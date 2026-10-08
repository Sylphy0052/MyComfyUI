import {
  artifactContentUrl,
  imageReferenceUrl,
  type GenerationJob,
  type GenerationJobBody,
  type GenerationManifest,
  type PromptOnlyVideoJobBody,
  type Recipe,
} from "../api/client";
import type { ImageRef, SourceImage } from "../imageGen/deriveForm";
import { acceptsInput, buildInputs, defaultForm, isRecord, type ImageTarget } from "../imageGen/imageForm";
import type { SupplementTags } from "../imageGen/promptTags";

/**
 * 動画の方式。「画像から」(i2v) は先頭フレーム1枚、「参照から」(ref2v) は参照画像1〜9枚。
 * 「プロンプトだけ」(prompt) は画像を生成してからその画像を先頭フレームにするi2v (2段)。動画側のRecipeはi2vを使う。
 */
export type VideoMode = "i2v" | "ref2v" | "prompt";

export const VIDEO_TEMPLATES: Record<VideoMode, string> = {
  i2v: "minimax_h3_i2v",
  ref2v: "minimax_h3_ref2v",
  prompt: "minimax_h3_i2v",
};

export const VIDEO_MODE_LABELS: Record<VideoMode, string> = {
  i2v: "画像から",
  ref2v: "参照から",
  prompt: "プロンプトだけ",
};

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

/** guide_audioに選んだ台詞音声1本。生成物かアップロードした参照音声。 */
export type GuideAudio = {
  ref: ImageRef;
  label: string;
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
  /** 「プロンプトだけ」の1段目 (画像) のプロンプト。空のネガティブはRecipeの既定値を使う。 */
  imagePrompt: string;
  imageNegative: string;
  firstFrame: VideoImage | null;
  references: VideoImage[];
  /** 台詞音声。選ぶと`audio_mode=external_voice`で投入する。 */
  guideAudio: GuideAudio | null;
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
    imagePrompt: "",
    imageNegative: "",
    firstFrame: null,
    references: [],
    guideAudio: null,
    params: {
      i2v: defaultParams(recipes.i2v),
      ref2v: defaultParams(recipes.ref2v),
      prompt: defaultParams(recipes.prompt),
    },
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
  return videoImage(copyRef(raw.ref), stringOr(raw.label, ""), raw.auto === true);
}

/** 余計なキーを落として参照だけにする。 */
function copyRef(ref: ImageRef): ImageRef {
  return "artifact_id" in ref
    ? { artifact_id: ref.artifact_id }
    : { relative_path: ref.relative_path, sha256: ref.sha256 };
}

