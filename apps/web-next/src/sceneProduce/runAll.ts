import type { QueryClient } from "@tanstack/react-query";

import {
  ApiError,
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
import { hasAllReferenceImages, isStepAdopted, STEPS, type StepId } from "./steps";

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
  /** 利用者の「中止」で止めたとき`true`。画面を閉じて止めたときは`false` (Jobは取り消さない)。 */
  cancelOnAbort: { current: boolean };
  /** 続けるが知らせたいこと (生成できないキャラ、音声を飛ばした台詞など)。 */
  notice: (text: string) => void;
};

// ---- 待機 ----

export function abortError(): Error {
  return new DOMException("aborted", "AbortError");
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** 中止されると途中で打ち切る待機。 */
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

/** Jobの状態を取れなくても待ち続ける連続回数。これを超えて続けて取れなかったら止める。 */
export const MAX_POLL_FAILURES = 3;

/** `promise`を待つ。ただし`signal`が中止されたら、結果を待たずにすぐ中止の例外にする。 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Jobが成功で終わるまで数秒おきに取り直す。失敗・取り消しは理由つきで`RunBlocked`にする。
 * 状態の取得が一時的に失敗しても、連続`MAX_POLL_FAILURES`回までは待ち続ける。全体の時間切れは設けない (動画のJobは長い)。
 */
export async function waitForJob(
  client: QueryClient,
  jobId: string,
  signal: AbortSignal,
  intervalMs: number = POLL_INTERVAL_MS,
): Promise<GenerationJob> {
  let failures = 0;
  for (;;) {
    if (signal.aborted) throw abortError();
    let job: GenerationJob;
    try {
      job = await raceAbort(
        client.fetchQuery({
          queryKey: queryKeys.job(jobId),
          queryFn: () => apiRequest<GenerationJob>(`/generation-jobs/${enc(jobId)}`),
          staleTime: 0,
        }),
        signal,
      );
      failures = 0;
    } catch (error) {
      if (signal.aborted) throw abortError();
      failures += 1;
      if (failures > MAX_POLL_FAILURES) {
        throw new RunBlocked(
          `Jobの状態を${failures}回続けて取れませんでした (${messageOf(error)})。Jobは動いている可能性があります。ヘッダーのJob一覧で確かめてください`,
        );
      }
      await sleep(intervalMs, signal);
      continue;
    }
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
  try {
    onSubmitted?.(submitted);
    const job = await waitForJob(ctx.client, submitted.id, ctx.signal);
    const artifacts = await apiRequest<ArtifactRecord[]>(`/generation-jobs/${enc(job.id)}/artifacts`);
    const artifact = pickArtifact(artifacts, artifactKind);
    if (artifact === null) throw new RunBlocked("Jobは終わりましたが、使える生成物がありません");
    return { job, artifact };
  } catch (error) {
    if (ctx.signal.aborted && ctx.cancelOnAbort.current) await cancelWaitingJob(ctx, submitted.id);
    throw error;
  }
}

/**
 * 利用者の中止で、待っているJobを取り消す。既に終わっていた (409) なら取り消すものが無いだけなので知らせない。
 * それ以外の失敗は、Jobが動き続けている可能性があるので握りつぶさず、知らせとして画面に出す。
 */
async function cancelWaitingJob(ctx: RunContext, jobId: string): Promise<void> {
  try {
    await cancelJob(jobId);
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) return;
    ctx.notice(`Jobを取り消せませんでした (${messageOf(error)})。ヘッダーのJob一覧で確かめてください。`);
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

/**
 * 実行の対象にする工程。採用済み・スキップ (参照画像がそろっている、台詞が無い) は含めない。
 * 判定は`computeStepStatus`と同じ (`hasAllReferenceImages`・`isStepAdopted`)。違いは音声だけで、台詞が無ければ対象にしない。
 * 声の参照が無い話者の行は採用できず音声が採用済みにならないが、対象には残す。`runVoice`が、その行を飛ばした旨の注記を出す。
 */
export function stepsToRun(
  scene: StoryScene,
  characters: StoryCharacter[],
  adoptions: StorySceneAdoption[],
): StepId[] {
  return STEPS.map(({ id }) => id).filter((id) => {
    if (id === "character") return !hasAllReferenceImages(scene, characters);
    // 台詞が無いシーンは全行採用の判定が成り立たず採用済みにならないため、ここで対象から外す
    if (id === "voice" && scene.dialogues.length === 0) return false;
    return !isStepAdopted(id, scene, adoptions);
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
