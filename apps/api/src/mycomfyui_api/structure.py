"""ローカルProjectのScene・Shot管理API。"""

import hashlib
import json
from typing import Annotated, Any

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette import status

from mycomfyui_api import schemas
from mycomfyui_api.db import get_session
from mycomfyui_api.errors import ApiError
from mycomfyui_api.models import Artifact, GenerationJob, Project, ProjectScene, ProjectShot

router = APIRouter(prefix="/api/v1/projects", tags=["projects"])
SessionDep = Annotated[AsyncSession, Depends(get_session)]
ACTIVE_JOB_STATES = ("queued", "running", "cancelling")
PRODUCTION_STATUSES = (
    "not_started",
    "in_progress",
    "has_candidates",
    "accepted",
    "completed",
)
PRODUCTION_RANK = {key: index for index, key in enumerate(PRODUCTION_STATUSES)}
PROGRESS_ARTIFACT_KINDS = ("image", "video", "audio")


def _not_found(resource: str, resource_id: str) -> ApiError:
    return ApiError(
        "REFERENCE_NOT_FOUND",
        f"{resource}がありません。",
        status_code=status.HTTP_404_NOT_FOUND,
        details={"resource": resource, "id": resource_id},
    )


async def require_project(session: AsyncSession, project_id: str) -> Project:
    project = await session.get(Project, project_id)
    if project is None or project.lifecycle == "trashed":
        raise _not_found("Project", project_id)
    return project


async def _require_editable_project(session: AsyncSession, project_id: str) -> Project:
    project = await require_project(session, project_id)
    if project.source_type != "local":
        raise ApiError(
            "PROJECT_EXTERNAL_READ_ONLY",
            "外部同期ProjectのScene・Shotは読取り専用です。",
            status_code=status.HTTP_409_CONFLICT,
            details={"project_id": project_id},
        )
    if project.lifecycle != "active":
        raise ApiError(
            "PROJECT_NOT_ACTIVE",
            "Scene・Shotを変更するにはProjectを復元してください。",
            status_code=status.HTTP_409_CONFLICT,
            details={"project_id": project_id, "lifecycle": project.lifecycle},
        )
    return project


async def get_local_scene(
    session: AsyncSession, project_id: str, scene_id: str
) -> ProjectScene:
    scene = await session.get(ProjectScene, scene_id)
    if scene is None or scene.project_id != project_id or scene.deleted_at is not None:
        raise _not_found("Scene", scene_id)
    return scene


async def get_local_shot(
    session: AsyncSession, project_id: str, scene_id: str, shot_id: str
) -> ProjectShot:
    shot = await session.get(ProjectShot, shot_id)
    if (
        shot is None
        or shot.project_id != project_id
        or shot.scene_id != scene_id
        or shot.deleted_at is not None
    ):
        raise _not_found("Shot", shot_id)
    return shot


