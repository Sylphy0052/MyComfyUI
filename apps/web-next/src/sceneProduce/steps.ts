import type {
  GenerationJob,
  MediaItem,
  StoryCharacter,
  StoryScene,
  StorySceneAdoption,
} from "../api/client";

/** シーン生成の工程。左のステッパーの並び順。 */
export const STEPS = [
  { id: "character", label: "キャラ画像" },
  { id: "scene_image", label: "シーン画像" },
  { id: "voice", label: "音声" },
  { id: "bgm", label: "BGM" },
  { id: "video", label: "動画" },
  { id: "compose", label: "統合" },
] as const;

export type StepId = (typeof STEPS)[number]["id"];

export function stepLabel(id: StepId): string {
  return STEPS.find((step) => step.id === id)?.label ?? id;
}

/** `?step=`を読む。読めない値と未指定は先頭の工程にする。 */
export function readStep(value: string | null): StepId {
  return STEPS.find((step) => step.id === value)?.id ?? STEPS[0].id;
}

/**
 * `skipped`はキャラ画像だけが使う。登場キャラ×衣装の参照画像がそろっていて、生成しなくてよいとき。
 * `failed`は状態の材料を取れなかったとき。空として計算すると「未着手」に見えるため分ける。
 */
export type StepStatusKey = "adopted" | "running" | "candidate" | "skipped" | "todo" | "failed";

export const STATUS_LABELS: Record<StepStatusKey, string> = {
  adopted: "採用済み",
  running: "生成中",
  candidate: "候補あり",
  skipped: "スキップ",
  todo: "未着手",
  failed: "取得失敗",
};

export const STATUS_COLORS: Record<StepStatusKey, string> = {
  adopted: "green",
  running: "blue",
  candidate: "yellow",
  skipped: "gray",
  todo: "gray",
  failed: "red",
};

export const FAILED_STATUS: StepStatus = { key: "failed", detail: null };

export type StepStatus = {
  key: StepStatusKey;
  /** 音声で一部の台詞だけ採用済みのときの「n/m行」。 */
  detail: string | null;
};

/** 状態を求める材料。取得できていないものは空として扱う。 */
export type StepInputs = {
  scene: StoryScene;
  characters: StoryCharacter[];
  adoptions: StorySceneAdoption[];
  /** 待機中・実行中のJob。 */
  activeJobs: GenerationJob[];
  /** シーンに紐づく生成物 (画像・動画・音声)。 */
  sceneMedia: MediaItem[];
  /** 統合Jobが出した動画の生成物ID。`video`と`compose`の動画を見分ける。 */
  composeArtifactIds: ReadonlySet<string>;
  /** 登場キャラに紐づく未判定の画像。キャラ画像の候補を探す。 */
  characterMedia: MediaItem[];
};

/** 工程の採用枠。キャラ画像は枠を持たない。 */
const SLOT_OF: Partial<Record<StepId, StorySceneAdoption["slot"]>> = {
  scene_image: "scene_image",
  voice: "voice",
  bgm: "bgm",
  video: "video",
  compose: "compose",
};

/** 工程ごとの生成Jobの種別 (`GenerationKind`)。 */
const JOB_KIND_OF: Record<Exclude<StepId, "character">, GenerationJob["kind"]> = {
  scene_image: "image",
  voice: "voice",
  bgm: "music",
  video: "video",
  compose: "compose",
};

/** 登場キャラ×衣装のすべてに参照画像があるか。衣装の指定が無い登場は、キャラの肖像を参照画像とみなす。 */
export function hasAllReferenceImages(scene: StoryScene, characters: StoryCharacter[]): boolean {
  return scene.cast.every((entry) => {
    const character = characters.find((item) => item.id === entry.character_id);
    if (!character) return false;
    if (entry.costume_id === null || entry.costume_id === undefined) return character.portrait_media_key !== null;
    const costume = character.costumes.find((item) => item.id === entry.costume_id);
    return (costume?.reference_images.length ?? 0) > 0;
  });
}

