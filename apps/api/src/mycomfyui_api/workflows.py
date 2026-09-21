"""登録済みWorkflowとその版の定義。

Workflow本体は同梱テンプレートとAdapterの実装であり、この表はその登録簿にあたる。
変数定義、対応モデル、入出力、版を実装から組み立てて登録するため、表へ行を足しても
実行できるWorkflowは増えない。利用者入力から任意のJSONを実行させない制約は
`adapters/comfyui/prepare.resolve_template_name`の許可リストで維持する。

版の判定は、テンプレートファイルを持つComfyUI系がそのSHA-256、テンプレートを持たない
音声と合成がスナップショットの版番号による。RecipeがどのWorkflow版を指すかは
`Recipe.workflow_version_id`で表す。
"""

import logging
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from mycomfyui_api import schemas
from mycomfyui_api.adapters.comfyui import prepare as comfyui_prepare
from mycomfyui_api.adapters.comfyui import workflow as workflow_module
from mycomfyui_api.adapters.comfyui.executor import ENGINE_COMFYUI
from mycomfyui_api.adapters.compose import plan as compose_plan
from mycomfyui_api.adapters.voice import plan as voice_plan
from mycomfyui_api.adapters.voice.base import VOICE_ENGINES
from mycomfyui_api.models import Recipe, Workflow, WorkflowVersion

logger = logging.getLogger(__name__)

#: 音声Recipeが指す実行スナップショットの形。ComfyUIのテンプレートに当たる。
VOICE_TEMPLATE_NAME = "voice_runner_request"

#: 出力ノードのclass_typeと、そこから生まれるArtifactの種別。
_OUTPUT_NODE_KINDS: dict[str, str] = {
    "SaveImage": "image",
    "SaveVideo": "video",
    "SaveAudio": "audio",
}

#: 同梱テンプレートの生成種別。`Recipe.kind`と揃える。
_COMFYUI_KINDS: dict[str, str] = {
    "anima_txt2img": "image",
    "minimax_h3_ref2v": "video",
    "minimax_h3_i2v": "video",
    "ace_step_bgm": "music",
}


@dataclass(frozen=True)
class WorkflowDefinition:
    """登録するWorkflow 1件と、その最新版の中身。"""

    name: str
    kind: str
    engines: tuple[str, ...]
    version: str
    template_sha256: str | None
    variables: dict[str, Any]
    model_slots: list[dict[str, Any]]
    inputs: list[dict[str, Any]]
    outputs: list[dict[str, Any]]


def _comfyui_definition(name: str) -> WorkflowDefinition:
    """同梱テンプレートのbindingから、登録する定義を組み立てる。"""
    binding = workflow_module.ALLOWED_TEMPLATES[name]
    variables: dict[str, Any] = {
        variable_name: {
            "value_type": ref.value_type,
            "required": ref.required,
            "role": ref.role,
            "node_id": binding.nodes[ref.role].node_id,
            "input_key": ref.input_key,
            "source": "workflow",
        }
        for variable_name, ref in binding.variables.items()
    }
    kind = _COMFYUI_KINDS[name]
    if kind == "video":
        # テンプレート変数ではないが、Adapterが解釈して素材とノード構成へ反映する。
        for extra in sorted(comfyui_prepare.VIDEO_EXTRA_INPUTS):
            variables[extra] = {
                "value_type": "object",
                "required": False,
                "source": "adapter",
            }
    inputs = [
        {
            "name": variable_name,
            "value_type": ref.value_type,
            "node_id": binding.nodes[ref.role].node_id,
            "input_key": ref.input_key,
        }
        for variable_name, ref in binding.variables.items()
        if ref.value_type in workflow_module.UPLOAD_VALUE_TYPES
    ]
    outputs = [
        {"kind": _OUTPUT_NODE_KINDS[node.class_type], "node_id": node.node_id}
        for node in binding.nodes.values()
        if node.class_type in _OUTPUT_NODE_KINDS
    ]
    return WorkflowDefinition(
        name=name,
        kind=kind,
        engines=(ENGINE_COMFYUI,),
        version=workflow_module.template_digest(name),
        template_sha256=workflow_module.template_digest(name),
        variables=variables,
        model_slots=[
            {
                "variable": slot.variable,
                "node_class": slot.node_class,
                "option_field": slot.option_field,
            }
            for slot in binding.model_slots
        ],
        inputs=inputs,
        outputs=outputs,
    )


