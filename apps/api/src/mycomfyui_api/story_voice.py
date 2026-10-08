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
    session: AsyncSession, character: StoryCharacter
) -> dict[str, str]:
    """キャラクターの声を、入力cacheの参照音声 (`reference_*`の組) へ解決する。"""
    key = character.voice_media_key
    details = {"story_character_id": character.id}
    if not key:
        raise PreparationError("キャラクターに声が登録されていません。", details)
    try:
        if key.startswith(ARTIFACT_KEY_PREFIX):
            artifact = await session.get(Artifact, key[len(ARTIFACT_KEY_PREFIX) :])
            if (
                artifact is None
                or artifact.kind != "audio"
                or artifact.deleted_at is not None
                or artifact.availability != "complete"
            ):
                raise PreparationError(
                    "キャラクターの声の生成物を参照音声として使えません。",
                    {**details, "voice_media_key": key},
                )
            data = storage.resolve_artifact(artifact.relative_path).read_bytes()
            # 参照音声は`inputs/<sha256>/`の入力cacheに置いた内容で固定する。
            stored = storage.write_input(Path(artifact.relative_path).name, data)
            return {
                "reference_relative_path": stored.relative_path,
                "reference_sha256": stored.sha256,
            }
        if key.startswith(INPUT_KEY_PREFIX):
            relative_path = key[len(INPUT_KEY_PREFIX) :]
            data = storage.resolve_input(relative_path).read_bytes()
            return {
                "reference_relative_path": relative_path,
                "reference_sha256": hashlib.sha256(data).hexdigest(),
            }
    except (storage.StorageError, OSError) as error:
        raise PreparationError(
            "キャラクターの声の参照音声を読み込めません。",
            {**details, "voice_media_key": key},
        ) from error
    raise PreparationError(
        "キャラクターの声の参照の形式が想定外です。", {**details, "voice_media_key": key}
    )


async def resolve_character_voice(
    session: AsyncSession,
    payload: schemas.GenerationPreviewCreate,
    inputs: dict[str, Any],
    recipe_defaults: Any,
) -> tuple[dict[str, Any], frozenset[str]]:
    """`inputs`の`voices`を、キャラクターの声で補った入力と、補ったvoice_idを返す。

    補うのは、音声Jobで`story_character_id`があり、参照もcaptionも無いvoiceだけ。
    `voices`自体が無いときは、`dialogue`の台詞が参照するvoice_idごとに補う。補う対象が
    あるのにキャラクターに声が無ければ`PreparationError`とする。
    """
    if payload.kind != "voice" or payload.story_character_id is None:
        return inputs, frozenset()
    defaults = recipe_defaults if isinstance(recipe_defaults, dict) else {}
    merged = {**defaults, **inputs}
    raw_voices = merged.get("voices")
    if isinstance(raw_voices, dict) and raw_voices:
        voices = dict(raw_voices)
    elif raw_voices in (None, {}):
        voices = {voice_id: {} for voice_id in _dialogue_voice_ids(merged.get("dialogue"))}
    else:
        return inputs, frozenset()
    targets = [voice_id for voice_id, raw in voices.items() if _needs_voice(raw)]
    if not targets:
        return inputs, frozenset()
    character = await session.get(StoryCharacter, payload.story_character_id)
    if character is None:
        raise PreparationError(
            "キャラクターがありません。",
            {"story_character_id": payload.story_character_id},
        )
    reference = await _character_reference(session, character)
    transcript = (character.voice_transcript or "").strip()
    if transcript:
        reference["reference_transcript"] = transcript
    for voice_id in targets:
        voices[voice_id] = {**(voices[voice_id] or {}), **reference}
    return {**inputs, "voices": voices}, frozenset(str(v) for v in targets)
