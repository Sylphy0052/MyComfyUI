import type { GenerationManifest, Recipe } from "../api/client";
import { acceptsInput, isRecord, SEED_MAX, type SeedMode } from "../imageGen/imageForm";

/** BGM生成に使うWorkflowテンプレート。 */
export const BGM_TEMPLATE = "ace_step_bgm";

/** Sceneに採用済みの動画が無いときの長さ (秒)。 */
export const DEFAULT_SECONDS = 30;
export const SECONDS_MAX = 600;
/**
 * `steps` / `cfg`の欄の範囲。backendは`steps`を1以上の整数、`cfg`を0より大きい数としか見ないため、
 * 上限は画面側の誤入力除け。画像の欄 (`imageGen/ParamsFields.tsx`) と同じ値にしてある。
 * `STEPS_MAX`はbackendの`sampling_steps`の範囲 (1〜1000、`workflow.py`) とも揃う。
 */
export const STEPS_MAX = 1_000;
export const CFG_MIN = 0.1;
export const CFG_MAX = 100;

/** Recipeの既定値が読めないときの`steps` / `cfg`。`ace_step_bgm`の`MUSIC_DEFAULTS` (`bootstrap.py`) の値。 */
const FALLBACK_STEPS = 50;
const FALLBACK_CFG = 5;

/** 1回の投入で分けるJobの数の上限。 */
export const COUNT_MAX = 8;
/** 固定seedで枚数を増やすと`seed + 0..枚数-1`をJobごとに使うため、その分を空けておく。 */
export const SEED_INPUT_MAX = SEED_MAX - COUNT_MAX;

/** 歌詞が空のときに補完タグとして付けるタグ。 */
export const INSTRUMENTAL_TAG = "instrumental";

/** backendの`AUTO_SEED`。投入時に乱数へ置き換わる。 */
const AUTO_SEED = -1;

/** 入力欄の内容。対象 (Project/Scene) はURLに持たせ、ここには入れない。 */
export type BgmForm = {
  /** シーンの`bgm_mood`を入れる日本語の欄。タグへの変換は別Issue (#578) で足す。 */
  moodJa: string;
  tags: string;
  negative: string;
  lyrics: string;
  /** 長さ (秒)。`null`は既定値 (採用済みの動画の長さか30秒) に従う。 */
  seconds: number | null;
  count: number;
  seedMode: SeedMode;
  seed: number;
  ckptName: string;
  steps: number;
  cfg: number;
  samplerName: string;
  scheduler: string;
};

/** 生成対象。どちらも任意で、Project無しでも生成できる。 */
export type BgmTarget = { projectId: string | null; sceneId: string | null };

/** localStorageに残す入力欄と対象。 */
export type StoredBgmInput = { form: BgmForm | null; target: BgmTarget | null };

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/** Recipeの既定値から作る初期値。「リセット」もこの値へ戻す。 */
export function defaultBgmForm(recipe: Recipe): BgmForm {
  const d = recipe.defaults;
  const seed = numberOr(d.seed, AUTO_SEED);
  return {
    moodJa: "",
    tags: stringOr(d.positive_prompt, ""),
    negative: stringOr(d.negative_prompt, ""),
    lyrics: stringOr(d.lyrics, ""),
    seconds: null,
    count: 1,
    seedMode: seed < 0 ? "random" : "fixed",
    seed: seed < 0 ? 0 : seed,
    ckptName: stringOr(d.ckpt_name, ""),
    steps: numberOr(d.steps, FALLBACK_STEPS),
    cfg: numberOr(d.cfg, FALLBACK_CFG),
    samplerName: stringOr(d.sampler_name, ""),
    scheduler: stringOr(d.scheduler, ""),
  };
}

