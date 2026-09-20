"""voice-runner経由で音声JobをこなすJobExecutor実装。

キューワーカーから1件ずつ呼ばれる。Shot 1件につき台詞ぶんの音声Artifactを作り、
ASRによる読み検証を`voice_verification`へ残すところまでを担う。

別Backendへ自動fallbackしない。exit codeが非0のBackend、runnerへ接続できない場合、
timeout超過のいずれもJobをfailedとする(`ai-media/docs/tts-backends.md`)。
ASR検証の不一致はJobの失敗にしない。音声は生成できているため`succeeded`とし、
不一致は記録して利用者の判断に委ねる。
"""

import hashlib
import json
import logging
from asyncio import Event
from dataclasses import dataclass
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from mycomfyui_api import schemas, storage
from mycomfyui_api.adapters.voice import audio, kana
from mycomfyui_api.adapters.voice.base import (
    SpeechRequest,
    VoiceBackend,
    VoiceExecutionFailed,
    VoicePayloadTooLarge,
    VoiceTimeout,
    VoiceUnavailable,
)
from mycomfyui_api.adapters.voice.factory import create_voice_backend
from mycomfyui_api.models import (
    Artifact,
    GenerationJob,
    GenerationManifest,
    VoiceVerification,
)
from mycomfyui_api.queue import ExecutionOutcome
from mycomfyui_api.settings import Settings, get_settings

logger = logging.getLogger(__name__)

AUDIO_MEDIA_TYPE = "audio/wav"

FAILURE_CODE_BACKEND_UNAVAILABLE = "BACKEND_UNAVAILABLE"
FAILURE_CODE_BACKEND_DISCONNECTED = "BACKEND_DISCONNECTED"
FAILURE_CODE_INPUT_UNRESOLVED = "INPUT_UNRESOLVED"
FAILURE_CODE_EXECUTION_FAILED = "EXECUTION_FAILED"
FAILURE_CODE_EXECUTION_TIMEOUT = "EXECUTION_TIMEOUT"
FAILURE_CODE_ARTIFACT_WRITE_FAILED = "ARTIFACT_WRITE_FAILED"
FAILURE_CODE_VOICE_REFERENCE_MISMATCH = "VOICE_REFERENCE_MISMATCH"
FAILURE_CODE_VOICE_PAYLOAD_TOO_LARGE = "VOICE_PAYLOAD_TOO_LARGE"
FAILURE_CODE_AUDIO_DECODE_FAILED = "AUDIO_DECODE_FAILED"

STATUS_VERIFIED = "verified"
STATUS_SKIPPED = "skipped"
STATUS_ASR_FAILED = "asr_failed"
STATUS_KANA_UNAVAILABLE = "kana_unavailable"


