"""ffmpegで合成JobをこなすJobExecutor実装。

キューワーカーから1件ずつ呼ばれる。動画1本に台詞音声とBGMを重ね、H.264 + AACのmp4を
1件のArtifactとして残す。GPUを使わないが、キューは全Jobで1本のまま共有する。

ffmpegへ渡す引数は固定の組み立てとし、利用者が与えた値は数値としてだけ埋め込む。
`shell=True`は使わず、実行ファイルと引数を配列で渡す。
"""

import asyncio
import contextlib
import hashlib
import json
import logging
import shutil
from asyncio import Event
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from mycomfyui_api import schemas, storage
from mycomfyui_api.adapters.compose import plan as compose_plan
from mycomfyui_api.models import Artifact, GenerationJob, GenerationManifest
from mycomfyui_api.queue import ExecutionOutcome
from mycomfyui_api.settings import Settings, get_settings

logger = logging.getLogger(__name__)

FAILURE_CODE_INPUT_UNRESOLVED = "INPUT_UNRESOLVED"
FAILURE_CODE_BACKEND_UNAVAILABLE = "BACKEND_UNAVAILABLE"
FAILURE_CODE_EXECUTION_FAILED = "EXECUTION_FAILED"
FAILURE_CODE_EXECUTION_TIMEOUT = "EXECUTION_TIMEOUT"
FAILURE_CODE_ARTIFACT_WRITE_FAILED = "ARTIFACT_WRITE_FAILED"
FAILURE_CODE_DURATION_EXCEEDED = "COMPOSE_DURATION_EXCEEDED"

#: 尺の比較に使う許容誤差。フレーム境界の丸めでわずかに超える分は失敗にしない。
DURATION_TOLERANCE_SEC = 0.05

#: ffmpegの標準エラーから記録する長さ。失敗理由の特定に足りる範囲へ切る。
STDERR_EXCERPT_LENGTH = 400

#: 補助コマンドの制限時間。合成本体とは別に、短時間で終わる前提の呼び出しへ当てる。
PROBE_TIMEOUT_SEC = 60.0
VERSION_TIMEOUT_SEC = 10.0


