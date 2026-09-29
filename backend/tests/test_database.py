def test_catalog_and_snapshot(tmp_path, monkeypatch):
    import app.settings as settings
    import app.database as db
    settings.DB_PATH = tmp_path / "x.db"
    settings.DATA_DIR = tmp_path
    db.DB_PATH = settings.DB_PATH
    db.DATA_DIR = settings.DATA_DIR
    db.init_db()
    db.replace_catalog({
        "departments": [{"value": "D", "label": "Dept"}],
        "department_groups": [{"department_id": "D", "groups": [{"value": "G", "label": "Group"}]}],
    })
    assert db.catalog()["departments"][0]["groups"][0]["id"] == "G"
    db.save_snapshot("G", {"student_group": "G", "events": []})
    assert db.latest_snapshot("G")["student_group"] == "G"
