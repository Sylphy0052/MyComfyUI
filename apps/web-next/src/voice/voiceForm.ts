import type { Recipe, StoryCharacter } from "../api/client";
import { acceptsInput, isRecord, SEED_MAX, type SeedMode } from "../imageGen/imageForm";

/** 声質の文章 (caption) の上限。backendの`MAX_CAPTION_CHARS`と揃える。 */
export const CAPTION_MAX = 500;

/** 台詞1行を指す`voice_id`。1行だけを投入するので固定でよい。 */
export const VOICE_ID = "v";

/** backendの`AUTO_SEED`。投入時に乱数へ置き換わる。 */
const AUTO_SEED = -1;

/** 声の指定。`clone`は参照音声、`caption`は声質の文章。 */
export type VoiceMode = "clone" | "caption";

/** Cloneの参照の出どころ。`character`は話者のキャラの声、`file`はアップロードか生成物から取り込んだ参照音声。 */
export type ReferenceSource = "character" | "file";

/** 取り込み済みの参照音声 (`POST /voice-references`の戻り)。 */
export type VoiceReferenceFile = { relativePath: string; sha256: string; label: string };

/** 入力欄の内容。対象 (Project/Scene) はURLに持たせ、ここには入れない。 */
export type VoiceForm = {
  text: string;
  reading: string;
  /** 話者に選んだキャラ (Projectを指定したときだけ使う)。 */
  speakerId: string | null;
  /** キャラを選ばないときの話者名。 */
  speakerName: string;
  direction: string;
  mode: VoiceMode;
  caption: string;
  referenceSource: ReferenceSource;
  reference: VoiceReferenceFile | null;
  /** 採用先にするSceneの台詞の行。選んでも本文は入れない。 */
  dialogueId: string | null;
  seedMode: SeedMode;
  seed: number;
  verifyAsr: boolean;
};

/** 生成対象。どちらも任意で、Project無しでも生成できる。 */
export type VoiceTarget = { projectId: string | null; sceneId: string | null };

/** localStorageに残す入力欄と対象。 */
export type StoredVoiceInput = { form: VoiceForm | null; target: VoiceTarget | null };

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Recipeの既定値から作る初期値。「リセット」もこの値へ戻す。 */
export function defaultVoiceForm(recipe: Recipe): VoiceForm {
  const d = recipe.defaults;
  const seed = numberOr(d.seed, AUTO_SEED);
  return {
    text: "",
    reading: "",
    speakerId: null,
    speakerName: "",
    direction: "",
    mode: "caption",
    caption: "",
    referenceSource: "file",
    reference: null,
    dialogueId: null,
    seedMode: seed < 0 ? "random" : "fixed",
    seed: seed < 0 ? 0 : Math.min(seed, SEED_MAX),
    verifyAsr: typeof d.verify_with_asr === "boolean" ? d.verify_with_asr : true,
  };
}

function normalizeReference(raw: unknown): VoiceReferenceFile | null {
  if (!isRecord(raw)) return null;
  const { relativePath, sha256, label } = raw;
  if (typeof relativePath !== "string" || typeof sha256 !== "string" || relativePath === "" || sha256 === "") return null;
  return { relativePath, sha256, label: typeof label === "string" ? label : relativePath };
}

/** 保存してあった入力欄の値を`base`の上に重ねる。型の合うキーだけを使い、古い形や壊れた値で画面が落ちないようにする。 */
export function normalizeVoiceForm(raw: Record<string, unknown>, base: VoiceForm): VoiceForm {
  const str = (key: keyof VoiceForm, fallback: string) => (typeof raw[key] === "string" ? (raw[key] as string) : fallback);
  const id = (key: keyof VoiceForm) => (typeof raw[key] === "string" && raw[key] !== "" ? (raw[key] as string) : null);
  return {
    text: str("text", base.text),
    reading: str("reading", base.reading),
    speakerId: id("speakerId"),
    speakerName: str("speakerName", base.speakerName),
    direction: str("direction", base.direction),
    mode: raw.mode === "clone" || raw.mode === "caption" ? raw.mode : base.mode,
    caption: str("caption", base.caption),
    referenceSource: raw.referenceSource === "character" || raw.referenceSource === "file" ? raw.referenceSource : base.referenceSource,
    reference: normalizeReference(raw.reference),
    dialogueId: id("dialogueId"),
    seedMode: raw.seedMode === "random" || raw.seedMode === "fixed" ? raw.seedMode : base.seedMode,
    seed: Math.min(SEED_MAX, Math.max(0, Math.trunc(numberOr(raw.seed, base.seed)))),
    verifyAsr: typeof raw.verifyAsr === "boolean" ? raw.verifyAsr : base.verifyAsr,
  };
}

