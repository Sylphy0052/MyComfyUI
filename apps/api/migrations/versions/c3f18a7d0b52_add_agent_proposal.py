"""add agent proposal

Revision ID: c3f18a7d0b52
Revises: 9a41c2d7f3be
Create Date: 2026-09-20 10:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c3f18a7d0b52"
down_revision: str | Sequence[str] | None = "9a41c2d7f3be"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "agent_proposal",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("provider_id", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("state", sa.Text(), nullable=False),
        sa.Column("project_id", sa.Text(), nullable=False),
        sa.Column("scene_id", sa.Text(), nullable=False),
        sa.Column("shot_id", sa.Text(), nullable=True),
        sa.Column("recipe_id", sa.String(length=36), nullable=True),
        sa.Column("instruction", sa.Text(), nullable=False),
        sa.Column("request_context", sa.JSON(), nullable=False),
        sa.Column("output", sa.JSON(), nullable=True),
        sa.Column("usage", sa.JSON(), nullable=True),
        sa.Column("model", sa.Text(), nullable=True),
        sa.Column("failure_code", sa.Text(), nullable=True),
        sa.Column("failure_message", sa.Text(), nullable=True),
        sa.Column("applied_job_id", sa.String(length=36), nullable=True),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("decided_at", sa.Text(), nullable=True),
        sa.CheckConstraint(
            "kind in ('shot_breakdown','image_prompt','reference_candidates','recipe_draft')",
            name="ck_agent_proposal_kind",
        ),
        sa.CheckConstraint(
            "state in ('proposed','approved','rejected','applied','failed')",
            name="ck_agent_proposal_state",
        ),
        sa.ForeignKeyConstraint(
            ["applied_job_id"],
            ["generation_job.id"],
            name="fk_agent_proposal_applied_job_id",
        ),
        sa.ForeignKeyConstraint(
            ["recipe_id"],
            ["recipe.id"],
            name="fk_agent_proposal_recipe_id",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_agent_proposal"),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table("agent_proposal")
