"""ComfyUIでJobを実行する`JobExecutor`実装。

キューワーカーから1件ずつ呼ばれる。ComfyUI固有の失敗をMyComfyUIの`failure_stage`と
`failure_code`へ翻訳し、出力をArtifactとして保存するところまでを担う。
"""

import hashlib
import json
import logging
import mimetypes
from asyncio import Event
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from mycomfyui_api import schemas, storage
from mycomfyui_api.adapters.comfyui import workflow as workflow_module
from mycomfyui_api.adapters.comfyui.client import (
    BackendDisconnected,
    ComfyUIClient,
    ComfyUIUnavailable,
    ExecutionFailed,
    ExecutionTimeout,
    ImageRef,
    InterruptFailed,
    OutputNotFound,
    WaitResult,
    WorkflowRejected,
)
from mycomfyui_api.models import Artifact, GenerationJob, GenerationManifest, Recipe
from mycomfyui_api.queue import ExecutionOutcome
from mycomfyui_api.settings import Settings, get_settings

logger = logging.getLogger(__name__)

ENGINE_COMFYUI = "comfyui"

FAILURE_BACKEND_UNAVAILABLE = "BACKEND_UNAVAILABLE"
FAILURE_MODEL_NOT_FOUND = "MODEL_NOT_FOUND"
FAILURE_INPUT_UNRESOLVED = "INPUT_UNRESOLVED"
FAILURE_WORKFLOW_REJECTED = "WORKFLOW_REJECTED"
FAILURE_EXECUTION_FAILED = "EXECUTION_FAILED"
FAILURE_OUTPUT_NOT_FOUND = "OUTPUT_NOT_FOUND"
FAILURE_ARTIFACT_WRITE_FAILED = "ARTIFACT_WRITE_FAILED"
FAILURE_BACKEND_DISCONNECTED = "BACKEND_DISCONNECTED"
FAILURE_EXECUTION_TIMEOUT = "EXECUTION_TIMEOUT"
FAILURE_INTERRUPT_FAILED = "INTERRUPT_FAILED"


