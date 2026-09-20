"""add workflow registry

Revision ID: 7d61b4e0a2c8
Revises: 2b7c40f1a9d3
Create Date: 2026-09-20 05:40:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "7d61b4e0a2c8"
down_revision: str | Sequence[str] | None = "2b7c40f1a9d3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "workflow",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("engines", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.CheckConstraint(
            "kind in ('image','video','voice','music','compose')",
            name="ck_workflow_kind",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_workflow"),
        sa.UniqueConstraint("name", name="uq_workflow_name"),
    )
    op.create_table(
        "workflow_version",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("workflow_id", sa.String(length=36), nullable=False),
        sa.Column("version", sa.Text(), nullable=False),
        sa.Column("template_sha256", sa.String(length=64), nullable=True),
        sa.Column("variables", sa.JSON(), nullable=False),
        sa.Column("model_slots", sa.JSON(), nullable=False),
        sa.Column("inputs", sa.JSON(), nullable=False),
        sa.Column("outputs", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.ForeignKeyConstraint(
            ["workflow_id"],
            ["workflow.id"],
            name="fk_workflow_version_workflow_id",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_workflow_version"),
        sa.UniqueConstraint(
            "workflow_id", "version", name="uq_workflow_version_version"
        ),
    )
    op.create_index(
        "ix_workflow_version_workflow_id",
        "workflow_version",
        ["workflow_id"],
    )
    with op.batch_alter_table("recipe") as batch_op:
        batch_op.add_column(
            sa.Column("workflow_version_id", sa.String(length=36), nullable=True)
        )
        batch_op.create_foreign_key(
            "fk_recipe_workflow_version_id",
            "workflow_version",
            ["workflow_version_id"],
            ["id"],
        )


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table("recipe") as batch_op:
        batch_op.drop_constraint("fk_recipe_workflow_version_id", type_="foreignkey")
        batch_op.drop_column("workflow_version_id")
    op.drop_index("ix_workflow_version_workflow_id", table_name="workflow_version")
    op.drop_table("workflow_version")
    op.drop_table("workflow")
