"""Instalasi Bedah end to end against the PostgreSQL test database (SATUSEHAT in MOCK mode)."""
import pytest

from tests.test_patients_orders_db import _login, _register

pytestmark = pytest.mark.db

SCHEDULE = {"start": "2026-11-27T09:00", "end": "2026-11-27T11:00", "room": "OK 2", "surgeon": "dr. Bima Santoso, Sp.B"}
REPORT = {"pre_dx_code": "K35.8", "pre_dx_text": "Acute appendicitis", "proc_code": "47.09",
          "proc_text": "Other appendectomy", "findings": "Apendiks meradang."}


def test_operation_flow(client, migrated_db):
    bedah = _login(client, "dokter_bedah")
    nik, _ = _register(client, bedah)

    r = client.post("/api/operations", headers=bedah, json={"patient": {"nik": nik}, "schedule": SCHEDULE, "report": {}})
    assert r.status_code == 200, r.text
    op = r.json()
    assert op["id"].startswith("OP-") and op["status"] == "scheduled" and op["data"]["patient"]["nik"] == nik

    r = client.post("/api/operations", headers=bedah,
                    json={"id": op["id"], "patient": {"nik": nik}, "schedule": SCHEDULE, "report": REPORT})
    assert r.status_code == 200 and r.json()["id"] == op["id"] and r.json()["data"]["report"] == REPORT

    assert any(o["id"] == op["id"] for o in client.get("/api/operations", headers=bedah).json())

    sent = client.post("/api/satusehat/send-procedure", headers=bedah, json={"operation_id": op["id"]})
    assert sent.status_code == 200, sent.text
    result = sent.json()
    assert result["ok"] and result["operation"]["status"] == "sent"
    assert result["operation"]["encounter_id"] == result["encounter_id"]

    again = client.post("/api/satusehat/send-procedure", headers=bedah, json={"operation_id": op["id"]})
    assert again.status_code == 409
    edit = client.post("/api/operations", headers=bedah,
                       json={"id": op["id"], "patient": {"nik": nik}, "schedule": SCHEDULE, "report": REPORT})
    assert edit.status_code == 409                       # a sent operation is read-only


def test_unknown_id_creates_new(client, migrated_db):
    bedah = _login(client, "dokter_bedah")
    nik, _ = _register(client, bedah)
    r = client.post("/api/operations", headers=bedah, json={"id": "OP-000000-NONE", "patient": {"nik": nik}})
    assert r.status_code == 200 and r.json()["id"] != "OP-000000-NONE"
