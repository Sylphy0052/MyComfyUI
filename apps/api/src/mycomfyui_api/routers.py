import json
import logging
from typing import Annotated, Any, TypeVar

from fastapi import APIRouter, Depends, Request
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette import status

from mycomfyui_api import schemas, storage
from mycomfyui_api.adapters.comfyui import workflow as workflow_module
from mycomfyui_api.adapters.comfyui.executor import ENGINE_COMFYUI
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

WORKFLOW_MEDIA_TYPE = "application/json"


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


def _validation_error(message: str, details: Any | None = None) -> ApiError:
    return ApiError(
        "VALIDATION_ERROR",
        message,
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        details=details,
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


def _resolve_template_name(recipe: Recipe) -> str:
    """Recipeが指すWorkflowテンプレートを許可済み一覧から解決する。

    利用者入力から任意のJSONを実行させないため、参照できるのは同梱テンプレートだけ
    とする。`sha256`を持つ参照は、指している版が同梱物と一致することまで確かめる。
    """
    reference = recipe.workflow_template_ref
    if not isinstance(reference, dict):
        raise _validation_error("Recipeのworkflow_template_refが不正です。")
    name = reference.get("name")
    if not isinstance(name, str) or name not in workflow_module.ALLOWED_TEMPLATES:
        raise _validation_error(
            "許可されていないWorkflowテンプレートです。",
            {
                "name": name,
                "allowed": sorted(workflow_module.ALLOWED_TEMPLATES),
            },
        )
    expected = reference.get("sha256")
    if isinstance(
        expected, str
    ) and expected.lower() != workflow_module.template_digest(name):
        raise _validation_error(
            "Workflowテンプレートの内容が参照と一致しません。", {"name": name}
        )
    return name


def _validate_against_input_schema(
    recipe: Recipe, template_name: str, inputs: dict[str, Any], values: dict[str, Any]
) -> None:
    """Recipeの`input_schema`で、受け取る変数と必須項目を絞る。

    テンプレート側のallowlistより狭い範囲しか許さないRecipeを作れるようにする。
    `input_schema`は変数名をキーとし、値が`{"required": true}`を持つ項目を必須とする。
    空のときはテンプレート側の定義だけで判定する。
    """
    schema = recipe.input_schema
    if not isinstance(schema, dict) or not schema:
        return
    known = workflow_module.variable_names(template_name)
    undefined = set(schema) - known
    if undefined:
        raise _validation_error(
            "Recipeのinput_schemaがWorkflowに無い変数を指しています。",
            {"template": template_name, "unknown": sorted(undefined)},
        )
    rejected = set(inputs) - set(schema)
    if rejected:
        raise _validation_error(
            "このRecipeで指定できない変数です。",
            {"rejected": sorted(rejected), "allowed": sorted(schema)},
        )
    missing = [
        name
        for name, spec in schema.items()
        if isinstance(spec, dict)
        and spec.get("required") is True
        and name not in values
    ]
    if missing:
        raise _validation_error(
            "Recipeが必須とする変数が不足しています。", {"missing": sorted(missing)}
        )


def _prepare_workflow(
    recipe: Recipe, inputs: dict[str, Any]
) -> workflow_module.PreparedWorkflow:
    """Recipeの既定値と要求の`inputs`をマージし、投入用Workflowを組み立てる。"""
    template_name = _resolve_template_name(recipe)
    defaults = recipe.defaults if isinstance(recipe.defaults, dict) else {}
    values: dict[str, Any] = {**defaults, **inputs}
    _validate_against_input_schema(recipe, template_name, inputs, values)
    try:
        return workflow_module.build_workflow(template_name, values)
    except workflow_module.WorkflowError as error:
        raise _validation_error(str(error), {"template": template_name}) from error


@router.post(
    "/generation-jobs",
    response_model=schemas.GenerationJobRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_generation_job(
    payload: schemas.GenerationJobCreate, session: SessionDep
):
    """RecipeからWorkflowを組み立て、JobとManifestのIDを先行採番して作成する。

    JobとManifestは相互参照するため、同一トランザクションで相互参照ごと作成する。
    実行時Workflow JSONは先にArtifact storeへ書き出し、その内容のSHA-256を
    Workflow Artifactとして記録する。投入するのはこのファイルそのものとする。
    """
    recipe = await _get_or_404(session, Recipe, "Recipe", payload.recipe_id)
    _validate_recipe_matches(recipe, payload)
    prepared = _prepare_workflow(recipe, payload.inputs)

    job_id = schemas.new_id()
    stored = _store_workflow_snapshot(job_id, prepared.workflow)
    job, workflow_artifact, manifest = _build_job_records(
        job_id, payload, recipe, prepared, stored
    )
    await _persist_job_records(
        session, job, workflow_artifact, manifest, stored.relative_path
    )
    return job


def _validate_recipe_matches(
    recipe: Recipe, payload: schemas.GenerationJobCreate
) -> None:
    if recipe.engine != ENGINE_COMFYUI:
        raise _validation_error(
            f"未対応の実行Backendです: {recipe.engine}", {"engine": recipe.engine}
        )
    if recipe.kind != payload.kind:
        raise _validation_error(
            "Recipeの生成種別と要求の種別が一致しません。",
            {"recipe_kind": recipe.kind, "kind": payload.kind},
        )


def _store_workflow_snapshot(
    job_id: str, workflow: dict[str, Any]
) -> storage.StoredFile:
    body = json.dumps(workflow, ensure_ascii=False, indent=2).encode("utf-8")
    try:
        return storage.write_artifact(job_id, storage.WORKFLOW_FILE_NAME, body)
    except storage.StorageError as error:
        logger.exception("Workflowスナップショットを保存できません。job_id=%s", job_id)
        raise ApiError(
            "STORAGE_ERROR",
            "Workflowスナップショットを保存できませんでした。",
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        ) from error


def _build_job_records(
    job_id: str,
    payload: schemas.GenerationJobCreate,
    recipe: Recipe,
    prepared: workflow_module.PreparedWorkflow,
    stored: storage.StoredFile,
) -> tuple[GenerationJob, Artifact, GenerationManifest]:
    manifest_id = schemas.new_id()
    workflow_artifact_id = schemas.new_id()
    created_at = schemas.now_iso()
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
        relative_path=stored.relative_path,
        sha256=stored.sha256,
        byte_size=stored.byte_size,
        media_type=WORKFLOW_MEDIA_TYPE,
        availability="complete",
        parent_artifact_id=None,
        created_at=created_at,
        decision="undecided",
        decision_at=None,
    )
    manifest = GenerationManifest(
        id=manifest_id,
        job_id=job_id,
        engine=recipe.engine,
        # 実行基盤の版はExecutorが実行開始直後に1回だけ設定する。
        engine_version=None,
        model=prepared.model,
        seed=prepared.seed,
        resolved_prompt=prepared.resolved_prompt,
        parameters={
            **prepared.parameters,
            "workflow_template": prepared.template_name,
            "workflow_template_sha256": prepared.template_sha256,
        },
        input_refs=payload.input_refs,
        workflow_artifact_id=workflow_artifact_id,
        created_at=created_at,
    )
    return job, workflow_artifact, manifest


async def _persist_job_records(
    session: AsyncSession,
    job: GenerationJob,
    workflow_artifact: Artifact,
    manifest: GenerationManifest,
    snapshot_path: str,
) -> None:
    """Job、Workflow Artifact、Manifestの順にflushして確定する。

    遅延検証はJobとManifestの相互参照だけに必要で、Artifactの参照はこの順序で即時に
    満たされる。確定できなければ、先に書いたスナップショットも残さない。
    """
    try:
        session.add(job)
        await session.flush()
        session.add(workflow_artifact)
        await session.flush()
        session.add(manifest)
        await session.flush()
        await session.commit()
    except IntegrityError as error:
        await session.rollback()
        storage.discard_artifacts([snapshot_path])
        raise _integrity_error(error) from error
    except Exception:
        await session.rollback()
        storage.discard_artifacts([snapshot_path])
        raise


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


@router.get("/generation-jobs/{job_id}", response_model=schemas.GenerationJobRead)
async def get_generation_job(job_id: str, session: SessionDep):
    return await _get_or_404(session, GenerationJob, "GenerationJob", job_id)


@router.get(
    "/generation-jobs/{job_id}/artifacts", response_model=list[schemas.ArtifactRead]
)
async def list_job_artifacts(job_id: str, session: SessionDep):
    """Jobに紐付くArtifactを作成順に返す。Workflowスナップショットも含む。"""
    await _get_or_404(session, GenerationJob, "GenerationJob", job_id)
    result = await session.execute(
        select(Artifact)
        .where(Artifact.job_id == job_id)
        .order_by(Artifact.created_at.asc(), Artifact.id.asc())
    )
    return result.scalars().all()


@router.post(
    "/generation-jobs/{job_id}/cancel", response_model=schemas.GenerationJobRead
)
async def cancel_generation_job(
    job_id: str, session: SessionDep, worker: QueueWorkerDep
):
    """queuedは即cancelled、runningはcancellingへ遷移しExecutorへ取消を伝える。

    条件付きUPDATEでワーカーの`_claim_next`/`_finalize`との競合を検知する。
    更新0件は他プロセスが先に状態を変えたことを意味し、409で再取得を促す。
    cancellingへの二重要求はidempotentに現在の状態を返す。
    """
    job = await _get_or_404(session, GenerationJob, "GenerationJob", job_id)
    if job.state == "cancelling":
        # ワーカーが直後にfinalizeした可能性があるため、返却前に最新状態を取り直す。
        await session.refresh(job)
        return job
    now = schemas.now_iso()
    if job.state == "queued":
        result = await session.execute(
            update(GenerationJob)
            .where(GenerationJob.id == job_id, GenerationJob.state == "queued")
            .values(state="cancelled", cancel_requested_at=now, finished_at=now)
        )
    elif job.state == "running":
        result = await session.execute(
            update(GenerationJob)
            .where(GenerationJob.id == job_id, GenerationJob.state == "running")
            .values(state="cancelling", cancel_requested_at=now)
        )
    else:
        raise ApiError(
            "JOB_NOT_CANCELLABLE",
            f"Jobの状態'{job.state}'は取消できません。",
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            details={"state": job.state},
        )
    if result.rowcount == 0:
        await session.rollback()
        raise ApiError(
            "JOB_STATE_CONFLICT",
            "他の処理がJobの状態を変更しました。最新状態を再取得してください。",
            status_code=status.HTTP_409_CONFLICT,
            details={"job_id": job_id},
        )
    await session.commit()
    await session.refresh(job)
    if job.state == "cancelling":
        worker.request_cancel(job_id)
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
