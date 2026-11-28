"""Radiology requests (permintaan radiologi). This table is also the worklist.

Status flow: requested -> imaged -> reported, or requested -> returned (sent back to the ward).
"""
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base

ORDER_STATUSES = ("requested", "imaged", "reported", "returned")
MODALITIES = ("CR", "DX", "CT", "MR", "US", "PT", "NM", "XA", "MG")   # DICOM modality codes


class Order(Base):
    __tablename__ = "orders"
    __table_args__ = (
        CheckConstraint("status IN ('requested', 'imaged', 'reported', 'returned')", name="status"),
        CheckConstraint("priority IN ('ROUTINE', 'STAT')", name="priority"),
        CheckConstraint("modality IN ('CR', 'DX', 'CT', 'MR', 'US', 'PT', 'NM', 'XA', 'MG')", name="modality"),
        CheckConstraint("(status = 'returned') = (returned_reason IS NOT NULL)", name="returned_has_reason"),
        Index("ix_orders_status_created", "status", "created_at"),
        Index("ix_orders_patient", "patient_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    # DICOM AccessionNumber (0008,0050), max 16 chars. Links the request to the images. e.g. RQ-261127-4F2A
    accession_number: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"), nullable=False)
    modality: Mapped[str] = mapped_column(Text, nullable=False)
    exam_description: Mapped[str] = mapped_column(Text, nullable=False)
    priority: Mapped[str] = mapped_column(Text, nullable=False, server_default="ROUTINE")
    indication_icd10: Mapped[str | None] = mapped_column(Text)
    indication_text: Mapped[str | None] = mapped_column(Text)
    note: Mapped[str | None] = mapped_column(Text)
    requesting_unit: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="requested")
    returned_reason: Mapped[str | None] = mapped_column(Text)
    returned_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    returned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    requested_by: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False,
                                                 server_default=func.now(), onupdate=func.now())
