"""音声JobのRecipe検証と実行スナップショットの組み立て。

Shot 1件をJob 1件とし、Shot内の台詞ごとに音声を1件ずつ生成する。台詞単位でJobを
分けないのは、VoxCPM2のロードが29〜67秒かかるのに対し生成そのものは平均1.77秒で、
1回のプロセス起動でまとめて生成するほうが実行時間が短いためである
(`ai-media/docs/tts-backends.md`)。

スナップショットは、voice-runnerへ送るリクエストのうち参照音声のbase64を
そのSHA-256参照へ置き換えたJSONとする。これによりWorkflow Artifactのhash検証が
既存実装のまま効き、Exact Replayも画像Jobと同じ経路で動く。
"""

import random
from typing import Any

from mycomfyui_api import provenance, storage
from mycomfyui_api.adapters.aimedia.client import AiMediaError
from mycomfyui_api.adapters.voice.base import VOICE_ENGINES
from mycomfyui_api.execution import (
    PreparationContext,
    PreparationError,
    PreparedExecution,
)
from mycomfyui_api.models import Recipe

#: スナップショットの版。読み込み側は値を見て解釈を決める。
SNAPSHOT_VERSION = 1

#: seedの自動採番を指示する値。
AUTO_SEED = -1

#: seedの上限。画像Jobと同じく、JSONの数値としてWeb UIまで誤差なく往復できる範囲へ
#: 揃える。これを超えると画面に出るseedと実際に使った値がずれ、再現できなくなる。
MAX_SEED = 2**53 - 1

#: 先頭無音を切り落とすしきい値。Voice Canonが宣言する`leading_silence_sec`が
#: これ以上のときだけ切る。短い無音まで削ると語頭の子音を削る危険があるため
#: (`ai-media/docs/tts-backends.md`の「先頭無音」)。
LEADING_SILENCE_TRIM_THRESHOLD_SEC = 0.5

#: Shotの尺の許容範囲。参照APIのShot Schemaに合わせる。
MIN_DURATION_SEC = 1.0
MAX_DURATION_SEC = 15.0

#: 画面から受け取れる入力と、その型・必須。Workflowレジストリの変数定義にも使う。
VOICE_VARIABLES: dict[str, dict[str, Any]] = {
    "profile": {"value_type": "str", "required": False},
    "language": {"value_type": "str", "required": False},
    "seed": {"value_type": "seed", "required": False},
    "verify_with_asr": {"value_type": "bool", "required": False},
    "pad_to_duration": {"value_type": "bool", "required": False},
    "voices": {"value_type": "voice_bindings", "required": True},
}

#: 画面から受け取れる入力。Recipeの`input_schema`はこの範囲より狭くできる。
VOICE_INPUT_NAMES = frozenset(VOICE_VARIABLES)

#: 1台詞のvoice bindingが持てる項目。
VOICE_BINDING_NAMES = frozenset(
    {
        "canon_id",
        "reference_relative_path",
        "reference_sha256",
        "reference_transcript",
        "leading_silence_sec",
    }
)

_HEX_DIGITS = frozenset("0123456789abcdef")


def _is_sha256(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and set(value.lower()) <= _HEX_DIGITS
    )


def _resolve_seed(value: Any) -> int:
    if value is None or value == AUTO_SEED:
        return random.randrange(0, MAX_SEED + 1)
    if not isinstance(value, int) or isinstance(value, bool):
        raise PreparationError("seedは整数で指定します。")
    if not 0 <= value <= MAX_SEED:
        raise PreparationError(f"seedは{AUTO_SEED}、または0以上{MAX_SEED}以下です。")
    return value


