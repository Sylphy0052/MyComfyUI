"""add job failure stage and retryable

Revision ID: 00820f6b1610
Revises: 8facbe638ebc
Create Date: 2026-09-19 23:28:21.023555

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "00820f6b1610"
down_revision: str | Sequence[str] | None = "8facbe638ebc"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table("generation_job") as batch_op:
        batch_op.add_column(sa.Column("failure_stage", sa.Text(), nullable=True))
        batch_op.add_column(sa.Column("retryable", sa.Boolean(), nullable=True))
        batch_op.create_check_constraint(
            "ck_generation_job_failure_stage",
            "failure_stage is null or failure_stage in "
            "('backend_start','execution','response_disconnect','timeout')",
        )


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("generation_job") as batch_op:
        batch_op.drop_constraint("ck_generation_job_failure_stage", type_="check")
        batch_op.drop_column("retryable")
        batch_op.drop_column("failure_stage")
