"""キャラクターに登録した声の参照を、音声Jobの`voices`へ解決する (#573)。

Jobの入力に`story_character_id`があり、`voices`のvoiceが参照音声もcaptionも持たない
ときに、キャラクターの`voice_media_key` (`artifact:<id>`か`input:<relative_path>`) と
`voice_transcript`から、Clone用の参照 (`reference_*`の組) を埋める。呼び出し側が
参照かcaptionを書いたvoiceには触らない。captionを書いた場合は、キャラクターの声を
使わず声質の文章で生成する (`story_character_id`は紐づけだけに働く)。
"""

import hashlib
from pathlib import Path
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from mycomfyui_api import schemas, storage
from mycomfyui_api.adapters.voice.plan import REFERENCE_NAMES
from mycomfyui_api.execution import PreparationError
from mycomfyui_api.models import Artifact, StoryCharacter
from mycomfyui_api.settings import get_settings

ARTIFACT_KEY_PREFIX = "artifact:"
INPUT_KEY_PREFIX = "input:"


def _needs_voice(raw: Any) -> bool:
    """参照音声もcaptionも書かれていないvoice設定か。"""
    if raw is None:
        return True
    if not isinstance(raw, dict):
        return False
    if raw.get("caption") not in (None, ""):
        return False
    return all(raw.get(name) in (None, "") for name in REFERENCE_NAMES)


def _dialogue_voice_ids(dialogue: Any) -> list[str]:
    """台詞が参照するvoice_idを、現れた順に重複なく返す。"""
    if not isinstance(dialogue, list):
        return []
    found: list[str] = []
    for item in dialogue:
        voice_id = item.get("voice_id") if isinstance(item, dict) else None
        if isinstance(voice_id, str) and voice_id and voice_id not in found:
            found.append(voice_id)
    return found


async def _character_reference(
    session: AsyncSession, character: StoryCharacter, *, persist: bool
) -> dict[str, str]:
    """キャラクターの声を、入力cacheの参照音声 (`reference_*`の組) へ解決する。

    使えない理由は`PreparationError.details["reason"]`で区別する (`no_voice`、
    `artifact_missing`、`artifact_not_audio`、`artifact_trashed`、
    `artifact_unavailable`、`reference_unreadable`、`bad_key`)。
    """
    key = character.voice_media_key
    details = {"story_character_id": character.id}
    if not key:
        raise PreparationError(
            "キャラクターに声が登録されていません。", {**details, "reason": "no_voice"}
        )
    details = {**details, "voice_media_key": key}
    try:
        if key.startswith(ARTIFACT_KEY_PREFIX):
            artifact = await session.get(Artifact, key[len(ARTIFACT_KEY_PREFIX) :])
            if artifact is None:
                raise PreparationError(
                    "キャラクターの声の生成物がありません。",
                    {**details, "reason": "artifact_missing"},
                )
            if artifact.kind != "audio":
                raise PreparationError(
                    "キャラクターの声の生成物が音声ではありません。",
                    {**details, "reason": "artifact_not_audio"},
                )
            if artifact.deleted_at is not None:
                raise PreparationError(
                    "キャラクターの声の生成物がゴミ箱にあります。",
                    {**details, "reason": "artifact_trashed"},
                )
            if artifact.availability != "complete":
                raise PreparationError(
                    "キャラクターの声の生成物のファイルがそろっていません。",
                    {**details, "reason": "artifact_unavailable"},
                )
            data = storage.resolve_artifact(artifact.relative_path).read_bytes()
            name = Path(artifact.relative_path).name
            # 参照音声は`inputs/<sha256>/`の入力cacheに置いた内容で固定する。プレビュー
            # は置かずに、置く場所とhashだけを返す (投入しない参照を孤児にしない)。
            stored = (
                storage.write_input(name, data)
                if persist
                else storage.plan_input(name, data)
            )
            return {
                "reference_relative_path": stored.relative_path,
                "reference_sha256": stored.sha256,
            }
        if key.startswith(INPUT_KEY_PREFIX):
            path = storage.resolve_input(key[len(INPUT_KEY_PREFIX) :])
            data = path.read_bytes()
            # keyの`..`や区切りの揺れを残さず、解決後の入力cache内のパスを記録する。
            inputs_root = (get_settings().data_root / storage.INPUTS_DIR_NAME).resolve()
            relative_path = (
                f"{storage.INPUTS_DIR_NAME}/{path.relative_to(inputs_root).as_posix()}"
            )
            return {
                "reference_relative_path": relative_path,
                "reference_sha256": hashlib.sha256(data).hexdigest(),
            }
    except PreparationError:
        raise
    except (storage.StorageError, OSError, ValueError) as error:
        # NUL入りのパスは`ValueError`で来る。
        raise PreparationError(
            "キャラクターの声の参照音声を読み込めません。",
            {**details, "reason": "reference_unreadable"},
        ) from error
    raise PreparationError(
        "キャラクターの声の参照の形式が想定外です。", {**details, "reason": "bad_key"}
    )


async def resolve_character_voice(
    session: AsyncSession,
    payload: schemas.GenerationPreviewCreate,
    inputs: dict[str, Any],
    recipe_defaults: Any,
    *,
    persist: bool,
    shot_data: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], frozenset[str]]:
    """`inputs`の`voices`を、キャラクターの声で補った入力と、補ったvoice_idを返す。

    補うのは、音声Jobで`story_character_id`があり、参照もcaptionも無いvoiceだけ。
    `voices`自体が無いときは、台詞が参照するvoice_idごとに補う。台詞はShotを指定した
    ときそのShot本文 (`shot_data`)、指定しないときは`inputs`の`dialogue`から取る。補う対象が
    あるのにキャラクターに声が無ければ`PreparationError`とする。補う対象が2件以上あるときは、
    1人の声を複数の話者へ当てることになるため`PreparationError` (`reason=ambiguous_voice`)
    とし、`voices`で話者ごとに指定させる。`persist=False`
    (プレビュー) では、Artifactの音声を入力cacheへ書かない。
    """
    if payload.kind != "voice" or payload.story_character_id is None:
        return inputs, frozenset()
    defaults = recipe_defaults if isinstance(recipe_defaults, dict) else {}
    merged = {**defaults, **inputs}
    raw_voices = merged.get("voices")
    if isinstance(raw_voices, dict) and raw_voices:
        voices = dict(raw_voices)
    elif raw_voices in (None, {}):
        dialogue = (
            (shot_data or {}).get("dialogue")
            if payload.shot_id is not None
            else merged.get("dialogue")
        )
        voices = {voice_id: {} for voice_id in _dialogue_voice_ids(dialogue)}
    else:
        return inputs, frozenset()
    targets = [voice_id for voice_id, raw in voices.items() if _needs_voice(raw)]
    if not targets:
        return inputs, frozenset()
    if len(targets) > 1:
        raise PreparationError(
            "台詞の話者が複数あるため、キャラクターの声で補えません。"
            "voicesで話者ごとに声を指定してください。",
            {"voice_ids": [str(v) for v in targets], "reason": "ambiguous_voice"},
        )
    character = await session.get(StoryCharacter, payload.story_character_id)
    if character is None:
        raise PreparationError(
            "キャラクターがありません。",
            {"story_character_id": payload.story_character_id},
        )
    reference = await _character_reference(session, character, persist=persist)
    transcript = (character.voice_transcript or "").strip()
    if transcript:
        reference["reference_transcript"] = transcript
    for voice_id in targets:
        voices[voice_id] = {**(voices[voice_id] or {}), **reference}
    return {**inputs, "voices": voices}, frozenset(str(v) for v in targets)