def _cached_input_path(value: Any, voice_id: str) -> str:
    """参照音声の入力cache参照を検証する。

    Manifestへそのまま保存され、実行時にファイル解決へ使う値のため、`inputs/`配下の
    正規化済み相対パスだけを受け付ける。
    """
    if not isinstance(value, str) or not value.strip():
        raise PreparationError(
            f"{voice_id}の参照音声にreference_relative_pathがありません。"
        )
    candidate = value.strip().replace("\\", "/")
    segments = candidate.split("/")
    if candidate.startswith("/") or (len(candidate) > 1 and candidate[1] == ":"):
        raise PreparationError(f"{voice_id}の参照音声に絶対パスを指定できません。")
    if ".." in segments or any(segment in ("", ".") for segment in segments):
        raise PreparationError(
            f"{voice_id}の参照音声のパスを正規化した形で指定してください。"
        )
    if segments[0] != storage.INPUTS_DIR_NAME:
        raise PreparationError(
            f"{voice_id}の参照音声は{storage.INPUTS_DIR_NAME}/配下を指す必要が"
            "あります。"
        )
    return candidate


def _binding(voice_id: str, raw: Any) -> dict[str, Any]:
    """1つのVoice Canonに対応する実行用の値を組み立てる。

    参照テキストを持たないVoice Canonは実行対象にしない。嘘の参照テキストを渡すと
    生成が破綻することが`ai-media/検証_minimax/18`で確認されており、空文字を黙って
    渡すのは同じ結果を招くためである。
    """
    if not isinstance(raw, dict):
        raise PreparationError(f"{voice_id}のvoice設定がobjectではありません。")
    unknown = sorted(set(raw) - VOICE_BINDING_NAMES)
    if unknown:
        raise PreparationError(
            f"{voice_id}のvoice設定に未知の項目があります。", {"unknown": unknown}
        )
    transcript = raw.get("reference_transcript")
    if not isinstance(transcript, str) or not transcript.strip():
        raise PreparationError(
            f"{voice_id}のreference_transcriptがありません。"
            "参照テキストを持たないVoice Canonは実行できません。"
        )
    sha256 = raw.get("reference_sha256")
    if not _is_sha256(sha256):
        raise PreparationError(
            f"{voice_id}のreference_sha256は小文字16進数64桁で指定します。"
        )
    canon_id = raw.get("canon_id")
    if not _is_sha256(canon_id):
        # どのVoice Canonで生成したかを後から説明できないJobを作らない。省略できる
        # ようにすると、参照音声だけを渡したJobが履歴にCanon参照を残さずに残る。
        raise PreparationError(
            f"{voice_id}のcanon_idは小文字16進数64桁で指定します。"
            "Voice Canonを指定しない音声Jobは作れません。"
        )
    leading_silence = raw.get("leading_silence_sec", 0.0)
    if isinstance(leading_silence, bool) or not isinstance(
        leading_silence, int | float
    ):
        raise PreparationError(f"{voice_id}のleading_silence_secは数値で指定します。")
    if leading_silence < 0:
        raise PreparationError(f"{voice_id}のleading_silence_secは0以上です。")
    return {
        "voice_id": voice_id,
        "canon_id": str(canon_id).lower(),
        "reference": {
            "relative_path": _cached_input_path(
                raw.get("reference_relative_path"), voice_id
            ),
            "sha256": str(sha256).lower(),
        },
        "reference_transcript": transcript,
        "leading_silence_sec": float(leading_silence),
        # 先頭無音を切るかどうかはAdapterが決める。判断結果をManifestへ残す。
        "trim_leading_silence": (
            float(leading_silence) >= LEADING_SILENCE_TRIM_THRESHOLD_SEC
        ),
    }


def _dialogue(shot_data: dict[str, Any]) -> list[dict[str, Any]]:
    """Shot本文から台詞を取り出し、Job内での位置を固定する。"""
    raw = shot_data.get("dialogue")
    if not isinstance(raw, list) or not raw:
        raise PreparationError(
            "Shotに台詞がありません。音声Jobを作れません。",
            {"shot_id": shot_data.get("id")},
        )
    lines: list[dict[str, Any]] = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise PreparationError(f"{index}番目の台詞の形式が想定外です。")
        text = item.get("text")
        voice_id = item.get("voice_id")
        if not isinstance(text, str) or not text.strip():
            raise PreparationError(f"{index}番目の台詞にtextがありません。")
        if not isinstance(voice_id, str) or not voice_id:
            raise PreparationError(f"{index}番目の台詞にvoice_idがありません。")
        reading = item.get("reading")
        speaker = item.get("speaker")
        start_sec = item.get("start_sec")
        lines.append(
            {
                "index": index,
                "speaker": speaker if isinstance(speaker, str) else None,
                "voice_id": voice_id,
                "text": text,
                "reading": reading if isinstance(reading, str) and reading else None,
                "start_sec": (
                    float(start_sec)
                    if isinstance(start_sec, int | float)
                    and not isinstance(start_sec, bool)
                    else None
                ),
            }
        )
    return lines


