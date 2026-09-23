"""生成の投入前に、プロンプトのタグの実在と干渉する組み合わせを確かめる。

実在はローカルのタグ辞書で判定する。辞書はa1111-sd-webui-tagcompleteの`danbooru.csv`
と同じ`name,category,post_count,"alias,..."`の形式とし、辞書に無いタグと0件のタグを
「実在しない」として警告する。0件のタグはpositiveでもnegativeでも効かない。
Danbooruへ直接問い合わせないのは、User-AgentにComfyUIを含む要求を先方が拒むためで
ある。正規化と対象外の判定は、novel-writerの`anima-prompt/scripts/tagcheck.py`
とWeb側の`prompt/merge.ts`に揃える。分割は`merge.ts`と違い、強調の括弧の内側も
タグ単位に区切る。

辞書を読めなくても投入は妨げず、実在を断定しない「未確認」として返す。
"""

import csv
import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

#: 実在確認の対象外にする品質・年代・ratingのタグ。`merge.ts`の`QUALITY_TAGS`と同じ。
QUALITY_TAGS = frozenset(
    {
        "masterpiece",
        "best quality",
        "high quality",
        "normal quality",
        "low quality",
        "worst quality",
        "amazing quality",
        "great quality",
        "very awa",
        "highres",
        "absurdres",
        "lowres",
        "anime screenshot",
        "official art",
        "newest",
        "recent",
        "mid",
        "early",
        "old",
        "safe",
        "sensitive",
        "nsfw",
        "explicit",
        "questionable",
        "general",
    }
)
RATING_TAGS = frozenset(
    {"general", "safe", "sensitive", "questionable", "nsfw", "explicit"}
)
#: `normalize_tag`がアンダースコアをスペースへ寄せた後の形で比べる。
SKIP_PREFIXES = ("score ", "year ", "@")
#: 自然文とみなす語数の下限。Danbooruのタグは長くても4語程度に収まる。
SENTENCE_WORD_THRESHOLD = 5
#: 同居させると中間で妥協した絵になる画角の指定。
FRAMING_TAGS = (
    "close-up",
    "portrait",
    "upper body",
    "cowboy shot",
    "full body",
)
MULTIPLE_PEOPLE = re.compile(
    r"^(?:(?:[2-9]|\d{2,})\+?(?:girls|boys|others)|multiple (?:girls|boys|others))$"
)
#: 強調の括弧を閉じる直前に付く重み`:1.2`。
WEIGHT_SUFFIX = re.compile(r":\s*-?\d+(?:\.\d+)?\s*$")
#: 版権名などの末尾の括弧。自然文かどうかの語数に数えない。
QUALIFIER = re.compile(r"\([^()]*\)$")

PromptSide = Literal["positive", "negative"]
TagStatus = Literal["ok", "missing", "unverified"]
ConflictKind = Literal["framing", "solo_with_multiple", "rating", "both_sides"]


class TagDictionaryError(Exception):
    """タグ辞書を読めない。実在は判らない。"""


@dataclass(frozen=True)
class TagFinding:
    tag: str
    side: PromptSide
    status: TagStatus
    #: 辞書にある投稿件数。別名は正規のタグの件数を返す。辞書に無いタグと未確認はNone。
    post_count: int | None = None


@dataclass(frozen=True)
class TagConflict:
    kind: ConflictKind
    tags: tuple[str, ...]
    message: str


@dataclass(frozen=True)
class TagCheck:
    tags: list[TagFinding] = field(default_factory=list)
    conflicts: list[TagConflict] = field(default_factory=list)
    #: 辞書で実在を確かめたか。辞書を設定していないときと、対象のタグが無いときは偽。
    looked_up: bool = False
    #: 辞書を読めなかった理由。読めたときはNone。
    lookup_error: str | None = None


def split_prompt(prompt: str) -> list[str]:
    """プロンプトから強調の構文を外し、タグ単位に区切る。

    強調の括弧`(` `)` `[` `]`と、閉じ括弧の直前にある重み`:1.2`を外し、括弧の内側も
    含めてカンマと改行と括弧で区切る。`((smile))`は`smile`、
    `(masterpiece, best quality:1.2)`は`masterpiece`と`best quality`になる。
    `hoshino ai \\(oshi no ko\\)`のようなエスケープ済みの括弧はタグの一部として残す。
    """
    segments: list[str] = []
    current: list[str] = []
    index = 0
    while index < len(prompt):
        char = prompt[index]
        if char == "\\" and index + 1 < len(prompt):
            current.append(prompt[index : index + 2])
            index += 2
            continue
        index += 1
        if char not in "()[],\n":
            current.append(char)
            continue
        text = "".join(current)
        if char in ")]":
            # `(:3)`のように重みを外すと空になるものは、重みでなくタグとして残す。
            stripped = WEIGHT_SUFFIX.sub("", text)
            if stripped.strip():
                text = stripped
        # 括弧も区切りとし、`(a:1.2)(b:1.1)`のような区切りの無い並びも分ける。
        segments.append(text)
        current = []
    segments.append("".join(current))
    return [segment.strip() for segment in segments if segment.strip()]


def normalize_tag(segment: str) -> str:
    """辞書の表記と比べられる形へ寄せる。

    版権名の`\\(` `\\)`は素の括弧へ戻し、アンダースコアはスペースへ寄せる。
    """
    text = segment.replace("\\(", "(").replace("\\)", ")").replace("_", " ")
    return " ".join(text.lower().split())


