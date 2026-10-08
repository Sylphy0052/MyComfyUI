import type { QueryClient } from "@tanstack/react-query";

import {
  apiRequest,
  type ArtifactRecord,
  type GenerationJob,
  type GenerationJobBody,
  type Recipe,
  type StoryCharacter,
  type StoryScene,
  type StorySceneAdoption,
} from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { cancelJob } from "../jobs/useJobs";
import { DURATION_LOAD_TIMEOUT_MS } from "./composeForm";
import { hasAllReferenceImages, STEPS, type StepId } from "./steps";
import { lineSkipOf } from "../voice/SceneLineList";

// 「残りを一括実行」の土台。画面がJobの終了を待ち、次の工程を投入する。工程ごとの中身は`runAllSteps.ts`。

const enc = encodeURIComponent;

/** Jobの状態を取り直す間隔。 */
export const POLL_INTERVAL_MS = 2000;

/** 一括実行の1工程の進み具合。 */
export type RunStepState = "pending" | "running" | "done" | "skipped" | "failed";

export const RUN_STATE_LABELS: Record<RunStepState, string> = {
  pending: "待機",
  running: "実行中",
  done: "完了",
  skipped: "スキップ",
  failed: "失敗",
};

/** 工程を続けられない理由。`message`をそのまま画面に出す。 */
export class RunBlocked extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunBlocked";
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 工程の実行に要るもの。 */
export type RunContext = {
  client: QueryClient;
  projectId: string;
  scene: StoryScene;
  signal: AbortSignal;
  /** 投入して、まだ終わっていないJobのID。中止のときに取り消す。 */
  jobs: Set<string>;
  /** 利用者の「中止」で止めたとき`true`。画面を閉じて止めたときは`false` (Jobは取り消さない)。 */
  cancelOnAbort: { current: boolean };
  /** 続けるが知らせたいこと (生成できないキャラ、音声を飛ばした台詞など)。 */
  notice: (text: string) => void;
};

// ---- 待機 ----

function abortError(): Error {
  return new DOMException("aborted", "AbortError");
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** 中止で途中で起きる待機。 */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Jobが成功で終わるまで数秒おきに取り直す。失敗・取り消しは理由つきで`RunBlocked`にする。 */
export async function waitForJob(
  client: QueryClient,
  jobId: string,
  signal: AbortSignal,
  intervalMs: number = POLL_INTERVAL_MS,
): Promise<GenerationJob> {
  for (;;) {
    if (signal.aborted) throw abortError();
    const job = await client.fetchQuery({
      queryKey: queryKeys.job(jobId),
      queryFn: () => apiRequest<GenerationJob>(`/generation-jobs/${enc(jobId)}`),
      staleTime: 0,
    });
    if (job.state === "succeeded") return job;
    if (job.state === "failed") throw new RunBlocked(job.failure_message ?? "Jobが失敗しました");
    if (job.state === "cancelled") throw new RunBlocked("Jobが取り消されました");
    await sleep(intervalMs, signal);
  }
}

/** Jobの生成物のうち、種別が合い、ゴミ箱に入っていない最初のもの。 */
export function pickArtifact(artifacts: readonly ArtifactRecord[], kind: string): ArtifactRecord | null {
  return artifacts.find((artifact) => artifact.kind === kind && artifact.deleted_at === null) ?? null;
}

/**
 * Jobを投入して終わるまで待ち、最初の候補の生成物を返す。
 * 待っている間に中止されたら、利用者の中止のときだけJobを取り消す。
 */
export async function submitAndWait(
  ctx: RunContext,
  body: GenerationJobBody,
  artifactKind: string,
  onSubmitted?: (job: GenerationJob) => void,
): Promise<{ job: GenerationJob; artifact: ArtifactRecord }> {
  if (ctx.signal.aborted) throw abortError();
  const submitted = await apiRequest<GenerationJob>("/generation-jobs", { method: "POST", body: JSON.stringify(body) });
  ctx.client.setQueryData(queryKeys.job(submitted.id), submitted);
  void ctx.client.invalidateQueries({ queryKey: queryKeys.jobs });
  ctx.jobs.add(submitted.id);
  onSubmitted?.(submitted);
  try {
    const job = await waitForJob(ctx.client, submitted.id, ctx.signal);
    const artifacts = await apiRequest<ArtifactRecord[]>(`/generation-jobs/${enc(job.id)}/artifacts`);
    const artifact = pickArtifact(artifacts, artifactKind);
    if (artifact === null) throw new RunBlocked("Jobは終わりましたが、使える生成物がありません");
    return { job, artifact };
  } catch (error) {
    if (ctx.signal.aborted && ctx.cancelOnAbort.current) await cancelJob(submitted.id).catch(() => undefined);
    throw error;
  } finally {
    ctx.jobs.delete(submitted.id);
  }
}

// ---- 尺 ----

/**
 * 音声・動画の尺 (秒)。DOMに足さない`HTMLMediaElement`の`loadedmetadata`で読む。
 * 読めない・時間切れ・中止は例外にする。
 */
export function loadDuration(
  url: string,
  signal: AbortSignal,
  kind: "audio" | "video" = "audio",
  timeoutMs: number = DURATION_LOAD_TIMEOUT_MS,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const media = document.createElement(kind);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      media.removeAttribute("src");
      media.load();
      settle();
    };
    const onAbort = () => finish(() => reject(abortError()));
    signal.addEventListener("abort", onAbort, { once: true });
    media.preload = "metadata";
    media.onloadedmetadata = () => {
      // `finish`は`src`を外して読み込みを捨てるので、尺はその前に読む。
      const seconds = media.duration;
      finish(() =>
        Number.isFinite(seconds) && seconds > 0 ? resolve(seconds) : reject(new Error("尺が0秒または不明です")),
      );
    };
    media.onerror = () => finish(() => reject(new Error("読み込めません")));
    timer = setTimeout(() => finish(() => reject(new Error("読み込みが時間切れになりました"))), timeoutMs);
    media.src = url;
  });
}

