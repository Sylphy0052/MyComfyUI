/**
 * Recipeの`input_schema`名に依存せず、生成入力のJSONからプロンプト欄だけを見分ける
 * ための共通定義。
 *
 * `positive_prompt`/`negative_prompt`という名前は複数のRecipe種別
 * (image/video/musicなど) をまたいで使われる慣習上の名前であり、スキーマから
 * 動的に判定できないため、名前一致で判定する。
 */
export const PROMPT_FIELD_NAMES = ["positive_prompt", "negative_prompt"] as const;

export type PromptFieldName = (typeof PROMPT_FIELD_NAMES)[number];

export function isPromptFieldName(name: string): name is PromptFieldName {
  return (PROMPT_FIELD_NAMES as readonly string[]).includes(name);
}

/**
 * 生成入力のJSONオブジェクトを、プロンプト欄とそれ以外へ分ける。
 *
 * プロンプト欄は文字列のときだけ取り出す。数値や配列など想定外の型で入っている
 * 場合は壊さないよう`rest`側へ残す。
 */
export function splitPromptFields(inputs: Record<string, unknown>): {
  prompts: Partial<Record<PromptFieldName, string>>;
  rest: Record<string, unknown>;
} {
  const prompts: Partial<Record<PromptFieldName, string>> = {};
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(inputs)) {
    if (isPromptFieldName(key) && typeof value === "string") {
      prompts[key] = value;
    } else {
      rest[key] = value;
    }
  }
  return { prompts, rest };
}

/** `rest`と`prompts`を1つのinputsオブジェクトへ戻す。 */
export function mergePromptFields(
  rest: Record<string, unknown>,
  prompts: Partial<Record<PromptFieldName, string>>,
): Record<string, unknown> {
  return { ...rest, ...prompts };
}