class _PreflightError(Exception):
    """投入前の検証で失敗した。`failure_code`まで決まっている。"""

    def __init__(self, code: str, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable


@dataclass(frozen=True)
class _VoiceBinding:
    """1つのVoice Canonに対応する、実行に必要な値。"""

    voice_id: str
    reference_audio: bytes
    transcript: str


@dataclass(frozen=True)
class _JobContext:
    """実行に必要な、DBと入力cacheから読んだ値の組。"""

    job_id: str
    manifest_id: str
    engine: str
    seed: int
    language: str
    verify_with_asr: bool
    pad_to_duration: bool
    target_duration_sec: float
    dialogue: tuple[dict[str, Any], ...]
    bindings: dict[str, _VoiceBinding]


@dataclass
class _Produced:
    """1台詞ぶんの生成結果。Artifactの記録前に保持する。"""

    index: int
    stored: storage.StoredFile
    expected_text: str
    expected_reading: str | None
    audio_sec: float
    padded_sec: float
    asr_text: str | None = None
    normalized_expected: str | None = None
    normalized_asr: str | None = None
    match: bool | None = None
    diff_ratio: float | None = None
    status: str = STATUS_SKIPPED


class VoiceExecutor:
    """voice-runnerへ台詞を投げ、音声Artifactと読み検証を保存する。"""

    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        *,
        settings: Settings | None = None,
        backend_factory=create_voice_backend,
    ) -> None:
        self._session_factory = session_factory
        self._settings = settings or get_settings()
        self._backend_factory = backend_factory

    async def run(self, job: GenerationJob, cancel_event: Event) -> ExecutionOutcome:
        try:
            context = await self._load_context(job)
        except _PreflightError as error:
            return _failed(error.code, "backend_start", error.message, error.retryable)

        backend = self._backend_factory(self._settings)
        try:
            return await self._execute(backend, context, cancel_event)
        finally:
            await backend.aclose()

    async def _execute(
        self, backend: VoiceBackend, context: _JobContext, cancel_event: Event
    ) -> ExecutionOutcome:
        try:
            await self._record_backend_facts(backend, context)
        except _PreflightError as error:
            return _failed(error.code, "backend_start", error.message, error.retryable)

        if cancel_event.is_set():
            # 投入前に取消要求が届いていれば、runnerへ何も送らずに止める。
            return ExecutionOutcome(succeeded=False, stop_confirmed=True)

        produced: list[_Produced] = []
        try:
            for line in context.dialogue:
                if cancel_event.is_set():
                    # 途中まで生成した音声はShotの一部でしかない。中途半端な履歴を
                    # 残さず、書き出した分を消してから取消として返す。
                    self._discard_files(produced)
                    return ExecutionOutcome(succeeded=False, stop_confirmed=True)
                produced.append(await self._produce(backend, context, line))
        except VoiceTimeout as error:
            return self._discard(
                produced,
                FAILURE_CODE_EXECUTION_TIMEOUT,
                "timeout",
                str(error),
                retryable=True,
            )
        except VoiceExecutionFailed as error:
            return self._discard(
                produced,
                FAILURE_CODE_EXECUTION_FAILED,
                "execution",
                str(error),
                retryable=False,
            )
        except VoicePayloadTooLarge as error:
            return self._discard(
                produced,
                FAILURE_CODE_VOICE_PAYLOAD_TOO_LARGE,
                "execution",
                str(error),
                retryable=False,
            )
        except VoiceUnavailable as error:
            return self._discard(
                produced,
                FAILURE_CODE_BACKEND_DISCONNECTED,
                "response_disconnect",
                f"実行中にvoice-runnerへ接続できなくなりました: {backend.base_url}",
                retryable=True,
                error=error,
            )
        except audio.AudioError as error:
            return self._discard(
                produced,
                FAILURE_CODE_AUDIO_DECODE_FAILED,
                "execution",
                f"生成音声を扱えません: {error}",
                retryable=False,
            )
        except storage.StorageError as error:
            return self._discard(
                produced,
                FAILURE_CODE_ARTIFACT_WRITE_FAILED,
                "execution",
                str(error),
                retryable=False,
            )

        try:
            await self._persist(context, produced)
        except Exception as error:
            logger.exception(
                "音声Artifactの記録に失敗しました。job_id=%s", context.job_id
            )
            return self._discard(
                produced,
                FAILURE_CODE_ARTIFACT_WRITE_FAILED,
                "execution",
                "生成物の記録に失敗しました。",
                retryable=False,
                error=error,
            )
        return ExecutionOutcome(succeeded=True)

    async def _produce(
        self, backend: VoiceBackend, context: _JobContext, line: dict[str, Any]
    ) -> _Produced:
        """1台詞を生成し、尺をそろえて保存する。ASR検証はここでは失敗にしない。"""
        binding = context.bindings[str(line["voice_id"])]
        reading = line.get("reading")
        result = await backend.speech(
            SpeechRequest(
                engine=context.engine,
                text=str(line["text"]),
                reading=reading if isinstance(reading, str) else None,
                reference_audio=binding.reference_audio,
                reference_transcript=binding.transcript,
                seed=context.seed,
                language=context.language,
                timeout_sec=self._settings.voice_runner_timeout_seconds,
            )
        )
        audio_sec = audio.inspect(result.wav).duration_sec
        if context.pad_to_duration:
            padded, padded_sec = audio.pad_to(result.wav, context.target_duration_sec)
        else:
            padded, padded_sec = result.wav, audio_sec
        index = int(line["index"])
        stored = storage.write_artifact(
            context.job_id, f"voice_{index:03d}.wav", padded, self._settings
        )
        produced = _Produced(
            index=index,
            stored=stored,
            expected_text=str(line["text"]),
            expected_reading=reading if isinstance(reading, str) else None,
            audio_sec=round(audio_sec, 4),
            padded_sec=round(padded_sec, 4),
        )
        if context.verify_with_asr:
            # 検証は生成そのものの音声に対して行う。無音パディングは読みを変えない
            # ため、足す前のwavを書き起こす。
            await self._verify(backend, produced, context.language, result.wav)
        return produced

    async def _verify(
        self,
        backend: VoiceBackend,
        produced: _Produced,
        language: str,
        wav: bytes,
    ) -> None:
        """ASRの結果と期待読みを突き合わせる。

        不一致はJobの失敗にしない。ASRそのものが失敗した場合も生成は成立している
        ため、検証できなかったことを`status`へ残して先へ進む。
        """
        try:
            transcription = await backend.transcribe(wav, language)
        except (
            VoiceTimeout,
            VoiceUnavailable,
            VoiceExecutionFailed,
            VoicePayloadTooLarge,
        ) as error:
            logger.info("ASR検証を実行できませんでした。", exc_info=error)
            produced.status = STATUS_ASR_FAILED
            return
        produced.asr_text = transcription.text
        # 比較は表記のままでは行わない。Whisperは同音の別表記(朝比奈 → 朝日菜)を
        # 返すため、表記で比べると読めているものが不一致になる。
        expected_source = produced.expected_reading or produced.expected_text
        try:
            normalized_expected = kana.normalize(expected_source)
            normalized_asr = kana.normalize(transcription.text)
        except kana.KanaUnavailable as error:
            logger.warning("読みの正規化を実行できませんでした。", exc_info=error)
            produced.status = STATUS_KANA_UNAVAILABLE
            return
        produced.normalized_expected = normalized_expected
        produced.normalized_asr = normalized_asr
        produced.match = normalized_expected == normalized_asr
        produced.diff_ratio = (
            0.0
            if produced.match
            else kana.diff_ratio(normalized_expected, normalized_asr)
        )
        produced.status = STATUS_VERIFIED

    def _discard_files(self, produced: list[_Produced]) -> None:
        if produced:
            storage.discard_artifacts(
                [item.stored.relative_path for item in produced], self._settings
            )

    def _discard(
        self,
        produced: list[_Produced],
        code: str,
        stage: str,
        message: str,
        retryable: bool,
        *,
        error: BaseException | None = None,
    ) -> ExecutionOutcome:
        """途中まで保存したファイルを消してから失敗として返す。"""
        self._discard_files(produced)
        return _failed(code, stage, message, retryable, error=error)

    async def _load_context(self, job: GenerationJob) -> _JobContext:
        """Manifest、実行スナップショット、参照音声を読み、投入できる形にする。"""
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

    async def _record_backend_facts(
        self, backend: VoiceBackend, context: _JobContext
    ) -> None:
        """runnerの`/v1/health`でengineの利用可否とmodel情報を確かめ、1回だけ記録する。"""
        try:
            health = await backend.health()
        except VoiceTimeout as error:
            raise _PreflightError(
                FAILURE_CODE_BACKEND_UNAVAILABLE,
                f"voice-runnerが応答しません: {backend.base_url}",
                retryable=True,
            ) from error
        except VoiceUnavailable as error:
            raise _PreflightError(
                FAILURE_CODE_BACKEND_UNAVAILABLE,
                f"voice-runnerへ接続できません: {backend.base_url}",
                retryable=True,
            ) from error
        except VoiceExecutionFailed as error:
            raise _PreflightError(
                FAILURE_CODE_BACKEND_UNAVAILABLE,
                f"voice-runnerが状態を返しませんでした: {error}",
                retryable=True,
            ) from error

        info = health.engine(context.engine)
        if info is None:
            raise _PreflightError(
                FAILURE_CODE_BACKEND_UNAVAILABLE,
                f"voice-runnerが{context.engine}を公開していません。",
                retryable=False,
            )
        if not info.available:
            raise _PreflightError(
                FAILURE_CODE_BACKEND_UNAVAILABLE,
                f"{context.engine}を実行できません: {info.detail or '理由不明'}",
                retryable=True,
            )
        async with self._session_factory() as session:
            manifest = await session.get(GenerationManifest, context.manifest_id)
            if manifest is None:
                return
            changed = False
            if info.revision and not manifest.engine_version:
                manifest.engine_version = info.revision
                changed = True
            # `model`のmodel_id、model_revision、sample_rateは実行Backendの実測値で、
            # Job作成時点では確定できない。既に値が入っている場合は上書きしない。
            model = dict(manifest.model or {})
            for key, value in (
                ("model_id", info.model),
                ("model_revision", info.revision),
                ("sample_rate", info.sample_rate),
            ):
                if value is not None and model.get(key) is None:
                    model[key] = value
                    changed = True
            if changed:
                manifest.model = model
                await session.commit()

    async def _persist(self, context: _JobContext, produced: list[_Produced]) -> None:
        """音声Artifactと読み検証を同じトランザクションで記録する。

        commitまで終われば記録は確定している。sessionを閉じるときの失敗をそのまま
        伝えると、呼び出し元が記録済みのファイルを消してしまうため、ここで止める。
        """
        session = self._session_factory()
        try:
            created_at = schemas.now_iso()
            for item in produced:
                artifact_id = schemas.new_id()
                session.add(
                    Artifact(
                        id=artifact_id,
                        job_id=context.job_id,
                        kind="audio",
                        relative_path=item.stored.relative_path,
                        sha256=item.stored.sha256,
                        byte_size=item.stored.byte_size,
                        media_type=AUDIO_MEDIA_TYPE,
                        availability="complete",
                        parent_artifact_id=None,
                        created_at=created_at,
                        decision="undecided",
                        decision_at=None,
                    )
                )
                session.add(
                    VoiceVerification(
                        id=schemas.new_id(),
                        job_id=context.job_id,
                        artifact_id=artifact_id,
                        dialogue_index=item.index,
                        expected_text=item.expected_text,
                        expected_reading=item.expected_reading,
                        asr_text=item.asr_text,
                        normalized_expected=item.normalized_expected,
                        normalized_asr=item.normalized_asr,
                        match=item.match,
                        diff_ratio=item.diff_ratio,
                        audio_sec=item.audio_sec,
                        padded_sec=item.padded_sec,
                        target_duration_sec=context.target_duration_sec,
                        status=item.status,
                        created_at=created_at,
                    )
                )
            await session.commit()
        finally:
            try:
                await session.close()
            except Exception:
                logger.warning(
                    "Artifact記録後のsessionを閉じられませんでした。job_id=%s",
                    context.job_id,
                    exc_info=True,
                )