/** 保存してあった台詞音声。古い保存値にはこの欄が無いので、無い・壊れているときは未選択にする。 */
function normalizeGuideAudio(raw: unknown): GuideAudio | null {
  if (!isRecord(raw) || !isImageRef(raw.ref)) return null;
  return { ref: copyRef(raw.ref), label: stringOr(raw.label, "") };
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
    mode: raw.mode === "ref2v" || raw.mode === "prompt" ? raw.mode : "i2v",
    prompt: stringOr(raw.prompt, base.prompt),
    imagePrompt: stringOr(raw.imagePrompt, base.imagePrompt),
    imageNegative: stringOr(raw.imageNegative, base.imageNegative),
    firstFrame: normalizeImage(raw.firstFrame),
    references: addReferences(
      [],
      Array.isArray(raw.references)
        ? raw.references.flatMap((item) => normalizeImage(item) ?? [])
        : [],
    ),
    guideAudio: normalizeGuideAudio(raw.guideAudio),
    params: {
      i2v: normalizeParams(params.i2v, base.params.i2v),
      ref2v: normalizeParams(params.ref2v, base.params.ref2v),
      prompt: normalizeParams(params.prompt, base.params.prompt),
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
export function videoBlockedReason(
  draft: VideoDraft,
  recipe: Recipe | null,
  imageRecipe: Recipe | null,
): string | null {
  if (recipe === null) return "この方式のRecipeがありません";
  if (draft.mode === "prompt" && imageRecipe === null) return "画像のRecipeがありません";
  if (draft.mode === "prompt" && draft.imagePrompt.trim() === "") return "画像のプロンプトを入力してください";
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
  } else if (draft.mode === "ref2v") {
    values.references = draft.references.map((item) => item.ref);
  }
  // 台詞音声は、Recipeが受けるときだけ送る。`guide_audio`は`audio_mode=external_voice`とセットでないとbackendが422にする。
  if (draft.guideAudio !== null && acceptsInput(recipe, "guide_audio") && acceptsInput(recipe, "audio_mode")) {
    values.audio_mode = "external_voice";
    values.guide_audio = draft.guideAudio.ref;
  }
  return Object.fromEntries(
    Object.entries(values).filter(([name, value]) => value !== "" && acceptsInput(recipe, name)),
  );
}

/** Job2本に共通の紐づけ (Project/Scene/キャラ/衣装)。 */
export type VideoLinks = Pick<
  GenerationJobBody,
  "project_id" | "story_scene_id" | "story_character_id" | "story_costume_id"
>;

/**
 * `POST /prompt-only-video-jobs`の本文。1段目は`anima_txt2img` (1枚、大きさは動画に合わせる)、2段目はi2vで、
 * 先頭フレームはサーバが1段目の画像から入れるため送らない。補完タグは`/image`と同じく1段目のプロンプトの前に足す。
 */
export function buildPromptOnlyBody(
  draft: VideoDraft,
  videoRecipe: Recipe,
  imageRecipe: Recipe,
  links: VideoLinks,
  supplement: SupplementTags,
): PromptOnlyVideoJobBody {
  const p = draft.params.prompt;
  const base = defaultForm(imageRecipe);
  const form = {
    ...base,
    positiveFree: draft.imagePrompt.trim(),
    negativeFree: draft.imageNegative.trim() === "" ? base.negativeFree : draft.imageNegative.trim(),
    width: p.width,
    height: p.height,
    batchSize: 1,
  };
  return {
    image: {
      kind: "image",
      recipe_id: imageRecipe.id,
      use_inherited_defaults: false,
      ...links,
      inputs: buildInputs(form, supplement, imageRecipe),
    },
    video: {
      kind: "video",
      recipe_id: videoRecipe.id,
      use_inherited_defaults: false,
      ...links,
      inputs: buildVideoInputs(draft, videoRecipe),
    },
  };
}

// ---- 生成物からの復元 ----

/** 生成物から戻した入力欄と対象。戻せなかった項目があれば`warning`に理由を入れる。 */
export type VideoRestored = { draft: VideoDraft; target: ImageTarget; warning: string | null };

type InputUpload = { variable: string; ref: ImageRef; label: string };

/** Manifestの`input_uploads`から、素材の参照を取り出す。生成物の素材は`artifact_id`、取り込み済みの素材はファイルの参照で戻す。 */
function inputUploadsOf(parameters: Record<string, unknown>): InputUpload[] {
  const raw = parameters.input_uploads;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): InputUpload[] => {
    if (!isRecord(item) || typeof item.variable !== "string") return [];
    const artifactId = idOrNull(item.artifact_id);
    const relativePath = idOrNull(item.relative_path);
    const sha256 = idOrNull(item.sha256);
    let ref: ImageRef;
    if (artifactId !== null) ref = { artifact_id: artifactId };
    else if (relativePath !== null && sha256 !== null) ref = { relative_path: relativePath, sha256 };
    else return [];
    return [{ variable: item.variable, ref, label: stringOr(item.file_name, relativePath ?? artifactId ?? item.variable) }];
  });
}

