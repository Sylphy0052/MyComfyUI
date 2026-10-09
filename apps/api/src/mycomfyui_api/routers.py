import base64
import binascii
import copy
import hashlib
import json
import logging
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Annotated, Any, Literal, TypeVar, get_args
from urllib.parse import quote

from fastapi import APIRouter, Depends, Query, Request, Response
from fastapi.responses import FileResponse
from sqlalchemy import (
    ColumnElement,
    Select,
    String,
    delete,
    exists,
    func,
    or_,
    select,
    type_coerce,
    update,
)
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette import status
from starlette.concurrency import run_in_threadpool

from mycomfyui_api import (
    bootstrap,
    provenance,
    schemas,
    storage,
    story_links,
    story_voice,
)
from mycomfyui_api import workflows as workflow_registry
from mycomfyui_api.adapters import tag_preflight
from mycomfyui_api.adapters.agent import base as agent_base
from mycomfyui_api.adapters.agent import prompt_assets, prompt_retry, proposals
from mycomfyui_api.adapters.agent.base import AgentProvider
from mycomfyui_api.adapters.aimedia.client import (
    AiMediaNotFound,
    AiMediaUnavailable,
    ReferenceSource,
)
from mycomfyui_api.adapters.comfyui import workflow as comfyui_workflow
from mycomfyui_api.adapters.comfyui.client import ComfyUIError
from mycomfyui_api.adapters.comfyui.executor import ENGINE_COMFYUI
from mycomfyui_api.adapters.comfyui.factory import create_comfyui_client
from mycomfyui_api.adapters.comfyui.tagger import ComfyUITagger
from mycomfyui_api.adapters.image_tagger import ImageTaggerError, QwenTagRefiner
from mycomfyui_api.adapters.voice import audio as voice_audio
from mycomfyui_api.adapters.voice.base import VoiceError
from mycomfyui_api.adapters.voice.factory import create_voice_backend
from mycomfyui_api.app_settings import get_effective_settings
from mycomfyui_api.db import get_session
from mycomfyui_api.engines import AUTO_SEED, SUPPORTED_ENGINES, is_supported
from mycomfyui_api.engines import prepare as prepare_execution
from mycomfyui_api.engines import workflow_defaults as engine_workflow_defaults
from mycomfyui_api.errors import ApiError
from mycomfyui_api.events import job_events
from mycomfyui_api.execution import (
    PreparationContext,
    PreparationError,
    PreparedExecution,
)
from mycomfyui_api.job_progress import job_progress
from mycomfyui_api.models import (
    Artifact,
    ArtifactImport,
    ArtifactTag,
    Base,
    GenerationJob,
    GenerationManifest,
    LookProfile,
    MediaRoleTag,
    Project,
    Recipe,
    StoryCharacter,
    StorySceneAdoption,
    VoiceVerification,
    Workflow,
    WorkflowVersion,
)
from mycomfyui_api.queue import JobQueueWorker
from mycomfyui_api.references import get_reference_source
from mycomfyui_api.settings import get_settings
from mycomfyui_api.structure import (
    get_local_scene,
    get_local_shot,
    scene_envelope as local_scene_envelope,
    shot_envelope as local_shot_envelope,
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

#: 1回の一覧で除外できる種別の数。ArtifactKindの値の数を超えて受け取る理由は無い。
MAX_EXCLUDE_KINDS = len(get_args(schemas.ArtifactKind))

#: 整合性一覧で絞り込める理由の数。ArtifactIntegrityReasonの値の数を上限にする。
MAX_INTEGRITY_REASONS = len(get_args(schemas.ArtifactIntegrityReason))

#: 整合性一覧でhashを取り直すときの読み込み単位。
DIGEST_CHUNK_SIZE = 1024 * 1024

#: 派生関係の探索を上限で打ち切ったことを伝える応答ヘッダ。一覧の応答本体は
#: Artifactの配列のままにし、打ち切りの有無だけをヘッダで返す。
LINEAGE_TRUNCATED_HEADER = "X-Lineage-Truncated"

MIN_FREE_SPACE_AFTER_IMPORT = 512 * 1024 * 1024

# 異常なBackend応答をそのままブラウザへ増幅しない。通常のモデル在庫を十分収めつつ、
# 応答とselect要素が無制限に増えることを防ぐ。
MAX_MODEL_OPTIONS_PER_SLOT = 2000
MAX_MODEL_OPTION_LENGTH = 512
MODEL_INVENTORY_UNAVAILABLE = "ComfyUIのモデル在庫を取得できません。"
MAX_LOOK_PROFILES = 200


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


@router.get(
    "/workflow-versions/{workflow_version_id}/models",
    response_model=schemas.WorkflowModelOptionsRead,
)
async def get_workflow_model_options(workflow_version_id: str, session: SessionDep):
    """登録済みWorkflow版が宣言したmodel slotだけをComfyUIへ照会する。"""
    version = await _get_or_404(
        session, WorkflowVersion, "WorkflowVersion", workflow_version_id
    )
    raw_slots = version.model_slots if isinstance(version.model_slots, list) else []
    allowed_slots = workflow_registry.allowed_model_slots()
    declared: list[tuple[str, str, str]] = []
    for raw in raw_slots:
        if not isinstance(raw, dict):
            continue
        variable = raw.get("variable")
        node_class = raw.get("node_class")
        option_field = raw.get("option_field")
        if all(
            isinstance(value, str) and value
            for value in (variable, node_class, option_field)
        ) and (node_class, option_field) in allowed_slots:
            declared.append((variable, node_class, option_field))

    client = create_comfyui_client()
    slots: list[schemas.WorkflowModelSlotOptions] = []
    successful_queries = 0
    try:
        for variable, node_class, option_field in declared:
            try:
                raw_options = await client.available_options(node_class, option_field)
            except ComfyUIError as error:
                logger.info(
                    "ComfyUIのモデル在庫を取得できません。slot=%s",
                    variable,
                    exc_info=error,
                )
                slots.append(
                    schemas.WorkflowModelSlotOptions(
                        variable=variable,
                        node_class=node_class,
                        option_field=option_field,
                        reason=MODEL_INVENTORY_UNAVAILABLE,
                    )
                )
                continue
            successful_queries += 1
            valid_options = [
                option
                for option in raw_options
                if 0 < len(option) <= MAX_MODEL_OPTION_LENGTH
            ]
            truncated = len(valid_options) > MAX_MODEL_OPTIONS_PER_SLOT
            options = valid_options[:MAX_MODEL_OPTIONS_PER_SLOT]
            if truncated:
                reason = (
                    f"モデル在庫が上限{MAX_MODEL_OPTIONS_PER_SLOT}件を超えたため、"
                    "先頭だけを表示しています。"
                )
            elif not options:
                reason = "ComfyUIに利用可能なモデルがありません。"
            else:
                reason = None
            slots.append(
                schemas.WorkflowModelSlotOptions(
                    variable=variable,
                    node_class=node_class,
                    option_field=option_field,
                    options=options,
                    reason=reason,
                )
            )
    finally:
        await client.aclose()
    reachable = not declared or successful_queries > 0
    return schemas.WorkflowModelOptionsRead(
        workflow_version_id=workflow_version_id,
        backend_reachable=reachable,
        reason=None if reachable else MODEL_INVENTORY_UNAVAILABLE,
        slots=slots,
    )


async def _validate_resolved_models(
    recipe: Recipe, prepared: PreparedExecution
) -> None:
    """既定値を全て解決した後のモデルを、Job作成前にComfyUI在庫へ再照合する。"""
    if recipe.engine != ENGINE_COMFYUI:
        return
    reference = recipe.workflow_template_ref
    template_name = reference.get("name") if isinstance(reference, dict) else None
    if not isinstance(template_name, str):
        raise _validation_error("RecipeのWorkflow参照が不正です。")

    client = create_comfyui_client()
    missing: list[str] = []
    try:
        for slot in comfyui_workflow.model_slots(template_name):
            required = prepared.model.get(slot.variable)
            if not required:
                continue
            options = await client.available_options(slot.node_class, slot.option_field)
            if not options:
                raise ApiError(
                    "MODEL_INVENTORY_UNAVAILABLE",
                    MODEL_INVENTORY_UNAVAILABLE,
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    details={"slot": slot.variable},
                )
            if required not in options:
                missing.append(slot.variable)
    except ComfyUIError as error:
        logger.info("ComfyUIのモデル在庫を再検証できません。", exc_info=error)
        raise ApiError(
            "MODEL_INVENTORY_UNAVAILABLE",
            MODEL_INVENTORY_UNAVAILABLE,
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        ) from error
    finally:
        await client.aclose()
    if missing:
        raise _validation_error(
            "ComfyUIに指定したモデルがありません。",
            {"slots": sorted(missing)},
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
    撤去したengineのRecipeはDBに残っていても実行できないため、選択肢に出さない。
    """
    query = (
        select(Recipe)
        .where(Recipe.engine.in_(SUPPORTED_ENGINES))
        .order_by(Recipe.created_at.desc(), Recipe.id.asc())
    )
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
    return await _submit_generation_job(session, source, payload)


async def _validate_story_links_of[P: schemas.GenerationPreviewCreate](
    session: AsyncSession, payload: P
) -> P:
    """Job作成・プレビューが受け取ったv2の紐づけ先を確かめる。

    `story_dialogue_id`だけを渡したときは、台詞の所属シーンを`story_scene_id`へ補った
    payloadを返す。生成物がシーンへ紐づかないまま残らないようにする。
    """
    scene_id = await story_links.validate_story_links(
        session,
        character_id=payload.story_character_id,
        costume_id=payload.story_costume_id,
        scene_id=payload.story_scene_id,
        project_id=payload.project_id,
        dialogue_id=payload.story_dialogue_id,
    )
    if payload.story_scene_id is None and scene_id is not None:
        return payload.model_copy(update={"story_scene_id": scene_id})
    return payload


async def _submit_generation_job(
    session: AsyncSession,
    source: ReferenceSource,
    payload: schemas.GenerationJobCreate,
    extra_records: Callable[[GenerationJob], Sequence[Base]] | None = None,
) -> GenerationJob:
    """JobとManifestのIDを先行採番して作成する、Job投入の共通処理。

    `extra_records`は、採番済みのJobを受けて同じcommitへ相乗りさせるレコードを返す。
    Jobの作成と一緒に確定させたい関連レコード (後続Jobの予約など) に使う。
    """
    await _validate_project_context(session, payload.project_id)
    payload = await _validate_story_links_of(session, payload)
    resolved = await _resolve_references(
        session, source, payload.project_id, payload.scene_id, payload.shot_id
    )
    effective, recipe, _, _, preferences, _, look_profiles = await _resolve_generation_defaults(
        session, payload, resolved
    )
    # 実行スナップショットの組み立てはengineごとのAdapterが行う。音声Jobは台詞を
    # 固定する必要があるため、参照APIから取得したShot本文もここで渡す。
    prepared = await _prepare_execution(
        recipe, effective, source, resolved, session, persist=True
    )
    await _validate_resolved_models(recipe, prepared)
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
            look_profiles,
        )
        await _persist_job_records(
            session,
            job,
            workflow_artifact,
            manifest,
            extra_records(job) if extra_records is not None else (),
        )
    except Exception:
        storage.discard_artifacts([stored.relative_path])
        raise
    # ここから先はレコードが確定している。失敗してもスナップショットを消さない。
    await _load_queue_sequence(session, job)
    await job_events.publish_job(job.id, job.state)
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
    payload = await _validate_story_links_of(session, payload)
    resolved = await _resolve_references(
        session, source, payload.project_id, payload.scene_id, payload.shot_id
    )
    effective, recipe, recipe_origin, input_origins, preferences, look_profile_ids, look_profiles = (
        await _resolve_generation_defaults(session, payload, resolved)
    )
    prepared = await _prepare_execution(
        recipe, effective, source, resolved, session, persist=False
    )
    await _validate_resolved_models(recipe, prepared)
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
            **(
                {"look_profile_ids": look_profile_ids}
                if look_profile_ids
                else {}
            ),
            **({"look_profiles": look_profiles} if look_profiles else {}),
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
        look_profile_ids=look_profile_ids,
        tag_check=await _check_prompt_tags(recipe, prepared),
    )


#: 設定したパスごとのタグ辞書。読み込んだ内容をファイルが変わるまで使い回す。
_tag_dictionaries: dict[Path, tag_preflight.TagDictionary] = {}


async def _check_prompt_tags(
    recipe: Recipe, prepared: PreparedExecution
) -> schemas.PromptTagCheckRead | None:
    """画像生成のpositiveとnegativeについて、タグの実在と干渉する組み合わせを調べる。

    検証するのはLook Profileなどを合成した後の値とし、合成で入るタグも見落とさない。
    """
    if recipe.kind != "image" or recipe.engine != ENGINE_COMFYUI:
        return None
    inputs = prepared.resolved_inputs
    positive = inputs.get("positive_prompt")
    negative = inputs.get("negative_prompt")
    if not isinstance(positive, str):
        return None
    path = get_settings().tag_dictionary_path
    dictionary = None
    if path is not None:
        dictionary = _tag_dictionaries.setdefault(path, tag_preflight.TagDictionary(path))
    # 初回は数MBのCSVを読むため、イベントループを塞がない。
    check = await run_in_threadpool(
        tag_preflight.check_prompt_tags,
        positive,
        negative if isinstance(negative, str) else "",
        dictionary,
    )
    return schemas.PromptTagCheckRead.model_validate(check, from_attributes=True)


async def _character_tags() -> frozenset[str]:
    """タグ辞書のキャラクターのタグ名。辞書が未設定か読めなければ空とする。

    空のときは、消したタグと足したタグがキャラクターかどうかをモデルの申告だけで
    判定する(#388より前の挙動)。
    """
    path = get_settings().tag_dictionary_path
    if path is None:
        return frozenset()
    dictionary = _tag_dictionaries.setdefault(path, tag_preflight.TagDictionary(path))
    try:
        # 初回は数MBのCSVを読むため、イベントループを塞がない。
        return await run_in_threadpool(dictionary.character_tags)
    except tag_preflight.TagDictionaryError as error:
        logger.warning("タグ辞書を読めずキャラクターの判定に使わない: %s", error)
        return frozenset()


async def _canonical_tag_names() -> dict[str, str]:
    """タグ辞書の別名から正規のタグ名への対応。辞書が未設定か読めなければ空とする。

    空のときは、prompt案のタグを正規化しない(#395より前の挙動)。
    """
    path = get_settings().tag_dictionary_path
    if path is None:
        return {}
    dictionary = _tag_dictionaries.setdefault(path, tag_preflight.TagDictionary(path))
    try:
        # 初回は数MBのCSVを読むため、イベントループを塞がない。
        return await run_in_threadpool(dictionary.canonical_names)
    except tag_preflight.TagDictionaryError as error:
        logger.warning("タグ辞書を読めずprompt案のタグを正規化しない: %s", error)
        return {}


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
    list[str],
    list[dict[str, Any]],
]:
    """入力をProject、Scene、Shot、LookProfile順、実行時指定の順で上書きする。"""
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
    applied_profiles: list[str] = []
    profile_snapshots: list[dict[str, Any]] = []
    if payload.look_profile_ids and not payload.use_inherited_defaults:
        rows = list(
            await session.scalars(
                select(LookProfile).where(
                    LookProfile.id.in_(payload.look_profile_ids)
                )
            )
        )
        profiles = {profile.id: profile for profile in rows}
        missing = [item for item in payload.look_profile_ids if item not in profiles]
        if missing:
            raise _validation_error(
                "指定したLookProfileがありません。", {"missing": missing}
            )
        schema = recipe.input_schema if isinstance(recipe.input_schema, dict) else {}
        for profile_id in payload.look_profile_ids:
            profile = profiles[profile_id]
            if profile.kind != recipe.kind:
                raise _validation_error(
                    "LookProfileとRecipeの生成種別が一致しません。",
                    {"profile_id": profile.id, "profile_kind": profile.kind},
                )
            if profile.recipe_id is not None and profile.recipe_id != recipe.id:
                raise _validation_error(
                    "LookProfileは別のRecipe専用です。",
                    {
                        "profile_id": profile.id,
                        "profile_recipe_id": profile.recipe_id,
                        "recipe_id": recipe.id,
                    },
                )
            unknown = sorted(set(profile.inputs) - set(schema))
            if unknown:
                raise _validation_error(
                    "Recipeで指定できないLookProfile入力があります。",
                    {"profile_id": profile.id, "unknown": unknown},
                )
            for name, value in profile.inputs.items():
                inputs[name] = value
                input_origins[name] = "look_profile"
            applied_profiles.append(profile.id)
            snapshot = {
                "id": profile.id,
                "name": profile.name,
                "category": profile.category,
                "recipe_id": profile.recipe_id,
                "inputs": profile.inputs,
                "updated_at": profile.updated_at,
            }
            canonical = json.dumps(
                snapshot, ensure_ascii=False, sort_keys=True, separators=(",", ":")
            ).encode("utf-8")
            profile_snapshots.append(
                {**snapshot, "sha256": hashlib.sha256(canonical).hexdigest()}
            )
    if not payload.use_inherited_defaults:
        for name, value in payload.inputs.items():
            inputs[name] = value
            input_origins[name] = "runtime"
    # 入力に無ければRecipe既定を見る。利用者が編集した既定から安全語が落ちていることがある。
    recipe_defaults = recipe.defaults if isinstance(recipe.defaults, dict) else {}
    negative = inputs.get(
        "negative_prompt", recipe_defaults.get("negative_prompt") or ""
    )
    if isinstance(negative, str):
        safe_negative = bootstrap.with_reference_safety_negative(recipe, negative)
        if safe_negative != negative:
            inputs["negative_prompt"] = safe_negative
            input_origins.setdefault("negative_prompt", "recipe_default")

    return (
        payload.model_copy(
            update={
                "recipe_id": recipe.id,
                "inputs": inputs,
                "look_profile_ids": applied_profiles,
            }
        ),
        recipe,
        recipe_origin,
        input_origins,
        preferences,
        applied_profiles,
        profile_snapshots,
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
    *,
    persist: bool,
):
    """Recipeのengineに対応するAdapterで実行スナップショットを組み立てる。

    `persist=False`はプレビュー用で、入力cacheなどへファイルを書かない。
    """
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
        inputs = await story_voice.resolve_character_voice(
            session,
            payload,
            payload.inputs,
            recipe.defaults,
            persist=persist,
            shot_data=resolved.shot_data,
        )
        return await prepare_execution(recipe, inputs, context)
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
    look_profiles: list[dict[str, Any]] | None = None,
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
        story_character_id=payload.story_character_id,
        story_costume_id=payload.story_costume_id,
        story_scene_id=payload.story_scene_id,
        story_dialogue_id=payload.story_dialogue_id,
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
        story_character_id=payload.story_character_id,
        story_costume_id=payload.story_costume_id,
        story_scene_id=payload.story_scene_id,
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
                {"look_profile_ids": list(payload.look_profile_ids)}
                if payload.look_profile_ids
                else {}
            ),
            **({"look_profiles": look_profiles} if look_profiles else {}),
            **(
                {"primary_input_artifact_id": prepared.parent_artifact_id}
                if prepared.parent_artifact_id is not None
                else {}
            ),
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
    extra_records: Sequence[Base] = (),
) -> None:
    """Job、Workflow Artifact、Manifestの順にflushしてコミットまで行う。

    `extra_records`はManifestの後にflushし、同じcommitで確定させる。

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
        for record in extra_records:
            session.add(record)
        if extra_records:
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
    order: Literal["asc", "desc"] = "asc",
):
    """キュー状態の確認用。既定はqueue_sequence昇順、指定した条件で絞り込む。

    `order=desc`で新しいJobから返す。limitは並べ替えの後に掛かる。

    `project_id`、`scene_id`、`shot_id`は現在の整理先と突き合わせる。`unassigned`は
    現在Projectに所属しないJobだけへ絞る。生成時参照とManifestは所属変更で変えない。
    """
    if unassigned and any(
        value is not None for value in (project_id, scene_id, shot_id)
    ):
        raise _validation_error(
            "unassignedとProjectコンテキストの絞り込みは同時に指定できません。"
        )
    if order == "desc":
        ordering = (GenerationJob.queue_sequence.desc(), GenerationJob.id.desc())
    else:
        ordering = (GenerationJob.queue_sequence.asc(), GenerationJob.id.asc())
    query = select(GenerationJob).order_by(*ordering)
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


@router.get(
    "/generation-jobs/{job_id}/preview",
    response_class=Response,
    responses={
        200: {"content": {"image/jpeg": {}, "image/png": {}}},
    },
)
async def get_job_preview(
    job_id: str,
    session: SessionDep,
    seq: Annotated[int | None, Query(ge=0)] = None,
):
    """実行中Jobの最新プレビュー画像を返す。

    プレビューはメモリ上にだけあり、Jobが終わると消える。`seq`は進捗イベントの
    `preview_seq`で、画面が取り直しのURLを変えるためだけに付ける。値は見ずに常に
    最新の1枚を返し、ブラウザにはキャッシュさせない。
    """
    await _get_or_404(session, GenerationJob, "GenerationJob", job_id)
    entry = job_progress.get(job_id)
    if entry is None or entry.preview is None or entry.preview_media_type is None:
        raise ApiError(
            "PREVIEW_NOT_FOUND",
            "プレビュー画像がありません。",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    return Response(
        content=entry.preview,
        media_type=entry.preview_media_type,
        headers={"Cache-Control": "no-store"},
    )


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
    await job_events.publish_job(job.id, job.state)
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
        **story_links.job_story_links(job),
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
    """Artifactを一括整理する。copyは元Artifactを親に持つ新しい記録を作る。

    trashはゴミ箱へ移し (論理削除)、restoreはゴミ箱から戻す。Workflowのスナップショットは
    生成記録が必ず参照するためゴミ箱へ移せず、1件でも含まれていれば何も変更しない。
    """
    rows = await _artifacts_in_order(session, payload.artifact_ids)
    if payload.operation == "trash":
        workflow_ids = [row.id for row in rows if row.kind == "workflow"]
        if workflow_ids:
            raise _validation_error(
                "Workflowのスナップショットはゴミ箱へ移せません。",
                {"artifact_ids": workflow_ids},
            )
    elif payload.operation != "restore":
        # ゴミ箱のまま割当やタグを書き換えると、復元時に元の整理先へ戻らない。
        trashed_ids = [row.id for row in rows if row.deleted_at is not None]
        if trashed_ids:
            raise _validation_error(
                "ゴミ箱にあるArtifactは復元してから操作してください。",
                {"artifact_ids": trashed_ids},
            )
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
        import_rows = list(
            await session.scalars(
                select(ArtifactImport).where(
                    ArtifactImport.artifact_id.in_(payload.artifact_ids)
                )
            )
        )
        imports_by_id = {row.artifact_id: row for row in import_rows}
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
            imported = imports_by_id.get(original.id)
            if imported is not None:
                session.add(
                    ArtifactImport(
                        artifact_id=copied.id,
                        original_file_name=imported.original_file_name,
                        source_format=imported.source_format,
                        raw_metadata=imported.raw_metadata,
                        recipe_draft=imported.recipe_draft,
                        created_at=now,
                    )
                )
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
    elif payload.operation == "trash":
        now = schemas.now_iso()
        for artifact in rows:
            if artifact.deleted_at is None:
                artifact.deleted_at = now
        # ゴミ箱の生成物をシーンの採用枠に残さない。採否も採用前へ戻す。
        await story_links.release_adoptions(
            session, StorySceneAdoption.artifact_id.in_([row.id for row in rows])
        )
        affected = rows
    elif payload.operation == "restore":
        for artifact in rows:
            artifact.deleted_at = None
        affected = rows
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


async def _artifacts_in_order(
    session: AsyncSession, artifact_ids: list[str]
) -> list[Artifact]:
    """指定順にArtifactを引く。1件でも無ければ404にし、何も変更させない。"""
    rows = list(
        await session.scalars(select(Artifact).where(Artifact.id.in_(artifact_ids)))
    )
    if len(rows) != len(artifact_ids):
        found = {row.id for row in rows}
        raise ApiError(
            "ARTIFACT_NOT_FOUND",
            "指定したArtifactの一部がありません。",
            status_code=status.HTTP_404_NOT_FOUND,
            details={
                "missing_ids": [item for item in artifact_ids if item not in found]
            },
        )
    ordered = {row.id: row for row in rows}
    return [ordered[item] for item in artifact_ids]


def _json_mentions(column: Any, ids: Sequence[str]) -> ColumnElement[bool]:
    """JSON列の本文にIDのどれかが現れる行を絞る。一致は呼出側で構造を見て確かめる。"""
    return or_(*(type_coerce(column, String).like(f'%"{item}"%') for item in ids))


def _clear_reference_slots(overrides: Any, ids: set[str]) -> tuple[Any, int]:
    """キャラ参照セットの枠から、削除するArtifactへの表示用参照を外す。

    旧形式の値を検証で弾かないよう、スキーマを通さずに該当キーだけを書き換える。
    書き換える参照セットからは、廃止した枠のキーも落とす (数には含めない)。
    書き戻すのは削除対象を参照する枠が数えられたprojectだけで、廃止キーしか残らない
    projectは書き換えない (読み込み時に`_drop_retired_slots`が捨てる)。
    """
    if not isinstance(overrides, dict):
        return overrides, 0
    updated = copy.deepcopy(overrides)
    cleared = 0
    for character in updated.get("characters") or []:
        if not isinstance(character, dict):
            continue
        for reference_set in character.get("reference_sets") or []:
            slots = reference_set.get("slots") if isinstance(reference_set, dict) else None
            if not isinstance(slots, dict):
                continue
            for key in schemas.RETIRED_REFERENCE_SLOT_KEYS:
                slots.pop(key, None)
            for slot in slots.values():
                if isinstance(slot, dict) and slot.get("artifact_id") in ids:
                    slot["artifact_id"] = None
                    cleared += 1
    return updated, cleared


@dataclass
class _PurgePlan:
    """完全削除で変わるもの。プレビューと実行で同じ判定を使う。"""

    rows: list[Artifact]
    not_trashed_ids: list[str]
    #: 実際に消すファイルの相対パスと容量。
    removed_files: dict[str, int]
    shared_file_count: int
    unreplayable_manifest_count: int
    detached_child_count: int
    thumbnail_projects: list[Project]
    #: 参照セットの枠を外したあとのlocal_overridesと、外した枠の数。
    slot_updates: list[tuple[Project, Any, int]]
    tag_count: int
    role_tag_count: int


async def _plan_purge(session: AsyncSession, artifact_ids: list[str]) -> _PurgePlan:
    rows = await _artifacts_in_order(session, artifact_ids)
    ids = set(artifact_ids)
    paths: dict[str, int] = {}
    for row in rows:
        paths.setdefault(row.relative_path, row.byte_size)
    # コピーやProjectのcloneはファイルを複製せず、同じパスを共有する。
    shared = set(
        await session.scalars(
            select(Artifact.relative_path)
            .where(Artifact.relative_path.in_(list(paths)), Artifact.id.not_in(ids))
            .distinct()
        )
    )
    manifests = await session.execute(
        select(GenerationManifest.input_refs).where(
            _json_mentions(GenerationManifest.input_refs, artifact_ids)
        )
    )
    unreplayable = sum(
        1
        for (refs,) in manifests
        if isinstance(refs, list)
        and any(
            isinstance(ref, dict)
            and ref.get("kind") == provenance.KIND_ARTIFACT
            and ref.get("artifact_id") in ids
            for ref in refs
        )
    )
    children = await session.scalar(
        select(func.count())
        .select_from(Artifact)
        .where(Artifact.parent_artifact_id.in_(ids), Artifact.id.not_in(ids))
    )
    projects = list(
        await session.scalars(
            select(Project).where(
                or_(
                    Project.thumbnail_artifact_id.in_(ids),
                    _json_mentions(Project.local_overrides, artifact_ids),
                )
            )
        )
    )
    slot_updates: list[tuple[Project, Any, int]] = []
    for project in projects:
        overrides, cleared = _clear_reference_slots(project.local_overrides, ids)
        if cleared:
            slot_updates.append((project, overrides, cleared))
    tag_count = await session.scalar(
        select(func.count()).select_from(ArtifactTag).where(ArtifactTag.artifact_id.in_(ids))
    )
    role_tag_count = await session.scalar(
        select(func.count()).select_from(MediaRoleTag).where(MediaRoleTag.artifact_id.in_(ids))
    )
    return _PurgePlan(
        rows=rows,
        not_trashed_ids=[row.id for row in rows if row.deleted_at is None],
        removed_files={
            path: size for path, size in paths.items() if path not in shared
        },
        shared_file_count=len(shared),
        unreplayable_manifest_count=unreplayable,
        detached_child_count=children or 0,
        thumbnail_projects=[
            project for project in projects if project.thumbnail_artifact_id in ids
        ],
        slot_updates=slot_updates,
        tag_count=tag_count or 0,
        role_tag_count=role_tag_count or 0,
    )


@router.post("/artifacts/purge-preview", response_model=schemas.ArtifactPurgePreview)
async def preview_artifact_purge(
    payload: schemas.ArtifactPurgeTarget, session: SessionDep
):
    """完全削除で消えるものと外れる参照を返す。DBもファイルも変更しない。"""
    plan = await _plan_purge(session, payload.artifact_ids)
    return schemas.ArtifactPurgePreview(
        artifacts=await _artifact_reads(session, plan.rows),
        removed_file_count=len(plan.removed_files),
        removed_byte_size=sum(plan.removed_files.values()),
        shared_file_count=plan.shared_file_count,
        unreplayable_manifest_count=plan.unreplayable_manifest_count,
        detached_child_count=plan.detached_child_count,
        thumbnail_project_ids=[project.id for project in plan.thumbnail_projects],
        reference_slot_count=sum(cleared for _, _, cleared in plan.slot_updates),
        tag_count=plan.tag_count,
        role_tag_count=plan.role_tag_count,
        not_trashed_ids=plan.not_trashed_ids,
    )


@router.post("/artifacts/purge", response_model=schemas.ArtifactPurgeResult)
async def purge_artifacts(payload: schemas.ArtifactPurgeRequest, session: SessionDep):
    """ゴミ箱にあるArtifactを、DBの記録と実ファイルごと完全に削除する。

    取り消せないため`confirm=true`を必須にし、ゴミ箱に無いものが1件でも含まれていれば
    何も削除しない。生成記録のJSONに残る参照は履歴として書き換えない。ファイルは
    同じパスを使う記録が他に無いときだけ、commit後に消す。
    """
    if not payload.confirm:
        raise ApiError(
            "PURGE_NOT_CONFIRMED",
            "完全削除は取り消せません。confirm=trueを指定してください。",
            status_code=status.HTTP_409_CONFLICT,
        )
    plan = await _plan_purge(session, payload.artifact_ids)
    if plan.not_trashed_ids:
        raise ApiError(
            "ARTIFACT_NOT_TRASHED",
            "ゴミ箱に無いArtifactは完全に削除できません。",
            status_code=status.HTTP_409_CONFLICT,
            details={"artifact_ids": plan.not_trashed_ids},
        )
    ids = list(payload.artifact_ids)
    # FKにondeleteが無いため、参照する行を先に消すか外す。
    for model in (
        ArtifactTag,
        ArtifactImport,
        MediaRoleTag,
        VoiceVerification,
        StorySceneAdoption,
    ):
        await session.execute(delete(model).where(model.artifact_id.in_(ids)))
    await session.execute(
        update(Artifact)
        .where(Artifact.parent_artifact_id.in_(ids))
        .values(parent_artifact_id=None)
    )
    for project in plan.thumbnail_projects:
        project.thumbnail_artifact_id = None
    for project, overrides, _ in plan.slot_updates:
        project.local_overrides = overrides
    await session.execute(
        delete(Artifact)
        .where(Artifact.id.in_(ids))
        .execution_options(synchronize_session=False)
    )
    await _commit(session)
    # 消せなかったファイルはwarningを残して続ける。記録はもう無いため戻さない。
    await run_in_threadpool(storage.discard_artifacts, list(plan.removed_files))
    return schemas.ArtifactPurgeResult(
        purged_ids=ids,
        removed_file_count=len(plan.removed_files),
        removed_byte_size=sum(plan.removed_files.values()),
    )


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
    trashed: bool = False,
    exclude_kinds: list[str] | None = None,
) -> Select[tuple[Artifact]]:
    """Artifactの絞り込み条件を組み立てる。条件はすべてANDで重ねる。

    既定ではゴミ箱にあるArtifactを除き、`trashed`を指定したときはゴミ箱にあるものだけに絞る。
    ProjectコンテキストはArtifactの現在の整理先と突き合わせる。
    `tags`を複数指定したときは、すべてのタグが付いたArtifactだけを返す。資産を絞り
    込む用途では和集合より積集合が要る。
    """
    query = query.where(
        Artifact.deleted_at.is_not(None) if trashed else Artifact.deleted_at.is_(None)
    )
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
    if exclude_kinds:
        query = query.where(Artifact.kind.not_in(exclude_kinds))
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
    trashed: bool = False,
    exclude_kind: Annotated[
        list[schemas.ArtifactKind] | None, Query(max_length=MAX_EXCLUDE_KINDS)
    ] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
):
    """Artifact履歴の一覧。既定は作成の新しい順に返す。

    ゴミ箱にあるArtifactは既定で除き、`trashed=true`のときはゴミ箱にあるものだけを返す。

    Projectコンテキストは現在の所属先と突き合わせる。`unassigned`は
    現在のProject所属を持たないArtifactだけへ絞る。
    Workflowスナップショットも記録として残すため、種別で絞りたい場合は`kind`を使う。
    `exclude_kind`は複数指定でき、指定した種別を除く。一覧から記録用の種別だけを外す
    用途では、取得後に除くとページの件数が欠けるためDB側で除く。

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
        trashed=trashed,
        exclude_kinds=exclude_kind,
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


def _media_role_tag_read(tag: MediaRoleTag) -> schemas.MediaRoleTagRead:
    return schemas.MediaRoleTagRead.model_validate(tag)


async def _validate_role_tag_characters(
    session: AsyncSession, project_id: str, character_ids: Sequence[str]
) -> None:
    """指定したProjectに登録されたキャラクターIDだけを受け付ける。"""
    project = await session.get(Project, project_id)
    overrides = schemas.ProjectLocalOverrides.model_validate(
        (project.local_overrides if project else None) or {}
    )
    known = {character.id for character in overrides.characters}
    unknown = [character_id for character_id in character_ids if character_id not in known]
    if unknown:
        raise _validation_error(
            "Projectに登録されていないキャラクターを指定しています。",
            details={"character_ids": unknown},
        )


def _validate_role_for_media(role: str, media_type: str) -> None:
    """音声の役割は音声だけに、画像の役割は画像だけに付けさせる。`other`は種別を問わない。"""
    if role == "other":
        return
    expected = "audio" if role in schemas.AUDIO_MEDIA_ROLES else "image"
    if not media_type.startswith(f"{expected}/"):
        raise _validation_error(
            "役割がメディアの種別(画像・音声)と合いません。",
            details={"role": role, "media_type": media_type},
        )


@router.put("/media-role-tags", response_model=schemas.MediaRoleTagRead)
async def upsert_media_role_tag(
    payload: schemas.MediaRoleTagUpsert,
    session: SessionDep,
    source: ReferenceSourceDep,
):
    """役割・キャラクターの紐付けを登録・更新する。

    Issue #148: 取込時の役割/キャラクター指定を、既存の4系統の取込endpointを変えずに
    後付けできるようにする。対象(`artifact_id`または`relative_path`)へ同じ内容を
    再送すると上書きになる。
    """
    await _validate_assignment_target(
        session,
        source,
        schemas.AssignmentTarget(
            project_id=payload.project_id, scene_id=payload.scene_id
        ),
    )
    if payload.project_id is not None and payload.character_ids:
        await _validate_role_tag_characters(
            session, payload.project_id, payload.character_ids
        )
    if payload.artifact_id is not None:
        artifact = await _get_or_404(session, Artifact, "Artifact", payload.artifact_id)
        _validate_role_for_media(payload.role, artifact.media_type)
        existing = await session.scalar(
            select(MediaRoleTag).where(MediaRoleTag.artifact_id == payload.artifact_id)
        )
    else:
        # relative_path指定時のmedia_typeはスキーマで必須にしてある。
        _validate_role_for_media(payload.role, payload.media_type or "")
        existing = await session.scalar(
            select(MediaRoleTag).where(
                MediaRoleTag.relative_path == payload.relative_path
            )
        )
    now = schemas.now_iso()
    if existing is None:
        row = MediaRoleTag(
            id=schemas.new_id(),
            artifact_id=payload.artifact_id,
            relative_path=payload.relative_path,
            sha256=payload.sha256,
            file_name=payload.file_name,
            byte_size=payload.byte_size,
            media_type=payload.media_type,
            role=payload.role,
            character_ids=list(payload.character_ids),
            reference_transcript=payload.reference_transcript,
            assigned_project_id=payload.project_id,
            assigned_scene_id=payload.scene_id,
            created_at=now,
            updated_at=now,
        )
        session.add(row)
    else:
        existing.sha256 = payload.sha256
        existing.file_name = payload.file_name
        existing.byte_size = payload.byte_size
        existing.media_type = payload.media_type
        existing.role = payload.role
        # Projectもキャラクターも送らない再送は割り当てを知らない呼び出し元 (Projectを
        # 選ばない音声の取込など) のため、既存の紐付けとProject・Sceneの割り当てを
        # 消さない。キャラクターを外すときは`project_id`を付けて`character_ids`を空で
        # 送り、Projectの割り当てを外すときは`project_id`をnullで明示して送る。
        keeps_assignment = (
            "project_id" not in payload.model_fields_set and not payload.character_ids
        )
        if not keeps_assignment:
            existing.character_ids = list(payload.character_ids)
            existing.assigned_project_id = payload.project_id
            existing.assigned_scene_id = payload.scene_id
        # 書き起こしを知らない呼び出し元 (画像の役割付けなど) が消さないよう、
        # 項目を送ったときだけ更新する。消すときは明示的にnullを送る。
        if "reference_transcript" in payload.model_fields_set:
            existing.reference_transcript = payload.reference_transcript
        existing.updated_at = now
        row = existing
    await _commit(session)
    await session.refresh(row)
    return _media_role_tag_read(row)


@router.delete("/media-role-tags", status_code=status.HTTP_204_NO_CONTENT)
async def delete_media_role_tag(
    session: SessionDep,
    artifact_id: str | None = None,
    relative_path: str | None = None,
):
    """役割・キャラクターの紐付けを外す。対象そのもの(Artifact・入力cacheの実体)は消さない。"""
    if bool(artifact_id) == bool(relative_path):
        raise _validation_error(
            "artifact_idとrelative_pathはどちらか一方だけ指定してください。"
        )
    if relative_path:
        # PUTと同じ検証を通し、登録できない形のパスは照合せずに弾く。
        # PUTは正規化した値(前後の空白を除いた値)で記録するため、照合も同じ値で行う。
        try:
            relative_path = schemas.input_cache_relative_path(relative_path)
        except ValueError as error:
            raise _validation_error(str(error)) from error
    query = select(MediaRoleTag)
    query = (
        query.where(MediaRoleTag.artifact_id == artifact_id)
        if artifact_id
        else query.where(MediaRoleTag.relative_path == relative_path)
    )
    row = await session.scalar(query)
    if row is not None:
        await session.delete(row)
        await _commit(session)


async def _media_role_tag_map(
    session: AsyncSession, artifact_ids: Sequence[str]
) -> dict[str, MediaRoleTag]:
    """Artifact IDごとの役割タグをまとめて引く。`_artifact_tag_map`と同じ理由でIN句を
    まとめ、SQLiteのbind parameter上限に当たらないよう分割する。
    """
    tags: dict[str, MediaRoleTag] = {}
    unique_ids = list(dict.fromkeys(artifact_ids))
    for start in range(0, len(unique_ids), TAG_LOOKUP_CHUNK):
        chunk = unique_ids[start : start + TAG_LOOKUP_CHUNK]
        result = await session.execute(
            select(MediaRoleTag).where(MediaRoleTag.artifact_id.in_(chunk))
        )
        for tag in result.scalars().all():
            if tag.artifact_id is not None:
                tags[tag.artifact_id] = tag
    return tags


async def _artifact_import_ids(
    session: AsyncSession, artifact_ids: Sequence[str]
) -> set[str]:
    """外部取込由来のArtifact IDの集合をまとめて引く。"""
    ids: set[str] = set()
    unique_ids = list(dict.fromkeys(artifact_ids))
    for start in range(0, len(unique_ids), TAG_LOOKUP_CHUNK):
        chunk = unique_ids[start : start + TAG_LOOKUP_CHUNK]
        result = await session.execute(
            select(ArtifactImport.artifact_id).where(
                ArtifactImport.artifact_id.in_(chunk)
            )
        )
        ids.update(result.scalars().all())
    return ids


def _media_item_kind(media_type: str) -> str:
    if media_type.startswith("audio/"):
        return "audio"
    return "image"


def _media_role_tag_conditions(
    role: str | None, character_id: str | None
) -> list[ColumnElement[bool]]:
    """役割タグを役割・キャラクターで絞る条件。`character_ids`はJSON配列のため、
    SQLiteの`json_each`で要素へ展開して突き合わせる。
    """
    conditions: list[ColumnElement[bool]] = []
    if role is not None:
        conditions.append(MediaRoleTag.role == role)
    if character_id is not None:
        member = func.json_each(MediaRoleTag.character_ids).table_valued("value")
        conditions.append(
            exists(select(1).select_from(member).where(member.c.value == character_id))
        )
    return conditions


def _parse_period_bound(name: str, value: str, *, is_end: bool) -> tuple[str, bool]:
    """期間指定のISO 8601文字列を、`julianday()`へ渡せるUTC表記と包含の別に直す。

    タイムゾーンを持たない値はサーバーのローカル時刻として読む。日付だけの終端
    (`to=2026-10-08`)はその日の終わりまでを含める意味で、翌日0時を超えない(排他)境界にする。
    戻り値は(境界のUTC表記, 境界を含めるか)。
    """
    inclusive = True
    try:
        parsed = datetime.fromisoformat(value)
        if is_end and len(value) == 10:
            parsed += timedelta(days=1)
            inclusive = False
        bound = parsed.astimezone().astimezone(UTC).isoformat()
    except (ValueError, OverflowError):
        # 0001-01-01や9999-12-31のように、翌日やUTCへ直すと範囲外になる値もここで弾く。
        raise _validation_error(
            f"{name}はISO 8601形式で指定してください。", {"value": value}
        ) from None
    return bound, inclusive


async def _story_media_conditions(
    session: AsyncSession,
    *,
    story_character_id: str | None,
    story_costume_id: str | None,
    story_scene_id: str | None,
    audio_class: schemas.ArtifactAudioClass | None,
    created_from: str | None,
    created_to: str | None,
) -> list[ColumnElement[bool]]:
    """`/media-items`のv2向け絞り込み条件。指定があればArtifactだけが対象になる。"""
    conditions: list[ColumnElement[bool]] = []
    if story_character_id is not None:
        conditions.append(Artifact.story_character_id == story_character_id)
    if story_costume_id is not None:
        conditions.append(Artifact.story_costume_id == story_costume_id)
    if story_scene_id is not None:
        conditions.append(Artifact.story_scene_id == story_scene_id)
    if audio_class is not None:
        recipe_ids = await story_links.recipe_ids_of_audio_class(session, audio_class)
        conditions.append(Artifact.kind == "audio")
        conditions.append(
            Artifact.job_id.in_(
                select(GenerationJob.id).where(GenerationJob.recipe_id.in_(recipe_ids))
            )
        )
    # `created_at`はローカルのオフセット付きで保存されているため、文字列比較ではなく
    # 時刻へ直して突き合わせる。
    if created_from is not None:
        bound, _ = _parse_period_bound("from", created_from, is_end=False)
        conditions.append(func.julianday(Artifact.created_at) >= func.julianday(bound))
    if created_to is not None:
        bound, inclusive = _parse_period_bound("to", created_to, is_end=True)
        end = func.julianday(bound)
        conditions.append(
            func.julianday(Artifact.created_at) <= end
            if inclusive
            else func.julianday(Artifact.created_at) < end
        )
    return conditions


@router.get("/media-items", response_model=list[schemas.MediaItemRead])
async def list_media_items(
    session: SessionDep,
    project_id: str | None = None,
    scene_id: str | None = None,
    shot_id: str | None = None,
    unassigned: bool = False,
    kind: schemas.ArtifactKind | None = None,
    source: schemas.MediaItemSource | None = None,
    role: schemas.MediaRole | None = None,
    character_id: str | None = None,
    exclude_kind: Annotated[
        list[schemas.ArtifactKind] | None, Query(max_length=MAX_EXCLUDE_KINDS)
    ] = None,
    story_character_id: str | None = None,
    story_costume_id: str | None = None,
    story_scene_id: str | None = None,
    decision: schemas.ArtifactDecision | None = None,
    audio_class: schemas.ArtifactAudioClass | None = None,
    created_from: Annotated[str | None, Query(alias="from", max_length=40)] = None,
    created_to: Annotated[str | None, Query(alias="to", max_length=40)] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
):
    """生成物・登録素材・外部取込・人物参照を1つの一覧で探す(Issue #148 受入基準3)。

    v2向けに、紐づけ(`story_character_id`・`story_costume_id`・`story_scene_id`)、
    採否(`decision`)、作成日時の期間(`from`・`to`、ISO 8601)、音声の種類
    (`audio_class`=`voice`|`bgm`、JobのRecipeで決まる)でも絞れる。これらは
    Artifactにだけある項目のため、どれかを指定すると入力cacheと人物参照は返さない。

    Artifact由来の3系統(生成物・外部取込・登録素材)に加え、役割タグを付けた入力
    cacheファイル(`registered_input`)、Projectのキャラクター参照画像
    (`character_reference`)を横断して返す。人物参照はProject単位の設定のため
    `project_id`を指定したときだけ含める。並び順は`created_at`の新しい順。
    `character_reference`は`ProjectReferenceImage`に登録時刻を持たないため、
    常に一覧の末尾寄りになる。
    `shot_id`はArtifact由来の項目にだけ効く。入力cacheの役割タグはShotの割当てを
    持たないため、`shot_id`を指定しても`registered_input`はProject・Scene単位で絞った
    結果を返す。`character_reference`もProject単位のまま返す。
    `exclude_kind`は複数指定でき、指定した種別を全系統から除く。

    絞り込みは系統ごとのSQLで行い、各系統から新しい順に`offset + limit`件だけ取って
    から並べ直して切り出す。各系統の先頭からその件数を取れば、全件を並べたときと
    同じ結果になる。`character_reference`はProjectのJSON設定から作るため、
    メモリ上で絞る。
    """
    if unassigned and any(
        value is not None for value in (project_id, scene_id, shot_id)
    ):
        raise _validation_error(
            "unassignedとProjectコンテキストの絞り込みは同時に指定できません。"
        )

    # `character_id=`の空文字はどのキャラクターとも一致せず常に空になるため、
    # 未指定として扱う。
    character_id = character_id or None

    story_conditions = await _story_media_conditions(
        session,
        story_character_id=story_character_id or None,
        story_costume_id=story_costume_id or None,
        story_scene_id=story_scene_id or None,
        audio_class=audio_class,
        created_from=created_from or None,
        created_to=created_to or None,
    )
    # 採否もArtifactにしか無い。入力cacheと人物参照を混ぜないため、絞り込みの有無で
    # 系統ごと外す。
    artifact_only = bool(story_conditions) or decision is not None

    window = offset + limit
    excluded_kinds = set(exclude_kind or [])
    items: list[schemas.MediaItemRead] = []
    tag_conditions = _media_role_tag_conditions(role, character_id)

    # 1) Artifact由来 (生成物・外部取込・登録素材)
    artifacts: list[Artifact] = []
    if source not in ("registered_input", "character_reference"):
        artifact_query = select(Artifact).order_by(
            Artifact.created_at.desc(), Artifact.id.asc()
        )
        artifact_query = _artifact_filters(
            artifact_query,
            project_id=project_id,
            scene_id=scene_id,
            shot_id=shot_id,
            unassigned=unassigned,
            job_id=None,
            kind=kind,
            decision=decision,
            exclude_kinds=exclude_kind,
        )
        if story_conditions:
            artifact_query = artifact_query.where(*story_conditions)
        imported = select(ArtifactImport.artifact_id)
        if source == "generated":
            artifact_query = artifact_query.where(Artifact.job_id.is_not(None))
        elif source == "external_import":
            artifact_query = artifact_query.where(
                Artifact.job_id.is_(None), Artifact.id.in_(imported)
            )
        elif source == "registered":
            artifact_query = artifact_query.where(
                Artifact.job_id.is_(None), Artifact.id.not_in(imported)
            )
        if tag_conditions:
            tagged = select(MediaRoleTag.artifact_id).where(
                MediaRoleTag.artifact_id.is_not(None), *tag_conditions
            )
            artifact_query = artifact_query.where(Artifact.id.in_(tagged))
        artifacts = list(
            (await session.execute(artifact_query.limit(window))).scalars().all()
        )
    artifact_ids = [artifact.id for artifact in artifacts]
    imported_ids = await _artifact_import_ids(session, artifact_ids)
    artifact_role_tags = await _media_role_tag_map(session, artifact_ids)
    audio_class_map = await story_links.audio_classes(session, artifacts)
    for artifact in artifacts:
        artifact_source: schemas.MediaItemSource = (
            "generated"
            if artifact.job_id
            else "external_import"
            if artifact.id in imported_ids
            else "registered"
        )
        tag = artifact_role_tags.get(artifact.id)
        items.append(
            schemas.MediaItemRead(
                key=f"artifact:{artifact.id}",
                source=artifact_source,
                kind=artifact.kind,
                relative_path=artifact.relative_path,
                sha256=artifact.sha256,
                byte_size=artifact.byte_size,
                media_type=artifact.media_type,
                created_at=artifact.created_at,
                label=artifact.relative_path.rsplit("/", 1)[-1],
                role=tag.role if tag else None,
                character_ids=list(tag.character_ids) if tag else [],
                reference_transcript=tag.reference_transcript if tag else None,
                artifact_id=artifact.id,
                assigned_project_id=artifact.assigned_project_id,
                assigned_scene_id=artifact.assigned_scene_id,
                assigned_shot_id=artifact.assigned_shot_id,
                decision=artifact.decision,
                memo=artifact.memo,
                story_character_id=artifact.story_character_id,
                story_costume_id=artifact.story_costume_id,
                story_scene_id=artifact.story_scene_id,
                audio_class=audio_class_map.get(artifact.id),
            )
        )

    # 2) 役割タグを付けた入力cacheファイル (registered_input)。種別はmedia_typeから
    #    決まり、画像か音声のどちらかになる。
    input_tags: list[MediaRoleTag] = []
    input_kinds = {
        value
        for value in ("image", "audio")
        if kind in (None, value) and value not in excluded_kinds
    }
    if source in (None, "registered_input") and input_kinds and not artifact_only:
        input_tag_query = (
            select(MediaRoleTag)
            .where(MediaRoleTag.relative_path.is_not(None), *tag_conditions)
            .order_by(MediaRoleTag.created_at.desc(), MediaRoleTag.id.asc())
        )
        if project_id is not None:
            input_tag_query = input_tag_query.where(
                MediaRoleTag.assigned_project_id == project_id
            )
        if scene_id is not None:
            input_tag_query = input_tag_query.where(
                MediaRoleTag.assigned_scene_id == scene_id
            )
        if unassigned:
            input_tag_query = input_tag_query.where(
                MediaRoleTag.assigned_project_id.is_(None)
            )
        if input_kinds == {"audio"}:
            input_tag_query = input_tag_query.where(
                MediaRoleTag.media_type.like("audio/%")
            )
        elif input_kinds == {"image"}:
            input_tag_query = input_tag_query.where(
                or_(
                    MediaRoleTag.media_type.is_(None),
                    MediaRoleTag.media_type.not_like("audio/%"),
                )
            )
        input_tags = list(
            (await session.execute(input_tag_query.limit(window))).scalars().all()
        )
    for tag in input_tags:
        media_type = tag.media_type or "application/octet-stream"
        items.append(
            schemas.MediaItemRead(
                key=f"input:{tag.relative_path}",
                source="registered_input",
                kind=_media_item_kind(media_type),
                relative_path=tag.relative_path or "",
                sha256=tag.sha256 or "",
                byte_size=tag.byte_size or 0,
                media_type=media_type,
                created_at=tag.created_at,
                label=tag.file_name,
                role=tag.role,
                character_ids=list(tag.character_ids),
                reference_transcript=tag.reference_transcript,
                artifact_id=None,
                assigned_project_id=tag.assigned_project_id,
                assigned_scene_id=tag.assigned_scene_id,
                assigned_shot_id=None,
            )
        )

    # 3) Projectのキャラクター参照画像 (character_reference)。Project単位の設定の
    #    ため、project_idを指定したときだけ含める。
    if (
        project_id is not None
        and source in (None, "character_reference")
        and role in (None, "appearance_reference")
        and not artifact_only
    ):
        project = await session.get(Project, project_id)
        if project is not None:
            overrides = schemas.ProjectLocalOverrides.model_validate(
                project.local_overrides or {}
            )
            for character in overrides.characters:
                if character_id is not None and character.id != character_id:
                    continue
                for reference in character.reference_images:
                    reference_kind = _media_item_kind(reference.media_type)
                    if (
                        kind is not None and reference_kind != kind
                    ) or reference_kind in excluded_kinds:
                        continue
                    items.append(
                        schemas.MediaItemRead(
                            key=f"character:{character.id}:{reference.relative_path}",
                            source="character_reference",
                            kind=_media_item_kind(reference.media_type),
                            relative_path=reference.relative_path,
                            sha256=reference.sha256,
                            byte_size=reference.byte_size,
                            media_type=reference.media_type,
                            created_at="",
                            label=f"{character.name} / {reference.file_name}",
                            role="appearance_reference",
                            character_ids=[character.id],
                            artifact_id=None,
                            assigned_project_id=project_id,
                            assigned_scene_id=None,
                            assigned_shot_id=None,
                        )
                    )

    items.sort(key=lambda item: item.created_at, reverse=True)
    return items[offset:window]


@router.get("/artifacts/{artifact_id}", response_model=schemas.ArtifactRead)
async def get_artifact(artifact_id: str, session: SessionDep):
    artifact = await _get_or_404(session, Artifact, "Artifact", artifact_id)
    return await _artifact_read(session, artifact)


@router.get("/artifacts/{artifact_id}/content")
async def get_artifact_content(
    artifact_id: str,
    session: SessionDep,
    download: Annotated[bool, Query()] = False,
):
    """Artifactの実ファイルを配信する。候補比較のプレビューに使う。

    既定は`inline`でブラウザ内に表示し、`download=true`のときだけ`attachment`で返す。

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
    return FileResponse(
        path,
        media_type=artifact.media_type,
        filename=path.name,
        content_disposition_type="attachment" if download else "inline",
        headers={"X-Content-Type-Options": "nosniff"},
    )


@router.patch("/artifacts/{artifact_id}", response_model=schemas.ArtifactRead)
async def update_artifact_links(
    artifact_id: str, payload: schemas.ArtifactLinkUpdate, session: SessionDep
):
    """生成物のv2紐づけ(キャラクター・衣装・シーン)とメモを更新する。

    渡した項目だけ変え、`null`を渡すと外す。紐づけ先は更新後の組み合わせで検証する
    (衣装はそのキャラクターのもの、キャラクターとシーンと生成物のProjectは同じ)。
    旧UIの`assigned_*`と採否は変えない。
    """
    artifact = await _get_or_404(session, Artifact, "Artifact", artifact_id)
    provided = payload.model_fields_set
    if provided & set(story_links.LINK_FIELDS):
        merged = {
            field: getattr(payload, field)
            if field in provided
            else getattr(artifact, field)
            for field in story_links.LINK_FIELDS
        }
        await story_links.validate_story_links(
            session,
            character_id=merged["story_character_id"],
            costume_id=merged["story_costume_id"],
            scene_id=merged["story_scene_id"],
            project_id=artifact.assigned_project_id,
        )
        for field, value in merged.items():
            setattr(artifact, field, value)
    if "memo" in provided:
        artifact.memo = payload.memo
    await _commit(session)
    return await _artifact_read(session, artifact)


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


async def _purged_input_artifacts(
    session: AsyncSession, input_refs: Any
) -> list[str]:
    """入力に使った生成物のうち、記録が完全削除されて実ファイルも無いもののID。

    コピーが同じファイルを残していれば内容は取得できるため、ここでは止めない。
    パスを持たない壊れた参照は完全削除と区別できないため、再現性の検査に任せる。
    """
    refs = [
        ref
        for ref in (input_refs if isinstance(input_refs, list) else [])
        if isinstance(ref, dict)
        and ref.get("kind") == provenance.KIND_ARTIFACT
        and isinstance(ref.get("artifact_id"), str)
        and isinstance(ref.get("relative_path"), str)
    ]
    if not refs:
        return []
    existing = set(
        await session.scalars(
            select(Artifact.id).where(
                Artifact.id.in_({ref["artifact_id"] for ref in refs})
            )
        )
    )
    purged: list[str] = []
    for ref in refs:
        if ref["artifact_id"] in existing:
            continue
        try:
            await run_in_threadpool(storage.resolve_artifact, ref["relative_path"])
        except storage.StorageError:
            purged.append(ref["artifact_id"])
    return purged


async def _ensure_inputs_not_purged(
    session: AsyncSession, job: GenerationJob, input_refs: Any
) -> None:
    purged = await _purged_input_artifacts(session, input_refs)
    if purged:
        raise ApiError(
            "INPUT_ARTIFACT_PURGED",
            "入力に使った生成物が完全に削除されているため、再実行できません。",
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            details={"job_id": job.id, "artifact_ids": purged},
        )


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
            **story_links.job_story_links(origin_job),
            # 台詞の行はJobにだけある (Artifactには列が無い)。再実行・派生でも引き継ぐ。
            story_dialogue_id=origin_job.story_dialogue_id,
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
            **story_links.job_story_links(origin_job),
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
    await job_events.publish_job(job.id, job.state)
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
    await _ensure_inputs_not_purged(session, job, manifest.input_refs)

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
    await _ensure_inputs_not_purged(session, job, manifest.input_refs)

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
    media_type = payload.media_type
    if media_type.startswith("image/"):
        detected = storage.detect_image_media_type(data[:32])
        declared = "image/jpeg" if media_type == "image/jpg" else media_type
        if detected is None or detected != declared:
            raise _validation_error(
                "画像の実形式とmedia_typeが一致しません。",
                {"declared": media_type, "detected": detected},
            )
        media_type = detected
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
        media_type=media_type,
    )


@router.get("/image-references/content")
async def get_image_reference_content(
    request: Request,
    relative_path: Annotated[str, Query(min_length=1, max_length=1024)],
):
    """入力cacheの参照画像を配信する。Artifactを持たない参照画像のサムネイルに使う (#480)。

    読み出せるのは`inputs/`配下の画像だけとする。パスの解決は`storage.resolve_input`へ閉じ、
    入力cacheの外と画像以外 (ガイド音声など) は配信しない。media_typeは拡張子ではなく
    実ファイルのmagic bytesから決める。
    """
    settings = get_settings()
    media_type: str | None = None
    data = b""
    etag = ""
    try:
        path = storage.resolve_input(relative_path, settings)
        stat = path.stat()
        if stat.st_size <= settings.max_image_bytes:
            # mtimeとサイズ由来の弱いETag。一致すれば読み込まずに304を返す。
            etag = f'W/"{stat.st_mtime_ns:x}-{stat.st_size:x}"'
            candidates = {
                value.strip().removeprefix("W/")
                for value in request.headers.get("if-none-match", "").split(",")
            }
            if "*" in candidates or etag.removeprefix("W/") in candidates:
                return Response(
                    status_code=status.HTTP_304_NOT_MODIFIED,
                    headers={"ETag": etag, "Cache-Control": "private, max-age=300"},
                )
            # 判定と配信で別々にファイルを開くと差し替えに追従するため、1回の読み取りで両方を行う。
            data = await run_in_threadpool(path.read_bytes)
            # 読み込み後のstatからETagを作り直し、古いETagと新しい内容の組を避ける。
            stat = path.stat()
            etag = f'W/"{stat.st_mtime_ns:x}-{stat.st_size:x}"'
            if len(data) <= settings.max_image_bytes:
                media_type = storage.detect_image_media_type(data[:32])
    except (storage.StorageError, OSError, ValueError):
        # ValueErrorはNULを含むパスで`Path.resolve()`が送出する。
        media_type = None
    if media_type is None:
        raise ApiError(
            "IMAGE_REFERENCE_MISSING",
            "入力cacheの画像を取得できませんでした。",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    return Response(
        content=data,
        media_type=media_type,
        headers={
            "X-Content-Type-Options": "nosniff",
            "ETag": etag,
            "Cache-Control": "private, max-age=300",
            "Content-Disposition": f"inline; filename*=utf-8''{quote(path.name, safe='', errors='replace')}",
        },
    )


@router.post("/image-tags", response_model=schemas.ImageTagExtractRead)
async def extract_image_tags(payload: schemas.ImageTagExtractRequest, request: Request):
    """画像をComfyUIのWD14 Taggerへ渡し、正プロンプト用タグを返す。

    画像は`content_base64`か、入力cacheを指す`relative_path`のどちらか一方で受け取る
    (排他はスキーマで検証済み)。後者は登録済みの衣装・参照画像の読み直しに使う (#486)。
    """
    settings = get_settings()
    if payload.relative_path is not None:
        try:
            path = storage.resolve_input(payload.relative_path, settings)
            byte_size = path.stat().st_size
            if byte_size > settings.max_image_bytes:
                raise _validation_error(
                    "画像が上限を超えています。",
                    {"byte_size": byte_size, "limit": settings.max_image_bytes},
                )
            data = await run_in_threadpool(path.read_bytes)
        except (storage.StorageError, OSError, ValueError) as error:
            # ValueErrorはNULを含むパスで`Path.resolve()`が送出する。
            raise _validation_error("入力cacheの画像を読み込めません。") from error
        content_base64 = base64.b64encode(data).decode("ascii")
    else:
        content_base64 = payload.content_base64 or ""
        encoded_limit = (settings.max_image_bytes + 2) // 3 * 4
        if len(content_base64) > encoded_limit:
            raise _validation_error(
                "画像が上限を超えています。", {"limit": settings.max_image_bytes}
            )
        try:
            data = base64.b64decode(content_base64, validate=True)
        except (binascii.Error, ValueError) as error:
            raise _validation_error("content_base64を復号できません。") from error
    if not data:
        raise _validation_error("空の画像は解析できません。")
    if len(data) > settings.max_image_bytes:
        raise _validation_error(
            "画像が上限を超えています。",
            {"byte_size": len(data), "limit": settings.max_image_bytes},
        )
    try:
        tags = await ComfyUITagger(settings).extract(content_base64, payload.media_type)
    except ImageTaggerError as error:
        raise ApiError(
            "IMAGE_TAGGER_ERROR", str(error), status_code=status.HTTP_503_SERVICE_UNAVAILABLE
        ) from error
    if settings.image_tagger_refine:
        try:
            tags = await QwenTagRefiner(get_effective_settings(request)).refine(tags)
        except ImageTaggerError as error:
            # 整理は付加価値であり、抽出そのものは成功している。Remote GPU Hostでは
            # ComfyUIの生成中に推論サーバーへ接続できないため、この失敗は通常運用でも
            # 起こりうる。WD14が出したタグをそのまま返す。
            logger.info("タグの整理を省いて抽出結果を返します。(%s)", error)
    return schemas.ImageTagExtractRead(tags=tags)


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
        .where(Artifact.deleted_at.is_(None))
        .order_by(Artifact.created_at.desc(), Artifact.id.asc())
        .limit(AGENT_CONTEXT_ARTIFACT_LIMIT)
    )
    result = await session.execute(query)
    return list(result.scalars().all())


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
    if payload.kind in proposals.PROMPT_STYLE_KINDS:
        context["prompt_style"] = _prompt_style(recipe)
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


def _prompt_style(recipe: Recipe | None) -> comfyui_workflow.PromptStyle:
    """prompt案の書き方。Recipeが指すテンプレートで決め、無ければ既定のAnimaとする。"""
    reference = recipe.workflow_template_ref if recipe is not None else None
    template_name = reference.get("name") if isinstance(reference, dict) else None
    return comfyui_workflow.prompt_style_of(template_name) or "anima"


async def _prompt_guidance(
    kind: str, instruction: str, context: dict[str, Any]
) -> str:
    """prompt案を持つ種別へ、novel-writerの資産から抜き出した作法と既存promptを添える。

    読んだファイルの相対パスを`context`へ残し、提案の履歴から根拠を辿れるようにする。
    本文は履歴へ残さない。
    """
    style = context.get("prompt_style")
    if kind not in proposals.PROMPT_STYLE_KINDS or style is None:
        return ""
    hint = "\n".join([instruction, json.dumps(context, ensure_ascii=False)])
    guidance = await run_in_threadpool(
        prompt_assets.load_guidance,
        get_settings().novel_writer_root,
        style,
        hint,
        has_rationale=kind in proposals.RATIONALE_KINDS,
    )
    if guidance is None:
        return ""
    context["prompt_assets"] = list(guidance.sources)
    return guidance.text


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


#: 操作を1件だけ持つ提案の種別。既存のApplication APIはこの種別だけを受け付ける。
SINGLE_OPERATION_KINDS = ("image_prompt",)


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


def _proposal_image_from_bytes(data: bytes, media_type: str) -> agent_base.ProposalImage:
    """バイト列を検証済みの``ProposalImage``へ変換する。

    base64復号後の画像と、Artifactの実ファイルから読んだ画像の両方が通る共通チェック。
    """
    limit = get_settings().agent_max_image_bytes
    if not data:
        raise _validation_error("空の画像は添付できません。")
    if len(data) > limit:
        raise _validation_error(
            "添付画像が上限を超えています。",
            {"byte_size": len(data), "limit": limit},
        )
    detected = storage.detect_image_media_type(data[:32])
    if detected != media_type:
        raise _validation_error(
            "添付画像の実形式とmedia_typeが一致しません。別の画像を選び直してください。",
            {"declared": media_type, "detected": detected},
        )
    return agent_base.ProposalImage(data=data, media_type=media_type)


def _decode_assist_image(
    image: schemas.ImagePromptAssistImage,
) -> agent_base.ProposalImage:
    """プロンプト補完へ添付する画像を復号し、上限を確かめる。"""
    limit = get_settings().agent_max_image_bytes
    # 復号の前に文字数で弾く。base64は3バイトを4文字で表すため、文字数から上限を逆算する。
    if len(image.content_base64) > (limit + 2) // 3 * 4:
        raise _validation_error("添付画像が上限を超えています。", {"limit": limit})
    try:
        data = base64.b64decode(image.content_base64, validate=True)
    except (binascii.Error, ValueError) as error:
        raise _validation_error("content_base64を復号できません。") from error
    return _proposal_image_from_bytes(data, image.media_type)


@router.post(
    "/image-prompt-assists",
    response_model=schemas.ImagePromptAssistRead,
)
async def assist_image_prompt(
    payload: schemas.ImagePromptAssistCreate,
    session: SessionDep,
    providers: AgentProvidersDep,
):
    """日本語の説明を、SceneやShotに依存しない画像promptへ補完する。

    Providerへ渡す出力Schemaと応答検証は既存の``image_prompt``提案と共有する。
    Job、Artifact、Proposal履歴を作らないため、この結果をフォームへ反映しても生成は
    利用者が明示的に投入するまで始まらない。

    画像を添付した場合は、画像と現在のpromptを突き合わせて直した案を返す。画像に
    対応しないProviderへは送らず、``AGENT_IMAGE_UNSUPPORTED``で理由を返す。

    ``recipe_id``を渡すと、そのRecipeのモデルに合う書き方 (タグ型か、タグと自然文の
    併用か) で返す。novel-writerの場所が設定されていれば、その作法と既存promptを添える。
    """
    provider = _resolve_agent_provider(providers, payload.provider_id)
    recipe: Recipe | None = None
    if payload.recipe_id is not None:
        recipe = await _get_or_404(session, Recipe, "Recipe", payload.recipe_id)
    images: tuple[agent_base.ProposalImage, ...] = ()
    if payload.image is not None:
        if not provider.supports_images:
            raise ApiError(
                "AGENT_IMAGE_UNSUPPORTED",
                f"{provider.label}は画像の入力に対応していません。"
                "画像に対応するAIを選んでください。",
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        images = (_decode_assist_image(payload.image),)
    return await _assist_image_prompt(
        provider,
        recipe,
        payload.instruction,
        payload.current_positive_prompt,
        payload.current_negative_prompt,
        images,
        payload.context_tags,
    )


async def _assist_image_prompt(
    provider: AgentProvider,
    recipe: Recipe | None,
    instruction: str,
    current_positive_prompt: str,
    current_negative_prompt: str,
    images: tuple[agent_base.ProposalImage, ...],
    context_tags: Sequence[str] = (),
) -> schemas.ImagePromptAssistRead:
    """画像promptの補完・修正を1回実行する。

    `context_tags`は別の欄から既に入るタグ。LLMへ文脈として渡し、結果からも決定的に除く。
    """
    context: dict[str, Any] = {
        key: value
        for key, value in (
            ("current_positive_prompt", current_positive_prompt),
            ("current_negative_prompt", current_negative_prompt),
        )
        if value.strip()
    }
    if context_tags:
        context["context_tags"] = list(context_tags)
    context["prompt_style"] = _prompt_style(recipe)
    guidance = await _prompt_guidance("image_prompt", instruction, context)
    request = agent_base.ProposalRequest(
        kind="image_prompt",
        instruction=instruction,
        context=context,
        images=images,
        guidance=guidance,
    )

    async def postprocess(result: agent_base.ProposalResult) -> dict[str, Any]:
        # Providerは検証とtag_line、positive_promptの組み立てを済ませて返す。ここで検証
        # し直すと、組み立てた派生項目が余計なキーとして拒否される。
        output = result.output
        if current_positive_prompt.strip() and not images:
            # 画像を添えたときは画像から直す点を探すため、タグの増減を画像に任せる。
            # 書き方の整形より先に行う。消えたタグを戻す前に、内容のタグが無いとして
            # 弾かないためである。作り直させた回も、利用者の元の指示で照らし合わせる。
            output = proposals.revise_current_prompt(
                output,
                current_positive_prompt,
                instruction,
                await _character_tags(),
            )
        # 現在のpromptにあった辞書外のタグは、利用者が付けたものとして外さない。
        output = proposals.normalize_prompt_tags(
            "image_prompt",
            output,
            await _canonical_tag_names(),
            context["prompt_style"],
            keep_tags={
                tag_preflight.normalize_tag(tag)
                for tag in tag_preflight.split_prompt(current_positive_prompt)
            },
        )
        return proposals.apply_prompt_style(
            "image_prompt", output, context["prompt_style"]
        )

    try:
        checked = await prompt_retry.propose_checked(
            provider,
            request,
            postprocess,
            enabled=get_settings().agent_prompt_retry_enabled,
        )
    except agent_base.AgentError as error:
        raise _agent_error(error) from error
    if checked.retry is not None:
        # 補完は提案の履歴を作らないため、作り直させたことはログにだけ残す。
        logger.info("画像promptの補完を作り直させた: %s", checked.retry)
    # 補完タグと重なるタグはLLM任せにせず除く。差分は除いたあとの案で取る。
    # 書き方の整形で自然文が落ちることもあるため、整形後の案で差分を取る。
    output = proposals.describe_prompt_changes(
        proposals.drop_context_tags(checked.output, context_tags),
        current_positive_prompt,
    )
    confidence_blocks = proposals.build_tag_confidence_blocks(output)
    return schemas.ImagePromptAssistRead(
        positive_prompt=output["positive_prompt"],
        tag_line=output.get("tag_line", ""),
        natural_text=output.get("natural_text", ""),
        negative_prompt=proposals.merge_negative_prompt(
            proposals.DEFAULT_NEGATIVE_PROMPT, output.get("negative_prompt", "")
        ),
        tag_glosses=output.get("tag_glosses", []),
        tag_changes=output["tag_changes"],
        natural_text_change=output["natural_text_change"],
        tag_confidence_blocks=schemas.ImagePromptTagConfidenceBlocks(
            **confidence_blocks
        ),
        provider_id=provider.id,
        model=checked.model,
    )


async def _propose_assist(
    provider: AgentProvider, request: agent_base.ProposalRequest
) -> agent_base.ProposalResult:
    """フォームの補完を1件求める。Providerの失敗はAPIの失敗へ変換する。

    Providerは応答の検証を済ませて返すため、ここでは検証し直さない。
    """
    try:
        return await provider.propose(request)
    except agent_base.AgentError as error:
        raise _agent_error(error) from error


@router.post(
    "/video-prompt-assists",
    response_model=schemas.VideoPromptAssistRead,
)
async def assist_video_prompt(
    payload: schemas.MediaPromptAssistCreate,
    providers: AgentProvidersDep,
):
    """日本語の説明を、動きとカメラワークを含む動画promptへ補完する。

    画像の補完と同じく、Job、Artifact、Proposal履歴を作らない。
    """
    provider = _resolve_agent_provider(providers, payload.provider_id)
    result = await _propose_assist(
        provider,
        agent_base.ProposalRequest(
            kind="video_prompt", instruction=payload.instruction
        ),
    )
    return schemas.VideoPromptAssistRead(
        prompt=result.output["prompt"],
        rationale=result.output["rationale"],
        provider_id=provider.id,
        model=result.model,
    )


@router.post(
    "/music-prompt-assists",
    response_model=schemas.MusicPromptAssistRead,
)
async def assist_music_prompt(
    payload: schemas.MediaPromptAssistCreate,
    providers: AgentProvidersDep,
):
    """日本語の説明を、BGMのmoodとgenreのタグへ補完する。

    画像の補完と同じく、Job、Artifact、Proposal履歴を作らない。
    """
    provider = _resolve_agent_provider(providers, payload.provider_id)
    result = await _propose_assist(
        provider,
        agent_base.ProposalRequest(
            kind="music_prompt", instruction=payload.instruction
        ),
    )
    return schemas.MusicPromptAssistRead(
        mood=result.output["mood"],
        genre=result.output["genre"],
        rationale=result.output["rationale"],
        provider_id=provider.id,
        model=result.model,
    )


@router.post(
    "/voice-caption-assists",
    response_model=schemas.VoiceCaptionAssistRead,
)
async def assist_voice_caption(
    payload: schemas.VoiceCaptionAssistCreate,
    providers: AgentProvidersDep,
    session: SessionDep,
):
    """演技指示とキャラクターの性格・設定を、音声の声質の文章 (caption) へ変換する。

    画像の補完と同じく、Job、Artifact、Proposal履歴を作らない。キャラクターは存在と
    ゴミ箱のProjectを確かめ、名前と性格・設定だけを許可リストで入力へ含める。
    """
    context: dict[str, Any] = {}
    if payload.story_character_id is not None:
        character = await session.get(StoryCharacter, payload.story_character_id)
        if character is None:
            raise ApiError(
                "STORY_CHARACTER_NOT_FOUND",
                "紐づけ先のキャラクターがありません。",
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                details={"story_character_id": payload.story_character_id},
            )
        # ゴミ箱のProjectのキャラを弾く。存在は上で確かめ済み。
        await story_links.validate_story_links(
            session,
            character_id=character.id,
            costume_id=None,
            scene_id=None,
        )
        context["character"] = {"name": character.name}
        if character.profile.strip():
            context["character"]["profile"] = character.profile
    provider = _resolve_agent_provider(providers, payload.provider_id)
    result = await _propose_assist(
        provider,
        agent_base.ProposalRequest(
            kind="voice_caption", instruction=payload.instruction, context=context
        ),
    )
    return schemas.VoiceCaptionAssistRead(
        caption=result.output["caption"],
        rationale=result.output["rationale"],
        provider_id=provider.id,
        model=result.model,
    )