/** 保存してあった入力欄の値を`base`の上に重ねる。型の合うキーだけを使い、古い形や壊れた値で画面が落ちないようにする。 */
export function normalizeBgmForm(raw: Record<string, unknown>, base: BgmForm): BgmForm {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, fallback] of Object.entries(base)) {
    if (key === "seconds") continue;
    const value = raw[key];
    const same = typeof fallback === "number" ? typeof value === "number" && Number.isFinite(value) : typeof value === typeof fallback;
    if (same) merged[key] = value;
  }
  const form = merged as BgmForm;
  const seconds = raw.seconds;
  return {
    ...form,
    seconds: typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? seconds : null,
    count: Math.min(COUNT_MAX, Math.max(1, Math.trunc(form.count))),
    seedMode: form.seedMode === "random" || form.seedMode === "fixed" ? form.seedMode : base.seedMode,
  };
}

/** 保存してあった対象。各値は空でない文字列だけを使う。 */
export function normalizeBgmTarget(raw: unknown): BgmTarget | null {
  if (!isRecord(raw)) return null;
  const idOf = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);
  return { projectId: idOf(raw.projectId), sceneId: idOf(raw.sceneId) };
}

/** タグをカンマで分け、前後の空白と空の要素を除く。 */
function splitTags(text: string): string[] {
  return text
    .split(/[,、\n]/)
    .map((tag) => tag.trim())
    .filter((tag) => tag !== "");
}

/**
 * 投入するタグ。歌詞が空のときだけ`instrumental`を補う。
 * 歌詞が空白だけのときも空とみなす。タグに既にあれば重ねない。
 */
export function composeBgmTags(form: BgmForm): string {
  const tags = splitTags(form.tags);
  const instrumental = form.lyrics.trim() === "";
  if (instrumental && !tags.some((tag) => tag.toLowerCase() === INSTRUMENTAL_TAG)) tags.push(INSTRUMENTAL_TAG);
  return tags.join(", ");
}

/** 長さの既定値。Sceneに採用済みの動画があればその長さ、無ければ30秒。長さの欄の上限 (`SECONDS_MAX`) を超える動画は上限に丸める。 */
export function defaultSeconds(videoSeconds: number | null): number {
  return Math.min(videoSeconds ?? DEFAULT_SECONDS, SECONDS_MAX);
}

/** 動画のManifestから長さ (秒) を出す。`length / fps`を小数1桁に丸める。読めなければ`null`。 */
export function videoSecondsOf(manifest: GenerationManifest): number | null {
  const { length, fps } = manifest.parameters;
  if (typeof length !== "number" || typeof fps !== "number" || length <= 0 || fps <= 0) return null;
  const seconds = Math.round((length / fps) * 10) / 10;
  return seconds > 0 ? seconds : null;
}

/** 空文字のまま送る変数。空にして既定値を打ち消せる。 */
const EMPTY_ALLOWED: ReadonlySet<string> = new Set(["negative_prompt", "lyrics"]);

/**
 * `POST /generation-jobs`の`inputs`。枚数ぶんのJobに分けるため、`index`番目のJobの本文を作る。
 * seedが固定のときは`seed + index`にして、Jobごとに別の曲になるようにする。
 * 空の文字列は、`negative_prompt`と`lyrics`以外の変数では送らず、Recipeの既定値に任せる。
 * `negative_prompt`と`lyrics`は空でも送る。backendは`inputs`をRecipeの既定値の上に重ねるため
 * (`prepare.py`の`{**defaults, **inputs}`)、送らないと利用者が空にしても既定値が効いてしまう。
 */
export function buildBgmInputs(form: BgmForm, seconds: number, index: number, recipe: Recipe): Record<string, unknown> {
  const values: Record<string, unknown> = {
    positive_prompt: composeBgmTags(form),
    negative_prompt: form.negative.trim(),
    // 空白と改行だけの歌詞は空とみなす (`composeBgmTags`が`instrumental`を補う条件と同じ)。
    lyrics: form.lyrics.trim() === "" ? "" : form.lyrics,
    seconds,
    seed: form.seedMode === "random" ? AUTO_SEED : form.seed + index,
    ckpt_name: form.ckptName,
    steps: form.steps,
    cfg: form.cfg,
    sampler_name: form.samplerName,
    scheduler: form.scheduler,
  };
  return Object.fromEntries(
    Object.entries(values).filter(
      ([name, value]) => (value !== "" || EMPTY_ALLOWED.has(name)) && acceptsInput(recipe, name),
    ),
  );
}