class _PreflightError(Exception):
    """投入前の検証で失敗した。`failure_code`まで決まっている。"""

    def __init__(
        self, code: str, message: str, *, retryable: bool, stage: str = "backend_start"
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable
        self.stage = stage


@dataclass(frozen=True)
class _Track:
    """合成する音声1本。"""

    path: Path
    start_sec: float
    volume: float


@dataclass(frozen=True)
class _JobContext:
    """実行に必要な、DBと保存済みスナップショットから読んだ値の組。"""

    job_id: str
    manifest_id: str
    video_path: Path
    video_artifact_id: str | None
    output_file_name: str
    output_media_type: str
    video_codec: str
    audio_codec: str
    voices: tuple[_Track, ...] = ()
    bgm: _Track | None = None


class ComposeExecutor:
    """ffmpegを起動し、合成結果をArtifactとして保存する。"""

    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        *,
        settings: Settings | None = None,
    ) -> None:
        self._session_factory = session_factory
        self._settings = settings or get_settings()

    async def run(self, job: GenerationJob, cancel_event: Event) -> ExecutionOutcome:
        try:
            context = await self._load_context(job)
        except _PreflightError as error:
            return _failed(error.code, error.stage, error.message, error.retryable)

        ffmpeg = _resolve_executable(self._settings.ffmpeg_path, "ffmpeg")
        ffprobe = _resolve_executable(self._settings.ffprobe_path, "ffprobe")
        if ffmpeg is None or ffprobe is None:
            missing = (
                self._settings.ffmpeg_path
                if ffmpeg is None
                else self._settings.ffprobe_path
            )
            return _failed(
                FAILURE_CODE_BACKEND_UNAVAILABLE,
                "backend_start",
                f"合成に必要な実行ファイルが見つかりません: {missing}",
                retryable=False,
            )
        await self._record_engine_version(context.manifest_id, ffmpeg)

        try:
            await self._measure(ffprobe, context)
        except _PreflightError as error:
            return _failed(error.code, error.stage, error.message, error.retryable)

        if cancel_event.is_set():
            # 起動前に取消要求が届いていれば、ffmpegを立ち上げずに止める。
            return ExecutionOutcome(succeeded=False, stop_confirmed=True)

        return await self._render(ffmpeg, context, cancel_event)

    async def _render(
        self, ffmpeg: str, context: _JobContext, cancel_event: Event
    ) -> ExecutionOutcome:
        directory = storage.job_directory(context.job_id, self._settings)
        try:
            directory.mkdir(parents=True, exist_ok=True)
        except OSError as error:
            return _failed(
                FAILURE_CODE_ARTIFACT_WRITE_FAILED,
                "execution",
                "出力先を用意できませんでした。",
                retryable=False,
                error=error,
            )
        output = directory / context.output_file_name
        arguments = _ffmpeg_arguments(context, output)
        try:
            completed = await _run(
                ffmpeg,
                arguments,
                timeout=self._settings.compose_timeout_seconds,
                cancel_event=cancel_event,
            )
        except TimeoutError:
            _remove(output)
            return _failed(
                FAILURE_CODE_EXECUTION_TIMEOUT,
                "timeout",
                f"合成が制限時間{self._settings.compose_timeout_seconds}秒以内に"
                "終わりませんでした。",
                retryable=True,
            )
        except OSError as error:
            _remove(output)
            return _failed(
                FAILURE_CODE_BACKEND_UNAVAILABLE,
                "backend_start",
                f"ffmpegを起動できませんでした: {error}",
                retryable=False,
                error=error,
            )
        if completed is None:
            # 取消要求でffmpegを止めた。中途半端な出力は残さない。
            _remove(output)
            return ExecutionOutcome(succeeded=False, stop_confirmed=True)
        if completed.returncode != 0:
            _remove(output)
            return _failed(
                FAILURE_CODE_EXECUTION_FAILED,
                "execution",
                f"ffmpegが失敗しました(exit={completed.returncode}): "
                f"{completed.stderr[:STDERR_EXCERPT_LENGTH]}",
                retryable=False,
            )
        try:
            data = output.read_bytes()
        except OSError as error:
            return _failed(
                FAILURE_CODE_ARTIFACT_WRITE_FAILED,
                "execution",
                "合成結果を読み出せませんでした。",
                retryable=False,
                error=error,
            )
        stored = storage.StoredFile(
            relative_path=(
                f"{storage.ARTIFACTS_DIR_NAME}/{directory.name}/{output.name}"
            ),
            sha256=hashlib.sha256(data).hexdigest(),
            byte_size=len(data),
        )
        try:
            await self._persist(context, stored)
        except Exception as error:
            logger.exception(
                "合成Artifactの記録に失敗しました。job_id=%s", context.job_id
            )
            storage.discard_artifacts([stored.relative_path], self._settings)
            return _failed(
                FAILURE_CODE_ARTIFACT_WRITE_FAILED,
                "execution",
                "生成物の記録に失敗しました。",
                retryable=False,
                error=error,
            )
        return ExecutionOutcome(succeeded=True)

    async def _measure(self, ffprobe: str, context: _JobContext) -> None:
        """尺を実測し、台詞が動画に収まっているかを確かめる。

        収まらない入力は切り落とさずに失敗させる。台詞の末尾を黙って削ると、画面には
        成功したJobとして残るのに内容が欠けた動画ができる。
        """
        video = await _duration(ffprobe, context.video_path)
        for index, track in enumerate(context.voices):
            seconds = await _duration(ffprobe, track.path)
            if track.start_sec + seconds > video + DURATION_TOLERANCE_SEC:
                raise _PreflightError(
                    FAILURE_CODE_DURATION_EXCEEDED,
                    f"{index + 1}件目の台詞音声が動画の尺を超えています"
                    f"(開始{track.start_sec}秒 + 長さ{round(seconds, 3)}秒 > "
                    f"{round(video, 3)}秒)。",
                    retryable=False,
                    stage="execution",
                )

    async def _record_engine_version(self, manifest_id: str, ffmpeg: str) -> None:
        """実測したffmpegの版をManifestへ1回だけ書き込む。"""
        version = await _ffmpeg_version(ffmpeg)
        if version is None:
            return
        async with self._session_factory() as session:
            manifest = await session.get(GenerationManifest, manifest_id)
            if manifest is None or manifest.engine_version:
                return
            manifest.engine_version = version
            await session.commit()

    async def _persist(self, context: _JobContext, stored: storage.StoredFile) -> None:
        """合成結果をArtifactとして記録する。

        `parent_artifact_id`には入力の動画Artifactを入れる。台詞音声とBGMは単一の親
        では表せないため、Manifestの`input_refs`から辿る。
        """
        async with self._session_factory() as session:
            session.add(
                Artifact(
                    id=schemas.new_id(),
                    job_id=context.job_id,
                    kind="video",
                    relative_path=stored.relative_path,
                    sha256=stored.sha256,
                    byte_size=stored.byte_size,
                    media_type=context.output_media_type,
                    availability="complete",
                    parent_artifact_id=context.video_artifact_id,
                    created_at=schemas.now_iso(),
                    decision="undecided",
                    decision_at=None,
                )
            )
            await session.commit()

    async def _load_context(self, job: GenerationJob) -> _JobContext:
        async with self._session_factory() as session:
            manifest = await session.get(GenerationManifest, job.manifest_id)
            if manifest is None:
                raise _PreflightError(
                    FAILURE_CODE_INPUT_UNRESOLVED,
                    "JobのManifestが見つかりません。",
                    retryable=False,
                )
            artifact = await session.get(Artifact, manifest.workflow_artifact_id)
            if artifact is None:
                raise _PreflightError(
                    FAILURE_CODE_INPUT_UNRESOLVED,
                    "実行スナップショットが見つかりません。",
                    retryable=False,
                )
            snapshot = _read_snapshot(artifact, self._settings)
            manifest_id = manifest.id
        return _build_context(job.id, manifest_id, snapshot, self._settings)


