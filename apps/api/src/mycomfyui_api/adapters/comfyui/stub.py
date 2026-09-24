"""実ComfyUIを持たない環境で使うスタブ。

到達できるComfyUIが無く、現PCのGPUではMiniMax H3もACE-Stepも動かせないため、実機を
用意するまでの間、投入から履歴・再実行までの経路をこのスタブで確かめる。外部へは一切
送信しない。

生成物は手元のffmpegで作る。中身は単色の動画とサイン波の音声で、実Backendの出力では
ないが、尺・フレーム数・解像度は投入したWorkflowの指定に従う。ffmpegが無い環境では
明示的に失敗させ、黙って空ファイルを残さない。
"""

import asyncio
import contextlib
import logging
import shutil
import tempfile
from asyncio import Event
from pathlib import Path
from typing import Any

from mycomfyui_api.adapters.comfyui import workflow as workflow_module
from mycomfyui_api.adapters.comfyui.client import (
    BackendStatus,
    ComfyUIUnavailable,
    ExecutionFailed,
    ExecutionTimeout,
    OutputNotFound,
    OutputRef,
    ProgressListener,
    ProgressUpdate,
    WaitResult,
)
from mycomfyui_api.schemas import new_id
from mycomfyui_api.settings import Settings, get_settings

logger = logging.getLogger(__name__)

STUB_BASE_URL = "stub://comfyui"
STUB_VERSION = "stub"

#: 生成にかける見かけの時間。取消要求が実行中に届く経路を確かめられる長さにする。
STUB_RUNTIME_SECONDS = 2.0

#: 見かけの実行時間を何段に分けて進捗を通知するか。画面の進捗表示を確かめるために使う。
STUB_PROGRESS_STEPS = 8

#: 1本の生成にかけてよい時間。単色の動画と正弦波しか作らないため、これを超えるのは
#: ffmpegが応答しなくなった場合とみなす。放置すると直列キューが止まったままになる。
STUB_RENDER_TIMEOUT_SECONDS = 120.0

#: 生成物を作るときの既定値。Workflowが値を持たない場合だけ使う。
DEFAULT_WIDTH = 512
DEFAULT_HEIGHT = 512
DEFAULT_FPS = 24.0
DEFAULT_FRAMES = 124
DEFAULT_SECONDS = 10.0
AUDIO_SAMPLE_RATE = 44100

#: 保存ノードと、作る生成物の種別。
SAVE_NODES = {
    "SaveVideo": "video",
    "SaveImage": "image",
    "SaveAudio": "audio",
    "SaveAudioMP3": "audio",
}

SUFFIXES = {"video": ".mp4", "image": ".png", "audio": ".wav"}


