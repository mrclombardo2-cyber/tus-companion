from __future__ import annotations

import argparse
import json
import os
import threading
import time
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import Page, sync_playwright

from ..settings import BASE_URL, DATA_DIR
from ..default_page import parse_departments_and_groups

ROOT = Path(__file__).resolve().parents[2]
PROFILE = ROOT / ".tus-browser-profile"
SESSION_DIR = ROOT / ".tus-session"
SESSION_STATE = SESSION_DIR / "storage_state.json"
LOGIN_TIMEOUT_MS = 10 * 60 * 1000
LOGIN_GATEWAY_RETRY_SECONDS = 60

LOCK = threading.RLock()


# ---------------------------------------------------------------------------
# Persistent authenticated browser state
# ---------------------------------------------------------------------------

def _restore(ctx) -> None:
    if not SESSION_STATE.exists():
        return
    try:
        cookies = json.loads(SESSION_STATE.read_text(encoding="utf-8")).get("cookies", [])
        if cookies:
            ctx.add_cookies(cookies)
    except Exception:
        # The persistent Chromium profile is still available as a fallback.
        pass


def _save(ctx) -> None:
    SESSION_DIR.mkdir(parents=True, exist_ok=True)
    ctx.storage_state(path=str(SESSION_STATE))


def _context(p, headless: bool):
    # GitHub Actions runners are ephemeral. In cloud mode we restore the full
    # Playwright storage_state (cookies + origin storage) into a normal context
    # instead of depending on a persistent Chromium profile that vanishes after
    # every job. Local Windows mode keeps the existing persistent profile.
    if os.getenv("TUS_EPHEMERAL_BROWSER", "").lower() in {"1", "true", "yes"}:
        browser = p.chromium.launch(headless=headless)
        kwargs = {"viewport": {"width": 1440, "height": 1000}}
        if SESSION_STATE.exists():
            kwargs["storage_state"] = str(SESSION_STATE)
        ctx = browser.new_context(**kwargs)
        return ctx

    PROFILE.mkdir(parents=True, exist_ok=True)
    ctx = p.chromium.launch_persistent_context(
        user_data_dir=str(PROFILE),
        headless=headless,
        viewport={"width": 1440, "height": 1000},
    )
    _restore(ctx)
    return ctx


def _close_context(ctx) -> None:
    browser = getattr(ctx, "browser", None)
    try:
        ctx.close()
    finally:
        # Persistent contexts own their browser and report browser=None. Normal
        # cloud contexts do not, so close that browser explicitly.
        if browser is not None:
            try:
                browser.close()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# TUS navigation helpers
# ---------------------------------------------------------------------------

def _ready(page: Page) -> bool:
    """True only on Student Set - by Name, where the filters are available."""
    try:
        return page.locator("#dlFilter2").is_visible(timeout=800)
    except Exception:
        return False


def _student_set_link_visible(page: Page) -> bool:
    try:
        return page.locator("#LinkBtn_StudentSetByName").is_visible(timeout=500)
    except Exception:
        return False


def _login_stage(page: Page) -> str:
    """Non-sensitive progress: report site category only, never an auth URL or form data."""
    try:
        if page.is_closed():
            return "browser-window-closed"
        host = (urlparse(page.url).hostname or "").lower()
        if host == (urlparse(BASE_URL).hostname or "").lower():
            if _ready(page):
                return "TUS timetable ready"
            if _student_set_link_visible(page):
                return "TUS Student Information"
            return "TUS landing page"
        if host == "login.microsoftonline.com" or host.endswith(".login.microsoftonline.com"):
            return "Microsoft sign-in / MFA"
        if host in {"login.live.com", "login.microsoft.com"}:
            return "Microsoft sign-in / MFA"
        if host == "":
            return "browser loading"
        return "external sign-in or redirect"
    except Exception:
        return "browser navigating"


