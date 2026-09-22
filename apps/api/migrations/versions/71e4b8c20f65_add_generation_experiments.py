"""add generation experiments

Revision ID: 71e4b8c20f65
Revises: 6b72c4d91e30
Create Date: 2026-09-22 11:30:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "71e4b8c20f65"
down_revision: str | Sequence[str] | None = "6b72c4d91e30"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "generation_experiment",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("project_id", sa.String(length=128), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("request", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.Text(), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["project.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_generation_experiment_project",
        "generation_experiment",
        ["project_id", "created_at"],
    )
    op.execute(
        "CREATE TRIGGER trg_generation_experiment_limit "
        "BEFORE INSERT ON generation_experiment "
        "WHEN (SELECT COUNT(*) FROM generation_experiment "
        "WHERE project_id = NEW.project_id) >= 200 "
        "BEGIN SELECT RAISE(ABORT, 'generation experiment limit reached'); END"
    )
    op.create_table(
        "generation_experiment_item",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("experiment_id", sa.String(length=36), nullable=False),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.Column("variables", sa.JSON(), nullable=False),
        sa.Column("inputs", sa.JSON(), nullable=False),
        sa.Column("job_id", sa.String(length=36), nullable=True),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("planning_error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.Text(), nullable=False),
        sa.ForeignKeyConstraint(["experiment_id"], ["generation_experiment.id"]),
        sa.ForeignKeyConstraint(["job_id"], ["generation_job.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "experiment_id", "ordinal", name="uq_generation_experiment_item_ordinal"
        ),
    )
    op.create_index(
        "ix_generation_experiment_item_experiment",
        "generation_experiment_item",
        ["experiment_id", "ordinal"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_generation_experiment_item_experiment",
        table_name="generation_experiment_item",
    )
    op.drop_table("generation_experiment_item")
    op.execute("DROP TRIGGER IF EXISTS trg_generation_experiment_limit")
    op.drop_index(
        "ix_generation_experiment_project", table_name="generation_experiment"
    )
    op.drop_table("generation_experiment")
