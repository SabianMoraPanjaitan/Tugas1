# Checks the MyPACS backend routes against a running MOCK backend (http://127.0.0.1:8000): a unit on a request,
# sending a request back, and the radiologist's draft reading (kept apart from the sent reading).
# Creates test requests and studies in Backend/data (gitignored), using the repo's Frontend/sample-ct.dcm only.
# Run with the backend's own Python (httpx is in Backend/requirements.txt):  python test_backend_routes.py <repo folder>
import json, sys, time
import httpx

B = "http://127.0.0.1:8000/api/"
REPO = sys.argv[1]
fails = 0


def check(name, cond, extra=""):
    global fails
    if not cond:
        fails += 1
    print(("PASS " if cond else "FAIL ") + name + (("  " + extra) if extra else ""))


for _ in range(30):
    try:
        if httpx.get(B + "health", timeout=2).status_code == 200:
            break
    except Exception:
        time.sleep(1)


def login(u, p):
    r = httpx.post(B + "auth/login", json={"username": u, "password": p})
    r.raise_for_status()
    return {"Authorization": "Bearer " + r.json()["token"]}


bedah, rad, radiolog, admin = (login("bedah", "bedah123"), login("radiografer", "radiografer123"),
                               login("radiolog", "radiolog123"), login("admin", "admin123"))
nik = httpx.get(B + "patients", headers=bedah).json()[0]["nik"]
body = {"patient": {"nik": nik}, "exam": {"modality": "CT", "description": "CT Thorax (route test)"},
        "indication": {"text": "Route test on sample data."}, "priority": "Biasa", "note": ""}

# (b) unit on a request
r = httpx.post(B + "orders", headers=bedah, json={**body, "unit": "IGD"})
o1 = r.json()
check("order with unit stores data.unit", r.status_code == 200 and o1["data"].get("unit") == "IGD", o1["id"])
r = httpx.post(B + "orders", headers=bedah, json=body)
check("order without unit has no unit key", r.status_code == 200 and "unit" not in r.json()["data"])
o2 = r.json()
r = httpx.post(B + "orders", headers=bedah, json={**body, "unit": "x" * 61})
check("unit over 60 chars -> 400", r.status_code == 400, r.json().get("detail", ""))

# (c) send a request back
r = httpx.post(B + f"orders/{o1['id']}/return", headers=rad, json={"reason": ""})
check("return without reason -> 400", r.status_code == 400, r.json().get("detail", ""))
r = httpx.post(B + f"orders/{o1['id']}/return", headers=bedah, json={"reason": "x"})
check("return by bedah -> 403", r.status_code == 403)
r = httpx.post(B + "orders/RQ-000000-NONE/return", headers=rad, json={"reason": "x"})
check("return of unknown request -> 404", r.status_code == 404)
r = httpx.post(B + f"orders/{o1['id']}/return", headers=rad, json={"reason": "Wrong exam: please order CT Abdomen."})
ret = r.json()
check("return by radiografer -> returned + reason", r.status_code == 200 and ret["status"] == "returned"
      and ret["data"]["returned"]["reason"].startswith("Wrong exam") and ret["data"].get("unit") == "IGD",
      json.dumps(ret["data"].get("returned")))
r = httpx.post(B + f"orders/{o1['id']}/return", headers=rad, json={"reason": "again"})
check("return twice -> 409", r.status_code == 409)
r = httpx.get(B + "orders", headers=bedah, params={"status": "returned"})
check("list ?status=returned finds it", any(o["id"] == o1["id"] for o in r.json()))
r = httpx.get(B + "orders", headers=rad, params={"status": "requested"})
check("returned request leaves the radiographer's queue", all(o["id"] != o1["id"] for o in r.json()))
with open(REPO + "/Frontend/sample-ct.dcm", "rb") as f:
    r = httpx.post(B + "studies", headers=rad, files={"file": ("sample-ct.dcm", f, "application/dicom")},
                   data={"meta": json.dumps({"order_id": o1["id"]})})
check("upload to a returned request -> 409", r.status_code == 409)

