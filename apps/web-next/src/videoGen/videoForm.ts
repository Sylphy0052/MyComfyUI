import { artifactContentUrl, imageReferenceUrl, type Recipe } from "../api/client";
import type { ImageRef, SourceImage } from "../imageGen/deriveForm";
import { acceptsInput, isRecord } from "../imageGen/imageForm";

/** 動画の方式。「画像から」(i2v) は先頭フレーム1枚、「参照から」(ref2v) は参照画像1〜9枚。 */
export type VideoMode = "i2v" | "ref2v";

export const VIDEO_TEMPLATES: Record<VideoMode, string> = {
  i2v: "minimax_h3_i2v",
  ref2v: "minimax_h3_ref2v",
};

export const VIDEO_MODE_LABELS: Record<VideoMode, string> = { i2v: "画像から", ref2v: "参照から" };

/** 参照画像の上限。backendの`MAX_REFERENCE_IMAGES` (`workflow.py`) に合わせる。 */
export const REFERENCES_MAX = 9;

/**
 * フレーム数のグリッド (17k+5) と範囲。backendの`prepare.py`の`FRAME_GRID_*`・`MIN_FRAMES`・`MAX_FRAMES`に合わせる。
 * どちらかを変えたらもう一方も直す。
 */
const FRAME_GRID_STEP = 17;
const FRAME_GRID_BASE = 5;
export const MIN_FRAMES = 124;
export const MAX_FRAMES = 362;

const FALLBACK_FPS = 24;
/** Recipeに既定値が無いときの出力サイズとsteps。 */
const FALLBACK_WIDTH = 864;
const FALLBACK_HEIGHT = 480;
const FALLBACK_STEPS = 20;
/** backendの`AUTO_SEED`。投入時に乱数へ置き換わる。 */
const AUTO_SEED = -1;
/** backendの`MAX_SEED` (2**53-1) に合わせる。 */
export const SEED_MAX = Number.MAX_SAFE_INTEGER;

export type SeedMode = "random" | "fixed";

/** 先頭フレーム・参照画像として選んだ1枚。`auto`は、ProjectのScene・衣装から自動で入れたもの。 */
export type VideoImage = {
  ref: ImageRef;
  previewUrl: string;
  label: string;
  auto: boolean;
};

/** 方式ごとの数値・モデルの入力。既定のサイズやモデルが方式ごとに違うため、方式ごとに持つ。 */
export type VideoParams = {
  width: number;
  height: number;
  /** 長さ(秒)。投入時に17k+5のフレーム数へ丸める。 */
  seconds: number;
  seedMode: SeedMode;
  seed: number;
  steps: number;
  samplerName: string;
  schedulerName: string;
  fps: number;
  unetName: string;
  clipName: string;
  videoVaeName: string;
  audioVaeName: string;
};

/** ProjectのScene・衣装から自動で入れた対象。同じ対象では入れ直さず、手で直した値を残す。 */
export type VideoFilled = {
  sceneId: string | null;
  costumeId: string | null;
  /** 自由欄へ入れた`video_motion`。自由欄がこの値のままなら、別のSceneの動きで置き換えてよい。 */
  motion: string | null;
};

/** 入力欄の内容。対象 (Project/Scene/キャラ/衣装) はURLに持たせ、ここには入れない。 */
export type VideoDraft = {
  mode: VideoMode;
  prompt: string;
  firstFrame: VideoImage | null;
  references: VideoImage[];
  params: Record<VideoMode, VideoParams>;
  filled: VideoFilled;
};

export type VideoRecipes = Record<VideoMode, Recipe | null>;

// ---- 長さ ----

/**
 * 秒数を、17k+5のグリッド上で最も近いフレーム数にする。範囲 (124〜362) の外は端へ寄せる。
 * 範囲の両端 (124, 362) はどちらもグリッド上にある。
 */
export function framesFromSeconds(seconds: number, fps: number): number {
  const steps = Math.round((seconds * fps - FRAME_GRID_BASE) / FRAME_GRID_STEP);
  const raw = FRAME_GRID_BASE + steps * FRAME_GRID_STEP;
  return Math.min(Math.max(raw, MIN_FRAMES), MAX_FRAMES);
}

