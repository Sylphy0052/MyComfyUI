"""Projectの一括生成計画、進捗操作、履歴統計。"""

import json
from collections import defaultdict
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette import status

from mycomfyui_api import schemas
from mycomfyui_api.db import get_session
from mycomfyui_api.errors import ApiError
from mycomfyui_api.models import (
    GenerationBatch,
    GenerationBatchItem,
    GenerationJob,
    GenerationManifest,
    Project,
    ProjectScene,
    ProjectShot,
    Recipe,
)
from mycomfyui_api.routers import (
    QueueWorkerDep,
    ReferenceSourceDep,
    cancel_generation_job,
    create_generation_job,
    preview_generation_job,
    regenerate_generation_job,
)

router = APIRouter(prefix="/api/v1/projects", tags=["project-operations"])
SessionDep = Annotated[AsyncSession, Depends(get_session)]
TERMINAL_STATES = {"succeeded", "failed", "cancelled"}


def _error(code: str, message: str, *, http_status: int = 400, details: Any = None) -> ApiError:
    return ApiError(code, message, status_code=http_status, details=details)


async def _project(session: AsyncSession, project_id: str) -> Project:
    project = await session.get(Project, project_id)
    if project is None or project.lifecycle == "trashed":
        raise _error("PROJECT_NOT_FOUND", "Projectがありません。", http_status=404)
    return project


async def _active_project(session: AsyncSession, project_id: str) -> Project:
    project = await _project(session, project_id)
    if project.lifecycle != "active":
        raise _error("PROJECT_NOT_ACTIVE", "一括生成にはactiveなProjectが必要です。", http_status=409)
    return project


async def _validate_targets(
    session: AsyncSession,
    project: Project,
    targets: list[schemas.BatchTarget],
) -> None:
    if project.source_type != "local":
        return
    for target in targets:
        scene = await session.get(ProjectScene, target.scene_id)
        if scene is None or scene.project_id != project.id or scene.deleted_at is not None:
            raise _error("BATCH_TARGET_NOT_FOUND", "一括生成対象のSceneがありません。", http_status=404)
        if target.shot_id is None:
            continue
        shot = await session.get(ProjectShot, target.shot_id)
        if (
            shot is None
            or shot.project_id != project.id
            or shot.scene_id != target.scene_id
            or shot.deleted_at is not None
        ):
            raise _error("BATCH_TARGET_NOT_FOUND", "一括生成対象のShotがありません。", http_status=404)


def _job_payload(
    project_id: str,
    request: schemas.GenerationBatchCreate,
    target: schemas.BatchTarget,
) -> schemas.GenerationJobCreate:
    return schemas.GenerationJobCreate(
        kind=request.kind,
        project_id=project_id,
        scene_id=target.scene_id,
        shot_id=target.shot_id,
        recipe_id=request.recipe_id,
        use_inherited_defaults=request.use_inherited_defaults,
        inputs=request.inputs,
        input_refs=request.input_refs,
    )


async def _preview(
    project_id: str,
    payload: schemas.GenerationBatchCreate,
    session: AsyncSession,
    source: Any,
) -> schemas.GenerationBatchPreview:
    project = await _active_project(session, project_id)
    await _validate_targets(session, project, payload.targets)
    items: list[schemas.GenerationBatchPreviewItem] = []
    recipe_ids: set[str] = set()
    workflows: set[str] = set()
    references: set[str] = set()
    for target in payload.targets:
        preview = await preview_generation_job(
            schemas.GenerationPreviewCreate.model_validate(
                _job_payload(project_id, payload, target).model_dump(exclude={"queue_sequence"})
            ),
            session,
            source,
        )
        recipe_ids.add(preview.recipe_id)
        if preview.workflow_version_id:
            workflows.add(preview.workflow_version_id)
        for reference in [
            preview.scene_ref,
            preview.shot_ref,
            *preview.canon_refs,
            *preview.input_refs,
        ]:
            if reference:
                references.add(
                    json.dumps(reference, ensure_ascii=False, sort_keys=True)
                )
        items.append(
            schemas.GenerationBatchPreviewItem(
                scene_id=target.scene_id,
                shot_id=target.shot_id,
                recipe_id=preview.recipe_id,
                recipe_origin=preview.recipe_origin,
                engine=preview.engine,
                model=preview.model,
                seed=preview.seed,
                seed_auto=preview.seed_auto,
                parameters=preview.parameters,
                resolved_inputs=preview.resolved_inputs,
                workflow_name=preview.workflow_name,
                workflow_version_id=preview.workflow_version_id,
                parent_job_id=preview.parent_job_id,
            )
        )
    return schemas.GenerationBatchPreview(
        name=payload.name,
        kind=payload.kind,
        job_count=len(items),
        recipe_ids=sorted(recipe_ids),
        workflow_dependencies=sorted(workflows),
        reference_dependencies=sorted(references),
        items=items,
    )


