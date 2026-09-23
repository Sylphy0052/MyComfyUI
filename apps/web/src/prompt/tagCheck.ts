/**
 * 投入前プレビューのタグ検証 (`tag_check`) を、確認ダイアログと画面に出す文へ直す。
 *
 * 実在しないタグと干渉する組み合わせは、投入を止めて確かめるべき警告として扱う。
 * タグ辞書を読めなかった「未確認」はプロンプトの問題ではないため、画面に出すだけで
 * 投入は止めない。
 */
import type { PromptTagCheck } from "../api/client";

/** 投入の前に確かめさせる警告。無ければ空配列を返す。 */
export function tagCheckWarnings(check: PromptTagCheck | null | undefined): string[] {
  if (!check) {
    return [];
  }
  const warnings: string[] = [];
  for (const side of ["positive", "negative"]) {
    const missing = check.tags
      .filter((finding) => finding.side === side && finding.status === "missing")
      .map((finding) => finding.tag);
    if (missing.length > 0) {
      warnings.push(
        `タグ辞書に無いタグ (${side}): ${missing.join(", ")}。0件のタグは効かない`,
      );
    }
  }
  for (const conflict of check.conflicts) {
    warnings.push(`${conflict.message}: ${conflict.tags.join(", ")}`);
  }
  return warnings;
}

/** 実在を確かめられなかった理由。確かめられたとき、または辞書が未設定のときはnull。 */
export function tagCheckNotice(check: PromptTagCheck | null | undefined): string | null {
  if (!check?.lookup_error) {
    return null;
  }
  return `タグの実在を確認できませんでした: ${check.lookup_error}`;
}
