from __future__ import annotations
from bs4 import BeautifulSoup


def parse_departments_and_groups(html: str) -> dict:
    soup = BeautifulSoup(html, "html.parser")
    departments = []
    dep = soup.select_one("#dlFilter2")
    if dep:
        for opt in dep.find_all("option"):
            value = opt.get("value", "").strip()
            text = opt.get_text(" ", strip=True)
            if value:
                departments.append({"value": value, "label": text, "selected": opt.has_attr("selected")})
    groups = []
    grp = soup.select_one("#dlObject")
    if grp:
        for opt in grp.find_all("option"):
            groups.append({
                "value": opt.get("value", "").strip(),
                "label": opt.get_text(" ", strip=True),
                "selected": opt.has_attr("selected"),
            })
    return {"departments": departments, "groups": groups}
