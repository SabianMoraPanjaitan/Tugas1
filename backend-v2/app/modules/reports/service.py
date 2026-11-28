"""Report rules. Every save writes a new, unchangeable row in report_versions, so the full edit
history of a reading is kept; `reports` holds only the current state.

    draft  --save-->  draft (version + 1)        all fields empty again = back to "unread" (still versioned)
    draft (or nothing yet)  --finalize (after SATUSEHAT accepted it)-->  final
"""
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.modules.archive.models import Study
from app.modules.auth.models import User
from app.modules.reports.models import Report, ReportVersion

LIMITS = {"icd10": 32, "diagnosis": 500, "finding": 20000}


class AlreadyFinal(Exception):
    pass


def _version(report: Report, user: User, source: str) -> ReportVersion:
    return ReportVersion(report_id=report.id, version=report.version, status=report.status, icd10=report.icd10,
                         diagnosis=report.diagnosis, findings=report.findings, impression=report.impression,
                         source=source, edited_by=user.id)


def save_draft(db: Session, study: Study, user: User, reading: dict, source: str = "typed") -> Report | None:
    """reading: {icd10, diagnosis, finding} (already trimmed and length-checked)."""
    if study.status in ("final", "amended"):
        raise AlreadyFinal(study.id)
    report = db.scalar(select(Report).where(Report.study_id == study.id).with_for_update())
    if report is not None and report.status != "draft":
        raise AlreadyFinal(study.id)
    has_text = any(reading.values())
    if report is None:
        if not has_text:
            return None                     # nothing written yet, nothing to clear
        report = Report(study_id=study.id, status="draft", author_id=user.id, version=1, icd10=reading["icd10"],
                        diagnosis=reading["diagnosis"], findings=reading["finding"])
        db.add(report)
        db.flush()
    else:
        report.version += 1
        report.icd10, report.diagnosis, report.findings = reading["icd10"], reading["diagnosis"], reading["finding"]
        report.author_id = user.id          # who saved it last
        db.flush()
    db.add(_version(report, user, source))
    study.status = "draft" if has_text else "unread"
    db.flush()
    return report


def finalize(db: Session, study: Study, user: User, reading: dict, *, diagnostic_report_id: str = "",
             source: str = "typed") -> Report:
    """Make the reading final. Called once SATUSEHAT has accepted it; the caller holds the study row lock."""
    if study.status in ("final", "amended"):
        raise AlreadyFinal(study.id)
    report = db.scalar(select(Report).where(Report.study_id == study.id).with_for_update())
    now = datetime.now(timezone.utc)
    if report is None:
        report = Report(study_id=study.id, status="final", author_id=user.id, version=1, finalized_at=now)
        db.add(report)
    elif report.status != "draft":
        raise AlreadyFinal(study.id)
    else:
        report.version += 1
        report.status, report.finalized_at, report.author_id = "final", now, user.id
    report.icd10, report.diagnosis, report.findings = reading["icd10"], reading["diagnosis"], reading["finding"]
    report.satusehat_diagnostic_report_id = diagnostic_report_id or None
    db.flush()
    db.add(_version(report, user, source))
    study.status = "final"
    db.flush()
    return report
