"""読み比較のためのカタカナ正規化。

`ai-media/検証_tts/05_tts比較/evaluate.py`の`normalize`と
`ai-media/tools/cosyvoice/jp_kana.py`の`to_katakana`を移植した。形態素解析器は
torchを必要としないため、Application APIのvenvへそのまま持ち込む。生成Backendの
Python環境を統合しない制約(PLAN.md)は生成Backendに対するものであり、ここには効かない。

句読点は変換前に落とす。あとで落とすと形態素解析の区切りが変わり、同じ「明日」が
期待側では「アス」、Whisper側では「ミョウニチ」になって偽の不一致が出る
(2026-09-10に実測)。

この指標の限界も記録しておく。Whisperは音を文字へ戻すときに言語モデルで表記を
正規化するため、同じ漢字の別の読み(アス/アシタ)は検出できない。検出できるのは
別語に化けた場合(女子 → 温座子)である。
"""

import difflib
import logging
import re
from functools import lru_cache

logger = logging.getLogger(__name__)

#: 発音が表記と異なる助詞。
PARTICLE_SOUND = {"は": "ワ", "へ": "エ", "を": "オ"}

#: 読みを持たない記号のうち、そのまま残すもの。
KEEP = frozenset("、。！？!?…「」『』・")

#: 比較前に落とす記号と空白。
PUNCT = re.compile(r"[、。！？!?…「」『』・,\.\s　]+")

_SPACE_RE = re.compile(r"[ 　]+")


class KanaUnavailable(RuntimeError):
    """形態素解析器を初期化できない。"""


@lru_cache(maxsize=1)
def _tagger():
    """形態素解析器。初期化が重いので使い回す。

    `fugashi`と`unidic-lite`が入っていない環境では読み比較だけができない。生成そのもの
    は続けられるため、ここでは専用の例外へ変換し、呼び出し側が検証をスキップできる
    ようにする。
    """
    try:
        import fugashi
    except ImportError as error:  # pragma: no cover - 依存が揃っていれば通らない
        raise KanaUnavailable("fugashiを読み込めません。") from error
    try:
        return fugashi.Tagger()
    except Exception as error:  # pragma: no cover - 辞書の欠落など
        raise KanaUnavailable("形態素解析器を初期化できません。") from error


def to_katakana(text: str) -> str:
    """日本語の文をカタカナの分かち書きにする。

    `pykakasi`は「今日は」を「コンニチハ」、「入り」を「イリ」と誤るため使わない
    (2026-09-10に実測)。
    """
    tokens: list[str] = []
    for word in _tagger()(_SPACE_RE.sub("", text)):
        surface = word.surface
        if surface in KEEP:
            tokens.append(surface)
            continue
        pos = word.feature.pos1 or ""
        if pos == "助詞" and surface in PARTICLE_SOUND:
            tokens.append(PARTICLE_SOUND[surface])
            continue
        kana = word.feature.kana
        tokens.append(kana if kana else surface)
    return " ".join(tokens)


def normalize(text: str) -> str:
    """読み比較のためにカタカナへそろえる。

    変換後の分かち書きの空白も落とす。Whisperが「朝比奈」を「朝日菜」と同音の別表記で
    返すと語境界がずれるため、境界は比較に含めない。
    """
    return to_katakana(PUNCT.sub("", text)).replace(" ", "")


def diff_ratio(expected: str, actual: str) -> float:
    """正規化済みの2文字列の差分率。0.0で完全一致、1.0で共通部分なし。"""
    return round(1.0 - difflib.SequenceMatcher(None, expected, actual).ratio(), 4)