def _voice_definition() -> WorkflowDefinition:
    """音声Adapterの定義。テンプレートファイルを持たないため版は番号で表す。"""
    return WorkflowDefinition(
        name=VOICE_TEMPLATE_NAME,
        kind="voice",
        engines=VOICE_ENGINES,
        version=str(voice_plan.SNAPSHOT_VERSION),
        template_sha256=None,
        variables={
            name: dict(spec, source="adapter")
            for name, spec in voice_plan.VOICE_VARIABLES.items()
        },
        model_slots=[],
        inputs=[
            {
                "name": "voices",
                "value_type": "voice_bindings",
                "fields": sorted(voice_plan.VOICE_BINDING_NAMES),
            }
        ],
        outputs=[{"kind": "audio"}],
    )


def _compose_definition() -> WorkflowDefinition:
    """合成Adapterの定義。入力は手元のArtifactと数値だけとする。"""
    return WorkflowDefinition(
        name=compose_plan.COMPOSE_TEMPLATE_NAME,
        kind="compose",
        engines=(compose_plan.ENGINE_FFMPEG,),
        version=str(compose_plan.SNAPSHOT_VERSION),
        template_sha256=None,
        variables={
            name: dict(spec, source="adapter")
            for name, spec in compose_plan.COMPOSE_VARIABLES.items()
        },
        model_slots=[],
        inputs=[
            {"name": "video", "value_type": "artifact_ref"},
            {
                "name": "voices",
                "value_type": "voice_tracks",
                "fields": sorted(compose_plan.VOICE_TRACK_NAMES),
            },
            {
                "name": "bgm",
                "value_type": "bgm_track",
                "fields": sorted(compose_plan.BGM_TRACK_NAMES),
            },
        ],
        outputs=[
            {"kind": "video", "media_type": compose_plan.OUTPUT_MEDIA_TYPE},
        ],
    )


def definitions() -> list[WorkflowDefinition]:
    """登録するWorkflowの定義を、実装から組み立てて返す。

    `_COMFYUI_KINDS`と`ALLOWED_TEMPLATES`は別のモジュールで定義しているため、片方だけ
    更新すると添字アクセスが生のKeyErrorで落ちる。起動時に原因を読み取れるよう、
    先に両者の食い違いを検出して落とす。
    """
    unregistered = set(workflow_module.ALLOWED_TEMPLATES) - set(_COMFYUI_KINDS)
    missing_template = set(_COMFYUI_KINDS) - set(workflow_module.ALLOWED_TEMPLATES)
    if unregistered or missing_template:
        raise workflow_module.WorkflowError(
            "登録簿とWorkflowテンプレートの定義が食い違っています: "
            f"生成種別が未登録={sorted(unregistered)}, "
            f"テンプレートが無い={sorted(missing_template)}"
        )
    built = [_comfyui_definition(name) for name in sorted(_COMFYUI_KINDS)]
    built.append(_voice_definition())
    built.append(_compose_definition())
    return built


def allowed_model_slots() -> frozenset[tuple[str, str]]:
    """同梱Workflowが宣言する(node class, option field)の許可集合。"""
    return frozenset(
        (slot["node_class"], slot["option_field"])
        for definition in definitions()
        for slot in definition.model_slots
    )


async def ensure_workflows(session: AsyncSession) -> dict[str, WorkflowVersion]:
    """登録済みWorkflowと版を最新化し、Workflow名から最新版への対応を返す。

    既存の版は書き換えず、内容が変わったときだけ新しい版を足す。Recipeが指している
    版を後から書き換えると、過去のJobがどの定義で実行されたか追えなくなる。
    """
    latest: dict[str, WorkflowVersion] = {}
    created = 0
    for definition in definitions():
        workflow = await _get_or_create_workflow(session, definition)
        version = await _get_version(session, workflow.id, definition.version)
        if version is None:
            version = WorkflowVersion(
                id=schemas.new_id(),
                workflow_id=workflow.id,
                version=definition.version,
                template_sha256=definition.template_sha256,
                variables=definition.variables,
                model_slots=definition.model_slots,
                inputs=definition.inputs,
                outputs=definition.outputs,
                created_at=schemas.now_iso(),
            )
            session.add(version)
            created += 1
        latest[definition.name] = version
    if created:
        await session.commit()
        logger.info("Workflowの版を%d件登録しました。", created)
    backfilled = await backfill_recipe_versions(session)
    if backfilled:
        logger.info("既存Recipeへ%d件のWorkflow版を結びました。", backfilled)
    return latest


