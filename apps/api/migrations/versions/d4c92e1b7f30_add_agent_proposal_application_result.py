"""add agent proposal application result

Revision ID: d4c92e1b7f30
Revises: b6f30c9d41a5
Create Date: 2026-09-20 15:00:00.000000

`file.move`の適用で動かした移動元・移動先を残すための列を足す。適用先のIDだけでは
どのパスからどこへ移したのかを辿れないため、監査の情報をこの列へ持たせる。

downgradeは列ごと消すため、記録済みの移動元・移動先は失われる。

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "d4c92e1b7f30"
down_revision: str | Sequence[str] | None = "b6f30c9d41a5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _application_table() -> sa.Table:
    """列を落とすためのagent_proposal_applicationの定義。

    SQLiteは列の削除で表を作り直す必要がある。作り直す側はSQLiteから読み取れない
    CHECK制約を復元できないため、現在の定義を`copy_from`へ明示的に渡す。
    """
    return sa.Table(
        "agent_proposal_application",
        sa.MetaData(),
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("proposal_id", sa.String(length=36), nullable=False),
        sa.Column("step_index", sa.Integer(), nullable=False),
        sa.Column("operation_type", sa.Text(), nullable=False),
        sa.Column("operation_digest", sa.Text(), nullable=False),
        sa.Column("target", sa.JSON(), nullable=False),
        sa.Column("state", sa.Text(), nullable=False),
        sa.Column("applied_ref_type", sa.Text(), nullable=True),
        sa.Column("applied_ref_id", sa.Text(), nullable=True),
        sa.Column("result", sa.JSON(), nullable=True),
        sa.Column("failure_code", sa.Text(), nullable=True),
        sa.Column("failure_message", sa.Text(), nullable=True),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.Text(), nullable=False),
        sa.CheckConstraint(
            "state in ('pending','applying','applied','failed')",
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
        sa.Index("ix_agent_proposal_application_proposal_id", "proposal_id"),
    )


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        "agent_proposal_application",
        sa.Column("result", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table(
        "agent_proposal_application",
        copy_from=_application_table(),
        recreate="always",
    ) as batch_op:
        batch_op.drop_column("result")
