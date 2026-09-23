import type { GenerationTab, ImageSubTab } from "./uiState";

/** 作品制作の工程。背景 → キャラクター参照 → 音声・BGM → 動画 → 仕上げの順に進める。 */
export type PipelineStepId = "background" | "character" | "audio" | "video" | "finish";

export interface PipelineStep {
  id: PipelineStepId;
  label: string;
  /** この工程が既存の生成画面のどれに当たるか。 */
  tab: GenerationTab;
  imageSubTab?: ImageSubTab;
  /** 揃っていないときに画面へ出す文言。 */
  missing: string;
}

export const PIPELINE_STEPS: readonly PipelineStep[] = [
  {
    id: "background",
    label: "背景",
    tab: "image",
    imageSubTab: "generate",
    missing: "背景画像を生成し、採用してください",
  },
  {
    id: "character",
    label: "キャラクター参照",
    tab: "image",
    imageSubTab: "change",
    missing: "参照画像 (appearance_reference) を登録してください",
  },
  { id: "audio", label: "音声・BGM", tab: "voice", missing: "音声かBGMを生成してください" },
  { id: "video", label: "動画", tab: "video", missing: "動画を生成してください" },
  { id: "finish", label: "仕上げ", tab: "compose", missing: "合成を実行してください" },
];

const STORAGE_KEY = "mycomfyui.pipeline.v1";

function isStepId(value: unknown): value is PipelineStepId {
  return PIPELINE_STEPS.some((step) => step.id === value);
}

function readStoredMap(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** 場面ごとの現在工程を読む。未保存か壊れた値なら先頭の工程に戻す。 */
export function readPipelineStep(sceneId: string | null): PipelineStepId {
  const stored = sceneId ? readStoredMap()[sceneId] : undefined;
  return isStepId(stored) ? stored : PIPELINE_STEPS[0].id;
}

/** 他の場面の保存値を消さないよう、書き込み直前に読み直して1場面だけ差し替える。 */
export function persistPipelineStep(sceneId: string, step: PipelineStepId): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readStoredMap(), [sceneId]: step }));
  } catch {
    // 書き込めない環境でも工程の移動自体は効かせる。復元だけが効かなくなる。
  }
}