// ---- 取得 ----

export async function fetchCharacters(client: QueryClient, projectId: string): Promise<StoryCharacter[]> {
  return client.fetchQuery({
    queryKey: queryKeys.projectCharacters(projectId),
    queryFn: () => apiRequest<StoryCharacter[]>(`/projects/${enc(projectId)}/characters`),
    staleTime: 0,
  });
}

export async function fetchAdoptions(
  client: QueryClient,
  projectId: string,
  sceneId: string,
): Promise<StorySceneAdoption[]> {
  return client.fetchQuery({
    queryKey: queryKeys.sceneAdoptions(projectId, sceneId),
    queryFn: () =>
      apiRequest<StorySceneAdoption[]>(`/projects/${enc(projectId)}/story-scenes/${enc(sceneId)}/adoptions`),
    staleTime: 0,
  });
}

/** `kind`のRecipeのうち`pick`が選ぶもの。無ければ`RunBlocked`。 */
export async function fetchRecipe(
  client: QueryClient,
  kind: string,
  label: string,
  pick: (recipes: Recipe[]) => Recipe | undefined,
): Promise<Recipe> {
  const recipes = await client.fetchQuery({
    queryKey: queryKeys.recipes(kind),
    queryFn: () => apiRequest<Recipe[]>(`/recipes?kind=${enc(kind)}`),
  });
  const recipe = pick(recipes);
  if (!recipe) throw new RunBlocked(`${label}のRecipeがありません`);
  return recipe;
}

// ---- 実行する工程の選び方 ----

/** 音声で、まだ採用が無く、投入できる台詞の行。 */
export function voiceTodoOf(
  scene: StoryScene,
  characters: StoryCharacter[],
  adoptions: StorySceneAdoption[],
): StoryScene["dialogues"] {
  return scene.dialogues.filter(
    (line) =>
      lineSkipOf(characters, line) === null &&
      !adoptions.some((item) => item.slot === "voice" && item.dialogue_id === line.id),
  );
}

/**
 * 実行の対象にする工程。採用済み・スキップ (参照画像がそろっている、台詞が無い、投入できる行が残っていない) は含めない。
 * `computeStepStatus`の「採用済み」「スキップ」と同じ判定だが、音声は投入できない行があっても完了とみなす。
 */
export function stepsToRun(
  scene: StoryScene,
  characters: StoryCharacter[],
  adoptions: StorySceneAdoption[],
): StepId[] {
  return STEPS.map(({ id }) => id).filter((id) => {
    if (id === "character") return !hasAllReferenceImages(scene, characters);
    if (id === "voice") return voiceTodoOf(scene, characters, adoptions).length > 0;
    return !adoptions.some((item) => item.slot === id);
  });
}

/** 画面に出す工程の初期状態。実行しない工程はスキップ、する工程は待機。 */
export function initialRunStates(
  scene: StoryScene,
  characters: StoryCharacter[],
  adoptions: StorySceneAdoption[],
): Record<StepId, RunStepState> {
  const todo = new Set(stepsToRun(scene, characters, adoptions));
  const states = {} as Record<StepId, RunStepState>;
  for (const { id } of STEPS) states[id] = todo.has(id) ? "pending" : "skipped";
  return states;
}
