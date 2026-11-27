"""Instalasi Bedah: operation schedule + operation report, ported from the old backend.

The schedule and report forms stay JSON (they are shown and sent as a whole, never searched by field);
the patient is a real foreign key now.
"""
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, Text, func, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


class Operation(Base):
    __tablename__ = "operations"
    __table_args__ = (
        CheckConstraint("status IN ('scheduled', 'sent')", name="status"),
        Index("ix_operations_patient", "patient_id"),
        Index("ix_operations_updated", text("updated_at DESC")),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(Text, unique=True, nullable=False)        # e.g. OP-261127-4F2A
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"), nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="scheduled")
    schedule: Mapped[dict] = mapped_column(JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    report: Mapped[dict] = mapped_column(JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    satusehat_encounter_id: Mapped[str | None] = mapped_column(Text)
    satusehat_procedure_id: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False,
                                                 server_default=func.now(), onupdate=func.now())
