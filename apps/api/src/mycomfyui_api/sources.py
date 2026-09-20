"""Jobの入力として指定された素材の解決。

利用者が選べるのは、既に記録されているArtifactと、取り込み済みの入力cacheの2つと
する。どちらもIDか`data_root`基準の相対パスで指し、絶対パスとファイル本体は受け取ら
ない。解決結果はManifestの`input_refs`と実行スナップショットへそのまま載るため、
書式の検証はここへ集約する。
"""

from dataclasses import dataclass
from typing import Any

from mycomfyui_api import provenance, storage
from mycomfyui_api.execution import PreparationError

#: 1件の素材指定が持てる項目。
SOURCE_NAMES = frozenset({"artifact_id", "relative_path", "sha256"})

_HEX_DIGITS = frozenset("0123456789abcdef")


@dataclass(frozen=True)
class InputSource:
    """解決済みの入力素材。実ファイルは読まず、参照と識別子だけを持つ。"""

    kind: str
    relative_path: str
    sha256: str
    file_name: str
    artifact_id: str | None = None
    job_id: str | None = None
    media_type: str | None = None


def _is_sha256(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and set(value.lower()) <= _HEX_DIGITS
    )


def _file_name(relative_path: str) -> str:
    return relative_path.rsplit("/", 1)[-1]


def cached_input_path(value: Any, label: str) -> str:
    """入力cacheの参照を検証する。

    Manifestへそのまま保存され、実行時にファイル解決へ使う値のため、`inputs/`配下の
    正規化済み相対パスだけを受け付ける。
    """
    if not isinstance(value, str) or not value.strip():
        raise PreparationError(f"{label}のrelative_pathがありません。")
    candidate = value.strip().replace("\\", "/")
    segments = candidate.split("/")
    if candidate.startswith("/") or (len(candidate) > 1 and candidate[1] == ":"):
        raise PreparationError(f"{label}に絶対パスを指定できません。")
    if ".." in segments or any(segment in ("", ".") for segment in segments):
        raise PreparationError(f"{label}のパスを正規化した形で指定してください。")
    if segments[0] != storage.INPUTS_DIR_NAME:
        raise PreparationError(
            f"{label}は{storage.INPUTS_DIR_NAME}/配下を指す必要があります。"
        )
    return candidate


async def resolve(
    raw: Any,
    *,
    label: str,
    lookup: Any,
    artifact_kinds: tuple[str, ...],
    allow_cached: bool = True,
) -> InputSource:
    """素材の指定を解決する。存在しないArtifactや種別違いはJobを作らない。"""
    if not isinstance(raw, dict):
        raise PreparationError(f"{label}の指定がobjectではありません。")
    unknown = sorted(set(raw) - SOURCE_NAMES)
    if unknown:
        raise PreparationError(
            f"{label}の指定に未知の項目があります。", {"unknown": unknown}
        )
    artifact_id = raw.get("artifact_id")
    if artifact_id is not None:
        return await _resolve_artifact(artifact_id, label, lookup, artifact_kinds)
    if not allow_cached:
        raise PreparationError(f"{label}はartifact_idで指定します。")
    relative_path = cached_input_path(raw.get("relative_path"), label)
    sha256 = raw.get("sha256")
    if not _is_sha256(sha256):
        raise PreparationError(f"{label}のsha256は小文字16進数64桁で指定します。")
    return InputSource(
        kind=provenance.KIND_CACHED_INPUT,
        relative_path=relative_path,
        sha256=str(sha256).lower(),
        file_name=_file_name(relative_path),
    )


async def _resolve_artifact(
    artifact_id: Any, label: str, lookup: Any, artifact_kinds: tuple[str, ...]
) -> InputSource:
    if not isinstance(artifact_id, str) or not artifact_id:
        raise PreparationError(f"{label}のartifact_idが不正です。")
    if lookup is None:
        raise PreparationError(f"{label}のArtifactを解決できません。")
    artifact = await lookup.get(artifact_id)
    if artifact is None:
        raise PreparationError(
            f"{label}のArtifactが見つかりません。", {"artifact_id": artifact_id}
        )
    if artifact.kind not in artifact_kinds:
        raise PreparationError(
            f"{label}に指定できないArtifactの種別です。",
            {
                "artifact_id": artifact_id,
                "kind": artifact.kind,
                "allowed": list(artifact_kinds),
            },
        )
    if artifact.availability != "complete":
        raise PreparationError(
            f"{label}のArtifactが未完成です。", {"artifact_id": artifact_id}
        )
    return InputSource(
        kind=provenance.KIND_ARTIFACT,
        relative_path=artifact.relative_path,
        sha256=artifact.sha256,
        file_name=_file_name(artifact.relative_path),
        artifact_id=artifact.id,
        job_id=artifact.job_id,
        media_type=artifact.media_type,
    )


def reference(source: InputSource, note: str) -> dict[str, Any]:
    """Manifestの`input_refs`へ載せる形にする。

    アップロードや合成で実際に使うファイルはここで固定する。Backend側のファイル名は
    実行ごとに変わりうるため、同一性の判定には内容hashだけを使う。
    """
    entry: dict[str, Any] = {
        "kind": source.kind,
        "relative_path": source.relative_path,
        "sha256": source.sha256,
        "note": note,
    }
    if source.artifact_id is not None:
        entry["artifact_id"] = source.artifact_id
    if source.job_id is not None:
        entry["job_id"] = source.job_id
    return entry