class _PreflightError(Exception):
    """投入前の検証で失敗した。`failure_code`まで決まっている。"""

    def __init__(self, code: str, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable


@dataclass(frozen=True)
class _JobContext:
    """実行に必要な、DBから読んだ値の組。"""

    job_id: str
    manifest_id: str
    template_name: str
    model: dict[str, str]
    workflow: dict[str, object]


class ComfyUIExecutor:
    """ComfyUIへWorkflowを投入し、出力をArtifactとして保存する。"""

    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        *,
        settings: Settings | None = None,
        client_factory=ComfyUIClient,
    ) -> None:
        self._session_factory = session_factory
        self._settings = settings or get_settings()
        self._client_factory = client_factory

    async def run(self, job: GenerationJob, cancel_event: Event) -> ExecutionOutcome:
        try:
            context = await self._load_context(job)
        except _PreflightError as error:
            return _failed(error.code, "backend_start", error.message, error.retryable)

        client = self._client_factory(self._settings)
        try:
            return await self._execute(client, context, cancel_event)
        finally:
            await client.aclose()

    async def _execute(
        self, client: ComfyUIClient, context: _JobContext, cancel_event: Event
    ) -> ExecutionOutcome:
        try:
            status = await client.status()
        except ComfyUIUnavailable as error:
            return _failed(
                FAILURE_BACKEND_UNAVAILABLE,
                "backend_start",
                f"ComfyUIへ接続できません: {client.base_url}",
                retryable=True,
                error=error,
            )
        await self._record_engine_version(context.manifest_id, status.version)

        try:
            await self._verify_models(client, context)
        except _PreflightError as error:
            return _failed(error.code, "backend_start", error.message, error.retryable)
        except ComfyUIUnavailable as error:
            return _failed(
                FAILURE_BACKEND_UNAVAILABLE,
                "backend_start",
                f"ComfyUIへ接続できません: {client.base_url}",
                retryable=True,
                error=error,
            )

        if cancel_event.is_set():
            # 投入前に取消要求が届いていれば、ComfyUIへ何も送らずに止める。
            return ExecutionOutcome(succeeded=False, stop_confirmed=True)

        try:
            prompt_id = await client.submit(context.workflow)
        except WorkflowRejected as error:
            return _failed(
                FAILURE_WORKFLOW_REJECTED, "backend_start", str(error), retryable=False
            )
        except ComfyUIUnavailable as error:
            return _failed(
                FAILURE_BACKEND_UNAVAILABLE,
                "backend_start",
                f"ComfyUIへ接続できません: {client.base_url}",
                retryable=True,
                error=error,
            )

        try:
            result = await client.wait_for_completion(
                prompt_id,
                cancel_event=cancel_event,
                timeout=self._settings.comfyui_timeout_seconds,
            )
        except ExecutionFailed as error:
            return _failed(
                FAILURE_EXECUTION_FAILED, "execution", str(error), retryable=False
            )
        except ExecutionTimeout as error:
            return _failed(
                FAILURE_EXECUTION_TIMEOUT, "timeout", str(error), retryable=True
            )
        except BackendDisconnected as error:
            return _failed(
                FAILURE_BACKEND_DISCONNECTED,
                "response_disconnect",
                str(error),
                retryable=True,
            )
        except ComfyUIUnavailable as error:
            return _failed(
                FAILURE_BACKEND_DISCONNECTED,
                "response_disconnect",
                f"実行中にComfyUIへ接続できなくなりました: {client.base_url}",
                retryable=True,
                error=error,
            )

        if result is WaitResult.CANCEL_REQUESTED:
            return await self._handle_cancel(client, context, prompt_id)
        return await self._collect_outputs(client, context, prompt_id)

    async def _handle_cancel(
        self, client: ComfyUIClient, context: _JobContext, prompt_id: str
    ) -> ExecutionOutcome:
        """停止要求を送り、停止前に出力が完了していたかを確かめる。"""
        try:
            await client.interrupt(prompt_id)
        except InterruptFailed as error:
            return _failed(
                FAILURE_INTERRUPT_FAILED, "execution", str(error), retryable=False
            )
        try:
            refs = await client.fetch_outputs(prompt_id)
        except (OutputNotFound, ExecutionFailed, ComfyUIUnavailable):
            # 停止できていれば出力が無いのが正常。取消として扱う。
            return ExecutionOutcome(succeeded=False, stop_confirmed=True)
        return await self._store_outputs(client, context, refs)

    async def _collect_outputs(
        self, client: ComfyUIClient, context: _JobContext, prompt_id: str
    ) -> ExecutionOutcome:
        try:
            refs = await client.fetch_outputs(prompt_id)
        except OutputNotFound as error:
            return _failed(
                FAILURE_OUTPUT_NOT_FOUND, "execution", str(error), retryable=False
            )
        except ExecutionFailed as error:
            return _failed(
                FAILURE_EXECUTION_FAILED, "execution", str(error), retryable=False
            )
        except ComfyUIUnavailable as error:
            return _failed(
                FAILURE_BACKEND_DISCONNECTED,
                "response_disconnect",
                f"出力の取得中にComfyUIへ接続できなくなりました: {client.base_url}",
                retryable=True,
                error=error,
            )
        return await self._store_outputs(client, context, refs)

    async def _store_outputs(
        self, client: ComfyUIClient, context: _JobContext, refs: tuple[ImageRef, ...]
    ) -> ExecutionOutcome:
        stored: list[storage.StoredFile] = []
        try:
            for ref in refs:
                data = await client.download(ref)
                stored.append(
                    storage.write_artifact(
                        context.job_id, ref.filename, data, self._settings
                    )
                )
        except OutputNotFound as error:
            return _failed(
                FAILURE_OUTPUT_NOT_FOUND, "execution", str(error), retryable=False
            )
        except ComfyUIUnavailable as error:
            return _failed(
                FAILURE_BACKEND_DISCONNECTED,
                "response_disconnect",
                f"出力の取得中にComfyUIへ接続できなくなりました: {client.base_url}",
                retryable=True,
                error=error,
            )
        except storage.StorageError as error:
            return _failed(
                FAILURE_ARTIFACT_WRITE_FAILED, "execution", str(error), retryable=False
            )

        try:
            await self._create_image_artifacts(context.job_id, stored)
        except Exception as error:
            logger.exception("Artifactの記録に失敗しました。job_id=%s", context.job_id)
            return _failed(
                FAILURE_ARTIFACT_WRITE_FAILED,
                "execution",
                "生成物の記録に失敗しました。",
                retryable=False,
                error=error,
            )
        return ExecutionOutcome(succeeded=True)

    async def _load_context(self, job: GenerationJob) -> _JobContext:
        """Manifest、Recipe、保存済みWorkflow JSONを読み、投入できる形にする。"""
        async with self._session_factory() as session:
            manifest = await session.get(GenerationManifest, job.manifest_id)
            if manifest is None:
                raise _PreflightError(
                    FAILURE_INPUT_UNRESOLVED,
                    "JobのManifestが見つかりません。",
                    retryable=False,
                )
            recipe = await session.get(Recipe, job.recipe_id)
            if recipe is None:
                raise _PreflightError(
                    FAILURE_INPUT_UNRESOLVED,
                    "JobのRecipeが見つかりません。",
                    retryable=False,
                )
            artifact = await session.get(Artifact, manifest.workflow_artifact_id)
            if artifact is None:
                raise _PreflightError(
                    FAILURE_INPUT_UNRESOLVED,
                    "Workflowスナップショットが見つかりません。",
                    retryable=False,
                )
            template_name = _template_name(recipe)
            model = {
                key: value
                for key, value in (manifest.model or {}).items()
                if isinstance(value, str)
            }
            workflow = _read_workflow(artifact, self._settings)
            return _JobContext(
                job_id=job.id,
                manifest_id=manifest.id,
                template_name=template_name,
                model=model,
                workflow=workflow,
            )

    async def _record_engine_version(
        self, manifest_id: str, version: str | None
    ) -> None:
        """実測した`engine_version`をManifestへ1回だけ書き込む。

        Manifestの他の項目と違い、実行基盤の版はJob作成時点では確定できない。既に
        値が入っている場合(再起動後の再実行など)は上書きしない。
        """
        if version is None:
            return
        async with self._session_factory() as session:
            manifest = await session.get(GenerationManifest, manifest_id)
            if manifest is None or manifest.engine_version:
                return
            manifest.engine_version = version
            await session.commit()

    async def _verify_models(self, client: ComfyUIClient, context: _JobContext) -> None:
        """Manifestが指すモデルファイルがComfyUI側にあるかを投入前に確かめる。"""
        missing: list[str] = []
        for slot in workflow_module.model_slots(context.template_name):
            required = context.model.get(slot.variable)
            if not required:
                continue
            options = await client.available_options(slot.node_class, slot.option_field)
            if options and required not in options:
                missing.append(f"{slot.variable}={required}")
        if missing:
            raise _PreflightError(
                FAILURE_MODEL_NOT_FOUND,
                f"ComfyUIに指定したモデルがありません: {', '.join(missing)}",
                retryable=False,
            )

    async def _create_image_artifacts(
        self, job_id: str, stored: list[storage.StoredFile]
    ) -> None:
        async with self._session_factory() as session:
            created_at = schemas.now_iso()
            for item in stored:
                session.add(
                    Artifact(
                        id=schemas.new_id(),
                        job_id=job_id,
                        kind="image",
                        relative_path=item.relative_path,
                        sha256=item.sha256,
                        byte_size=item.byte_size,
                        media_type=_media_type(item.relative_path),
                        availability="complete",
                        parent_artifact_id=None,
                        created_at=created_at,
                        decision="undecided",
                        decision_at=None,
                    )
                )
            await session.commit()


