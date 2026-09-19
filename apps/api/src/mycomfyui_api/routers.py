import hashlib
import json
import logging
from dataclasses import dataclass
from typing import Annotated, Any, TypeVar

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import FileResponse
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette import status

from mycomfyui_api import provenance, schemas, storage
from mycomfyui_api.adapters.aimedia.client import (
    AiMediaNotFound,
    AiMediaUnavailable,
    ReferenceSource,
)
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
from mycomfyui_api.references import get_reference_source

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1")

SessionDep = Annotated[AsyncSession, Depends(get_session)]

ModelT = TypeVar("ModelT", bound=Base)

WORKFLOW_MEDIA_TYPE = "application/json"

#: 採否を記録できるArtifactの種別。Workflowスナップショットやログは対象外とする。
DECIDABLE_ARTIFACT_KINDS = frozenset({"image", "video", "audio"})


def get_queue_worker(request: Request) -> JobQueueWorker:
    return request.app.state.queue_worker


QueueWorkerDep = Annotated[JobQueueWorker, Depends(get_queue_worker)]
ReferenceSourceDep = Annotated[ReferenceSource, Depends(get_reference_source)]

#: lineageを辿る上限。DB上は循環を作らない設計だが、壊れたデータで無限に辿らない。
MAX_LINEAGE_DEPTH = 50
#: lineageで返す子孫Jobの上限。
MAX_LINEAGE_NODES = 200


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


@router.get("/recipes", response_model=list[schemas.RecipeRead])
async def list_recipes(
    session: SessionDep,
    kind: schemas.GenerationKind | None = None,
    engine: str | None = None,
    latest: bool = True,
):
    """画面のプリセット選択用。

    Recipeは作成後に書き換えず、更新時は`supersedes_recipe_id`で後継を作る。既定では
    後継に置き換えられたRecipeを除き、選択肢に古い版が並ばないようにする。
    """
    query = select(Recipe).order_by(Recipe.created_at.desc(), Recipe.id.asc())
    if kind is not None:
        query = query.where(Recipe.kind == kind)
    if engine is not None:
        query = query.where(Recipe.engine == engine)
    if latest:
        superseded = select(Recipe.supersedes_recipe_id).where(
            Recipe.supersedes_recipe_id.is_not(None)
        )
        query = query.where(Recipe.id.not_in(superseded))
    result = await session.execute(query)
    return result.scalars().all()


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
    malformed = sorted(
        name for name, spec in schema.items() if not isinstance(spec, dict | str)
    )
    if malformed:
        # 必須指定は`{"required": true}`で書く。`true`のような書き間違いを黙って
        # 読み飛ばすと、必須チェックが効かないまま動いてしまう。
        raise _validation_error(
            "Recipeのinput_schemaの項目は、型名の文字列かobjectで書きます。",
            {"malformed": malformed},
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
    payload: schemas.GenerationJobCreate,
    session: SessionDep,
    source: ReferenceSourceDep,
):
    """RecipeからWorkflowを組み立て、JobとManifestのIDを先行採番して作成する。

    Scene、Shot、Canonの不変参照は参照APIから解決してManifestへ固定する。JobとManifest
    は相互参照するため、同一トランザクションで相互参照ごと作成する。実行時Workflow JSON
    は先にArtifact storeへ書き出し、その内容のSHA-256をWorkflow Artifactとして記録する。
    投入するのはこのファイルそのものとする。
    """
    recipe = await _get_or_404(session, Recipe, "Recipe", payload.recipe_id)
    _validate_recipe_matches(recipe, payload)
    prepared = _prepare_workflow(recipe, payload.inputs)
    resolved = await _resolve_references(
        source, payload.project_id, payload.scene_id, payload.shot_id
    )
    queue_sequence = _resolve_queue_sequence(payload.queue_sequence)

    job_id = schemas.new_id()
    stored = _store_workflow_snapshot(job_id, prepared.workflow)
    # 書き出した後はどこで失敗してもスナップショットを残さない。レコードの組み立てと
    # 永続化をまとめて囲み、後始末の無い隙間を作らない。
    try:
        job, workflow_artifact, manifest = _build_job_records(
            job_id, payload, recipe, prepared, stored, queue_sequence, resolved
        )
        await _persist_job_records(session, job, workflow_artifact, manifest)
    except Exception:
        storage.discard_artifacts([stored.relative_path])
        raise
    # ここから先はレコードが確定している。失敗してもスナップショットを消さない。
    await _load_queue_sequence(session, job)
    return job