class StubComfyUIClient:
    """Workflowの指定どおりの寸法・尺を持つ生成物を手元で作る。"""

    def __init__(self, settings: Settings | None = None) -> None:
        self._settings = settings or get_settings()
        self._queued: dict[str, dict[str, Any]] = {}
        self._outputs: dict[str, list[tuple[OutputRef, bytes]]] = {}
        self._uploaded: dict[str, bytes] = {}

    @property
    def base_url(self) -> str:
        return STUB_BASE_URL

    async def aclose(self) -> None:
        """保持する接続は無い。実クライアントと同じ形にするために用意する。"""

    async def status(self) -> BackendStatus:
        """疎通は`comfyui_stub_failure`の影響を受けない。

        障害注入を疎通にも効かせると、Jobが投入前の確認で止まり、生成の失敗を扱う
        経路まで届かない。接続できない場合は接続先を実在しないURLへ向ければ再現
        できるため、この切り替えは生成の失敗だけに当てる。
        """
        return BackendStatus(
            base_url=STUB_BASE_URL, version=STUB_VERSION, devices=("stub",)
        )

    async def available_options(self, node_class: str, field: str) -> tuple[str, ...]:
        """同梱テンプレートが宣言しているモデル名を在庫として返す。"""
        return workflow_module.template_option_values(node_class, field)

    async def upload_input(self, file_name: str, data: bytes) -> str:
        """受け取った素材を覚えておくだけで、どこへも送らない。"""
        self._uploaded[file_name] = data
        return file_name

    async def submit(self, workflow: dict[str, Any]) -> str:
        prompt_id = new_id()
        self._queued[prompt_id] = workflow
        logger.info("スタブへWorkflowを投入しました。prompt_id=%s", prompt_id)
        return prompt_id

    async def wait_for_completion(
        self,
        prompt_id: str,
        *,
        cancel_event: Event,
        timeout: float,
        listener: ProgressListener | None = None,
    ) -> WaitResult:
        """見かけの実行時間だけ待ってから生成する。

        待っている間に取消要求が届けば、生成物を作らずに取消として返す。実Backendと
        同じく、取消後の`fetch_outputs`では何も取得できない。制限時間が見かけの実行
        時間より短ければ、実Backendと同じく時間切れとして扱う。
        進捗は段ごとに通知する。プレビュー画像は作らない。
        """
        runtime = min(STUB_RUNTIME_SECONDS, timeout)
        for step in range(1, STUB_PROGRESS_STEPS + 1):
            try:
                await asyncio.wait_for(
                    cancel_event.wait(), timeout=runtime / STUB_PROGRESS_STEPS
                )
            except TimeoutError:
                pass
            else:
                return WaitResult.CANCEL_REQUESTED
            if listener is not None:
                listener.on_progress(
                    ProgressUpdate(value=step, max=STUB_PROGRESS_STEPS, node=None)
                )
        if timeout < STUB_RUNTIME_SECONDS:
            raise ExecutionTimeout(
                f"生成が制限時間{timeout}秒以内に完了しませんでした。"
                f"prompt_id={prompt_id}"
            )
        if self._settings.comfyui_stub_failure:
            # 障害試験用。Jobはfailedになり、別Backendへ自動fallbackしない。
            raise ExecutionFailed("スタブBackendは失敗するよう設定されています。")
        workflow = self._queued.get(prompt_id)
        if workflow is None:
            raise ExecutionFailed(f"投入されていないpromptです。prompt_id={prompt_id}")
        self._outputs[prompt_id] = await _render(workflow, self._settings)
        return WaitResult.COMPLETED

    async def fetch_outputs(self, prompt_id: str) -> tuple[OutputRef, ...]:
        produced = self._outputs.get(prompt_id)
        if not produced:
            raise OutputNotFound(
                f"生成結果に取得できる出力がありません。prompt_id={prompt_id}"
            )
        return tuple(ref for ref, _ in produced)

    async def download(self, ref: OutputRef) -> bytes:
        for produced in self._outputs.values():
            for candidate, data in produced:
                if candidate == ref:
                    return data
        raise OutputNotFound(f"生成物を取得できません: {ref.filename}")

    async def interrupt(self, prompt_id: str) -> None:
        self._queued.pop(prompt_id, None)
        self._outputs.pop(prompt_id, None)


def _first_value(workflow: dict[str, Any], class_type: str, key: str) -> Any:
    for entry in workflow.values():
        if not isinstance(entry, dict) or entry.get("class_type") != class_type:
            continue
        value = entry.get("inputs", {}).get(key)
        if isinstance(value, int | float) and not isinstance(value, bool):
            return value
    return None


def _number(value: Any, fallback: float) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return fallback
    return float(value)


def _dimensions(workflow: dict[str, Any]) -> tuple[int, int]:
    """寸法を拾う。ffmpegのH.264は偶数の幅と高さしか受け付けない。"""
    width = int(
        _number(
            _first_value(workflow, "MiniMaxH3ReferenceToVideo", "width")
            or _first_value(workflow, "MiniMaxH3ImageToVideo", "width")
            or _first_value(workflow, "EmptyLatentImage", "width"),
            DEFAULT_WIDTH,
        )
    )
    height = int(
        _number(
            _first_value(workflow, "MiniMaxH3ReferenceToVideo", "height")
            or _first_value(workflow, "MiniMaxH3ImageToVideo", "height")
            or _first_value(workflow, "EmptyLatentImage", "height"),
            DEFAULT_HEIGHT,
        )
    )
    return max(width - width % 2, 2), max(height - height % 2, 2)


def _prefix(entry: dict[str, Any], fallback: str) -> str:
    """保存ノードの接頭辞から、ファイル名として使える部分だけを取り出す。"""
    raw = entry.get("inputs", {}).get("filename_prefix")
    if not isinstance(raw, str) or not raw:
        return fallback
    name = raw.replace("\\", "/").rsplit("/", 1)[-1]
    return name or fallback


