"""Projectの一括生成計画、進捗操作、履歴統計。"""

import asyncio
import json
import time
from collections import defaultdict
from collections.abc import AsyncIterator
from datetime import datetime
from itertools import product
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette import status

from mycomfyui_api import schemas
from mycomfyui_api.db import get_session
from mycomfyui_api.errors import ApiError
from mycomfyui_api.models import (
    GenerationBatch,
    GenerationBatchItem,
    GenerationExperiment,
    GenerationExperimentItem,
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
MAX_EXPERIMENTS_PER_PROJECT = 200
MAX_EXPERIMENT_JOBS_PER_PROJECT = 2000
MAX_ACTIVE_EXPERIMENT_JOBS_PER_PROJECT = 200
MAX_EXPERIMENT_ATTEMPTS = 3
EXPERIMENT_MUTATION_LOCK = asyncio.Lock()
EXPERIMENT_PREVIEW_SEMAPHORE = asyncio.Semaphore(2)
_preview_times: dict[str, float] = {}


async def _experiment_mutation_guard() -> AsyncIterator[None]:
    async with EXPERIMENT_MUTATION_LOCK:
        yield


ExperimentMutationDep = Annotated[None, Depends(_experiment_mutation_guard)]


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
        state = (
            "completed"
            if job is not None and job.state == "succeeded"
            else job.state
            if job is not None
            else "failed"
            if item.planning_error
            else "pending"
        )
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
            recorded_id = (
                error.details.get("job_id")
                if error.code == "JOB_RECORD_UNREADABLE" and isinstance(error.details, dict)
                else None
            )
            if isinstance(recorded_id, str):
                item.job_id = recorded_id
                item.planning_error = None
            else:
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
                recorded_id = (
                    error.details.get("job_id")
                    if error.code == "JOB_RECORD_UNREADABLE" and isinstance(error.details, dict)
                    else None
                )
                if isinstance(recorded_id, str):
                    item.job_id = recorded_id
                    item.planning_error = None
                else:
                    item.planning_error = f"{error.code}: {error.message}"
        elif job is not None and job.state == "failed":
            item.attempts += 1
            try:
                replacement = await regenerate_generation_job(job.id, session, source)
                item.job_id = replacement.id
                item.planning_error = None
            except ApiError as error:
                recorded_id = (
                    error.details.get("job_id")
                    if error.code == "JOB_RECORD_UNREADABLE" and isinstance(error.details, dict)
                    else None
                )
                if isinstance(recorded_id, str):
                    item.job_id = recorded_id
                    item.planning_error = None
                else:
                    item.planning_error = f"{error.code}: {error.message}"
        else:
            continue
        item.updated_at = schemas.now_iso()
        await session.commit()
    batch.updated_at = schemas.now_iso()
    await session.commit()
    return await _batch_read(session, batch)


def _expand_experiment(
    payload: schemas.GenerationExperimentCreate,
) -> tuple[list[tuple[dict[str, Any], dict[str, Any]]], int]:
    axes = {
        "seed": payload.axes.seed,
        "cfg": payload.axes.cfg,
        "steps": payload.axes.steps,
        "prompt_fragment": payload.axes.prompt_fragment,
    }
    active = [(name, values) for name, values in axes.items() if values]
    combinations: list[tuple[Any, ...]] = []
    if payload.mode == "cartesian":
        combinations = list(product(*(values for _, values in active)))
    else:
        count = max(len(values) for _, values in active)
        combinations = [
            tuple(values[0] if len(values) == 1 else values[index] for _, values in active)
            for index in range(count)
        ]
    expanded: list[tuple[dict[str, Any], dict[str, Any]]] = []
    seen: set[str] = set()
    duplicates = 0
    for combination in combinations:
        variables = dict(zip((name for name, _ in active), combination, strict=True))
        inputs = dict(payload.base_inputs)
        for name in ("seed", "cfg", "steps"):
            if name in variables:
                inputs[name] = variables[name]
        fragment = variables.get("prompt_fragment")
        if isinstance(fragment, str):
            base = str(inputs.get("positive_prompt") or "").strip()
            inputs["positive_prompt"] = f"{base}, {fragment}" if base else fragment
        key = json.dumps(inputs, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        if key in seen:
            duplicates += 1
            continue
        seen.add(key)
        expanded.append((variables, inputs))
    if len(expanded) > 50:
        raise _error(
            "EXPERIMENT_TOO_LARGE",
            "重複除外後の探索variantは50件以下にしてください。",
            details={"count": len(expanded), "limit": 50},
        )
    return expanded, duplicates


def _experiment_job_payload(
    project_id: str,
    request: schemas.GenerationExperimentCreate,
    inputs: dict[str, Any],
) -> schemas.GenerationJobCreate:
    return schemas.GenerationJobCreate(
        kind="image",
        project_id=project_id,
        scene_id=request.scene_id,
        shot_id=request.shot_id,
        recipe_id=request.recipe_id,
        look_profile_ids=request.look_profile_ids,
        inputs=inputs,
        input_refs=request.input_refs,
    )


async def _preview_experiment(
    project_id: str,
    payload: schemas.GenerationExperimentCreate,
    session: AsyncSession,
    source: Any,
) -> schemas.GenerationExperimentPreview:
    project = await _active_project(session, project_id)
    await _validate_targets(
        session,
        project,
        [schemas.BatchTarget(scene_id=payload.scene_id, shot_id=payload.shot_id)],
    )
    expanded, duplicates = _expand_experiment(payload)
    items: list[schemas.GenerationExperimentPreviewItem] = []
    for ordinal, (variables, inputs) in enumerate(expanded):
        request = _experiment_job_payload(project_id, payload, inputs)
        preview = await preview_generation_job(
            schemas.GenerationPreviewCreate.model_validate(
                request.model_dump(exclude={"queue_sequence"})
            ),
            session,
            source,
        )
        items.append(
            schemas.GenerationExperimentPreviewItem(
                ordinal=ordinal,
                variables=variables,
                inputs=inputs,
                preview=preview,
            )
        )
    return schemas.GenerationExperimentPreview(
        name=payload.name,
        mode=payload.mode,
        job_count=len(items),
        duplicate_count=duplicates,
        items=items,
    )


async def _experiment_read(
    session: AsyncSession, experiment: GenerationExperiment
) -> schemas.GenerationExperimentRead:
    items = list(
        await session.scalars(
            select(GenerationExperimentItem)
            .where(GenerationExperimentItem.experiment_id == experiment.id)
            .order_by(GenerationExperimentItem.ordinal)
        )
    )
    job_ids = [item.job_id for item in items if item.job_id]
    jobs = {
        job.id: job
        for job in (
            list(
                await session.scalars(
                    select(GenerationJob).where(GenerationJob.id.in_(job_ids))
                )
            )
            if job_ids
            else []
        )
    }
    counts: dict[str, int] = defaultdict(int)
    reads: list[schemas.GenerationExperimentItemRead] = []
    for item in items:
        job = jobs.get(item.job_id or "")
        state = (
            "completed"
            if job is not None and job.state == "succeeded"
            else job.state
            if job is not None
            else "failed"
            if item.planning_error
            else "pending"
        )
        counts[state] += 1
        reads.append(
            schemas.GenerationExperimentItemRead(
                id=item.id,
                ordinal=item.ordinal,
                variables=item.variables,
                inputs=item.inputs,
                job_id=item.job_id,
                state=state,
                attempts=item.attempts,
                planning_error=item.planning_error,
            )
        )
    states = {item.state for item in reads}
    if states and states <= {"completed", "failed", "cancelled"}:
        state = "completed" if states == {"completed"} else "completed_with_errors"
    elif any(value in states for value in ("running", "queued", "cancelling")):
        state = "running"
    elif states == {"pending"} or not states:
        state = "pending"
    else:
        state = "running"
    return schemas.GenerationExperimentRead(
        id=experiment.id,
        project_id=experiment.project_id,
        name=experiment.name,
        state=state,
        counts=dict(counts),
        items=reads,
        created_at=experiment.created_at,
        updated_at=experiment.updated_at,
    )


async def _experiment_reads(
    session: AsyncSession, experiments: list[GenerationExperiment]
) -> list[schemas.GenerationExperimentRead]:
    if not experiments:
        return []
    experiment_ids = [experiment.id for experiment in experiments]
    all_items = list(
        await session.scalars(
            select(GenerationExperimentItem)
            .where(GenerationExperimentItem.experiment_id.in_(experiment_ids))
            .order_by(
                GenerationExperimentItem.experiment_id,
                GenerationExperimentItem.ordinal,
            )
        )
    )
    job_ids = [item.job_id for item in all_items if item.job_id]
    jobs = {
        job.id: job
        for job in (
            list(
                await session.scalars(
                    select(GenerationJob).where(GenerationJob.id.in_(job_ids))
                )
            )
            if job_ids
            else []
        )
    }
    grouped: dict[str, list[GenerationExperimentItem]] = defaultdict(list)
    for item in all_items:
        grouped[item.experiment_id].append(item)
    results: list[schemas.GenerationExperimentRead] = []
    for experiment in experiments:
        counts: dict[str, int] = defaultdict(int)
        reads: list[schemas.GenerationExperimentItemRead] = []
        for item in grouped[experiment.id]:
            job = jobs.get(item.job_id or "")
            state = (
                "completed"
                if job is not None and job.state == "succeeded"
                else job.state
                if job is not None
                else "failed"
                if item.planning_error
                else "pending"
            )
            counts[state] += 1
            reads.append(
                schemas.GenerationExperimentItemRead(
                    id=item.id,
                    ordinal=item.ordinal,
                    variables=item.variables,
                    inputs=item.inputs,
                    job_id=item.job_id,
                    state=state,
                    attempts=item.attempts,
                    planning_error=item.planning_error,
                )
            )
        states = {item.state for item in reads}
        if states and states <= {"completed", "failed", "cancelled"}:
            state = "completed" if states == {"completed"} else "completed_with_errors"
        elif states == {"pending"} or not states:
            state = "pending"
        else:
            state = "running"
        results.append(
            schemas.GenerationExperimentRead(
                id=experiment.id,
                project_id=experiment.project_id,
                name=experiment.name,
                state=state,
                counts=dict(counts),
                items=reads,
                created_at=experiment.created_at,
                updated_at=experiment.updated_at,
            )
        )
    return results


async def _require_experiment(
    session: AsyncSession, project_id: str, experiment_id: str
) -> GenerationExperiment:
    experiment = await session.get(GenerationExperiment, experiment_id)
    if experiment is None or experiment.project_id != project_id:
        raise _error("EXPERIMENT_NOT_FOUND", "探索実験がありません。", http_status=404)
    return experiment


async def _ensure_experiment_job_capacity(
    session: AsyncSession, project_id: str, additional: int
) -> None:
    if additional <= 0:
        return
    total = int(
        await session.scalar(
            select(func.count(GenerationJob.id)).where(
                GenerationJob.assigned_project_id == project_id
            )
        )
        or 0
    )
    active = int(
        await session.scalar(
            select(func.count(GenerationJob.id)).where(
                GenerationJob.assigned_project_id == project_id,
                GenerationJob.state.in_(("queued", "running", "cancelling")),
            )
        )
        or 0
    )
    if total + additional > MAX_EXPERIMENT_JOBS_PER_PROJECT:
        raise _error(
            "EXPERIMENT_JOB_LIMIT_REACHED",
            "探索実験で作成できるProjectのJob総数上限を超えます。",
            http_status=409,
            details={"current": total, "additional": additional, "limit": MAX_EXPERIMENT_JOBS_PER_PROJECT},
        )
    if active + additional > MAX_ACTIVE_EXPERIMENT_JOBS_PER_PROJECT:
        raise _error(
            "EXPERIMENT_ACTIVE_JOB_LIMIT_REACHED",
            "探索実験で投入できる実行中・待機中Jobの上限を超えます。",
            http_status=409,
            details={"current": active, "additional": additional, "limit": MAX_ACTIVE_EXPERIMENT_JOBS_PER_PROJECT},
        )


@router.post(
    "/{project_id}/experiments/preview",
    response_model=schemas.GenerationExperimentPreview,
)
async def preview_experiment(
    project_id: str,
    payload: schemas.GenerationExperimentCreate,
    session: SessionDep,
    source: ReferenceSourceDep,
):
    await _active_project(session, project_id)
    now = time.monotonic()
    if len(_preview_times) > 1000:
        expired = [key for key, value in _preview_times.items() if now - value > 60]
        for key in expired:
            _preview_times.pop(key, None)
    if len(_preview_times) >= 1000 and project_id not in _preview_times:
        oldest = min(_preview_times, key=_preview_times.get)
        _preview_times.pop(oldest, None)
    previous = _preview_times.get(project_id, 0.0)
    if now - previous < 1.0:
        raise _error(
            "EXPERIMENT_PREVIEW_RATE_LIMITED",
            "探索previewは1秒以上空けて実行してください。",
            http_status=429,
        )
    _preview_times[project_id] = now
    async with EXPERIMENT_PREVIEW_SEMAPHORE:
        return await _preview_experiment(project_id, payload, session, source)


@router.post(
    "/{project_id}/experiments",
    response_model=schemas.GenerationExperimentRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_experiment(
    project_id: str,
    payload: schemas.GenerationExperimentCreate,
    session: SessionDep,
    source: ReferenceSourceDep,
    _guard: ExperimentMutationDep,
):
    preview = await _preview_experiment(project_id, payload, session, source)
    await _ensure_experiment_job_capacity(session, project_id, preview.job_count)
    count = await session.scalar(
        select(func.count(GenerationExperiment.id)).where(
            GenerationExperiment.project_id == project_id
        )
    )
    if (count or 0) >= MAX_EXPERIMENTS_PER_PROJECT:
        raise _error(
            "EXPERIMENT_LIMIT_REACHED",
            f"Projectごとの探索実験は{MAX_EXPERIMENTS_PER_PROJECT}件までです。",
            http_status=409,
        )
    now = schemas.now_iso()
    experiment = GenerationExperiment(
        id=schemas.new_id(),
        project_id=project_id,
        name=payload.name,
        request=payload.model_dump(mode="json"),
        created_at=now,
        updated_at=now,
    )
    session.add(experiment)
    items: list[GenerationExperimentItem] = []
    for variant in preview.items:
        item = GenerationExperimentItem(
            id=schemas.new_id(),
            experiment_id=experiment.id,
            ordinal=variant.ordinal,
            variables=variant.variables,
            inputs=variant.inputs,
            job_id=None,
            attempts=0,
            planning_error=None,
            created_at=now,
            updated_at=now,
        )
        session.add(item)
        items.append(item)
    await session.commit()
    for item in items:
        item.attempts = 1
        try:
            job = await create_generation_job(
                _experiment_job_payload(project_id, payload, item.inputs),
                session,
                source,
            )
            item.job_id = job.id
            item.planning_error = None
        except ApiError as error:
            recorded_id = (
                error.details.get("job_id")
                if error.code == "JOB_RECORD_UNREADABLE" and isinstance(error.details, dict)
                else None
            )
            if isinstance(recorded_id, str):
                item.job_id = recorded_id
                item.planning_error = None
            else:
                item.planning_error = f"{error.code}: {error.message}"
        item.updated_at = schemas.now_iso()
        experiment.updated_at = item.updated_at
        await session.commit()
    return await _experiment_read(session, experiment)


@router.get(
    "/{project_id}/experiments",
    response_model=list[schemas.GenerationExperimentRead],
)
async def list_experiments(
    project_id: str,
    session: SessionDep,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    offset: Annotated[int, Query(ge=0)] = 0,
):
    await _project(session, project_id)
    rows = list(
        await session.scalars(
            select(GenerationExperiment)
            .where(GenerationExperiment.project_id == project_id)
            .order_by(GenerationExperiment.created_at.desc())
            .limit(limit)
            .offset(offset)
        )
    )
    return await _experiment_reads(session, rows)


@router.get(
    "/{project_id}/experiments/{experiment_id}",
    response_model=schemas.GenerationExperimentRead,
)
async def get_experiment(
    project_id: str, experiment_id: str, session: SessionDep
):
    await _project(session, project_id)
    return await _experiment_read(
        session, await _require_experiment(session, project_id, experiment_id)
    )


@router.post(
    "/{project_id}/experiments/{experiment_id}/cancel-pending",
    response_model=schemas.GenerationExperimentRead,
)
async def cancel_pending_experiment_jobs(
    project_id: str,
    experiment_id: str,
    session: SessionDep,
    worker: QueueWorkerDep,
    _guard: ExperimentMutationDep,
):
    experiment = await _require_experiment(session, project_id, experiment_id)
    items = list(
        await session.scalars(
            select(GenerationExperimentItem).where(
                GenerationExperimentItem.experiment_id == experiment.id
            )
        )
    )
    for item in items:
        job = await session.get(GenerationJob, item.job_id) if item.job_id else None
        if job is not None and job.state == "queued":
            await cancel_generation_job(job.id, session, worker)
    experiment.updated_at = schemas.now_iso()
    await session.commit()
    return await _experiment_read(session, experiment)


@router.post(
    "/{project_id}/experiments/{experiment_id}/retry-failed",
    response_model=schemas.GenerationExperimentRead,
)
async def retry_failed_experiment_jobs(
    project_id: str,
    experiment_id: str,
    session: SessionDep,
    source: ReferenceSourceDep,
    _guard: ExperimentMutationDep,
):
    await _active_project(session, project_id)
    experiment = await _require_experiment(session, project_id, experiment_id)
    request = schemas.GenerationExperimentCreate.model_validate(experiment.request)
    items = list(
        await session.scalars(
            select(GenerationExperimentItem).where(
                GenerationExperimentItem.experiment_id == experiment.id
            )
        )
    )
    retryable = []
    for item in items:
        if item.attempts >= MAX_EXPERIMENT_ATTEMPTS:
            continue
        job = await session.get(GenerationJob, item.job_id) if item.job_id else None
        if (job is not None and job.state == "failed") or (
            job is None and item.planning_error
        ):
            retryable.append(item)
    if not retryable:
        raise _error(
            "EXPERIMENT_RETRY_NOT_AVAILABLE",
            f"再実行できる失敗variantがありません。最大試行回数は{MAX_EXPERIMENT_ATTEMPTS}回です。",
            http_status=409,
        )
    await _ensure_experiment_job_capacity(session, project_id, len(retryable))
    for item in retryable:
        job = await session.get(GenerationJob, item.job_id) if item.job_id else None
        if job is not None and job.state == "failed":
            item.attempts += 1
            try:
                replacement = await regenerate_generation_job(job.id, session, source)
                item.job_id = replacement.id
                item.planning_error = None
            except ApiError as error:
                recorded_id = (
                    error.details.get("job_id")
                    if error.code == "JOB_RECORD_UNREADABLE" and isinstance(error.details, dict)
                    else None
                )
                if isinstance(recorded_id, str):
                    item.job_id = recorded_id
                    item.planning_error = None
                else:
                    item.planning_error = f"{error.code}: {error.message}"
        elif job is None and item.planning_error:
            item.attempts += 1
            try:
                replacement = await create_generation_job(
                    _experiment_job_payload(project_id, request, item.inputs),
                    session,
                    source,
                )
                item.job_id = replacement.id
                item.planning_error = None
            except ApiError as error:
                recorded_id = (
                    error.details.get("job_id")
                    if error.code == "JOB_RECORD_UNREADABLE" and isinstance(error.details, dict)
                    else None
                )
                if isinstance(recorded_id, str):
                    item.job_id = recorded_id
                    item.planning_error = None
                else:
                    item.planning_error = f"{error.code}: {error.message}"
        else:
            continue
        item.updated_at = schemas.now_iso()
        await session.commit()
    experiment.updated_at = schemas.now_iso()
    await session.commit()
    return await _experiment_read(session, experiment)


@router.delete(
    "/{project_id}/experiments/{experiment_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_experiment(
    project_id: str,
    experiment_id: str,
    session: SessionDep,
    _guard: ExperimentMutationDep,
    confirm: bool = False,
):
    experiment = await _require_experiment(session, project_id, experiment_id)
    if not confirm:
        raise _error(
            "EXPERIMENT_DELETE_CONFIRMATION_REQUIRED",
            "探索実験の削除にはconfirm=trueが必要です。JobとArtifactは削除しません。",
            http_status=422,
        )
    await session.execute(
        delete(GenerationExperimentItem).where(
            GenerationExperimentItem.experiment_id == experiment.id
        )
    )
    await session.delete(experiment)
    await session.commit()


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
