import { useLocalStorage } from "@mantine/hooks";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { ApiError, apiRequest, type GenerationExperiment, type GenerationExperimentBody } from "../api/client";
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

const SWEEPS_KEY = "web-next:image-sweeps";

/**
 * 結果欄へスイープを足す。投入中に画面を離れると`useSweepEntries`の更新関数は呼べない
 * (unmount後のsetStateは更新関数を実行しない) ため、保存先を直接書いて同じkeyの
 * 購読者へ知らせる。
 */
function addSweepEntry(entry: SweepEntry) {
  try {
    const current = normalizeSweeps(window.localStorage.getItem(SWEEPS_KEY) ?? undefined);
    const next = [entry, ...current.filter((item) => item.experimentId !== entry.experimentId)].slice(0, SWEEPS_MAX);
    window.localStorage.setItem(SWEEPS_KEY, JSON.stringify(next));
    // @mantine/hooksのuseLocalStorageが同じタブの別インスタンスへ値を伝えるevent。
    window.dispatchEvent(new CustomEvent("mantine-local-storage", { detail: { key: SWEEPS_KEY, value: next } }));
  } catch {
    // localStorageが使えない環境では結果欄に残せない。投入自体は成功している。
  }
}

export function useSweepEntries() {
  const [entries, setEntries] = useLocalStorage<SweepEntry[]>({
    key: SWEEPS_KEY,
    defaultValue: [],
    getInitialValueInEffect: false,
    deserialize: normalizeSweeps,
  });
  const remove = useCallback(
    (experimentId: string) => setEntries((list) => list.filter((item) => item.experimentId !== experimentId)),
    [setEntries],
  );
  return { entries, remove };
}

export function useSubmitSweep() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: GenerationExperimentBody) =>
      apiRequest<GenerationExperiment>("/generation-experiments", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: (experiment) => {
      addSweepEntry({ experimentId: experiment.id });
      client.setQueryData(queryKeys.experiment(experiment.id), experiment);
      return client.invalidateQueries({ queryKey: queryKeys.jobs });
    },
  });
}

/** 取り直す間隔。Jobの状態変化はWebSocketのイベントでも知るが、切れていてもグリッドが進むようにする。 */
const ACTIVE_POLL_MS = 5_000;
/** 取り直しに失敗した後の間隔。API停止などの間も叩きすぎず、戻れば進むようにする。 */
const FAILED_POLL_MS = 15_000;

function isRunning(experiment: GenerationExperiment | undefined): boolean {
  return experiment !== undefined && (experiment.state === "pending" || experiment.state === "running");
}

export function useExperiment(experimentId: string) {
  return useQuery({
    queryKey: queryKeys.experiment(experimentId),
    queryFn: () => apiRequest<GenerationExperiment>(`/generation-experiments/${enc(experimentId)}`),
    // 実行中は取り直し続ける。実験が無い (404) ときは止め、一時的な失敗は間隔を延ばして続ける。
    refetchInterval: (query) => {
      if (query.state.error instanceof ApiError && query.state.error.status === 404) return false;
      if (!isRunning(query.state.data)) return false;
      return query.state.status === "error" ? FAILED_POLL_MS : ACTIVE_POLL_MS;
    },
  });
}
