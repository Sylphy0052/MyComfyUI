import type { GenerationJobBody, StoryScene, StorySceneAdoption } from "../api/client";

/** 台詞の音声の上限 (`adapters/compose/plan.py`の`MAX_VOICE_TRACKS`)。超えた行は投入に含めない。 */
export const MAX_VOICE_TRACKS = 16;
/** `start_sec`の範囲。 */
export const MAX_START_SEC = 3600;
/** 音量の上限 (`MAX_VOLUME`)。 */
export const MAX_VOLUME = 4;
/** 音量の既定値 (`DEFAULT_VOICE_VOLUME`・`DEFAULT_BGM_VOLUME`)。 */
export const DEFAULT_VOICE_VOLUME = 1;
export const DEFAULT_BGM_VOLUME = 0.33;
/** 尺の比較の許容誤差 (`executor.py`の`DURATION_TOLERANCE_SEC`)。フレーム境界の丸めは超過にしない。 */
export const DURATION_TOLERANCE_SEC = 0.05;

/** 尺の読み込み状態。`<video>`と`<audio>`の`loadedmetadata`で決まる。 */
export type Duration = { state: "loading" } | { state: "error" } | { state: "ready"; seconds: number };

/** 統合に載せる台詞の1行。採用した音声がある台詞だけ。 */
export type VoiceRow = {
  dialogueId: string;
  /** 台詞の表示用の番号 (1始まり、採用の無い行も数えた台詞の順)。 */
  lineNo: number;
  text: string;
  artifactId: string;
};

/** 台詞の音声の行。台詞の順に、採用済みの音声を持つものだけ。 */
export function voiceRowsOf(scene: StoryScene, adoptions: StorySceneAdoption[]): VoiceRow[] {
  const byDialogue = new Map<string, string>();
  for (const adoption of adoptions) {
    if (adoption.slot === "voice" && adoption.dialogue_id) byDialogue.set(adoption.dialogue_id, adoption.artifact_id);
  }
  const rows: VoiceRow[] = [];
  scene.dialogues.forEach((dialogue, index) => {
    const artifactId = byDialogue.get(dialogue.id);
    if (artifactId) rows.push({ dialogueId: dialogue.id, lineNo: index + 1, text: dialogue.text, artifactId });
  });
  return rows;
}

/**
 * 前から順に詰めた`start_sec`の初期値。先頭は0、次の行は前の行の終わり。
 * 前の行の尺がまだ読めていない行は`null` (読めるまで決まらない)。
 */
export function packedStarts(durations: (number | null)[]): (number | null)[] {
  let cursor: number | null = 0;
  return durations.map((seconds) => {
    const start = cursor === null ? null : roundSec(cursor);
    cursor = start === null || seconds === null ? null : start + seconds;
    return start;
  });
}

/** ミリ秒で丸める。丸め誤差は許容誤差の十分内側。 */
export function roundSec(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** 入力欄の文字列を、範囲内の有限な数値にする。範囲外・空・数値でないものは`null`。 */
export function parseBounded(value: string, min: number, max: number): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

/** 台詞の音声が動画の尺を超えるか。`executor.py`と同じ許容誤差で判定する。 */
export function exceedsVideo(startSec: number, voiceSeconds: number, videoSeconds: number): boolean {
  return startSec + voiceSeconds > videoSeconds + DURATION_TOLERANCE_SEC;
}

export type ComposeVoiceInput = { artifact_id: string; start_sec: number; volume: number };

/** `POST /generation-jobs`の`inputs` (`adapters/compose/plan.py`の入力)。 */
export function buildComposeInputs(args: {
  videoArtifactId: string;
  voices: ComposeVoiceInput[];
  bgm: { artifactId: string; volume: number } | null;
}): Record<string, unknown> {
  const inputs: Record<string, unknown> = { video: { artifact_id: args.videoArtifactId }, voices: args.voices };
  if (args.bgm) inputs.bgm = { artifact_id: args.bgm.artifactId, volume: args.bgm.volume };
  return inputs;
}

export function composeJobBody(args: {
  recipeId: string;
  projectId: string;
  sceneId: string;
  inputs: Record<string, unknown>;
}): GenerationJobBody {
  return {
    kind: "compose",
    recipe_id: args.recipeId,
    use_inherited_defaults: false,
    project_id: args.projectId,
    story_scene_id: args.sceneId,
    inputs: args.inputs,
  };
}
