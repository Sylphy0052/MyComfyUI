import type { GenerationManifest, Recipe } from "../api/client";
import { composePositive, composePrompt, type SupplementTags } from "./promptTags";

/** 新規生成に使うWorkflowテンプレート。 */
export const TXT2IMG_TEMPLATE = "anima_txt2img";

export type SeedMode = "random" | "fixed";

/** スイープの組み合わせ方。全組合せ (cartesian) か、位置を揃えた対 (zip)。 */
export type SweepMode = "cartesian" | "zip";

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
  /** スイープのスイッチ。オンの間、投入は`POST /generation-experiments`へ送る。 */
  sweepEnabled: boolean;
  sweepMode: SweepMode;
  /** 軸の値。カンマ区切りの入力欄の文字列のまま持つ。断片だけは`|`か改行区切り。 */
  sweepSeed: string;
  sweepCfg: string;
  sweepSteps: string;
  sweepFragment: string;
};

/** 2人目以降のキャラと衣装の組。 */
export type CastMember = { characterId: string; costumeId: string | null };

/** 複数人の上限 (先頭キャラを含む)。 */
export const CAST_MAX = 4;

/**
 * 生成対象。すべて任意で、Project無しでも生成できる。
 * `characterId`/`costumeId`は先頭キャラ。`extraCast`は2人目以降で、新規タブだけが使う。
 */
export type ImageTarget = {
  projectId: string | null;
  sceneId: string | null;
  characterId: string | null;
  costumeId: string | null;
  extraCast: CastMember[];
};

export const EMPTY_TARGET: ImageTarget = {
  projectId: null,
  sceneId: null,
  characterId: null,
  costumeId: null,
  extraCast: [],
};

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

/** 生成物のManifestから戻すseed。0以上の整数なら`max`以下に丸めて返し、それ以外 (NaN・小数・負数・非数) は`null`。 */
export function restorableSeed(value: unknown, max: number): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
  return Math.min(value, max);
}
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
    sweepEnabled: false,
    sweepMode: "cartesian",
    sweepSeed: "",
    sweepCfg: "",
    sweepSteps: "",
    sweepFragment: "",
  };
}

/** JSONのオブジェクトか。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 保存値が既定値と同じ型か。配列は文字列の配列、数は有限の値に限る。 */
function sameKind(value: unknown, fallback: unknown): boolean {
  if (Array.isArray(fallback)) return Array.isArray(value) && value.every((item) => typeof item === "string");
  if (typeof fallback === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === typeof fallback;
}

/** 保存してあった入力欄の値を`base`の上に重ねる。型の合うキーだけを使い、古い形や壊れた値で画面が落ちないようにする。 */
export function normalizeForm(raw: Record<string, unknown>, base: ImageForm): ImageForm {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, fallback] of Object.entries(base)) {
    if (sameKind(raw[key], fallback)) merged[key] = raw[key];
  }
  const form = merged as ImageForm;
  return {
    ...form,
    seedMode: form.seedMode === "random" || form.seedMode === "fixed" ? form.seedMode : base.seedMode,
    sweepMode: form.sweepMode === "cartesian" || form.sweepMode === "zip" ? form.sweepMode : base.sweepMode,
  };
}

/**
 * 2人目以降を整える。先頭キャラが無ければ空にする。先頭や他と重なるキャラは落とし、合計が上限に収まるまでにする。
 */
export function normalizeExtraCast(characterId: string | null, extra: readonly CastMember[]): CastMember[] {
  if (characterId === null) return [];
  const seen = new Set([characterId]);
  const result: CastMember[] = [];
  for (const member of extra) {
    if (result.length >= CAST_MAX - 1) break;
    if (seen.has(member.characterId)) continue;
    seen.add(member.characterId);
    result.push(member);
  }
  return result;
}

/** 保存してあった対象。各値は空でない文字列だけを使う。 */
export function normalizeTarget(raw: unknown): ImageTarget | null {
  if (!isRecord(raw)) return null;
  const idOf = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);
  const characterId = idOf(raw.characterId);
  const extra: CastMember[] = [];
  if (Array.isArray(raw.extraCast)) {
    for (const item of raw.extraCast) {
      if (!isRecord(item)) continue;
      const memberId = idOf(item.characterId);
      if (memberId !== null) extra.push({ characterId: memberId, costumeId: idOf(item.costumeId) });
    }
  }
  return {
    projectId: idOf(raw.projectId),
    sceneId: idOf(raw.sceneId),
    characterId,
    costumeId: idOf(raw.costumeId),
    extraCast: normalizeExtraCast(characterId, extra),
  };
}

/** Recipeの`input_schema`にある変数だけを渡せる。それ以外を送るとbackendが投入を断る。 */
export function acceptsInput(recipe: Recipe, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(recipe.input_schema, name);
}

/** 投入するプロンプトとネガティブ。 */
export function composedPrompts(form: ImageForm, supplement: SupplementTags): { positive: string; negative: string } {
  return {
    positive: composePositive(supplement, form.excludedPositive, form.positiveFree),
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