def _click_student_gateway(page: Page) -> bool:
    """Click the public TUS 'Student' gateway automatically if it is present.

    TUS has used different HTML controls for this button, so use several narrow
    selectors rather than relying on one specific tag.
    """
    # Never click links containing "Student" on third-party/Microsoft pages.
    try:
        if (urlparse(page.url).hostname or "").lower() != (urlparse(BASE_URL).hostname or "").lower():
            return False
    except Exception:
        return False
    selectors = (
        'input[type="submit"][value="Student"]',
        'input[type="button"][value="Student"]',
        'button:has-text("Student")',
        'a:has-text("Student")',
    )
    for selector in selectors:
        try:
            loc = page.locator(selector).first
            if loc.is_visible(timeout=500):
                print("TUS Student gateway detected. Opening Microsoft sign-in automatically...")
                loc.click()
                return True
        except Exception:
            continue
    return False


def _open_student_set_by_name(page: Page, timeout_ms: int = 20_000) -> bool:
    """Open 'Student Set - by Name' automatically after authentication."""
    if _ready(page):
        return True

    try:
        link = page.locator("#LinkBtn_StudentSetByName")
        if not link.is_visible(timeout=1000):
            return False

        print("Opening 'Student Set - by Name' automatically...")
        # ASP.NET may post back without a full navigation. A navigation expectation
        # previously wasted up to 20 seconds per attempt on these normal updates.
        link.click(timeout=min(timeout_ms, 10_000))
        page.locator("#dlFilter2").wait_for(state="visible", timeout=timeout_ms)
        return True
    except Exception:
        return False


def _try_silent_reauth(page: Page, timeout_ms: int = 25_000) -> bool:
    """Try to renew an expired TUS/App Proxy session without user interaction.

    Playwright storage_state normally also contains the user's existing Microsoft
    sign-in cookies. When the shorter-lived TUS/App Proxy cookie expires, clicking
    the normal Student gateway can often renew it silently. If Microsoft actually
    asks for credentials/MFA, this helper stops and leaves interactive login for the
    explicit reconnect flow.
    """
    if _ready(page) or _open_student_set_by_name(page):
        return True

    clicked = _click_student_gateway(page)
    if not clicked:
        return False

    deadline = time.monotonic() + (timeout_ms / 1000)
    while time.monotonic() < deadline:
        if _ready(page) or _open_student_set_by_name(page, timeout_ms=5_000):
            return True

        for candidate in reversed(page.context.pages):
            try:
                if _ready(candidate) or _open_student_set_by_name(candidate, timeout_ms=5_000):
                    if candidate is not page:
                        page.goto(candidate.url, wait_until="domcontentloaded", timeout=30_000)
                    return _ready(page) or _open_student_set_by_name(page, timeout_ms=5_000)
            except Exception:
                continue

        # A silent Microsoft redirect can take a few seconds. Do not type, click
        # credential controls, or attempt to bypass MFA here.
        time.sleep(0.5)

    return False


def _ensure_timetable_page(page: Page, allow_interactive_login: bool) -> bool:
    """Reach Student Set - by Name from any normal TUS authenticated landing page.

    In headless/cloud mode, first try a silent App Proxy renewal using the existing
    Microsoft browser session. Actual credentials/MFA are still never automated.
    """
    if _ready(page):
        return True
    if _open_student_set_by_name(page):
        return True
    if not allow_interactive_login:
        return _try_silent_reauth(page)
    _complete_login(page)
    return _ready(page)


