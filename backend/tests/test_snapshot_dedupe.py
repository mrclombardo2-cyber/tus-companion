import importlib


def test_identical_snapshot_is_not_duplicated(tmp_path, monkeypatch):
    monkeypatch.setenv("TUS_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("TUS_DB_PATH", str(tmp_path / "data" / "db.sqlite"))
    import app.settings as settings
    import app.database as database
    importlib.reload(settings)
    importlib.reload(database)
    database.init_db()
    payload = {"events": [{"module": "A", "start": "09:00"}]}
    assert database.save_snapshot("G", payload) is True
    assert database.save_snapshot("G", payload) is False
    with database.conn() as c:
        count = c.execute("SELECT COUNT(*) n FROM snapshots WHERE group_id='G'").fetchone()["n"]
    assert count == 1
