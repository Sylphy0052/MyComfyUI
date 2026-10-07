"""prompt案の出力を、決まった規則で採点する。

Providerの出力(`ImagePromptOutput`を`model_dump`した辞書。`batch_generation_plan`
なら`items`各件のprompt部分)を受け取り、違反の一覧を返す純関数を置く。生成Jobの
投入や提案の承認には関わらない。`apps/api/scripts/prompt_eval.py`の評価scriptと、
#396で予定する再生成の判定のどちらからも同じ関数を呼ぶため、判定ロジックはここだけ
に書く。

ratingの値の集合とタグの分割・正規化・干渉の判定は、`proposals.py`と
`tag_preflight.py`の既存の定数・関数を再利用し、ここでは重複定義しない。
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from mycomfyui_api.adapters import tag_preflight
from mycomfyui_api.adapters.agent import proposals
from mycomfyui_api.adapters.agent.base import ProposalKind

#: 判定できる規則のID。報告と`--compare`はこの順で並べる。
RULE_IDS: tuple[str, ...] = (
    "rating",
    "subject_mix",
    "identity_leak",
    "natural_length",
    "weight_syntax",
    "underscore",
    "conflict",
    "unknown_tag",
)


@dataclass(frozen=True)
class Violation:
    """1件の違反、または`unknown_tag`の参考値。

    `message`は#396で再生成の指示文へそのまま添付する想定のため、LLMへ渡してよい
    英語の短文にする。`detail`は該当するタグや文の抜粋など、人が確かめる補足とする。
    """

    rule: str
    message: str
    detail: str = ""
    #: 真なら合否には数えない参考値。`unknown_tag`だけがこれを立てる。
    reference: bool = False


#: `1girl`、`2girls`、`3+girls`のように人数と性別を表すタグ。
_SUBJECT_COUNT_PATTERN = re.compile(r"^(\d+)\+?(girl|boy|other)s?$")
#: `multiple girls`のように具体的な人数を持たない複数人数の表現。
_SUBJECT_MULTIPLE_PATTERN = re.compile(r"^multiple (girl|boy|other)s$")

#: 見分けに使う髪色・瞳の色として扱う色名。複合語(`dark blue hair`など)は接頭辞
#: として許す。Danbooruで代表的に使われる色名だけを持つ。
_COLOR_WORDS = (
    "black",
    "white",
    "brown",
    "blonde",
    "blond",
    "red",
    "pink",
    "purple",
    "violet",
    "blue",
    "green",
    "yellow",
    "orange",
    "silver",
    "gray",
    "grey",
    "aqua",
    "platinum",
    "multicolored",
    "rainbow",
)
_COLOR_PREFIX = r"(?:light |dark |pale |bright )?"
_HAIR_COLOR_PATTERN = re.compile(rf"^{_COLOR_PREFIX}(?:{'|'.join(_COLOR_WORDS)}) hair$")
_EYE_COLOR_PATTERN = re.compile(rf"^{_COLOR_PREFIX}(?:{'|'.join(_COLOR_WORDS)}) eyes$")
#: 見分けに使う髪型。色と組み合わせない固定の語だけを持つ。
_HAIRSTYLE_TAGS = frozenset(
    {
        "ponytail",
        "twintails",
        "twin tails",
        "side ponytail",
        "low ponytail",
        "high ponytail",
        "short hair",
        "long hair",
        "medium hair",
        "bob cut",
        "hime cut",
        "braid",
        "braids",
        "single braid",
        "twin braids",
        "drill hair",
        "odango",
        "bun",
        "very short hair",
        "very long hair",
    }
)
#: `glasses`で終わるタグは全て見分けに使う眼鏡とみなす(`sunglasses`、`round
#: glasses`など)。
_GLASSES_PATTERN = re.compile(r"glasses$")

#: `natural_text`の長さの規則。2〜3文、60語以下とする。
_NATURAL_TEXT_MIN_SENTENCES = 2
_NATURAL_TEXT_MAX_SENTENCES = 3
_NATURAL_TEXT_MAX_WORDS = 60


def check_prompt_body(
    body: Mapping[str, Any],
    *,
    context: Mapping[str, Any] | None = None,
    tag_dictionary_path: Path | str | None = None,
) -> list[Violation]:
    """1件のprompt案 (`PromptBody`と同じ形の辞書) を判定する。

    `batch_generation_plan`では`items`の1件がこの形になる。呼び出し側が
    `check_output`を使わず個別のitemだけを判定したいとき(#396など)にも使える。
    """
    violations: list[Violation] = []
    violations.extend(_check_rating(body))
    violations.extend(_check_subject_mix(body))
    violations.extend(_check_identity_leak(body))
    length_violation = _check_natural_length(body, context)
    if length_violation is not None:
        violations.append(length_violation)
    violations.extend(_check_weight_syntax(body))
    violations.extend(_check_underscore(body))
    violations.extend(_check_conflict(body))
    unknown_violation = _check_unknown_tag(body, tag_dictionary_path)
    if unknown_violation is not None:
        violations.append(unknown_violation)
    return violations


def check_output(
    kind: ProposalKind,
    output: Mapping[str, Any],
    *,
    context: Mapping[str, Any] | None = None,
    tag_dictionary_path: Path | str | None = None,
) -> list[Violation]:
    """提案出力全体を判定する。

    `batch_generation_plan`は`items`の各要素を`check_prompt_body`で判定し、`detail`
    の先頭へどのitemかを足す。それ以外の種別(`image_prompt`)は出力全体を1件の
    prompt案として判定する。
    """
    if kind != "batch_generation_plan":
        return check_prompt_body(
            output, context=context, tag_dictionary_path=tag_dictionary_path
        )
    items = output.get("items")
    if not isinstance(items, list):
        return []
    violations: list[Violation] = []
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            continue
        label = str(item.get("shot_id") or f"item[{index}]")
        for violation in check_prompt_body(
            item, context=context, tag_dictionary_path=tag_dictionary_path
        ):
            detail = f"{label}: {violation.detail}" if violation.detail else label
            violations.append(
                Violation(
                    rule=violation.rule,
                    message=violation.message,
                    detail=detail,
                    reference=violation.reference,
                )
            )
    return violations


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item.strip() for item in value if isinstance(item, str) and item.strip()]


def _norm(tag: str) -> str:
    return tag_preflight.normalize_tag(tag)


def _check_rating(body: Mapping[str, Any]) -> list[Violation]:
    """`quality_tags`にratingの値がちょうど1つあるか。"""
    found = [
        tag
        for tag in _string_list(body.get("quality_tags"))
        if _norm(tag) in proposals.RATING_TAGS
    ]
    if len(found) == 1:
        return []
    reason = "none found" if not found else "found multiple"
    message = (
        "quality_tags must contain exactly one rating tag "
        f"(safe/sensitive/nsfw/explicit); {reason}."
    )
    return [Violation("rating", message, detail=", ".join(found))]


def total_subject_count(subject_tags: Sequence[str]) -> int:
    """`subject_tags`が表す総人数。判定できないときは0を返す。"""
    per_gender: dict[str, int] = {}
    for tag in subject_tags:
        match = _SUBJECT_COUNT_PATTERN.match(tag)
        if match is not None:
            gender = match.group(2)
            per_gender[gender] = max(per_gender.get(gender, 0), int(match.group(1)))
            continue
        match = _SUBJECT_MULTIPLE_PATTERN.match(tag)
        if match is not None:
            gender = match.group(1)
            per_gender[gender] = max(per_gender.get(gender, 0), 2)
    if per_gender:
        return sum(per_gender.values())
    return 1 if "solo" in subject_tags else 0


def _check_subject_mix(body: Mapping[str, Any]) -> list[Violation]:
    """`subject_tags`で人数の表現が混ざっていないか (`1girl`と`2girls`の併記など)。"""
    subject_tags = [_norm(tag) for tag in _string_list(body.get("subject_tags"))]
    counts_by_gender: dict[str, set[int]] = {}
    for tag in subject_tags:
        match = _SUBJECT_COUNT_PATTERN.match(tag)
        if match is not None:
            counts_by_gender.setdefault(match.group(2), set()).add(int(match.group(1)))
    mixed = {
        gender: sorted(counts)
        for gender, counts in counts_by_gender.items()
        if len(counts) > 1
    }
    if not mixed:
        return []
    detail = "; ".join(f"{gender}: {counts}" for gender, counts in mixed.items())
    message = (
        "subject_tags mixes different counts for the same gender "
        "(e.g. 1girl and 2girls together); use one consistent count."
    )
    return [Violation("subject_mix", message, detail=detail)]


def _is_identity_hint(tag: str) -> bool:
    return (
        _HAIR_COLOR_PATTERN.match(tag) is not None
        or _EYE_COLOR_PATTERN.match(tag) is not None
        or tag in _HAIRSTYLE_TAGS
        or _GLASSES_PATTERN.search(tag) is not None
    )


def _check_identity_leak(body: Mapping[str, Any]) -> list[Violation]:
    """`subject_tags`が2人以上を示すとき、`general_tags`に見分けに使う属性が無いか。"""
    subject_tags = [_norm(tag) for tag in _string_list(body.get("subject_tags"))]
    if total_subject_count(subject_tags) < 2:
        return []
    general_tags = [_norm(tag) for tag in _string_list(body.get("general_tags"))]
    leaked = [tag for tag in general_tags if _is_identity_hint(tag)]
    if not leaked:
        return []
    message = (
        "general_tags leaks per-character identity attributes (hair color/style, "
        "eye color, glasses) while subject_tags indicates multiple people; "
        "move these attributes to natural_text instead."
    )
    return [Violation("identity_leak", message, detail=", ".join(leaked))]


def _check_natural_length(
    body: Mapping[str, Any], context: Mapping[str, Any] | None
) -> Violation | None:
    """`natural_text`が2〜3文かつ60語以下か。`prompt_style=="tags"`なら空か。"""
    natural_text = str(body.get("natural_text") or "").strip()
    prompt_style = (context or {}).get("prompt_style")
    if prompt_style == "tags":
        if not natural_text:
            return None
        return Violation(
            "natural_length",
            "natural_text must be empty when prompt_style is tags.",
            detail=natural_text[:200],
        )
    if not natural_text:
        return Violation(
            "natural_length",
            "natural_text must be 2-3 sentences (<=60 words); it is empty.",
        )
    sentences = [s for s in re.split(r"[.!?]+", natural_text) if s.strip()]
    word_count = len(natural_text.split())
    if (
        _NATURAL_TEXT_MIN_SENTENCES <= len(sentences) <= _NATURAL_TEXT_MAX_SENTENCES
        and word_count <= _NATURAL_TEXT_MAX_WORDS
    ):
        return None
    message = (
        "natural_text must be 2-3 sentences and <=60 words; found "
        f"{len(sentences)} sentence(s), {word_count} word(s)."
    )
    return Violation("natural_length", message, detail=natural_text[:200])


def _iter_block_tags(body: Mapping[str, Any]) -> list[tuple[str, str]]:
    """タグ配列(`TAG_BLOCK_FIELDS`)の生の要素を、属するブロック名と組で返す。

    連結・重複排除済みの`tag_line`ではなく、Providerが返した個々の要素を見る。
    重み構文とアンダースコアはタグ単位の書式であり、連結前の要素で判定する方が
    どのタグが違反かを特定しやすい。
    """
    tags: list[tuple[str, str]] = []
    for field_name in proposals.TAG_BLOCK_FIELDS:
        for tag in _string_list(body.get(field_name)):
            tags.append((field_name, tag))
    return tags


def _check_weight_syntax(body: Mapping[str, Any]) -> list[Violation]:
    """`(tag:1.2)`のような重み書式が無いか。"""
    hits = [
        tag
        for _, tag in _iter_block_tags(body)
        if proposals.WEIGHTED_TAG_PATTERN.match(tag) is not None
    ]
    if not hits:
        return []
    message = "tags must not use A1111-style weight syntax such as (tag:1.2)."
    return [Violation("weight_syntax", message, detail=", ".join(hits))]


def _check_underscore(body: Mapping[str, Any]) -> list[Violation]:
    """`score_`で始まるタグ以外にアンダースコアが無いか。"""
    hits = [
        tag
        for _, tag in _iter_block_tags(body)
        if "_" in tag and not tag.startswith("score_")
    ]
    if not hits:
        return []
    message = "tags must not contain underscores, except tags starting with score_."
    return [Violation("underscore", message, detail=", ".join(hits))]


def _check_conflict(body: Mapping[str, Any]) -> list[Violation]:
    """positiveとnegativeに同じタグが無いか。`tag_preflight.find_conflicts`を使う。"""
    positive = [_norm(tag) for _, tag in _iter_block_tags(body)]
    negative_raw = str(body.get("negative_prompt") or "")
    negative = [_norm(segment) for segment in tag_preflight.split_prompt(negative_raw)]
    conflicts = tag_preflight.find_conflicts(positive, negative)
    return [
        Violation(
            "conflict",
            f"conflicting tags ({conflict.kind}): {conflict.message}",
            detail=", ".join(conflict.tags),
        )
        for conflict in conflicts
    ]


def _check_unknown_tag(
    body: Mapping[str, Any], tag_dictionary_path: Path | str | None
) -> Violation | None:
    """タグ辞書が設定され、辞書に無いタグが1件以上あるときだけ、その割合を出す。

    合否には使わず参考値とするため、`reference=True`を立てる。辞書を読めない
    ときは何も返さない(`tag_preflight`自身が投入を妨げないのと同じ扱い)。
    """
    if not tag_dictionary_path:
        return None
    try:
        counts, _characters = tag_preflight.load_tag_dictionary(
            Path(tag_dictionary_path)
        )
    except tag_preflight.TagDictionaryError:
        return None
    candidates = [
        _norm(tag)
        for _, tag in _iter_block_tags(body)
        if not tag_preflight.is_excluded(_norm(tag))
    ]
    if not candidates:
        return None
    unknown = [tag for tag in candidates if tag not in counts]
    if not unknown:
        return None
    ratio = len(unknown) / len(candidates)
    message = (
        f"{len(unknown)}/{len(candidates)} tags not found in the tag dictionary "
        "(reference only, not a pass/fail check)."
    )
    return Violation(
        "unknown_tag",
        message,
        detail=f"ratio={ratio:.2f}; unknown={', '.join(unknown[:20])}",
        reference=True,
    )
