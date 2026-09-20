"""ComfyUI HTTP / WebSocket APIクライアント。

ComfyUIのエンドポイント仕様と応答形状の知識はこのモジュールへ閉じ込め、上位層へは
本パッケージの例外型とデータ構造だけを返す。

秘密情報は扱わない。ログへ残すのは操作名、結果、`prompt_id`だけとする。
"""

import asyncio
import json
import logging
import uuid
from dataclasses import dataclass
from enum import Enum
from pathlib import PurePosixPath
from types import TracebackType
from typing import Any, Self
from urllib.parse import urlencode

import httpx
import websockets
from websockets.exceptions import WebSocketException

from mycomfyui_api.settings import Settings, get_settings

logger = logging.getLogger(__name__)

#: 個々のHTTP要求の上限。Job全体の上限(`comfyui_timeout_seconds`)とは別に短く保つ。
REQUEST_TIMEOUT_SECONDS = 30.0

#: 疎通確認は生成本体より短い時間で打ち切る。
HEALTH_TIMEOUT_SECONDS = 5.0

#: WebSocketを使えないときのhistoryポーリング間隔。
POLL_INTERVAL_SECONDS = 1.0

#: 新しいノード定義APIが選択肢の型として返すマーカー。
COMBO_TYPE = "COMBO"


class ComfyUIError(Exception):
    """ComfyUI Adapterが返す例外の基底。"""


class ComfyUIUnavailable(ComfyUIError):
    """ComfyUIへ接続できない、または応答を解釈できない。"""


class WorkflowRejected(ComfyUIError):
    """ComfyUIがWorkflowの受け付けを拒否した。"""


class ExecutionFailed(ComfyUIError):
    """ComfyUI上での実行が失敗した。"""


class ExecutionTimeout(ComfyUIError):
    """制限時間内に実行が終わらなかった。"""


class BackendDisconnected(ComfyUIError):
    """実行の監視接続が切れ、履歴からも状態を確認できない。"""


class OutputNotFound(ComfyUIError):
    """実行は終わったが、取得できる出力がない。"""


class InterruptFailed(ComfyUIError):
    """停止要求そのものが失敗した。"""


class WaitResult(Enum):
    """実行監視の打ち切り理由。"""

    COMPLETED = "completed"
    CANCEL_REQUESTED = "cancel_requested"


#: ComfyUIが履歴の`outputs`へ書く出力キーと、そのキーの既定のArtifact種別。
#: 2026-09-20にComfyUI 0.33.0の実機で確認した結果、素の`SaveVideo`は動画を`videos`では
#: なく`images`へ入れる(`{"images": [{"filename": "...mp4"}], "animated": [true]}`)。
#: キーだけでは種別を判定できないため、既定として使い、判定は拡張子を優先する。
#: `videos`と`gifs`はVideo Helper Suite系のカスタムノードが使う。
OUTPUT_KINDS: dict[str, str] = {
    "images": "image",
    "videos": "video",
    "gifs": "video",
    "audio": "audio",
}

#: 拡張子から決まるArtifact種別。`SaveAnimatedWEBP`のように`animated`が真でも中身が
#: 画像のノードがあるため、判定には`animated`ではなく拡張子を使う。`.gif`は載せない。
#: 出力キー(`gifs`か`images`か)で従来どおり種別が決まるようにする。
EXTENSION_KINDS: dict[str, str] = {
    ".png": "image",
    ".jpg": "image",
    ".jpeg": "image",
    ".webp": "image",
    ".mp4": "video",
    ".webm": "video",
    ".mkv": "video",
    ".mov": "video",
    ".avi": "video",
    ".flac": "audio",
    ".wav": "audio",
    ".mp3": "audio",
    ".ogg": "audio",
    ".opus": "audio",
    ".m4a": "audio",
}


class UploadFailed(ComfyUIError):
    """ComfyUIのinputへ素材を置けなかった。"""


@dataclass(frozen=True)
class OutputRef:
    """ComfyUIのoutput上の生成物への参照。"""

    filename: str
    subfolder: str
    type: str
    kind: str


@dataclass(frozen=True)
class BackendStatus:
    """疎通確認の結果。"""

    base_url: str
    version: str | None
    devices: tuple[str, ...]