def _build_context(
    job_id: str, manifest_id: str, snapshot: dict[str, Any], settings: Settings
) -> _JobContext:
    video = snapshot.get("video")
    if not isinstance(video, dict):
        raise _PreflightError(
            FAILURE_CODE_INPUT_UNRESOLVED,
            "実行スナップショットに動画がありません。",
            retryable=False,
        )
    output = snapshot.get("output") if isinstance(snapshot.get("output"), dict) else {}
    voices_raw = snapshot.get("voices")
    voices = (
        [item for item in voices_raw if isinstance(item, dict)]
        if isinstance(voices_raw, list)
        else []
    )
    bgm_raw = snapshot.get("bgm")
    return _JobContext(
        job_id=job_id,
        manifest_id=manifest_id,
        video_path=_resolve_input(video, "動画", settings),
        video_artifact_id=(
            video.get("artifact_id")
            if isinstance(video.get("artifact_id"), str)
            else None
        ),
        output_file_name=str(output.get("file_name") or compose_plan.OUTPUT_FILE_NAME),
        output_media_type=str(
            output.get("media_type") or compose_plan.OUTPUT_MEDIA_TYPE
        ),
        video_codec=str(output.get("video_codec") or compose_plan.VIDEO_CODEC),
        audio_codec=str(output.get("audio_codec") or compose_plan.AUDIO_CODEC),
        voices=tuple(
            _Track(
                path=_resolve_input(item, f"台詞音声{index + 1}件目", settings),
                start_sec=_float(item.get("start_sec"), 0.0),
                volume=_float(item.get("volume"), compose_plan.DEFAULT_VOICE_VOLUME),
            )
            for index, item in enumerate(voices)
        ),
        bgm=(
            _Track(
                path=_resolve_input(bgm_raw, "BGM", settings),
                start_sec=0.0,
                volume=_float(bgm_raw.get("volume"), compose_plan.DEFAULT_BGM_VOLUME),
            )
            if isinstance(bgm_raw, dict)
            else None
        ),
    )


def _float(value: Any, fallback: float) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return fallback
    return float(value)


