"""Scene、Shot、Canonの不変参照の解決と突き合わせ。

参照APIの応答Envelopeから、Generation Manifestへ固定する不変参照を組み立てる。Canon
本文は扱わず、`source_locator`、`revision`、`path`、`sha256`、`anchor`だけを保存する
(docs/design/generation-records.md)。記録済みの参照と現在の参照を比べる処理もここへ
閉じ込め、呼び出し側は判定結果だけを扱う。
"""

import hashlib
import json
from collections.abc import Mapping, Sequence
from typing import Any

#: Manifestの`input_refs`が持つ参照の種別。`cached_input`は利用者素材のcache参照で、
#: 参照APIでは解決しないため、ここには含めない。
KIND_SCENE = "scene"
KIND_SHOT = "shot"
KIND_CANON = "canon"
KIND_CACHED_INPUT = "cached_input"
#: 生成済みArtifactを入力に使ったときの参照。参照APIでは解決しない。
KIND_ARTIFACT = "artifact"

#: Canon参照の出どころ。Scene/Shot本文が宣言したものと、Jobの入力として利用者が
#: 選んだものを区別する。後者は本文から辿れないため、引き直すときの手がかりになる。
DECLARED_BY_INPUT = "input"

#: 参照APIから解決し直せる種別。Canon更新警告と再実行の検証はこれだけを対象にする。
RESOLVABLE_KINDS = frozenset({KIND_SCENE, KIND_SHOT, KIND_CANON})

CHANGE_UNCHANGED = "unchanged"
CHANGE_UPDATED = "updated"
CHANGE_MISSING = "missing"
CHANGE_ADDED = "added"

REVISION_LENGTH = 40
SHA256_LENGTH = 64

_HEX_DIGITS = frozenset("0123456789abcdef")


class ReferenceError(ValueError):
    """参照APIの応答から不変参照を取り出せない。"""


def _is_hex(value: str) -> bool:
    return set(value) <= _HEX_DIGITS