def _canonical(data: dict[str, Any]) -> bytes:
    return json.dumps(
        data, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def _reference(project_id: str, path: str, data: dict[str, Any]) -> dict[str, str]:
    body = _canonical(data)
    return {
        "source_locator": f"mycomfyui://projects/{project_id}",
        "revision": hashlib.sha1(body).hexdigest(),
        "path": path,
        "sha256": hashlib.sha256(body).hexdigest(),
    }


async def scene_summary(session: AsyncSession, scene: ProjectScene) -> dict[str, Any]:
    shot_count = int(
        await session.scalar(
            select(func.count())
            .select_from(ProjectShot)
            .where(ProjectShot.scene_id == scene.id, ProjectShot.deleted_at.is_(None))
        )
        or 0
    )
    data = {
        "id": scene.id,
        "project_id": scene.project_id,
        "sequence": scene.sequence,
        "summary": scene.summary,
        "notes": scene.notes,
        "tags": list(scene.tags or []),
        "production_status": scene.production_status,
        "todo": scene.todo,
        "due_date": scene.due_date,
        "priority": scene.priority,
        "shot_count": shot_count,
    }
    return {**data, "reference": _reference(scene.project_id, f"scenes/{scene.id}", data)}


def shot_summary(shot: ProjectShot) -> dict[str, Any]:
    data = {
        "id": shot.id,
        "scene_id": shot.scene_id,
        "sequence": shot.sequence,
        "duration_sec": shot.duration_sec,
        "summary": shot.summary,
        "notes": shot.notes,
        "tags": list(shot.tags or []),
        "production_status": shot.production_status,
        "todo": shot.todo,
        "due_date": shot.due_date,
        "priority": shot.priority,
    }
    return {
        **data,
        "reference": _reference(
            shot.project_id, f"scenes/{shot.scene_id}/shots/{shot.id}", data
        ),
    }


async def scene_envelope(session: AsyncSession, scene: ProjectScene) -> dict[str, Any]:
    summary = await scene_summary(session, scene)
    data = {key: value for key, value in summary.items() if key != "reference"}
    return {
        "kind": "scene",
        "data": data,
        "provenance": {"resource": summary["reference"], "references": []},
    }


def shot_envelope(shot: ProjectShot) -> dict[str, Any]:
    summary = shot_summary(shot)
    data = {key: value for key, value in summary.items() if key != "reference"}
    return {
        "kind": "shot",
        "data": data,
        "provenance": {"resource": summary["reference"], "references": []},
    }


async def _refresh_counts(session: AsyncSession, project: Project) -> None:
    project.scene_count = int(
        await session.scalar(
            select(func.count())
            .select_from(ProjectScene)
            .where(ProjectScene.project_id == project.id, ProjectScene.deleted_at.is_(None))
        )
        or 0
    )
    project.shot_count = int(
        await session.scalar(
            select(func.count())
            .select_from(ProjectShot)
            .where(ProjectShot.project_id == project.id, ProjectShot.deleted_at.is_(None))
        )
        or 0
    )
    project.updated_at = schemas.now_iso()


async def _impact(
    session: AsyncSession,
    *,
    resource_id: str,
    scene_id: str,
    shot_id: str | None = None,
) -> schemas.StructureDeletionImpact:
    job_filter = GenerationJob.assigned_scene_id == scene_id
    if shot_id is not None:
        job_filter = GenerationJob.assigned_shot_id == shot_id
    job_count = int(
        await session.scalar(select(func.count()).select_from(GenerationJob).where(job_filter))
        or 0
    )
    active_job_count = int(
        await session.scalar(
            select(func.count())
            .select_from(GenerationJob)
            .where(job_filter, GenerationJob.state.in_(ACTIVE_JOB_STATES))
        )
        or 0
    )
    artifact_count = int(
        await session.scalar(
            select(func.count())
            .select_from(Artifact)
            .where(
                Artifact.assigned_shot_id == shot_id
                if shot_id is not None
                else Artifact.assigned_scene_id == scene_id
            )
        )
        or 0
    )
    shot_count = 0
    if shot_id is None:
        shot_count = int(
            await session.scalar(
                select(func.count())
                .select_from(ProjectShot)
                .where(ProjectShot.scene_id == scene_id, ProjectShot.deleted_at.is_(None))
            )
            or 0
        )
    blockers = (
        ["実行中または待機中のJobがあるため削除できません。"]
        if active_job_count
        else []
    )
    return schemas.StructureDeletionImpact(
        resource_id=resource_id,
        shot_count=shot_count,
        job_count=job_count,
        artifact_count=artifact_count,
        active_job_count=active_job_count,
        requires_confirmation=bool(shot_count or job_count or artifact_count),
        blockers=blockers,
    )


def _apply_update(target: ProjectScene | ProjectShot, payload: Any) -> None:
    for field in payload.model_fields_set:
        value = getattr(payload, field)
        if field in {"summary", "tags", "production_status", "duration_sec"} and value is None:
            raise ApiError(
                "STRUCTURE_FIELD_REQUIRED",
                f"{field}をnullにできません。",
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        setattr(target, field, list(value) if field == "tags" else value)
    target.updated_at = schemas.now_iso()


async def _reorder(
    session: AsyncSession,
    rows: list[ProjectScene] | list[ProjectShot],
    ids: list[str],
) -> None:
    if len(ids) != len(set(ids)) or set(ids) != {row.id for row in rows}:
        raise ApiError(
            "INVALID_STRUCTURE_ORDER",
            "並び順には現在のIDを重複なくすべて指定してください。",
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    index = {row.id: row for row in rows}
    for sequence, resource_id in enumerate(ids, start=1):
        index[resource_id].sequence = -sequence
    await session.flush()
    now = schemas.now_iso()
    for sequence, resource_id in enumerate(ids, start=1):
        row = index[resource_id]
        row.sequence = sequence
        row.updated_at = now


@router.post("/{project_id}/scenes", status_code=status.HTTP_201_CREATED)
async def create_scene(project_id: schemas.AiMediaId, payload: schemas.SceneCreate, session: SessionDep):
    project = await _require_editable_project(session, project_id)
    sequence = int(
        await session.scalar(
            select(func.coalesce(func.max(ProjectScene.sequence), 0)).where(
                ProjectScene.project_id == project_id, ProjectScene.deleted_at.is_(None)
            )
        )
        or 0
    ) + 1
    now = schemas.now_iso()
    scene = ProjectScene(
        id=schemas.new_id(), project_id=project_id, sequence=sequence,
        summary=payload.summary, notes=payload.notes, tags=list(payload.tags),
        production_status=payload.production_status, todo=payload.todo,
        due_date=payload.due_date, priority=payload.priority, created_at=now, updated_at=now,
        deleted_at=None,
    )
    session.add(scene)
    await session.flush()
    await _refresh_counts(session, project)
    await session.commit()
    return await scene_envelope(session, scene)


@router.patch("/{project_id}/scenes/{scene_id}")
async def update_scene(project_id: schemas.AiMediaId, scene_id: schemas.ResourceId, payload: schemas.SceneUpdate, session: SessionDep):
    await _require_editable_project(session, project_id)
    scene = await get_local_scene(session, project_id, scene_id)
    _apply_update(scene, payload)
    await session.commit()
    return await scene_envelope(session, scene)


@router.post("/{project_id}/scenes/reorder")
async def reorder_scenes(project_id: schemas.AiMediaId, payload: schemas.StructureReorder, session: SessionDep):
    project = await _require_editable_project(session, project_id)
    rows = list(await session.scalars(select(ProjectScene).where(ProjectScene.project_id == project_id, ProjectScene.deleted_at.is_(None))))
    await _reorder(session, rows, payload.ids)
    project.updated_at = schemas.now_iso()
    await session.commit()
    ordered = sorted(rows, key=lambda row: row.sequence)
    return {"items": [await scene_summary(session, row) for row in ordered]}


@router.get("/{project_id}/scenes/{scene_id}/deletion-impact", response_model=schemas.StructureDeletionImpact)
async def get_scene_deletion_impact(project_id: schemas.AiMediaId, scene_id: schemas.ResourceId, session: SessionDep):
    await require_project(session, project_id)
    await get_local_scene(session, project_id, scene_id)
    return await _impact(session, resource_id=scene_id, scene_id=scene_id)


@router.delete("/{project_id}/scenes/{scene_id}")
async def delete_scene(project_id: schemas.AiMediaId, scene_id: schemas.ResourceId, session: SessionDep, confirm: bool = False):
    project = await _require_editable_project(session, project_id)
    scene = await get_local_scene(session, project_id, scene_id)
    impact = await _impact(session, resource_id=scene_id, scene_id=scene_id)
    if impact.blockers:
        raise ApiError("STRUCTURE_HAS_ACTIVE_JOBS", impact.blockers[0], status_code=status.HTTP_409_CONFLICT, details=impact.model_dump())
    if impact.requires_confirmation and not confirm:
        raise ApiError("STRUCTURE_DELETE_CONFIRMATION_REQUIRED", "関連データを残して削除するには確認が必要です。", status_code=status.HTTP_409_CONFLICT, details=impact.model_dump())
    now = schemas.now_iso()
    scene.deleted_at = now
    scene.updated_at = now
    shots = await session.scalars(select(ProjectShot).where(ProjectShot.scene_id == scene_id, ProjectShot.deleted_at.is_(None)))
    for shot in shots:
        shot.deleted_at = now
        shot.updated_at = now
    await _refresh_counts(session, project)
    await session.commit()
    return {"id": scene_id, "deleted_at": now}


@router.post("/{project_id}/scenes/{scene_id}/restore")
async def restore_scene(project_id: schemas.AiMediaId, scene_id: schemas.ResourceId, session: SessionDep):
    """削除したSceneを戻す。同じ削除でまとめて消えたShotも一緒に戻す。"""
    project = await _require_editable_project(session, project_id)
    scene = await session.get(ProjectScene, scene_id)
    if scene is None or scene.project_id != project_id:
        raise _not_found("Scene", scene_id)
    if scene.deleted_at is None:
        raise ApiError("STRUCTURE_NOT_DELETED", "削除されていないSceneは復元できません。", status_code=status.HTTP_409_CONFLICT, details={"scene_id": scene_id})
    deleted_at = scene.deleted_at
    now = schemas.now_iso()
    scene.deleted_at = None
    scene.updated_at = now
    shots = await session.scalars(select(ProjectShot).where(ProjectShot.scene_id == scene_id, ProjectShot.deleted_at == deleted_at))
    for shot in shots:
        shot.deleted_at = None
        shot.updated_at = now
    await _refresh_counts(session, project)
    await session.commit()
    return await scene_envelope(session, scene)


@router.post("/{project_id}/scenes/{scene_id}/shots", status_code=status.HTTP_201_CREATED)
async def create_shot(project_id: schemas.AiMediaId, scene_id: schemas.ResourceId, payload: schemas.ShotCreate, session: SessionDep):
    project = await _require_editable_project(session, project_id)
    await get_local_scene(session, project_id, scene_id)
    sequence = int(await session.scalar(select(func.coalesce(func.max(ProjectShot.sequence), 0)).where(ProjectShot.scene_id == scene_id, ProjectShot.deleted_at.is_(None))) or 0) + 1
    now = schemas.now_iso()
    shot = ProjectShot(
        id=schemas.new_id(), project_id=project_id, scene_id=scene_id,
        sequence=sequence, duration_sec=payload.duration_sec, summary=payload.summary,
        notes=payload.notes, tags=list(payload.tags), production_status=payload.production_status,
        todo=payload.todo, due_date=payload.due_date, priority=payload.priority,
        created_at=now, updated_at=now, deleted_at=None,
    )
    session.add(shot)
    await session.flush()
    await _refresh_counts(session, project)
    await session.commit()
    return shot_envelope(shot)


@router.patch("/{project_id}/scenes/{scene_id}/shots/{shot_id}")
async def update_shot(project_id: schemas.AiMediaId, scene_id: schemas.ResourceId, shot_id: schemas.ResourceId, payload: schemas.ShotUpdate, session: SessionDep):
    await _require_editable_project(session, project_id)
    shot = await get_local_shot(session, project_id, scene_id, shot_id)
    _apply_update(shot, payload)
    await session.commit()
    return shot_envelope(shot)


@router.post("/{project_id}/scenes/{scene_id}/shots/reorder")
async def reorder_shots(project_id: schemas.AiMediaId, scene_id: schemas.ResourceId, payload: schemas.StructureReorder, session: SessionDep):
    project = await _require_editable_project(session, project_id)
    await get_local_scene(session, project_id, scene_id)
    rows = list(await session.scalars(select(ProjectShot).where(ProjectShot.scene_id == scene_id, ProjectShot.deleted_at.is_(None))))
    await _reorder(session, rows, payload.ids)
    project.updated_at = schemas.now_iso()
    await session.commit()
    return {"items": [shot_summary(row) for row in sorted(rows, key=lambda row: row.sequence)]}


@router.get("/{project_id}/scenes/{scene_id}/shots/{shot_id}/deletion-impact", response_model=schemas.StructureDeletionImpact)
async def get_shot_deletion_impact(project_id: schemas.AiMediaId, scene_id: schemas.ResourceId, shot_id: schemas.ResourceId, session: SessionDep):
    await require_project(session, project_id)
    await get_local_shot(session, project_id, scene_id, shot_id)
    return await _impact(session, resource_id=shot_id, scene_id=scene_id, shot_id=shot_id)


@router.delete("/{project_id}/scenes/{scene_id}/shots/{shot_id}")
async def delete_shot(project_id: schemas.AiMediaId, scene_id: schemas.ResourceId, shot_id: schemas.ResourceId, session: SessionDep, confirm: bool = False):
    project = await _require_editable_project(session, project_id)
    shot = await get_local_shot(session, project_id, scene_id, shot_id)
    impact = await _impact(session, resource_id=shot_id, scene_id=scene_id, shot_id=shot_id)
    if impact.blockers:
        raise ApiError("STRUCTURE_HAS_ACTIVE_JOBS", impact.blockers[0], status_code=status.HTTP_409_CONFLICT, details=impact.model_dump())
    if impact.requires_confirmation and not confirm:
        raise ApiError("STRUCTURE_DELETE_CONFIRMATION_REQUIRED", "関連データを残して削除するには確認が必要です。", status_code=status.HTTP_409_CONFLICT, details=impact.model_dump())
    now = schemas.now_iso()
    shot.deleted_at = now
    shot.updated_at = now
    await _refresh_counts(session, project)
    await session.commit()
    return {"id": shot_id, "deleted_at": now}


@router.post("/{project_id}/scenes/{scene_id}/shots/{shot_id}/restore")
async def restore_shot(project_id: schemas.AiMediaId, scene_id: schemas.ResourceId, shot_id: schemas.ResourceId, session: SessionDep):
    """削除したShotを戻す。親Sceneが削除済みなら、先にSceneを戻す必要がある。"""
    project = await _require_editable_project(session, project_id)
    scene = await session.get(ProjectScene, scene_id)
    if scene is None or scene.project_id != project_id:
        raise _not_found("Scene", scene_id)
    if scene.deleted_at is not None:
        raise ApiError("STRUCTURE_PARENT_DELETED", "Shotを戻す前にSceneを復元してください。", status_code=status.HTTP_409_CONFLICT, details={"scene_id": scene_id, "shot_id": shot_id})
    shot = await session.get(ProjectShot, shot_id)
    if shot is None or shot.project_id != project_id or shot.scene_id != scene_id:
        raise _not_found("Shot", shot_id)
    if shot.deleted_at is None:
        raise ApiError("STRUCTURE_NOT_DELETED", "削除されていないShotは復元できません。", status_code=status.HTTP_409_CONFLICT, details={"shot_id": shot_id})
    shot.deleted_at = None
    shot.updated_at = schemas.now_iso()
    await _refresh_counts(session, project)
    await session.commit()
    return shot_envelope(shot)


def _snapshot_group(project: Project, group: str) -> dict[str, Any]:
    snapshot = project.source_snapshot if isinstance(project.source_snapshot, dict) else {}
    values = snapshot.get(group)
    return {key: value for key, value in values.items() if isinstance(value, dict)} if isinstance(values, dict) else {}


def _envelope_scene_id(envelope: dict[str, Any]) -> str | None:
    data = envelope.get("data")
    scene_id = data.get("scene_id") if isinstance(data, dict) else None
    return scene_id if isinstance(scene_id, str) else None


def _advance(statuses: dict[str, str], key: str | None, derived: str) -> None:
    """実績から導いた状態が現在の状態より先なら進める。手動ラベルより後ろへは戻さない。"""
    if key is not None and key in statuses and PRODUCTION_RANK[derived] > PRODUCTION_RANK[statuses[key]]:
        statuses[key] = derived


@router.get("/{project_id}/progress", response_model=schemas.ProjectProgress)
async def get_project_progress(project_id: schemas.AiMediaId, session: SessionDep):
    """Scene・Shotごとに手動ラベルと生成実績の進んでいる方を実効状態とし、件数を返す。"""
    project = await require_project(session, project_id)
    if project.source_type == "local":
        scene_rows = await session.execute(select(ProjectScene.id, ProjectScene.production_status).where(ProjectScene.project_id == project_id, ProjectScene.deleted_at.is_(None)))
        shot_rows = await session.execute(select(ProjectShot.id, ProjectShot.scene_id, ProjectShot.production_status).where(ProjectShot.project_id == project_id, ProjectShot.deleted_at.is_(None)))
        scene_statuses = {scene_id: production_status for scene_id, production_status in scene_rows}
        shot_statuses: dict[str, str] = {}
        shot_scenes: dict[str, str | None] = {}
        for shot_id, scene_id, production_status in shot_rows:
            shot_statuses[shot_id] = production_status
            shot_scenes[shot_id] = scene_id
    else:
        # 外部ソースは制作状態を持たないため、手動ラベルは未着手とみなして実績だけで判定する。
        scene_statuses = {scene_id: "not_started" for scene_id in _snapshot_group(project, "scene_envelopes")}
        shot_envelopes = _snapshot_group(project, "shot_envelopes")
        shot_statuses = {shot_id: "not_started" for shot_id in shot_envelopes}
        shot_scenes = {shot_id: _envelope_scene_id(envelope) for shot_id, envelope in shot_envelopes.items()}

    artifact_rows = await session.execute(select(Artifact.assigned_scene_id, Artifact.assigned_shot_id, Artifact.decision).where(Artifact.assigned_project_id == project_id, Artifact.kind.in_(PROGRESS_ARTIFACT_KINDS)))
    for scene_id, shot_id, decision in artifact_rows:
        derived = {"accepted": "accepted", "undecided": "has_candidates"}.get(decision, "in_progress")
        _advance(scene_statuses, scene_id or shot_scenes.get(shot_id or ""), derived)
        _advance(shot_statuses, shot_id, derived)
    # 失敗・取消だけのJobは制作が進んだ根拠にしない。
    job_rows = await session.execute(select(GenerationJob.assigned_scene_id, GenerationJob.assigned_shot_id, GenerationJob.kind, GenerationJob.state).where(GenerationJob.assigned_project_id == project_id, GenerationJob.state.in_((*ACTIVE_JOB_STATES, "succeeded"))))
    for scene_id, shot_id, kind, state in job_rows:
        # Pipelineの「仕上げ」と同じく、Sceneの合成Jobが成功したらSceneを完了とする。
        scene_derived = "completed" if kind == "compose" and state == "succeeded" else "in_progress"
        _advance(scene_statuses, scene_id or shot_scenes.get(shot_id or ""), scene_derived)
        _advance(shot_statuses, shot_id, "in_progress")

    scenes = {key: 0 for key in PRODUCTION_STATUSES}
    shots = {key: 0 for key in PRODUCTION_STATUSES}
    for production_status in scene_statuses.values():
        scenes[production_status] += 1
    for production_status in shot_statuses.values():
        shots[production_status] += 1
    return schemas.ProjectProgress(project_id=project_id, scenes=scenes, shots=shots)
