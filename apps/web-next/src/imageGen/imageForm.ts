import type { GenerationManifest, Recipe } from "../api/client";
import { composePrompt, type SupplementTags } from "./promptTags";

/** 新規生成に使うWorkflowテンプレート。 */
export const TXT2IMG_TEMPLATE = "anima_txt2img";

export type SeedMode = "random" | "fixed";

/** 入力欄の内容。対象 (Project/Scene/キャラ/衣装) はURLに持たせ、ここには入れない。 */
export type ImageForm = {
  positiveFree: string;
  negativeFree: string;
  /** ×で外した補完タグ。 */
  excludedPositive: string[];
  excludedNegative: string[];
  width: number;
  height: number;
  batchSize: number;
  seedMode: SeedMode;
  seed: number;
  unetName: string;
  clipName: string;
  vaeName: string;
  steps: number;
  cfg: number;
  samplerName: string;
  scheduler: string;
  hiresEnabled: boolean;
  hiresScale: number;
  hiresSteps: number;
  hiresDenoise: number;
};

/** 生成対象。すべて任意で、Project無しでも生成できる。 */
export type ImageTarget = {
  projectId: string | null;
  sceneId: string | null;
  characterId: string | null;
  costumeId: string | null;
};

export const EMPTY_TARGET: ImageTarget = { projectId: null, sceneId: null, characterId: null, costumeId: null };

/** 縦横比のプリセット。値は縦長の向きで持ち、横長は入れ替えて使う。幅と高さは8の倍数にする。 */
export const SIZE_PRESETS = [
  { label: "1:1", short: 1024, long: 1024 },
  { label: "3:4", short: 896, long: 1152 },
  { label: "2:3", short: 832, long: 1216 },
  { label: "9:16", short: 768, long: 1344 },
] as const;

export const BATCH_MAX = 8;
/** backendの`MAX_SEED` (2**53-1) に合わせる。 */
export const SEED_MAX = Number.MAX_SAFE_INTEGER;
/** backendの`AUTO_SEED`。投入時に乱数へ置き換わる。 */
const AUTO_SEED = -1;

/** 今の幅と高さに合うプリセット。向きは問わない。 */
export function presetOf(width: number, height: number): string | null {
  const short = Math.min(width, height);
  const long = Math.max(width, height);
  return SIZE_PRESETS.find((preset) => preset.short === short && preset.long === long)?.label ?? null;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/** Recipeの既定値から作る初期値。「リセット」もこの値へ戻す。 */
export function defaultForm(recipe: Recipe): ImageForm {
  const d = recipe.defaults;
  const seed = numberOr(d.seed, AUTO_SEED);
  return {
    positiveFree: stringOr(d.positive_prompt, ""),
    negativeFree: stringOr(d.negative_prompt, ""),
    excludedPositive: [],
    excludedNegative: [],
    width: numberOr(d.width, 832),
    height: numberOr(d.height, 1216),
    batchSize: numberOr(d.batch_size, 1),
    seedMode: seed < 0 ? "random" : "fixed",
    seed: seed < 0 ? 0 : seed,
    unetName: stringOr(d.unet_name, ""),
    clipName: stringOr(d.clip_name, ""),
    vaeName: stringOr(d.vae_name, ""),
    steps: numberOr(d.steps, 30),
    cfg: numberOr(d.cfg, 4),
    samplerName: stringOr(d.sampler_name, ""),
    scheduler: stringOr(d.scheduler, ""),
    hiresEnabled: d.hires_enabled === true,
    hiresScale: numberOr(d.hires_scale, 2),
    hiresSteps: numberOr(d.hires_steps, 0),
    hiresDenoise: numberOr(d.hires_denoise, 0.5),
  };
}

/** Recipeの`input_schema`にある変数だけを渡せる。それ以外を送るとbackendが投入を断る。 */
export function acceptsInput(recipe: Recipe, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(recipe.input_schema, name);
}

/** 投入するプロンプトとネガティブ。 */
export function composedPrompts(form: ImageForm, supplement: SupplementTags): { positive: string; negative: string } {
  return {
    positive: composePrompt(supplement.positive, form.excludedPositive, form.positiveFree),
    negative: composePrompt(supplement.negative, form.excludedNegative, form.negativeFree),
  };
}

/** `POST /generation-jobs`の`inputs`。空の文字列の変数は送らず、Recipeの既定値に任せる。 */
export function buildInputs(form: ImageForm, supplement: SupplementTags, recipe: Recipe): Record<string, unknown> {
  const { positive, negative } = composedPrompts(form, supplement);
  const values: Record<string, unknown> = {
    positive_prompt: positive,
    negative_prompt: negative,
    width: form.width,
    height: form.height,
    batch_size: form.batchSize,
    seed: form.seedMode === "random" ? AUTO_SEED : form.seed,
    unet_name: form.unetName,
    clip_name: form.clipName,
    vae_name: form.vaeName,
    steps: form.steps,
    cfg: form.cfg,
    sampler_name: form.samplerName,
    scheduler: form.scheduler,
    hires_enabled: form.hiresEnabled,
    hires_scale: form.hiresScale,
    hires_steps: form.hiresSteps,
    hires_denoise: form.hiresDenoise,
  };
  return Object.fromEntries(
    Object.entries(values).filter(([name, value]) => value !== "" && acceptsInput(recipe, name)),
  );
}

/**
 * 投入済みのJobのManifestから入力欄の値を作る。プロンプトの分け直しは呼び出し側が行う。
 * seedは実際に使った値を固定で戻し、同じ画像を作り直せるようにする。
 */
export function formFromManifest(base: ImageForm, manifest: GenerationManifest): ImageForm {
  const p = manifest.parameters;
  const m = manifest.model;
  return {
    ...base,
    width: numberOr(p.width, base.width),
    height: numberOr(p.height, base.height),
    batchSize: numberOr(p.batch_size, base.batchSize),
    seedMode: "fixed",
    seed: manifest.seed,
    unetName: stringOr(m.unet_name, base.unetName),
    clipName: stringOr(m.clip_name, base.clipName),
    vaeName: stringOr(m.vae_name, base.vaeName),
    steps: numberOr(p.steps, base.steps),
    cfg: numberOr(p.cfg, base.cfg),
    samplerName: stringOr(p.sampler_name, base.samplerName),
    scheduler: stringOr(p.scheduler, base.scheduler),
    hiresEnabled: typeof p.hires_enabled === "boolean" ? p.hires_enabled : base.hiresEnabled,
    hiresScale: numberOr(p.hires_scale, base.hiresScale),
    hiresSteps: numberOr(p.hires_steps, base.hiresSteps),
    hiresDenoise: numberOr(p.hires_denoise, base.hiresDenoise),
  };
}
