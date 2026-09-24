import { ApiError } from "../api/client";
import type { Recipe } from "../api/client";

/** RecipeのWorkflowテンプレート参照名。`ImageChangePanel`と`ImageDerivationPanel`で共通に使う。 */
export function templateName(recipe: Recipe): string {
  const reference = recipe.workflow_template_ref as Record<string, unknown>;
  return typeof reference?.name === "string" ? reference.name : "";
}

/** APIエラーを画面表示用の文字列にする。`ApiError`ならコードを併記する。 */
export function describeApiError(error: unknown): string {
  if (error instanceof ApiError) return `${error.message} (${error.code})`;
  return String(error);
}