def _resolve_input(entry: dict[str, Any], label: str, settings: Settings) -> Path:
    """入力Artifactの実ファイルを解決し、記録済みのhashと突き合わせる。"""
    relative_path = entry.get("relative_path")
    expected = entry.get("sha256")
    if not isinstance(relative_path, str) or not isinstance(expected, str):
        raise _PreflightError(
            FAILURE_CODE_INPUT_UNRESOLVED,
            f"{label}の参照が不足しています。",
            retryable=False,
        )
    try:
        path = storage.resolve_artifact(relative_path, settings)
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
    except (storage.StorageError, OSError) as error:
        raise _PreflightError(
            FAILURE_CODE_INPUT_UNRESOLVED,
            f"{label}の実ファイルを読み込めません。",
            retryable=False,
        ) from error
    if digest != expected.lower():
        raise _PreflightError(
            FAILURE_CODE_INPUT_UNRESOLVED,
            f"{label}の内容が記録と一致しません。",
            retryable=False,
        )
    return path


def _ffmpeg_arguments(context: _JobContext, output: Path) -> list[str]:
    """合成のffmpeg引数を組み立てる。

    音声は`adelay`で開始位置を合わせ、`volume`で音量を決めてから`amix`で重ねる。
    混ぜた音声は`apad`で伸ばしたうえで`-shortest`を付け、出力の長さを動画に合わせる。
    動画より長いBGMはここで切り詰められ、短い音声の後ろは無音のまま残る。
    """
    arguments = ["-v", "error", "-y", "-i", str(context.video_path)]
    tracks = [*context.voices]
    if context.bgm is not None:
        tracks.append(context.bgm)
    for track in tracks:
        arguments += ["-i", str(track.path)]

    if not tracks:
        # 音声を1本も重ねないときは、映像だけを入れ直す。
        return arguments + [
            "-map",
            "0:v:0",
            "-an",
            "-c:v",
            context.video_codec,
            "-pix_fmt",
            "yuv420p",
            str(output),
        ]

    filters: list[str] = []
    labels: list[str] = []
    for index, track in enumerate(tracks):
        label = f"a{index}"
        steps = []
        if track.start_sec > 0:
            steps.append(f"adelay={round(track.start_sec * 1000)}:all=1")
        steps.append(f"volume={track.volume:g}")
        filters.append(f"[{index + 1}:a]{','.join(steps)}[{label}]")
        labels.append(f"[{label}]")
    mix = (
        f"{''.join(labels)}amix=inputs={len(tracks)}:duration=longest:normalize=0,"
        "apad[aout]"
    )
    filters.append(mix)
    return arguments + [
        "-filter_complex",
        ";".join(filters),
        "-map",
        "0:v:0",
        "-map",
        "[aout]",
        "-c:v",
        context.video_codec,
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        context.audio_codec,
        "-shortest",
        str(output),
    ]


@dataclass(frozen=True)
class _Completed:
    returncode: int
    stderr: str


