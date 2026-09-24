/**
 * Preset (内部はLookProfile) の「モードBで選ばせる入力」まわりの共通定義 (#161)。
 *
 * Presetは入力ごとに次の3つへ振り分ける。
 *
 * - 固定する部分: `inputs` に値ごと保存する。
 * - モードBで選ばせる部分: `production_choice_inputs` に入力名だけを保存する。
 * - 自動で埋まる部分: どちらにも入れない。キャラクター・場面・Recipe既定値から埋まる。
 */
import { ApiError } from "../api/client";
import type { GenerationManifest, Recipe } from "../api/client";

/** モードBで選ばせる項目の目安の上限。超えても保存はできるが警告を出す。 */
export const PRODUCTION_CHOICE_SOFT_LIMIT = 2;

export function productionChoiceWarning(count: number): string | null {
  if (count <= PRODUCTION_CHOICE_SOFT_LIMIT) return null;
  return `モードBで選ばせる項目が${count}個あります。${PRODUCTION_CHOICE_SOFT_LIMIT}個までに絞ると、作品制作の画面が分かりやすくなります。`;
}

export type PresetInputRole = "fixed" | "auto" | "choice";

export const PRESET_INPUT_ROLE_LABEL: Record<PresetInputRole, string> = {
  fixed: "固定",
  auto: "自動で埋まる",
  choice: "モードBで選ばせる",
};

export interface PresetInputRow {
  name: string;
  label: string;
  /** 候補の生成に使われた値。復元できなかったときはundefined。 */
  value: unknown;
  role: PresetInputRole;
}

/**
 * 生成ごとに変わるため、既定では固定しない入力の名前。
 * 組み込みRecipeの入力名 (`apps/api/src/mycomfyui_api/bootstrap.py` の
 * `DEFAULT_INPUT_SCHEMA` など) に合わせている。入力名を変えたらここも直す。
 */
const AUTO_BY_DEFAULT = new Set(["positive_prompt", "seed"]);
/**
 * 画像・音声などの参照を受ける入力の `control`。生成ごとに変わるため既定では固定しない。
 * 組み込みRecipeのinput_schema (`bootstrap.py` の `_IMAGE_DERIVATION_SCHEMA`・
 * `VOICE_INPUT_SCHEMA`・`COMPOSE_INPUT_SCHEMA` など) が使う値に合わせている。
 */
const MEDIA_CONTROLS = new Set(["artifact", "artifacts", "audio_track", "audio_tracks", "voices", "dialogue"]);

function schemaEntry(recipe: Recipe, name: string): Record<string, unknown> {
  const entry = (recipe.input_schema as Record<string, unknown>)[name];
  return entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>) : {};
}

/**
 * Manifestから、Recipeの入力名ごとに候補の生成で使われた値を取り出す。
 *
 * Manifestは解決済みの値を、モデル (`model`)、プロンプト (`resolved_prompt`)、
 * それ以外 (`parameters`) に分けて持つ。プロンプト欄の入力名はManifestに残らないため、
 * 慣習名の `positive_prompt` に対応づける。
 */
export function candidateInputValue(name: string, manifest: GenerationManifest): unknown {
  const model = manifest.model as Record<string, unknown>;
  const parameters = manifest.parameters as Record<string, unknown>;
  if (name in model) return model[name];
  if (name in parameters) return parameters[name];
  if (name === "positive_prompt" && manifest.resolved_prompt) return manifest.resolved_prompt;
  return undefined;
}

export function buildPresetInputRows(recipe: Recipe, manifest: GenerationManifest): PresetInputRow[] {
  return Object.keys(recipe.input_schema as Record<string, unknown>).map((name) => {
    const entry = schemaEntry(recipe, name);
    const value = candidateInputValue(name, manifest);
    const control = typeof entry.control === "string" ? entry.control : "";
    const isAuto = value === undefined || AUTO_BY_DEFAULT.has(name) || MEDIA_CONTROLS.has(control);
    return {
      name,
      label: typeof entry.label === "string" && entry.label ? entry.label : name,
      value,
      role: isAuto ? "auto" : "fixed",
    };
  });
}

/**
 * Presetの読込・保存で出たエラーを画面向けの文にする。
 * 入力の重なりやRecipeに無い入力で422になったときは、対象の入力名を添える。
 */
export function describePresetError(error: unknown): string {
  if (!(error instanceof ApiError)) return String(error);
  const details = error.details && typeof error.details === "object"
    ? (error.details as Record<string, unknown>)
    : {};
  const names = [details.overlap, details.unknown]
    .filter((value): value is unknown[] => Array.isArray(value))
    .flat()
    .map(String);
  const suffix = names.length > 0 ? `: ${names.join(", ")}` : "";
  return `${error.message}${suffix} (${error.code})`;
}

/** Preset一覧を持つ画面へ、作成・更新があったことを知らせるイベント名。 */
const LOOK_PROFILES_CHANGED_EVENT = "mycomfyui:look-profiles-changed";

export function notifyLookProfilesChanged(): void {
  window.dispatchEvent(new Event(LOOK_PROFILES_CHANGED_EVENT));
}

export function subscribeLookProfilesChanged(listener: () => void): () => void {
  window.addEventListener(LOOK_PROFILES_CHANGED_EVENT, listener);
  return () => window.removeEventListener(LOOK_PROFILES_CHANGED_EVENT, listener);
}