async def backfill_recipe_versions(session: AsyncSession) -> int:
    """レジストリ導入前に作られたRecipeへ、参照から解決した版を後から結ぶ。

    既存Recipeは`workflow_template_ref`しか持たないため、そのままでは画面がどの版を
    使っているか判別できない。結ぶのは`workflow_version_id`だけで、Recipeの他の項目は
    書き換えない。解決できない参照はNULLのまま残す。
    """
    result = await session.execute(
        select(Recipe).where(Recipe.workflow_version_id.is_(None))
    )
    updated = 0
    for recipe in result.scalars().all():
        version_id = await resolve_version_id(session, recipe.workflow_template_ref)
        if version_id is None:
            continue
        recipe.workflow_version_id = version_id
        updated += 1
    if updated:
        await session.commit()
    return updated


async def resolve_version_id(session: AsyncSession, template_ref: Any) -> str | None:
    """`workflow_template_ref`が指す登録済みWorkflow版のIDを返す。

    レジストリ導入前の形で作られたRecipeも受け付けるため、解決できなければNoneを
    返す。版の表し方はWorkflowにより`sha256`と`version`へ分かれるため、テンプレート
    ファイルを持つ版を先に見る`sha256`を優先し、見つからなければ`version`で引く。
    先に見た側で決めるのは、両方を一度に突き合わせると別の版の値とたまたま一致した
    ときに取り違えるためである。
    """
    if not isinstance(template_ref, dict):
        return None
    name = template_ref.get("name")
    if not isinstance(name, str):
        return None
    result = await session.execute(select(Workflow).where(Workflow.name == name))
    workflow = result.scalar_one_or_none()
    if workflow is None:
        return None
    for key in ("sha256", "version"):
        value = template_ref.get(key)
        if value is None:
            continue
        result = await session.execute(
            select(WorkflowVersion).where(
                WorkflowVersion.workflow_id == workflow.id,
                WorkflowVersion.version == str(value),
            )
        )
        version = result.scalar_one_or_none()
        if version is not None:
            return version.id
    return None


async def load_version(
    session: AsyncSession, workflow_version_id: str
) -> tuple[Workflow, WorkflowVersion] | None:
    """Workflow版と、それが属するWorkflowを引く。見つからなければNoneを返す。"""
    result = await session.execute(
        select(Workflow, WorkflowVersion)
        .join(WorkflowVersion, WorkflowVersion.workflow_id == Workflow.id)
        .where(WorkflowVersion.id == workflow_version_id)
    )
    row = result.first()
    return None if row is None else (row[0], row[1])


async def _get_or_create_workflow(
    session: AsyncSession, definition: WorkflowDefinition
) -> Workflow:
    result = await session.execute(
        select(Workflow).where(Workflow.name == definition.name)
    )
    workflow = result.scalar_one_or_none()
    if workflow is not None:
        return workflow
    workflow = Workflow(
        id=schemas.new_id(),
        name=definition.name,
        kind=definition.kind,
        engines=list(definition.engines),
        created_at=schemas.now_iso(),
    )
    session.add(workflow)
    # 版を足す前にWorkflowのIDを確定させる。同一トランザクション内で参照するため、
    # commitまでは進めずflushだけ行う。
    await session.flush()
    return workflow


async def _get_version(
    session: AsyncSession, workflow_id: str, version: str
) -> WorkflowVersion | None:
    result = await session.execute(
        select(WorkflowVersion).where(
            WorkflowVersion.workflow_id == workflow_id,
            WorkflowVersion.version == version,
        )
    )
    return result.scalar_one_or_none()