async def _run(
    executable: str, arguments: list[str], *, timeout: float, cancel_event: Event
) -> _Completed | None:
    """ffmpegを起動し、完了・取消・制限時間のいずれかまで待つ。

    取消要求が届いたらプロセスを止め、`None`を返す。
    """
    process = await asyncio.create_subprocess_exec(
        executable,
        *arguments,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    communicate = asyncio.create_task(process.communicate())
    cancel_wait = asyncio.create_task(cancel_event.wait())
    try:
        done, _ = await asyncio.wait(
            {communicate, cancel_wait},
            timeout=timeout,
            return_when=asyncio.FIRST_COMPLETED,
        )
    finally:
        cancel_wait.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await cancel_wait
    if communicate in done:
        _, stderr = communicate.result()
        return _Completed(
            returncode=process.returncode or 0,
            stderr=stderr.decode("utf-8", "replace").strip(),
        )
    await _terminate(process, communicate)
    if cancel_wait in done:
        return None
    raise TimeoutError


async def _terminate(process: Any, communicate: asyncio.Task[Any]) -> None:
    """起動したffmpegを確実に終わらせる。"""
    with contextlib.suppress(ProcessLookupError):
        process.terminate()
    try:
        await asyncio.wait_for(asyncio.shield(communicate), timeout=5.0)
    except (TimeoutError, asyncio.CancelledError):
        with contextlib.suppress(ProcessLookupError):
            process.kill()
        with contextlib.suppress(Exception):
            await communicate
    except Exception:
        logger.debug("ffmpegの終了待ちで例外が発生しました。", exc_info=True)


async def _capture(
    executable: str, arguments: list[str], *, timeout: float
) -> tuple[int, bytes, bytes]:
    """短時間で終わる補助コマンドを実行し、終了コードと出力を返す。

    制限時間を過ぎたらプロセスを止めてから送出する。放置すると、応答しない入力を
    投げるたびにffmpegやffprobeが残り、直列キューの裏でホストのリソースを食い続ける。
    """
    process = await asyncio.create_subprocess_exec(
        executable,
        *arguments,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    communicate = asyncio.create_task(process.communicate())
    try:
        stdout, stderr = await asyncio.wait_for(
            asyncio.shield(communicate), timeout=timeout
        )
    except TimeoutError:
        await _terminate(process, communicate)
        raise
    return process.returncode or 0, stdout, stderr


def _resolve_executable(configured: str, label: str) -> str | None:
    found = shutil.which(configured)
    if found:
        return found
    path = Path(configured)
    if path.is_file():
        return str(path)
    logger.warning("%sの実行ファイルが見つかりません: %s", label, configured)
    return None


async def _ffmpeg_version(ffmpeg: str) -> str | None:
    try:
        returncode, stdout, _ = await _capture(
            ffmpeg, ["-version"], timeout=VERSION_TIMEOUT_SEC
        )
    except (OSError, TimeoutError):
        return None
    if returncode != 0:
        return None
    first = stdout.decode("utf-8", "replace").splitlines()
    return first[0].strip()[:200] if first else None


async def _duration(ffprobe: str, path: Path) -> float:
    """ffprobeで尺を実測する。取得できない入力は合成しない。"""
    arguments = [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        str(path),
    ]
    try:
        returncode, stdout, stderr = await _capture(
            ffprobe, arguments, timeout=PROBE_TIMEOUT_SEC
        )
    except (OSError, TimeoutError) as error:
        raise _PreflightError(
            FAILURE_CODE_BACKEND_UNAVAILABLE,
            f"ffprobeを実行できませんでした: {path.name}",
            retryable=True,
        ) from error
    if returncode != 0:
        raise _PreflightError(
            FAILURE_CODE_INPUT_UNRESOLVED,
            f"入力の尺を取得できません: {path.name} "
            f"({stderr.decode('utf-8', 'replace').strip()[:200]})",
            retryable=False,
            stage="execution",
        )
    try:
        payload = json.loads(stdout)
        seconds = float(payload["format"]["duration"])
    except (ValueError, KeyError, TypeError) as error:
        raise _PreflightError(
            FAILURE_CODE_INPUT_UNRESOLVED,
            f"入力の尺を解釈できません: {path.name}",
            retryable=False,
            stage="execution",
        ) from error
    return seconds


def _remove(path: Path) -> None:
    with contextlib.suppress(OSError):
        path.unlink(missing_ok=True)


def _read_snapshot(artifact: Artifact, settings: Settings) -> dict[str, Any]:
    """保存済みの実行スナップショットを読み、記録済みのhashと突き合わせる。"""
    path = settings.data_root / artifact.relative_path
    try:
        raw = path.read_bytes()
    except OSError as error:
        raise _PreflightError(
            FAILURE_CODE_INPUT_UNRESOLVED,
            "実行スナップショットを読み込めません。",
            retryable=False,
        ) from error
    if hashlib.sha256(raw).hexdigest() != artifact.sha256:
        raise _PreflightError(
            FAILURE_CODE_INPUT_UNRESOLVED,
            "実行スナップショットの内容が記録と一致しません。",
            retryable=False,
        )
    try:
        snapshot = json.loads(raw)
    except ValueError as error:
        raise _PreflightError(
            FAILURE_CODE_INPUT_UNRESOLVED,
            "実行スナップショットを解釈できません。",
            retryable=False,
        ) from error
    if not isinstance(snapshot, dict):
        raise _PreflightError(
            FAILURE_CODE_INPUT_UNRESOLVED,
            "実行スナップショットの形式が想定外です。",
            retryable=False,
        )
    return snapshot


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