def _complete_login(page: Page) -> None:
    """Continue navigating the official timetable while the user handles Microsoft MFA.

    Track authenticated TUS pages across windows and tabs, avoid repeatedly
    restarting the Student sign-in gateway, and emit *redacted* progress stages.
    This routine never inspects password/MFA values or prints browser URLs.
    """
    print("Complete Microsoft/TUS sign-in only if requested in the opened browser.", flush=True)
    print("TUS Student and Student Set navigation will be attempted automatically.", flush=True)

    deadline = time.monotonic() + LOGIN_TIMEOUT_MS / 1000
    last_gateway_click: dict[int, float] = {}
    last_progress = ""
    last_notice = 0.0
    manual_tip_shown = False
    began_at = time.monotonic()

    while time.monotonic() < deadline:
        pages = [p for p in reversed(page.context.pages) if not p.is_closed()]
        if not pages:
            raise RuntimeError("TUS login browser was closed before authentication completed")

        # Prefer the original stable Page reference used by collectors. When the
        # provider opens a new tab, copy its authenticated landing URL back to
        # that Page; the same browser context shares Microsoft/TUS cookies.
        for candidate in pages:
            if _ready(candidate) or _open_student_set_by_name(candidate, timeout_ms=6_000):
                if candidate is page:
                    return
                if not page.is_closed():
                    try:
                        page.goto(candidate.url, wait_until="domcontentloaded", timeout=20_000)
                        if _ready(page) or _open_student_set_by_name(page, timeout_ms=6_000):
                            return
                    except Exception:
                        pass
                # The local one-shot login only needs the shared cookie state;
                # if the original tab closed, a ready authenticated tab is valid.
                if page.is_closed():
                    return

        stages = sorted({_login_stage(p) for p in pages})
        summary = ", ".join(stages)
        now = time.monotonic()
        if summary != last_progress or now - last_notice >= 45:
            print(f"[TUS login] Browser stage: {summary}", flush=True)
            last_progress = summary
            last_notice = now

        # The Microsoft authentication page may be another tab. Do not restart
        # the TUS sign-in flow while that page is open or during MFA.
        microsoft_open = any("Microsoft sign-in" in stage for stage in stages)
        if not microsoft_open:
            for candidate in pages:
                if _login_stage(candidate) != "TUS landing page":
                    continue
                key = id(candidate)
                if now - last_gateway_click.get(key, -1e9) >= LOGIN_GATEWAY_RETRY_SECONDS:
                    last_gateway_click[key] = now
                    _click_student_gateway(candidate)

        if not manual_tip_shown and now - began_at >= 120:
            # Printed once at approximately two minutes, not every half-second.
            print("[TUS login] If the browser is still on a TUS landing page, "
                  "you can click its Student link once. Complete any Microsoft "
                  "prompt in the browser; the collector continues waiting.", flush=True)
            manual_tip_shown = True

        time.sleep(1)

    # No secrets, query strings, form values or full URLs in failure messages.
    raise RuntimeError(
        "TUS login not verified within 10 minutes. "
        f"Last browser stage: {last_progress or 'unknown'}. "
        "Check which page is visible in the browser and try again."
    )


# ---------------------------------------------------------------------------
# Public session commands
# ---------------------------------------------------------------------------

def login() -> None:
    with LOCK, sync_playwright() as p:
        ctx = _context(p, False)
        try:
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            page.goto(BASE_URL, wait_until="domcontentloaded")
            _complete_login(page)
            _save(ctx)
            print("authenticated")
        finally:
            _close_context(ctx)


def status() -> bool:
    with LOCK, sync_playwright() as p:
        ctx = _context(p, True)
        try:
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            page.goto(BASE_URL, wait_until="domcontentloaded", timeout=60_000)
            # An authenticated session may land on Student Information rather than
            # Student Set - by Name. Move to the latter automatically before deciding
            # the session is invalid.
            ok = _ensure_timetable_page(page, allow_interactive_login=False)
            if ok:
                _save(ctx)
            print("authenticated" if ok else "login-required")
            return ok
        finally:
            _close_context(ctx)


# ---------------------------------------------------------------------------
# Timetable/catalog collection
# ---------------------------------------------------------------------------

def _postback_select(page: Page, selector: str, value: str) -> None:
    loc = page.locator(selector)
    if loc.input_value() == value:
        return
    with page.expect_navigation(wait_until="domcontentloaded", timeout=60_000):
        loc.select_option(value=value)


def _fetch_one_on_page(
    page: Page,
    department: str,
    group: str,
    week: str = "t",
    days: str = "1-7",
    period: str = "1-28",
) -> str:
    # The collector always starts from Student Set - by Name. Department and group
    # therefore come entirely from our app/database; the user never needs to touch
    # the legacy Scientia UI.
    if not _ensure_timetable_page(page, allow_interactive_login=False):
        raise RuntimeError("source-session-expired")

    _postback_select(page, "#dlFilter2", department)
    page.locator(f'#dlObject option[value="{group}"]').wait_for(timeout=15_000)
    page.select_option("#dlObject", value=group)
    _postback_select(page, "#lbWeeks", week)
    page.select_option("#lbDays", value=days)
    _postback_select(page, "#dlPeriod", period)

    # Reapply controls that may have been reset by ASP.NET AutoPostBack.
    page.select_option("#dlObject", value=group)
    page.select_option("#lbDays", value=days)
    page.check("#RadioType_2")

    with page.expect_popup(timeout=30_000) as popup_info:
        page.click("#bGetTimetable")
    popup = popup_info.value
    try:
        popup.wait_for_load_state("domcontentloaded", timeout=60_000)
        html = popup.content()
        if "Student Set TextSpreadsheet" not in html:
            raise RuntimeError("unexpected-timetable-layout")
        return html
    finally:
        popup.close()


