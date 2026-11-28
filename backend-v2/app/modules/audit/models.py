"""Audit log: who did what, to which record, when. Append-only.

The migration adds a trigger that rejects UPDATE and DELETE on this table,
so even a bug in the app cannot rewrite history.
"""
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, Text, func, text
from sqlalchemy.dialects.postgresql import INET, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


class AuditLog(Base):
    __tablename__ = "audit_logs"
    __table_args__ = (
        Index("ix_audit_logs_patient_at", "patient_id", text("at DESC")),   # "who opened this patient?"
        Index("ix_audit_logs_user_at", "user_id", text("at DESC")),         # "what did this user do?"
        Index("ix_audit_logs_at", text("at DESC")),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    username: Mapped[str | None] = mapped_column(Text)        # kept as typed, e.g. for failed logins
    action: Mapped[str] = mapped_column(Text, nullable=False)  # login, login_failed, view_study, finalize_report, ...
    entity_type: Mapped[str | None] = mapped_column(Text)
    entity_id: Mapped[str | None] = mapped_column(Text)
    patient_id: Mapped[int | None] = mapped_column(ForeignKey("patients.id"))
    ip: Mapped[str | None] = mapped_column(INET)
    detail: Mapped[dict] = mapped_column(JSONB, nullable=False, server_default=text("'{}'::jsonb"))
