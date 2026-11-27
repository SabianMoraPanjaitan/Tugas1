"""Initial schema: users/roles/sessions, patients, orders, the DICOM archive
(studies -> series -> instances + storage), reports + versions, audit log, operations.

Revision ID: 0001_initial
Revises:
Create Date: 2026-11-27
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None

ROLES = [("admin", "Admin"), ("radiografer", "Radiografer"), ("radiolog", "Radiolog"), ("dokter_bedah", "Dokter Bedah")]

TABLES = ["instances", "storage", "report_versions", "reports", "series", "studies", "orders", "operations",
          "audit_logs", "sessions", "patients", "users", "roles"]


def upgrade() -> None:
    # pg_trgm: fast "contains / similar to" text search on patient names.
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    # Numbers for medical record numbers (MR00000001, ...), used by patients.mrn's default.
    op.execute("CREATE SEQUENCE patient_mrn_seq")

    op.create_table('roles',
    sa.Column('code', sa.Text(), nullable=False),
    sa.Column('label', sa.Text(), nullable=False),
    sa.PrimaryKeyConstraint('code', name=op.f('pk_roles'))
    )
    op.create_table('users',
    sa.Column('id', sa.BigInteger(), nullable=False),
    sa.Column('username', sa.Text(), nullable=False),
    sa.Column('full_name', sa.Text(), nullable=False),
    sa.Column('role_code', sa.Text(), nullable=False),
    sa.Column('password_hash', sa.Text(), nullable=False),
    sa.Column('is_active', sa.Boolean(), server_default='true', nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['role_code'], ['roles.code'], name=op.f('fk_users_role_code_roles')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_users')),
    sa.UniqueConstraint('username', name=op.f('uq_users_username'))
    )
    op.create_table('patients',
    sa.Column('id', sa.BigInteger(), nullable=False),
    sa.Column('mrn', sa.Text(), server_default=sa.text("'MR' || lpad(nextval('patient_mrn_seq')::text, 8, '0')"), nullable=False),
    sa.Column('nik', sa.CHAR(length=16), nullable=True),
    sa.Column('ihs_number', sa.Text(), nullable=True),
    sa.Column('satusehat_link', sa.Text(), nullable=True),
    sa.Column('name', sa.Text(), nullable=False),
    sa.Column('sex', sa.Text(), nullable=True),
    sa.Column('birth_date', sa.Date(), nullable=True),
    sa.Column('birth_place', sa.Text(), nullable=True),
    sa.Column('contact', postgresql.JSONB(astext_type=sa.Text()), server_default=sa.text("'{}'::jsonb"), nullable=False),
    sa.Column('created_by', sa.BigInteger(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint("nik ~ '^[0-9]{16}$'", name=op.f('ck_patients_nik_digits')),
    sa.CheckConstraint("satusehat_link IN ('found', 'created')", name=op.f('ck_patients_satusehat_link')),
    sa.CheckConstraint("sex IN ('M', 'F', 'O')", name=op.f('ck_patients_sex')),
    sa.ForeignKeyConstraint(['created_by'], ['users.id'], name=op.f('fk_patients_created_by_users')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_patients')),
    sa.UniqueConstraint('ihs_number', name=op.f('uq_patients_ihs_number')),
    sa.UniqueConstraint('mrn', name=op.f('uq_patients_mrn')),
    sa.UniqueConstraint('nik', name=op.f('uq_patients_nik'))
    )
    op.create_index('ix_patients_name_trgm', 'patients', ['name'], unique=False, postgresql_using='gin', postgresql_ops={'name': 'gin_trgm_ops'})
    op.create_table('sessions',
    sa.Column('token_hash', sa.CHAR(length=64), nullable=False),
    sa.Column('user_id', sa.BigInteger(), nullable=False),
    sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_sessions_user_id_users'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('token_hash', name=op.f('pk_sessions'))
    )
    op.create_index(op.f('ix_sessions_expires_at'), 'sessions', ['expires_at'], unique=False)
    op.create_index(op.f('ix_sessions_user_id'), 'sessions', ['user_id'], unique=False)
    op.create_table('audit_logs',
    sa.Column('id', sa.BigInteger(), nullable=False),
    sa.Column('at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('user_id', sa.BigInteger(), nullable=True),
    sa.Column('username', sa.Text(), nullable=True),
    sa.Column('action', sa.Text(), nullable=False),
    sa.Column('entity_type', sa.Text(), nullable=True),
    sa.Column('entity_id', sa.Text(), nullable=True),
    sa.Column('patient_id', sa.BigInteger(), nullable=True),
    sa.Column('ip', postgresql.INET(), nullable=True),
    sa.Column('detail', postgresql.JSONB(astext_type=sa.Text()), server_default=sa.text("'{}'::jsonb"), nullable=False),
    sa.ForeignKeyConstraint(['patient_id'], ['patients.id'], name=op.f('fk_audit_logs_patient_id_patients')),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_audit_logs_user_id_users')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_audit_logs'))
    )
    op.create_index('ix_audit_logs_at', 'audit_logs', [sa.text('at DESC')], unique=False)
    op.create_index('ix_audit_logs_patient_at', 'audit_logs', ['patient_id', sa.text('at DESC')], unique=False)
    op.create_index('ix_audit_logs_user_at', 'audit_logs', ['user_id', sa.text('at DESC')], unique=False)
    op.create_table('operations',
    sa.Column('id', sa.BigInteger(), nullable=False),
    sa.Column('code', sa.Text(), nullable=False),
    sa.Column('patient_id', sa.BigInteger(), nullable=False),
    sa.Column('status', sa.Text(), server_default='scheduled', nullable=False),
    sa.Column('schedule', postgresql.JSONB(astext_type=sa.Text()), server_default=sa.text("'{}'::jsonb"), nullable=False),
    sa.Column('report', postgresql.JSONB(astext_type=sa.Text()), server_default=sa.text("'{}'::jsonb"), nullable=False),
    sa.Column('satusehat_encounter_id', sa.Text(), nullable=True),
    sa.Column('satusehat_procedure_id', sa.Text(), nullable=True),
    sa.Column('created_by', sa.BigInteger(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint("status IN ('scheduled', 'sent')", name=op.f('ck_operations_status')),
    sa.ForeignKeyConstraint(['created_by'], ['users.id'], name=op.f('fk_operations_created_by_users')),
    sa.ForeignKeyConstraint(['patient_id'], ['patients.id'], name=op.f('fk_operations_patient_id_patients')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_operations')),
    sa.UniqueConstraint('code', name=op.f('uq_operations_code'))
    )
    op.create_index('ix_operations_patient', 'operations', ['patient_id'], unique=False)
    op.create_index('ix_operations_updated', 'operations', [sa.text('updated_at DESC')], unique=False)
    op.create_table('orders',
    sa.Column('id', sa.BigInteger(), nullable=False),
    sa.Column('accession_number', sa.Text(), nullable=False),
    sa.Column('patient_id', sa.BigInteger(), nullable=False),
    sa.Column('modality', sa.Text(), nullable=False),
    sa.Column('exam_description', sa.Text(), nullable=False),
    sa.Column('priority', sa.Text(), server_default='ROUTINE', nullable=False),
    sa.Column('indication_icd10', sa.Text(), nullable=True),
    sa.Column('indication_text', sa.Text(), nullable=True),
    sa.Column('note', sa.Text(), nullable=True),
    sa.Column('requesting_unit', sa.Text(), nullable=True),
    sa.Column('status', sa.Text(), server_default='requested', nullable=False),
    sa.Column('returned_reason', sa.Text(), nullable=True),
    sa.Column('returned_by', sa.BigInteger(), nullable=True),
    sa.Column('returned_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('requested_by', sa.BigInteger(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint("(status = 'returned') = (returned_reason IS NOT NULL)", name=op.f('ck_orders_returned_has_reason')),
    sa.CheckConstraint("modality IN ('CR', 'DX', 'CT', 'MR', 'US', 'PT', 'NM', 'XA', 'MG')", name=op.f('ck_orders_modality')),
    sa.CheckConstraint("priority IN ('ROUTINE', 'STAT')", name=op.f('ck_orders_priority')),
    sa.CheckConstraint("status IN ('requested', 'imaged', 'reported', 'returned')", name=op.f('ck_orders_status')),
    sa.ForeignKeyConstraint(['patient_id'], ['patients.id'], name=op.f('fk_orders_patient_id_patients')),
    sa.ForeignKeyConstraint(['requested_by'], ['users.id'], name=op.f('fk_orders_requested_by_users')),
    sa.ForeignKeyConstraint(['returned_by'], ['users.id'], name=op.f('fk_orders_returned_by_users')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_orders')),
    sa.UniqueConstraint('accession_number', name=op.f('uq_orders_accession_number'))
    )
    op.create_index('ix_orders_patient', 'orders', ['patient_id'], unique=False)
    op.create_index('ix_orders_status_created', 'orders', ['status', 'created_at'], unique=False)
    op.create_table('studies',
    sa.Column('id', sa.BigInteger(), nullable=False),
    sa.Column('study_instance_uid', sa.Text(), nullable=False),
    sa.Column('patient_id', sa.BigInteger(), nullable=False),
    sa.Column('order_id', sa.BigInteger(), nullable=True),
    sa.Column('accession_number', sa.Text(), nullable=True),
    sa.Column('study_datetime', sa.DateTime(timezone=True), nullable=True),
    sa.Column('description', sa.Text(), nullable=True),
    sa.Column('modalities', postgresql.ARRAY(sa.Text()), server_default=sa.text("'{}'"), nullable=False),
    sa.Column('status', sa.Text(), server_default='receiving', nullable=False),
    sa.Column('satusehat_imaging_study_id', sa.Text(), nullable=True),
    sa.Column('uploaded_by', sa.BigInteger(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint("status IN ('receiving', 'unread', 'draft', 'final', 'amended')", name=op.f('ck_studies_status')),
    sa.CheckConstraint("study_instance_uid ~ '^[0-9]+(\\.[0-9]+)*$' AND length(study_instance_uid) <= 64", name=op.f('ck_studies_uid_format')),
    sa.ForeignKeyConstraint(['order_id'], ['orders.id'], name=op.f('fk_studies_order_id_orders')),
    sa.ForeignKeyConstraint(['patient_id'], ['patients.id'], name=op.f('fk_studies_patient_id_patients')),
    sa.ForeignKeyConstraint(['uploaded_by'], ['users.id'], name=op.f('fk_studies_uploaded_by_users')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_studies')),
    sa.UniqueConstraint('order_id', name=op.f('uq_studies_order_id')),
    sa.UniqueConstraint('study_instance_uid', name=op.f('uq_studies_study_instance_uid'))
    )
    op.create_index('ix_studies_patient_date', 'studies', ['patient_id', sa.text('study_datetime DESC')], unique=False)
    op.create_index('ix_studies_status_created', 'studies', ['status', sa.text('created_at DESC')], unique=False)
    op.create_table('reports',
    sa.Column('id', sa.BigInteger(), nullable=False),
    sa.Column('study_id', sa.BigInteger(), nullable=False),
    sa.Column('status', sa.Text(), server_default='draft', nullable=False),
    sa.Column('icd10', sa.Text(), nullable=True),
    sa.Column('diagnosis', sa.Text(), nullable=True),
    sa.Column('findings', sa.Text(), nullable=True),
    sa.Column('impression', sa.Text(), nullable=True),
    sa.Column('author_id', sa.BigInteger(), nullable=False),
    sa.Column('finalized_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('satusehat_diagnostic_report_id', sa.Text(), nullable=True),
    sa.Column('version', sa.Integer(), server_default='1', nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint("(status = 'draft') = (finalized_at IS NULL)", name=op.f('ck_reports_finalized_when_not_draft')),
    sa.CheckConstraint("status IN ('draft', 'final', 'amended')", name=op.f('ck_reports_status')),
    sa.ForeignKeyConstraint(['author_id'], ['users.id'], name=op.f('fk_reports_author_id_users')),
    sa.ForeignKeyConstraint(['study_id'], ['studies.id'], name=op.f('fk_reports_study_id_studies')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_reports')),
    sa.UniqueConstraint('study_id', name=op.f('uq_reports_study_id'))
    )
    op.create_table('series',
    sa.Column('id', sa.BigInteger(), nullable=False),
    sa.Column('series_instance_uid', sa.Text(), nullable=False),
    sa.Column('study_id', sa.BigInteger(), nullable=False),
    sa.Column('modality', sa.Text(), nullable=False),
    sa.Column('series_number', sa.Integer(), nullable=True),
    sa.Column('description', sa.Text(), nullable=True),
    sa.Column('body_part', sa.Text(), nullable=True),
    sa.Column('frame_of_reference_uid', sa.Text(), nullable=True),
    sa.Column('manufacturer', sa.Text(), nullable=True),
    sa.Column('station_name', sa.Text(), nullable=True),
    sa.Column('instance_count', sa.Integer(), server_default='0', nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint("series_instance_uid ~ '^[0-9]+(\\.[0-9]+)*$' AND length(series_instance_uid) <= 64", name=op.f('ck_series_uid_format')),
    sa.ForeignKeyConstraint(['study_id'], ['studies.id'], name=op.f('fk_series_study_id_studies'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_series')),
    sa.UniqueConstraint('series_instance_uid', name=op.f('uq_series_series_instance_uid'))
    )
    op.create_index('ix_series_study', 'series', ['study_id'], unique=False)
    op.create_table('storage',
    sa.Column('id', sa.BigInteger(), nullable=False),
    sa.Column('backend', sa.Text(), server_default='fs', nullable=False),
    sa.Column('relative_path', sa.Text(), nullable=False),
    sa.Column('kind', sa.Text(), server_default='dicom', nullable=False),
    sa.Column('size_bytes', sa.BigInteger(), nullable=False),
    sa.Column('sha256', sa.CHAR(length=64), nullable=False),
    sa.Column('content_type', sa.Text(), nullable=False),
    sa.Column('original_filename', sa.Text(), nullable=True),
    sa.Column('study_id', sa.BigInteger(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint("backend IN ('fs', 's3', 'pg_lo')", name=op.f('ck_storage_backend')),
    sa.CheckConstraint("kind IN ('dicom', 'nifti_source', 'derived')", name=op.f('ck_storage_kind')),
    sa.CheckConstraint('size_bytes >= 0', name=op.f('ck_storage_size')),
    sa.ForeignKeyConstraint(['study_id'], ['studies.id'], name=op.f('fk_storage_study_id_studies'), ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_storage')),
    sa.UniqueConstraint('relative_path', name=op.f('uq_storage_relative_path'))
    )
    op.create_index('ix_storage_sha256', 'storage', ['sha256'], unique=False)
    op.create_index('ix_storage_study', 'storage', ['study_id'], unique=False)
    op.create_table('instances',
    sa.Column('id', sa.BigInteger(), nullable=False),
    sa.Column('sop_instance_uid', sa.Text(), nullable=False),
    sa.Column('series_id', sa.BigInteger(), nullable=False),
    sa.Column('sop_class_uid', sa.Text(), nullable=False),
    sa.Column('instance_number', sa.Integer(), nullable=True),
    sa.Column('transfer_syntax_uid', sa.Text(), nullable=True),
    sa.Column('rows', sa.Integer(), nullable=True),
    sa.Column('columns', sa.Integer(), nullable=True),
    sa.Column('number_of_frames', sa.Integer(), server_default='1', nullable=False),
    sa.Column('slice_location', sa.Float(), nullable=True),
    sa.Column('storage_id', sa.BigInteger(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint("sop_instance_uid ~ '^[0-9]+(\\.[0-9]+)*$' AND length(sop_instance_uid) <= 64", name=op.f('ck_instances_uid_format')),
    sa.ForeignKeyConstraint(['series_id'], ['series.id'], name=op.f('fk_instances_series_id_series'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['storage_id'], ['storage.id'], name=op.f('fk_instances_storage_id_storage')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_instances')),
    sa.UniqueConstraint('sop_instance_uid', name=op.f('uq_instances_sop_instance_uid')),
    sa.UniqueConstraint('storage_id', name=op.f('uq_instances_storage_id'))
    )
    op.create_index('ix_instances_series_number', 'instances', ['series_id', 'instance_number'], unique=False)
    op.create_table('report_versions',
    sa.Column('report_id', sa.BigInteger(), nullable=False),
    sa.Column('version', sa.Integer(), nullable=False),
    sa.Column('status', sa.Text(), nullable=False),
    sa.Column('icd10', sa.Text(), nullable=True),
    sa.Column('diagnosis', sa.Text(), nullable=True),
    sa.Column('findings', sa.Text(), nullable=True),
    sa.Column('impression', sa.Text(), nullable=True),
    sa.Column('source', sa.Text(), server_default='typed', nullable=False),
    sa.Column('edited_by', sa.BigInteger(), nullable=False),
    sa.Column('edited_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint("source IN ('typed', 'dictated', 'mixed')", name=op.f('ck_report_versions_source')),
    sa.CheckConstraint("status IN ('draft', 'final', 'amended')", name=op.f('ck_report_versions_status')),
    sa.ForeignKeyConstraint(['edited_by'], ['users.id'], name=op.f('fk_report_versions_edited_by_users')),
    sa.ForeignKeyConstraint(['report_id'], ['reports.id'], name=op.f('fk_report_versions_report_id_reports')),
    sa.PrimaryKeyConstraint('report_id', 'version', name=op.f('pk_report_versions'))
    )

    op.execute("ALTER SEQUENCE patient_mrn_seq OWNED BY patients.mrn")

    op.bulk_insert(sa.table("roles", sa.column("code", sa.Text), sa.column("label", sa.Text)),
                   [{"code": c, "label": label} for c, label in ROLES])

    # The audit log is append-only: refuse UPDATE and DELETE at the database level.
    op.execute("""
        CREATE FUNCTION audit_logs_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION 'audit_logs is append-only (% refused)', TG_OP;
        END;
        $$
    """)
    op.execute("""
        CREATE TRIGGER audit_logs_no_change BEFORE UPDATE OR DELETE ON audit_logs
        FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only()
    """)


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS audit_logs_no_change ON audit_logs")
    op.execute("DROP FUNCTION IF EXISTS audit_logs_append_only()")
    for table in TABLES:
        op.drop_table(table)
    op.execute("DROP SEQUENCE IF EXISTS patient_mrn_seq")
