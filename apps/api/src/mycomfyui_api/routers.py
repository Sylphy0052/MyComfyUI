import logging
from typing import Annotated, TypeVar

from fastapi import APIRouter, Depends, Request
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette import status

from mycomfyui_api import schemas
from mycomfyui_api.db import get_session
from mycomfyui_api.errors import ApiError
from mycomfyui_api.models import (
    ApprovalLog,
    Artifact,
    Base,
    GenerationJob,
    GenerationManifest,
    Recipe,
)
from mycomfyui_api.queue import JobQueueWorker

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1")

SessionDep = Annotated[AsyncSession, Depends(get_session)]

ModelT = TypeVar("ModelT", bound=Base)


def get_queue_worker(request: Request) -> JobQueueWorker:
    return request.app.state.queue_worker


QueueWorkerDep = Annotated[JobQueueWorker, Depends(get_queue_worker)]


def _not_found(resource: str, resource_id: str) -> ApiError:
    return ApiError(
        "RESOURCE_NOT_FOUND",
        f"{resource}が見つかりません。",
        status_code=status.HTTP_404_NOT_FOUND,
        details={"resource": resource, "id": resource_id},
    )


def _integrity_error(error: IntegrityError) -> ApiError:
    """外部キー違反などDB制約の違反を機械判定可能なEnvelopeへ変換する。"""
    logger.info("DB制約に違反しました。", exc_info=error)
    return ApiError(
        "VALIDATION_ERROR",
        "参照先が存在しないか、制約に違反しています。",
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        details={"reason": "integrity_constraint"},
    )


async def _commit(session: AsyncSession) -> None:
    try:
        await session.commit()
    except IntegrityError as error:
        await session.rollback()
        raise _integrity_error(error) from error


async def _get_or_404(
    session: AsyncSession, model: type[ModelT], resource: str, resource_id: str
) -> ModelT:
    entity = await session.get(model, resource_id)
    if entity is None:
        raise _not_found(resource, resource_id)
    return entity


@router.post(
    "/recipes", response_model=schemas.RecipeRead, status_code=status.HTTP_201_CREATED
)
async def create_recipe(payload: schemas.RecipeCreate, session: SessionDep):
    recipe = Recipe(
        id=schemas.new_id(),
        created_at=schemas.now_iso(),
        **payload.model_dump(),
    )
    session.add(recipe)
    await _commit(session)
    return recipe


@router.get("/recipes/{recipe_id}", response_model=schemas.RecipeRead)
async def get_recipe(recipe_id: str, session: SessionDep):
    return await _get_or_404(session, Recipe, "Recipe", recipe_id)


