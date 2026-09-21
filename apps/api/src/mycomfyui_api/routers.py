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
    AgentProposalApplication,
    ApprovalLog,
    Artifact,
    ArtifactTag,
    Base,
    GenerationJob,
    GenerationManifest,
    Project,
    ProjectShot,
    Recipe,
    VoiceVerification,
    Workflow,
    WorkflowVersion,
)
from mycomfyui_api.queue import FAILURE_CODE_INTERRUPTED, JobQueueWorker
from mycomfyui_api.references import get_reference_source
from mycomfyui_api.settings import get_settings
from mycomfyui_api.structure import (
    get_local_scene,
    get_local_shot,
    scene_envelope as local_scene_envelope,
    shot_envelope as local_shot_envelope,
    shot_summary as local_shot_summary,
)

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
    await _validate_project_context(session, payload.project_id)
    resolved = await _resolve_references(
        session, source, payload.project_id, payload.scene_id, payload.shot_id
    )
    effective, recipe, _, _, preferences = await _resolve_generation_defaults(
        session, payload, resolved
    )
    # 実行スナップショットの組み立てはengineごとのAdapterが行う。音声Jobは台詞を
    # 固定する必要があるため、参照APIから取得したShot本文もここで渡す。
    prepared = await _prepare_execution(recipe, effective, source, resolved, session)
    queue_sequence = _resolve_queue_sequence(payload.queue_sequence)

    job_id = schemas.new_id()
    stored = _store_workflow_snapshot(job_id, prepared.snapshot)
    # 書き出した後はどこで失敗してもスナップショットを残さない。レコードの組み立てと
    # 永続化をまとめて囲み、後始末の無い隙間を作らない。
    try:
        job, workflow_artifact, manifest = _build_job_records(
            job_id,
            effective,
            recipe,
            prepared,
            stored,
            queue_sequence,
            resolved,
            preferences,
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
    await _validate_project_context(session, payload.project_id)
    resolved = await _resolve_references(
        session, source, payload.project_id, payload.scene_id, payload.shot_id
    )
    effective, recipe, recipe_origin, input_origins, preferences = (
        await _resolve_generation_defaults(session, payload, resolved)
    )
    prepared = await _prepare_execution(recipe, effective, source, resolved, session)
    defaults = recipe.defaults if isinstance(recipe.defaults, dict) else {}
    version = await _load_recipe_version(session, recipe)
    workflow, workflow_version = version if version is not None else (None, None)
    return schemas.GenerationPreviewRead(
        scene_ref=resolved.scene_ref,
        shot_ref=resolved.shot_ref,
        canon_refs=resolved.canon_refs,
        engine=recipe.engine,
        recipe_id=recipe.id,
        recipe_origin=recipe_origin,
        resolved_prompt=prepared.resolved_prompt,
        model=dict(prepared.model),
        seed=prepared.seed,
        seed_auto=_is_seed_auto(defaults, effective.inputs, prepared),
        parameters={
            **dict(prepared.parameters),
            **({"production_preferences": preferences} if preferences else {}),
        },
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
        diff=_build_workflow_diff(
            recipe, defaults, effective.inputs, prepared, input_origins
        ),
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
    input_origins: dict[str, schemas.GenerationDefaultOrigin],
) -> list[schemas.GenerationPreviewDiff]:
    """Workflowの既定値、Recipeの既定値、今回確定する値を変数ごとに並べる。

    テンプレートファイルを持たないengineは`workflow_default`を持たない。その場合は
    Recipeの既定値を基準にして、変わったかどうかを判定する。基準が無ければ、変わって
    いないものとして扱う。
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
        if name in workflow_defaults:
            baseline: Any = workflow_default
            has_baseline = True
        else:
            baseline = defaults.get(name)
            has_baseline = name in defaults
        if name in inputs:
            origin = input_origins.get(name, "runtime")
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
                changed=resolved and has_baseline and value != baseline,
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
        return [
            reference
            for reference in [self.scene_ref, self.shot_ref, *self.canon_refs, *extra]
            if reference.get("kind")
        ]


def _profile_from_data(
    data: dict[str, Any], kind: schemas.GenerationKind
) -> schemas.ProjectGenerationProfile:
    """Scene/Shotの将来互換な`generation_defaults`から媒体設定を読む。"""
    settings = data.get("generation_defaults")
    if not isinstance(settings, dict):
        return schemas.ProjectGenerationProfile()
    raw = settings.get(kind)
    if not isinstance(raw, dict):
        return schemas.ProjectGenerationProfile()
    try:
        return schemas.ProjectGenerationProfile.model_validate(raw)
    except ValueError:
        # 外部参照の補助設定が壊れていても、明示した実行時入力までは妨げない。
        return schemas.ProjectGenerationProfile()


async def _resolve_generation_defaults(
    session: AsyncSession,
    payload: schemas.GenerationPreviewCreate,
    resolved: _ResolvedReferences,
) -> tuple[
    schemas.GenerationPreviewCreate,
    Recipe,
    schemas.GenerationDefaultOrigin,
    dict[str, schemas.GenerationDefaultOrigin],
    dict[str, Any],
]:
    """Recipeと入力をProject、Scene、Shot、実行時指定の順で上書きする。"""
    project_profile = schemas.ProjectGenerationProfile()
    local_overrides = schemas.ProjectLocalOverrides()
    if payload.project_id is not None:
        project = await session.get(Project, payload.project_id)
        if project is not None:
            defaults = schemas.ProjectGenerationDefaults.model_validate(
                project.generation_defaults or {}
            )
            project_profile = getattr(defaults, payload.kind)
            local_overrides = schemas.ProjectLocalOverrides.model_validate(
                project.local_overrides or {}
            )
    scene_profile = _profile_from_data(resolved.scene_data, payload.kind)
    shot_profile = _profile_from_data(resolved.shot_data, payload.kind)

    recipe_candidates: list[tuple[str | None, schemas.GenerationDefaultOrigin]] = [
        (
            None if payload.use_inherited_defaults else payload.recipe_id,
            "runtime",
        ),
        (shot_profile.recipe_id, "shot"),
        (scene_profile.recipe_id, "scene"),
        (project_profile.recipe_id, "project"),
    ]
    recipe_id, recipe_origin = next(
        ((value, origin) for value, origin in recipe_candidates if value is not None),
        (None, "recipe_default"),
    )
    if recipe_id is None:
        raise _validation_error(
            "Recipeを指定するか、Projectの生成既定値へ設定してください。",
            {"kind": payload.kind, "project_id": payload.project_id},
        )
    recipe = await _get_or_404(session, Recipe, "Recipe", recipe_id)
    _validate_recipe_matches(recipe, payload)

    inputs: dict[str, Any] = {}
    input_origins: dict[str, schemas.GenerationDefaultOrigin] = {}
    preferences: dict[str, Any] = {}
    for profile, origin in (
        (project_profile, "project"),
        (scene_profile, "scene"),
        (shot_profile, "shot"),
    ):
        for name, value in profile.inputs.items():
            inputs[name] = value
            input_origins[name] = origin
        for name in (
            "character_references",
            "style",
            "color_tone",
            "voice_cast",
            "bgm_policy",
            "output_directory",
            "filename_pattern",
        ):
            value = getattr(profile, name)
            if value not in (None, [], ""):
                preferences[name] = value
    if payload.kind in ("image", "video"):
        if payload.scene_id is not None and local_overrides.scene_prompts.get(
            payload.scene_id
        ):
            inputs["positive_prompt"] = local_overrides.scene_prompts[payload.scene_id]
            input_origins["positive_prompt"] = "scene"
        if payload.shot_id is not None and local_overrides.shot_prompts.get(
            payload.shot_id
        ):
            inputs["positive_prompt"] = local_overrides.shot_prompts[payload.shot_id]
            input_origins["positive_prompt"] = "shot"
    if not payload.use_inherited_defaults:
        for name, value in payload.inputs.items():
            inputs[name] = value
            input_origins[name] = "runtime"

    return (
        payload.model_copy(update={"recipe_id": recipe.id, "inputs": inputs}),
        recipe,
        recipe_origin,
        input_origins,
        preferences,
    )


async def _validate_project_context(
    session: AsyncSession, project_id: str | None
) -> None:
    """生成先Projectが存在し、利用可能な状態であることを確かめる。"""
    if project_id is None:
        return
    project = await session.get(Project, project_id)
    if project is None or project.lifecycle == "trashed":
        raise ApiError(
            "PROJECT_NOT_FOUND",
            "生成先Projectがありません。",
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            details={"project_id": project_id},
        )
    if project.lifecycle != "active":
        raise ApiError(
            "PROJECT_NOT_ACTIVE",
            "アーカイブ中のProjectには生成できません。",
            status_code=status.HTTP_409_CONFLICT,
            details={"project_id": project_id, "lifecycle": project.lifecycle},
        )


def _snapshot_entry(
    project: Project | None, group: str, key: str
) -> dict[str, Any] | None:
    if project is None or not isinstance(project.source_snapshot, dict):
        return None
    values = project.source_snapshot.get(group)
    if not isinstance(values, dict):
        return None
    value = values.get(key)
    return value if isinstance(value, dict) else None


async def _external_scene(
    source: ReferenceSource, project: Project | None, external_id: str, scene_id: str
) -> dict[str, Any]:
    try:
        return await source.get_scene(external_id, scene_id)
    except AiMediaUnavailable:
        cached = _snapshot_entry(project, "scene_envelopes", scene_id)
        if cached is not None:
            return cached
        raise


async def _external_shot(
    source: ReferenceSource,
    project: Project | None,
    external_id: str,
    scene_id: str,
    shot_id: str,
) -> dict[str, Any]:
    try:
        return await source.get_shot(external_id, scene_id, shot_id)
    except AiMediaUnavailable:
        cached = _snapshot_entry(project, "shot_envelopes", shot_id)
        if cached is not None:
            return cached
        raise


async def _external_shots(
    source: ReferenceSource, project: Project | None, external_id: str, scene_id: str
) -> dict[str, Any]:
    try:
        return await source.list_shots(external_id, scene_id)
    except AiMediaUnavailable:
        cached = _snapshot_entry(project, "shots", scene_id)
        if cached is not None:
            return cached
        raise


async def _external_canon(
    source: ReferenceSource, project: Project | None, external_id: str, canon_id: str
) -> dict[str, Any]:
    try:
        return await source.get_canon(external_id, canon_id)
    except AiMediaUnavailable:
        if project is not None and isinstance(project.source_snapshot, dict):
            canon = project.source_snapshot.get("canon")
            items = canon.get("items") if isinstance(canon, dict) else None
            if isinstance(items, list):
                for item in items:
                    if isinstance(item, dict) and item.get("canon_id") == canon_id:
                        return item
        raise


async def _resolve_references(
    session: AsyncSession,
    source: ReferenceSource,
    project_id: str | None,
    scene_id: str | None,
    shot_id: str | None,
) -> _ResolvedReferences:
    """指定されたScene/Shotを参照APIから取得し、不変参照を固定する。

    Canon参照を解決できないままJobを作ると、どのCanonで生成したか後から説明できない
    履歴だけが残る。取得できない場合と応答から参照を取り出せない場合はJobを作らない。
    """
    scene_ref: dict[str, Any] = (
        {"project_id": project_id} if project_id is not None else {}
    )
    shot_ref: dict[str, Any] = {}
    scene_canon: list[dict[str, Any]] = []
    shot_canon: list[dict[str, Any]] = []
    scene_envelope: Any = None
    shot_envelope: Any = None

    try:
        project = await session.get(Project, project_id) if project_id is not None else None
        if project_id is not None and project is None:
            raise ApiError(
                "PROJECT_NOT_FOUND",
                "Projectがありません。",
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                details={"project_id": project_id},
            )
        if project is not None and project.source_type == "local":
            if scene_id is not None:
                scene = await get_local_scene(session, project_id, scene_id)
                scene_envelope = await local_scene_envelope(session, scene)
            if shot_id is not None and scene_id is not None:
                shot_envelope = local_shot_envelope(
                    await get_local_shot(session, project_id, scene_id, shot_id)
                )
        else:
            external_id = (
                project.external_id
                if project is not None and project.external_id is not None
                else project_id
            )
            if scene_id is not None and external_id is not None:
                scene_envelope = await _external_scene(
                    source, project, external_id, scene_id
                )
            if shot_id is not None and scene_id is not None and external_id is not None:
                shot_envelope = await _external_shot(
                    source, project, external_id, scene_id, shot_id
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

    try:
        if scene_id is not None:
            resolved_scene_ref, scene_canon = provenance.resolve_envelope(
                provenance.KIND_SCENE, scene_id, scene_envelope
            )
            scene_ref = {**resolved_scene_ref, "project_id": project_id}
        if shot_id is not None:
            resolved_shot_ref, shot_canon = provenance.resolve_envelope(
                provenance.KIND_SHOT, shot_id, shot_envelope
            )
            shot_ref = {
                **resolved_shot_ref,
                "project_id": project_id,
                "scene_id": scene_id,
            }
    except provenance.ReferenceError as error:
        logger.warning("参照APIの応答から不変参照を取り出せません。", exc_info=error)
        raise ApiError(
            "REFERENCE_UNAVAILABLE",
            f"参照APIの応答から不変参照を取り出せませんでした: {error}",
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        ) from error

    return _ResolvedReferences(
        scene_ref=scene_ref,
        shot_ref=shot_ref,
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
    preferences: dict[str, Any] | None = None,
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
        assigned_project_id=payload.project_id,
        assigned_scene_id=payload.scene_id,
        assigned_shot_id=payload.shot_id,
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
        assigned_project_id=payload.project_id,
        assigned_scene_id=payload.scene_id,
        assigned_shot_id=payload.shot_id,
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
            **dict(prepared.parameters),
            **(
                {"production_preferences": preferences}
                if preferences
                else {}
            ),
        },
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
    project_id: str | None = None,
    scene_id: str | None = None,
    shot_id: str | None = None,
    unassigned: bool = False,
    limit: Annotated[int, Query(ge=1, le=200)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
):
    """キュー状態の確認用。既定はqueue_sequence昇順、指定した条件で絞り込む。

    `project_id`、`scene_id`、`shot_id`は現在の整理先と突き合わせる。`unassigned`は
    現在Projectに所属しないJobだけへ絞る。生成時参照とManifestは所属変更で変えない。
    """
    if unassigned and any(
        value is not None for value in (project_id, scene_id, shot_id)
    ):
        raise _validation_error(
            "unassignedとProjectコンテキストの絞り込みは同時に指定できません。"
        )
    query = select(GenerationJob).order_by(
        GenerationJob.queue_sequence.asc(), GenerationJob.id.asc()
    )
    if state is not None:
        query = query.where(GenerationJob.state == state)
    if project_id is not None:
        query = query.where(GenerationJob.assigned_project_id == project_id)
    if unassigned:
        query = query.where(GenerationJob.assigned_project_id.is_(None))
    if scene_id is not None:
        query = query.where(GenerationJob.assigned_scene_id == scene_id)
    if shot_id is not None:
        query = query.where(GenerationJob.assigned_shot_id == shot_id)
    result = await session.execute(query.limit(limit).offset(offset))
    return result.scalars().all()


@router.get("/generation-jobs/{job_id}", response_model=schemas.GenerationJobRead)
async def get_generation_job(job_id: str, session: SessionDep):
    return await _get_or_404(session, GenerationJob, "GenerationJob", job_id)


async def _validate_assignment_target(
    session: AsyncSession,
    source: ReferenceSource,
    target: schemas.AssignmentTarget,
) -> tuple[str | None, str | None, str | None]:
    if target.project_id is None:
        return None, None, None
    project = await session.get(Project, target.project_id)
    if project is None or project.lifecycle == "trashed":
        raise ApiError(
            "PROJECT_NOT_FOUND",
            "割当て先Projectがありません。",
            status_code=status.HTTP_404_NOT_FOUND,
            details={"project_id": target.project_id},
        )
    if project.lifecycle != "active":
        raise ApiError(
            "PROJECT_NOT_ACTIVE",
            "割当て先Projectはアクティブではありません。",
            status_code=status.HTTP_409_CONFLICT,
            details={"project_id": project.id, "lifecycle": project.lifecycle},
        )
    if target.scene_id is None:
        return project.id, None, None
    if project.source_type == "local":
        await get_local_scene(session, project.id, target.scene_id)
        if target.shot_id is not None:
            await get_local_shot(session, project.id, target.scene_id, target.shot_id)
    else:
        external_id = project.external_id or project.id
        try:
            await _external_scene(source, project, external_id, target.scene_id)
            if target.shot_id is not None:
                await _external_shot(
                    source, project, external_id, target.scene_id, target.shot_id
                )
        except AiMediaNotFound as error:
            raise ApiError(
                "REFERENCE_NOT_FOUND",
                str(error),
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                details=target.model_dump(),
            ) from error
        except AiMediaUnavailable as error:
            raise ApiError(
                "REFERENCE_UNAVAILABLE",
                "割当て先の外部Scene・Shotを確認できませんでした。",
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            ) from error
    return project.id, target.scene_id, target.shot_id


def _set_assignment(
    item: GenerationJob | Artifact,
    target: tuple[str | None, str | None, str | None],
) -> None:
    item.assigned_project_id, item.assigned_scene_id, item.assigned_shot_id = target


@router.patch(
    "/generation-jobs/{job_id}/assignment",
    response_model=schemas.GenerationJobRead,
)
async def update_job_assignment(
    job_id: str,
    payload: schemas.JobAssignmentUpdate,
    session: SessionDep,
    source: ReferenceSourceDep,
):
    """完了済みJobの現在所属を変更する。生成時参照とManifestは更新しない。"""
    job = await _get_or_404(session, GenerationJob, "GenerationJob", job_id)
    if job.state in ("queued", "running", "cancelling"):
        raise ApiError(
            "ACTIVE_JOB_ASSIGNMENT_CONFLICT",
            "待機中・実行中・取消中のJobは所属を変更できません。完了後に再実行してください。",
            status_code=status.HTTP_409_CONFLICT,
            details={"job_id": job.id, "state": job.state},
        )
    target = await _validate_assignment_target(session, source, payload)
    _set_assignment(job, target)
    if payload.include_artifacts:
        artifacts = await session.scalars(select(Artifact).where(Artifact.job_id == job.id))
        for artifact in artifacts:
            _set_assignment(artifact, target)
    await session.commit()
    return job


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
    job = await _get_or_404(session, GenerationJob, "GenerationJob", payload.job_id)
    artifact = Artifact(
        id=schemas.new_id(),
        created_at=schemas.now_iso(),
        decision="undecided",
        decision_at=None,
        assigned_project_id=job.assigned_project_id,
        assigned_scene_id=job.assigned_scene_id,
        assigned_shot_id=job.assigned_shot_id,
        **payload.model_dump(),
    )
    session.add(artifact)
    await _commit(session)
    return await _artifact_read(session, artifact)


@router.post("/artifacts/batch-operation", response_model=list[schemas.ArtifactRead])
async def operate_artifacts(
    payload: schemas.ArtifactBatchOperation,
    session: SessionDep,
    source: ReferenceSourceDep,
):
    """Artifactを一括整理する。copyは元Artifactを親に持つ新しい記録を作る。"""
    rows = list(
        await session.scalars(
            select(Artifact).where(Artifact.id.in_(payload.artifact_ids))
        )
    )
    if len(rows) != len(payload.artifact_ids):
        found = {row.id for row in rows}
        raise ApiError(
            "ARTIFACT_NOT_FOUND",
            "指定したArtifactの一部がありません。",
            status_code=status.HTTP_404_NOT_FOUND,
            details={
                "missing_ids": [
                    item for item in payload.artifact_ids if item not in found
                ]
            },
        )
    ordered = {row.id: row for row in rows}
    rows = [ordered[item] for item in payload.artifact_ids]
    target: tuple[str | None, str | None, str | None] | None = None
    if payload.operation in ("move", "copy"):
        target = await _validate_assignment_target(session, source, payload.target)
    elif payload.operation == "unassign":
        target = (None, None, None)

    affected: list[Artifact] = []
    if payload.operation in ("move", "unassign"):
        assert target is not None
        for artifact in rows:
            _set_assignment(artifact, target)
        affected = rows
    elif payload.operation == "copy":
        assert target is not None
        tag_rows = await session.execute(
            select(ArtifactTag.artifact_id, ArtifactTag.tag).where(
                ArtifactTag.artifact_id.in_(payload.artifact_ids)
            )
        )
        tags_by_id: dict[str, list[str]] = {}
        for artifact_id, tag in tag_rows:
            tags_by_id.setdefault(artifact_id, []).append(tag)
        now = schemas.now_iso()
        for original in rows:
            copied = Artifact(
                id=schemas.new_id(),
                job_id=original.job_id,
                kind=original.kind,
                relative_path=original.relative_path,
                sha256=original.sha256,
                byte_size=original.byte_size,
                media_type=original.media_type,
                availability=original.availability,
                parent_artifact_id=original.id,
                assigned_project_id=target[0],
                assigned_scene_id=target[1],
                assigned_shot_id=target[2],
                created_at=now,
                decision=original.decision,
                decision_at=original.decision_at,
            )
            session.add(copied)
            for tag in tags_by_id.get(original.id, []):
                session.add(
                    ArtifactTag(
                        id=schemas.new_id(),
                        artifact_id=copied.id,
                        tag=tag,
                        created_at=now,
                    )
                )
            affected.append(copied)
    else:
        existing = set(
            await session.scalars(
                select(ArtifactTag.artifact_id).where(
                    ArtifactTag.artifact_id.in_(payload.artifact_ids),
                    ArtifactTag.tag == payload.tag,
                )
            )
        )
        now = schemas.now_iso()
        for artifact in rows:
            if artifact.id not in existing:
                session.add(
                    ArtifactTag(
                        id=schemas.new_id(),
                        artifact_id=artifact.id,
                        tag=payload.tag,
                        created_at=now,
                    )
                )
        affected = rows
    await session.commit()
    return await _artifact_reads(session, affected)


def _artifact_filters(
    query: Select[tuple[Artifact]],
    *,
    project_id: str | None,
    scene_id: str | None,
    shot_id: str | None,
    unassigned: bool,
    job_id: str | None,
    kind: str | None,
    decision: str | None = None,
    availability: str | None = None,
    tags: list[str] | None = None,
) -> Select[tuple[Artifact]]:
    """Artifactの絞り込み条件を組み立てる。条件はすべてANDで重ねる。

    ProjectコンテキストはArtifactの現在の整理先と突き合わせる。
    `tags`を複数指定したときは、すべてのタグが付いたArtifactだけを返す。資産を絞り
    込む用途では和集合より積集合が要る。
    """
    if job_id is not None:
        query = query.where(Artifact.job_id == job_id)
    if (
        project_id is not None
        or scene_id is not None
        or shot_id is not None
        or unassigned
    ):
        if project_id is not None:
            query = query.where(Artifact.assigned_project_id == project_id)
        if unassigned:
            query = query.where(Artifact.assigned_project_id.is_(None))
        if scene_id is not None:
            query = query.where(Artifact.assigned_scene_id == scene_id)
        if shot_id is not None:
            query = query.where(Artifact.assigned_shot_id == shot_id)
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
    project_id: str | None = None,
    scene_id: str | None = None,
    shot_id: str | None = None,
    unassigned: bool = False,
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

    Projectコンテキストは現在の所属先と突き合わせる。`unassigned`は
    現在のProject所属を持たないArtifactだけへ絞る。
    Workflowスナップショットも記録として残すため、種別で絞りたい場合は`kind`を使う。

    `tag`は複数指定でき、すべてのタグが付いたArtifactだけを返す。`lineage_artifact_id`
    は`parent_artifact_id`、`lineage_job_id`は`parent_job_id`をそれぞれ祖先と子孫の
    両方向へ辿り、指定した資産の派生関係に属するものだけへ絞る。

    派生関係の探索を上限で打ち切った場合は`X-Lineage-Truncated: true`を返す。結果の
    件数だけでは、絞り込みの対象が全件だったのか途中で止めたのかが判らない。
    """
    if unassigned and any(
        value is not None for value in (project_id, scene_id, shot_id)
    ):
        raise _validation_error(
            "unassignedとProjectコンテキストの絞り込みは同時に指定できません。"
        )
    query = select(Artifact).order_by(Artifact.created_at.desc(), Artifact.id.asc())
    query = _artifact_filters(
        query,
        project_id=project_id,
        scene_id=scene_id,
        shot_id=shot_id,
        unassigned=unassigned,
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
    current, failure = await _current_references(
        session, source, job, manifest.input_refs
    )
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
    project_id: str | None = None,
    scene_id: str | None = None,
    shot_id: str | None = None,
    unassigned: bool = False,
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
    if unassigned and any(
        value is not None for value in (project_id, scene_id, shot_id)
    ):
        raise _validation_error(
            "unassignedとProjectコンテキストの絞り込みは同時に指定できません。"
        )
    query = select(Artifact).order_by(Artifact.created_at.desc(), Artifact.id.asc())
    query = _artifact_filters(
        query,
        project_id=project_id,
        scene_id=scene_id,
        shot_id=shot_id,
        unassigned=unassigned,
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
    job_findings: dict[str | None, list[schemas.ArtifactIntegrityFinding]] = {}
    found: list[tuple[Artifact, list[schemas.ArtifactIntegrityFinding]]] = []
    for artifact in candidates:
        if artifact.job_id not in job_findings:
            job_findings[artifact.job_id] = (
                [_integrity_finding("reference_broken", "移行したArtifactには作成元Jobがありません。")]
                if artifact.job_id is None
                else await _job_integrity_findings(
                    session,
                    source,
                    artifact.job_id,
                    canon_state=canon_state,
                )
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


def _reference_ids(job: GenerationJob) -> tuple[str | None, str | None, str | None]:
    """Jobに記録した参照IDを取り出す。

    参照を解決する前に作られたJobには`project_id`が無い。現在値を引けないため、
    推測で補わずに再実行不能として扱う。
    """
    scene_ref = job.scene_ref if isinstance(job.scene_ref, dict) else {}
    shot_ref = job.shot_ref if isinstance(job.shot_ref, dict) else {}
    project_id = scene_ref.get("project_id") or shot_ref.get("project_id")
    scene_id = scene_ref.get("id")
    shot_id = shot_ref.get("id")
    project_id = project_id if isinstance(project_id, str) else None
    scene_id = scene_id if isinstance(scene_id, str) else None
    shot_id = shot_id if isinstance(shot_id, str) else None
    if (scene_id is not None and project_id is None) or (
        shot_id is not None and scene_id is None
    ):
        raise ApiError(
            "REFERENCE_IDS_MISSING",
            "JobのProject、Scene、Shot参照IDに不足があります。",
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            details={"job_id": job.id},
        )
    return project_id, scene_id, shot_id


async def _current_references(
    session: AsyncSession,
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
        resolved = await _resolve_references(
            session, source, project_id, scene_id, shot_id
        )
        selected = (
            await _current_selected_canon(session, source, project_id, recorded or [])
            if project_id is not None
            else []
        )
    except ApiError as error:
        return None, error
    return [*resolved.input_refs([]), *selected], None


async def _current_selected_canon(
    session: AsyncSession,
    source: ReferenceSource,
    project_id: str,
    recorded: list[Any],
) -> list[dict[str, Any]]:
    """記録済みの`input_refs`にある、入力として選んだCanonを現在の参照で引き直す。

    参照元から消えたCanonは現在側に並べない。呼び出し元の突き合わせで`missing`に
    なり、再実行できないことが利用者へ伝わる。
    """
    project = await session.get(Project, project_id)
    if project is not None and project.source_type == "local":
        return []
    external_id = (
        project.external_id
        if project is not None and project.external_id is not None
        else project_id
    )
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
            descriptor = await _external_canon(
                source, project, external_id, canon_id
            )
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
    current, failure = await _current_references(
        session, source, job, manifest.input_refs
    )
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
            assigned_project_id=origin_job.assigned_project_id,
            assigned_scene_id=origin_job.assigned_scene_id,
            assigned_shot_id=origin_job.assigned_shot_id,
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
            assigned_project_id=origin_job.assigned_project_id,
            assigned_scene_id=origin_job.assigned_scene_id,
            assigned_shot_id=origin_job.assigned_shot_id,
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

    current, failure = await _current_references(
        session, source, job, manifest.input_refs
    )
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
    resolved = await _resolve_references(session, source, project_id, scene_id, shot_id)
    # 利用者素材のcache参照は参照APIで解決できないため、記録済みの値を引き継ぐ。
    cached = [
        dict(ref)
        for ref in (manifest.input_refs or [])
        if isinstance(ref, dict) and ref.get("kind") not in provenance.RESOLVABLE_KINDS
    ]
    # Scene/Shotが宣言していない、入力として選んだCanon(音声JobのVoice Canonなど)も
    # 現在の参照で引き直す。ここで拾わないと、派生Jobの履歴からどのCanonで生成したかが
    # 消える。
    selected = (
        await _current_selected_canon(
            session, source, project_id, manifest.input_refs or []
        )
        if project_id is not None
        else []
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


def get_agent_providers(request: Request) -> dict[str, AgentProvider]:
    return request.app.state.agent_providers


AgentProvidersDep = Annotated[dict[str, AgentProvider], Depends(get_agent_providers)]

#: 提案の入力へ載せる既存Artifactの取得上限。
AGENT_CONTEXT_ARTIFACT_LIMIT = 20


@router.get("/agent-providers", response_model=list[schemas.AgentProviderRead])
async def list_agent_providers(providers: AgentProvidersDep):
    """設定済みProviderを返す。接続先と認証情報は返さない。"""
    return [
        schemas.AgentProviderRead(
            id=provider.id, label=provider.label, available=await provider.available()
        )
        for provider in providers.values()
    ]


def _resolve_agent_provider(
    providers: dict[str, AgentProvider], provider_id: str | None
) -> AgentProvider:
    """要求されたProviderを選ぶ。未指定なら設定の既定Providerを使う。"""
    resolved_id = provider_id or get_settings().agent_provider
    provider = providers.get(resolved_id)
    if provider is None:
        raise ApiError(
            "AGENT_PROVIDER_NOT_FOUND",
            "指定されたProviderは利用できません。",
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            details={"provider_id": resolved_id},
        )
    return provider


async def _fetch_envelopes(
    session: AsyncSession,
    source: ReferenceSource,
    project_id: str,
    scene_id: str,
    shot_id: str | None,
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """提案の入力に使うScene/Shotを参照APIから取得する。

    提案はJobを作らないため不変参照までは固定しない。取得できないときは提案も作らない。
    現在の内容を読めないまま提案すると、どの内容に対する提案か後から説明できない。
    """
    try:
        project = await session.get(Project, project_id)
        if project is not None and project.source_type == "local":
            scene_envelope = await local_scene_envelope(
                session, await get_local_scene(session, project_id, scene_id)
            )
            shot_envelope = (
                local_shot_envelope(
                    await get_local_shot(session, project_id, scene_id, shot_id)
                )
                if shot_id is not None
                else None
            )
        else:
            external_id = (
                project.external_id
                if project is not None and project.external_id is not None
                else project_id
            )
            scene_envelope = await _external_scene(
                source, project, external_id, scene_id
            )
            shot_envelope = (
                await _external_shot(source, project, external_id, scene_id, shot_id)
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


async def _context_artifacts(session: AsyncSession, scene_id: str) -> list[Artifact]:
    """入力へ載せる既存Artifactを引く。Scene配下の完成済み画像だけを対象にする。"""
    jobs = select(GenerationJob.id).where(
        GenerationJob.assigned_scene_id == scene_id
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
    return list(result.scalars().all())


async def _fetch_shot_list(
    session: AsyncSession, source: ReferenceSource, project_id: str, scene_id: str
) -> list[dict[str, Any]]:
    """バッチ生成計画の入力に使うScene配下のShot一覧を参照APIから取得する。

    失敗の扱いはScene/Shotの取得と揃える。一覧を読めないまま提案すると、入力へ載せて
    いないShotを対象にした計画を許すことになる。
    """
    try:
        project = await session.get(Project, project_id)
        if project is not None and project.source_type == "local":
            await get_local_scene(session, project_id, scene_id)
            rows = await session.scalars(
                select(ProjectShot)
                .where(
                    ProjectShot.project_id == project_id,
                    ProjectShot.scene_id == scene_id,
                    ProjectShot.deleted_at.is_(None),
                )
                .order_by(ProjectShot.sequence, ProjectShot.id)
            )
            return [local_shot_summary(row) for row in rows]
        external_id = (
            project.external_id
            if project is not None and project.external_id is not None
            else project_id
        )
        document = await _external_shots(source, project, external_id, scene_id)
    except AiMediaNotFound as error:
        raise ApiError(
            "REFERENCE_NOT_FOUND",
            str(error),
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            details={"project_id": project_id, "scene_id": scene_id},
        ) from error
    except AiMediaUnavailable as error:
        logger.warning("ai-media参照APIを利用できません。", exc_info=error)
        raise ApiError(
            "REFERENCE_UNAVAILABLE",
            "ai-media参照APIを利用できませんでした。",
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        ) from error
    items = document.get("items")
    if not isinstance(items, list):
        return []
    return [item for item in items if isinstance(item, dict)]


async def _agent_context(
    session: AsyncSession,
    payload: schemas.AgentProposalCreate,
    recipe: Recipe | None,
    scene_envelope: dict[str, Any],
    shot_envelope: dict[str, Any] | None,
    shot_items: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Providerへ渡す入力コンテキストを許可リストで組み立てる。

    渡す項目は`proposals`側で列挙する。ここでは対象の取得だけを行い、参照APIの応答を
    そのまま流さない。秘密情報、環境変数、ローカル絶対パスは含めない。

    準備段階の提案は適用対象を出力へ含めるため、ここで載せた一覧が適用してよい対象の
    範囲になる。範囲外のIDは`proposals.restrict_output`で落とす。
    """
    context: dict[str, Any] = {
        "scene": proposals.scene_context(scene_envelope.get("data")),
    }
    if shot_envelope is not None:
        context["shot"] = proposals.shot_context(shot_envelope.get("data"))
    if recipe is not None:
        context["recipe"] = proposals.recipe_context(recipe)
    if payload.kind == "reference_candidates":
        context["artifacts"] = proposals.artifact_context(
            await _context_artifacts(session, payload.scene_id)
        )
    if payload.kind == "asset_organization_plan":
        artifacts = await _context_artifacts(session, payload.scene_id)
        tags = await _artifact_tag_map(session, [artifact.id for artifact in artifacts])
        context["artifacts"] = proposals.artifact_context(artifacts, tags)
    if payload.kind == "batch_generation_plan":
        context["shots"] = proposals.shot_list_context(shot_items)
    return context


def _context_shot_ids(context: dict[str, Any]) -> set[str]:
    """入力コンテキストへ載せたShot IDの集合。計画の対象を突き合わせるのに使う。"""
    entries = context.get("shots")
    if not isinstance(entries, list):
        return set()
    return {
        str(entry["id"])
        for entry in entries
        if isinstance(entry, dict) and entry.get("id")
    }


def _context_recipe_input_names(context: dict[str, Any]) -> set[str]:
    """基準Recipeが宣言した入力名の集合。Recipe案の`defaults`を絞るのに使う。"""
    recipe = context.get("recipe")
    if not isinstance(recipe, dict):
        return set()
    fields = recipe.get("inputs")
    if not isinstance(fields, list):
        return set()
    return {
        str(field_definition["name"])
        for field_definition in fields
        if isinstance(field_definition, dict) and field_definition.get("name")
    }


#: 操作を1件だけ持つ提案の種別。既存のApplication APIはこの種別だけを受け付ける。
SINGLE_OPERATION_KINDS = ("image_prompt",)


def _planned_operations(proposal: AgentProposal) -> list[dict[str, Any]]:
    """提案から、承認後に実行する操作を0件以上で組み立てる。

    提案の内容から毎回組み立て直す。承認時に記録したdigestと突き合わせるため、提案が
    差し替わればdigestも変わり、古い承認では実行できない。

    副作用のある操作へつながるのは`image_prompt`と準備段階の3種だけとする。Shot構成案、
    参照候補、Recipe案は表示だけで、ai-mediaへの書き込みは範囲外とする。
    """
    output = proposal.output
    if not isinstance(output, dict):
        return []
    if proposal.kind == "image_prompt":
        operation = _image_prompt_operation(proposal, output)
        return [] if operation is None else [operation]
    if proposal.kind == "batch_generation_plan":
        return _batch_generation_operations(proposal, output)
    if proposal.kind == "workflow_registration_draft":
        return _recipe_registration_operations(proposal, output)
    if proposal.kind == "asset_organization_plan":
        return _asset_organization_operations(proposal, output)
    return []


def _image_prompt_operation(
    proposal: AgentProposal, output: dict[str, Any]
) -> dict[str, Any] | None:
    """prompt案から投入するJob 1件を組み立てる。"""
    if proposal.recipe_id is None or proposal.shot_id is None:
        return None
    return _generation_job_operation(
        proposal,
        proposal.shot_id,
        output.get("positive_prompt"),
        output.get("negative_prompt", ""),
    )


def _generation_job_operation(
    proposal: AgentProposal,
    shot_id: str,
    positive_prompt: Any,
    negative_prompt: Any,
) -> dict[str, Any]:
    """生成Jobの投入操作。prompt案とバッチ計画で同じ形にする。"""
    return {
        "type": approvals.OPERATION_GENERATION_JOB_CREATE,
        "target": {
            "project_id": proposal.project_id,
            "scene_id": proposal.scene_id,
            "shot_id": shot_id,
            "recipe_id": proposal.recipe_id,
        },
        "payload": {
            "kind": "image",
            "inputs": {
                "positive_prompt": positive_prompt,
                "negative_prompt": negative_prompt,
            },
        },
    }


def _batch_generation_operations(
    proposal: AgentProposal, output: dict[str, Any]
) -> list[dict[str, Any]]:
    """バッチ生成計画から、Shotごとの投入操作を組み立てる。

    対象Shotは提案の作成時に入力へ載せた一覧へ制限済みとする。ここでは件数の上限だけ
    を改めて当て、長いキューを1回の承認で積ませない。
    """
    if proposal.recipe_id is None:
        return []
    items = output.get("items")
    if not isinstance(items, list):
        return []
    operations: list[dict[str, Any]] = []
    for item in items[: proposals.MAX_PLAN_STEPS]:
        if not isinstance(item, dict):
            continue
        shot_id = item.get("shot_id")
        if not isinstance(shot_id, str) or not shot_id:
            continue
        operations.append(
            _generation_job_operation(
                proposal,
                shot_id,
                item.get("positive_prompt"),
                item.get("negative_prompt", ""),
            )
        )
    return operations


def _recipe_registration_operations(
    proposal: AgentProposal, output: dict[str, Any]
) -> list[dict[str, Any]]:
    """Workflow登録案から、Recipe登録の操作を組み立てる。

    登録先のWorkflow版は基準Recipeから引き継ぐ。提案の出力はRecipeの名前と既定値だけ
    に使い、Workflowテンプレートの指定には使わない。実行できるWorkflowを提案の内容で
    増やさないためである。
    """
    if proposal.recipe_id is None:
        return []
    name = output.get("name")
    if not isinstance(name, str) or not name.strip():
        return []
    defaults = output.get("defaults")
    return [
        {
            "type": approvals.OPERATION_RECIPE_CREATE,
            "target": {
                "project_id": proposal.project_id,
                "scene_id": proposal.scene_id,
                "base_recipe_id": proposal.recipe_id,
            },
            "payload": {
                "name": name.strip(),
                "defaults": defaults if isinstance(defaults, dict) else {},
            },
        }
    ]


def _plan_tags(values: Any) -> list[str]:
    """計画が指定したタグを、保存できる値だけへ揃える。

    タグの書式はタグAPIと同じ検証を通す。通らない値は落とし、適用の直前で初めて
    弾かれる形にしない。
    """
    if not isinstance(values, list):
        return []
    tags: list[str] = []
    for value in values[: proposals.MAX_PLAN_TAGS]:
        if not isinstance(value, str):
            continue
        try:
            tag = schemas.normalize_tag(value)
        except ValueError:
            continue
        if tag not in tags:
            tags.append(tag)
    return tags


def _plan_destination_dir(value: Any) -> str:
    """計画が指定した移動先を、操作へ載せられる形へ揃える。

    ここでは空かどうかと長さだけを見る。上限を超える値は`_plan_tags`と同じく黙って
    捨てる。保存できない値であり、履歴へ残す意味がないためである。

    一方で`artifacts/`配下かどうかの判定は`storage.move_artifact`で行い、範囲外の指定
    は適用の失敗として履歴へ残す。範囲外は「保存できない値」ではなく利用者が確かめる
    べき指定であり、組み立ての時点で落とすと拒否した事実がどこにも残らない。
    """
    if not isinstance(value, str):
        return ""
    destination = value.strip()
    if len(destination) > proposals.MAX_PLAN_DESTINATION_LENGTH:
        logger.info(
            "移動先が長すぎるため移動stepを作りません。length=%d", len(destination)
        )
        return ""
    return destination


def _asset_organization_operations(
    proposal: AgentProposal, output: dict[str, Any]
) -> list[dict[str, Any]]:
    """資産整理案から、Artifactごとのタグ更新とファイル移動の操作を組み立てる。

    付与と除去に同じタグが並んだ場合は付与を残す。順序で結果が変わる指定を、実行する
    側の順番任せにしない。付けるものも外すものも無く、移動先も無いstepは操作にしない。

    1件のitemはタグ更新と移動の最大2操作になる。同一item内はタグ更新を先に固定する。
    stepの並びが変わるとdigestの突き合わせが成り立たないためである。

    操作の総数は`MAX_PLAN_STEPS`で止める。1件のitemから作る操作は分割せず、入り切ら
    なければそのitemごと落とす。タグだけ適用して移動を落とす形にしない。入り切らない
    itemがあっても後続は見る。1操作だけのitemなら収まることがあるためである。
    """
    items = output.get("items")
    if not isinstance(items, list):
        return []
    operations: list[dict[str, Any]] = []
    for item in items[: proposals.MAX_PLAN_STEPS]:
        if not isinstance(item, dict):
            continue
        artifact_id = item.get("artifact_id")
        if not isinstance(artifact_id, str) or not artifact_id:
            continue
        add_tags = _plan_tags(item.get("add_tags"))
        remove_tags = [
            tag for tag in _plan_tags(item.get("remove_tags")) if tag not in add_tags
        ]
        destination_dir = _plan_destination_dir(item.get("destination_dir"))
        planned: list[dict[str, Any]] = []
        if add_tags or remove_tags:
            planned.append(
                {
                    "type": approvals.OPERATION_ARTIFACT_TAG_UPDATE,
                    "target": {"artifact_id": artifact_id},
                    "payload": {"add_tags": add_tags, "remove_tags": remove_tags},
                }
            )
        if destination_dir:
            # 移動元の実パスは載せない。ここでDBを引くと提案一覧の取得が提案件数分の
            # 追加クエリになる。実パスは適用時に解決し、結果を履歴へ残す。
            planned.append(
                {
                    "type": approvals.OPERATION_FILE_MOVE,
                    "target": {"artifact_id": artifact_id},
                    "payload": {"destination_dir": destination_dir},
                }
            )
        if not planned:
            continue
        if len(operations) + len(planned) > proposals.MAX_PLAN_STEPS:
            logger.info(
                "操作の上限を超えるitemを落とします。artifact_id=%s", artifact_id
            )
            continue
        operations.extend(planned)
    return operations


def _approval_subject(
    proposal: AgentProposal, operations: list[dict[str, Any]]
) -> dict[str, Any]:
    """承認記録へ残し、適用時に突き合わせる対象を返す。

    単一操作の提案は操作そのものを対象にする。既存の`image_prompt`の承認記録と
    digestの計算を変えないためである。複数操作を持つ提案は計画全体を対象にし、step
    が1件でも入れ替われば全体のdigestが変わるようにする。
    """
    if proposal.kind in SINGLE_OPERATION_KINDS:
        return operations[0]
    return {"operations": operations}


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


def _planned_operation_read(operation: dict[str, Any]) -> schemas.PlannedOperation:
    return schemas.PlannedOperation(
        type=operation["type"],
        effect=approvals.effect_of(operation["type"]),
        target=operation["target"],
        payload=operation["payload"],
        digest=approvals.operation_digest(operation),
    )


def _proposal_read(proposal: AgentProposal) -> schemas.AgentProposalRead:
    """提案の応答。適用予定の操作とそのdigestを一緒に返す。

    画面は対象と内容をこの値で表示し、同じdigestの承認だけが実行へ進む。複数操作を
    持つ提案は`planned_operations`で返し、単一操作の提案だけが従来どおり
    `planned_operation`にも入る。
    """
    read = schemas.AgentProposalRead.model_validate(proposal)
    operations = [
        _planned_operation_read(operation)
        for operation in _planned_operations(proposal)
    ]
    if not operations:
        return read
    return read.model_copy(
        update={
            "planned_operation": (
                operations[0] if proposal.kind in SINGLE_OPERATION_KINDS else None
            ),
            "planned_operations": operations,
        }
    )


def _validate_agent_recipe(recipe: Recipe, kind: str) -> None:
    """承認後にJobを作れるRecipeかを、提案を取る前に確かめる。

    バッチ生成計画も投入するのは画像のJobのため、prompt案と同じRecipeを求める。
    Workflow登録案は登録するRecipeの基準にするだけで、Jobを作らないため種別を問わない。
    """
    if kind not in ("image_prompt", "batch_generation_plan"):
        return
    if recipe.kind != "image" or recipe.engine != ENGINE_COMFYUI:
        raise _validation_error(
            f"{kind}の提案には画像生成のRecipeを指定してください。",
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
    providers: AgentProvidersDep,
):
    """提案を取得して履歴へ残す。生成Jobは作らない。

    提案の取得は副作用を持たない操作として承認を求めない。ここで作るのは提案の記録
    だけで、Job、Artifact、Manifestには触れない。

    Providerが失敗した場合も提案を`failed`として残し、他の機能は止めない。
    """
    provider = _resolve_agent_provider(providers, payload.provider_id)
    recipe: Recipe | None = None
    if payload.recipe_id is not None:
        recipe = await _get_or_404(session, Recipe, "Recipe", payload.recipe_id)
        _validate_agent_recipe(recipe, payload.kind)
    scene_envelope, shot_envelope = await _fetch_envelopes(
        session, source, payload.project_id, payload.scene_id, payload.shot_id
    )
    shot_items = (
        await _fetch_shot_list(session, source, payload.project_id, payload.scene_id)
        if payload.kind == "batch_generation_plan"
        else None
    )
    context = await _agent_context(
        session, payload, recipe, scene_envelope, shot_envelope, shot_items
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
    proposal.output = proposals.restrict_output(
        payload.kind,
        result.output,
        artifact_ids=_context_artifact_ids(context),
        shot_ids=_context_shot_ids(context),
        recipe_input_names=_context_recipe_input_names(context),
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
    operations = _planned_operations(proposal)
    if payload.decision == "approved":
        if not operations:
            raise _validation_error(
                "この提案は副作用のある操作を伴わないため、承認の対象になりません。",
                {"kind": proposal.kind},
            )
        try:
            for operation in operations:
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
            approvals.requested_operation(_approval_subject(proposal, operations))
            if operations
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
    if proposal.kind not in SINGLE_OPERATION_KINDS:
        raise ApiError(
            "PROPOSAL_REQUIRES_APPLICATIONS",
            "この提案は複数の操作を持つため、applicationsへ適用を要求してください。",
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            details={
                "kind": proposal.kind,
                "endpoint": f"/agent-proposals/{proposal_id}/applications",
            },
        )
    operations = _planned_operations(proposal)
    if not operations:
        raise _validation_error(
            "この提案には実行できる操作がありません。", {"kind": proposal.kind}
        )
    operation = operations[0]
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


async def _load_applications(
    session: AsyncSession, proposal_id: str
) -> list[AgentProposalApplication]:
    """提案の適用状態をstepの順に引く。"""
    result = await session.execute(
        select(AgentProposalApplication)
        .where(AgentProposalApplication.proposal_id == proposal_id)
        .order_by(AgentProposalApplication.step_index.asc())
    )
    return list(result.scalars().all())


async def _ensure_application_rows(
    session: AsyncSession, proposal: AgentProposal, operations: list[dict[str, Any]]
) -> dict[int, AgentProposalApplication]:
    """未作成のstepへ`pending`の行を足し、step番号から引ける形で返す。

    行は承認時ではなく最初の適用要求で作る。同じ提案へ適用要求が同時に届いても、
    `(proposal_id, step_index)`の一意制約で片方だけが行を作り、もう片方は作られた行を
    読み直す。
    """
    existing = {
        row.step_index: row for row in await _load_applications(session, proposal.id)
    }
    missing = [index for index in range(len(operations)) if index not in existing]
    if missing:
        now = schemas.now_iso()
        for index in missing:
            operation = operations[index]
            session.add(
                AgentProposalApplication(
                    id=schemas.new_id(),
                    proposal_id=proposal.id,
                    step_index=index,
                    operation_type=operation["type"],
                    operation_digest=approvals.operation_digest(operation),
                    target=operation["target"],
                    state="pending",
                    applied_ref_type=None,
                    applied_ref_id=None,
                    failure_code=None,
                    failure_message=None,
                    created_at=now,
                    updated_at=now,
                )
            )
        try:
            await session.commit()
        except IntegrityError:
            await session.rollback()
    return {
        row.step_index: row for row in await _load_applications(session, proposal.id)
    }


async def _claim_application(session: AsyncSession, application_id: str) -> bool:
    """stepを実行中として占有する。占有できた要求だけが実行へ進む。

    同じstepへ適用要求が同時に届くのは、応答待ちの再送や画面の重複操作で普通に起こる。
    行を読んでから実行するだけでは、両方が`pending`を見て非冪等な操作を二重に実行
    できてしまう。`pending`か`failed`からの条件付き更新で占有し、更新できた側だけが
    実行する。
    """
    claimed = await session.execute(
        update(AgentProposalApplication)
        .where(AgentProposalApplication.id == application_id)
        .where(AgentProposalApplication.state.in_(("pending", "failed")))
        .values(state="applying", updated_at=schemas.now_iso())
    )
    await session.commit()
    return claimed.rowcount == 1


async def _finalize_application(
    session: AsyncSession, application_id: str, **values: Any
) -> None:
    """stepの適用結果を残す。実行済みの副作用を辿れる形にしてから次へ進む。

    更新は占有した`applying`からに限る。条件を付けずに書くと、先に成功して`applied`
    で確定した行を、後から来た要求の失敗で`failed`へ塗り替えてしまう。
    """
    await session.execute(
        update(AgentProposalApplication)
        .where(AgentProposalApplication.id == application_id)
        .where(AgentProposalApplication.state == "applying")
        .values(updated_at=schemas.now_iso(), **values)
    )
    await session.commit()


async def _apply_recipe_registration(
    session: AsyncSession, operation: dict[str, Any]
) -> str:
    """Workflow登録案のstepを適用し、登録したRecipeのIDを返す。

    Workflowの参照と入力の宣言は基準Recipeから引き継ぎ、提案が決めるのは名前と既定値
    だけとする。既定値も基準Recipeが宣言した入力に限る。提案の内容で実行できる
    Workflowテンプレートを増やさないためである。

    承認のdigestは提案が決める名前と既定値を対象にする。基準Recipeの内容は承認後に
    変わらない前提に立っている。Recipeは作成後に書き換えず、変更は後継Recipeの作成で
    表す設計のためである。Recipeへ更新経路を足す場合は、基準Recipeの内容もdigestへ
    含める必要がある。
    """
    base = await _get_or_404(
        session, Recipe, "Recipe", operation["target"]["base_recipe_id"]
    )
    declared = set(base.input_schema) if isinstance(base.input_schema, dict) else set()
    defaults = dict(base.defaults) if isinstance(base.defaults, dict) else {}
    proposed = operation["payload"].get("defaults")
    for name, value in (proposed if isinstance(proposed, dict) else {}).items():
        if name in declared:
            defaults[name] = value
    recipe = await create_recipe(
        payload=schemas.RecipeCreate(
            name=operation["payload"]["name"],
            kind=base.kind,
            engine=base.engine,
            workflow_template_ref=base.workflow_template_ref,
            input_schema=base.input_schema,
            defaults=defaults,
            workflow_version_id=base.workflow_version_id,
            supersedes_recipe_id=None,
        ),
        session=session,
    )
    return recipe.id


async def _apply_artifact_tag_update(
    session: AsyncSession, operation: dict[str, Any]
) -> str:
    """資産整理案のstepを適用し、対象ArtifactのIDを返す。

    付いていないタグの除去と、付いているタグの付与は成功として扱う。狙いどおりの
    状態になっていることが結果であり、再実行でstepが失敗し続ける形にしない。
    """
    artifact_id = operation["target"]["artifact_id"]
    await _get_or_404(session, Artifact, "Artifact", artifact_id)
    payload = operation["payload"]
    for tag in payload.get("remove_tags", []):
        entry = await _find_artifact_tag(session, artifact_id, tag)
        if entry is not None:
            await session.delete(entry)
    for tag in payload.get("add_tags", []):
        if await _find_artifact_tag(session, artifact_id, tag) is None:
            session.add(
                ArtifactTag(
                    id=schemas.new_id(),
                    artifact_id=artifact_id,
                    tag=tag,
                    created_at=schemas.now_iso(),
                )
            )
    await _commit(session)
    return artifact_id


async def _apply_file_move(
    session: AsyncSession, operation: dict[str, Any]
) -> tuple[str, dict[str, str]]:
    """資産整理案の移動stepを適用し、対象ArtifactのIDと移動の結果を返す。

    移動元は提案ではなくDBの`relative_path`から引く。Providerの出力を移動元として
    信用すると、Artifact storeの任意のファイルを動かせてしまう。

    パスの検証は`storage.move_artifact`へ任せる。範囲外の指定は`ApiError`へ変換し、
    stepの失敗として理由を履歴へ残す。

    ファイルを動かしてからDBを更新し、更新に失敗した場合は元の場所へ戻す。逆順にする
    と、DBだけが移動後を指す状態が残る。

    移動とDBの更新の間でプロセスが落ちた場合は戻す処理まで到達しない。その場合だけ、
    再実行時に移動先の実ファイルを`storage.adopt_moved_artifact`で拾い、DBの追従だけ
    を済ませる。移動元が消えたまま失敗し続ける状態を残さないためである。
    """
    artifact_id = operation["target"]["artifact_id"]
    artifact = await _get_or_404(session, Artifact, "Artifact", artifact_id)
    from_path = artifact.relative_path
    destination_dir = operation["payload"]["destination_dir"]
    try:
        to_path = storage.move_artifact(from_path, destination_dir)
    except storage.StorageError as error:
        adopted = storage.adopt_moved_artifact(
            from_path, destination_dir, artifact.sha256
        )
        if adopted is None:
            raise ApiError(
                "ARTIFACT_MOVE_REJECTED",
                str(error),
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                details={
                    "artifact_id": artifact_id,
                    "destination_dir": destination_dir,
                },
            ) from error
        logger.info(
            "移動済みの実ファイルを拾ってDBを追従させます。artifact_id=%s from=%s to=%s",
            artifact_id,
            from_path,
            adopted,
        )
        to_path = adopted
    result = {"from_path": from_path, "to_path": to_path}
    if to_path == from_path:
        # 既に移動先にある。狙いどおりの状態のため、DBも書き換えずに成功とする。
        return artifact_id, result
    artifact.relative_path = to_path
    try:
        await _commit(session)
    except (ApiError, SQLAlchemyError) as error:
        await session.rollback()
        restored = True
        try:
            storage.move_artifact(to_path, storage.artifact_destination_dir(from_path))
        except storage.StorageError:
            restored = False
            logger.exception(
                "移動したArtifactを戻せません。artifact_id=%s from=%s to=%s",
                artifact_id,
                from_path,
                to_path,
            )
        # 戻せた場合と戻せなかった場合で、次にすべきことが変わる。戻せなかったときは
        # 実ファイルの居場所を失敗の記録へ残し、手当ての対象が分かるようにする。
        raise ApiError(
            "ARTIFACT_MOVE_NOT_RECORDED",
            (
                "Artifactの移動を記録できません。移動は取り消しました。"
                if restored
                else "Artifactの移動を記録できず、実ファイルを戻せませんでした。"
                "移動先のファイルを確認してください。"
            ),
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            details={
                "artifact_id": artifact_id,
                "from_path": from_path,
                "to_path": to_path,
                "restored": restored,
            },
        ) from error
    return artifact_id, result


async def _execute_application(
    session: AsyncSession,
    source: ReferenceSource,
    operation: dict[str, Any],
) -> tuple[str, str, dict[str, Any] | None]:
    """1stepを実行し、適用先の種別とID、実行の結果を返す。

    実行は既存の経路をそのまま使う。承認と履歴の形を揃えるために、ここへJob作成や
    Recipe登録の別実装を置かない。

    結果は適用先のIDだけでは足りない操作のためにある。`file.move`が実際に動かした
    移動元・移動先を返し、他の操作種別は`None`を返す。
    """
    operation_type = operation["type"]
    if operation_type == approvals.OPERATION_GENERATION_JOB_CREATE:
        target = operation["target"]
        job = await create_generation_job(
            payload=schemas.GenerationJobCreate(
                kind="image",
                project_id=target["project_id"],
                scene_id=target["scene_id"],
                shot_id=target["shot_id"],
                recipe_id=target["recipe_id"],
                inputs=operation["payload"]["inputs"],
            ),
            session=session,
            source=source,
        )
        return "generation_job", job.id, None
    if operation_type == approvals.OPERATION_RECIPE_CREATE:
        return "recipe", await _apply_recipe_registration(session, operation), None
    if operation_type == approvals.OPERATION_ARTIFACT_TAG_UPDATE:
        return (
            "artifact_tag",
            await _apply_artifact_tag_update(session, operation),
            None,
        )
    if operation_type == approvals.OPERATION_FILE_MOVE:
        artifact_id, result = await _apply_file_move(session, operation)
        return "artifact_file", artifact_id, result
    # 許可リストの確認を通った種別だけがここへ来る。実装の取りこぼしを実行時に握り
    # つぶさず、許可リストと実装の食い違いとして落とす。
    raise approvals.OperationNotAllowed(
        f"適用の実装がない操作種別です: {operation_type}"
    )


async def _sync_proposal_state(
    session: AsyncSession,
    proposal_id: str,
    applications: list[AgentProposalApplication],
) -> None:
    """全stepが適用済みになったときだけ提案を`applied`へ進める。

    一部が失敗している間は`approved`のまま残す。失敗したstepだけを承認のやり直し
    なしで再実行できるようにするためである。
    """
    if not applications or any(row.state != "applied" for row in applications):
        return
    await session.execute(
        update(AgentProposal)
        .where(AgentProposal.id == proposal_id)
        .where(AgentProposal.state == "approved")
        .values(state="applied")
    )
    await session.commit()


def _single_operation_error(proposal: AgentProposal) -> ApiError:
    return ApiError(
        "PROPOSAL_SINGLE_OPERATION",
        "この提案は単一の操作を持つため、applyへ適用を要求してください。",
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        details={
            "kind": proposal.kind,
            "endpoint": f"/agent-proposals/{proposal.id}/apply",
        },
    )


@router.post(
    "/agent-proposals/{proposal_id}/applications",
    response_model=list[schemas.AgentProposalApplicationRead],
)
async def apply_agent_proposal_steps(
    proposal_id: str,
    session: SessionDep,
    source: ReferenceSourceDep,
    payload: schemas.AgentProposalApplyRequest | None = None,
):
    """承認済みの計画をstep単位で適用する。

    突き合わせは計画全体のdigestとstepごとのdigestの両方で行う。承認したあとに提案や
    対象が変われば、どちらかが必ず食い違って実行しない。

    1stepが失敗した時点で打ち切り、成功済みのstepは`applied`のまま残す。失敗したstep
    だけを`step_indexes`で指定して再実行できる。適用済みのstepは指定しても実行し直さ
    ない。
    """
    request = payload or schemas.AgentProposalApplyRequest()
    proposal = await _get_or_404(session, AgentProposal, "Agent提案", proposal_id)
    if proposal.kind in SINGLE_OPERATION_KINDS:
        raise _single_operation_error(proposal)
    operations = _planned_operations(proposal)
    if not operations:
        raise _validation_error(
            "この提案には実行できる操作がありません。", {"kind": proposal.kind}
        )
    try:
        for operation in operations:
            approvals.require_executable(operation["type"])
    except approvals.OperationNotAllowed as error:
        # 拒否の理由はApprovalLogではなくログへ残す。ApprovalLogは判断の追記専用で、
        # 実行を断った記録の置き場ではない。
        logger.warning(
            "許可していない操作種別のため適用しません。proposal_id=%s error=%s",
            proposal_id,
            error,
        )
        raise _operation_not_allowed(error) from error
    if proposal.state != "approved":
        logger.warning(
            "承認済みでない提案への適用要求です。proposal_id=%s state=%s",
            proposal_id,
            proposal.state,
        )
        raise ApiError(
            "PROPOSAL_NOT_APPROVED",
            "承認済みの提案ではありません。",
            status_code=status.HTTP_409_CONFLICT,
            details={"state": proposal.state},
        )
    record = await _latest_approval(session, proposal.id)
    try:
        approvals.verify(
            record,
            _approval_subject(proposal, operations),
            now=schemas.now_iso(),
            subject_id=proposal.id,
        )
    except approvals.ApprovalInvalid as error:
        raise ApiError(
            error.code, str(error), status_code=status.HTTP_409_CONFLICT
        ) from error
    rows = await _ensure_application_rows(session, proposal, operations)
    step_indexes = _resolve_step_indexes(request.step_indexes, operations, rows)
    for index in step_indexes:
        row = rows[index]
        operation = operations[index]
        if row.state == "applied":
            continue
        # 計画全体のdigestを突き合わせた後でも、行を作った時点の内容と食い違う場合が
        # ある。承認記録を経ずに提案の出力が書き換わった場合が該当する。
        if row.operation_digest != approvals.operation_digest(operation):
            raise ApiError(
                "APPROVAL_STALE",
                "承認した操作の内容と一致しません。承認を取り直してください。",
                status_code=status.HTTP_409_CONFLICT,
                details={"step_index": index},
            )
        application_id = row.id
        if not await _claim_application(session, application_id):
            # 同じstepを別の要求が処理している。実行も結果の書き換えもしない。
            logger.info(
                "適用中のstepのため処理しません。proposal_id=%s step_index=%s",
                proposal_id,
                index,
            )
            continue
        try:
            ref_type, ref_id, result = await _execute_application(
                session, source, operation
            )
        except (ApiError, approvals.OperationNotAllowed) as error:
            # 失敗したstepだけを記録して打ち切る。後続を続けると、失敗の原因が共通
            # している場合に同じ失敗を残りのstep分だけ積み増すことになる。
            await session.rollback()
            code = (
                error.code if isinstance(error, ApiError) else "OPERATION_NOT_ALLOWED"
            )
            try:
                await _finalize_application(
                    session,
                    application_id,
                    state="failed",
                    failure_code=code,
                    failure_message=str(error)[:500],
                )
            except SQLAlchemyError:
                # 失敗の記録にも失敗した。操作は実行していないため副作用は無い。行は
                # 占有されたまま残り、次回起動のリカバリが中断として倒す。
                logger.exception(
                    "適用の失敗を記録できません。proposal_id=%s step_index=%s",
                    proposal_id,
                    index,
                )
                await session.rollback()
            break
        except Exception:
            # 想定外の失敗でも占有を残さない。残すと同じstepを再実行できなくなる。
            # 原因は握りつぶさず、記録を失敗へ倒してからそのまま外へ出す。
            logger.exception(
                "提案の適用で想定外のエラーが発生しました。proposal_id=%s step_index=%s",
                proposal_id,
                index,
            )
            await session.rollback()
            try:
                await _finalize_application(
                    session,
                    application_id,
                    state="failed",
                    failure_code="APPLICATION_FAILED",
                    failure_message="適用中に想定外のエラーが発生しました。",
                )
            except SQLAlchemyError:
                # 記録にも失敗した場合。元の失敗を隠さないよう記録だけ残して外へ出す。
                logger.exception(
                    "適用の失敗を記録できません。proposal_id=%s step_index=%s",
                    proposal_id,
                    index,
                )
                await session.rollback()
            raise
        try:
            await _finalize_application(
                session,
                application_id,
                state="applied",
                applied_ref_type=ref_type,
                applied_ref_id=ref_id,
                result=result,
                failure_code=None,
                failure_message=None,
            )
        except SQLAlchemyError:
            # 操作は成功していて、記録だけが残せなかった。失敗として倒すと、実行済みの
            # 副作用を辿れないまま再実行を促すことになる。別のセッションで書き直す。
            logger.exception(
                "適用したstepを記録できません。proposal_id=%s step_index=%s ref=%s:%s",
                proposal_id,
                index,
                ref_type,
                ref_id,
            )
            await session.rollback()
            await _relink_application(application_id, ref_type, ref_id, result)
    applications = await _load_applications(session, proposal_id)
    await _sync_proposal_state(session, proposal_id, applications)
    return applications


async def _relink_application(
    application_id: str,
    ref_type: str,
    ref_id: str,
    result: dict[str, Any] | None = None,
) -> None:
    """適用済みのstepへ結果を後から書く。応答を組み立てられなかった経路から使う。

    呼び出し元のセッションは書けない状態のため、別のセッションで書く。ここでも失敗
    した場合は占有が残り、次回起動時のリカバリが中断として倒す。倒れた行は自動再実行
    の対象にならないため、実行済みの副作用を重ねて作ることはない。
    """
    try:
        async with get_session_factory()() as session:
            await _finalize_application(
                session,
                application_id,
                state="applied",
                applied_ref_type=ref_type,
                applied_ref_id=ref_id,
                result=result,
                failure_code=None,
                failure_message=None,
            )
    except SQLAlchemyError:
        logger.warning(
            "適用したstepの記録を書き直せません。application_id=%s ref=%s:%s",
            application_id,
            ref_type,
            ref_id,
        )


def _resolve_step_indexes(
    requested: list[int] | None,
    operations: list[dict[str, Any]],
    rows: dict[int, AgentProposalApplication],
) -> list[int]:
    """処理するstepを決める。省略時は未適用のstepを順に処理する。

    中断で倒したstepは省略時の対象から外す。適用の途中でプロセスが落ちた場合、実行
    済みかどうかはこちらで判定できない。まとめて再実行すると、既に投入したJobや登録
    したRecipeを重ねて作りうる。利用者が適用先の有無を確かめ、`step_indexes`で明示
    したときだけ再実行する。
    """
    if requested is None:
        return [
            index
            for index in range(len(operations))
            if rows[index].state != "applied"
            and rows[index].failure_code != FAILURE_CODE_INTERRUPTED
        ]
    unknown = [index for index in requested if index >= len(operations)]
    if unknown:
        raise _validation_error(
            "計画に無いstepを指定しています。",
            {"step_indexes": unknown, "step_count": len(operations)},
        )
    return sorted(requested)


@router.get(
    "/agent-proposals/{proposal_id}/applications",
    response_model=list[schemas.AgentProposalApplicationRead],
)
async def list_agent_proposal_applications(proposal_id: str, session: SessionDep):
    """計画の適用状態を返す。投入したJobやRecipeはここから辿る。"""
    await _get_or_404(session, AgentProposal, "Agent提案", proposal_id)
    return await _load_applications(session, proposal_id)


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