class ComfyUIClient:
    """ComfyUIサーバとの通信を担う。

    `transport`はテストでhttpxのMockTransportを差し込むための拡張点であり、通常利用
    では指定しない。
    """

    def __init__(
        self,
        settings: Settings | None = None,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._settings = settings or get_settings()
        self._base_url = self._settings.comfyui_base_url.rstrip("/")
        self._client_id = str(uuid.uuid4())
        self._client = httpx.AsyncClient(
            base_url=self._base_url,
            timeout=httpx.Timeout(REQUEST_TIMEOUT_SECONDS),
            transport=transport,
        )

    @property
    def base_url(self) -> str:
        return self._base_url

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        await self._client.aclose()

    async def status(self) -> BackendStatus:
        """疎通と`engine_version`を確認する。到達不能ならComfyUIUnavailable。"""
        payload = await self._get_json("/system_stats", timeout=HEALTH_TIMEOUT_SECONDS)
        version: str | None = None
        system = payload.get("system")
        if isinstance(system, dict) and isinstance(system.get("comfyui_version"), str):
            version = system["comfyui_version"]
        devices: tuple[str, ...] = ()
        raw_devices = payload.get("devices")
        if isinstance(raw_devices, list):
            devices = tuple(
                device["name"]
                for device in raw_devices
                if isinstance(device, dict) and isinstance(device.get("name"), str)
            )
        return BackendStatus(base_url=self._base_url, version=version, devices=devices)

    async def available_options(self, node_class: str, field: str) -> tuple[str, ...]:
        """あるノードの選択肢一覧を取得する。モデルファイルの在庫確認に使う。"""
        payload = await self._get_json(f"/object_info/{node_class}")
        return _extract_option_names(payload, node=node_class, field=field)

    async def upload_input(self, file_name: str, data: bytes) -> str:
        """素材をComfyUIのinputへ置き、Workflowから参照できる名前を返す。

        `LoadImage`と`LoadAudio`はComfyUI側のinputディレクトリにあるファイル名しか
        受け取らないため、手元のArtifactをそのまま渡すことはできない。投入直前に
        ここでアップロードし、返った名前をWorkflowへ差し込む。

        同名ファイルは上書きしない。ComfyUIが採番した名前をそのまま使う。
        """
        try:
            response = await self._client.post(
                "/upload/image",
                files={"image": (file_name, data, "application/octet-stream")},
                data={"type": "input", "overwrite": "false"},
            )
        except httpx.HTTPError as error:
            raise ComfyUIUnavailable(
                f"ComfyUIへ接続できません: {self._base_url}"
            ) from error
        if response.status_code >= httpx.codes.BAD_REQUEST:
            raise UploadFailed(
                f"ComfyUIが素材を受け付けませんでした"
                f"(HTTP {response.status_code}): {file_name}"
            )
        try:
            payload = response.json()
        except ValueError as error:
            raise UploadFailed("ComfyUIの応答を解釈できません。") from error
        name = payload.get("name") if isinstance(payload, dict) else None
        if not isinstance(name, str) or not name:
            raise UploadFailed("ComfyUIの応答にファイル名が含まれていません。")
        subfolder = payload.get("subfolder") if isinstance(payload, dict) else ""
        if isinstance(subfolder, str) and subfolder:
            return f"{subfolder}/{name}"
        return name

    async def submit(self, workflow: dict[str, Any]) -> str:
        """Workflowを投入し、`prompt_id`を返す。"""
        try:
            response = await self._client.post(
                "/prompt", json={"prompt": workflow, "client_id": self._client_id}
            )
        except httpx.HTTPError as error:
            raise ComfyUIUnavailable(
                f"ComfyUIへ接続できません: {self._base_url}"
            ) from error
        if response.status_code >= httpx.codes.BAD_REQUEST:
            raise WorkflowRejected(_format_submission_error(response))
        try:
            payload = response.json()
        except ValueError as error:
            raise WorkflowRejected("ComfyUIの応答を解釈できません。") from error
        prompt_id = payload.get("prompt_id") if isinstance(payload, dict) else None
        if not isinstance(prompt_id, str) or not prompt_id:
            raise WorkflowRejected("ComfyUIの応答にprompt_idが含まれていません。")
        logger.info("Workflowを投入しました。prompt_id=%s", prompt_id)
        return prompt_id

    async def wait_for_completion(
        self, prompt_id: str, *, cancel_event: asyncio.Event, timeout: float
    ) -> WaitResult:
        """実行完了、取消要求、制限時間のいずれかまで待つ。

        監視方式はこのメソッドへ隠蔽する。WebSocketを使えない環境ではhistoryの
        ポーリングへ自動的に切り替える。
        """
        monitor = asyncio.create_task(self._monitor(prompt_id))
        cancel_wait = asyncio.create_task(cancel_event.wait())
        try:
            done, _ = await asyncio.wait(
                {monitor, cancel_wait},
                timeout=timeout,
                return_when=asyncio.FIRST_COMPLETED,
            )
        except BaseException:
            await _cancel_task(monitor)
            await _cancel_task(cancel_wait)
            raise
        await _cancel_task(cancel_wait)
        if monitor in done:
            # 監視側の例外(実行失敗、切断)はそのまま呼び出し元へ伝える。
            monitor.result()
            return WaitResult.COMPLETED
        await _cancel_task(monitor)
        if cancel_wait in done:
            return WaitResult.CANCEL_REQUESTED
        raise ExecutionTimeout(
            f"生成が制限時間{timeout}秒以内に完了しませんでした。prompt_id={prompt_id}"
        )

    async def _monitor(self, prompt_id: str) -> None:
        try:
            completed = await self._monitor_via_websocket(prompt_id)
        except (OSError, WebSocketException) as error:
            logger.warning(
                "WebSocket監視を使えないためポーリングへ切り替えます。prompt_id=%s (%s)",
                prompt_id,
                type(error).__name__,
            )
        else:
            if completed:
                return
            logger.warning(
                "WebSocketが完了前に閉じたためポーリングへ切り替えます。prompt_id=%s",
                prompt_id,
            )
        try:
            await self._monitor_via_polling(prompt_id)
        except ComfyUIUnavailable as error:
            raise BackendDisconnected(
                f"実行の監視接続が切れ、履歴も取得できません。prompt_id={prompt_id}"
            ) from error

    async def _monitor_via_websocket(self, prompt_id: str) -> bool:
        """WebSocketで完了を検知できたかを返す。

        ComfyUIが正常クローズでWebSocketを閉じると`async for`は例外を出さずに終わる
        (サーバ再起動やプロキシのアイドル切断で起きる)。完了を検知しないまま抜けた
        ことを呼び出し元へ伝え、ポーリングで確かめ直させる。
        """
        ws_url = _to_websocket_url(self._base_url, self._client_id)
        async with websockets.connect(ws_url) as connection:
            # 接続前に完了していると通知を取り逃すため、接続直後に履歴を1度確認する。
            entry = await self.history_entry(prompt_id)
            if entry is not None:
                _raise_if_failed(entry, prompt_id)
                if _is_completed(entry):
                    return True
            async for raw in connection:
                if not isinstance(raw, str):
                    continue
                if _is_completion_message(raw, prompt_id):
                    return True
        return False

    async def _monitor_via_polling(self, prompt_id: str) -> None:
        while True:
            entry = await self.history_entry(prompt_id)
            if entry is not None:
                _raise_if_failed(entry, prompt_id)
                if _is_completed(entry):
                    return
            await asyncio.sleep(POLL_INTERVAL_SECONDS)

    async def history_entry(self, prompt_id: str) -> dict[str, Any] | None:
        payload = await self._get_json(f"/history/{prompt_id}")
        entry = payload.get(prompt_id)
        return entry if isinstance(entry, dict) else None

    async def fetch_outputs(self, prompt_id: str) -> tuple[OutputRef, ...]:
        """生成物への参照を取得する。画像、動画、音声を同じ形で返す。"""
        entry = await self.history_entry(prompt_id)
        if entry is None:
            raise OutputNotFound(f"履歴にprompt_id={prompt_id}の記録がありません。")
        _raise_if_failed(entry, prompt_id)
        outputs = _extract_outputs(entry)
        if not outputs:
            raise OutputNotFound(
                f"生成結果に取得できる出力がありません。prompt_id={prompt_id}"
            )
        return outputs

    async def download(self, ref: OutputRef) -> bytes:
        """ComfyUIのoutputから生成物のデータを取得する。"""
        params = {
            "filename": ref.filename,
            "subfolder": ref.subfolder,
            "type": ref.type,
        }
        try:
            response = await self._client.get("/view", params=params)
        except httpx.HTTPError as error:
            raise ComfyUIUnavailable(
                f"ComfyUIへ接続できません: {self._base_url}"
            ) from error
        if response.status_code >= httpx.codes.BAD_REQUEST:
            raise OutputNotFound(
                f"生成物を取得できません(HTTP {response.status_code}): {ref.filename}"
            )
        return response.content

    async def interrupt(self, prompt_id: str) -> None:
        """対象を限定して実行を止め、待機中なら順番待ちからも外す。

        `/interrupt`は実行中のpromptにしか効かない。ComfyUIを他の利用者と共有して
        いると自分のpromptが待機中のことがあるため、`/queue`のdeleteも合わせて送る。
        """
        try:
            interrupted = await self._client.post(
                "/interrupt", json={"prompt_id": prompt_id}
            )
        except httpx.HTTPError as error:
            raise InterruptFailed(
                f"停止要求を送れませんでした。prompt_id={prompt_id}"
            ) from error
        if interrupted.status_code >= httpx.codes.BAD_REQUEST:
            raise InterruptFailed(
                f"停止要求が拒否されました(HTTP {interrupted.status_code})。"
                f"prompt_id={prompt_id}"
            )
        # 中断そのものは成功している。順番待ちからの削除は取りこぼしを防ぐための
        # 追加操作であり、ここでの失敗を停止処理の失敗として扱わない。
        try:
            dequeued = await self._client.post("/queue", json={"delete": [prompt_id]})
        except httpx.HTTPError:
            logger.warning(
                "順番待ちからの削除を送れませんでした。中断は成功しています。"
                "同じpromptが待機列に残っていないかComfyUIの/queueで確認してください。"
                "prompt_id=%s",
                prompt_id,
            )
        else:
            if dequeued.status_code >= httpx.codes.BAD_REQUEST:
                logger.warning(
                    "順番待ちからの削除が拒否されました(HTTP %s)。中断は成功しています。"
                    "同じpromptが待機列に残っていないかComfyUIの/queueで確認してください。"
                    "prompt_id=%s",
                    dequeued.status_code,
                    prompt_id,
                )
        logger.info("停止要求を送りました。prompt_id=%s", prompt_id)

    async def _get_json(
        self, path: str, *, timeout: float | None = None
    ) -> dict[str, Any]:
        try:
            response = await self._client.get(
                path, timeout=timeout or REQUEST_TIMEOUT_SECONDS
            )
            response.raise_for_status()
            payload = response.json()
        except httpx.HTTPStatusError as error:
            raise ComfyUIUnavailable(
                f"ComfyUIがエラーを返しました(HTTP {error.response.status_code}): {path}"
            ) from error
        except httpx.HTTPError as error:
            raise ComfyUIUnavailable(
                f"ComfyUIへ接続できません: {self._base_url}"
            ) from error
        except ValueError as error:
            raise ComfyUIUnavailable(
                f"ComfyUIの応答を解釈できません: {path}"
            ) from error
        if not isinstance(payload, dict):
            raise ComfyUIUnavailable(f"ComfyUIの応答形式が想定外です: {path}")
        return payload


async def _cancel_task(task: asyncio.Task[Any]) -> None:
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    except Exception:
        # 監視を打ち切るための取消であり、ここでの失敗は結果へ影響しない。
        logger.debug("監視タスクの終了時に例外が発生しました。", exc_info=True)


def _extract_option_names(
    payload: dict[str, Any], *, node: str, field: str
) -> tuple[str, ...]:
    """object_infoの応答から、あるノードの選択肢一覧を取り出す。

    選択肢の並びには2つの形があり、どちらで来るかはノードの定義側で決まる。

    - 旧来のノード: ``[["a.safetensors", "b.safetensors"]]``
    - 新しい定義APIのノード: ``["COMBO", {"options": [...]}]``
    """
    loader = payload.get(node)
    if not isinstance(loader, dict):
        return ()
    inputs = loader.get("input")
    if not isinstance(inputs, dict):
        return ()
    fields = inputs.get("required")
    if not isinstance(fields, dict):
        return ()
    entry = fields.get(field)
    if not isinstance(entry, list) or not entry:
        return ()
    candidates = entry[0]
    if isinstance(candidates, list):
        return tuple(name for name in candidates if isinstance(name, str))
    # 型マーカーまで見る。optionsという名前のメタデータを持つ別の型を選択肢と
    # 取り違えないため。
    if candidates == COMBO_TYPE and len(entry) > 1 and isinstance(entry[1], dict):
        options = entry[1].get("options")
        if isinstance(options, list):
            return tuple(name for name in options if isinstance(name, str))
    return ()


def _to_websocket_url(base_url: str, client_id: str) -> str:
    scheme, _, rest = base_url.partition("://")
    ws_scheme = "wss" if scheme == "https" else "ws"
    return f"{ws_scheme}://{rest}/ws?{urlencode({'clientId': client_id})}"


def _is_completion_message(raw: str, prompt_id: str) -> bool:
    """WebSocketのメッセージが対象promptの完了通知かを判定する。

    ComfyUIは実行終了時にnode=Noneのexecutingメッセージを送る。
    """
    try:
        message = json.loads(raw)
    except ValueError:
        return False
    if not isinstance(message, dict):
        return False
    data = message.get("data")
    if not isinstance(data, dict) or data.get("prompt_id") != prompt_id:
        return False
    if message.get("type") == "execution_error":
        raise ExecutionFailed(_execution_error_message(data, prompt_id))
    if message.get("type") == "execution_success":
        return True
    return message.get("type") == "executing" and data.get("node") is None


def _is_completed(entry: dict[str, Any]) -> bool:
    status = entry.get("status")
    if not isinstance(status, dict):
        return False
    return status.get("completed") is True or status.get("status_str") == "success"


def _raise_if_failed(entry: dict[str, Any], prompt_id: str) -> None:
    status = entry.get("status")
    if not isinstance(status, dict) or status.get("status_str") != "error":
        return
    detail = "詳細不明"
    messages = status.get("messages")
    if isinstance(messages, list):
        for item in messages:
            if (
                isinstance(item, list)
                and len(item) == 2
                and item[0] == "execution_error"
                and isinstance(item[1], dict)
            ):
                detail = _execution_error_message(item[1], prompt_id)
                break
    raise ExecutionFailed(
        f"ComfyUIでの実行が失敗しました。prompt_id={prompt_id}: {detail}"
    )


def _execution_error_message(data: dict[str, Any], prompt_id: str) -> str:
    message = data.get("exception_message")
    node = data.get("node_type") or data.get("node_id")
    if isinstance(message, str) and message:
        return f"{message} (node={node})" if node else message
    return f"実行エラー (prompt_id={prompt_id})"


def _kind_for(filename: str, fallback: str) -> str:
    """ファイル名からArtifact種別を決める。拡張子が未知なら出力キーの既定に従う。"""
    suffix = PurePosixPath(filename).suffix.lower()
    return EXTENSION_KINDS.get(suffix, fallback)


def _extract_outputs(entry: dict[str, Any]) -> tuple[OutputRef, ...]:
    """履歴の`outputs`から、取得できる生成物の参照を集める。

    ノードごとの出力は種別ごとに別のキーへ入る。どのキーに入るかはノード側の実装で
    決まるため、扱える種別を横断して読む。種別の判定は拡張子を優先する。キーだけでは
    `SaveVideo`の出力を画像として扱ってしまう(`OUTPUT_KINDS`の注記)。
    """
    outputs = entry.get("outputs")
    if not isinstance(outputs, dict):
        return ()
    refs: list[OutputRef] = []
    for node_output in outputs.values():
        if not isinstance(node_output, dict):
            continue
        for key, kind in OUTPUT_KINDS.items():
            items = node_output.get(key, [])
            if not isinstance(items, list):
                # ComfyUIの応答は外部由来のため、想定した形でなければ読み飛ばす。
                # そのまま列挙すると、失敗理由がTypeErrorに化けて特定しにくくなる。
                logger.warning("履歴の%sが配列ではありません。読み飛ばします。", key)
                continue
            for item in items:
                if not isinstance(item, dict):
                    continue
                filename = item.get("filename")
                if not isinstance(filename, str):
                    continue
                refs.append(
                    OutputRef(
                        filename=filename,
                        subfolder=str(item.get("subfolder", "")),
                        type=str(item.get("type", "output")),
                        kind=_kind_for(filename, kind),
                    )
                )
    return tuple(refs)


def _format_submission_error(response: httpx.Response) -> str:
    """ComfyUIの拒否応答から、原因を特定できるメッセージを組み立てる。"""
    base = f"ComfyUIがWorkflowを受け付けませんでした(HTTP {response.status_code})"
    try:
        payload = response.json()
    except ValueError:
        return base
    if not isinstance(payload, dict):
        return base
    details: list[str] = []
    error = payload.get("error")
    if isinstance(error, dict) and isinstance(error.get("message"), str):
        details.append(error["message"])
    node_errors = payload.get("node_errors")
    if isinstance(node_errors, dict):
        for node_id, node_error in node_errors.items():
            if not isinstance(node_error, dict):
                continue
            for item in node_error.get("errors", []):
                if isinstance(item, dict) and isinstance(item.get("message"), str):
                    details.append(f"node {node_id}: {item['message']}")
    return f"{base}: {' / '.join(details)}" if details else base
