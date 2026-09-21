"""add current job and artifact assignments

Revision ID: c84e9a1d2f30
Revises: a71ce48d925f
Create Date: 2026-09-22 13:30:00.000000

生成時の参照を変更せず、現在の整理先を独立して保持する。
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c84e9a1d2f30"
down_revision: str | Sequence[str] | None = "a71ce48d925f"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _reference_ids(
    scene_ref: object, shot_ref: object
) -> tuple[str | None, str | None, str | None]:
    scene = scene_ref if isinstance(scene_ref, dict) else {}
    shot = shot_ref if isinstance(shot_ref, dict) else {}
    project_id = scene.get("project_id") or shot.get("project_id")
    scene_id = scene.get("id")
    shot_id = shot.get("id")
    return (
        project_id if isinstance(project_id, str) else None,
        scene_id if isinstance(scene_id, str) else None,
        shot_id if isinstance(shot_id, str) else None,
    )


def upgrade() -> None:
    for table_name in ("generation_job", "artifact"):
        with op.batch_alter_table(table_name) as batch_op:
            batch_op.add_column(
                sa.Column("assigned_project_id", sa.String(length=128), nullable=True)
            )
            batch_op.add_column(
                sa.Column("assigned_scene_id", sa.String(length=128), nullable=True)
            )
            batch_op.add_column(
                sa.Column("assigned_shot_id", sa.String(length=128), nullable=True)
            )

    connection = op.get_bind()
    jobs = sa.table(
        "generation_job",
        sa.column("id", sa.String()),
        sa.column("scene_ref", sa.JSON()),
        sa.column("shot_ref", sa.JSON()),
        sa.column("assigned_project_id", sa.String()),
        sa.column("assigned_scene_id", sa.String()),
        sa.column("assigned_shot_id", sa.String()),
    )
    assignments: dict[str, tuple[str | None, str | None, str | None]] = {}
    for row in connection.execute(sa.select(jobs.c.id, jobs.c.scene_ref, jobs.c.shot_ref)):
        target = _reference_ids(row.scene_ref, row.shot_ref)
        assignments[row.id] = target
        connection.execute(
            jobs.update().where(jobs.c.id == row.id).values(
                assigned_project_id=target[0],
                assigned_scene_id=target[1],
                assigned_shot_id=target[2],
            )
        )

    artifacts = sa.table(
        "artifact",
        sa.column("id", sa.String()),
        sa.column("job_id", sa.String()),
        sa.column("assigned_project_id", sa.String()),
        sa.column("assigned_scene_id", sa.String()),
        sa.column("assigned_shot_id", sa.String()),
    )
    for row in connection.execute(sa.select(artifacts.c.id, artifacts.c.job_id)):
        target = assignments.get(row.job_id, (None, None, None))
        connection.execute(
            artifacts.update().where(artifacts.c.id == row.id).values(
                assigned_project_id=target[0],
                assigned_scene_id=target[1],
                assigned_shot_id=target[2],
            )
        )

    op.create_index(
        "ix_generation_job_assignment",
        "generation_job",
        ["assigned_project_id", "assigned_scene_id", "assigned_shot_id"],
        unique=False,
    )
    op.create_index(
        "ix_artifact_assignment",
        "artifact",
        ["assigned_project_id", "assigned_scene_id", "assigned_shot_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_artifact_assignment", table_name="artifact")
    op.drop_index("ix_generation_job_assignment", table_name="generation_job")
    for table_name in ("artifact", "generation_job"):
        with op.batch_alter_table(table_name) as batch_op:
            batch_op.drop_column("assigned_shot_id")
            batch_op.drop_column("assigned_scene_id")
            batch_op.drop_column("assigned_project_id")
