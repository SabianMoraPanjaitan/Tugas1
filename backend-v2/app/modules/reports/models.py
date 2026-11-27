"""Radiology reports. `reports` holds the current state (one per study);
`report_versions` keeps every saved version, which is never changed afterwards.

Status: draft -> final -> amended (a correction after finalising; the final version stays in history).
"""
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Integer, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


class Report(Base):
    __tablename__ = "reports"
    __table_args__ = (
        CheckConstraint("status IN ('draft', 'final', 'amended')", name="status"),
        CheckConstraint("(status = 'draft') = (finalized_at IS NULL)", name="finalized_when_not_draft"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    study_id: Mapped[int] = mapped_column(ForeignKey("studies.id"), unique=True, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="draft")
    icd10: Mapped[str | None] = mapped_column(Text)
    diagnosis: Mapped[str | None] = mapped_column(Text)         # the ICD-10 diagnosis text, e.g. "Pneumonia, unspecified"
    findings: Mapped[str | None] = mapped_column(Text)          # MyPACS sends findings + impression as one text ("finding")
    impression: Mapped[str | None] = mapped_column(Text)        # separate field, for clients that send it apart
    author_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    finalized_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    satusehat_diagnostic_report_id: Mapped[str | None] = mapped_column(Text)
    version: Mapped[int] = mapped_column(Integer, nullable=False, server_default="1")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False,
                                                 server_default=func.now(), onupdate=func.now())


class ReportVersion(Base):
    __tablename__ = "report_versions"
    __table_args__ = (
        CheckConstraint("source IN ('typed', 'dictated', 'mixed')", name="source"),
        CheckConstraint("status IN ('draft', 'final', 'amended')", name="status"),
    )

    report_id: Mapped[int] = mapped_column(ForeignKey("reports.id"), primary_key=True)
    version: Mapped[int] = mapped_column(Integer, primary_key=True)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    icd10: Mapped[str | None] = mapped_column(Text)
    diagnosis: Mapped[str | None] = mapped_column(Text)
    findings: Mapped[str | None] = mapped_column(Text)
    impression: Mapped[str | None] = mapped_column(Text)
    source: Mapped[str] = mapped_column(Text, nullable=False, server_default="typed")   # for dictation later
    edited_by: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    edited_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