/** 丸めたフレーム数の秒数。入力欄の横に出す。 */
export function secondsOfFrames(frames: number, fps: number): number {
  return frames / fps;
}

// ---- 画像 ----

export function refKeyOf(ref: ImageRef): string {
  return "artifact_id" in ref ? `artifact:${ref.artifact_id}` : `input:${ref.relative_path}:${ref.sha256}`;
}

export function previewUrlOf(ref: ImageRef): string {
  return "artifact_id" in ref ? artifactContentUrl(ref.artifact_id) : imageReferenceUrl(ref.relative_path);
}

export function videoImage(ref: ImageRef, label: string, auto: boolean): VideoImage {
  return { ref, previewUrl: previewUrlOf(ref), label, auto };
}

/** 画像の選択欄で選んだ元画像を、動画の入力にする。選んだ画像の紐づけは対象へ引き継がない。 */
export function videoImageFromSource(source: SourceImage): VideoImage {
  return videoImage(source.ref, source.label, false);
}

/** 参照画像を足した結果と、入れなかった枚数。`duplicated`は同じ画像が既にあった分、`overflow`は上限を超えた分。 */
export type MergedReferences = { references: VideoImage[]; duplicated: number; overflow: number };

/** 参照画像を足す。同じ画像は重ねず、上限を超えた分は入れない。 */
export function mergeReferences(current: readonly VideoImage[], added: readonly VideoImage[]): MergedReferences {
  const references = [...current];
  let duplicated = 0;
  let overflow = 0;
  for (const item of added) {
    if (references.some((existing) => refKeyOf(existing.ref) === refKeyOf(item.ref))) duplicated += 1;
    else if (references.length >= REFERENCES_MAX) overflow += 1;
    else references.push(item);
  }
  return { references, duplicated, overflow };
}

export function addReferences(current: readonly VideoImage[], added: readonly VideoImage[]): VideoImage[] {
  return mergeReferences(current, added).references;
}

// ---- 既定値と保存 ----

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Recipeの既定値から作る方式ごとの初期値。Recipeが無ければ最小限の値にする。 */
export function defaultParams(recipe: Recipe | null): VideoParams {
  const d = recipe?.defaults ?? {};
  const fps = numberOr(d.fps, FALLBACK_FPS);
  const seed = numberOr(d.seed, AUTO_SEED);
  return {
    width: numberOr(d.width, FALLBACK_WIDTH),
    height: numberOr(d.height, FALLBACK_HEIGHT),
    seconds: round1(numberOr(d.length, MIN_FRAMES) / fps),
    seedMode: seed < 0 ? "random" : "fixed",
    seed: seed < 0 ? 0 : seed,
    steps: numberOr(d.steps, FALLBACK_STEPS),
    samplerName: stringOr(d.sampler_name, ""),
    schedulerName: stringOr(d.scheduler, ""),
    fps,
    unetName: stringOr(d.unet_name, ""),
    clipName: stringOr(d.clip_name, ""),
    videoVaeName: stringOr(d.video_vae_name, ""),
    audioVaeName: stringOr(d.audio_vae_name, ""),
  };
}

export const EMPTY_FILLED: VideoFilled = { sceneId: null, costumeId: null, motion: null };

export function defaultDraft(recipes: VideoRecipes): VideoDraft {
  return {
    mode: "i2v",
    prompt: "",
    firstFrame: null,
    references: [],
    params: { i2v: defaultParams(recipes.i2v), ref2v: defaultParams(recipes.ref2v) },
    filled: EMPTY_FILLED,
  };
}

function isImageRef(value: unknown): value is ImageRef {
  if (!isRecord(value)) return false;
  if (typeof value.artifact_id === "string" && value.artifact_id !== "") return true;
  return (
    typeof value.relative_path === "string" &&
    value.relative_path !== "" &&
    typeof value.sha256 === "string" &&
    value.sha256 !== ""
  );
}

