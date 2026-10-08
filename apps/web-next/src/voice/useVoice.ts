import { useLocalStorage } from "@mantine/hooks";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import {
  apiRequest,
  artifactContentUrl,
  type ArtifactRecord,
  type GenerationJob,
  type GenerationJobBody,
  type Recipe,
  type VoiceVerification,
} from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { isRecord } from "../imageGen/imageForm";
import { useSlotDecision } from "../imageGen/useImageGen";
import { useUploadVoiceReference } from "../projectDetail/useStory";
import {
  defaultVoiceForm,
  normalizeVoiceForm,
  normalizeVoiceTarget,
  type StoredVoiceInput,
  type VoiceReferenceFile,
} from "./voiceForm";

const enc = encodeURIComponent;

// ---- 入力欄と結果欄の保存 ----

/**
 * 結果欄に出すJob。1本のJobから1つの音声ができる。`text`は結果欄に添える台詞文。
 * `line`はSceneの台詞の行を採用先にしたときの行の見出し (例: `3行目 ヒカリ`)。
 */
export type VoiceResultEntry = { jobId: string; text: string; line: string | null };

/** 結果欄に残すJobの数。古いものから落とす。 */
const RESULTS_MAX = 30;

/** 結果欄に添える台詞文の長さの上限。 */
const TEXT_PREVIEW_MAX = 80;

/** localStorageの文字列をJSONとして読む。読めなければ`undefined`。 */
function parseStored(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** 最後に使った入力欄と対象をブラウザに残し、画面を離れて戻っても続きから書けるようにする。 */
export function useStoredVoiceInput(recipe: Recipe) {
  return useLocalStorage<StoredVoiceInput>({
    key: "web-next:voice-input",
    defaultValue: { form: null, target: null },
    // 初回の描画から保存済みの値を使う。既定値で描いてから差し替えると、対象の復元が既定値で上書きされる。
    getInitialValueInEffect: false,
    // 壊れた値・`null`・古い形の値でも画面が開けるよう、型の合う値だけを読む。
    deserialize: (value) => {
      const raw = parseStored(value);
      if (!isRecord(raw)) return { form: null, target: null };
      return {
        form: isRecord(raw.form) ? normalizeVoiceForm(raw.form, defaultVoiceForm(recipe)) : null,
        target: normalizeVoiceTarget(raw.target),
      };
    },
  });
}

export function useVoiceResultEntries() {
  const [entries, setEntries] = useLocalStorage<VoiceResultEntry[]>({
    key: "web-next:voice-results",
    defaultValue: [],
    getInitialValueInEffect: false,
    deserialize: (value) => {
      const raw = parseStored(value);
      if (!Array.isArray(raw)) return [];
      return raw
        .filter((item): item is Record<string, unknown> => isRecord(item) && typeof item.jobId === "string")
        .map((item) => ({
          jobId: String(item.jobId),
          text: typeof item.text === "string" ? item.text : "",
          line: typeof item.line === "string" ? item.line : null,
        }))
        .slice(0, RESULTS_MAX);
    },
  });
  const add = useCallback(
    (entry: VoiceResultEntry) =>
      setEntries((list) =>
        [{ ...entry, text: entry.text.slice(0, TEXT_PREVIEW_MAX) }, ...list.filter((item) => item.jobId !== entry.jobId)].slice(
          0,
          RESULTS_MAX,
        ),
      ),
    [setEntries],
  );
  const remove = useCallback(
    (jobId: string) => setEntries((list) => list.filter((item) => item.jobId !== jobId)),
    [setEntries],
  );
  return { entries, add, remove };
}

// ---- Recipe ----

/** 音声生成のRecipe。`kind=voice`のうち先頭を使う。 */
export function useVoiceRecipe() {
  return useQuery({
    queryKey: queryKeys.recipes("voice"),
    queryFn: () => apiRequest<Recipe[]>("/recipes?kind=voice"),
    select: (recipes) => recipes[0] ?? null,
  });
}

// ---- 投入と結果 ----

/** 音声Jobを1本投入する。投入できたら`onSubmitted`へ渡す。 */
export function useSubmitVoiceJob() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({
      body,
      onSubmitted,
    }: {
      body: GenerationJobBody;
      onSubmitted: (job: GenerationJob) => void;
    }) => {
      const job = await apiRequest<GenerationJob>("/generation-jobs", { method: "POST", body: JSON.stringify(body) });
      client.setQueryData(queryKeys.job(job.id), job);
      onSubmitted(job);
    },
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.jobs }),
  });
}

/** Jobの音声の生成物。ゴミ箱のものは除く。Jobの状態が変わるイベントで取り直される。 */
export function useJobAudio(jobId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.jobAudio(jobId),
    queryFn: () => apiRequest<ArtifactRecord[]>(`/generation-jobs/${enc(jobId)}/artifacts`),
    select: (items) => items.filter((item) => item.kind === "audio" && item.deleted_at === null),
    enabled,
  });
}

/** Jobの台詞ごとの読み検証 (ASR)。 */
export function useVoiceVerifications(jobId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.jobVoiceVerifications(jobId),
    queryFn: () => apiRequest<VoiceVerification[]>(`/generation-jobs/${enc(jobId)}/voice-verifications`),
    enabled,
  });
}

// ---- 参照音声 ----

/** 参照音声の表示名。ファイル名と尺。 */
export function referenceLabel(name: string, durationSec: number): string {
  return `${name} (${durationSec.toFixed(1)}秒)`;
}

/** ファイルを参照音声として取り込む。 */
export function useImportVoiceReference() {
  const upload = useUploadVoiceReference();
  return {
    isPending: upload.isPending,
    importFile: (file: File, onDone: (reference: VoiceReferenceFile) => void, onError: (error: Error) => void) =>
      upload.mutate(file, {
        onSuccess: (reference) =>
          onDone({
            relativePath: reference.relative_path,
            sha256: reference.sha256,
            label: referenceLabel(file.name, reference.duration_sec),
          }),
        onError,
      }),
  };
}

/** 生成物の音声ファイルを取得して、参照音声として取り込む。新しいAPIは使わず、アップロードと同じ`/voice-references`へ送る。 */
export function useArtifactAsVoiceReference() {
  const upload = useUploadVoiceReference();
  return useMutation({
    mutationFn: async (artifact: ArtifactRecord): Promise<VoiceReferenceFile> => {
      const response = await fetch(artifactContentUrl(artifact.id));
      if (!response.ok) throw new Error(`生成物を取得できませんでした (${response.status})`);
      const name = `voice-${artifact.id}.wav`;
      const file = new File([await response.blob()], name, { type: "audio/wav" });
      const reference = await upload.mutateAsync(file);
      return {
        relativePath: reference.relative_path,
        sha256: reference.sha256,
        label: referenceLabel(name, reference.duration_sec),
      };
    },
  });
}

// ---- 結果のカードの操作 ----

/** Sceneの台詞の行 (`dialogueId`) の音声枠への採用と、不採用の印。枠は台詞ごとに1件。 */
export function useVoiceDecision(projectId: string, sceneId: string, dialogueId: string | null) {
  return useSlotDecision(projectId, sceneId, "voice", dialogueId);
}