/**
 * 動画Jobとそのマニフェストから入力欄の内容を作る。方式はWorkflowテンプレートから決め、
 * 先頭フレーム・参照画像・台詞音声は`input_uploads`から、プロンプトは`resolved_prompt`から、
 * サイズ・長さ・モデルなどは`parameters` / `model`から戻す。シードは固定にして同じ値を使う。
 * Project・Scene・衣装はJobの紐づけをそのまま対象にし、追加キャストは戻さない。
 */
export function videoRestoredFromManifest(
  base: VideoDraft,
  job: Pick<GenerationJob, "assigned_project_id" | "story_scene_id" | "story_character_id" | "story_costume_id">,
  manifest: Pick<GenerationManifest, "parameters" | "model" | "resolved_prompt" | "seed">,
): VideoRestored {
  const { parameters, model } = manifest;
  const template = parameters.workflow_template;
  const mode: VideoMode | null =
    template === VIDEO_TEMPLATES.ref2v ? "ref2v" : template === VIDEO_TEMPLATES.i2v ? "i2v" : null;
  if (mode === null) throw new Error("動画の生成設定ではありません");

  const prev = base.params[mode];
  const fps = numberOr(parameters.fps, prev.fps);
  const params: VideoParams = {
    width: numberOr(parameters.width, prev.width),
    height: numberOr(parameters.height, prev.height),
    seconds: typeof parameters.length === "number" ? round1(parameters.length / fps) : prev.seconds,
    seedMode: "fixed",
    seed: manifest.seed,
    steps: numberOr(parameters.steps, prev.steps),
    samplerName: stringOr(parameters.sampler_name, prev.samplerName),
    schedulerName: stringOr(parameters.scheduler, prev.schedulerName),
    fps,
    unetName: stringOr(model.unet_name, prev.unetName),
    clipName: stringOr(model.clip_name, prev.clipName),
    videoVaeName: stringOr(model.video_vae_name, prev.videoVaeName),
    audioVaeName: stringOr(model.audio_vae_name, prev.audioVaeName),
  };

  const uploads = inputUploadsOf(parameters);
  const firstFrame = uploads.find((item) => item.variable === "first_frame");
  const references = uploads
    .filter((item) => /^reference_\d+$/.test(item.variable))
    .sort((a, b) => Number(a.variable.slice(10)) - Number(b.variable.slice(10)))
    .map((item) => videoImage(item.ref, item.label, false));
  const guide = uploads.find((item) => item.variable === "guide_audio");

  const warnings: string[] = [];
  if (parameters.audio_mode === "silent") warnings.push("無音の指定は戻せません");
  if (parameters.audio_mode === "external_voice" && guide === undefined) warnings.push("台詞音声の素材が見つかりません");
  if (typeof parameters.guide_frame_idx === "number" && parameters.guide_frame_idx !== 0) {
    warnings.push("台詞音声の開始フレームは戻せません (0になります)");
  }

  return {
    draft: {
      ...base,
      mode,
      prompt: manifest.resolved_prompt,
      firstFrame: mode === "i2v" && firstFrame !== undefined ? videoImage(firstFrame.ref, firstFrame.label, false) : null,
      references: mode === "ref2v" ? addReferences([], references) : [],
      guideAudio: guide !== undefined && parameters.audio_mode === "external_voice" ? { ref: guide.ref, label: guide.label } : null,
      params: { ...base.params, [mode]: params },
      // 戻した対象のScene・衣装で、自動の補完が入力を上書きしないよう「補完済み」にしておく。
      filled: { sceneId: job.story_scene_id ?? null, costumeId: job.story_costume_id ?? null, motion: null },
    },
    target: {
      projectId: job.assigned_project_id,
      sceneId: job.story_scene_id ?? null,
      characterId: job.story_character_id ?? null,
      costumeId: job.story_costume_id ?? null,
      extraCast: [],
    },
    warning: warnings.length === 0 ? null : warnings.join("。"),
  };
}
