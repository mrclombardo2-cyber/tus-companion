from app.notifications import _body, send_changes


def test_notification_bodies():
    room = {
        "change_type": "ROOM_CHANGED",
        "module": "Accounting",
        "before": {"room_code": "B09"},
        "after": {"room_code": "E3209"},
    }
    assert _body(room) == "Accounting: B09 → E3209"

    time = {
        "change_type": "TIME_CHANGED",
        "module": "Law",
        "before": {"start": "13:00"},
        "after": {"start": "14:00"},
    }
    assert _body(time) == "Law: 13:00 → 14:00"


def test_no_changes_does_not_claim_push_disabled_when_configured(monkeypatch):
    import app.notifications as n
    monkeypatch.setattr(n, "push_configured", lambda: True)
    assert send_changes("G", []) == {"sent": 0, "disabled": False, "reason": "no-changes"}
