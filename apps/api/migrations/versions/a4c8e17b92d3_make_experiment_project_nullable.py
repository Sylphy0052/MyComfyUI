"""make generation experiment project nullable

Revision ID: a4c8e17b92d3
Revises: e6a3c91d5b27
Create Date: 2026-10-08 18:00:00.000000

WebUI v2の/imageはProjectを選ばずにスイープを投入できる (#539)。
`generation_experiment.project_id`をNULL可にするだけで、列の追加と削除はしない。

SQLiteのbatch_alter_tableは表を作り直すため、表に紐づくtriggerも消える。
上限triggerは作り直す。`project_id = NULL`は常に偽なので、triggerはProject無しの
実験を数えない。Project無しの上限はアプリ側で見る。
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a4c8e17b92d3"
down_revision: str | Sequence[str] | None = "e6a3c91d5b27"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TRIGGER = (
    "CREATE TRIGGER trg_generation_experiment_limit "
    "BEFORE INSERT ON generation_experiment "
    "WHEN (SELECT COUNT(*) FROM generation_experiment "
    "WHERE project_id = NEW.project_id) >= 200 "
    "BEGIN SELECT RAISE(ABORT, 'generation experiment limit reached'); END"
)


def upgrade() -> None:
    """project_idをNULL可にし、作り直しで消えた上限triggerを戻す。"""
    op.execute("DROP TRIGGER IF EXISTS trg_generation_experiment_limit")
    with op.batch_alter_table("generation_experiment") as batch_op:
        batch_op.alter_column(
            "project_id", existing_type=sa.String(length=128), nullable=True
        )
    op.execute(_TRIGGER)


def downgrade() -> None:
    """Project無しの実験とその項目を消してNOT NULLへ戻す。"""
    op.execute("DROP TRIGGER IF EXISTS trg_generation_experiment_limit")
    op.execute(
        "DELETE FROM generation_experiment_item WHERE experiment_id IN "
        "(SELECT id FROM generation_experiment WHERE project_id IS NULL)"
    )
    op.execute("DELETE FROM generation_experiment WHERE project_id IS NULL")
    with op.batch_alter_table("generation_experiment") as batch_op:
        batch_op.alter_column(
            "project_id", existing_type=sa.String(length=128), nullable=False
        )
    op.execute(_TRIGGER)