# (a) draft reading
with open(REPO + "/Frontend/sample-ct.dcm", "rb") as f:
    r = httpx.post(B + "studies", headers=rad, files={"file": ("sample-ct.dcm", f, "application/dicom")},
                   data={"meta": json.dumps({"order_id": o2["id"]})})
st = r.json()
sid = st["id"]
check("upload to the open request works", r.status_code == 200 and st.get("order_id") == o2["id"], sid)
r = httpx.post(B + f"orders/{o2['id']}/return", headers=rad, json={"reason": "too late"})
check("return after images -> 409", r.status_code == 409)
reading = {"icd10": "R91", "diagnosis": "Route test diagnosis", "finding": "Draft text.\n\nImpression: Draft impression."}
r = httpx.post(B + f"studies/{sid}/reading", headers=rad, json=reading)
check("draft by radiografer -> 403", r.status_code == 403)
r = httpx.post(B + "studies/nope/reading", headers=radiolog, json=reading)
check("draft on unknown study -> 404", r.status_code == 404)
r = httpx.post(B + f"studies/{sid}/reading", headers=radiolog, json={**reading, "icd10": "x" * 33})
check("icd10 over 32 chars -> 400", r.status_code == 400)
r = httpx.post(B + f"studies/{sid}/reading", headers=radiolog, json=reading)
d = r.json().get("draft") or {}
check("draft saved apart from the reading", r.status_code == 200 and d.get("icd10") == "R91" and d.get("by") == "radiolog"
      and not r.json().get("icd10") and not r.json().get("finding") and not r.json().get("sent"), json.dumps(d)[:120])
s_rl = next(s for s in httpx.get(B + "studies", headers=radiolog).json() if s["id"] == sid)
s_bd = next(s for s in httpx.get(B + "studies", headers=bedah).json() if s["id"] == sid)
check("radiolog sees the draft text", (s_rl.get("draft") or {}).get("finding", "").startswith("Draft text"))
check("bedah sees only that a draft exists", set((s_bd.get("draft") or {}).keys()) == {"saved"}, json.dumps(s_bd.get("draft")))
o2_bd = next(o for o in httpx.get(B + "orders", headers=bedah).json() if o["id"] == o2["id"])
check("ward's request list shows no reading yet", o2_bd["status"] == "imaged" and not (o2_bd["study"] or {}).get("icd10"))
r = httpx.post(B + f"studies/{sid}/reading", headers=radiolog, json={"icd10": " ", "diagnosis": "", "finding": ""})
check("empty draft removes it", r.status_code == 200 and r.json().get("draft") is None)
httpx.post(B + f"studies/{sid}/reading", headers=radiolog, json=reading)

# send: the draft goes, the reading stays
send = {"name": st.get("name", ""), "nik": st.get("nik", ""), "modality": st.get("modality", ""), "description": st.get("description", ""),
        "icd10": "R91", "diagnosis": "Route test diagnosis", "finding": reading["finding"], "instalasi": "Instalasi Radiologi", "archive_id": sid}
r = httpx.post(B + "satusehat/send-study", headers=radiolog, json=send, timeout=30)
check("send-study ok (MOCK)", r.status_code == 200 and r.json().get("ok"), r.json().get("mode", ""))
s_after = next(s for s in httpx.get(B + "studies", headers=radiolog).json() if s["id"] == sid)
check("after send: sent, reading kept, draft cleared", s_after["sent"] and s_after["icd10"] == "R91" and s_after.get("draft") is None)
r = httpx.post(B + f"studies/{sid}/reading", headers=radiolog, json=reading)
check("draft on a sent study -> 409", r.status_code == 409)
o2_after = next(o for o in httpx.get(B + "orders", headers=bedah).json() if o["id"] == o2["id"])
check("request now reported with the reading", o2_after["status"] == "reported" and o2_after["study"]["icd10"] == "R91")
print("test ids:", o1["id"], o2["id"], sid)
print(fails and f"{fails} FAILED" or "all passed")
sys.exit(1 if fails else 0)
