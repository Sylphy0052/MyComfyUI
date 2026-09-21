"""add project portability

Revision ID: e482fd130aa6
Revises: 31f5c8a2d907
Create Date: 2026-09-22 17:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e482fd130aa6"
down_revision: str | Sequence[str] | None = "31f5c8a2d907"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "project_template",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("name", sa.Text(collation="NOCASE"), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("settings", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name", name="uq_project_template_name"),
    )
    with op.batch_alter_table("artifact") as batch_op:
        batch_op.alter_column("job_id", existing_type=sa.String(length=36), nullable=True)


def downgrade() -> None:
    with op.batch_alter_table("artifact") as batch_op:
        batch_op.alter_column("job_id", existing_type=sa.String(length=36), nullable=False)
    op.drop_table("project_template")
