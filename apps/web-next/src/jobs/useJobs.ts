import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiRequest, type GenerationJob } from "../api/client";
import type { JobProgress } from "../api/events";
import { queryKeys } from "../api/queryKeys";

export const ACTIVE_STATES = ["queued", "running", "cancelling"] as const;
const RECENT_LIMIT = 20;
/** `GET /generation-jobs`の`limit`の上限。状態ごとにこれを超える分は取れない。 */
const ACTIVE_LIMIT = 200;

export type JobBoard = {
  /** 待機中・実行中と直近に終わったJobを、新しい順に重複なく並べたもの。 */
  jobs: GenerationJob[];
  running: number;
  queued: number;
  /** どれかの状態で上限まで返った。件数は実数より少ない可能性がある。 */
  truncated: boolean;
};

function listJobs(params: Record<string, string>): Promise<GenerationJob[]> {
  return apiRequest<GenerationJob[]>(`/generation-jobs?${new URLSearchParams(params)}`);
}

/**
 * 待機中のJobは直近の件数に収まらないことがあるため、状態ごとに取ってから直近の終了分と合わせる。
 */
async function fetchJobBoard(): Promise<JobBoard> {
  const [active, recent] = await Promise.all([
    Promise.all(ACTIVE_STATES.map((state) => listJobs({ state, order: "desc", limit: String(ACTIVE_LIMIT) }))),
    listJobs({ order: "desc", limit: String(RECENT_LIMIT) }),
  ]);
  const byId = new Map<string, GenerationJob>();
  for (const job of [...active.flat(), ...recent]) byId.set(job.id, job);
  const jobs = [...byId.values()].sort((a, b) => b.queue_sequence - a.queue_sequence);
  return {
    jobs,
    running: jobs.filter((job) => job.state === "running" || job.state === "cancelling").length,
    queued: jobs.filter((job) => job.state === "queued").length,
    truncated: active.some((list) => list.length >= ACTIVE_LIMIT),
  };
}

export function useJobBoard() {
  return useQuery({ queryKey: queryKeys.jobs, queryFn: fetchJobBoard });
}

export function useJobProgress(jobId: string) {
  // 進捗はWebSocketのイベントでsetQueryDataされるだけで、取得はしない。
  return useQuery<JobProgress | null>({
    queryKey: queryKeys.jobProgress(jobId),
    queryFn: () => null,
    enabled: false,
    initialData: null,
  });
}

export function useCancelJob() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) =>
      apiRequest<GenerationJob>(`/generation-jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" }),
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.jobs }),
  });
}

export function useReplayJob() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) =>
      apiRequest<GenerationJob>(`/generation-jobs/${encodeURIComponent(jobId)}/replay`, { method: "POST" }),
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.jobs }),
  });
}

/** 結果を開くURL。Viewer (#534) が`job`を受けて該当の生成物を開く。 */
export function jobResultPath(jobId: string): string {
  return `/viewer?${new URLSearchParams({ job: jobId })}`;
}