/** 保存してあった画像。参照の形が合うものだけを使い、プレビューのURLは保存値を信用せず参照から作り直す。 */
function normalizeImage(raw: unknown): VideoImage | null {
  if (!isRecord(raw) || !isImageRef(raw.ref)) return null;
  const ref: ImageRef =
    "artifact_id" in raw.ref
      ? { artifact_id: raw.ref.artifact_id }
      : { relative_path: raw.ref.relative_path, sha256: raw.ref.sha256 };
  return videoImage(ref, stringOr(raw.label, ""), raw.auto === true);
}

/** 保存してあった方式ごとの入力を`base`の上に重ねる。型の合うキーだけを使う。 */
function normalizeParams(raw: unknown, base: VideoParams): VideoParams {
  if (!isRecord(raw)) return base;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, fallback] of Object.entries(base)) {
    const value = raw[key];
    if (typeof fallback === "number" ? typeof value === "number" && Number.isFinite(value) : typeof value === typeof fallback) {
      merged[key] = value;
    }
  }
  const params = merged as VideoParams;
  return { ...params, seedMode: params.seedMode === "fixed" ? "fixed" : "random" };
}

function idOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** 保存してあった入力欄の値。壊れた値や古い形でも画面が開けるよう、型の合う値だけを読む。 */
export function normalizeDraft(raw: Record<string, unknown>, base: VideoDraft): VideoDraft {
  const filled = isRecord(raw.filled) ? raw.filled : {};
  const params = isRecord(raw.params) ? raw.params : {};
  return {
    mode: raw.mode === "ref2v" ? "ref2v" : "i2v",
    prompt: stringOr(raw.prompt, base.prompt),
    firstFrame: normalizeImage(raw.firstFrame),
    references: addReferences(
      [],
      Array.isArray(raw.references)
        ? raw.references.flatMap((item) => normalizeImage(item) ?? [])
        : [],
    ),
    params: {
      i2v: normalizeParams(params.i2v, base.params.i2v),
      ref2v: normalizeParams(params.ref2v, base.params.ref2v),
    },
    filled: {
      sceneId: idOrNull(filled.sceneId),
      costumeId: idOrNull(filled.costumeId),
      motion: typeof filled.motion === "string" ? filled.motion : null,
    },
  };
}

// ---- 投入 ----

/** 投入できない理由。投入できるなら`null`。 */
export function videoBlockedReason(draft: VideoDraft, recipe: Recipe | null): string | null {
  if (recipe === null) return "この方式のRecipeがありません";
  if (draft.mode === "i2v" && draft.firstFrame === null) return "先頭フレームを1枚選んでください";
  if (draft.mode === "ref2v" && draft.references.length === 0) return "参照画像を1枚以上選んでください";
  if (draft.prompt.trim() === "") return "プロンプトを入力してください";
  return null;
}

/** `POST /generation-jobs`の`inputs`。空の文字列の変数は送らず、Recipeの既定値に任せる。 */
export function buildVideoInputs(draft: VideoDraft, recipe: Recipe): Record<string, unknown> {
  const p = draft.params[draft.mode];
  const values: Record<string, unknown> = {
    positive_prompt: draft.prompt.trim(),
    width: p.width,
    height: p.height,
    length: framesFromSeconds(p.seconds, p.fps),
    seed: p.seedMode === "random" ? AUTO_SEED : p.seed,
    steps: p.steps,
    sampler_name: p.samplerName,
    scheduler: p.schedulerName,
    fps: p.fps,
    unet_name: p.unetName,
    clip_name: p.clipName,
    video_vae_name: p.videoVaeName,
    audio_vae_name: p.audioVaeName,
  };
  if (draft.mode === "i2v") {
    if (draft.firstFrame !== null) values.first_frame = draft.firstFrame.ref;
  } else {
    values.references = draft.references.map((item) => item.ref);
  }
  return Object.fromEntries(
    Object.entries(values).filter(([name, value]) => value !== "" && acceptsInput(recipe, name)),
  );
}