async def _batch_read(session: AsyncSession, batch: GenerationBatch) -> schemas.GenerationBatchRead:
    items = list(
        await session.scalars(
            select(GenerationBatchItem)
            .where(GenerationBatchItem.batch_id == batch.id)
            .order_by(GenerationBatchItem.created_at, GenerationBatchItem.id)
        )
    )
    job_ids = [item.job_id for item in items if item.job_id]
    jobs = {
        row.id: row
        for row in (
            list(await session.scalars(select(GenerationJob).where(GenerationJob.id.in_(job_ids))))
            if job_ids
            else []
        )
    }
    reads: list[schemas.GenerationBatchItemRead] = []
    counts: dict[str, int] = defaultdict(int)
    for item in items:
        job = jobs.get(item.job_id or "")
        state = job.state if job else ("planning_failed" if item.planning_error else "pending")
        counts[state] += 1
        reads.append(
            schemas.GenerationBatchItemRead(
                id=item.id,
                scene_id=item.scene_id,
                shot_id=item.shot_id,
                job_id=item.job_id,
                state=state,
                attempts=item.attempts,
                planning_error=item.planning_error,
            )
        )
    states = {item.state for item in reads}
    if not reads or states == {"pending"}:
        batch_state = "pending"
    elif states <= TERMINAL_STATES | {"planning_failed"}:
        batch_state = "completed" if states == {"succeeded"} else "completed_with_errors"
    else:
        batch_state = "running"
    return schemas.GenerationBatchRead(
        id=batch.id,
        project_id=batch.project_id,
        name=batch.name,
        kind=batch.kind,
        state=batch_state,
        counts=dict(counts),
        items=reads,
        created_at=batch.created_at,
        updated_at=batch.updated_at,
    )


async def _require_batch(
    session: AsyncSession, project_id: str, batch_id: str
) -> GenerationBatch:
    batch = await session.get(GenerationBatch, batch_id)
    if batch is None or batch.project_id != project_id:
        raise _error("BATCH_NOT_FOUND", "一括生成計画がありません。", http_status=404)
    return batch


@router.post(
    "/{project_id}/batches/preview",
    response_model=schemas.GenerationBatchPreview,
)
async def preview_batch(
    project_id: str,
    payload: schemas.GenerationBatchCreate,
    session: SessionDep,
    source: ReferenceSourceDep,
):
    return await _preview(project_id, payload, session, source)


