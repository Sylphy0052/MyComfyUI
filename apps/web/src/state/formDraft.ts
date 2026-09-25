/**
 * 未投入の入力 (下書き) をsessionStorageへ保存する。
 *
 * 開発サーバが配信元の更新でコンポーネントを作り直したときや、ページを再読み込みしたときに、
 * 入力途中の値が初期値へ戻らないようにする (#327)。タブを閉じれば消えるよう、localStorageは使わない。
 */

const STORAGE_PREFIX = "mycomfyui.draft.v1.";

/** 保存値が無い・JSONとして読めない・オブジェクトでない場合はnullを返す。項目の検証は呼び出し元が行う。 */
export function readFormDraft(key: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(window.sessionStorage.getItem(STORAGE_PREFIX + key) ?? "null");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** 保存できなくても入力は続けられるので、容量超過などの失敗は無視する。 */
export function writeFormDraft(key: string, draft: Record<string, unknown>): void {
  try {
    window.sessionStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(draft));
  } catch {
    // sessionStorageが使えない環境では下書きを残さない。
  }
}

export function draftString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function draftStringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}

/** 値がすべて文字列のオブジェクトだけを受け付ける。 */
export function draftStringRecord(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  return entries.every(([, item]) => typeof item === "string")
    ? Object.fromEntries(entries as [string, string][])
    : null;
}
