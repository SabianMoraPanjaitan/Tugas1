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


def test_upload_needs_a_file(as_admin):
    r = as_admin.post("/api/studies", data={"meta": "{}"})
    assert r.status_code == 400 and r.json()["detail"] == "Tidak ada berkas yang diunggah"


def test_upload_meta_must_be_json_object(as_admin):
    r = as_admin.post("/api/studies", data={"meta": "[1,2]"}, files={"file": ("a.dcm", b"x")})
    assert r.status_code == 400


def test_radiografer_upload_needs_order(client):
    client.app.dependency_overrides[current_user] = lambda: User(id=2, username="rg", full_name="RG",
                                                                 role_code="radiografer", password_hash="-")
    client.app.dependency_overrides[get_db] = lambda: MagicMock()
    try:
        r = client.post("/api/studies", data={"meta": "{}"}, files={"file": ("a.dcm", b"x")})
        assert r.status_code == 400 and r.json()["detail"] == "Pilih permintaan radiologi terlebih dulu"
    finally:
        client.app.dependency_overrides.clear()


def test_reading_limits(as_admin):
    as_admin.app.dependency_overrides[get_db] = lambda: MagicMock(get=lambda *a, **k: MagicMock())
    r = as_admin.post("/api/studies/1/reading", json={"icd10": "x" * 33})
    assert r.status_code == 400 and "icd10" in r.json()["detail"]


def test_role_check(client):
    client.app.dependency_overrides[current_user] = lambda: User(id=2, username="rg", full_name="RG",
                                                                 role_code="radiografer", password_hash="-")
    try:
        r = client.post("/api/orders", json={})
        assert r.status_code == 403 and "Radiografer" in r.json()["detail"]
    finally:
        client.app.dependency_overrides.clear()


def test_send_study_unknown_archive_id_is_404(as_admin):
    as_admin.app.dependency_overrides[get_db] = lambda: MagicMock(get=lambda *a, **k: None)
    assert as_admin.post("/api/satusehat/send-study", json={"archive_id": "999", "icd10": "J18"}).status_code == 404
    assert as_admin.post("/api/satusehat/send-study", json={"archive_id": "abc"}).status_code == 404


def test_send_study_reading_limits(as_admin):
    r = as_admin.post("/api/satusehat/send-study", json={"archive_id": "1", "finding": "x" * 20001})
    assert r.status_code == 400 and "finding" in r.json()["detail"]


def test_send_study_needs_reporter_role(client):
    client.app.dependency_overrides[current_user] = lambda: User(id=2, username="rg", full_name="RG",
                                                                 role_code="radiografer", password_hash="-")
    try:
        assert client.post("/api/satusehat/send-study", json={}).status_code == 403
    finally:
        client.app.dependency_overrides.clear()


def test_send_study_endpoint_without_archive(as_admin):
    """The endpoint runs the async client from its worker thread (anyio.from_thread.run)."""
    from app.modules.satusehat import settings
    if not settings.MOCK:
        pytest.skip("SATUSEHAT credentials configured (LIVE mode)")
    db = MagicMock()
    db.scalar.return_value = None                      # NIK not in the registry
    as_admin.app.dependency_overrides[get_db] = lambda: db
    r = as_admin.post("/api/satusehat/send-study", json={"name": "Budi", "nik": VALID["nik"], "modality": "CT",
                                                         "description": "CT Thorax", "icd10": "J18.9",
                                                         "diagnosis": "Pneumonia", "finding": "Konsolidasi."})
    assert r.status_code == 200 and r.json()["ok"] and r.json()["mode"] == "MOCK"
    assert db.commit.called                            # the audit entry is saved


def test_satusehat_mock_sends_radiology_chain():
    from app.modules.satusehat import settings
    from app.modules.satusehat.client import client as sehat
    if not settings.MOCK:
        pytest.skip("SATUSEHAT credentials configured (LIVE mode)")
    result = asyncio.run(sehat.send_study({"name": "Budi", "nik": VALID["nik"], "modality": "CT",
                                           "description": "CT Thorax", "icd10": "J18.9",
                                           "diagnosis": "Pneumonia", "finding": "Konsolidasi lobus kanan bawah."}))
    assert result["ok"] and result["imaging_study_id"] and result["diagnostic_report_id"]
    assert [log["step"] for log in result["logs"]][-1] == "DiagnosticReport"


def test_operation_needs_registered_patient(as_admin):
    r = as_admin.post("/api/operations", json={"patient": {"nik": ""}, "schedule": {}, "report": {}})
    assert r.status_code == 400 and "belum terdaftar" in r.json()["detail"]


def test_operation_form_size_limit(as_admin):
    r = as_admin.post("/api/operations", json={"patient": {"nik": "x"}, "report": {"findings": "x" * 60_000}})
    assert r.status_code == 400 and "terlalu panjang" in r.json()["detail"]


def test_send_procedure_unknown_is_404(as_admin):
    r = as_admin.post("/api/satusehat/send-procedure", json={"operation_id": ""})
    assert r.status_code == 404 and r.json()["detail"] == "Operasi belum disimpan"


def test_operations_need_bedah_role(client):
    client.app.dependency_overrides[current_user] = lambda: User(id=3, username="rl", full_name="RL",
                                                                 role_code="radiolog", password_hash="-")
    try:
        assert client.get("/api/operations").status_code == 403
        assert client.post("/api/satusehat/send-procedure", json={}).status_code == 403
    finally:
        client.app.dependency_overrides.clear()


def test_satusehat_mock_sends_procedure():
    from app.modules.satusehat import settings
    from app.modules.satusehat.client import client as sehat
    if not settings.MOCK:
        pytest.skip("SATUSEHAT credentials configured (LIVE mode)")
    result = asyncio.run(sehat.send_procedure({
        "patient": {"nik": VALID["nik"], "name": "Budi"},
        "schedule": {"start": "2026-11-27T09:00", "end": "2026-11-27T11:00", "surgeon": "dr. Bima"},
        "report": {"proc_code": "47.09", "proc_text": "Other appendectomy", "pre_dx_code": "K35.8",
                   "pre_dx_text": "Acute appendicitis"}}))
    assert result["ok"] and result["encounter_id"] and result["procedure_id"]


def test_satusehat_mock_registers_patient():
    from app.modules.satusehat import settings
    from app.modules.satusehat.client import client as sehat
    if not settings.MOCK:
        pytest.skip("SATUSEHAT credentials configured (LIVE mode)")
    result = asyncio.run(sehat.register_patient({**VALID, "phone": "", "address": "", "city": "", "birthPlace": ""}))
    assert result["ok"] and result["ihs_number"] and result["how"] in ("found", "created")