def _template_name(recipe: Recipe) -> str:
    reference = recipe.workflow_template_ref
    name = reference.get("name") if isinstance(reference, dict) else None
    if not isinstance(name, str) or name not in workflow_module.ALLOWED_TEMPLATES:
        raise _PreflightError(
            FAILURE_INPUT_UNRESOLVED,
            "Recipeが許可されていないWorkflowテンプレートを指しています。",
            retryable=False,
        )
    return name


def _read_workflow(artifact: Artifact, settings: Settings) -> dict[str, object]:
    """保存済みのWorkflowスナップショットを読み、記録済みのhashと突き合わせる。

    投入するのは作成時に保存したJSONそのものとする。組み立て直すと、記録した
    スナップショットと実際に投入した内容がずれる余地が残るため。
    """
    path = settings.data_root / artifact.relative_path
    try:
        raw = path.read_bytes()
    except OSError as error:
        raise _PreflightError(
            FAILURE_INPUT_UNRESOLVED,
            "Workflowスナップショットを読み込めません。",
            retryable=False,
        ) from error
    if hashlib.sha256(raw).hexdigest() != artifact.sha256:
        raise _PreflightError(
            FAILURE_INPUT_UNRESOLVED,
            "Workflowスナップショットの内容が記録と一致しません。",
            retryable=False,
        )
    try:
        workflow = json.loads(raw)
    except ValueError as error:
        raise _PreflightError(
            FAILURE_INPUT_UNRESOLVED,
            "Workflowスナップショットを解釈できません。",
            retryable=False,
        ) from error
    if not isinstance(workflow, dict):
        raise _PreflightError(
            FAILURE_INPUT_UNRESOLVED,
            "Workflowスナップショットの形式が想定外です。",
            retryable=False,
        )
    return workflow


def _media_type(relative_path: str) -> str:
    return mimetypes.guess_type(relative_path)[0] or "application/octet-stream"


def _failed(
    code: str,
    stage: str,
    message: str,
    retryable: bool,
    *,
    error: BaseException | None = None,
) -> ExecutionOutcome:
    if error is not None:
        logger.info("Jobを失敗として記録します。code=%s", code, exc_info=error)
    else:
        logger.info("Jobを失敗として記録します。code=%s", code)
    return ExecutionOutcome(
        succeeded=False,
        failure_code=code,
        failure_stage=stage,
        failure_message=message,
        retryable=retryable,
    )