def is_excluded(tag: str) -> bool:
    """実在確認の対象外か。品質・rating・絵師のタグ、自然文、特殊構文が当たる。"""
    if tag in QUALITY_TAGS or tag.startswith(SKIP_PREFIXES):
        return True
    # `<lora:name:0.8>`や`embedding:name`はタグでなくComfyUI側の構文。
    if tag.startswith("<") or tag.startswith("embedding:") or tag == "break":
        return True
    if re.search(r"[.!?]", tag):
        return True
    return len(QUALIFIER.sub("", tag).split()) >= SENTENCE_WORD_THRESHOLD


def find_conflicts(
    positive: Sequence[str], negative: Sequence[str]
) -> list[TagConflict]:
    """干渉する組み合わせを返す。引数は`normalize_tag`済みのタグ。"""
    conflicts: list[TagConflict] = []
    present = set(positive)
    framing = tuple(tag for tag in FRAMING_TAGS if tag in present)
    if len(framing) >= 2:
        conflicts.append(
            TagConflict(
                "framing",
                framing,
                "画角の指定が複数あり、どちらでもない中間の構図になる。1つに絞る",
            )
        )
    multiple = tuple(tag for tag in _unique(positive) if MULTIPLE_PEOPLE.match(tag))
    if "solo" in present and multiple:
        conflicts.append(
            TagConflict(
                "solo_with_multiple",
                ("solo", *multiple),
                "soloと複数人数のタグが同居している。人数の指定を1つに揃える",
            )
        )
    ratings = tuple(tag for tag in _unique(positive) if tag in RATING_TAGS)
    if len(ratings) >= 2:
        conflicts.append(TagConflict("rating", ratings, "ratingが複数ある。1つに絞る"))
    negative_set = set(negative)
    both = tuple(tag for tag in _unique(positive) if tag and tag in negative_set)
    if both:
        conflicts.append(
            TagConflict(
                "both_sides",
                both,
                "同じタグがpositiveとnegativeの両方にあり、打ち消し合う",
            )
        )
    return conflicts


def load_tag_dictionary(path: Path) -> dict[str, int]:
    """タグ辞書を読み、正規化したタグ名と別名から投稿件数への対応を返す。

    別名は正規のタグの件数を引けるようにする。正規のタグ名と別名が衝突したときは
    正規のタグ名を優先する。
    """
    counts: dict[str, int] = {}
    aliases: dict[str, int] = {}
    try:
        with path.open(encoding="utf-8", newline="") as file:
            for line_number, row in enumerate(csv.reader(file), start=1):
                if not row:
                    continue
                if len(row) < 3:
                    raise TagDictionaryError(
                        f"タグ辞書の{line_number}行目が`name,category,post_count`の形でない"
                    )
                try:
                    count = int(row[2])
                except ValueError as error:
                    raise TagDictionaryError(
                        f"タグ辞書の{line_number}行目の件数が整数でない"
                    ) from error
                counts[normalize_tag(row[0])] = count
                if len(row) >= 4:
                    for alias in row[3].split(","):
                        if alias.strip():
                            aliases.setdefault(normalize_tag(alias), count)
    except (OSError, UnicodeDecodeError, csv.Error) as error:
        raise TagDictionaryError(f"タグ辞書を読めない: {error}") from error
    return {**aliases, **counts}


class TagDictionary:
    """設定したタグ辞書を読み、ファイルが変わるまで読み直さない。"""

    def __init__(self, path: Path) -> None:
        self._path = path
        self._stamp: tuple[int, int] | None = None
        self._counts: dict[str, int] = {}

    def post_counts(self) -> dict[str, int]:
        """タグ名から投稿件数への対応を返す。読めなければ`TagDictionaryError`。"""
        try:
            stat = self._path.stat()
        except OSError as error:
            raise TagDictionaryError(f"タグ辞書を読めない: {error}") from error
        stamp = (stat.st_mtime_ns, stat.st_size)
        if stamp != self._stamp:
            self._counts = load_tag_dictionary(self._path)
            self._stamp = stamp
        return self._counts


def check_prompt_tags(
    positive: str,
    negative: str,
    dictionary: TagDictionary | None,
) -> TagCheck:
    """positiveとnegativeのタグを検証する。辞書がNoneなら干渉の検出だけを行う。"""
    sides: dict[PromptSide, list[str]] = {
        "positive": [normalize_tag(segment) for segment in split_prompt(positive)],
        "negative": [normalize_tag(segment) for segment in split_prompt(negative)],
    }
    conflicts = find_conflicts(sides["positive"], sides["negative"])
    targets = {
        side: [tag for tag in _unique(tags) if tag and not is_excluded(tag)]
        for side, tags in sides.items()
    }
    if dictionary is None or not any(targets.values()):
        return TagCheck(conflicts=conflicts)
    try:
        counts = dictionary.post_counts()
    except TagDictionaryError as error:
        findings = [
            TagFinding(tag, side, "unverified")
            for side, tags in targets.items()
            for tag in tags
        ]
        return TagCheck(findings, conflicts, looked_up=True, lookup_error=str(error))
    findings = [
        TagFinding(tag, side, "ok" if counts.get(tag) else "missing", counts.get(tag))
        for side, tags in targets.items()
        for tag in tags
    ]
    return TagCheck(findings, conflicts, looked_up=True)


def _unique(tags: Iterable[str]) -> list[str]:
    return list(dict.fromkeys(tags))
