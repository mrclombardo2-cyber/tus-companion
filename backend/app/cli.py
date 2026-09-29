from __future__ import annotations
import argparse
from pathlib import Path
from .settings import VAPID_PRIVATE_KEY, ROOT
from .collector.playwright_collector import login, status, scrape_catalog
from .database import replace_catalog, init_db
from .sync_service import sync_active_groups, sync_group
from .vapid import generate


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("login")
    sub.add_parser("status")
    cat = sub.add_parser("catalog")
    cat.add_argument("--show-browser", action="store_true", help="show Scientia while scanning departments")
    sub.add_parser("sync-all")
    sub.add_parser("vapid-generate")
    s = sub.add_parser("sync")
    s.add_argument("--department", required=True)
    s.add_argument("--group", required=True)
    args = ap.parse_args()
    init_db()

    if args.cmd == "login":
        login()
    elif args.cmd == "status":
        status()
    elif args.cmd == "catalog":
        # Default is headless. The old build visibly raced through every department
        # after login, which looked like a crash even though it was just catalog scan.
        c = scrape_catalog(headless=not args.show_browser)
        replace_catalog(c)
        print(f"saved {len(c['departments'])} departments / {sum(len(x['groups']) for x in c['department_groups'])} groups")
    elif args.cmd == "sync-all":
        print(sync_active_groups())
    elif args.cmd == "sync":
        print(sync_group(args.department, args.group))
    elif args.cmd == "vapid-generate":
        path = Path(VAPID_PRIVATE_KEY)
        public = generate(path, ROOT / "secrets" / "vapid_public.txt")
        print(f"VAPID_PRIVATE_KEY={path}")
        print(f"VAPID_PUBLIC_KEY={public}")


if __name__ == "__main__":
    main()
