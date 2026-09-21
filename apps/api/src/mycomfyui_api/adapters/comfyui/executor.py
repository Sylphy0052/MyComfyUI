"""ComfyUIでJobを実行する`JobExecutor`実装。

キューワーカーから1件ずつ呼ばれる。ComfyUI固有の失敗をMyComfyUIの`failure_stage`と
`failure_code`へ翻訳し、出力をArtifactとして保存するところまでを担う。
"""

import copy
import hashlib
import json
import logging
import mimetypes
from asyncio import Event
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from mycomfyui_api import provenance, schemas, storage
from mycomfyui_api.adapters.comfyui import workflow as workflow_module
from mycomfyui_api.adapters.comfyui.client import (
    BackendDisconnected,
    ComfyUIClient,
    ComfyUIUnavailable,
    ExecutionFailed,
    ExecutionTimeout,
    InterruptFailed,
    OutputNotFound,
    OutputRef,
    UploadFailed,
    WaitResult,
    WorkflowRejected,
)
from mycomfyui_api.adapters.comfyui.factory import create_comfyui_client
from mycomfyui_api.models import Artifact, GenerationJob, GenerationManifest, Recipe
from mycomfyui_api.queue import ExecutionOutcome
from mycomfyui_api.settings import Settings, get_settings

logger = logging.getLogger(__name__)

ENGINE_COMFYUI = "comfyui"

FAILURE_CODE_BACKEND_UNAVAILABLE = "BACKEND_UNAVAILABLE"
FAILURE_CODE_MODEL_NOT_FOUND = "MODEL_NOT_FOUND"
FAILURE_CODE_INPUT_UNRESOLVED = "INPUT_UNRESOLVED"
FAILURE_CODE_WORKFLOW_REJECTED = "WORKFLOW_REJECTED"
FAILURE_CODE_EXECUTION_FAILED = "EXECUTION_FAILED"
FAILURE_CODE_OUTPUT_NOT_FOUND = "OUTPUT_NOT_FOUND"
FAILURE_CODE_ARTIFACT_WRITE_FAILED = "ARTIFACT_WRITE_FAILED"
FAILURE_CODE_BACKEND_DISCONNECTED = "BACKEND_DISCONNECTED"
FAILURE_CODE_EXECUTION_TIMEOUT = "EXECUTION_TIMEOUT"
FAILURE_CODE_INTERRUPT_FAILED = "INTERRUPT_FAILED"
FAILURE_CODE_INPUT_UPLOAD_FAILED = "INPUT_UPLOAD_FAILED"

#: 生成物の種別ごとの既定のmedia_type。拡張子から判定できない場合に使う。
DEFAULT_MEDIA_TYPES = {
    "image": "image/png",
    "video": "video/mp4",
    "audio": "audio/wav",
}


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
    #: 投入直前にComfyUIのinputへ置き、Workflowへ差し込む素材。
    uploads: tuple[dict[str, object], ...] = ()


