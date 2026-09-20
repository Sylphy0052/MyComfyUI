"""add voice verification

Revision ID: 2b7c40f1a9d3
Revises: c3f18a7d0b52
Create Date: 2026-09-20 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "2b7c40f1a9d3"
down_revision: str | Sequence[str] | None = "c3f18a7d0b52"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "voice_verification",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("job_id", sa.String(length=36), nullable=False),
        sa.Column("artifact_id", sa.String(length=36), nullable=False),
        sa.Column("dialogue_index", sa.Integer(), nullable=False),
        sa.Column("expected_text", sa.Text(), nullable=False),
        sa.Column("expected_reading", sa.Text(), nullable=True),
        sa.Column("asr_text", sa.Text(), nullable=True),
        sa.Column("normalized_expected", sa.Text(), nullable=True),
        sa.Column("normalized_asr", sa.Text(), nullable=True),
        sa.Column("match", sa.Boolean(), nullable=True),
        sa.Column("diff_ratio", sa.Float(), nullable=True),
        sa.Column("audio_sec", sa.Float(), nullable=False),
        sa.Column("padded_sec", sa.Float(), nullable=False),
        sa.Column("target_duration_sec", sa.Float(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.CheckConstraint(
            "status in ('verified','skipped','asr_failed','kana_unavailable')",
            name="ck_voice_verification_status",
        ),
        sa.ForeignKeyConstraint(
            ["artifact_id"],
            ["artifact.id"],
            name="fk_voice_verification_artifact_id",
        ),
        sa.ForeignKeyConstraint(
            ["job_id"],
            ["generation_job.id"],
            name="fk_voice_verification_job_id",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_voice_verification"),
    )
    op.create_index(
        "ix_voice_verification_job_id",
        "voice_verification",
        ["job_id"],
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index("ix_voice_verification_job_id", table_name="voice_verification")
    op.drop_table("voice_verification")
