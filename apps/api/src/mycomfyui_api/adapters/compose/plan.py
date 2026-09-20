"""合成JobのRecipe検証と実行スナップショットの組み立て。

Shot 1件をJob 1件とし、動画1本に台詞音声とBGMを重ねた最終動画を1本作る。合成は
GPUを使わず入力も手元のArtifactだけのため、Remote PCではなく手元PCで実行する
([ADR 0002](docs/adr/0002-remote-gpu-host.md))。

利用者から受け取るのはArtifact IDと数値だけとする。ffmpegへ渡す引数はAdapterが
固定の形で組み立て、利用者が与えた文字列を引数へ流さない。
"""

from typing import Any

from mycomfyui_api import sources
from mycomfyui_api.execution import (
    PreparationContext,
    PreparationError,
    PreparedExecution,
)
from mycomfyui_api.models import Recipe

#: 合成のengine識別子。Recipeの`engine`にそのまま入る。
ENGINE_FFMPEG = "ffmpeg"

#: スナップショットの版。読み込み側は値を見て解釈を決める。
SNAPSHOT_VERSION = 1

#: 合成Recipeが指す実行スナップショットの形。ComfyUIのテンプレートに当たる。
COMPOSE_TEMPLATE_NAME = "ffmpeg_compose"

#: 画面から受け取れる入力。
COMPOSE_INPUT_NAMES = frozenset({"video", "voices", "bgm"})

#: 1トラックが持てる項目。
VOICE_TRACK_NAMES = frozenset({"artifact_id", "start_sec", "volume"})
BGM_TRACK_NAMES = frozenset({"artifact_id", "volume"})

#: 音量の既定値。BGMは台詞の約3分の1とする
#: (`ai-media/検証_minimax/27_10秒版/README.md`の実測: 台詞0.08に対しBGM0.030)。
DEFAULT_VOICE_VOLUME = 1.0
DEFAULT_BGM_VOLUME = 0.33

#: 音量の上限。増幅しすぎて割れた音を作らない。
MAX_VOLUME = 4.0

#: 台詞トラックの上限。Shot 1件に載る台詞の数として十分な値にする。
MAX_VOICE_TRACKS = 16

#: 出力の形。H.264 + AACのmp4に固定する。
OUTPUT_FILE_NAME = "compose.mp4"
OUTPUT_MEDIA_TYPE = "video/mp4"
VIDEO_CODEC = "libx264"
AUDIO_CODEC = "aac"


def _number(value: Any, label: str, *, minimum: float, maximum: float) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise PreparationError(f"{label}は数値で指定します。")
    number = float(value)
    if not minimum <= number <= maximum:
        raise PreparationError(
            f"{label}は{minimum}以上{maximum}以下で指定します。", {"value": number}
        )
    return number


def _validate_input_names(recipe: Recipe, inputs: dict[str, Any]) -> None:
    """受け取れる入力をRecipeの`input_schema`で絞る。"""
    unknown = sorted(set(inputs) - COMPOSE_INPUT_NAMES)
    if unknown:
        raise PreparationError(
            "合成Recipeで指定できない変数です。",
            {"rejected": unknown, "allowed": sorted(COMPOSE_INPUT_NAMES)},
        )
    schema = recipe.input_schema
    if not isinstance(schema, dict) or not schema:
        return
    undefined = sorted(set(schema) - COMPOSE_INPUT_NAMES)
    if undefined:
        raise PreparationError(
            "Recipeのinput_schemaが合成Jobに無い変数を指しています。",
            {"unknown": undefined},
        )
    rejected = sorted(set(inputs) - set(schema))
    if rejected:
        raise PreparationError(
            "このRecipeで指定できない変数です。",
            {"rejected": rejected, "allowed": sorted(schema)},
        )


def _split(raw: Any, allowed: frozenset[str], label: str) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise PreparationError(f"{label}の指定がobjectではありません。")
    unknown = sorted(set(raw) - allowed)
    if unknown:
        raise PreparationError(
            f"{label}の指定に未知の項目があります。", {"unknown": unknown}
        )
    return raw