@dataclass(frozen=True)
class _ResolvedReferences:
    """参照APIから解決した、Manifestへ固定する不変参照の組。"""

    scene_ref: dict[str, Any]
    shot_ref: dict[str, Any]
    canon_refs: list[dict[str, Any]]

    def input_refs(self, extra: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Manifestの`input_refs`を組み立てる。`extra`は入力cache参照を想定する。"""
        return [self.scene_ref, self.shot_ref, *self.canon_refs, *extra]


async def _resolve_references(
    source: ReferenceSource, project_id: str, scene_id: str, shot_id: str
) -> _ResolvedReferences:
    """Scene/Shotを参照APIから取得し、本文とCanonの不変参照を固定する。

    Canon参照を解決できないままJobを作ると、どのCanonで生成したか後から説明できない
    履歴だけが残る。取得できない場合と応答から参照を取り出せない場合はJobを作らない。
    """
    try:
        scene_envelope = await source.get_scene(project_id, scene_id)
        shot_envelope = await source.get_shot(project_id, scene_id, shot_id)
    except AiMediaNotFound as error:
        raise ApiError(
            "REFERENCE_NOT_FOUND",
            str(error),
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            details={
                "project_id": project_id,
                "scene_id": scene_id,
                "shot_id": shot_id,
            },
        ) from error
    except AiMediaUnavailable as error:
        logger.warning("ai-media参照APIを利用できません。", exc_info=error)
        raise ApiError(
            "REFERENCE_UNAVAILABLE",
            "ai-media参照APIを利用できませんでした。",
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        ) from error

    try:
        scene_ref, scene_canon = provenance.resolve_envelope(
            provenance.KIND_SCENE, scene_id, scene_envelope
        )
        shot_ref, shot_canon = provenance.resolve_envelope(
            provenance.KIND_SHOT, shot_id, shot_envelope
        )
    except provenance.ReferenceError as error:
        logger.warning("参照APIの応答から不変参照を取り出せません。", exc_info=error)
        raise ApiError(
            "REFERENCE_UNAVAILABLE",
            f"参照APIの応答から不変参照を取り出せませんでした: {error}",
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        ) from error

    return _ResolvedReferences(
        scene_ref={**scene_ref, "project_id": project_id},
        shot_ref={**shot_ref, "project_id": project_id, "scene_id": scene_id},
        canon_refs=provenance.deduplicate([*scene_canon, *shot_canon]),
    )


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
    return _store_workflow_body(job_id, body)


def _store_workflow_body(job_id: str, body: bytes) -> storage.StoredFile:
    """Workflow JSONをArtifact storeへ書き出す。

    再実行では組み立て直さず、記録済みスナップショットと同じ内容をそのまま書き出す。
    """
    try:
        return storage.write_artifact(job_id, storage.WORKFLOW_FILE_NAME, body)
    except storage.StorageError as error:
        logger.exception("Workflowスナップショットを保存できません。job_id=%s", job_id)
        raise ApiError(
            "STORAGE_ERROR",
            "Workflowスナップショットを保存できませんでした。",
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        ) from error


def _resolve_queue_sequence(requested: int | None) -> int | Any:
    """キュー順を決める。未指定なら現在の最大値の次を採番する。

    キューは全Jobで1本のため、呼び出し側ごとに採番すると同じ順番が重複する。既定では
    Application APIが決め、順番を指定したい呼び出しだけが値を渡す。

    採番はINSERT文の中で評価する副問い合わせとして渡す。最大値の読み取りとINSERTを
    別の文に分けると、その隙間に別の要求が同じ値を読み、同じ順番のJobが2件できる。
    """
    if requested is not None:
        return requested
    return select(
        func.coalesce(func.max(GenerationJob.queue_sequence), 0) + 1
    ).scalar_subquery()


def _build_job_records(
    job_id: str,
    payload: schemas.GenerationJobCreate,
    recipe: Recipe,
    prepared: workflow_module.PreparedWorkflow,
    stored: storage.StoredFile,
    queue_sequence: int | Any,
    resolved: _ResolvedReferences,
) -> tuple[GenerationJob, Artifact, GenerationManifest]:
    manifest_id = schemas.new_id()
    workflow_artifact_id = schemas.new_id()
    created_at = schemas.now_iso()
    job = GenerationJob(
        id=job_id,
        kind=payload.kind,
        state="queued",
        scene_ref=resolved.scene_ref,
        shot_ref=resolved.shot_ref,
        recipe_id=payload.recipe_id,
        manifest_id=manifest_id,
        parent_job_id=payload.parent_job_id,
        queue_sequence=queue_sequence,
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
        input_refs=resolved.input_refs(payload.input_refs),
        workflow_artifact_id=workflow_artifact_id,
        replay_of_manifest_id=None,
        created_at=created_at,
    )
    return job, workflow_artifact, manifest


async def _persist_job_records(
    session: AsyncSession,
    job: GenerationJob,
    workflow_artifact: Artifact,
    manifest: GenerationManifest,
) -> None:
    """Job、Workflow Artifact、Manifestの順にflushしてコミットまで行う。

    遅延検証はJobとManifestの相互参照だけに必要で、Artifactの参照はこの順序で即時に
    満たされる。スナップショットの後始末は呼び出し元が担う。

    コミット後の読み直しはここでは行わない。コミット済みのレコードに対して呼び出し元の
    後始末が走ると、DBには記録が残ったまま実ファイルだけが消える。
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
        raise _integrity_error(error) from error
    except Exception:
        await session.rollback()
        raise


async def _load_queue_sequence(session: AsyncSession, job: GenerationJob) -> None:
    """採番済みの`queue_sequence`を読み直す。

    採番はINSERT文の中で評価されるため、確定した値はDBにしかない。コミット済みの
    レコードを読むだけの操作であり、失敗してもJobの記録は有効なまま残す。
    """
    await session.refresh(job)


@router.get("/generation-jobs", response_model=list[schemas.GenerationJobRead])
async def list_generation_jobs(
    session: SessionDep,
    state: schemas.JobState | None = None,
    scene_id: str | None = None,
    shot_id: str | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
):
    """キュー状態の確認用。既定はqueue_sequence昇順、指定した条件で絞り込む。

    `scene_id`と`shot_id`は`scene_ref`/`shot_ref`の`id`と突き合わせる。画面が特定の
    Shotの生成履歴だけを見るために使う。
    """
    query = select(GenerationJob).order_by(
        GenerationJob.queue_sequence.asc(), GenerationJob.id.asc()
    )
    if state is not None:
        query = query.where(GenerationJob.state == state)
    if scene_id is not None:
        query = query.where(GenerationJob.scene_ref["id"].as_string() == scene_id)
    if shot_id is not None:
        query = query.where(GenerationJob.shot_ref["id"].as_string() == shot_id)
    result = await session.execute(query.limit(limit).offset(offset))
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


@router.get("/artifacts", response_model=list[schemas.ArtifactRead])
async def list_artifacts(
    session: SessionDep,
    scene_id: str | None = None,
    shot_id: str | None = None,
    job_id: str | None = None,
    kind: schemas.ArtifactKind | None = None,
    decision: schemas.ArtifactDecision | None = None,
    availability: schemas.Availability | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
):
    """Artifact履歴の一覧。既定は作成の新しい順に返す。

    `scene_id`と`shot_id`は作成元Jobの`scene_ref`/`shot_ref`の`id`と突き合わせる。
    Workflowスナップショットも記録として残すため、種別で絞りたい場合は`kind`を使う。
    """
    query = select(Artifact).order_by(Artifact.created_at.desc(), Artifact.id.asc())
    if job_id is not None:
        query = query.where(Artifact.job_id == job_id)
    if scene_id is not None or shot_id is not None:
        jobs = select(GenerationJob.id)
        if scene_id is not None:
            jobs = jobs.where(GenerationJob.scene_ref["id"].as_string() == scene_id)
        if shot_id is not None:
            jobs = jobs.where(GenerationJob.shot_ref["id"].as_string() == shot_id)
        query = query.where(Artifact.job_id.in_(jobs))
    if kind is not None:
        query = query.where(Artifact.kind == kind)
    if decision is not None:
        query = query.where(Artifact.decision == decision)
    if availability is not None:
        query = query.where(Artifact.availability == availability)
    result = await session.execute(query.limit(limit).offset(offset))
    return result.scalars().all()


@router.get("/artifacts/{artifact_id}", response_model=schemas.ArtifactRead)
async def get_artifact(artifact_id: str, session: SessionDep):
    return await _get_or_404(session, Artifact, "Artifact", artifact_id)


@router.get("/artifacts/{artifact_id}/content")
async def get_artifact_content(artifact_id: str, session: SessionDep):
    """Artifactの実ファイルを配信する。候補比較のプレビューに使う。

    画面へ渡すのは`artifact_id`だけとし、保存先の絶対パスを外へ出さない。パスの解決は
    `storage`へ閉じ、`data_root`の外は配信しない。
    """
    artifact = await _get_or_404(session, Artifact, "Artifact", artifact_id)
    try:
        path = storage.resolve_artifact(artifact.relative_path)
    except storage.StorageError as error:
        logger.warning(
            "Artifactの実ファイルを配信できません。artifact_id=%s", artifact_id
        )
        raise ApiError(
            "ARTIFACT_FILE_MISSING",
            "Artifactの実ファイルを取得できませんでした。",
            status_code=status.HTTP_404_NOT_FOUND,
            details={"artifact_id": artifact_id},
        ) from error
    return FileResponse(path, media_type=artifact.media_type, filename=path.name)


@router.patch("/artifacts/{artifact_id}/decision", response_model=schemas.ArtifactRead)
async def update_artifact_decision(
    artifact_id: str, payload: schemas.ArtifactDecisionUpdate, session: SessionDep
):
    """生成候補の採否を記録する。`undecided`へ戻すと判断時刻も消す。"""
    artifact = await _get_or_404(session, Artifact, "Artifact", artifact_id)
    if artifact.kind not in DECIDABLE_ARTIFACT_KINDS:
        raise _validation_error(
            "この種別のArtifactには採否を記録できません。",
            {"kind": artifact.kind, "allowed": sorted(DECIDABLE_ARTIFACT_KINDS)},
        )
    artifact.decision = payload.decision
    artifact.decision_at = (
        None if payload.decision == "undecided" else schemas.now_iso()
    )
    await _commit(session)
    return artifact


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


async def _get_manifest(
    session: AsyncSession, job: GenerationJob
) -> GenerationManifest:
    manifest = await session.get(GenerationManifest, job.manifest_id)
    if manifest is None:
        raise _not_found("GenerationManifest", job.manifest_id)
    return manifest


async def _get_workflow_artifact(
    session: AsyncSession, manifest: GenerationManifest
) -> Artifact:
    artifact = await session.get(Artifact, manifest.workflow_artifact_id)
    if artifact is None:
        raise _not_found("Artifact", manifest.workflow_artifact_id)
    return artifact


def _reference_ids(job: GenerationJob) -> tuple[str, str, str]:
    """Jobに記録した参照IDを取り出す。

    参照を解決する前に作られたJobには`project_id`が無い。現在値を引けないため、
    推測で補わずに再実行不能として扱う。
    """
    scene_ref = job.scene_ref if isinstance(job.scene_ref, dict) else {}
    shot_ref = job.shot_ref if isinstance(job.shot_ref, dict) else {}
    project_id = scene_ref.get("project_id") or shot_ref.get("project_id")
    scene_id = scene_ref.get("id")
    shot_id = shot_ref.get("id")
    if not (
        isinstance(project_id, str)
        and isinstance(scene_id, str)
        and isinstance(shot_id, str)
    ):
        raise ApiError(
            "REFERENCE_IDS_MISSING",
            "JobにProject、Scene、Shotの参照IDが記録されていません。",
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            details={"job_id": job.id},
        )
    return project_id, scene_id, shot_id


async def _current_references(
    source: ReferenceSource, job: GenerationJob
) -> tuple[list[dict[str, Any]] | None, ApiError | None]:
    """現在のScene、Shot、Canon参照を解決する。

    引けない場合は送出せず、失敗を表すApiErrorを添えて`None`を返す。Canon更新警告は
    参照APIが使えないときも画面へ状態を出す必要があり、再実行はそのまま失敗として
    返す必要があるため、扱いを呼び出し側で分ける。
    """
    try:
        project_id, scene_id, shot_id = _reference_ids(job)
        resolved = await _resolve_references(source, project_id, scene_id, shot_id)
    except ApiError as error:
        return None, error
    return [resolved.scene_ref, resolved.shot_ref, *resolved.canon_refs], None


def _verify_cached_input(reference: dict[str, Any]) -> dict[str, Any]:
    """入力cache参照の実ファイルが記録時と同じ内容かを確かめる。

    参照APIで解決できない利用者素材も、当時の入力の一部として再現可否に効く。設計
    どおり、取得できないか内容が違えばExact Replayを実行しない
    (docs/design/generation-records.md)。
    """
    note = reference.get("note")
    entry: dict[str, Any] = {
        "kind": str(reference.get("kind")),
        "change": provenance.CHANGE_UNCHANGED,
        "path": reference.get("relative_path"),
        "anchor": None,
        "note": note if isinstance(note, str) else None,
        "reason": None,
        "recorded": dict(reference),
        "current": None,
    }
    relative_path = reference.get("relative_path")
    expected = reference.get("sha256")
    if not isinstance(relative_path, str) or not isinstance(expected, str):
        entry["change"] = provenance.CHANGE_MISSING
        entry["reason"] = "入力cache参照にrelative_pathかsha256がありません。"
        return entry
    try:
        raw = storage.resolve_input(relative_path).read_bytes()
    except (storage.StorageError, OSError):
        entry["change"] = provenance.CHANGE_MISSING
        entry["reason"] = "入力cacheの実ファイルを読み込めません。"
        return entry
    digest = hashlib.sha256(raw).hexdigest()
    if digest != expected.lower():
        entry["change"] = provenance.CHANGE_UPDATED
        entry["reason"] = "入力cacheの内容が記録済みのhashと一致しません。"
        entry["current"] = {"relative_path": relative_path, "sha256": digest}
    return entry


def _cached_input_entries(input_refs: Any) -> list[dict[str, Any]]:
    """参照APIで解決しない入力cache参照を、比較結果の形へ揃える。"""
    if not isinstance(input_refs, list):
        return []
    return [
        _verify_cached_input(reference)
        for reference in input_refs
        if isinstance(reference, dict)
        and reference.get("kind") not in provenance.RESOLVABLE_KINDS
    ]


def _read_workflow_snapshot(artifact: Artifact) -> bytes:
    """Workflowスナップショットを読み、記録済みのSHA-256と突き合わせる。

    再実行で投入するのは記録したJSONそのものとする。内容が変わっていれば当時の条件を
    再現できないため、組み立て直さずに実行不能として扱う。
    """
    try:
        path = storage.resolve_artifact(artifact.relative_path)
        raw = path.read_bytes()
    except (storage.StorageError, OSError) as error:
        logger.warning(
            "Workflowスナップショットを読み込めません。artifact_id=%s", artifact.id
        )
        raise ApiError(
            "WORKFLOW_SNAPSHOT_UNAVAILABLE",
            "記録済みのWorkflowスナップショットを読み込めませんでした。",
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            details={"artifact_id": artifact.id},
        ) from error
    if hashlib.sha256(raw).hexdigest() != artifact.sha256:
        raise ApiError(
            "WORKFLOW_SNAPSHOT_MISMATCH",
            "記録済みのWorkflowスナップショットの内容がhashと一致しません。",
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            details={"artifact_id": artifact.id},
        )
    return raw


@router.get(
    "/generation-jobs/{job_id}/canon-status", response_model=schemas.CanonStatusRead
)
async def get_job_canon_status(
    job_id: str, session: SessionDep, source: ReferenceSourceDep
):
    """記録済みの参照と現在の参照を比べ、Canon更新と再現可否を返す。

    記録済みのManifestとArtifactは読むだけで更新しない。Exact Replayの入力を現在値へ
    切り替えることもしない。
    """
    job = await _get_or_404(session, GenerationJob, "GenerationJob", job_id)
    manifest = await _get_manifest(session, job)
    current, failure = await _current_references(source, job)
    if current is None:
        return schemas.CanonStatusRead(
            job_id=job.id,
            manifest_id=manifest.id,
            status="unavailable",
            replayable=False,
            reason=failure.message if failure is not None else None,
            entries=[],
            blocking=[],
        )
    entries = provenance.compare(manifest.input_refs or [], current)
    entries.extend(_cached_input_entries(manifest.input_refs))
    blocking = provenance.unreproducible(entries)
    changed = any(entry["change"] != provenance.CHANGE_UNCHANGED for entry in entries)
    return schemas.CanonStatusRead(
        job_id=job.id,
        manifest_id=manifest.id,
        status="changed" if changed else "unchanged",
        replayable=not blocking,
        reason=None,
        entries=entries,
        blocking=blocking,
    )


async def _create_derived_job(
    session: AsyncSession,
    origin_job: GenerationJob,
    origin_manifest: GenerationManifest,
    workflow_body: bytes,
    parent_artifact_id: str,
    *,
    scene_ref: dict[str, Any],
    shot_ref: dict[str, Any],
    input_refs: list[dict[str, Any]],
    replay_of_manifest_id: str | None,
) -> GenerationJob:
    """元Jobを親に持つ新しいJobとManifestを作る。

    元のJob、Manifest、Artifactは更新しない。Workflowは記録済みの内容をそのまま新しい
    Jobのディレクトリへ書き出し、派生元のArtifactを親として記録する。
    """
    job_id = schemas.new_id()
    manifest_id = schemas.new_id()
    workflow_artifact_id = schemas.new_id()
    created_at = schemas.now_iso()
    stored = _store_workflow_body(job_id, workflow_body)
    try:
        job = GenerationJob(
            id=job_id,
            kind=origin_job.kind,
            state="queued",
            scene_ref=dict(scene_ref),
            shot_ref=dict(shot_ref),
            recipe_id=origin_job.recipe_id,
            manifest_id=manifest_id,
            parent_job_id=origin_job.id,
            queue_sequence=_resolve_queue_sequence(None),
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
            parent_artifact_id=parent_artifact_id,
            created_at=created_at,
            decision="undecided",
            decision_at=None,
        )
        manifest = GenerationManifest(
            id=manifest_id,
            job_id=job_id,
            engine=origin_manifest.engine,
            # 実行基盤の版は再実行時の実測値を入れる。元の値は複製しない。
            engine_version=None,
            model=dict(origin_manifest.model or {}),
            seed=origin_manifest.seed,
            resolved_prompt=origin_manifest.resolved_prompt,
            parameters=dict(origin_manifest.parameters or {}),
            input_refs=input_refs,
            workflow_artifact_id=workflow_artifact_id,
            replay_of_manifest_id=replay_of_manifest_id,
            created_at=created_at,
        )
        await _persist_job_records(session, job, workflow_artifact, manifest)
    except Exception:
        storage.discard_artifacts([stored.relative_path])
        raise
    # ここから先はレコードが確定している。失敗してもスナップショットを消さない。
    await _load_queue_sequence(session, job)
    return job


@router.post(
    "/generation-jobs/{job_id}/replay",
    response_model=schemas.GenerationJobRead,
    status_code=status.HTTP_201_CREATED,
)
async def replay_generation_job(
    job_id: str, session: SessionDep, source: ReferenceSourceDep
):
    """当時の実行条件で再実行する(Exact Replay)。

    元Manifestの解決済み入力とWorkflowスナップショットをそのまま使い、現在Canonへ
    暗黙に置き換えない。記録時と同じ内容を取得できない入力が1件でもあれば、Jobを
    作らずに不足項目を返す。
    """
    job = await _get_or_404(session, GenerationJob, "GenerationJob", job_id)
    manifest = await _get_manifest(session, job)
    workflow_artifact = await _get_workflow_artifact(session, manifest)
    workflow_body = _read_workflow_snapshot(workflow_artifact)

    current, failure = await _current_references(source, job)
    if current is None:
        # 参照IDの欠落と上流の不調では原因が違う。解決を試みたときの分類をそのまま返す。
        raise failure or ApiError(
            "REFERENCE_UNAVAILABLE",
            "記録済みの入力を検証できませんでした。",
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            details={"job_id": job.id},
        )
    entries = provenance.compare(manifest.input_refs or [], current)
    entries.extend(_cached_input_entries(manifest.input_refs))
    blocking = provenance.unreproducible(entries)
    if blocking:
        raise ApiError(
            "REPLAY_NOT_REPRODUCIBLE",
            "記録時の入力を取得できないため、当時の条件で再実行できません。",
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            details={"job_id": job.id, "blocking": blocking},
        )
    return await _create_derived_job(
        session,
        job,
        manifest,
        workflow_body,
        workflow_artifact.id,
        scene_ref=job.scene_ref if isinstance(job.scene_ref, dict) else {},
        shot_ref=job.shot_ref if isinstance(job.shot_ref, dict) else {},
        input_refs=list(manifest.input_refs or []),
        replay_of_manifest_id=manifest.id,
    )


@router.post(
    "/generation-jobs/{job_id}/regenerate",
    response_model=schemas.GenerationJobRead,
    status_code=status.HTTP_201_CREATED,
)
async def regenerate_generation_job(
    job_id: str, session: SessionDep, source: ReferenceSourceDep
):
    """現在のCanonで再生成する(Regenerate with Current Canon)。

    Scene、Shot、Canonだけを現在の参照APIから解決し直し、Recipe、Workflow、モデル、
    seed、パラメータは元Manifestを複製する。元Jobを親に持つ派生Jobとして記録する。
    """
    job = await _get_or_404(session, GenerationJob, "GenerationJob", job_id)
    manifest = await _get_manifest(session, job)
    workflow_artifact = await _get_workflow_artifact(session, manifest)
    workflow_body = _read_workflow_snapshot(workflow_artifact)

    project_id, scene_id, shot_id = _reference_ids(job)
    resolved = await _resolve_references(source, project_id, scene_id, shot_id)
    # 利用者素材のcache参照は参照APIで解決できないため、記録済みの値を引き継ぐ。
    cached = [
        dict(ref)
        for ref in (manifest.input_refs or [])
        if isinstance(ref, dict) and ref.get("kind") not in provenance.RESOLVABLE_KINDS
    ]
    return await _create_derived_job(
        session,
        job,
        manifest,
        workflow_body,
        workflow_artifact.id,
        scene_ref=resolved.scene_ref,
        shot_ref=resolved.shot_ref,
        input_refs=resolved.input_refs(cached),
        replay_of_manifest_id=None,
    )


async def _collect_ancestors(
    session: AsyncSession, job: GenerationJob
) -> tuple[list[GenerationJob], bool]:
    """親から順にJobを辿る。

    lineageは有向非循環グラフとして作るが、壊れたデータで無限に辿らないよう、既訪問の
    IDと深さの上限で打ち切る。打ち切ったかどうかも返し、全件と取り違えさせない。
    """
    ancestors: list[GenerationJob] = []
    seen = {job.id}
    cursor = job.parent_job_id
    truncated = False
    while cursor is not None and cursor not in seen:
        if len(ancestors) >= MAX_LINEAGE_DEPTH:
            truncated = True
            break
        parent = await session.get(GenerationJob, cursor)
        if parent is None:
            break
        ancestors.append(parent)
        seen.add(parent.id)
        cursor = parent.parent_job_id
    ancestors.reverse()
    return ancestors, truncated


async def _collect_descendants(
    session: AsyncSession, job: GenerationJob
) -> tuple[list[GenerationJob], bool]:
    """子孫Jobを世代の浅い順に集める。件数の上限で打ち切ったかどうかも返す。"""
    descendants: list[GenerationJob] = []
    seen = {job.id}
    frontier = [job.id]
    truncated = False
    while frontier:
        result = await session.execute(
            select(GenerationJob)
            .where(GenerationJob.parent_job_id.in_(frontier))
            .order_by(GenerationJob.queue_sequence.asc(), GenerationJob.id.asc())
        )
        children = [child for child in result.scalars().all() if child.id not in seen]
        if not children:
            break
        for child in children:
            seen.add(child.id)
        remaining = MAX_LINEAGE_NODES - len(descendants)
        if len(children) > remaining:
            descendants.extend(children[:remaining])
            truncated = True
            break
        descendants.extend(children)
        frontier = [child.id for child in children]
    return descendants, truncated


@router.get("/generation-jobs/{job_id}/lineage", response_model=schemas.JobLineageRead)
async def get_job_lineage(job_id: str, session: SessionDep):
    """親子Jobと、lineageに含まれるArtifactを返す。

    派生Artifactは`parent_artifact_id`で結ばれているため、Artifactは関係するJobの分を
    まとめて返し、画面側で辿れるようにする。
    """
    job = await _get_or_404(session, GenerationJob, "GenerationJob", job_id)
    ancestors, ancestors_truncated = await _collect_ancestors(session, job)
    descendants, descendants_truncated = await _collect_descendants(session, job)
    job_ids = [
        job.id,
        *(item.id for item in ancestors),
        *(item.id for item in descendants),
    ]
    result = await session.execute(
        select(Artifact)
        .where(Artifact.job_id.in_(job_ids))
        .order_by(Artifact.created_at.asc(), Artifact.id.asc())
    )
    artifacts = result.scalars().all()
    return schemas.JobLineageRead(
        job=schemas.GenerationJobRead.model_validate(job),
        ancestors=[
            schemas.GenerationJobRead.model_validate(item) for item in ancestors
        ],
        descendants=[
            schemas.GenerationJobRead.model_validate(item) for item in descendants
        ],
        artifacts=[schemas.ArtifactRead.model_validate(item) for item in artifacts],
        truncated=ancestors_truncated or descendants_truncated,
    )