async def _render(
    workflow: dict[str, Any], settings: Settings
) -> list[tuple[OutputRef, bytes]]:
    """Workflowの保存ノードに対応する生成物をffmpegで作る。"""
    ffmpeg = shutil.which(settings.ffmpeg_path) or settings.ffmpeg_path
    if shutil.which(settings.ffmpeg_path) is None and not Path(ffmpeg).is_file():
        raise ComfyUIUnavailable(
            "スタブの生成にはffmpegが必要です。"
            f"実行ファイルが見つかりません: {settings.ffmpeg_path}"
        )
    width, height = _dimensions(workflow)
    fps = _number(_first_value(workflow, "CreateVideo", "fps"), DEFAULT_FPS)
    frames = int(
        _number(
            _first_value(workflow, "MiniMaxH3ReferenceToVideo", "length")
            or _first_value(workflow, "MiniMaxH3ImageToVideo", "length"),
            DEFAULT_FRAMES,
        )
    )
    seconds = _number(
        _first_value(workflow, "EmptyAceStepLatentAudio", "seconds"), DEFAULT_SECONDS
    )

    produced: list[tuple[OutputRef, bytes]] = []
    with tempfile.TemporaryDirectory(prefix="mycomfyui-stub-") as workspace:
        index = 0
        for entry in workflow.values():
            if not isinstance(entry, dict):
                continue
            kind = SAVE_NODES.get(str(entry.get("class_type")))
            if kind is None:
                continue
            index += 1
            name = f"{_prefix(entry, 'stub')}_{index:05d}{SUFFIXES[kind]}"
            path = Path(workspace) / name
            await _run_ffmpeg(
                ffmpeg, _arguments(kind, path, width, height, fps, frames, seconds)
            )
            produced.append(
                (
                    OutputRef(filename=name, subfolder="", type="output", kind=kind),
                    path.read_bytes(),
                )
            )
    return produced


def _arguments(
    kind: str,
    path: Path,
    width: int,
    height: int,
    fps: float,
    frames: int,
    seconds: float,
) -> list[str]:
    """ffmpegへ渡す引数。利用者入力は数値だけで、文字列をそのまま渡さない。"""
    if kind == "video":
        return [
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"color=c=0x24476b:s={width}x{height}:r={fps:g}",
            "-frames:v",
            str(frames),
            "-pix_fmt",
            "yuv420p",
            "-c:v",
            "libx264",
            str(path),
        ]
    if kind == "audio":
        return [
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency=330:sample_rate={AUDIO_SAMPLE_RATE}",
            "-t",
            f"{seconds:g}",
            "-ac",
            "2",
            str(path),
        ]
    return [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        f"color=c=0x6b4724:s={width}x{height}",
        "-frames:v",
        "1",
        str(path),
    ]


async def _stop(process: Any, communicate: asyncio.Task[Any]) -> None:
    """起動したffmpegを止める。

    作るのは単色の動画と正弦波だけで、途中まで書いたファイルを残す意味が無いため、
    猶予を置かずに落とす。
    """
    with contextlib.suppress(ProcessLookupError):
        process.kill()
    with contextlib.suppress(Exception):
        await communicate


async def _run_ffmpeg(ffmpeg: str, arguments: list[str]) -> None:
    process = await asyncio.create_subprocess_exec(
        ffmpeg,
        *arguments,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    communicate = asyncio.create_task(process.communicate())
    try:
        _, stderr = await asyncio.wait_for(
            asyncio.shield(communicate), timeout=STUB_RENDER_TIMEOUT_SECONDS
        )
    except asyncio.CancelledError:
        # ワーカーの停止などで外側から止められた場合も、ffmpegを残さない。
        await _stop(process, communicate)
        raise
    except TimeoutError as error:
        await _stop(process, communicate)
        raise ExecutionTimeout(
            f"スタブの生成が制限時間{STUB_RENDER_TIMEOUT_SECONDS}秒以内に"
            "完了しませんでした。"
        ) from error
    if process.returncode != 0:
        raise ExecutionFailed(
            "スタブの生成に失敗しました: "
            f"{stderr.decode('utf-8', 'replace').strip()[:200]}"
        )
