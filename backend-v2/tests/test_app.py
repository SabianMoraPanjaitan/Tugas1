"""App-level checks that need no database."""


def test_routes_mypacs_needs_exist(client):
    paths = {route.path for route in client.app.routes}
    for path in ("/api/health", "/api/auth/login", "/api/auth/logout", "/api/auth/me", "/api/auth/tab-session",
                 "/api/patients", "/api/orders", "/api/orders/{order_id}/return",
                 "/api/studies", "/api/studies/{study_id}/file", "/api/studies/{study_id}/slices",
                 "/api/studies/{study_id}/reading", "/api/studies/{study_id}/instances",
                 "/api/instances/{sop_uid}/file", "/api/satusehat/send-study", "/api/satusehat/patient",
                 "/api/operations", "/api/satusehat/send-procedure"):
        assert path in paths


def test_me_without_login_is_401(client):
    r = client.get("/api/auth/me")
    assert r.status_code == 401


def test_login_validates_body(client):
    assert client.post("/api/auth/login", json={"username": "", "password": "x"}).status_code == 422
    assert client.post("/api/auth/login", json={}).status_code == 422


def test_health_reports_unreachable_database(client, monkeypatch):
    import os
    if os.environ.get("TEST_DATABASE_URL"):
        return    # a database is configured; the db tests cover the healthy case
    r = client.get("/api/health")
    assert r.status_code == 503
    assert r.json()["database"] == "unreachable"
