"""生成音声の尺と無音パディング。

標準ライブラリの`wave`だけを使い、Application APIのvenvへ音声処理の依存を増やさない。
扱うのはPCM wavに限る。別の符号化で返ってきた場合は解釈できない入力として失敗させる。
"""

import io
import wave
from dataclasses import dataclass


class AudioError(ValueError):
    """wavを解釈できない、または組み立てられない。"""


@dataclass(frozen=True)
class AudioInfo:
    """wavのヘッダから読める情報。"""

    sample_rate: int
    channels: int
    sample_width: int
    frames: int

    @property
    def duration_sec(self) -> float:
        if self.sample_rate <= 0:
            raise AudioError("sample_rateが0以下のwavです。")
        return self.frames / self.sample_rate


def inspect(data: bytes) -> AudioInfo:
    """wavのヘッダを読む。"""
    try:
        with wave.open(io.BytesIO(data), "rb") as source:
            return AudioInfo(
                sample_rate=source.getframerate(),
                channels=source.getnchannels(),
                sample_width=source.getsampwidth(),
                frames=source.getnframes(),
            )
    except (wave.Error, EOFError, OSError) as error:
        raise AudioError("wavとして解釈できません。") from error


def pad_to(data: bytes, target_sec: float) -> tuple[bytes, float]:
    """末尾へ無音を足して尺を`target_sec`へそろえる。

    生成音声が`target_sec`を超えている場合はパディングしない。切り詰めると台詞が
    途中で切れるため、超過はそのまま残し、呼び出し側が記録して利用者へ見せる。

    戻り値は(wav, パディング後の尺)とする。
    """
    info = inspect(data)
    if target_sec <= 0:
        return data, info.duration_sec
    missing = target_sec - info.duration_sec
    if missing <= 0:
        return data, info.duration_sec
    extra_frames = round(missing * info.sample_rate)
    if extra_frames <= 0:
        return data, info.duration_sec
    # 16bit以下のPCMはゼロ値が無音。8bit PCMだけは中央値が0x80になる。
    fill = b"\x80" if info.sample_width == 1 else b"\x00"
    silence = fill * (extra_frames * info.sample_width * info.channels)
    try:
        with wave.open(io.BytesIO(data), "rb") as source:
            frames = source.readframes(info.frames)
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as sink:
            sink.setnchannels(info.channels)
            sink.setsampwidth(info.sample_width)
            sink.setframerate(info.sample_rate)
            sink.writeframes(frames + silence)
    except (wave.Error, EOFError, OSError) as error:
        raise AudioError("wavへ無音を足せません。") from error
    padded = buffer.getvalue()
    return padded, inspect(padded).duration_sec


def silence(sample_rate: int, seconds: float, *, sample_width: int = 2) -> bytes:
    """無音のPCM wavを作る。スタブBackendと先頭無音の切り落としで使う。"""
    frames = max(round(sample_rate * seconds), 0)
    fill = b"\x80" if sample_width == 1 else b"\x00"
    buffer = io.BytesIO()
    try:
        with wave.open(buffer, "wb") as sink:
            sink.setnchannels(1)
            sink.setsampwidth(sample_width)
            sink.setframerate(sample_rate)
            sink.writeframes(fill * (frames * sample_width))
    except (wave.Error, OSError) as error:
        raise AudioError("無音wavを組み立てられません。") from error
    return buffer.getvalue()


def trim_leading(data: bytes, seconds: float) -> bytes:
    """先頭の無音を切る。

    Voice Canonの`reference.leading_silence_sec`が長い参照音声を、runnerへ渡す前に
    整えるために使う。切る長さが音声全体より長い場合は、参照音声が空になるのを避けて
    そのまま返す。
    """
    if seconds <= 0:
        return data
    info = inspect(data)
    skip = round(seconds * info.sample_rate)
    if skip <= 0 or skip >= info.frames:
        return data
    try:
        with wave.open(io.BytesIO(data), "rb") as source:
            source.setpos(skip)
            frames = source.readframes(info.frames - skip)
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as sink:
            sink.setnchannels(info.channels)
            sink.setsampwidth(info.sample_width)
            sink.setframerate(info.sample_rate)
            sink.writeframes(frames)
    except (wave.Error, EOFError, OSError) as error:
        raise AudioError("先頭無音を切り落とせません。") from error
    return buffer.getvalue()
