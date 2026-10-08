import { useLocalStorage } from "@mantine/hooks";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { apiRequest, type GenerationExperiment, type GenerationExperimentBody } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { isRecord } from "./imageForm";

const enc = encodeURIComponent;

/** 結果欄に出すスイープ。実験の中身はAPIから取る。 */
export type SweepEntry = { experimentId: string };

/** 結果欄に残すスイープの数。古いものから落とす。 */
const SWEEPS_MAX = 10;

/** 保存してあったスイープの一覧。実験のidを持つ要素だけを残す。 */
function normalizeSweeps(value: string | undefined): SweepEntry[] {
  if (value === undefined) return [];
  try {
    const raw: unknown = JSON.parse(value);
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((item): item is SweepEntry => isRecord(item) && typeof item.experimentId === "string" && item.experimentId !== "")
      .slice(0, SWEEPS_MAX);
  } catch {
    return [];
  }
}

export function useSweepEntries() {
  const [entries, setEntries] = useLocalStorage<SweepEntry[]>({
    key: "web-next:image-sweeps",
    defaultValue: [],
    getInitialValueInEffect: false,
    deserialize: normalizeSweeps,
  });
  const add = useCallback(
    (entry: SweepEntry) =>
      setEntries((list) => [entry, ...list.filter((item) => item.experimentId !== entry.experimentId)].slice(0, SWEEPS_MAX)),
    [setEntries],
  );
  const remove = useCallback(
    (experimentId: string) => setEntries((list) => list.filter((item) => item.experimentId !== experimentId)),
    [setEntries],
  );
  return { entries, add, remove };
}

export function useSubmitSweep() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: GenerationExperimentBody) =>
      apiRequest<GenerationExperiment>("/generation-experiments", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: (experiment) => {
      client.setQueryData(queryKeys.experiment(experiment.id), experiment);
      return client.invalidateQueries({ queryKey: queryKeys.jobs });
    },
  });
}

/** 取り直す間隔。Jobの状態変化はWebSocketのイベントでも知るが、切れていてもグリッドが進むようにする。 */
const ACTIVE_POLL_MS = 5_000;

function isRunning(experiment: GenerationExperiment | undefined): boolean {
  return experiment !== undefined && (experiment.state === "pending" || experiment.state === "running");
}

export function useExperiment(experimentId: string) {
  return useQuery({
    queryKey: queryKeys.experiment(experimentId),
    queryFn: () => apiRequest<GenerationExperiment>(`/generation-experiments/${enc(experimentId)}`),
    // 取り直しに失敗している間は止める (404やAPI停止で回り続けないように)。
    refetchInterval: (query) =>
      query.state.status !== "error" && query.state.fetchFailureCount === 0 && isRunning(query.state.data)
        ? ACTIVE_POLL_MS
        : false,
  });
}
