import base64
import binascii
import hashlib
import json
import logging
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Annotated, Any, TypeVar

from fastapi import APIRouter, Depends, Query, Request, Response
from fastapi.responses import FileResponse
from sqlalchemy import Select, func, select, update
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette import status
from starlette.concurrency import run_in_threadpool

from mycomfyui_api import approvals, provenance, schemas, storage
from mycomfyui_api import workflows as workflow_registry
from mycomfyui_api.adapters.agent import base as agent_base
from mycomfyui_api.adapters.agent import proposals
from mycomfyui_api.adapters.agent.base import AgentProvider
from mycomfyui_api.adapters.aimedia.client import (
    AiMediaNotFound,
    AiMediaUnavailable,
    ReferenceSource,
)
from mycomfyui_api.adapters.comfyui.client import ComfyUIError
from mycomfyui_api.adapters.comfyui.executor import ENGINE_COMFYUI
from mycomfyui_api.adapters.comfyui.factory import create_comfyui_client
from mycomfyui_api.adapters.voice import audio as voice_audio
from mycomfyui_api.adapters.voice.base import VoiceError
from mycomfyui_api.adapters.voice.factory import create_voice_backend
from mycomfyui_api.db import get_session, get_session_factory
from mycomfyui_api.engines import AUTO_SEED, SUPPORTED_ENGINES, is_supported
from mycomfyui_api.engines import prepare as prepare_execution
from mycomfyui_api.engines import workflow_defaults as engine_workflow_defaults
from mycomfyui_api.errors import ApiError
from mycomfyui_api.execution import (
    PreparationContext,
    PreparationError,
    PreparedExecution,
)
from mycomfyui_api.models import (
    AgentProposal,
    ApprovalLog,
    Artifact,
    ArtifactTag,
    Base,
    GenerationJob,
    GenerationManifest,
    Recipe,
    VoiceVerification,
    Workflow,
    WorkflowVersion,
)
from mycomfyui_api.queue import JobQueueWorker
from mycomfyui_api.references import get_reference_source
from mycomfyui_api.settings import get_settings

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

#: タグをまとめて引くときに、1回のIN句へ渡すArtifact IDの上限。SQLiteのbind
#: parameter上限に当たらない範囲へ収める。
TAG_LOOKUP_CHUNK = 200

#: 1回の検索で指定できるタグの数。条件は1件ごとにEXISTSを重ねるため、際限なく
#: 受け取るとクエリだけが肥大する。
MAX_TAG_FILTERS = 10

#: 整合性一覧でhashを取り直すときの読み込み単位。
DIGEST_CHUNK_SIZE = 1024 * 1024

#: 派生関係の探索を上限で打ち切ったことを伝える応答ヘッダ。一覧の応答本体は
#: Artifactの配列のままにし、打ち切りの有無だけをヘッダで返す。
LINEAGE_TRUNCATED_HEADER = "X-Lineage-Truncated"


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


@router.get("/workflows", response_model=list[schemas.WorkflowRead])
async def list_workflows(
    session: SessionDep,
    kind: schemas.GenerationKind | None = None,
    engine: str | None = None,
):
    """登録済みWorkflowの一覧。Recipeが指す実行本体を画面で選ぶために使う。

    `engines`は複数Backendを持てる。音声のように同じ形のスナップショットを複数の
    Backendが使うためである。`engine`での絞込みはその配列に含まれるかで判定する。
    """
    query = select(Workflow).order_by(Workflow.name.asc())
    if kind is not None:
        query = query.where(Workflow.kind == kind)
    result = await session.execute(query)
    workflows = list(result.scalars().all())
    if engine is not None:
        # enginesはJSON配列のため、SQLiteで含有を判定せずPython側で絞る。登録数が
        # テンプレートの本数に限られ、全件読んでも負荷にならない。
        workflows = [
            workflow
            for workflow in workflows
            if engine
            in (workflow.engines if isinstance(workflow.engines, list) else [])
        ]
    return workflows


@router.get("/workflows/{workflow_id}", response_model=schemas.WorkflowRead)
async def get_workflow(workflow_id: str, session: SessionDep):
    return await _get_or_404(session, Workflow, "Workflow", workflow_id)


@router.get(
    "/workflows/{workflow_id}/versions",
    response_model=list[schemas.WorkflowVersionRead],
)
async def list_workflow_versions(workflow_id: str, session: SessionDep):
    """Workflowの版を新しい順に返す。変数定義と対応モデルは版ごとに異なる。"""
    await _get_or_404(session, Workflow, "Workflow", workflow_id)
    result = await session.execute(
        select(WorkflowVersion)
        .where(WorkflowVersion.workflow_id == workflow_id)
        .order_by(WorkflowVersion.created_at.desc(), WorkflowVersion.id.asc())
    )
    return result.scalars().all()


@router.get(
    "/workflow-versions/{workflow_version_id}",
    response_model=schemas.WorkflowVersionRead,
)
async def get_workflow_version(workflow_version_id: str, session: SessionDep):
    return await _get_or_404(
        session, WorkflowVersion, "WorkflowVersion", workflow_version_id
    )


async def _validate_workflow_version(
    session: AsyncSession, values: dict[str, Any]
) -> None:
    """明示指定されたWorkflow版が、Recipeの参照と生成種別に合うかを確かめる。

    版が宣言した変数は投入値の許可リストになるため、`workflow_template_ref`と別の
    Workflowを指す版を結べると、参照とは違う宣言を通して値を流し込む余地が残る。
    存在確認を外部キー制約だけに任せず、作成の時点で組み合わせを弾く。
    """
    workflow_version_id = values["workflow_version_id"]
    loaded = await workflow_registry.load_version(session, workflow_version_id)
    if loaded is None:
        raise _not_found("WorkflowVersion", workflow_version_id)
    workflow, _version = loaded
    template_ref = values["workflow_template_ref"]
    name = template_ref.get("name") if isinstance(template_ref, dict) else None
    if name != workflow.name:
        raise _validation_error(
            "workflow_version_idとworkflow_template_refが別のWorkflowを指しています。",
            {"template_ref_name": name, "workflow_name": workflow.name},
        )
    if workflow.kind != values["kind"]:
        raise _validation_error(
            "workflow_version_idのWorkflowと生成種別が一致しません。",
            {"workflow_kind": workflow.kind, "recipe_kind": values["kind"]},
        )