class ComfyUIExecutor:
    """ComfyUIへWorkflowを投入し、出力をArtifactとして保存する。"""

    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        *,
        settings: Settings | None = None,
        client_factory=create_comfyui_client,
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
                FAILURE_CODE_BACKEND_UNAVAILABLE,
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
                FAILURE_CODE_BACKEND_UNAVAILABLE,
                "backend_start",
                f"ComfyUIへ接続できません: {client.base_url}",
                retryable=True,
                error=error,
            )

        if cancel_event.is_set():
            # 投入前に取消要求が届いていれば、ComfyUIへ何も送らずに止める。
            return ExecutionOutcome(succeeded=False, stop_confirmed=True)

        try:
            workflow = await self._upload_inputs(client, context)
        except _PreflightError as error:
            return _failed(error.code, "backend_start", error.message, error.retryable)
        except UploadFailed as error:
            return _failed(
                FAILURE_CODE_INPUT_UPLOAD_FAILED,
                "backend_start",
                str(error),
                retryable=False,
            )
        except ComfyUIUnavailable as error:
            return _failed(
                FAILURE_CODE_BACKEND_UNAVAILABLE,
                "backend_start",
                f"ComfyUIへ接続できません: {client.base_url}",
                retryable=True,
                error=error,
            )

        try:
            prompt_id = await client.submit(workflow)
        except WorkflowRejected as error:
            return _failed(
                FAILURE_CODE_WORKFLOW_REJECTED,
                "backend_start",
                str(error),
                retryable=False,
            )
        except ComfyUIUnavailable as error:
            return _failed(
                FAILURE_CODE_BACKEND_UNAVAILABLE,
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
                FAILURE_CODE_EXECUTION_FAILED, "execution", str(error), retryable=False
            )
        except ExecutionTimeout as error:
            return _failed(
                FAILURE_CODE_EXECUTION_TIMEOUT, "timeout", str(error), retryable=True
            )
        except BackendDisconnected as error:
            return _failed(
                FAILURE_CODE_BACKEND_DISCONNECTED,
                "response_disconnect",
                str(error),
                retryable=True,
            )
        except ComfyUIUnavailable as error:
            return _failed(
                FAILURE_CODE_BACKEND_DISCONNECTED,
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
                FAILURE_CODE_INTERRUPT_FAILED, "execution", str(error), retryable=False
            )
        try:
            refs = await client.fetch_outputs(prompt_id)
        except (OutputNotFound, ExecutionFailed):
            # 停止できていれば出力が無いのが正常。取消として扱う。
            return ExecutionOutcome(succeeded=False, stop_confirmed=True)
        except ComfyUIUnavailable as error:
            # 接続できず停止を確認できなかった場合まで取消へ丸めない。停止したのか
            # 通信できないだけなのかが区別できないため、理由付きの失敗として残す。
            return _failed(
                FAILURE_CODE_BACKEND_DISCONNECTED,
                "response_disconnect",
                f"停止後の状態を確認できませんでした: {client.base_url}",
                retryable=True,
                error=error,
            )
        return await self._store_outputs(client, context, refs)

    async def _collect_outputs(
        self, client: ComfyUIClient, context: _JobContext, prompt_id: str
    ) -> ExecutionOutcome:
        try:
            refs = await client.fetch_outputs(prompt_id)
        except OutputNotFound as error:
            return _failed(
                FAILURE_CODE_OUTPUT_NOT_FOUND, "execution", str(error), retryable=False
            )
        except ExecutionFailed as error:
            return _failed(
                FAILURE_CODE_EXECUTION_FAILED, "execution", str(error), retryable=False
            )
        except ComfyUIUnavailable as error:
            return _failed(
                FAILURE_CODE_BACKEND_DISCONNECTED,
                "response_disconnect",
                f"出力の取得中にComfyUIへ接続できなくなりました: {client.base_url}",
                retryable=True,
                error=error,
            )
        return await self._store_outputs(client, context, refs)

    async def _upload_inputs(
        self, client: ComfyUIClient, context: _JobContext
    ) -> dict[str, object]:
        """参照画像とガイド音声をComfyUIのinputへ置き、Workflowへ名前を差し込む。

        `LoadImage`と`LoadAudio`はComfyUI側のinputにあるファイル名しか受け取れず、
        手元のArtifactをそのまま渡せない。投入する内容が記録済みのスナップショットと
        変わるのはこの差し替えだけで、どのファイルを置いたかはManifestへ残っている。
        """
        if not context.uploads:
            return context.workflow
        workflow = copy.deepcopy(context.workflow)
        # 差し込み先は1件でも欠けていれば投入できない。1件目を置いた後に気付くと、
        # ComfyUI側のinputに使われないファイルだけが残るため、先にまとめて確かめる。
        targets: list[tuple[dict[str, object], str]] = []
        for upload in context.uploads:
            node_id = str(upload.get("node_id"))
            node = workflow.get(node_id)
            if not isinstance(node, dict) or not isinstance(node.get("inputs"), dict):
                raise _PreflightError(
                    FAILURE_CODE_INPUT_UNRESOLVED,
                    f"素材の差し込み先ノードがありません: {node_id}",
                    retryable=False,
                )
            targets.append((node["inputs"], str(upload.get("input_key"))))
        for upload, (inputs, input_key) in zip(context.uploads, targets, strict=True):
            data = _read_source(upload, self._settings)
            file_name = str(upload.get("file_name") or "input")
            inputs[input_key] = await client.upload_input(file_name, data)
        return workflow

    async def _store_outputs(
        self, client: ComfyUIClient, context: _JobContext, refs: tuple[OutputRef, ...]
    ) -> ExecutionOutcome:
        stored: list[tuple[OutputRef, storage.StoredFile]] = []
        try:
            for ref in refs:
                data = await client.download(ref)
                stored.append(
                    (
                        ref,
                        storage.write_artifact(
                            context.job_id, ref.filename, data, self._settings
                        ),
                    )
                )
            await self._create_artifacts(context.job_id, stored)
        except OutputNotFound as error:
            return self._discard(
                stored,
                FAILURE_CODE_OUTPUT_NOT_FOUND,
                "execution",
                str(error),
                retryable=False,
            )
        except ComfyUIUnavailable as error:
            return self._discard(
                stored,
                FAILURE_CODE_BACKEND_DISCONNECTED,
                "response_disconnect",
                f"出力の取得中にComfyUIへ接続できなくなりました: {client.base_url}",
                retryable=True,
                error=error,
            )
        except storage.StorageError as error:
            return self._discard(
                stored,
                FAILURE_CODE_ARTIFACT_WRITE_FAILED,
                "execution",
                str(error),
                retryable=False,
            )
        except Exception as error:
            logger.exception("Artifactの記録に失敗しました。job_id=%s", context.job_id)
            return self._discard(
                stored,
                FAILURE_CODE_ARTIFACT_WRITE_FAILED,
                "execution",
                "生成物の記録に失敗しました。",
                retryable=False,
                error=error,
            )
        return ExecutionOutcome(succeeded=True)

    def _discard(
        self,
        stored: list[tuple[OutputRef, storage.StoredFile]],
        code: str,
        stage: str,
        message: str,
        retryable: bool,
        *,
        error: BaseException | None = None,
    ) -> ExecutionOutcome:
        """途中まで保存したファイルを消してから失敗として返す。

        複数枚の途中で失敗すると、DBに記録の無いファイルだけが残る。再実行すると
        連番違いが増えるだけで診断にも使えないため、記録できた分がない限り残さない。
        """
        if stored:
            storage.discard_artifacts(
                [item.relative_path for _, item in stored], self._settings
            )
        return _failed(code, stage, message, retryable, error=error)

    async def _load_context(self, job: GenerationJob) -> _JobContext:
        """Manifest、Recipe、保存済みWorkflow JSONを読み、投入できる形にする。"""
        async with self._session_factory() as session:
            manifest = await session.get(GenerationManifest, job.manifest_id)
            if manifest is None:
                raise _PreflightError(
                    FAILURE_CODE_INPUT_UNRESOLVED,
                    "JobのManifestが見つかりません。",
                    retryable=False,
                )
            recipe = await session.get(Recipe, job.recipe_id)
            if recipe is None:
                raise _PreflightError(
                    FAILURE_CODE_INPUT_UNRESOLVED,
                    "JobのRecipeが見つかりません。",
                    retryable=False,
                )
            artifact = await session.get(Artifact, manifest.workflow_artifact_id)
            if artifact is None:
                raise _PreflightError(
                    FAILURE_CODE_INPUT_UNRESOLVED,
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
            raw_uploads = (manifest.parameters or {}).get("input_uploads")
            uploads = (
                tuple(item for item in raw_uploads if isinstance(item, dict))
                if isinstance(raw_uploads, list)
                else ()
            )
            return _JobContext(
                job_id=job.id,
                manifest_id=manifest.id,
                template_name=template_name,
                model=model,
                workflow=workflow,
                uploads=uploads,
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
        """Manifestが指すモデルファイルがComfyUI側にあるかを投入前に確かめる。

        選択肢を取得できなかった場合も失敗させる。ComfyUIのモデルローダーはファイルを
        読み込む経路のため、在庫を確認できないまま任意の文字列を渡さない。
        """
        missing: list[str] = []
        for slot in workflow_module.model_slots(context.template_name):
            required = context.model.get(slot.variable)
            if not required:
                continue
            options = await client.available_options(slot.node_class, slot.option_field)
            if not options:
                # 選択肢が空になるのは、モデルが1つも置かれていない場合と、ComfyUIの
                # 応答形式が想定と違う場合の両方がある。切り分けのため何を見たかを残す。
                logger.warning(
                    "%sの%sから選択肢を取得できませんでした。ComfyUIのモデル配置か"
                    "object_infoの応答形式を確認してください。",
                    slot.node_class,
                    slot.option_field,
                )
                raise _PreflightError(
                    FAILURE_CODE_MODEL_NOT_FOUND,
                    f"ComfyUIから{slot.node_class}の選択肢を取得できず、"
                    f"{slot.variable}の在庫を確認できません。",
                    retryable=True,
                )
            if required not in options:
                missing.append(f"{slot.variable}={required}")
        if missing:
            raise _PreflightError(
                FAILURE_CODE_MODEL_NOT_FOUND,
                f"ComfyUIに指定したモデルがありません: {', '.join(missing)}",
                retryable=False,
            )

    async def _create_artifacts(
        self, job_id: str, stored: list[tuple[OutputRef, storage.StoredFile]]
    ) -> None:
        """保存済みファイルをArtifactとして記録する。

        commitまで終われば記録は確定している。sessionを閉じるときの失敗をそのまま
        伝えると、呼び出し元が記録済みのファイルを消してしまうため、ここで止める。
        """
        session = self._session_factory()
        try:
            created_at = schemas.now_iso()
            job = await session.get(GenerationJob, job_id)
            assignment = (
                (job.assigned_project_id, job.assigned_scene_id, job.assigned_shot_id)
                if job is not None
                else (None, None, None)
            )
            for ref, item in stored:
                session.add(
                    Artifact(
                        id=schemas.new_id(),
                        job_id=job_id,
                        kind=ref.kind,
                        relative_path=item.relative_path,
                        sha256=item.sha256,
                        byte_size=item.byte_size,
                        media_type=_media_type(item.relative_path, ref.kind),
                        availability="complete",
                        parent_artifact_id=None,
                        assigned_project_id=assignment[0],
                        assigned_scene_id=assignment[1],
                        assigned_shot_id=assignment[2],
                        created_at=created_at,
                        decision="undecided",
                        decision_at=None,
                    )
                )
            await session.commit()
        finally:
            try:
                await session.close()
            except Exception:
                logger.warning(
                    "Artifact記録後のsessionを閉じられませんでした。job_id=%s",
                    job_id,
                    exc_info=True,
                )


def _template_name(recipe: Recipe) -> str:
    reference = recipe.workflow_template_ref
    name = reference.get("name") if isinstance(reference, dict) else None
    if not isinstance(name, str) or name not in workflow_module.ALLOWED_TEMPLATES:
        raise _PreflightError(
            FAILURE_CODE_INPUT_UNRESOLVED,
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
            FAILURE_CODE_INPUT_UNRESOLVED,
            "Workflowスナップショットを読み込めません。",
            retryable=False,
        ) from error
    if hashlib.sha256(raw).hexdigest() != artifact.sha256:
        raise _PreflightError(
            FAILURE_CODE_INPUT_UNRESOLVED,
            "Workflowスナップショットの内容が記録と一致しません。",
            retryable=False,
        )
    try:
        workflow = json.loads(raw)
    except ValueError as error:
        raise _PreflightError(
            FAILURE_CODE_INPUT_UNRESOLVED,
            "Workflowスナップショットを解釈できません。",
            retryable=False,
        ) from error
    if not isinstance(workflow, dict):
        raise _PreflightError(
            FAILURE_CODE_INPUT_UNRESOLVED,
            "Workflowスナップショットの形式が想定外です。",
            retryable=False,
        )
    return workflow


def _media_type(relative_path: str, kind: str) -> str:
    guessed = mimetypes.guess_type(relative_path)[0]
    if guessed:
        return guessed
    return DEFAULT_MEDIA_TYPES.get(kind, "application/octet-stream")


def _read_source(upload: dict[str, object], settings: Settings) -> bytes:
    """アップロードする素材を`data_root`配下から読み、記録済みのhashと突き合わせる。

    記録時と違う内容を置くと、Manifestが指す素材と実際に使った素材がずれる。中身が
    変わっていればJobを失敗させ、取り違えたまま履歴へ残さない。
    """
    relative_path = str(upload.get("relative_path") or "")
    expected = str(upload.get("sha256") or "").lower()
    source = str(upload.get("source") or "")
    try:
        if source == provenance.KIND_CACHED_INPUT:
            path = storage.resolve_input(relative_path, settings)
        else:
            path = storage.resolve_artifact(relative_path, settings)
        data = path.read_bytes()
    except (storage.StorageError, OSError) as error:
        raise _PreflightError(
            FAILURE_CODE_INPUT_UNRESOLVED,
            f"入力素材を読み込めません: {relative_path}",
            retryable=False,
        ) from error
    if hashlib.sha256(data).hexdigest() != expected:
        raise _PreflightError(
            FAILURE_CODE_INPUT_UNRESOLVED,
            f"入力素材の内容が記録と一致しません: {relative_path}",
            retryable=False,
        )
    return data


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