def _build_context(
    job_id: str, manifest_id: str, snapshot: dict[str, Any], settings: Settings
) -> _JobContext:
    """実行スナップショットと入力cacheから、実行に必要な値を組み立てる。"""
    engine = snapshot.get("engine")
    if not isinstance(engine, str) or not engine:
        raise _PreflightError(
            FAILURE_CODE_INPUT_UNRESOLVED,
            "実行スナップショットにengineがありません。",
            retryable=False,
        )
    dialogue = snapshot.get("dialogue")
    if not isinstance(dialogue, list) or not dialogue:
        raise _PreflightError(
            FAILURE_CODE_INPUT_UNRESOLVED,
            "実行スナップショットに台詞がありません。",
            retryable=False,
        )
    raw_voices = snapshot.get("voices")
    if not isinstance(raw_voices, dict) or not raw_voices:
        raise _PreflightError(
            FAILURE_CODE_INPUT_UNRESOLVED,
            "実行スナップショットにvoicesがありません。",
            retryable=False,
        )
    shot = snapshot.get("shot") if isinstance(snapshot.get("shot"), dict) else {}
    target = shot.get("duration_sec")
    bindings = {
        str(voice_id): _load_binding(str(voice_id), raw, settings)
        for voice_id, raw in raw_voices.items()
    }
    missing = sorted(
        {str(line.get("voice_id")) for line in dialogue if isinstance(line, dict)}
        - set(bindings)
    )
    if missing:
        raise _PreflightError(
            FAILURE_CODE_INPUT_UNRESOLVED,
            f"台詞が参照するVoice Canonの設定がありません: {', '.join(missing)}",
            retryable=False,
        )
    seed = snapshot.get("seed")
    return _JobContext(
        job_id=job_id,
        manifest_id=manifest_id,
        engine=engine,
        seed=seed if isinstance(seed, int) and not isinstance(seed, bool) else 0,
        language=(
            snapshot["language"] if isinstance(snapshot.get("language"), str) else "ja"
        ),
        verify_with_asr=bool(snapshot.get("verify_with_asr", True)),
        pad_to_duration=bool(snapshot.get("pad_to_duration", True)),
        target_duration_sec=(
            float(target)
            if isinstance(target, int | float) and not isinstance(target, bool)
            else 0.0
        ),
        dialogue=tuple(line for line in dialogue if isinstance(line, dict)),
        bindings=bindings,
    )


