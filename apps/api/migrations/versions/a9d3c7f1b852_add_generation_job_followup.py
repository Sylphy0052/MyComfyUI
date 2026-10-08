"""add generation_job_followup

Revision ID: a9d3c7f1b852
Revises: e7b3a91c5d24
Create Date: 2026-10-08 21:00:00.000000

親Jobが終端になったあとに自動投入する後続Jobの予約を持つ表を足す (#581)。新しい表を
作るだけで、既存の表と行は変えない。
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a9d3c7f1b852"
down_revision: str | Sequence[str] | None = "e7b3a91c5d24"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "generation_job_followup",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("parent_job_id", sa.String(length=36), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("state", sa.Text(), nullable=False),
        sa.Column("child_job_id", sa.String(length=36), nullable=True),
        sa.Column("failure_message", sa.Text(), nullable=True),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.Text(), nullable=False),
        sa.CheckConstraint(
            "state in ('pending','submitted','skipped','failed')",
            name="ck_generation_job_followup_state",
        ),
        sa.ForeignKeyConstraint(["parent_job_id"], ["generation_job.id"]),
        sa.ForeignKeyConstraint(["child_job_id"], ["generation_job.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_generation_job_followup_parent",
        "generation_job_followup",
        ["parent_job_id"],
    )
    op.create_index(
        "ix_generation_job_followup_state",
        "generation_job_followup",
        ["state"],
    )


def downgrade() -> None:
    """表を消す。後続Jobの予約の記録は失われる。"""
    op.drop_index("ix_generation_job_followup_state", table_name="generation_job_followup")
    op.drop_index("ix_generation_job_followup_parent", table_name="generation_job_followup")
    op.drop_table("generation_job_followup")