@router.post(
    "/recipes", response_model=schemas.RecipeRead, status_code=status.HTTP_201_CREATED
)
async def create_recipe(payload: schemas.RecipeCreate, session: SessionDep):
    values = payload.model_dump()
    if values.get("workflow_version_id") is None:
        values["workflow_version_id"] = await workflow_registry.resolve_version_id(
            session, values["workflow_template_ref"]
        )
    else:
        await _validate_workflow_version(session, values)
    recipe = Recipe(
        id=schemas.new_id(),
        created_at=schemas.now_iso(),
        **values,
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
    resolved = await _resolve_references(
        source, payload.project_id, payload.scene_id, payload.shot_id
    )
    # 実行スナップショットの組み立てはengineごとのAdapterが行う。音声Jobは台詞を
    # 固定する必要があるため、参照APIから取得したShot本文もここで渡す。
    prepared = await _prepare_execution(recipe, payload, source, resolved, session)
    queue_sequence = _resolve_queue_sequence(payload.queue_sequence)

    job_id = schemas.new_id()
    stored = _store_workflow_snapshot(job_id, prepared.snapshot)
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


@router.post("/generation-jobs/preview", response_model=schemas.GenerationPreviewRead)
async def preview_generation_job(
    payload: schemas.GenerationPreviewCreate,
    session: SessionDep,
    source: ReferenceSourceDep,
):
    """投入せずに、解決済みの入力とWorkflow既定値からの差分を返す。

    Jobの作成と同じ経路で参照を解決し実行内容を組み立てるが、スナップショットの
    書き出し、レコードの作成、キュー順の採番は行わない。解決できない入力は作成時と
    同じ`VALIDATION_ERROR`で返し、画面が投入時とプレビューで分岐を二重に持たない
    ようにする。
    """
    recipe = await _get_or_404(session, Recipe, "Recipe", payload.recipe_id)
    _validate_recipe_matches(recipe, payload)
    resolved = await _resolve_references(
        source, payload.project_id, payload.scene_id, payload.shot_id
    )
    prepared = await _prepare_execution(recipe, payload, source, resolved, session)
    defaults = recipe.defaults if isinstance(recipe.defaults, dict) else {}
    version = await _load_recipe_version(session, recipe)
    workflow, workflow_version = version if version is not None else (None, None)
    return schemas.GenerationPreviewRead(
        scene_ref=resolved.scene_ref,
        shot_ref=resolved.shot_ref,
        canon_refs=resolved.canon_refs,
        engine=recipe.engine,
        resolved_prompt=prepared.resolved_prompt,
        model=dict(prepared.model),
        seed=prepared.seed,
        seed_auto=_is_seed_auto(defaults, payload.inputs, prepared),
        parameters=dict(prepared.parameters),
        resolved_inputs=dict(prepared.resolved_inputs),
        input_refs=_merge_input_refs(
            resolved.input_refs([]), prepared.input_refs, payload.input_refs
        ),
        workflow_name=workflow.name if workflow is not None else None,
        workflow_version_id=(
            workflow_version.id if workflow_version is not None else None
        ),
        version=workflow_version.version if workflow_version is not None else None,
        template_sha256=(
            workflow_version.template_sha256 if workflow_version is not None else None
        ),
        diff=_build_workflow_diff(recipe, defaults, payload.inputs, prepared),
        parent_job_id=_resolve_parent_job_id(payload, prepared),
    )


async def _load_recipe_version(
    session: AsyncSession, recipe: Recipe
) -> tuple[Workflow, WorkflowVersion] | None:
    """Recipeが指す登録済みWorkflow版を引く。

    レジストリ導入前の形のRecipeは`workflow_version_id`を持たないため、
    `workflow_template_ref`から引き直す。解決できなければ版の情報を返さない。
    """
    version_id = recipe.workflow_version_id
    if version_id is None:
        version_id = await workflow_registry.resolve_version_id(
            session, recipe.workflow_template_ref
        )
    if version_id is None:
        return None
    return await workflow_registry.load_version(session, version_id)


def _is_seed_auto(
    defaults: dict[str, Any], inputs: dict[str, Any], prepared: PreparedExecution
) -> bool:
    """seedを自動採番したかを返す。

    自動採番したseedは投入時に採り直されるため、プレビューの値と一致しない。画面が
    その旨を示せるようにする。seedを持たないengineでは常に偽とする。
    """
    if "seed" not in prepared.resolved_inputs:
        return False
    requested = {**defaults, **inputs}.get("seed")
    return requested is None or requested == AUTO_SEED


def _build_workflow_diff(
    recipe: Recipe,
    defaults: dict[str, Any],
    inputs: dict[str, Any],
    prepared: PreparedExecution,
) -> list[schemas.GenerationPreviewDiff]:
    """Workflowの既定値、Recipeの既定値、今回確定する値を変数ごとに並べる。

    テンプレートファイルを持たないengineは`workflow_default`を持たないため、
    Recipeの既定値と入力の対比だけになる。
    """
    workflow_defaults = engine_workflow_defaults(recipe)
    names = sorted(
        set(prepared.resolved_inputs) | set(workflow_defaults) | set(defaults)
    )
    entries: list[schemas.GenerationPreviewDiff] = []
    for name in names:
        resolved = name in prepared.resolved_inputs
        value = prepared.resolved_inputs.get(name)
        workflow_default = workflow_defaults.get(name)
        if name in inputs:
            origin = "input"
        elif name in defaults:
            origin = "recipe_default"
        elif resolved:
            origin = "adapter"
        else:
            origin = "workflow_default"
        entries.append(
            schemas.GenerationPreviewDiff(
                name=name,
                workflow_default=workflow_default,
                recipe_default=defaults.get(name),
                value=value,
                # 値が確定していない変数は、既定値から変わっていないものとして扱う。
                changed=resolved
                and name in workflow_defaults
                and value != workflow_default,
                origin=origin,
            )
        )
    return entries


@dataclass(frozen=True)
class _ResolvedReferences:
    """参照APIから解決した、Manifestへ固定する不変参照の組。

    `scene_data`と`shot_data`は参照APIの応答本文そのものとする。Manifestへは保存
    しない。音声Jobが台詞をスナップショットへ固定するために使う。
    """

    scene_ref: dict[str, Any]
    shot_ref: dict[str, Any]
    canon_refs: list[dict[str, Any]]
    scene_data: dict[str, Any] = field(default_factory=dict)
    shot_data: dict[str, Any] = field(default_factory=dict)

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
        scene_data=_envelope_data(scene_envelope),
        shot_data=_envelope_data(shot_envelope),
    )


def _envelope_data(envelope: Any) -> dict[str, Any]:
    """参照APIのEnvelopeから本文を取り出す。形が違えば空のまま扱う。"""
    if not isinstance(envelope, dict):
        return {}
    data = envelope.get("data")
    return dict(data) if isinstance(data, dict) else {}


@dataclass(frozen=True)
class _ArtifactLookup:
    """準備処理へ渡す、Artifactの読取り専用の窓口。

    準備処理にDBセッションをそのまま渡すと、Adapterから書き込みもできてしまう。
    引けるのはIDによる1件の取得だけにする。
    """

    session: AsyncSession

    async def get(self, artifact_id: str) -> Artifact | None:
        return await self.session.get(Artifact, artifact_id)


async def _prepare_execution(
    recipe: Recipe,
    payload: schemas.GenerationPreviewCreate,
    source: ReferenceSource,
    resolved: _ResolvedReferences,
    session: AsyncSession,
):
    """Recipeのengineに対応するAdapterで実行スナップショットを組み立てる。"""
    context = PreparationContext(
        project_id=payload.project_id,
        scene_id=payload.scene_id,
        shot_id=payload.shot_id,
        scene_data=resolved.scene_data,
        shot_data=resolved.shot_data,
        canon_lookup=source,
        artifact_lookup=_ArtifactLookup(session),
    )
    try:
        return await prepare_execution(recipe, payload.inputs, context)
    except PreparationError as error:
        raise _validation_error(error.message, error.details) from error


def _validate_recipe_matches(
    recipe: Recipe, payload: schemas.GenerationPreviewCreate
) -> None:
    if not is_supported(recipe.engine):
        raise _validation_error(
            f"未対応の実行Backendです: {recipe.engine}",
            {"engine": recipe.engine, "supported": list(SUPPORTED_ENGINES)},
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
    prepared: PreparedExecution,
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
        parent_job_id=_resolve_parent_job_id(payload, prepared),
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
        parameters=dict(prepared.parameters),
        input_refs=_merge_input_refs(
            resolved.input_refs([]), prepared.input_refs, payload.input_refs
        ),
        workflow_artifact_id=workflow_artifact_id,
        replay_of_manifest_id=None,
        created_at=created_at,
    )
    return job, workflow_artifact, manifest


def _resolve_parent_job_id(
    payload: schemas.GenerationPreviewCreate, prepared: PreparedExecution
) -> str | None:
    """親Jobを決める。入力から決まる場合は要求の指定と食い違わせない。

    合成Jobの親は入力の動画Jobで、準備処理が解決する。要求が別のJobを指していれば
    どちらが正しいか決められないため、Jobを作らずに拒否する。
    """
    derived = prepared.parent_job_id
    if payload.parent_job_id is None:
        return derived
    if derived is not None and derived != payload.parent_job_id:
        raise _validation_error(
            "parent_job_idが入力から決まる親Jobと一致しません。",
            {"parent_job_id": payload.parent_job_id, "expected": derived},
        )
    return payload.parent_job_id