def _load_binding(voice_id: str, raw: Any, settings: Settings) -> _VoiceBinding:
    """参照音声を入力cacheから読み、Voice Canonが宣言するhashと突き合わせる。

    一致しない場合はJobを失敗させる。別人の声や別の録音で生成した履歴が、Voice Canon
    で生成したものとして残るのを防ぐ。
    """
    if not isinstance(raw, dict):
        raise _PreflightError(
            FAILURE_CODE_INPUT_UNRESOLVED,
            f"{voice_id}のvoice設定の形式が想定外です。",
            retryable=False,
        )
    reference = raw.get("reference")
    transcript = raw.get("reference_transcript")
    if not isinstance(reference, dict) or not isinstance(transcript, str):
        raise _PreflightError(
            FAILURE_CODE_INPUT_UNRESOLVED,
            f"{voice_id}の参照音声の設定が不足しています。",
            retryable=False,
        )
    relative_path = reference.get("relative_path")
    expected = reference.get("sha256")
    if not isinstance(relative_path, str) or not isinstance(expected, str):
        raise _PreflightError(
            FAILURE_CODE_INPUT_UNRESOLVED,
            f"{voice_id}の参照音声にrelative_pathかsha256がありません。",
            retryable=False,
        )
    try:
        data = storage.resolve_input(relative_path, settings).read_bytes()
    except (storage.StorageError, OSError) as error:
        raise _PreflightError(
            FAILURE_CODE_INPUT_UNRESOLVED,
            f"{voice_id}の参照音声を読み込めません。",
            retryable=False,
        ) from error
    if hashlib.sha256(data).hexdigest() != expected.lower():
        raise _PreflightError(
            FAILURE_CODE_VOICE_REFERENCE_MISMATCH,
            f"{voice_id}の参照音声がVoice Canonのsource_sha256と一致しません。",
            retryable=False,
        )
    if raw.get("trim_leading_silence"):
        leading = raw.get("leading_silence_sec")
        seconds = (
            float(leading)
            if isinstance(leading, int | float) and not isinstance(leading, bool)
            else 0.0
        )
        try:
            data = audio.trim_leading(data, seconds)
        except audio.AudioError as error:
            raise _PreflightError(
                FAILURE_CODE_AUDIO_DECODE_FAILED,
                f"{voice_id}の参照音声の先頭無音を切れません: {error}",
                retryable=False,
            ) from error
    return _VoiceBinding(voice_id=voice_id, reference_audio=data, transcript=transcript)


def _read_snapshot(artifact: Artifact, settings: Settings) -> dict[str, Any]:
    """保存済みの実行スナップショットを読み、記録済みのhashと突き合わせる。

    投入するのは作成時に保存したJSONそのものとする。組み立て直すと、記録した
    スナップショットと実際に送った内容がずれる余地が残るため。
    """
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
