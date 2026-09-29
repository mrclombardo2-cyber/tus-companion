
def test_push_subscription_can_be_disabled(tmp_path):
    import app.settings as settings
    import app.database as db
    settings.DB_PATH = tmp_path / "push.db"
    settings.DATA_DIR = tmp_path
    db.DB_PATH = settings.DB_PATH
    db.DATA_DIR = settings.DATA_DIR
    db.init_db()
    db.replace_catalog({
        "departments": [{"value": "D", "label": "Dept"}],
        "department_groups": [{"department_id": "D", "groups": [{"value": "G", "label": "Group"}]}],
    })
    assert db.group_exists("G", "D")
    db.upsert_subscription("G", "https://push.example/x", "p", "a", ["French"])
    sub = db.get_subscription("https://push.example/x")
    assert sub and sub["active"] == 1 and sub["hidden_modules"] == ["French"]
    db.deactivate_subscription("https://push.example/x")
    assert db.get_subscription("https://push.example/x")["active"] == 0
