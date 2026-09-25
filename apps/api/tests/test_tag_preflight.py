import tempfile
import unittest
from pathlib import Path

from mycomfyui_api.adapters.tag_preflight import load_tag_dictionary


def _load(rows: str) -> tuple[dict[str, int], frozenset[str]]:
    """`rows`を一時ファイルのタグ辞書として読む。"""
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "danbooru.csv"
        path.write_text(rows, encoding="utf-8")
        return load_tag_dictionary(path)


class LoadTagDictionaryCharacterTest(unittest.TestCase):
    def test_character_names_and_aliases_are_collected(self) -> None:
        counts, characters = _load(
            'hatsune_miku,4,100,"miku,miku_hatsune"\nsmile,0,500,smiling\n'
        )

        self.assertEqual(
            characters, frozenset({"hatsune miku", "miku", "miku hatsune"})
        )
        self.assertEqual(counts["miku"], 100)
        self.assertEqual(counts["smiling"], 500)

    def test_alias_matching_other_canonical_name_is_not_character(self) -> None:
        # キャラクターの別名が別の種別の正規のタグ名と重なるときは正規の方に従う。
        # 辞書の並び順によらないよう、正規のタグ名を後ろにも前にも置いて確かめる。
        rows = {
            "alias_first": "some_character,4,10,black_hood\nblack_hood,0,300,\n",
            "canonical_first": "black_hood,0,300,\nsome_character,4,10,black_hood\n",
        }
        for order, text in rows.items():
            with self.subTest(order=order):
                counts, characters = _load(text)

                self.assertEqual(characters, frozenset({"some character"}))
                self.assertEqual(counts["black hood"], 300)
