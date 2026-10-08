import { useLocalStorage } from "@mantine/hooks";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import {
  apiRequest,
  type ArtifactRecord,
  type GenerationJobFollowup,
  type MediaItem,
  type PromptOnlyVideoJob,
  type PromptOnlyVideoJobBody,
  type Recipe,
} from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { fetchJobSettings } from "../imageGen/artifactRestore";
import { isRecord, normalizeTarget, type ImageTarget } from "../imageGen/imageForm";
import {
  defaultDraft,
  normalizeDraft,
  VIDEO_TEMPLATES,
  type VideoDraft,
  type VideoMode,
  type VideoRecipes,
  type VideoRestored,
  videoRestoredFromManifest,
} from "./videoForm";

const enc = encodeURIComponent;

// ---- 入力欄と結果欄の保存 ----

/** 入力欄の内容と対象。最後に使った値をブラウザに残し、画面を離れて戻っても続きから書ける。 */
export type StoredVideoInput = { draft: VideoDraft; target: ImageTarget | null };

/** 結果欄に出すJob。「プロンプトだけ」は1段目のJobと、2段目の予約 (`followupId`) を持つ。 */
export type VideoResultEntry = { jobId: string; followupId?: string };

/** 結果欄に残すJobの数。古いものから落とす。 */
export const RESULTS_MAX = 30;

/** localStorageの文字列をJSONとして読む。読めなければ`undefined`。 */
function parseStored(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** `/video`が入力欄を残すlocalStorageのキー。 */
export const VIDEO_INPUT_KEY = "web-next:video-input";
/** `/video`が結果欄を残すlocalStorageのキー。 */
export const VIDEO_RESULTS_KEY = "web-next:video-results";

export function useStoredVideoInput(recipes: VideoRecipes, key = VIDEO_INPUT_KEY) {
  return useLocalStorage<StoredVideoInput>({
    key,
    defaultValue: { draft: defaultDraft(recipes), target: null },
    // 初回の描画から保存済みの値を使う。既定値で描いてから差し替えると、対象の復元が既定値で上書きされる。
    getInitialValueInEffect: false,
    deserialize: (value) => {
      const raw = parseStored(value);
      const base = defaultDraft(recipes);
      if (!isRecord(raw)) return { draft: base, target: null };
      return {
        draft: isRecord(raw.draft) ? normalizeDraft(raw.draft, base) : base,
        target: normalizeTarget(raw.target),
      };
    },
  });
}

export function useVideoResultEntries(key = VIDEO_RESULTS_KEY) {
  const [entries, setEntries] = useLocalStorage<VideoResultEntry[]>({
    key,
    defaultValue: [],
    getInitialValueInEffect: false,
    deserialize: (value) => {
      const raw = parseStored(value);
      if (!Array.isArray(raw)) return [];
      return raw
        .filter((item): item is VideoResultEntry => isRecord(item) && typeof item.jobId === "string")
        .map((item) =>
          typeof item.followupId === "string" ? { jobId: item.jobId, followupId: item.followupId } : { jobId: item.jobId },
        )
        .slice(0, RESULTS_MAX);
    },
  });
  const add = useCallback(
    (entry: VideoResultEntry) =>
      setEntries((list) => [entry, ...list.filter((item) => item.jobId !== entry.jobId)].slice(0, RESULTS_MAX)),
    [setEntries],
  );
  const remove = useCallback(
    (jobId: string) => setEntries((list) => list.filter((item) => item.jobId !== jobId)),
    [setEntries],
  );
  return { entries, add, remove };
}

// ---- Recipe ----

/** 動画のRecipe。方式のテンプレートごとに、最新の版の先頭を使う。 */
export function useVideoRecipes() {
  return useQuery({
    queryKey: queryKeys.recipes("video"),
    queryFn: () => apiRequest<Recipe[]>("/recipes?kind=video"),
    select: (recipes): VideoRecipes => {
      const find = (mode: VideoMode) =>
        recipes.find((recipe) => recipe.workflow_template_ref.name === VIDEO_TEMPLATES[mode]) ?? null;
      return { i2v: find("i2v"), ref2v: find("ref2v"), prompt: find("prompt") };
    },
  });
}

// ---- 結果 ----

/** Jobの動画の生成物。ゴミ箱のものは除く。 */
export function useJobVideos(jobId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.jobVideos(jobId),
    queryFn: () => apiRequest<ArtifactRecord[]>(`/generation-jobs/${enc(jobId)}/artifacts`),
    select: (items) => items.filter((item) => item.kind === "video" && item.deleted_at === null),
    enabled,
  });
}

// ---- プロンプトだけ (画像 -> i2v の2段) ----

/** 画像Jobの投入と、2段目の予約。投入後にJob一覧を取り直す。 */
export function useSubmitPromptOnlyVideo() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: PromptOnlyVideoJobBody) =>
      apiRequest<PromptOnlyVideoJob>("/prompt-only-video-jobs", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: (result) => {
      client.setQueryData(queryKeys.job(result.image_job.id), result.image_job);
      client.setQueryData(queryKeys.followup(result.followup.id), result.followup);
      return client.invalidateQueries({ queryKey: queryKeys.jobs });
    },
  });
}

/** 予約を取り直す間隔。 */
const FOLLOWUP_POLL_MS = 2_000;

/**
 * 2段目の予約。投入待ちの間は取り直す。投入のcommitと`child_job_id`の記録は別なので、
 * `submitted`でも`child_job_id`が付くまでは取り直す。取り直しが1回失敗しても、直前の
 * dataがまだ待機中なら間隔を保って再取得する (止めると待機中の表示のまま固まる)。
 */
export function useFollowup(followupId: string) {
  return useQuery({
    queryKey: queryKeys.followup(followupId),
    queryFn: () => apiRequest<GenerationJobFollowup>(`/generation-job-followups/${enc(followupId)}`),
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data === undefined) return false;
      const settling = data.state === "pending" || (data.state === "submitted" && !data.child_job_id);
      return settling ? FOLLOWUP_POLL_MS : false;
    },
  });
}

// ---- 台詞音声 (guide_audio) ----

const VOICE_AUDIO_LIMIT = 24;

/** guide_audioに選べる最近の台詞音声 (BGMは含めない)。入力cacheも同じ一覧で返るので、生成物 (Artifact) だけを出す。 */
export function useRecentVoiceAudio(enabled: boolean) {
  const query = new URLSearchParams({ kind: "audio", audio_class: "voice", limit: String(VOICE_AUDIO_LIMIT) });
  return useQuery({
    queryKey: queryKeys.voiceAudio(query.toString()),
    queryFn: () => apiRequest<MediaItem[]>(`/media-items?${query}`),
    select: (items) => items.filter((item) => item.source === "generated" && item.artifact_id),
    enabled,
  });
}

// ---- 生成物からの復元 ----

/** `/video?from_artifact=`で開いたとき、生成物を作った動画Jobの設定を入力欄の内容にする。 */
export async function restoreVideoFromJob(client: QueryClient, jobId: string, recipes: VideoRecipes): Promise<VideoRestored> {
  const { job, manifest } = await fetchJobSettings(client, jobId, "video", "動画");
  return videoRestoredFromManifest(defaultDraft(recipes), job, manifest, recipes);
}