/** 保存してあった対象。各値は空でない文字列だけを使う。 */
export function normalizeVoiceTarget(raw: unknown): VoiceTarget | null {
  if (!isRecord(raw)) return null;
  const idOf = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);
  return { projectId: idOf(raw.projectId), sceneId: idOf(raw.sceneId) };
}

/** captionの問題。backendの`caption_problem`と同じ条件 (空白だけ・500字超・改行などの制御文字)。問題が無ければ`null`。 */
export function captionProblem(caption: string): string | null {
  if (caption.trim() === "") return "声質の文章を入れてください";
  if ([...caption].length > CAPTION_MAX) return `${CAPTION_MAX}字以内にしてください`;
  if (/\p{Cc}/u.test(caption)) return "改行などの制御文字は使えません";
  return null;
}

/** 投入に使うCloneの参照。`null`は参照が決まっていない。キャラの声は声の有無だけを見て、中身はbackendが補う。 */
export function effectiveSource(form: VoiceForm, character: StoryCharacter | null): ReferenceSource | null {
  if (form.referenceSource === "character") return character?.voice_media_key ? "character" : null;
  return form.reference ? "file" : null;
}

/** 声の指定が足りない理由。足りていれば`null`。 */
export function voiceProblem(form: VoiceForm, character: StoryCharacter | null): string | null {
  if (form.mode === "caption") return captionProblem(form.caption);
  return effectiveSource(form, character) === null ? "Cloneの参照音声を選んでください" : null;
}

/** `voices.v`。キャラの声は空のobjectで送り、`story_character_id`からbackendが参照音声を補う。 */
function voiceBinding(form: VoiceForm, character: StoryCharacter | null): Record<string, unknown> {
  if (form.mode === "caption") return { caption: form.caption };
  if (effectiveSource(form, character) === "character") return {};
  return {
    reference_relative_path: form.reference?.relativePath,
    reference_sha256: form.reference?.sha256,
  };
}

/**
 * `POST /generation-jobs`の本文。台詞は1行だけで、Shot無しなので`duration_sec`と`pad_to_duration`は送らない。
 * `reading`と`direction`は空なら`null` / 省略にする。
 */
export function buildVoiceBody(
  form: VoiceForm,
  recipe: Recipe,
  target: VoiceTarget,
  character: StoryCharacter | null,
  dialogueId: string | null,
) {
  const speaker = character ? character.name : form.speakerName.trim() || null;
  const direction = form.direction.trim();
  const inputs: Record<string, unknown> = {
    dialogue: [
      {
        speaker,
        voice_id: VOICE_ID,
        text: form.text.trim(),
        reading: form.reading.trim() === "" ? null : form.reading.trim(),
        ...(direction === "" ? {} : { direction }),
      },
    ],
    voices: { [VOICE_ID]: voiceBinding(form, character) },
  };
  if (acceptsInput(recipe, "seed")) inputs.seed = form.seedMode === "random" ? AUTO_SEED : form.seed;
  if (acceptsInput(recipe, "verify_with_asr")) inputs.verify_with_asr = form.verifyAsr;
  return {
    kind: "voice" as const,
    recipe_id: recipe.id,
    use_inherited_defaults: false,
    project_id: target.projectId,
    story_scene_id: target.sceneId,
    story_character_id: character?.id ?? null,
    story_dialogue_id: dialogueId,
    inputs,
  };
}