def _duration(shot_data: dict[str, Any]) -> float:
    value = shot_data.get("duration_sec")
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise PreparationError("Shotにduration_secがありません。")
    duration = float(value)
    if not MIN_DURATION_SEC <= duration <= MAX_DURATION_SEC:
        raise PreparationError(
            f"Shotのduration_secが想定の範囲外です: {duration}",
            {"min": MIN_DURATION_SEC, "max": MAX_DURATION_SEC},
        )
    return duration


def _validate_input_names(recipe: Recipe, inputs: dict[str, Any]) -> None:
    """受け取れる入力をRecipeの`input_schema`で絞る。

    画像Jobと同じく、`input_schema`が空でなければそのキーが受け取れる全体になる。
    """
    unknown = sorted(set(inputs) - VOICE_INPUT_NAMES)
    if unknown:
        raise PreparationError(
            "音声Recipeで指定できない変数です。",
            {"rejected": unknown, "allowed": sorted(VOICE_INPUT_NAMES)},
        )
    schema = recipe.input_schema
    if not isinstance(schema, dict) or not schema:
        return
    undefined = sorted(set(schema) - VOICE_INPUT_NAMES)
    if undefined:
        raise PreparationError(
            "Recipeのinput_schemaが音声Jobに無い変数を指しています。",
            {"unknown": undefined},
        )
    rejected = sorted(set(inputs) - set(schema))
    if rejected:
        raise PreparationError(
            "このRecipeで指定できない変数です。",
            {"rejected": rejected, "allowed": sorted(schema)},
        )


async def _canon_refs(
    context: PreparationContext, bindings: dict[str, dict[str, Any]]
) -> list[dict[str, Any]]:
    """Voice Canon descriptorを参照APIから引き、不変参照として記録する。

    Canon本文は取得しない。`canon_id`は`_binding`で必須にしてあり、参照を引けない
    場合はJobを作らない。どのVoice Canonで生成したかを説明できない履歴を残さない。
    """
    source = context.canon_lookup
    entries: list[dict[str, Any]] = []
    for voice_id, binding in bindings.items():
        canon_id = binding["canon_id"]
        if source is None:
            raise PreparationError("Voice Canonを解決できません。")
        try:
            descriptor = await source.get_canon(context.project_id, canon_id)
        except AiMediaError as error:
            raise PreparationError(
                f"{voice_id}のVoice Canonを参照APIから取得できません: {error}",
                {"canon_id": canon_id},
            ) from error
        if not isinstance(descriptor, dict):
            raise PreparationError(f"{voice_id}のCanon descriptorの形式が想定外です。")
        try:
            entry = provenance.canon_entry(
                descriptor.get("reference"),
                declared_by=provenance.DECLARED_BY_INPUT,
                declared_in=context.shot_id,
                voice_id=voice_id,
            )
        except provenance.ReferenceError as error:
            raise PreparationError(
                f"{voice_id}のCanon descriptorから不変参照を取り出せません: {error}",
                {"canon_id": canon_id},
            ) from error
        if entry.get("canon_id") != canon_id:
            # 指定したIDと、参照から算出したIDが食い違う。どちらが正しいか決められない
            # ため、取り違えたまま履歴へ残さない。
            raise PreparationError(
                f"{voice_id}のcanon_idがCanon descriptorの不変参照と一致しません。",
                {"canon_id": canon_id, "resolved": entry.get("canon_id")},
            )
        entries.append(entry)
    return entries


