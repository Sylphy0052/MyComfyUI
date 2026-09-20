"""ComfyUI JobのRecipe検証とWorkflow組み立て。

`routers`から呼ばれ、実行スナップショットとManifestへ残す値を返す。ComfyUIの
テンプレート名とノードの知識はここから先(`workflow`モジュール)に閉じる。
"""

from typing import Any

from mycomfyui_api.adapters.comfyui import workflow as workflow_module
from mycomfyui_api.execution import (
    PreparationContext,
    PreparationError,
    PreparedExecution,
)
from mycomfyui_api.models import Recipe


def resolve_template_name(recipe: Recipe) -> str:
    """Recipeが指すWorkflowテンプレートを許可済み一覧から解決する。

    利用者入力から任意のJSONを実行させないため、参照できるのは同梱テンプレートだけ
    とする。`sha256`を持つ参照は、指している版が同梱物と一致することまで確かめる。
    """
    reference = recipe.workflow_template_ref
    if not isinstance(reference, dict):
        raise PreparationError("Recipeのworkflow_template_refが不正です。")
    name = reference.get("name")
    if not isinstance(name, str) or name not in workflow_module.ALLOWED_TEMPLATES:
        raise PreparationError(
            "許可されていないWorkflowテンプレートです。",
            {"name": name, "allowed": sorted(workflow_module.ALLOWED_TEMPLATES)},
        )
    expected = reference.get("sha256")
    if isinstance(
        expected, str
    ) and expected.lower() != workflow_module.template_digest(name):
        raise PreparationError(
            "Workflowテンプレートの内容が参照と一致しません。", {"name": name}
        )
    return name


def validate_against_input_schema(
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
        raise PreparationError(
            "Recipeのinput_schemaがWorkflowに無い変数を指しています。",
            {"template": template_name, "unknown": sorted(undefined)},
        )
    rejected = set(inputs) - set(schema)
    if rejected:
        raise PreparationError(
            "このRecipeで指定できない変数です。",
            {"rejected": sorted(rejected), "allowed": sorted(schema)},
        )
    malformed = sorted(
        name for name, spec in schema.items() if not isinstance(spec, dict | str)
    )
    if malformed:
        # 必須指定は`{"required": true}`で書く。`true`のような書き間違いを黙って
        # 読み飛ばすと、必須チェックが効かないまま動いてしまう。
        raise PreparationError(
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
        raise PreparationError(
            "Recipeが必須とする変数が不足しています。", {"missing": sorted(missing)}
        )


async def prepare(
    recipe: Recipe, inputs: dict[str, Any], context: PreparationContext
) -> PreparedExecution:
    """Recipeの既定値と要求の`inputs`をマージし、投入用Workflowを組み立てる。

    `context`はScene/Shot本文を持つが、ComfyUI Jobでは使わない。呼び出し元を
    engineごとに分岐させないため、引数だけ受け取る。
    """
    template_name = resolve_template_name(recipe)
    defaults = recipe.defaults if isinstance(recipe.defaults, dict) else {}
    values: dict[str, Any] = {**defaults, **inputs}
    validate_against_input_schema(recipe, template_name, inputs, values)
    try:
        prepared = workflow_module.build_workflow(template_name, values)
    except workflow_module.WorkflowError as error:
        raise PreparationError(str(error), {"template": template_name}) from error
    return PreparedExecution(
        snapshot=prepared.workflow,
        seed=prepared.seed,
        resolved_prompt=prepared.resolved_prompt,
        model=dict(prepared.model),
        parameters={
            **prepared.parameters,
            "workflow_template": prepared.template_name,
            "workflow_template_sha256": prepared.template_sha256,
        },
        input_refs=[],
    )
