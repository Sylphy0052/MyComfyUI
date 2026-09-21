"""add external project sync

Revision ID: 31f5c8a2d907
Revises: d12b8a6f4e90
Create Date: 2026-09-22 16:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "31f5c8a2d907"
down_revision: str | Sequence[str] | None = "d12b8a6f4e90"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("project") as batch_op:
        batch_op.add_column(
            sa.Column("source_snapshot", sa.JSON(), nullable=False, server_default=sa.text("'{}'"))
        )
        batch_op.add_column(sa.Column("source_snapshot_sha256", sa.String(length=64), nullable=True))
        batch_op.add_column(
            sa.Column("sync_state", sa.Text(), nullable=False, server_default="never")
        )
        batch_op.add_column(
            sa.Column("auto_sync", sa.Boolean(), nullable=False, server_default=sa.false())
        )
        batch_op.add_column(sa.Column("last_synced_at", sa.Text(), nullable=True))
        batch_op.add_column(sa.Column("sync_error", sa.Text(), nullable=True))
        batch_op.create_check_constraint(
            "ck_project_sync_state",
            "sync_state in ('never','synced','outdated','conflicted','failed')",
        )


def downgrade() -> None:
    with op.batch_alter_table("project") as batch_op:
        batch_op.drop_constraint("ck_project_sync_state", type_="check")
        batch_op.drop_column("sync_error")
        batch_op.drop_column("last_synced_at")
        batch_op.drop_column("auto_sync")
        batch_op.drop_column("sync_state")
        batch_op.drop_column("source_snapshot_sha256")
        batch_op.drop_column("source_snapshot")