@router.post(
    "/generation-jobs",
    response_model=schemas.GenerationJobRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_generation_job(
    payload: schemas.GenerationJobCreate, session: SessionDep
):
    """JobとManifestのIDを先行採番し、同一トランザクションで相互参照ごと作成する。"""
    job_id = schemas.new_id()
    manifest_id = schemas.new_id()
    workflow_artifact_id = schemas.new_id()
    created_at = schemas.now_iso()
    manifest_payload = payload.manifest

    job = GenerationJob(
        id=job_id,
        kind=payload.kind,
        state="queued",
        scene_ref=payload.scene_ref,
        shot_ref=payload.shot_ref,
        recipe_id=payload.recipe_id,
        manifest_id=manifest_id,
        parent_job_id=payload.parent_job_id,
        queue_sequence=payload.queue_sequence,
    )
    workflow_artifact = Artifact(
        id=workflow_artifact_id,
        job_id=job_id,
        kind="workflow",
        relative_path=manifest_payload.workflow_artifact.relative_path,
        sha256=manifest_payload.workflow_artifact.sha256,
        byte_size=manifest_payload.workflow_artifact.byte_size,
        media_type=manifest_payload.workflow_artifact.media_type,
        availability="complete",
        parent_artifact_id=None,
        created_at=created_at,
        decision="undecided",
        decision_at=None,
    )
    manifest = GenerationManifest(
        id=manifest_id,
        job_id=job_id,
        engine=manifest_payload.engine,
        engine_version=manifest_payload.engine_version,
        model=manifest_payload.model,
        seed=manifest_payload.seed,
        resolved_prompt=manifest_payload.resolved_prompt,
        parameters=manifest_payload.parameters,
        input_refs=manifest_payload.input_refs,
        workflow_artifact_id=workflow_artifact_id,
        created_at=created_at,
    )
    # Job、Workflow Artifact、Manifestの順にflushする。遅延検証はJobとManifestの
    # 相互参照だけに必要で、Artifactの参照はこの順序で即時に満たされる。
    try:
        session.add(job)
        await session.flush()
        session.add(workflow_artifact)
        await session.flush()
        session.add(manifest)
        await session.flush()
    except IntegrityError as error:
        await session.rollback()
        raise _integrity_error(error) from error
    await _commit(session)
    return job


@router.get("/generation-jobs/{job_id}", response_model=schemas.GenerationJobRead)
async def get_generation_job(job_id: str, session: SessionDep):
    return await _get_or_404(session, GenerationJob, "GenerationJob", job_id)


@router.get("/generation-jobs", response_model=list[schemas.GenerationJobRead])
async def list_generation_jobs(
    session: SessionDep, state: schemas.JobState | None = None
):
    """キュー状態の確認用。既定はqueue_sequence昇順の全件、state指定で絞り込む。"""
    query = select(GenerationJob).order_by(GenerationJob.queue_sequence.asc())
    if state is not None:
        query = query.where(GenerationJob.state == state)
    result = await session.execute(query)
    return result.scalars().all()


@router.post(
    "/generation-jobs/{job_id}/cancel", response_model=schemas.GenerationJobRead
)
async def cancel_generation_job(
    job_id: str, session: SessionDep, worker: QueueWorkerDep
):
    """queuedは即cancelled、runningはcancellingへ遷移しExecutorへ取消を伝える。"""
    job = await _get_or_404(session, GenerationJob, "GenerationJob", job_id)
    now = schemas.now_iso()
    if job.state == "queued":
        job.state = "cancelled"
        job.cancel_requested_at = now
        job.finished_at = now
    elif job.state == "running":
        job.state = "cancelling"
        job.cancel_requested_at = now
        worker.request_cancel(job_id)
    else:
        raise ApiError(
            "JOB_NOT_CANCELLABLE",
            f"Jobの状態'{job.state}'は取消できません。",
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            details={"state": job.state},
        )
    await _commit(session)
    return job


@router.get(
    "/generation-manifests/{manifest_id}", response_model=schemas.GenerationManifestRead
)
async def get_generation_manifest(manifest_id: str, session: SessionDep):
    return await _get_or_404(
        session, GenerationManifest, "GenerationManifest", manifest_id
    )


@router.post(
    "/artifacts",
    response_model=schemas.ArtifactRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_artifact(payload: schemas.ArtifactCreate, session: SessionDep):
    artifact = Artifact(
        id=schemas.new_id(),
        created_at=schemas.now_iso(),
        decision="undecided",
        decision_at=None,
        **payload.model_dump(),
    )
    session.add(artifact)
    await _commit(session)
    return artifact


@router.get("/artifacts/{artifact_id}", response_model=schemas.ArtifactRead)
async def get_artifact(artifact_id: str, session: SessionDep):
    return await _get_or_404(session, Artifact, "Artifact", artifact_id)


@router.post(
    "/approval-logs",
    response_model=schemas.ApprovalLogRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_approval_log(payload: schemas.ApprovalLogCreate, session: SessionDep):
    approval_log = ApprovalLog(
        id=schemas.new_id(),
        decided_at=schemas.now_iso(),
        **payload.model_dump(),
    )
    session.add(approval_log)
    await _commit(session)
    return approval_log


@router.get("/approval-logs/{approval_log_id}", response_model=schemas.ApprovalLogRead)
async def get_approval_log(approval_log_id: str, session: SessionDep):
    return await _get_or_404(session, ApprovalLog, "ApprovalLog", approval_log_id)