def _resolved_prompt(lines: list[dict[str, Any]]) -> str:
    """Manifestへ残す、解決済みの台詞。

    実際に読ませる本文(`text`)と、期待する読み(`reading`)を並べる。どちらを渡したかは
    Backendごとに変わるため、両方を残して後から突き合わせられるようにする。
    """
    rendered: list[str] = []
    for line in lines:
        speaker = line["speaker"] or line["voice_id"]
        body = f"{speaker}: {line['text']}"
        if line["reading"]:
            body = f"{body} / 読み: {line['reading']}"
        rendered.append(body)
    return "\n".join(rendered)


async def prepare(
    recipe: Recipe, inputs: dict[str, Any], context: PreparationContext
) -> PreparedExecution:
    """Recipeの既定値と要求の`inputs`から、voice-runnerへ送る内容を組み立てる。"""
    if recipe.engine not in VOICE_ENGINES:
        raise PreparationError(
            f"音声Recipeのengineが未対応です: {recipe.engine}",
            {"allowed": list(VOICE_ENGINES)},
        )
    _validate_input_names(recipe, inputs)
    defaults = recipe.defaults if isinstance(recipe.defaults, dict) else {}
    values: dict[str, Any] = {**defaults, **inputs}

    raw_voices = values.get("voices")
    if not isinstance(raw_voices, dict) or not raw_voices:
        raise PreparationError("voicesに、台詞が参照するVoice Canonの設定が必要です。")
    bindings = {
        str(voice_id): _binding(str(voice_id), raw)
        for voice_id, raw in raw_voices.items()
    }

    lines = _dialogue(context.shot_data)
    missing = sorted({line["voice_id"] for line in lines} - set(bindings))
    if missing:
        raise PreparationError(
            "台詞が参照するVoice Canonの設定がありません。", {"missing": missing}
        )

    seed = _resolve_seed(values.get("seed"))
    profile = values.get("profile", "default")
    if not isinstance(profile, str) or not profile:
        raise PreparationError("profileは空でない文字列で指定します。")
    language = values.get("language", "ja")
    if not isinstance(language, str) or not language:
        raise PreparationError("languageは空でない文字列で指定します。")
    verify_with_asr = values.get("verify_with_asr", True)
    if not isinstance(verify_with_asr, bool):
        raise PreparationError("verify_with_asrは真偽値で指定します。")
    pad_to_duration = values.get("pad_to_duration", True)
    if not isinstance(pad_to_duration, bool):
        raise PreparationError("pad_to_durationは真偽値で指定します。")

    duration_sec = _duration(context.shot_data)
    canon_refs = await _canon_refs(context, bindings)

    snapshot: dict[str, Any] = {
        "version": SNAPSHOT_VERSION,
        "engine": recipe.engine,
        "profile": profile,
        "language": language,
        "seed": seed,
        "verify_with_asr": verify_with_asr,
        "pad_to_duration": pad_to_duration,
        "shot": {"id": context.shot_id, "duration_sec": duration_sec},
        "voices": {voice_id: dict(binding) for voice_id, binding in bindings.items()},
        "dialogue": lines,
    }
    # 参照音声のcache参照は、利用者素材として再実行の検証対象になる。
    cached_refs = [
        {
            "kind": provenance.KIND_CACHED_INPUT,
            "relative_path": binding["reference"]["relative_path"],
            "sha256": binding["reference"]["sha256"],
            "note": f"voice reference: {voice_id}",
        }
        for voice_id, binding in bindings.items()
    ]
    return PreparedExecution(
        snapshot=snapshot,
        seed=seed,
        resolved_prompt=_resolved_prompt(lines),
        model={
            "engine": recipe.engine,
            "profile": profile,
            # model_id、model_revision、sample_rateは実行Backendの実測値のため、
            # Adapterが実行開始直後に1回だけ埋める。
            "model_id": None,
            "model_revision": None,
            "sample_rate": None,
        },
        parameters={
            "profile": profile,
            "language": language,
            "verify_with_asr": verify_with_asr,
            "pad_to_duration": pad_to_duration,
            "target_duration_sec": duration_sec,
            "snapshot_version": SNAPSHOT_VERSION,
            "leading_silence": {
                voice_id: {
                    "declared_sec": binding["leading_silence_sec"],
                    "trim": binding["trim_leading_silence"],
                }
                for voice_id, binding in bindings.items()
            },
        },
        input_refs=[*canon_refs, *cached_refs],
    )