def fetch_many(items: list[dict], headless: bool = True) -> dict[str, dict]:
    """Fetch multiple Student Groups with one central authenticated session.

    Scientia stores the currently selected timetable in server-side session state,
    so groups are deliberately fetched sequentially. Students never authenticate to
    TUS: they only select a group in our own web app; the central collector uses that
    group id here.
    """
    results: dict[str, dict] = {}
    with LOCK, sync_playwright() as p:
        ctx = _context(p, headless)
        try:
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            page.goto(BASE_URL, wait_until="domcontentloaded", timeout=60_000)
            if not _ensure_timetable_page(page, allow_interactive_login=not headless):
                raise RuntimeError("source-session-expired")

            for item in items:
                group = item["group_id"]
                last_error = None
                for attempt in range(2):
                    try:
                        html = _fetch_one_on_page(
                            page,
                            item["department_id"],
                            group,
                            item.get("week", "t"),
                            item.get("days", "1-7"),
                            item.get("period", "1-28"),
                        )
                        results[group] = {"html": html, "error": None}
                        last_error = None
                        break
                    except Exception as exc:
                        last_error = str(exc)
                        try:
                            page.goto(BASE_URL, wait_until="domcontentloaded", timeout=60_000)
                            if not _ensure_timetable_page(page, allow_interactive_login=False):
                                last_error = "source-session-expired"
                                break
                        except Exception as recover_exc:
                            last_error = str(recover_exc) or last_error
                            break
                        if attempt == 0:
                            time.sleep(0.75)
                if last_error is not None:
                    results[group] = {"html": None, "error": last_error}
                    if "source-session-expired" in last_error.lower() or "login-required" in last_error.lower():
                        break

            _save(ctx)
            return results
        finally:
            _close_context(ctx)


def fetch_html(
    department: str,
    group: str,
    week: str = "t",
    days: str = "1-7",
    period: str = "1-28",
    headless: bool = True,
) -> str:
    result = fetch_many([
        {
            "department_id": department,
            "group_id": group,
            "week": week,
            "days": days,
            "period": period,
        }
    ], headless=headless)[group]
    if result["error"]:
        raise RuntimeError(result["error"])
    return result["html"]


def scrape_catalog(headless: bool = True) -> dict:
    with LOCK, sync_playwright() as p:
        ctx = _context(p, headless)
        try:
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            page.goto(BASE_URL, wait_until="domcontentloaded", timeout=60_000)
            if not _ensure_timetable_page(page, allow_interactive_login=not headless):
                raise RuntimeError("source-session-expired")

            first = parse_departments_and_groups(page.content())
            departments = first["departments"]
            department_groups = []
            for dep in departments:
                _postback_select(page, "#dlFilter2", dep["value"])
                current = parse_departments_and_groups(page.content())
                department_groups.append({
                    "department_id": dep["value"],
                    "groups": current["groups"],
                })
            _save(ctx)
            return {"departments": departments, "department_groups": department_groups}
        finally:
            _close_context(ctx)


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("login")
    sub.add_parser("status")
    sub.add_parser("catalog")
    f = sub.add_parser("fetch")
    f.add_argument("--department", required=True)
    f.add_argument("--group", required=True)
    f.add_argument("--show-browser", action="store_true")
    args = ap.parse_args()

    if args.cmd == "login":
        login()
    elif args.cmd == "status":
        status()
    elif args.cmd == "catalog":
        from ..database import replace_catalog

        c = scrape_catalog(False)
        replace_catalog(c)
        print(f"catalog: {len(c['departments'])} departments")
    else:
        html = fetch_html(args.department, args.group, headless=not args.show_browser)
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        path = DATA_DIR / "manual_latest.html"
        path.write_text(html, encoding="utf-8")
        print(path)


if __name__ == "__main__":
    main()