def _text(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _validate_repository_path(path: str) -> str:
    """repository相対pathだけを受け付ける。

    参照契約は`/`区切りの相対pathに限定し、絶対path、backslash、`..`を拒否する。
    記録した値は再実行時の突き合わせと画面表示にそのまま使うため、保存前に弾く。

    空セグメントと`.`セグメントも拒否する。`a//b`と`a/./b`は`a/b`と同じ場所を指す
    のに文字列としては別物になり、同一性の判定が参照先とずれる。
    """
    if path.startswith("/") or (len(path) > 1 and path[1] == ":"):
        raise ReferenceError(f"参照pathに絶対pathを指定できません: {path}")
    if "\\" in path:
        raise ReferenceError(f"参照pathにbackslashを含められません: {path}")
    segments = path.split("/")
    if ".." in segments:
        raise ReferenceError(f"参照pathに親ディレクトリ参照を含められません: {path}")
    if any(segment in ("", ".") for segment in segments):
        raise ReferenceError(f"参照pathを正規化した形で指定してください: {path}")
    return path


def immutable_reference(raw: Any) -> dict[str, Any]:
    """参照APIが返した不変参照を検証して正規化する。

    `revision`と`sha256`は再実行時の一致判定に使う。書式が崩れた値を記録すると、後から
    同一性を判定できないまま履歴だけが残るため、保存前にここで弾く。
    """
    if not isinstance(raw, Mapping):
        raise ReferenceError("不変参照がobjectではありません。")
    source_locator = _text(raw.get("source_locator"))
    revision = _text(raw.get("revision"))
    path = _text(raw.get("path"))
    sha256 = _text(raw.get("sha256"))
    if not (source_locator and revision and path and sha256):
        raise ReferenceError(
            "不変参照にsource_locator、revision、path、sha256のいずれかがありません。"
        )
    revision = revision.lower()
    sha256 = sha256.lower()
    if len(revision) != REVISION_LENGTH or not _is_hex(revision):
        raise ReferenceError(f"revisionの書式が想定外です: {revision}")
    if len(sha256) != SHA256_LENGTH or not _is_hex(sha256):
        raise ReferenceError(f"sha256の書式が想定外です: {sha256}")
    anchor = raw.get("anchor")
    if anchor is not None and not isinstance(anchor, str):
        raise ReferenceError("anchorは文字列かnullで指定します。")
    note = raw.get("note")
    if note is not None and not isinstance(note, str):
        raise ReferenceError("noteは文字列かnullで指定します。")
    return {
        "source_locator": source_locator,
        "revision": revision,
        "path": _validate_repository_path(path),
        "sha256": sha256,
        "anchor": anchor,
        "note": note,
    }


def canon_id(reference: Mapping[str, Any]) -> str:
    """参照契約の決定的IDを算出する。

    `[source_locator, revision, path, anchor]`をこの順のJSON配列としてRFC 8785の
    JSON Canonicalization SchemeでUTF-8へserializeし、そのSHA-256を返す。要素は
    文字列とnullだけのため、`ensure_ascii=False`かつ区切りを詰めた`json.dumps`の
    出力がJCSの正規形と一致する。
    """
    payload = [
        reference["source_locator"],
        reference["revision"],
        reference["path"],
        reference.get("anchor"),
    ]
    serialized = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def _entry(kind: str, reference: Mapping[str, Any], **extra: Any) -> dict[str, Any]:
    """1件の参照を`input_refs`へ保存する形へ整える。

    `canon_id`は参照契約がCanon参照の識別子として定義したものであり、Scene/Shot本文の
    参照には付けない。
    """
    entry: dict[str, Any] = {"kind": kind}
    if kind == KIND_CANON:
        entry["canon_id"] = canon_id(reference)
    entry.update(dict(reference))
    entry.update(extra)
    return entry


def canon_entry(raw: Any, **extra: Any) -> dict[str, Any]:
    """Canon descriptorの不変参照を`input_refs`の形へ整える。

    Scene/Shot本文が宣言していないCanon(利用者がJobの入力として選んだVoice Canonなど)
    を来歴へ残すために使う。`canon_id`の算出規則は本文経由の参照と同じとする。
    """
    return _entry(KIND_CANON, immutable_reference(raw), **extra)


def identity(entry: Mapping[str, Any]) -> tuple[str, str, str, str | None]:
    """同じ参照先を指すかどうかの判定キー。

    `revision`と`sha256`は更新で変わるため同一性には含めない。`anchor`は参照箇所を
    識別するため含める。`note`は表示専用で同一性に使わない (参照API契約v1)。
    """
    anchor = entry.get("anchor")
    return (
        str(entry.get("kind", "")),
        str(entry.get("source_locator", "")),
        str(entry.get("path", "")),
        anchor if isinstance(anchor, str) else None,
    )


def resolve_envelope(
    kind: str, resource_id: str, envelope: Any
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Scene/Shot Envelopeから、本文自体の参照と本文が宣言するCanon参照を取り出す。

    戻り値は(本文の参照エントリ, Canon参照エントリの配列)とする。Canon参照は
    `provenance.references`に展開済みのものだけを使い、本文中のpath表記から推測しない。
    """
    if not isinstance(envelope, Mapping):
        raise ReferenceError(f"{kind}の応答がobjectではありません。")
    provenance = envelope.get("provenance")
    if not isinstance(provenance, Mapping):
        raise ReferenceError(f"{kind}の応答にprovenanceがありません。")
    resource = _entry(
        kind, immutable_reference(provenance.get("resource")), id=resource_id
    )

    references = provenance.get("references")
    if references is None:
        references = []
    if not isinstance(references, Sequence) or isinstance(references, str | bytes):
        raise ReferenceError(f"{kind}のprovenance.referencesが配列ではありません。")

    canon_entries: list[dict[str, Any]] = []
    for item in references:
        if not isinstance(item, Mapping):
            raise ReferenceError(f"{kind}のprovenance.referencesの要素が不正です。")
        json_pointer = item.get("json_pointer")
        canon_entries.append(
            _entry(
                KIND_CANON,
                immutable_reference(item.get("reference")),
                declared_by=kind,
                declared_in=resource_id,
                json_pointer=json_pointer if isinstance(json_pointer, str) else None,
            )
        )
    return resource, canon_entries


def deduplicate(entries: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """同じ参照先を指すエントリを1件へ畳む。

    SceneとShotが同じCanonを宣言することがある。同じ`canon_id`を重ねて記録しても
    再実行の検証結果は変わらず、画面の警告だけが重複するため、先勝ちで畳む。
    """
    seen: set[tuple[str, str, str, str | None]] = set()
    unique: list[dict[str, Any]] = []
    for entry in entries:
        key = identity(entry)
        if key in seen:
            continue
        seen.add(key)
        unique.append(dict(entry))
    return unique


def resolvable(entries: Sequence[Any]) -> list[dict[str, Any]]:
    """参照APIから解決し直せるエントリだけを返す。"""
    return [
        dict(entry)
        for entry in entries
        if isinstance(entry, Mapping) and entry.get("kind") in RESOLVABLE_KINDS
    ]


def compare(
    recorded: Sequence[Any], current: Sequence[Mapping[str, Any]]
) -> list[dict[str, Any]]:
    """記録済み参照と現在の参照を突き合わせる。

    記録側は読むだけで更新しない。判定は次の4種とする。

    - `unchanged`: `revision`と`sha256`が一致する
    - `updated`: 同じ参照先だが`revision`か`sha256`が違う
    - `missing`: 現在の参照に同じ参照先が無い
    - `added`: 記録に無い参照が現在側に増えている
    """
    current_index = {identity(entry): entry for entry in current}
    matched: set[tuple[str, str, str, str | None]] = set()
    entries: list[dict[str, Any]] = []

    for raw in recorded:
        if not isinstance(raw, Mapping) or raw.get("kind") not in RESOLVABLE_KINDS:
            continue
        key = identity(raw)
        found = current_index.get(key)
        if found is not None:
            matched.add(key)
            change = (
                CHANGE_UNCHANGED
                if found.get("revision") == raw.get("revision")
                and found.get("sha256") == raw.get("sha256")
                else CHANGE_UPDATED
            )
        else:
            change = CHANGE_MISSING
        entries.append(
            {
                "kind": str(raw.get("kind")),
                "change": change,
                "path": raw.get("path"),
                "anchor": raw.get("anchor"),
                "note": raw.get("note"),
                # 参照APIで解決した結果は記録側と現在側の値を並べれば足りる。追加の
                # 説明が要るのは、ファイルを直接読んで確かめる入力cacheだけとする。
                "reason": None,
                "recorded": dict(raw),
                "current": dict(found) if found is not None else None,
            }
        )

    for key, entry in current_index.items():
        if key in matched:
            continue
        entries.append(
            {
                "kind": str(entry.get("kind")),
                "change": CHANGE_ADDED,
                "path": entry.get("path"),
                "anchor": entry.get("anchor"),
                "note": entry.get("note"),
                "reason": None,
                "recorded": None,
                "current": dict(entry),
            }
        )
    return entries


def unreproducible(entries: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Exact Replayを実行できない原因になるエントリだけを返す。

    現在値へ暗黙に置き換えないため、記録時と違う内容しか取得できない参照と、取得
    できない参照はどちらも実行不能として扱う。現在側に増えた参照は当時条件の再現を
    妨げないため含めない。
    """
    return [
        dict(entry)
        for entry in entries
        if entry.get("change") in (CHANGE_UPDATED, CHANGE_MISSING)
    ]