def _merge_input_refs(
    *groups: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Scene/Shot/Canonの参照、準備で判った参照、呼び出し元の入力cache参照を束ねる。

    同じ参照先が複数の経路から届くことがある。Shotが宣言したCanonを利用者が改めて
    Jobの入力として指定した場合が典型で、重ねて記録しても再実行の検証結果は変わらず、
    画面の警告だけが重複する。先勝ちで畳む。

    `provenance.deduplicate`は参照APIで解決する種別だけを想定しており、
    `source_locator`と`path`を持たない入力cache参照は1件へ畳まれてしまう。ここでは
    参照APIで解決しない種別も扱うため、`relative_path`まで見る鍵を使う。
    """
    merged: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str, str | None]] = set()
    for group in groups:
        for reference in group:
            anchor = reference.get("anchor")
            key = (
                str(reference.get("kind")),
                str(reference.get("source_locator") or ""),
                str(reference.get("path") or reference.get("relative_path") or ""),
                anchor if isinstance(anchor, str) else None,
            )
            if key in seen:
                continue
            seen.add(key)
            merged.append(dict(reference))
    return merged


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

    読み直せないときは応答を組み立てられないが、Jobは作成済みである。作成に失敗した
    と誤解して再送されると同じ内容のJobが増えるため、その旨を専用のcodeで返す。
    """
    try:
        await session.refresh(job)
    except Exception as error:
        logger.exception("作成済みJobを読み直せません。job_id=%s", job.id)
        raise ApiError(
            "JOB_RECORD_UNREADABLE",
            "Jobは作成済みですが、応答を組み立てられませんでした。"
            "再送せずにJob一覧で状態を確認してください。",
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            details={"job_id": job.id},
        ) from error


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
    return await _artifact_reads(session, result.scalars().all())


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


async def _artifact_tag_map(
    session: AsyncSession, artifact_ids: Sequence[str]
) -> dict[str, list[str]]:
    """Artifact IDごとのタグをまとめて引く。

    一覧とlineageは複数件を返すため、1件ずつ引くとArtifactの数だけ問い合わせが増える。
    IN句をまとめて発行し、呼び出し側は結果の辞書から取り出す。SQLiteのbind parameter
    上限に当たらないよう、IDは分割して渡す。
    """
    tags: dict[str, list[str]] = {}
    unique_ids = list(dict.fromkeys(artifact_ids))
    for start in range(0, len(unique_ids), TAG_LOOKUP_CHUNK):
        chunk = unique_ids[start : start + TAG_LOOKUP_CHUNK]
        result = await session.execute(
            select(ArtifactTag.artifact_id, ArtifactTag.tag)
            .where(ArtifactTag.artifact_id.in_(chunk))
            .order_by(ArtifactTag.tag.asc())
        )
        for artifact_id, tag in result.all():
            tags.setdefault(artifact_id, []).append(tag)
    return tags


async def _artifact_reads(
    session: AsyncSession, artifacts: Sequence[Artifact]
) -> list[schemas.ArtifactRead]:
    """Artifactへタグを添えて応答の形へ揃える。

    Artifactを返すすべての経路でこれを通す。経路によってタグが入らないと、空配列が
    「タグ無し」なのか「この経路では返していない」のかを画面側で区別できない。
    """
    tags = await _artifact_tag_map(session, [artifact.id for artifact in artifacts])
    return [
        schemas.ArtifactRead.model_validate(artifact).model_copy(
            update={"tags": tags.get(artifact.id, [])}
        )
        for artifact in artifacts
    ]


async def _artifact_read(
    session: AsyncSession, artifact: Artifact
) -> schemas.ArtifactRead:
    reads = await _artifact_reads(session, [artifact])
    return reads[0]


async def _collect_artifact_lineage(
    session: AsyncSession, artifact: Artifact
) -> tuple[list[str], bool]:
    """指定Artifactと、その祖先・子孫のIDを集める。上限で打ち切ったかどうかも返す。

    Jobのlineageと同じく、DB上は循環を作らない設計だが、壊れたデータで無限に辿らない
    よう既訪問のIDと上限で打ち切る。
    """
    collected = [artifact.id]
    seen = {artifact.id}
    truncated = False
    cursor = artifact.parent_artifact_id
    depth = 0
    while cursor is not None and cursor not in seen:
        if depth >= MAX_LINEAGE_DEPTH:
            truncated = True
            break
        parent = await session.get(Artifact, cursor)
        if parent is None:
            break
        collected.append(parent.id)
        seen.add(parent.id)
        cursor = parent.parent_artifact_id
        depth += 1
    frontier = [artifact.id]
    descendants = 0
    while frontier and not truncated:
        result = await session.execute(
            select(Artifact.id)
            .where(Artifact.parent_artifact_id.in_(frontier))
            .order_by(Artifact.created_at.asc(), Artifact.id.asc())
        )
        children = [child for child in result.scalars().all() if child not in seen]
        if not children:
            break
        remaining = MAX_LINEAGE_NODES - descendants
        if len(children) > remaining:
            children = children[:remaining]
            truncated = True
        for child in children:
            seen.add(child)
        collected.extend(children)
        descendants += len(children)
        frontier = children
    return collected, truncated


async def _collect_job_lineage(
    session: AsyncSession, job: GenerationJob
) -> tuple[list[str], bool]:
    """指定Jobと、その祖先・子孫JobのIDを集める。上限で打ち切ったかどうかも返す。"""
    ancestors, ancestors_truncated = await _collect_ancestors(session, job)
    descendants, descendants_truncated = await _collect_descendants(session, job)
    job_ids = [
        job.id,
        *(item.id for item in ancestors),
        *(item.id for item in descendants),
    ]
    return job_ids, ancestors_truncated or descendants_truncated


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
    return await _artifact_read(session, artifact)


def _artifact_filters(
    query: Select[tuple[Artifact]],
    *,
    scene_id: str | None,
    shot_id: str | None,
    job_id: str | None,
    kind: str | None,
    decision: str | None = None,
    availability: str | None = None,
    tags: list[str] | None = None,
) -> Select[tuple[Artifact]]:
    """Artifactの絞り込み条件を組み立てる。条件はすべてANDで重ねる。

    `scene_id`と`shot_id`は作成元Jobの`scene_ref`/`shot_ref`の`id`と突き合わせる。
    `tags`を複数指定したときは、すべてのタグが付いたArtifactだけを返す。資産を絞り
    込む用途では和集合より積集合が要る。
    """
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
    for value in tags or []:
        query = query.where(
            select(ArtifactTag.id)
            .where(
                ArtifactTag.artifact_id == Artifact.id,
                ArtifactTag.tag == value,
            )
            .exists()
        )
    return query


async def _apply_lineage_filters(
    session: AsyncSession,
    query: Select[tuple[Artifact]],
    *,
    lineage_artifact_id: str | None,
    lineage_job_id: str | None,
) -> tuple[Select[tuple[Artifact]], bool]:
    """派生関係の絞り込みを重ねる。探索を上限で打ち切ったかどうかも返す。"""
    truncated = False
    if lineage_artifact_id is not None:
        artifact = await _get_or_404(session, Artifact, "Artifact", lineage_artifact_id)
        artifact_ids, artifact_truncated = await _collect_artifact_lineage(
            session, artifact
        )
        truncated = truncated or artifact_truncated
        query = query.where(Artifact.id.in_(artifact_ids))
    if lineage_job_id is not None:
        job = await _get_or_404(session, GenerationJob, "GenerationJob", lineage_job_id)
        job_ids, job_truncated = await _collect_job_lineage(session, job)
        truncated = truncated or job_truncated
        query = query.where(Artifact.job_id.in_(job_ids))
    return query, truncated


@router.get(
    "/artifacts",
    response_model=list[schemas.ArtifactRead],
    responses={
        200: {
            "headers": {
                LINEAGE_TRUNCATED_HEADER: {
                    "description": (
                        "派生関係の探索を上限で打ち切ったかどうか。"
                        "`true`のとき、絞り込みの対象は全件ではない。"
                    ),
                    "schema": {"type": "string", "enum": ["true", "false"]},
                }
            }
        }
    },
)
async def list_artifacts(
    session: SessionDep,
    response: Response,
    scene_id: str | None = None,
    shot_id: str | None = None,
    job_id: str | None = None,
    kind: schemas.ArtifactKind | None = None,
    decision: schemas.ArtifactDecision | None = None,
    availability: schemas.Availability | None = None,
    tag: Annotated[
        list[schemas.ArtifactTagValue] | None, Query(max_length=MAX_TAG_FILTERS)
    ] = None,
    lineage_artifact_id: str | None = None,
    lineage_job_id: str | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
):
    """Artifact履歴の一覧。既定は作成の新しい順に返す。

    `scene_id`と`shot_id`は作成元Jobの`scene_ref`/`shot_ref`の`id`と突き合わせる。
    Workflowスナップショットも記録として残すため、種別で絞りたい場合は`kind`を使う。

    `tag`は複数指定でき、すべてのタグが付いたArtifactだけを返す。`lineage_artifact_id`
    は`parent_artifact_id`、`lineage_job_id`は`parent_job_id`をそれぞれ祖先と子孫の
    両方向へ辿り、指定した資産の派生関係に属するものだけへ絞る。

    派生関係の探索を上限で打ち切った場合は`X-Lineage-Truncated: true`を返す。結果の
    件数だけでは、絞り込みの対象が全件だったのか途中で止めたのかが判らない。
    """
    query = select(Artifact).order_by(Artifact.created_at.desc(), Artifact.id.asc())
    query = _artifact_filters(
        query,
        scene_id=scene_id,
        shot_id=shot_id,
        job_id=job_id,
        kind=kind,
        decision=decision,
        availability=availability,
        tags=tag,
    )
    query, truncated = await _apply_lineage_filters(
        session,
        query,
        lineage_artifact_id=lineage_artifact_id,
        lineage_job_id=lineage_job_id,
    )
    response.headers[LINEAGE_TRUNCATED_HEADER] = "true" if truncated else "false"
    result = await session.execute(query.limit(limit).offset(offset))
    return await _artifact_reads(session, result.scalars().all())


def _integrity_finding(
    reason: schemas.ArtifactIntegrityReason, message: str
) -> schemas.ArtifactIntegrityFinding:
    return schemas.ArtifactIntegrityFinding(reason=reason, message=message)


def _file_digest(path: Path) -> str:
    """実ファイルのSHA-256を求める。

    動画のように大きいArtifactも対象になるため、全体をメモリへ載せずに読み進める。
    """
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(DIGEST_CHUNK_SIZE), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _artifact_file_findings(
    artifact: Artifact,
) -> list[schemas.ArtifactIntegrityFinding]:
    """Artifactの実ファイルが記録どおり残っているかを確かめる。

    読むだけで、`availability`も`sha256`も書き換えない。記録を現在の状態へ寄せると、
    いつ何が失われたのかが履歴から消える。
    """
    try:
        path = storage.resolve_artifact(artifact.relative_path)
    except storage.StorageError:
        return [
            _integrity_finding("file_missing", "Artifactの実ファイルがありません。")
        ]
    try:
        digest = _file_digest(path)
    except OSError:
        return [
            _integrity_finding("file_missing", "Artifactの実ファイルを読み込めません。")
        ]
    if digest != artifact.sha256.lower():
        return [
            _integrity_finding(
                "hash_mismatch",
                "実ファイルの内容が記録済みのhashと一致しません。",
            )
        ]
    return []


@dataclass
class _CanonState:
    """整合性一覧の実行中に、参照APIを引けたかどうかを持ち回る。

    引けなくなった時点で以降のCanon判定を止める。Jobごとに引き直すと、参照APIが落ちて
    いる間は対象の数だけ待たされる。
    """

    available: bool = True
    reason: str | None = None


async def _job_integrity_findings(
    session: AsyncSession,
    source: ReferenceSource,
    job_id: str,
    *,
    canon_state: _CanonState,
) -> list[schemas.ArtifactIntegrityFinding]:
    """作成元Jobの記録から、参照切れとCanon更新を判定する。

    判定は読み取りだけで行い、ManifestとArtifactの記録値を更新しない。参照APIを引け
    なかった場合はCanon判定を諦め、`canon_state`へ理由を残して他の判定を続ける。
    Jobごとに事情が違う失敗(参照IDが記録されていないなど)は、そのJobの参照切れとして
    扱い、一覧全体のCanon判定は止めない。
    """
    job = await session.get(GenerationJob, job_id)
    if job is None:
        return [_integrity_finding("reference_broken", "作成元のJobが見つかりません。")]
    manifest = await session.get(GenerationManifest, job.manifest_id)
    if manifest is None:
        return [
            _integrity_finding(
                "reference_broken", "作成元JobのGeneration Manifestが見つかりません。"
            )
        ]
    findings = [
        _integrity_finding(
            "reference_broken",
            entry.get("reason") or "記録済みの入力を再現できません。",
        )
        for entry in _local_input_entries(manifest.input_refs)
        if entry["change"] != provenance.CHANGE_UNCHANGED
    ]
    if not canon_state.available:
        return findings
    current, failure = await _current_references(source, job, manifest.input_refs)
    if current is None:
        message = failure.message if failure is not None else "参照を解決できません。"
        if failure is not None and failure.code == "REFERENCE_UNAVAILABLE":
            canon_state.available = False
            canon_state.reason = message
        else:
            findings.append(_integrity_finding("reference_broken", message))
        return findings
    entries = provenance.compare(manifest.input_refs or [], current)
    if any(entry["change"] != provenance.CHANGE_UNCHANGED for entry in entries):
        findings.append(
            _integrity_finding(
                "canon_updated", "記録済みの参照と現在の参照が一致しません。"
            )
        )
    return findings


@router.get("/artifacts/integrity", response_model=schemas.ArtifactIntegrityRead)
async def list_artifact_integrity(
    session: SessionDep,
    source: ReferenceSourceDep,
    scene_id: str | None = None,
    shot_id: str | None = None,
    job_id: str | None = None,
    kind: schemas.ArtifactKind | None = None,
    tag: Annotated[
        list[schemas.ArtifactTagValue] | None, Query(max_length=MAX_TAG_FILTERS)
    ] = None,
    reason: Annotated[list[schemas.ArtifactIntegrityReason] | None, Query()] = None,
    include_canon: bool = True,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
):
    """整合性を欠いたArtifactを理由付きで一覧する。

    `limit`と`offset`は判定する対象の範囲であり、返す件数ではない。実ファイルを読んで
    hashを取り直すため、対象を絞らずに走らせると重い。作成の新しい順に`limit`件だけを
    判定し、まだ対象が残っている場合は`truncated`を`true`にする。

    `reason`を指定すると、その理由が付いたArtifactだけを返す。複数指定はORとする。
    `include_canon`を`false`にすると参照APIを引かず、ファイルと入力の判定だけを行う。
    このとき`canon_available`は`false`になる。判定した結果として更新が無かったのか、
    そもそも見ていないのかを取り違えさせない。

    判定は読み取りのみで、ManifestとArtifactの記録値を更新しない。
    """
    query = select(Artifact).order_by(Artifact.created_at.desc(), Artifact.id.asc())
    query = _artifact_filters(
        query,
        scene_id=scene_id,
        shot_id=shot_id,
        job_id=job_id,
        kind=kind,
        tags=tag,
    )
    result = await session.execute(query.limit(limit + 1).offset(offset))
    candidates = list(result.scalars().all())
    truncated = len(candidates) > limit
    candidates = candidates[:limit]

    # 判定を頼まれていない場合も「Canon更新は判定できていない」状態として返す。
    # 判定した結果として更新が無かったのか、そもそも見ていないのかを取り違えさせない。
    canon_state = (
        _CanonState()
        if include_canon
        else _CanonState(
            available=False,
            reason="include_canonがfalseのため、Canon更新は判定していません。",
        )
    )
    job_findings: dict[str, list[schemas.ArtifactIntegrityFinding]] = {}
    found: list[tuple[Artifact, list[schemas.ArtifactIntegrityFinding]]] = []
    for artifact in candidates:
        if artifact.job_id not in job_findings:
            job_findings[artifact.job_id] = await _job_integrity_findings(
                session,
                source,
                artifact.job_id,
                canon_state=canon_state,
            )
        # hashの取り直しは1件あたりのファイル全体を読む同期I/Oになる。対象が最大
        # `limit`件続くため、そのまま呼ぶとイベントループを塞いで他の要求が止まる。
        file_findings = await run_in_threadpool(_artifact_file_findings, artifact)
        found.append(
            (
                artifact,
                [*file_findings, *job_findings[artifact.job_id]],
            )
        )

    # 途中で参照APIを引けなくなった場合、先に判定したJobにだけCanon更新が付いた一覧に
    # なる。判定できたものとできなかったものが混ざると読み手が全体を誤解するため、
    # Canon判定そのものを外す。
    keep: set[str] = set(reason or []) or {
        "file_missing",
        "hash_mismatch",
        "reference_broken",
        "canon_updated",
    }
    if not canon_state.available:
        keep.discard("canon_updated")
    items_source = [
        (artifact, [finding for finding in findings if finding.reason in keep])
        for artifact, findings in found
    ]
    items_source = [
        (artifact, findings) for artifact, findings in items_source if findings
    ]
    reads = await _artifact_reads(session, [artifact for artifact, _ in items_source])
    return schemas.ArtifactIntegrityRead(
        items=[
            schemas.ArtifactIntegrityEntry(artifact=read, findings=findings)
            for read, (_, findings) in zip(reads, items_source, strict=True)
        ],
        checked=len(candidates),
        truncated=truncated,
        canon_available=canon_state.available,
        canon_reason=canon_state.reason,
    )


@router.get("/artifacts/{artifact_id}", response_model=schemas.ArtifactRead)
async def get_artifact(artifact_id: str, session: SessionDep):
    artifact = await _get_or_404(session, Artifact, "Artifact", artifact_id)
    return await _artifact_read(session, artifact)


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
    return await _artifact_read(session, artifact)


async def _find_artifact_tag(
    session: AsyncSession, artifact_id: str, tag: str
) -> ArtifactTag | None:
    result = await session.execute(
        select(ArtifactTag).where(
            ArtifactTag.artifact_id == artifact_id,
            ArtifactTag.tag == tag,
        )
    )
    return result.scalars().first()


@router.post(
    "/artifacts/{artifact_id}/tags",
    response_model=schemas.ArtifactRead,
    status_code=status.HTTP_201_CREATED,
)
async def add_artifact_tag(
    artifact_id: str, payload: schemas.ArtifactTagCreate, session: SessionDep
):
    """Artifactへタグを付ける。既に付いている場合も現在の状態を返す。

    同じタグを二度送るのは、画面の再送や操作の重複で普通に起こる。既に狙いどおりの
    状態になっているものをエラーにしても、呼び出し側は結局現在の状態を引き直すため、
    付け直しは成功として扱う。
    """
    await _get_or_404(session, Artifact, "Artifact", artifact_id)
    session.add(
        ArtifactTag(
            id=schemas.new_id(),
            artifact_id=artifact_id,
            tag=payload.tag,
            created_at=schemas.now_iso(),
        )
    )
    try:
        await session.commit()
    except IntegrityError as error:
        await session.rollback()
        # 付いているかを先に確かめてから足すと、同じタグを同時に送られたときに両方が
        # 「まだ無い」と判定して衝突する。先に足し、ユニーク制約の違反だけを付け直し
        # として握る。付け直しでないIntegrityErrorは外部キー違反として返す。
        if await _find_artifact_tag(session, artifact_id, payload.tag) is None:
            raise _integrity_error(error) from error
    artifact = await _get_or_404(session, Artifact, "Artifact", artifact_id)
    return await _artifact_read(session, artifact)


@router.delete(
    "/artifacts/{artifact_id}/tags/{tag}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def remove_artifact_tag(artifact_id: str, tag: str, session: SessionDep):
    """Artifactからタグを外す。付いていないタグの指定は404とする。

    付与と違い、外す操作は対象が存在しないことを伝える価値がある。画面のタグ一覧が
    古いまま操作された場合に、成功として返すと消えたことになってしまう。

    パスから受け取る値も付与時と同じ書式で検証する。検証せずに落とすと、付与では
    受け付けない値がエラー応答の`details`へそのまま載る。
    """
    try:
        tag = schemas.normalize_tag(tag)
    except ValueError as error:
        raise _validation_error(str(error)) from error
    await _get_or_404(session, Artifact, "Artifact", artifact_id)
    entry = await _find_artifact_tag(session, artifact_id, tag)
    if entry is None:
        raise _not_found("ArtifactTag", tag)
    await session.delete(entry)
    await _commit(session)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/approval-logs",
    response_model=schemas.ApprovalLogRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_approval_log(payload: schemas.ApprovalLogCreate, session: SessionDep):
    """任意の承認記録を追記する。

    Agent提案の承認はこの経路では作れない。操作内容のdigestを外から持ち込めると、
    提案の内容と対応しない承認を作って適用できてしまうため、専用Endpointだけに限る。
    """
    if payload.subject_type == approvals.SUBJECT_TYPE_AGENT_PROPOSAL:
        raise _validation_error(
            "Agent提案の承認は提案の判断Endpointから記録してください。",
            {"subject_type": payload.subject_type},
        )
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
    source: ReferenceSource,
    job: GenerationJob,
    recorded: list[Any] | None = None,
) -> tuple[list[dict[str, Any]] | None, ApiError | None]:
    """現在のScene、Shot、Canon参照を解決する。

    引けない場合は送出せず、失敗を表すApiErrorを添えて`None`を返す。Canon更新警告は
    参照APIが使えないときも画面へ状態を出す必要があり、再実行はそのまま失敗として
    返す必要があるため、扱いを呼び出し側で分ける。

    Scene/Shot本文が宣言していないCanon(利用者がJobの入力として選んだVoice Canonなど)
    は、記録済みの`input_refs`を手がかりに引き直す。引き直さないと、現在側に同じ参照が
    現れず、更新が無くても常に`missing`として扱われてしまう。
    """
    try:
        project_id, scene_id, shot_id = _reference_ids(job)
        resolved = await _resolve_references(source, project_id, scene_id, shot_id)
        selected = await _current_selected_canon(source, project_id, recorded or [])
    except ApiError as error:
        return None, error
    return [
        resolved.scene_ref,
        resolved.shot_ref,
        *resolved.canon_refs,
        *selected,
    ], None


async def _current_selected_canon(
    source: ReferenceSource, project_id: str, recorded: list[Any]
) -> list[dict[str, Any]]:
    """記録済みの`input_refs`にある、入力として選んだCanonを現在の参照で引き直す。

    参照元から消えたCanonは現在側に並べない。呼び出し元の突き合わせで`missing`に
    なり、再実行できないことが利用者へ伝わる。
    """
    entries: list[dict[str, Any]] = []
    for reference in recorded:
        if not isinstance(reference, dict):
            continue
        if reference.get("kind") != provenance.KIND_CANON:
            continue
        if reference.get("declared_by") != provenance.DECLARED_BY_INPUT:
            continue
        canon_id = reference.get("canon_id")
        if not isinstance(canon_id, str):
            continue
        try:
            descriptor = await source.get_canon(project_id, canon_id)
        except AiMediaNotFound:
            continue
        except AiMediaUnavailable as error:
            logger.warning("ai-media参照APIを利用できません。", exc_info=error)
            raise ApiError(
                "REFERENCE_UNAVAILABLE",
                "ai-media参照APIを利用できませんでした。",
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            ) from error
        if not isinstance(descriptor, dict):
            continue
        try:
            entries.append(
                provenance.canon_entry(
                    descriptor.get("reference"),
                    declared_by=provenance.DECLARED_BY_INPUT,
                )
            )
        except provenance.ReferenceError as error:
            logger.warning(
                "Canon descriptorから不変参照を取り出せません。canon_id=%s",
                canon_id,
                exc_info=error,
            )
    return entries


def _verify_local_input(reference: dict[str, Any]) -> dict[str, Any]:
    """参照APIで解決しない入力の実ファイルが記録時と同じ内容かを確かめる。

    利用者が取り込んだ素材(`cached_input`)と、入力に使った生成物(`artifact`)の
    どちらも、当時の入力の一部として再現可否に効く。設計どおり、取得できないか内容が
    違えばExact Replayを実行しない(docs/design/generation-records.md)。保存先が
    違うため、解決先は種別で分ける。
    """
    kind = str(reference.get("kind"))
    label = "生成物" if kind == provenance.KIND_ARTIFACT else "入力cache"
    note = reference.get("note")
    entry: dict[str, Any] = {
        "kind": kind,
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
        entry["reason"] = f"{label}の参照にrelative_pathかsha256がありません。"
        return entry
    resolve = (
        storage.resolve_artifact
        if kind == provenance.KIND_ARTIFACT
        else storage.resolve_input
    )
    try:
        raw = resolve(relative_path).read_bytes()
    except (storage.StorageError, OSError):
        entry["change"] = provenance.CHANGE_MISSING
        entry["reason"] = f"{label}の実ファイルを読み込めません。"
        return entry
    digest = hashlib.sha256(raw).hexdigest()
    if digest != expected.lower():
        entry["change"] = provenance.CHANGE_UPDATED
        entry["reason"] = f"{label}の内容が記録済みのhashと一致しません。"
        entry["current"] = {"relative_path": relative_path, "sha256": digest}
    return entry


def _local_input_entries(input_refs: Any) -> list[dict[str, Any]]:
    """参照APIで解決しない入力の参照を、比較結果の形へ揃える。"""
    if not isinstance(input_refs, list):
        return []
    return [
        _verify_local_input(reference)
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
    current, failure = await _current_references(source, job, manifest.input_refs)
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
    entries.extend(_local_input_entries(manifest.input_refs))
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

    current, failure = await _current_references(source, job, manifest.input_refs)
    if current is None:
        # 参照IDの欠落と上流の不調では原因が違う。解決を試みたときの分類をそのまま返す。
        raise failure or ApiError(
            "REFERENCE_UNAVAILABLE",
            "記録済みの入力を検証できませんでした。",
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            details={"job_id": job.id},
        )
    entries = provenance.compare(manifest.input_refs or [], current)
    entries.extend(_local_input_entries(manifest.input_refs))
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
    # Scene/Shotが宣言していない、入力として選んだCanon(音声JobのVoice Canonなど)も
    # 現在の参照で引き直す。ここで拾わないと、派生Jobの履歴からどのCanonで生成したかが
    # 消える。
    selected = await _current_selected_canon(
        source, project_id, manifest.input_refs or []
    )
    return await _create_derived_job(
        session,
        job,
        manifest,
        workflow_body,
        workflow_artifact.id,
        scene_ref=resolved.scene_ref,
        shot_ref=resolved.shot_ref,
        input_refs=_merge_input_refs(resolved.input_refs(cached), selected),
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
    artifacts = await _artifact_reads(session, result.scalars().all())
    return schemas.JobLineageRead(
        job=schemas.GenerationJobRead.model_validate(job),
        ancestors=[
            schemas.GenerationJobRead.model_validate(item) for item in ancestors
        ],
        descendants=[
            schemas.GenerationJobRead.model_validate(item) for item in descendants
        ],
        artifacts=artifacts,
        truncated=ancestors_truncated or descendants_truncated,
    )


@router.get(
    "/generation-jobs/{job_id}/voice-verifications",
    response_model=list[schemas.VoiceVerificationRead],
)
async def list_voice_verifications(job_id: str, session: SessionDep):
    """音声Jobの読み検証を台詞順で返す。

    ASR結果が期待読みと一致しなかったこと自体はJobの失敗ではない。音声は生成できて
    いるため、判断は利用者へ委ねる。
    """
    await _get_or_404(session, GenerationJob, "GenerationJob", job_id)
    result = await session.execute(
        select(VoiceVerification)
        .where(VoiceVerification.job_id == job_id)
        .order_by(VoiceVerification.dialogue_index.asc())
    )
    return list(result.scalars().all())


@router.get("/backends/voice/health", response_model=schemas.VoiceBackendHealthRead)
async def get_voice_backend_health():
    """voice-runnerの疎通とengineの利用可否を中継する。

    接続できないことは障害として応答本文で伝え、HTTPのエラーにしない。画面は音声
    Backendが使えない状態でも他の機能を出し続ける。
    """
    backend = create_voice_backend()
    try:
        health = await backend.health()
    except VoiceError as error:
        logger.info("voice-runnerの状態を取得できません。", exc_info=error)
        return schemas.VoiceBackendHealthRead(
            base_url=backend.base_url, reachable=False, reason=str(error), engines=[]
        )
    finally:
        await backend.aclose()
    return schemas.VoiceBackendHealthRead(
        base_url=health.base_url,
        reachable=True,
        reason=None,
        engines=[
            schemas.VoiceEngineHealthRead(
                id=engine.id,
                available=engine.available,
                model=engine.model,
                revision=engine.revision,
                sample_rate=engine.sample_rate,
                needs_katakana=engine.needs_katakana,
                detail=engine.detail,
            )
            for engine in health.engines
        ],
    )


@router.get("/backends/comfyui/health", response_model=schemas.ComfyUIBackendHealthRead)
async def get_comfyui_backend_health():
    """ComfyUIの疎通と版を中継する。

    接続できないことは障害として応答本文で伝え、HTTPのエラーにしない。画面は動画・
    音楽Backendが使えない状態でも他の機能を出し続ける。
    """
    client = create_comfyui_client()
    try:
        status_info = await client.status()
    except ComfyUIError as error:
        logger.info("ComfyUIの状態を取得できません。", exc_info=error)
        return schemas.ComfyUIBackendHealthRead(
            base_url=client.base_url, reachable=False, reason=str(error)
        )
    finally:
        await client.aclose()
    return schemas.ComfyUIBackendHealthRead(
        base_url=status_info.base_url,
        reachable=True,
        reason=None,
        version=status_info.version,
        devices=list(status_info.devices),
    )


@router.post(
    "/image-references",
    response_model=schemas.ImageReferenceRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_image_reference(payload: schemas.ImageReferenceCreate):
    """参照画像とガイド音声を入力cacheへ取り込む。

    ComfyUIの`LoadImage`と`LoadAudio`はComfyUI側のinputにあるファイルしか参照できず、
    手元の素材をそのまま渡せない。取り込んだ内容のSHA-256を返し、Job投入時の参照に
    使えるようにする。実際のアップロードはJobの実行直前にAdapterが行う。
    """
    settings = get_settings()
    # 復号の前に文字数で弾く。base64は3バイトを4文字で表すため、文字数から上限を
    # 逆算する。復号まで通すと、上限を超える分の複製がもう1つメモリへ載る。
    encoded_limit = (settings.max_image_bytes + 2) // 3 * 4
    if len(payload.content_base64) > encoded_limit:
        raise _validation_error(
            "素材が上限を超えています。", {"limit": settings.max_image_bytes}
        )
    try:
        data = base64.b64decode(payload.content_base64, validate=True)
    except (binascii.Error, ValueError) as error:
        raise _validation_error("content_base64を復号できません。") from error
    if not data:
        raise _validation_error("空のファイルは取り込めません。")
    if len(data) > settings.max_image_bytes:
        raise _validation_error(
            "素材が上限を超えています。",
            {"byte_size": len(data), "limit": settings.max_image_bytes},
        )
    try:
        stored = storage.write_input(payload.file_name, data, settings)
    except storage.StorageError as error:
        logger.exception("素材を取り込めません。")
        raise ApiError(
            "STORAGE_ERROR",
            "素材を取り込めませんでした。",
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        ) from error
    return schemas.ImageReferenceRead(
        relative_path=stored.relative_path,
        sha256=stored.sha256,
        byte_size=stored.byte_size,
        media_type=payload.media_type,
    )


@router.post(
    "/voice-references",
    response_model=schemas.VoiceReferenceRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_voice_reference(payload: schemas.VoiceReferenceCreate):
    """参照音声を入力cacheへ取り込む。

    参照APIはVoice Canonの`source_audio`を公開しないため、参照音声そのものを上流から
    取得する経路は無い。利用者が取り込んだファイルの内容hashを返し、Voice Canonの
    `source_sha256`と突き合わせられるようにする。
    """
    settings = get_settings()
    # 復号の前に文字数で弾く。要求本文そのものは受信した時点でメモリに載っているが、
    # 復号を通すと上限を超える分の複製がもう1つ増える。base64は3バイトを4文字で表す
    # ため、文字数から上限を逆算する。
    encoded_limit = (settings.voice_max_audio_bytes + 2) // 3 * 4
    if len(payload.content_base64) > encoded_limit:
        raise _validation_error(
            "参照音声が上限を超えています。",
            {"limit": settings.voice_max_audio_bytes},
        )
    try:
        data = base64.b64decode(payload.content_base64, validate=True)
    except (binascii.Error, ValueError) as error:
        raise _validation_error("content_base64を復号できません。") from error
    if len(data) > settings.voice_max_audio_bytes:
        raise _validation_error(
            "参照音声が上限を超えています。",
            {"byte_size": len(data), "limit": settings.voice_max_audio_bytes},
        )
    try:
        info = voice_audio.inspect(data)
    except voice_audio.AudioError as error:
        # 取り込めるのはPCM wavだけとする。runnerへそのまま渡す素材のため、扱えない
        # 符号化を入力cacheへ残さない。
        raise _validation_error(f"PCM wavとして読み込めません: {error}") from error
    try:
        stored = storage.write_input(payload.file_name, data, settings)
    except storage.StorageError as error:
        logger.exception("参照音声を取り込めません。")
        raise ApiError(
            "STORAGE_ERROR",
            "参照音声を取り込めませんでした。",
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        ) from error
    return schemas.VoiceReferenceRead(
        relative_path=stored.relative_path,
        sha256=stored.sha256,
        byte_size=stored.byte_size,
        media_type="audio/wav",
        sample_rate=info.sample_rate,
        channels=info.channels,
        duration_sec=round(info.duration_sec, 4),
    )


def get_agent_provider(request: Request) -> AgentProvider:
    return request.app.state.agent_provider


AgentProviderDep = Annotated[AgentProvider, Depends(get_agent_provider)]

#: 提案の入力へ載せる既存Artifactの取得上限。
AGENT_CONTEXT_ARTIFACT_LIMIT = 20


@router.get("/agent-providers", response_model=list[schemas.AgentProviderRead])
async def list_agent_providers(provider: AgentProviderDep):
    """設定済みProviderを返す。接続先と認証情報は返さない。"""
    return [
        schemas.AgentProviderRead(
            id=provider.id, label=provider.label, available=await provider.available()
        )
    ]


async def _fetch_envelopes(
    source: ReferenceSource, project_id: str, scene_id: str, shot_id: str | None
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """提案の入力に使うScene/Shotを参照APIから取得する。

    提案はJobを作らないため不変参照までは固定しない。取得できないときは提案も作らない。
    現在の内容を読めないまま提案すると、どの内容に対する提案か後から説明できない。
    """
    try:
        scene_envelope = await source.get_scene(project_id, scene_id)
        shot_envelope = (
            await source.get_shot(project_id, scene_id, shot_id)
            if shot_id is not None
            else None
        )
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
    return scene_envelope, shot_envelope


async def _agent_context(
    session: AsyncSession,
    payload: schemas.AgentProposalCreate,
    recipe: Recipe | None,
    scene_envelope: dict[str, Any],
    shot_envelope: dict[str, Any] | None,
) -> dict[str, Any]:
    """Providerへ渡す入力コンテキストを許可リストで組み立てる。

    渡す項目は`proposals`側で列挙する。ここでは対象の取得だけを行い、参照APIの応答を
    そのまま流さない。秘密情報、環境変数、ローカル絶対パスは含めない。
    """
    context: dict[str, Any] = {
        "scene": proposals.scene_context(scene_envelope.get("data")),
    }
    if shot_envelope is not None:
        context["shot"] = proposals.shot_context(shot_envelope.get("data"))
    if recipe is not None:
        context["recipe"] = proposals.recipe_context(recipe)
    if payload.kind == "reference_candidates":
        jobs = select(GenerationJob.id).where(
            GenerationJob.scene_ref["id"].as_string() == payload.scene_id
        )
        query = (
            select(Artifact)
            .where(Artifact.job_id.in_(jobs))
            .where(Artifact.kind == "image")
            .where(Artifact.availability == "complete")
            .order_by(Artifact.created_at.desc(), Artifact.id.asc())
            .limit(AGENT_CONTEXT_ARTIFACT_LIMIT)
        )
        result = await session.execute(query)
        context["artifacts"] = proposals.artifact_context(list(result.scalars().all()))
    return context


def _planned_operation(proposal: AgentProposal) -> dict[str, Any] | None:
    """提案から、承認後に実行する操作を組み立てる。

    提案の内容から毎回組み立て直す。承認時に記録したdigestと突き合わせるため、提案が
    差し替わればdigestも変わり、古い承認では実行できない。

    副作用のある操作へつながるのは`image_prompt`だけとする。Shot構成案、参照候補、
    Recipe案は表示だけで、ai-mediaへの書き込みとRecipe登録は本Issueの範囲外とする。
    """
    if proposal.kind != "image_prompt":
        return None
    output = proposal.output
    if not isinstance(output, dict) or proposal.recipe_id is None:
        return None
    if proposal.shot_id is None:
        return None
    return {
        "type": approvals.OPERATION_GENERATION_JOB_CREATE,
        "target": {
            "project_id": proposal.project_id,
            "scene_id": proposal.scene_id,
            "shot_id": proposal.shot_id,
            "recipe_id": proposal.recipe_id,
        },
        "payload": {
            "kind": "image",
            "inputs": {
                "positive_prompt": output.get("positive_prompt"),
                "negative_prompt": output.get("negative_prompt", ""),
            },
        },
    }


def _context_artifact_ids(context: dict[str, Any]) -> set[str]:
    """入力コンテキストへ載せたArtifact IDの集合。提案の出力を突き合わせるのに使う。"""
    entries = context.get("artifacts")
    if not isinstance(entries, list):
        return set()
    return {
        str(entry["artifact_id"])
        for entry in entries
        if isinstance(entry, dict) and entry.get("artifact_id")
    }


def _proposal_read(proposal: AgentProposal) -> schemas.AgentProposalRead:
    """提案の応答。適用予定の操作とそのdigestを一緒に返す。

    画面は対象と内容をこの値で表示し、同じdigestの承認だけが実行へ進む。
    """
    read = schemas.AgentProposalRead.model_validate(proposal)
    operation = _planned_operation(proposal)
    if operation is None:
        return read
    return read.model_copy(
        update={
            "planned_operation": schemas.PlannedOperation(
                type=operation["type"],
                effect=approvals.effect_of(operation["type"]),
                target=operation["target"],
                payload=operation["payload"],
                digest=approvals.operation_digest(operation),
            )
        }
    )


def _validate_agent_recipe(recipe: Recipe, kind: str) -> None:
    """承認後にJobを作れるRecipeかを、提案を取る前に確かめる。"""
    if kind != "image_prompt":
        return
    if recipe.kind != "image" or recipe.engine != ENGINE_COMFYUI:
        raise _validation_error(
            "image_promptの提案には画像生成のRecipeを指定してください。",
            {"recipe_kind": recipe.kind, "engine": recipe.engine},
        )


def _agent_error(error: agent_base.AgentError) -> ApiError:
    """提案Adapterの失敗を、画面が種別で判定できるEnvelopeへ変換する。"""
    if isinstance(error, agent_base.AgentInvalidResponse):
        return ApiError(
            "AGENT_INVALID_RESPONSE",
            "提案Providerの応答を提案として扱えませんでした。",
            status_code=status.HTTP_502_BAD_GATEWAY,
        )
    return ApiError(
        "AGENT_UNAVAILABLE",
        f"提案Providerを利用できませんでした: {error}",
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
    )


async def _record_proposal_failure(
    session: AsyncSession, proposal: AgentProposal, error: agent_base.AgentError
) -> None:
    """失敗した提案も履歴へ残す。記録に失敗しても提案の失敗を返す。

    Providerの不調で履歴管理まで止めないため、ここでの失敗は呼び出し元へ伝えない。
    握るのは永続化層の失敗だけとする。それ以外の例外は実装の誤りであり、提案の失敗へ
    読み替えるとJobや履歴の不整合を見落とすため、そのまま外へ出す。
    """
    proposal.state = "failed"
    proposal.failure_code = (
        "AGENT_INVALID_RESPONSE"
        if isinstance(error, agent_base.AgentInvalidResponse)
        else "AGENT_UNAVAILABLE"
    )
    proposal.failure_message = str(error)[:500]
    # rollback後はORM objectの属性を参照できないため、ログへ出すIDを先に取り出す。
    proposal_id = proposal.id
    session.add(proposal)
    try:
        await session.commit()
    except SQLAlchemyError:
        await session.rollback()
        logger.warning("失敗した提案を記録できません。proposal_id=%s", proposal_id)


@router.post(
    "/agent-proposals",
    response_model=schemas.AgentProposalRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_agent_proposal(
    payload: schemas.AgentProposalCreate,
    session: SessionDep,
    source: ReferenceSourceDep,
    provider: AgentProviderDep,
):
    """提案を取得して履歴へ残す。生成Jobは作らない。

    提案の取得は副作用を持たない操作として承認を求めない。ここで作るのは提案の記録
    だけで、Job、Artifact、Manifestには触れない。

    Providerが失敗した場合も提案を`failed`として残し、他の機能は止めない。
    """
    recipe: Recipe | None = None
    if payload.recipe_id is not None:
        recipe = await _get_or_404(session, Recipe, "Recipe", payload.recipe_id)
        _validate_agent_recipe(recipe, payload.kind)
    scene_envelope, shot_envelope = await _fetch_envelopes(
        source, payload.project_id, payload.scene_id, payload.shot_id
    )
    context = await _agent_context(
        session, payload, recipe, scene_envelope, shot_envelope
    )
    proposal = AgentProposal(
        id=schemas.new_id(),
        provider_id=provider.id,
        kind=payload.kind,
        state="proposed",
        project_id=payload.project_id,
        scene_id=payload.scene_id,
        shot_id=payload.shot_id,
        recipe_id=payload.recipe_id,
        instruction=payload.instruction,
        request_context=context,
        output=None,
        usage=None,
        model=None,
        failure_code=None,
        failure_message=None,
        applied_job_id=None,
        created_at=schemas.now_iso(),
        decided_at=None,
    )
    request = agent_base.ProposalRequest(
        kind=payload.kind, instruction=payload.instruction, context=context
    )
    try:
        result = await provider.propose(request)
    except agent_base.AgentError as error:
        await _record_proposal_failure(session, proposal, error)
        raise _agent_error(error) from error
    proposal.output = proposals.restrict_reference_candidates(
        payload.kind, result.output, _context_artifact_ids(context)
    )
    proposal.usage = result.usage or None
    proposal.model = result.model
    session.add(proposal)
    await _commit(session)
    return _proposal_read(proposal)


@router.get("/agent-proposals", response_model=list[schemas.AgentProposalRead])
async def list_agent_proposals(
    session: SessionDep,
    scene_id: str | None = None,
    shot_id: str | None = None,
    state: schemas.AgentProposalState | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
):
    """提案履歴の一覧。既定は作成の新しい順に返す。"""
    query = select(AgentProposal).order_by(
        AgentProposal.created_at.desc(), AgentProposal.id.asc()
    )
    if scene_id is not None:
        query = query.where(AgentProposal.scene_id == scene_id)
    if shot_id is not None:
        query = query.where(AgentProposal.shot_id == shot_id)
    if state is not None:
        query = query.where(AgentProposal.state == state)
    result = await session.execute(query.limit(limit).offset(offset))
    return [_proposal_read(proposal) for proposal in result.scalars().all()]


@router.get("/agent-proposals/{proposal_id}", response_model=schemas.AgentProposalRead)
async def get_agent_proposal(proposal_id: str, session: SessionDep):
    proposal = await _get_or_404(session, AgentProposal, "Agent提案", proposal_id)
    return _proposal_read(proposal)


def _operation_not_allowed(error: approvals.OperationNotAllowed) -> ApiError:
    return ApiError(
        "OPERATION_NOT_ALLOWED",
        str(error),
        status_code=status.HTTP_403_FORBIDDEN,
    )


@router.post(
    "/agent-proposals/{proposal_id}/decision",
    response_model=schemas.AgentProposalRead,
)
async def decide_agent_proposal(
    proposal_id: str, payload: schemas.AgentProposalDecision, session: SessionDep
):
    """提案への承認・却下をApprovalLogへ追記する。

    承認しただけでは何も実行しない。実行は適用の要求で明示的に行う。承認時点の操作
    内容のdigestを記録し、提案や対象が変わった後の承認を使い回せないようにする。
    """
    proposal = await _get_or_404(session, AgentProposal, "Agent提案", proposal_id)
    current_state = proposal.state
    seen_decided_at = proposal.decided_at
    decidable_states = await _decidable_states(session, proposal)
    if current_state not in decidable_states:
        raise ApiError(
            "PROPOSAL_NOT_DECIDABLE",
            "この提案はすでに判断済みか、判断できない状態です。",
            status_code=status.HTTP_409_CONFLICT,
            details={"state": current_state},
        )
    operation = _planned_operation(proposal)
    if payload.decision == "approved":
        if operation is None:
            raise _validation_error(
                "この提案は副作用のある操作を伴わないため、承認の対象になりません。",
                {"kind": proposal.kind},
            )
        try:
            approvals.require_executable(operation["type"])
        except approvals.OperationNotAllowed as error:
            raise _operation_not_allowed(error) from error
    decided_at = schemas.now_iso()
    settings = get_settings()
    approval_log = ApprovalLog(
        id=schemas.new_id(),
        subject_type=approvals.SUBJECT_TYPE_AGENT_PROPOSAL,
        subject_id=proposal.id,
        requested_operation=(
            approvals.requested_operation(operation)
            if operation is not None
            else {"type": approvals.OPERATION_AGENT_PROPOSE, "kind": proposal.kind}
        ),
        decision=payload.decision,
        actor_type="user",
        actor_id=payload.actor_id,
        decided_at=decided_at,
        expires_at=(
            approvals.expires_at(decided_at, settings.agent_approval_ttl_seconds)
            if payload.decision == "approved"
            else None
        ),
    )
    # 承認と却下がほぼ同時に届いても、両方をApprovalLogへ残さない。状態と直前の判断時刻
    # を条件に含めて更新し、更新できた要求だけが判断を記録する。
    #
    # 期限切れの承認をやり直す経路では状態が`approved`のまま変わらない。状態だけを条件に
    # すると、先に届いた再承認で期限が延びた後でも同じ条件が成り立ち、二重に記録できて
    # しまう。読み取った時点の判断時刻も条件に含めて、その時点からの更新に限る。
    next_state = "approved" if payload.decision == "approved" else "rejected"
    claimed = await session.execute(
        update(AgentProposal)
        .where(AgentProposal.id == proposal.id)
        .where(AgentProposal.state.in_(decidable_states))
        .where(AgentProposal.decided_at.is_not_distinct_from(seen_decided_at))
        .values(state=next_state, decided_at=decided_at)
    )
    if claimed.rowcount != 1:
        await session.rollback()
        raise ApiError(
            "PROPOSAL_NOT_DECIDABLE",
            "この提案はすでに判断済みか、判断できない状態です。",
            status_code=status.HTTP_409_CONFLICT,
            details={"state": current_state},
        )
    session.add(approval_log)
    await _commit(session)
    await session.refresh(proposal)
    return _proposal_read(proposal)


async def _decidable_states(
    session: AsyncSession, proposal: AgentProposal
) -> tuple[str, ...]:
    """判断を受け付ける状態を返す。

    承認は一定時間で切れる。切れた承認では適用できないため、`approved`のまま判断も
    やり直せないと提案が行き止まりになる。承認が切れているときに限り、同じ提案への
    判断をもう一度受け付ける。
    """
    if proposal.state != "approved":
        return ("proposed",)
    latest = await _latest_approval(session, proposal.id)
    if latest is None or latest.decision != "approved":
        return ("proposed",)
    if not approvals.is_expired(latest.expires_at, schemas.now_iso()):
        return ("proposed",)
    return ("proposed", "approved")


async def _latest_approval(
    session: AsyncSession, proposal_id: str
) -> ApprovalLog | None:
    """提案に対する直近の承認記録を取る。ApprovalLogは追記専用のため更新しない。"""
    result = await session.execute(
        select(ApprovalLog)
        .where(ApprovalLog.subject_type == approvals.SUBJECT_TYPE_AGENT_PROPOSAL)
        .where(ApprovalLog.subject_id == proposal_id)
        .order_by(ApprovalLog.decided_at.desc(), ApprovalLog.id.desc())
        .limit(1)
    )
    return result.scalars().first()


@router.post(
    "/agent-proposals/{proposal_id}/apply",
    response_model=schemas.GenerationJobRead,
    status_code=status.HTTP_201_CREATED,
)
async def apply_agent_proposal(
    proposal_id: str, session: SessionDep, source: ReferenceSourceDep
):
    """承認済みの提案を実行する。ここでだけ生成Jobを作る。

    実行直前に操作内容のdigestを組み立て直し、承認記録と突き合わせる。対象や内容が
    変わっていれば実行しない。適用は1回だけとし、`approved`からの条件付き更新で
    二重投入を防ぐ。
    """
    proposal = await _get_or_404(session, AgentProposal, "Agent提案", proposal_id)
    operation = _planned_operation(proposal)
    if operation is None:
        raise _validation_error(
            "この提案には実行できる操作がありません。", {"kind": proposal.kind}
        )
    try:
        approvals.require_executable(operation["type"])
    except approvals.OperationNotAllowed as error:
        raise _operation_not_allowed(error) from error
    record = await _latest_approval(session, proposal.id)
    try:
        approvals.verify(
            record, operation, now=schemas.now_iso(), subject_id=proposal.id
        )
    except approvals.ApprovalInvalid as error:
        raise ApiError(
            error.code, str(error), status_code=status.HTTP_409_CONFLICT
        ) from error
    # 適用済みの提案から2件目のJobを作らない。状態を条件に含めて更新し、更新できた
    # 場合だけ実行へ進む。
    #
    # 応答へ出す値はrollbackの前に取り出す。rollback後のORM objectは属性が失効し、
    # 読み直しに非同期の問い合わせが必要になるため、その場では参照できない。
    current_state = proposal.state
    claimed = await session.execute(
        update(AgentProposal)
        .where(AgentProposal.id == proposal.id)
        .where(AgentProposal.state == "approved")
        .values(state="applied")
    )
    if claimed.rowcount != 1:
        await session.rollback()
        raise ApiError(
            "PROPOSAL_NOT_APPROVED",
            "承認済みの提案ではありません。",
            status_code=status.HTTP_409_CONFLICT,
            details={"state": current_state},
        )
    target = operation["target"]
    job_payload = schemas.GenerationJobCreate(
        kind="image",
        project_id=target["project_id"],
        scene_id=target["scene_id"],
        shot_id=target["shot_id"],
        recipe_id=target["recipe_id"],
        inputs=operation["payload"]["inputs"],
    )
    try:
        job = await create_generation_job(
            payload=job_payload, session=session, source=source
        )
    except ApiError as error:
        # Jobは作成済みだが応答を組み立てられなかった場合。提案は`applied`で確定して
        # いるため、ここで紐付けを残さないとどのJobを投入したのか辿れなくなる。
        job_id = (error.details or {}).get("job_id")
        if error.code != "JOB_RECORD_UNREADABLE" or not job_id:
            raise
        await _link_applied_job(proposal.id, str(job_id))
        raise
    # 応答に必要な値はコミットの前に取り出す。紐付けに失敗してrollbackすると、ORMの
    # objectは属性が失効し、その場では応答を組み立てられなくなる。
    job_id = job.id
    job_read = schemas.GenerationJobRead.model_validate(job)
    try:
        await session.execute(
            update(AgentProposal)
            .where(AgentProposal.id == proposal_id)
            .values(applied_job_id=job_id)
        )
        await session.commit()
    except SQLAlchemyError:
        # Jobは作成済みで、提案も`applied`で確定している。ここで失敗を返すと投入済みの
        # Jobを辿れなくなるため、別のセッションで紐付けを残して応答は返す。
        logger.exception(
            "適用した提案の紐付けをコミットできません。proposal_id=%s job_id=%s",
            proposal_id,
            job_id,
        )
        await session.rollback()
        await _link_applied_job(proposal_id, job_id)
    return job_read


async def _link_applied_job(proposal_id: str, job_id: str) -> None:
    """提案へ投入済みJobを結ぶ。応答を返せなかった経路からの後追い記録に使う。

    呼び出し元のセッションは応答を組み立てられない状態のため、別のセッションで書く。
    ここでの失敗はJobの作成結果を変えないため、警告だけ残す。
    """
    try:
        async with get_session_factory()() as session:
            await session.execute(
                update(AgentProposal)
                .where(AgentProposal.id == proposal_id)
                .values(applied_job_id=job_id)
            )
            await session.commit()
    except SQLAlchemyError:
        logger.warning(
            "適用した提案へJobを結べません。proposal_id=%s job_id=%s",
            proposal_id,
            job_id,
        )


@router.get("/approval-logs", response_model=list[schemas.ApprovalLogRead])
async def list_approval_logs(
    session: SessionDep,
    subject_type: str | None = None,
    subject_id: str | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
):
    """承認履歴の一覧。既定は判断の新しい順に返す。

    承認対象、許可した操作、判断、時刻をここで確認できる。ApprovalLogは追記専用の
    ため、この経路でも書き換えない。
    """
    # 判断時刻が同じ記録の順序を`_latest_approval`と揃える。画面が最新と見る記録と、
    # 適用時に突き合わせる記録を食い違わせない。
    query = select(ApprovalLog).order_by(
        ApprovalLog.decided_at.desc(), ApprovalLog.id.desc()
    )
    if subject_type is not None:
        query = query.where(ApprovalLog.subject_type == subject_type)
    if subject_id is not None:
        query = query.where(ApprovalLog.subject_id == subject_id)
    result = await session.execute(query.limit(limit).offset(offset))
    return result.scalars().all()
