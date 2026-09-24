"""forbid user script delete

Revision ID: e8b3f6a1c952
Revises: d4a7e2b9c613
Create Date: 2026-09-24 13:00:00.000000

`user_script`と`user_script_run`の削除をDBで拒否する (#200)。

UPDATEを拒否するtriggerだけでは、行を削除してから同じidで入れ直すと、署名対象の列を
UPDATEを経由せずに差し替えられる。アプリに削除の経路は無いため、`user_script_audit_event`
と同じく削除そのものを止める。

"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "e8b3f6a1c952"
down_revision: str | Sequence[str] | None = "d4a7e2b9c613"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        "CREATE TRIGGER trg_user_script_no_delete "
        "BEFORE DELETE ON user_script "
        "BEGIN SELECT RAISE(ABORT, 'user_script is immutable'); END"
    )
    op.execute(
        "CREATE TRIGGER trg_user_script_run_no_delete "
        "BEFORE DELETE ON user_script_run "
        "BEGIN SELECT RAISE(ABORT, 'user_script_run cannot be deleted'); END"
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS trg_user_script_run_no_delete")
    op.execute("DROP TRIGGER IF EXISTS trg_user_script_no_delete")
