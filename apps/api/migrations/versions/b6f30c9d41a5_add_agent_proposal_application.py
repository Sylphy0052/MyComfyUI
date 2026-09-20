"""add agent proposal application

Revision ID: b6f30c9d41a5
Revises: a4e2c9d51f07
Create Date: 2026-09-20 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b6f30c9d41a5"
down_revision: str | Sequence[str] | None = "a4e2c9d51f07"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_OLD_KINDS = "'shot_breakdown','image_prompt','reference_candidates','recipe_draft'"
_NEW_KINDS = (
    "'shot_breakdown','image_prompt','reference_candidates','recipe_draft',"
    "'workflow_registration_draft','batch_generation_plan','asset_organization_plan'"
)


def _agent_proposal_table(kinds: str) -> sa.Table:
    """CHECK制約を差し替えるためのagent_proposalの定義。

    SQLiteはCHECK制約を後から付け替えられないため、batch modeで表を作り直す。
    作り直す側はSQLiteから読み取れない制約を復元できないので、現在の定義を
    `copy_from`へ明示的に渡す。
    """
    return sa.Table(
        "agent_proposal",
        sa.MetaData(),
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
        sa.CheckConstraint(f"kind in ({kinds})", name="ck_agent_proposal_kind"),
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


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table(
        "agent_proposal",
        copy_from=_agent_proposal_table(_OLD_KINDS),
        recreate="always",
    ) as batch_op:
        batch_op.drop_constraint("ck_agent_proposal_kind", type_="check")
        batch_op.create_check_constraint(
            "ck_agent_proposal_kind", f"kind in ({_NEW_KINDS})"
        )
    op.create_table(
        "agent_proposal_application",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("proposal_id", sa.String(length=36), nullable=False),
        sa.Column("step_index", sa.Integer(), nullable=False),
        sa.Column("operation_type", sa.Text(), nullable=False),
        sa.Column("operation_digest", sa.Text(), nullable=False),
        sa.Column("target", sa.JSON(), nullable=False),
        sa.Column("state", sa.Text(), nullable=False),
        sa.Column("applied_ref_type", sa.Text(), nullable=True),
        sa.Column("applied_ref_id", sa.Text(), nullable=True),
        sa.Column("failure_code", sa.Text(), nullable=True),
        sa.Column("failure_message", sa.Text(), nullable=True),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.Text(), nullable=False),
        sa.CheckConstraint(
            "state in ('pending','applied','failed')",
            name="ck_agent_proposal_application_state",
        ),
        sa.ForeignKeyConstraint(
            ["proposal_id"],
            ["agent_proposal.id"],
            name="fk_agent_proposal_application_proposal_id",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_agent_proposal_application"),
        sa.UniqueConstraint(
            "proposal_id",
            "step_index",
            name="uq_agent_proposal_application_proposal_id_step_index",
        ),
    )
    op.create_index(
        "ix_agent_proposal_application_proposal_id",
        "agent_proposal_application",
        ["proposal_id"],
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(
        "ix_agent_proposal_application_proposal_id",
        table_name="agent_proposal_application",
    )
    op.drop_table("agent_proposal_application")
    # 準備段階の提案が残っているとCHECK制約に反する。戻す先では扱えない記録のため、
    # 制約を戻す前に消す。
    op.execute(
        "delete from agent_proposal where kind in ('workflow_registration_draft',"
        "'batch_generation_plan','asset_organization_plan')"
    )
    with op.batch_alter_table(
        "agent_proposal",
        copy_from=_agent_proposal_table(_NEW_KINDS),
        recreate="always",
    ) as batch_op:
        batch_op.drop_constraint("ck_agent_proposal_kind", type_="check")
        batch_op.create_check_constraint(
            "ck_agent_proposal_kind", f"kind in ({_OLD_KINDS})"
        )
