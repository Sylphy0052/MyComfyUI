import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import type { StoryScene } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import {
  fetchAdoptions,
  fetchCharacters,
  initialRunStates,
  isAbortError,
  messageOf,
  type RunContext,
  type RunStepState,
  stepsToRun,
} from "./runAll";
import { executeStep } from "./runAllSteps";
import { stepLabel, type StepId } from "./steps";

/** 一括実行の全体の段階。`idle`は未実行 (実行した結果は`completed`・`failed`・`aborted`で残す)。 */
export type RunPhase = "idle" | "running" | "completed" | "failed" | "aborted";

export type RunAllState = {
  phase: RunPhase;
  /** 実行中の工程。 */
  current: StepId | null;
  steps: Record<StepId, RunStepState> | null;
  /** 止まった工程と、その理由。 */
  failedStep: StepId | null;
  message: string | null;
  /** 続けたが知らせたいこと。 */
  notices: string[];
};

const IDLE: RunAllState = { phase: "idle", current: null, steps: null, failedStep: null, message: null, notices: [] };

/**
 * 「残りを一括実行」。画面がJobの終了を待って次の工程を投入するので、画面を閉じると止まる (Jobは取り消さない)。
 * 開き直したときは、採用済みの工程を飛ばして残りから実行する。実行の状態は保存しない。
 */
export function useRunAll(projectId: string, scene: StoryScene) {
  const client = useQueryClient();
  const [state, setState] = useState<RunAllState>(IDLE);
  const controller = useRef<AbortController | null>(null);
  const cancelOnAbort = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // 画面を閉じて止めるだけ。待っているJobは取り消さない。
      controller.current?.abort();
    };
  }, []);

  const update = useCallback((patch: (current: RunAllState) => RunAllState) => {
    if (mounted.current) setState(patch);
  }, []);

  const setStep = useCallback(
    (id: StepId, value: RunStepState, extra: Partial<RunAllState> = {}) =>
      update((current) =>
        current.steps ? { ...current, ...extra, steps: { ...current.steps, [id]: value } } : current,
      ),
    [update],
  );

  const refresh = useCallback(
    () =>
      Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.sceneAdoptions(projectId, scene.id) }),
        client.invalidateQueries({ queryKey: queryKeys.projectCharacters(projectId) }),
        client.invalidateQueries({ queryKey: queryKeys.jobs }),
        client.invalidateQueries({ queryKey: queryKeys.mediaItems }),
      ]),
    [client, projectId, scene.id],
  );

  const start = useCallback(async () => {
    if (controller.current !== null) return;
    const abort = new AbortController();
    controller.current = abort;
    cancelOnAbort.current = false;
    const jobs = new Set<string>();
    const ctx: RunContext = {
      client,
      projectId,
      scene,
      signal: abort.signal,
      jobs,
      cancelOnAbort,
      notice: (text) => update((current) => (current.notices.includes(text) ? current : { ...current, notices: [...current.notices, text] })),
    };
    let running: StepId | null = null;
    try {
      const [characters, adoptions] = await Promise.all([
        fetchCharacters(client, projectId),
        fetchAdoptions(client, projectId, scene.id),
      ]);
      const steps = initialRunStates(scene, characters, adoptions);
      update(() => ({ phase: "running", current: null, steps, failedStep: null, message: null, notices: [] }));
      for (const id of stepsToRun(scene, characters, adoptions)) {
        if (abort.signal.aborted) throw new DOMException("aborted", "AbortError");
        running = id;
        setStep(id, "running", { current: id });
        const outcome = await executeStep(id, ctx);
        running = null;
        setStep(id, outcome, { current: null });
        await refresh();
      }
      update((current) => ({ ...current, phase: "completed", current: null }));
    } catch (error) {
      if (isAbortError(error) || abort.signal.aborted) {
        // 利用者の中止だけ画面に残す。画面を閉じたときは、もう描かない。
        if (running !== null) setStep(running, "pending");
        update((current) => ({
          ...current,
          phase: "aborted",
          current: null,
          message: running !== null ? `${stepLabel(running)}の実行中に中止しました。` : "中止しました。",
        }));
      } else {
        const failed = running;
        if (failed !== null) setStep(failed, "failed");
        update((current) => ({
          ...current,
          phase: "failed",
          current: null,
          failedStep: failed,
          message: messageOf(error),
        }));
      }
    } finally {
      controller.current = null;
      void refresh();
    }
  }, [client, projectId, scene, update, setStep, refresh]);

  /** 「中止」。ループを止め、いま待っているJobを取り消す。 */
  const stop = useCallback(() => {
    const abort = controller.current;
    if (abort === null) return;
    cancelOnAbort.current = true;
    abort.abort();
  }, []);

  return { state, start, stop, running: state.phase === "running" };
}