async def prepare(
    recipe: Recipe, inputs: dict[str, Any], context: PreparationContext
) -> PreparedExecution:
    """入力Artifactを解決し、ffmpegへ渡す合成計画を組み立てる。"""
    if recipe.engine != ENGINE_FFMPEG:
        raise PreparationError(
            f"合成Recipeのengineが未対応です: {recipe.engine}",
            {"allowed": [ENGINE_FFMPEG]},
        )
    _validate_input_names(recipe, inputs)
    defaults = recipe.defaults if isinstance(recipe.defaults, dict) else {}
    values: dict[str, Any] = {**defaults, **inputs}

    raw_video = values.get("video")
    if raw_video is None:
        raise PreparationError("videoに合成する動画Artifactを指定します。")
    video = await sources.resolve(
        _split(raw_video, frozenset({"artifact_id"}), "動画"),
        label="動画",
        lookup=context.artifact_lookup,
        artifact_kinds=("video",),
        allow_cached=False,
    )

    raw_voices = values.get("voices", [])
    if not isinstance(raw_voices, list):
        raise PreparationError("voicesは配列で指定します。")
    if len(raw_voices) > MAX_VOICE_TRACKS:
        raise PreparationError(
            f"台詞音声は{MAX_VOICE_TRACKS}件までです。", {"count": len(raw_voices)}
        )
    voices: list[dict[str, Any]] = []
    input_refs = [sources.reference(video, "compose video")]
    for index, raw in enumerate(raw_voices):
        label = f"台詞音声{index + 1}件目"
        track = _split(raw, VOICE_TRACK_NAMES, label)
        source = await sources.resolve(
            {"artifact_id": track.get("artifact_id")},
            label=label,
            lookup=context.artifact_lookup,
            artifact_kinds=("audio",),
            allow_cached=False,
        )
        voices.append(
            {
                "index": index,
                "artifact_id": source.artifact_id,
                "relative_path": source.relative_path,
                "sha256": source.sha256,
                "start_sec": _number(
                    track.get("start_sec", 0.0),
                    f"{label}のstart_sec",
                    minimum=0.0,
                    maximum=3600.0,
                ),
                "volume": _number(
                    track.get("volume", DEFAULT_VOICE_VOLUME),
                    f"{label}のvolume",
                    minimum=0.0,
                    maximum=MAX_VOLUME,
                ),
            }
        )
        input_refs.append(sources.reference(source, f"compose voice {index}"))

    raw_bgm = values.get("bgm")
    bgm: dict[str, Any] | None = None
    if raw_bgm is not None:
        track = _split(raw_bgm, BGM_TRACK_NAMES, "BGM")
        source = await sources.resolve(
            {"artifact_id": track.get("artifact_id")},
            label="BGM",
            lookup=context.artifact_lookup,
            artifact_kinds=("audio",),
            allow_cached=False,
        )
        bgm = {
            "artifact_id": source.artifact_id,
            "relative_path": source.relative_path,
            "sha256": source.sha256,
            "volume": _number(
                track.get("volume", DEFAULT_BGM_VOLUME),
                "BGMのvolume",
                minimum=0.0,
                maximum=MAX_VOLUME,
            ),
            # 動画より長いBGMは動画の尺で切り詰める。
            "truncate_to_video": True,
        }
        input_refs.append(sources.reference(source, "compose bgm"))

    snapshot: dict[str, Any] = {
        "version": SNAPSHOT_VERSION,
        "engine": ENGINE_FFMPEG,
        "output": {
            "file_name": OUTPUT_FILE_NAME,
            "media_type": OUTPUT_MEDIA_TYPE,
            "video_codec": VIDEO_CODEC,
            "audio_codec": AUDIO_CODEC,
        },
        "video": {
            "artifact_id": video.artifact_id,
            "relative_path": video.relative_path,
            "sha256": video.sha256,
        },
        "voices": voices,
        "bgm": bgm,
    }
    return PreparedExecution(
        snapshot=snapshot,
        # 合成に乱数は無い。再現に使う値が無いことを0で表す。
        seed=0,
        resolved_prompt=_resolved_prompt(len(voices), bgm is not None),
        model={
            "engine": ENGINE_FFMPEG,
            "video_codec": VIDEO_CODEC,
            "audio_codec": AUDIO_CODEC,
        },
        parameters={
            "snapshot_version": SNAPSHOT_VERSION,
            "voice_track_count": len(voices),
            "has_bgm": bgm is not None,
            "voice_offsets_sec": [track["start_sec"] for track in voices],
            "voice_volumes": [track["volume"] for track in voices],
            "bgm_volume": bgm["volume"] if bgm else None,
        },
        input_refs=input_refs,
        # 動画Artifactを作ったJobを親に持たせ、合成結果から生成元を辿れるようにする。
        parent_job_id=video.job_id,
    )


def _resolved_prompt(voice_count: int, has_bgm: bool) -> str:
    """Manifestへ残す、解決済みの合成内容。"""
    parts = ["動画1本"]
    if voice_count:
        parts.append(f"台詞音声{voice_count}件")
    if has_bgm:
        parts.append("BGM1件")
    return " + ".join(parts) + " を1本のmp4へ合成する"
