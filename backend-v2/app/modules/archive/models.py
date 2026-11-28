"""The DICOM archive: Study -> Series -> Instance, plus `storage` (where each file's bytes are).

Every level has a short internal id (bigint, for fast joins) AND its DICOM UID with a UNIQUE
constraint. Lookups coming from DICOM data always go by UID; the internal id never replaces it.
"""
from datetime import datetime

from sqlalchemy import (CHAR, BigInteger, CheckConstraint, DateTime, Float, ForeignKey, Index, Integer, Text,
                        func, text)
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base

STUDY_STATUSES = ("receiving", "unread", "draft", "final", "amended")
UID_CHECK = "{col} ~ '^[0-9]+(\\.[0-9]+)*$' AND length({col}) <= 64"   # DICOM UID: digits and dots, max 64


class Study(Base):
    __tablename__ = "studies"
    __table_args__ = (
        CheckConstraint(UID_CHECK.format(col="study_instance_uid"), name="uid_format"),
        CheckConstraint("status IN ('receiving', 'unread', 'draft', 'final', 'amended')", name="status"),
        Index("ix_studies_patient_date", "patient_id", text("study_datetime DESC")),   # a patient's history
        Index("ix_studies_status_created", "status", text("created_at DESC")),         # worklist tabs
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    study_instance_uid: Mapped[str] = mapped_column(Text, unique=True, nullable=False)   # (0020,000D)
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"), nullable=False)
    order_id: Mapped[int | None] = mapped_column(ForeignKey("orders.id"), unique=True)  # 1 order -> at most 1 study
    accession_number: Mapped[str | None] = mapped_column(Text)                          # (0008,0050)
    study_datetime: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    description: Mapped[str | None] = mapped_column(Text)
    modalities: Mapped[list[str]] = mapped_column(ARRAY(Text), nullable=False, server_default=text("'{}'"))
    # Worklist status, kept in step with the report by the reports module.
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="receiving")
    satusehat_imaging_study_id: Mapped[str | None] = mapped_column(Text)
    uploaded_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False,
                                                 server_default=func.now(), onupdate=func.now())


class Series(Base):
    __tablename__ = "series"
    __table_args__ = (
        CheckConstraint(UID_CHECK.format(col="series_instance_uid"), name="uid_format"),
        Index("ix_series_study", "study_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    series_instance_uid: Mapped[str] = mapped_column(Text, unique=True, nullable=False)  # (0020,000E)
    study_id: Mapped[int] = mapped_column(ForeignKey("studies.id", ondelete="CASCADE"), nullable=False)
    modality: Mapped[str] = mapped_column(Text, nullable=False)                          # (0008,0060)
    series_number: Mapped[int | None] = mapped_column(Integer)
    description: Mapped[str | None] = mapped_column(Text)
    body_part: Mapped[str | None] = mapped_column(Text)
    frame_of_reference_uid: Mapped[str | None] = mapped_column(Text)
    manufacturer: Mapped[str | None] = mapped_column(Text)        # instead of a separate `devices` table
    station_name: Mapped[str | None] = mapped_column(Text)
    instance_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class StoredFile(Base):
    """A file's bytes on disk (or later S3 / PostgreSQL large object). The file is only 'real' if it has a row here."""
    __tablename__ = "storage"
    __table_args__ = (
        CheckConstraint("backend IN ('fs', 's3', 'pg_lo')", name="backend"),
        CheckConstraint("kind IN ('dicom', 'nifti_source', 'derived')", name="kind"),
        CheckConstraint("size_bytes >= 0", name="size"),
        Index("ix_storage_study", "study_id"),
        Index("ix_storage_sha256", "sha256"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    backend: Mapped[str] = mapped_column(Text, nullable=False, server_default="fs")
    relative_path: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False, server_default="dicom")
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    sha256: Mapped[str] = mapped_column(CHAR(64), nullable=False)
    content_type: Mapped[str] = mapped_column(Text, nullable=False)
    original_filename: Mapped[str | None] = mapped_column(Text)
    # Set for study-level source files (e.g. an uploaded NIfTI volume before conversion).
    study_id: Mapped[int | None] = mapped_column(ForeignKey("studies.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class Instance(Base):
    __tablename__ = "instances"
    __table_args__ = (
        CheckConstraint(UID_CHECK.format(col="sop_instance_uid"), name="uid_format"),
        Index("ix_instances_series_number", "series_id", "instance_number"),   # slices in order
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    sop_instance_uid: Mapped[str] = mapped_column(Text, unique=True, nullable=False)     # (0008,0018)
    series_id: Mapped[int] = mapped_column(ForeignKey("series.id", ondelete="CASCADE"), nullable=False)
    sop_class_uid: Mapped[str] = mapped_column(Text, nullable=False)                     # (0008,0016)
    instance_number: Mapped[int | None] = mapped_column(Integer)                         # (0020,0013)
    transfer_syntax_uid: Mapped[str | None] = mapped_column(Text)
    rows: Mapped[int | None] = mapped_column(Integer)
    columns: Mapped[int | None] = mapped_column(Integer)
    number_of_frames: Mapped[int] = mapped_column(Integer, nullable=False, server_default="1")
    slice_location: Mapped[float | None] = mapped_column(Float)
    storage_id: Mapped[int] = mapped_column(ForeignKey("storage.id"), unique=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
