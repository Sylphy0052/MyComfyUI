"""engineからExecutorと準備処理を引くレジストリ。

`routers`と`main`はengineの種類を直接知らない。Recipeの`engine`でここを引き、
Jobの組み立てと実行の両方を差し込む。音声Jobも画像Jobと同じ`JobQueueWorker`の
キューへ積まれるため、同一GPUを共有する構成でも同時に実行されない。

動画と音楽はComfyUIの同じプロセスで動くため、engineは`comfyui`のままRecipeの`kind`
とテンプレート名で区別する。合成だけはGPUを使わず実行基盤も別のため、`ffmpeg`を
engineとして分ける。
"""

import asyncio
import json
import logging
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from mycomfyui_api.adapters.comfyui import prepare as comfyui_prepare
from mycomfyui_api.adapters.comfyui import workflow as comfyui_workflow
from mycomfyui_api.adapters.comfyui.executor import ENGINE_COMFYUI, ComfyUIExecutor
from mycomfyui_api.adapters.compose import plan as compose_plan
from mycomfyui_api.adapters.compose.executor import ComposeExecutor
from mycomfyui_api.adapters.compose.plan import ENGINE_FFMPEG
from mycomfyui_api.adapters.voice import plan as voice_plan
from mycomfyui_api.adapters.voice.base import VOICE_ENGINES
from mycomfyui_api.adapters.voice.executor import VoiceExecutor
from mycomfyui_api.execution import (
    PreparationContext,
    PreparationError,
    PreparedExecution,
)
from mycomfyui_api.models import GenerationJob, GenerationManifest
from mycomfyui_api.queue import ExecutionOutcome, JobExecutor
from mycomfyui_api.settings import Settings, get_settings

logger = logging.getLogger(__name__)

#: 自動採番を表すseedの値。engineを直接知らない呼び出し元がここから引く。
AUTO_SEED = comfyui_workflow.AUTO_SEED

FAILURE_CODE_ENGINE_UNSUPPORTED = "ENGINE_UNSUPPORTED"
FAILURE_CODE_INPUT_UNRESOLVED = "INPUT_UNRESOLVED"

#: engineごとの準備処理。Recipeと入力から実行スナップショットを組み立てる。
PREPARERS = {
    ENGINE_COMFYUI: comfyui_prepare.prepare,
    ENGINE_FFMPEG: compose_plan.prepare,
    **{engine: voice_plan.prepare for engine in VOICE_ENGINES},
}

#: 実行可能なengine。Recipeの`engine`がここに無ければJobを作らない。
SUPPORTED_ENGINES: tuple[str, ...] = tuple(PREPARERS)


def is_supported(engine: str) -> bool:
    return engine in PREPARERS


async def prepare(
    recipe: Any, inputs: dict[str, Any], context: PreparationContext
) -> PreparedExecution:
    """Recipeのengineに対応する準備処理を呼ぶ。"""
    preparer = PREPARERS.get(recipe.engine)
    if preparer is None:
        raise PreparationError(
            f"未対応の実行Backendです: {recipe.engine}",
            {"engine": recipe.engine, "supported": list(SUPPORTED_ENGINES)},
        )
    return await preparer(recipe, inputs, context)


def workflow_defaults(recipe: Any) -> dict[str, Any]:
    """Recipeが指すWorkflowテンプレートに書かれた既定値を返す。

    投入前プレビューが差分の基準に使う。テンプレートファイルを持たないengine
    (音声・合成)は既定値の定義を持たないため、空のまま返す。
    """
    if recipe.engine != ENGINE_COMFYUI:
        return {}
    try:
        template_name = comfyui_prepare.resolve_template_name(recipe)
        return comfyui_workflow.template_defaults(template_name)
    except (
        PreparationError,
        comfyui_workflow.WorkflowError,
        json.JSONDecodeError,
    ):
        # 既定値を引けないこと自体は準備処理が同じ理由で拒否する。差分の基準が
        # 無いだけとして扱い、ここでは失敗させない。
        return {}


class ExecutorRegistry:
    """Manifestの`engine`で実行Adapterを選ぶ`JobExecutor`。

    Executorは最初に必要になったときだけ作り、以後は使い回す。生成の直前に接続を
    張る実装のため、未使用のBackendへ接続を試みることはない。
    """

    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        *,
        settings: Settings | None = None,
    ) -> None:
        self._session_factory = session_factory
        self._settings = settings or get_settings()
        self._executors: dict[str, JobExecutor] = {}

    async def run(
        self, job: GenerationJob, cancel_event: asyncio.Event
    ) -> ExecutionOutcome:
        engine = await self._engine_of(job)
        if engine is None:
            return ExecutionOutcome(
                succeeded=False,
                failure_code=FAILURE_CODE_INPUT_UNRESOLVED,
                failure_stage="backend_start",
                failure_message="JobのManifestが見つかりません。",
                retryable=False,
            )
        executor = self._executor(engine)
        if executor is None:
            return ExecutionOutcome(
                succeeded=False,
                failure_code=FAILURE_CODE_ENGINE_UNSUPPORTED,
                failure_stage="backend_start",
                failure_message=f"未対応の実行Backendです: {engine}",
                retryable=False,
            )
        return await executor.run(job, cancel_event)

    async def _engine_of(self, job: GenerationJob) -> str | None:
        async with self._session_factory() as session:
            manifest = await session.get(GenerationManifest, job.manifest_id)
            if manifest is None:
                return None
            return manifest.engine

    def _executor(self, engine: str) -> JobExecutor | None:
        existing = self._executors.get(engine)
        if existing is not None:
            return existing
        if engine == ENGINE_COMFYUI:
            created: JobExecutor = ComfyUIExecutor(
                self._session_factory, settings=self._settings
            )
        elif engine == ENGINE_FFMPEG:
            created = ComposeExecutor(self._session_factory, settings=self._settings)
        elif engine in VOICE_ENGINES:
            created = VoiceExecutor(self._session_factory, settings=self._settings)
        else:
            logger.warning("未対応のengineのJobを受け取りました。engine=%s", engine)
            return None
        self._executors[engine] = created
        return created
