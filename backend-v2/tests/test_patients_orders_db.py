"""Patients and orders end to end against the PostgreSQL test database (TEST_DATABASE_URL).
SATUSEHAT runs in MOCK mode in tests (no credentials), so registration never leaves this machine."""
import random
import uuid

import pytest

pytestmark = pytest.mark.db


def _login(client, role):
    from app.core.db import SessionLocal
    from app.modules.auth import service
    username = f"t_{role}_{uuid.uuid4().hex[:6]}"
    with SessionLocal() as db, db.begin():
        service.create_user(db, username, "pw-12345678", role, f"Test {role}")
    token = client.post("/api/auth/login", json={"username": username, "password": "pw-12345678"}).json()["token"]
    client.cookies.clear()
    return {"Authorization": "Bearer " + token}


def _nik():
    return "31" + "".join(random.choice("0123456789") for _ in range(14))


@pytest.fixture()
def bedah(client, migrated_db):
    return _login(client, "dokter_bedah")


@pytest.fixture()
def radiografer(client, migrated_db):
    return _login(client, "radiografer")


def _register(client, headers, name="Siti Aminah"):
    nik = _nik()
    r = client.post("/api/patients", headers=headers,
                    json={"nik": nik, "name": name, "gender": "Perempuan", "birthDate": "1985-02-03", "city": "Bandung"})
    assert r.status_code == 200, r.text
    return nik, r.json()


def test_register_and_list_patient(client, bedah):
    nik, result = _register(client, bedah, "Siti Aminah Uji")
    p = result["patient"]
    assert result["ok"] and p["nik"] == nik and p["gender"] == "Perempuan" and p["city"] == "Bandung"
    assert p["mrn"].startswith("MR") and p["ihs_number"]
    found = client.get("/api/patients?q=aminah uji", headers=bedah).json()
    assert any(x["nik"] == nik for x in found)


def test_duplicate_nik_is_409(client, bedah):
    nik, _ = _register(client, bedah)
    r = client.post("/api/patients", headers=bedah,
                    json={"nik": nik, "name": "Lain", "gender": "Laki-laki", "birthDate": "1990-01-01"})
    assert r.status_code == 409


def test_order_flow(client, bedah, radiografer):
    nik, _ = _register(client, bedah)
    body = {"patient": {"nik": nik}, "exam": {"modality": "CT", "description": "CT Thorax kontras"},
            "indication": {"icd10": "J18.9", "text": "Batuk lama"}, "priority": "CITO", "unit": "IGD"}
    r = client.post("/api/orders", headers=bedah, json=body)
    assert r.status_code == 200, r.text
    order = r.json()
    assert order["id"].startswith("RQ-") and order["status"] == "requested"
    assert order["data"]["priority"] == "CITO" and order["data"]["unit"] == "IGD"
    assert order["data"]["patient"]["nik"] == nik and order["data"]["requester"] == "Test dokter_bedah"
    assert order["study"] is None

    waiting = client.get("/api/orders?status=requested", headers=radiografer).json()
    assert any(o["id"] == order["id"] for o in waiting)
    assert [o["id"] for o in client.get(f"/api/orders?nik={nik}", headers=radiografer).json()] == [order["id"]]

    r = client.post(f"/api/orders/{order['id']}/return", headers=radiografer, json={"reason": "Salah pemeriksaan"})
    assert r.status_code == 200, r.text
    returned = r.json()
    assert returned["status"] == "returned" and returned["data"]["returned"]["reason"] == "Salah pemeriksaan"
    assert returned["data"]["returned"]["by"] == "Test radiografer"

    again = client.post(f"/api/orders/{order['id']}/return", headers=radiografer, json={"reason": "lagi"})
    assert again.status_code == 409


def test_order_for_unregistered_patient(client, bedah):
    r = client.post("/api/orders", headers=bedah,
                    json={"patient": {"nik": _nik()}, "exam": {"modality": "CT", "description": "CT Kepala"}})
    assert r.status_code == 400 and "belum terdaftar" in r.json()["detail"]


def test_return_unknown_order_is_404(client, radiografer):
    assert client.post("/api/orders/RQ-000000-ZZZZ/return", headers=radiografer,
                       json={"reason": "x"}).status_code == 404


def test_actions_are_audited(client, bedah):
    from sqlalchemy import select

    from app.core.db import SessionLocal
    from app.modules.audit.models import AuditLog
    nik, result = _register(client, bedah)
    with SessionLocal() as db:
        actions = db.scalars(select(AuditLog.action).where(AuditLog.patient_id == result["patient"]["id"])).all()
    assert "register_patient" in actions
