import tempfile
import unittest
from pathlib import Path

from mycomfyui_api.adapters.tag_preflight import TagDictionaryError, load_tag_dictionary


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


class LoadTagDictionaryErrorTest(unittest.TestCase):
    def test_malformed_rows_are_rejected_with_line_number(self) -> None:
        rows = {
            "too_few_columns": ("smile,0,500\nhatsune_miku,4\n", "2行目が"),
            "count_not_integer": ("smile,0,many\n", "1行目の件数が整数でない"),
        }
        for case, (text, message) in rows.items():
            with self.subTest(case=case):
                with self.assertRaises(TagDictionaryError) as raised:
                    _load(text)

                self.assertIn(message, str(raised.exception))

    def test_missing_file_is_rejected(self) -> None:
        with (
            tempfile.TemporaryDirectory() as directory,
            self.assertRaises(TagDictionaryError) as raised,
        ):
            load_tag_dictionary(Path(directory) / "missing.csv")

        self.assertIn("タグ辞書を読めない", str(raised.exception))

    def test_non_utf8_file_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "danbooru.csv"
            path.write_bytes("笑顔,0,500\n".encode("shift_jis"))

            with self.assertRaises(TagDictionaryError) as raised:
                load_tag_dictionary(path)

        self.assertIn("タグ辞書を読めない", str(raised.exception))
