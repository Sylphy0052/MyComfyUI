"""add project operations

Revision ID: f17a2c8e90b4
Revises: e482fd130aa6
Create Date: 2026-09-22 18:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f17a2c8e90b4"
down_revision: str | Sequence[str] | None = "e482fd130aa6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    for table_name in ("project_scene", "project_shot"):
        with op.batch_alter_table(table_name) as batch_op:
            batch_op.add_column(sa.Column("todo", sa.Text(), nullable=True))
            batch_op.add_column(sa.Column("due_date", sa.Text(), nullable=True))
            batch_op.add_column(sa.Column("priority", sa.Text(), nullable=True))

    op.create_table(
        "generation_batch",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("project_id", sa.String(length=160), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("request", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.Text(), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["project.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_generation_batch_project",
        "generation_batch",
        ["project_id", "created_at"],
    )
    op.create_table(
        "generation_batch_item",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("batch_id", sa.String(length=36), nullable=False),
        sa.Column("scene_id", sa.String(length=160), nullable=False),
        sa.Column("shot_id", sa.String(length=160), nullable=True),
        sa.Column("job_id", sa.String(length=36), nullable=True),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("planning_error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.Text(), nullable=False),
        sa.ForeignKeyConstraint(["batch_id"], ["generation_batch.id"]),
        sa.ForeignKeyConstraint(["job_id"], ["generation_job.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_generation_batch_item_batch",
        "generation_batch_item",
        ["batch_id", "created_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_generation_batch_item_batch", table_name="generation_batch_item")
    op.drop_table("generation_batch_item")
    op.drop_index("ix_generation_batch_project", table_name="generation_batch")
    op.drop_table("generation_batch")
    for table_name in ("project_shot", "project_scene"):
        with op.batch_alter_table(table_name) as batch_op:
            batch_op.drop_column("priority")
            batch_op.drop_column("due_date")
            batch_op.drop_column("todo")
