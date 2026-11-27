"""Input checks on /api/patients and /api/orders that run before any database access,
tested with a stand-in logged-in user (no PostgreSQL needed). Also the SATUSEHAT client in MOCK mode."""
import asyncio
from unittest.mock import MagicMock

import pytest

from app.core.db import get_db
from app.modules.auth.deps import current_user
from app.modules.auth.models import User


@pytest.fixture()
def as_admin(client):
    client.app.dependency_overrides[current_user] = lambda: User(id=1, username="admin", full_name="Admin",
                                                                 role_code="admin", password_hash="-")
    client.app.dependency_overrides[get_db] = lambda: MagicMock()
    yield client
    client.app.dependency_overrides.clear()


VALID = {"nik": "3171234567890123", "name": "Budi", "gender": "Laki-laki", "birthDate": "1990-05-01"}


@pytest.mark.parametrize("change, message", [
    ({"nik": "123"}, "NIK harus 16 digit angka"),
    ({"nik": "31712345678901ab"}, "NIK harus 16 digit angka"),
    ({"name": "  "}, "Nama pasien wajib diisi"),
    ({"gender": "L"}, "Jenis kelamin harus Laki-laki atau Perempuan"),
    ({"birthDate": "01-05-1990"}, "Tanggal lahir harus berformat YYYY-MM-DD"),
    ({"birthDate": "2999-01-01"}, "Tanggal lahir tidak boleh di masa depan"),
    ({"name": "x" * 201}, "name terlalu panjang (maks. 200 huruf)"),
])
def test_patient_rejected(as_admin, change, message):
    r = as_admin.post("/api/patients", json={**VALID, **change})
    assert r.status_code == 400 and r.json()["detail"] == message


@pytest.mark.parametrize("body, message", [
    ({"patient": {"nik": ""}, "exam": {"modality": "CT", "description": "CT Thorax"}},
     "NIK pasien dan jenis pemeriksaan wajib diisi"),
    ({"patient": {"nik": "3171234567890123"}, "exam": {"modality": "CT", "description": " "}},
     "NIK pasien dan jenis pemeriksaan wajib diisi"),
    ({"patient": {"nik": "3171234567890123"}, "exam": {"modality": "CT", "description": "CT"}, "unit": "x" * 61},
     "Nama unit terlalu panjang (maks. 60 huruf)"),
])
def test_order_rejected(as_admin, body, message):
    r = as_admin.post("/api/orders", json=body)
    assert r.status_code == 400 and r.json()["detail"] == message


def test_order_list_rejects_unknown_status(as_admin):
    assert as_admin.get("/api/orders?status=bogus").status_code == 400


def test_return_needs_reason(as_admin):
    r = as_admin.post("/api/orders/RQ-1/return", json={"reason": " "})
    assert r.status_code == 400 and r.json()["detail"] == "Alasan pengembalian wajib diisi"


def test_role_check(client):
    client.app.dependency_overrides[current_user] = lambda: User(id=2, username="rg", full_name="RG",
                                                                 role_code="radiografer", password_hash="-")
    try:
        r = client.post("/api/orders", json={})
        assert r.status_code == 403 and "Radiografer" in r.json()["detail"]
    finally:
        client.app.dependency_overrides.clear()


def test_satusehat_mock_registers_patient():
    from app.modules.satusehat import settings
    from app.modules.satusehat.client import client as sehat
    if not settings.MOCK:
        pytest.skip("SATUSEHAT credentials configured (LIVE mode)")
    result = asyncio.run(sehat.register_patient({**VALID, "phone": "", "address": "", "city": "", "birthPlace": ""}))
    assert result["ok"] and result["ihs_number"] and result["how"] in ("found", "created")