/** 採用済みの台詞の行ID (このシーンの行だけ)。 */
export function adoptedVoiceLineIds(scene: StoryScene, adoptions: StorySceneAdoption[]): Set<string> {
  const lineIds = new Set(scene.dialogues.map((dialogue) => dialogue.id));
  const adopted = new Set<string>();
  for (const adoption of adoptions) {
    if (adoption.slot === "voice" && adoption.dialogue_id && lineIds.has(adoption.dialogue_id)) {
      adopted.add(adoption.dialogue_id);
    }
  }
  return adopted;
}

/**
 * キャラ画像以外の工程が採用済みか。`computeStepStatus`と、一括実行が実行対象を選ぶ`stepsToRun`の共通の判定。
 * 音声は全行が採用済みのときだけ。台詞が0行なら採用済みにならない。
 */
export function isStepAdopted(
  step: Exclude<StepId, "character">,
  scene: StoryScene,
  adoptions: StorySceneAdoption[],
): boolean {
  if (step === "voice") {
    const lineCount = new Set(scene.dialogues.map((dialogue) => dialogue.id)).size;
    return lineCount > 0 && adoptedVoiceLineIds(scene, adoptions).size >= lineCount;
  }
  return adoptions.some((adoption) => adoption.slot === SLOT_OF[step]);
}

function isCandidateOf(step: Exclude<StepId, "character">, item: MediaItem, composeIds: ReadonlySet<string>): boolean {
  const isCompose = item.artifact_id !== null && item.artifact_id !== undefined && composeIds.has(item.artifact_id);
  switch (step) {
    case "scene_image":
      return item.kind === "image";
    case "voice":
      return item.kind === "audio" && item.audio_class === "voice";
    case "bgm":
      return item.kind === "audio" && item.audio_class === "bgm";
    case "video":
      return item.kind === "video" && !isCompose;
    case "compose":
      return item.kind === "video" && isCompose;
  }
}

/** 工程の状態。優先は 採用済み > 生成中 > 候補あり > スキップ > 未着手。 */
export function computeStepStatus(step: StepId, inputs: StepInputs): StepStatus {
  const { scene, adoptions, activeJobs, sceneMedia } = inputs;
  if (step === "character") {
    const castIds = new Set(scene.cast.map((entry) => entry.character_id));
    const running = activeJobs.some(
      (job) =>
        job.kind === "image" && !job.story_scene_id && job.story_character_id && castIds.has(job.story_character_id),
    );
    if (running) return { key: "running", detail: null };
    const complete = hasAllReferenceImages(scene, inputs.characters);
    // 参照画像がそろえば、参照に使った候補が残っていても候補としては数えない。
    const hasCandidate =
      !complete &&
      inputs.characterMedia.some(
        (item) => !item.story_scene_id && item.story_character_id && castIds.has(item.story_character_id),
      );
    if (hasCandidate) return { key: "candidate", detail: null };
    return { key: complete ? "skipped" : "todo", detail: null };
  }

  if (isStepAdopted(step, scene, adoptions)) return { key: "adopted", detail: null };
  let detail: string | null = null;
  if (step === "voice") {
    const adopted = adoptedVoiceLineIds(scene, adoptions);
    if (adopted.size > 0) detail = `${adopted.size}/${new Set(scene.dialogues.map((dialogue) => dialogue.id)).size}行`;
  }

  const kind = JOB_KIND_OF[step];
  if (activeJobs.some((job) => job.kind === kind && job.story_scene_id === scene.id)) return { key: "running", detail };
  const adoptedArtifactIds = new Set(adoptions.map((adoption) => adoption.artifact_id));
  const hasCandidate = sceneMedia.some(
    (item) =>
      item.decision !== "rejected" &&
      !(item.artifact_id && adoptedArtifactIds.has(item.artifact_id)) &&
      isCandidateOf(step, item, inputs.composeArtifactIds),
  );
  return { key: hasCandidate ? "candidate" : "todo", detail };
}