@router.post(
    "/{project_id}/batches",
    response_model=schemas.GenerationBatchRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_batch(
    project_id: str,
    payload: schemas.GenerationBatchCreate,
    session: SessionDep,
    source: ReferenceSourceDep,
):
    await _preview(project_id, payload, session, source)
    now = schemas.now_iso()
    batch = GenerationBatch(
        id=schemas.new_id(),
        project_id=project_id,
        name=payload.name,
        kind=payload.kind,
        request=payload.model_dump(mode="json"),
        created_at=now,
        updated_at=now,
    )
    session.add(batch)
    items: list[tuple[GenerationBatchItem, schemas.BatchTarget]] = []
    for target in payload.targets:
        item = GenerationBatchItem(
            id=schemas.new_id(),
            batch_id=batch.id,
            scene_id=target.scene_id,
            shot_id=target.shot_id,
            job_id=None,
            attempts=0,
            planning_error=None,
            created_at=now,
            updated_at=now,
        )
        session.add(item)
        items.append((item, target))
    await session.commit()

    for item, target in items:
        item.attempts = 1
        try:
            job = await create_generation_job(
                _job_payload(project_id, payload, target), session, source
            )
            item.job_id = job.id
            item.attempts = 1
            item.planning_error = None
        except ApiError as error:
            item.planning_error = f"{error.code}: {error.message}"
        item.updated_at = schemas.now_iso()
        batch.updated_at = item.updated_at
        await session.commit()
    return await _batch_read(session, batch)


@router.get("/{project_id}/batches", response_model=list[schemas.GenerationBatchRead])
async def list_batches(project_id: str, session: SessionDep):
    await _project(session, project_id)
    rows = list(
        await session.scalars(
            select(GenerationBatch)
            .where(GenerationBatch.project_id == project_id)
            .order_by(GenerationBatch.created_at.desc())
        )
    )
    return [await _batch_read(session, row) for row in rows]


@router.get(
    "/{project_id}/batches/{batch_id}", response_model=schemas.GenerationBatchRead
)
async def get_batch(project_id: str, batch_id: str, session: SessionDep):
    await _project(session, project_id)
    return await _batch_read(session, await _require_batch(session, project_id, batch_id))


@router.post(
    "/{project_id}/batches/{batch_id}/cancel-pending",
    response_model=schemas.GenerationBatchRead,
)
async def cancel_pending_batch_jobs(
    project_id: str,
    batch_id: str,
    session: SessionDep,
    worker: QueueWorkerDep,
):
    await _project(session, project_id)
    batch = await _require_batch(session, project_id, batch_id)
    items = list(
        await session.scalars(
            select(GenerationBatchItem).where(GenerationBatchItem.batch_id == batch.id)
        )
    )
    for item in items:
        if not item.job_id:
            continue
        job = await session.get(GenerationJob, item.job_id)
        if job is not None and job.state == "queued":
            await cancel_generation_job(job.id, session, worker)
    batch.updated_at = schemas.now_iso()
    await session.commit()
    return await _batch_read(session, batch)


@router.post(
    "/{project_id}/batches/{batch_id}/retry-failed",
    response_model=schemas.GenerationBatchRead,
)
async def retry_failed_batch_jobs(
    project_id: str,
    batch_id: str,
    session: SessionDep,
    source: ReferenceSourceDep,
):
    await _active_project(session, project_id)
    batch = await _require_batch(session, project_id, batch_id)
    request = schemas.GenerationBatchCreate.model_validate(batch.request)
    items = list(
        await session.scalars(
            select(GenerationBatchItem).where(GenerationBatchItem.batch_id == batch.id)
        )
    )
    for item in items:
        job = await session.get(GenerationJob, item.job_id) if item.job_id else None
        if job is None and item.planning_error:
            target = schemas.BatchTarget(scene_id=item.scene_id, shot_id=item.shot_id)
            item.attempts += 1
            try:
                replacement = await create_generation_job(
                    _job_payload(project_id, request, target), session, source
                )
                item.job_id = replacement.id
                item.planning_error = None
            except ApiError as error:
                item.planning_error = f"{error.code}: {error.message}"
        elif job is not None and job.state == "failed":
            item.attempts += 1
            try:
                replacement = await regenerate_generation_job(job.id, session, source)
                item.job_id = replacement.id
                item.planning_error = None
            except ApiError as error:
                item.planning_error = f"{error.code}: {error.message}"
        else:
            continue
        item.updated_at = schemas.now_iso()
        await session.commit()
    batch.updated_at = schemas.now_iso()
    await session.commit()
    return await _batch_read(session, batch)


def _seconds(job: GenerationJob) -> float:
    if not job.started_at or not job.finished_at:
        return 0
    try:
        return max(
            0.0,
            (datetime.fromisoformat(job.finished_at) - datetime.fromisoformat(job.started_at)).total_seconds(),
        )
    except ValueError:
        return 0


def _breakdowns(rows: list[tuple[GenerationJob, GenerationManifest, Recipe]], key: str) -> list[schemas.StatisticsBreakdown]:
    groups: dict[str, list[tuple[GenerationJob, str]]] = defaultdict(list)
    for job, manifest, recipe in rows:
        if key == "model":
            value = json.dumps(manifest.model or {}, ensure_ascii=False, sort_keys=True)
            label = ", ".join(str(item) for item in (manifest.model or {}).values()) or "未記録"
        elif key == "workflow":
            value = recipe.workflow_version_id or "unversioned"
            label = value
        else:
            value = recipe.id
            label = recipe.name
        groups[value].append((job, label))
    return [
        schemas.StatisticsBreakdown(
            key=value,
            label=group[0][1],
            jobs=len(group),
            succeeded=sum(job.state == "succeeded" for job, _ in group),
            failed=sum(job.state == "failed" for job, _ in group),
            processing_seconds=round(sum(_seconds(job) for job, _ in group), 3),
        )
        for value, group in sorted(groups.items())
    ]


@router.get("/{project_id}/statistics", response_model=schemas.ProjectStatistics)
async def project_statistics(
    project_id: str,
    session: SessionDep,
    recipe_id: str | None = None,
    workflow_version_id: str | None = None,
    model: str | None = None,
    date_from: str | None = Query(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
    date_to: str | None = Query(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
):
    await _project(session, project_id)
    query = (
        select(GenerationJob, GenerationManifest, Recipe)
        .join(GenerationManifest, GenerationManifest.id == GenerationJob.manifest_id)
        .join(Recipe, Recipe.id == GenerationJob.recipe_id)
        .where(GenerationJob.assigned_project_id == project_id)
    )
    if recipe_id:
        query = query.where(Recipe.id == recipe_id)
    if workflow_version_id:
        query = query.where(
            Recipe.workflow_version_id.is_(None)
            if workflow_version_id == "unversioned"
            else Recipe.workflow_version_id == workflow_version_id
        )
    if date_from:
        query = query.where(GenerationManifest.created_at >= date_from)
    if date_to:
        query = query.where(GenerationManifest.created_at <= f"{date_to}T23:59:59.999999")
    rows = list((await session.execute(query)).tuples())
    if model:
        needle = model.casefold()
        rows = [
            row
            for row in rows
            if needle in json.dumps(row[1].model or {}, ensure_ascii=False).casefold()
        ]

    jobs = [row[0] for row in rows]
    return schemas.ProjectStatistics(
        project_id=project_id,
        jobs=len(jobs),
        succeeded=sum(job.state == "succeeded" for job in jobs),
        failed=sum(job.state == "failed" for job in jobs),
        cancelled=sum(job.state == "cancelled" for job in jobs),
        processing_seconds=round(sum(_seconds(job) for job in jobs), 3),
        by_model=_breakdowns(rows, "model"),
        by_workflow=_breakdowns(rows, "workflow"),
        by_recipe=_breakdowns(rows, "recipe"),
        cost=schemas.ProjectCostSummary(
            reason="Provider由来の信頼できる料金情報を保存していないため取得できません。"
        ),
    )
