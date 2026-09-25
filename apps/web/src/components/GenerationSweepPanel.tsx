import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { ApiError, api } from "../api/client";
import type {
  AgentProvider,
  GenerationExperiment,
  GenerationExperimentCreate,
  GenerationExperimentPreview,
  Recipe,
} from "../api/client";
import { LookProfileManager } from "./LookProfileManager";
import { AssistNotes, PromptAssist } from "./PromptAssist";
import type { AssistResult } from "./PromptAssist";
import { PromptDiffReview } from "./PromptDiffReview";
import type { PromptDiffField } from "./PromptDiffReview";
import { EmptyState } from "./ui/EmptyState";

interface Props {
  /** 隠れている間は一覧のポーリングを止め、無駄なリクエストを出さない。 */
  active: boolean;
  projectId: string | null;
  sceneId: string | null;
  shotId: string | null;
  recipes: Recipe[];
  onJobsChanged: () => void;
  activeComparisonId: string | null;
  onCompare: (experimentId: string, jobIds: string[]) => void;
  /** Project未選択の案内から、シーン一覧のProjectセレクトへ移る。 */
  onSelectProject: () => void;
  /** 実験一覧の描画先。右カラムに置かれたDOMノードへportalし、フォームは左カラムに残す (#317)。 */
  resultSlot?: HTMLElement | null;
}

function describe(error: unknown): string {
  if (error instanceof ApiError) return `${error.message} (${error.code})`;
  return String(error);
}

function numbers(value: string, integer = false): number[] {
  if (!value.trim()) return [];
  return value.split(",").map((item) => {
    const parsed = Number(item.trim());
    if (!Number.isFinite(parsed) || (integer && !Number.isInteger(parsed))) {
      throw new Error(integer ? "整数軸を確認してください。" : "数値軸を確認してください。");
    }
    return parsed;
  });
}

export function GenerationSweepPanel({
  active,
  projectId,
  sceneId,
  shotId,
  recipes,
  onJobsChanged,
  activeComparisonId,
  onCompare,
  onSelectProject,
  resultSlot,
}: Props) {
  const [name, setName] = useState("探索スイープ");
  const [recipeId, setRecipeId] = useState("");
  const [mode, setMode] = useState<"cartesian" | "zip">("cartesian");
  const [prompt, setPrompt] = useState("");
  const [negative, setNegative] = useState("");
  const [providers, setProviders] = useState<AgentProvider[]>([]);
  const [promptDiff, setPromptDiff] = useState<PromptDiffField[] | null>(null);
  // 補完から開いた差分に添える AI の説明とタグ訳。補完以外から開いた差分では null (#354)。
  const [promptDiffNotes, setPromptDiffNotes] = useState<AssistResult | null>(null);
  const [seedAxis, setSeedAxis] = useState("-1");
  const [cfgAxis, setCfgAxis] = useState("4,5");
  const [stepsAxis, setStepsAxis] = useState("20,30");
  const [fragmentAxis, setFragmentAxis] = useState("");
  const [lookProfileIds, setLookProfileIds] = useState<string[]>([]);
  const [preview, setPreview] = useState<GenerationExperimentPreview | null>(null);
  const [previewSignature, setPreviewSignature] = useState<string | null>(null);
  const [experiments, setExperiments] = useState<GenerationExperiment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const requestSequence = useRef(0);
  const busyRef = useRef(false);
  const recipe = useMemo(
    () => recipes.find((item) => item.id === recipeId) ?? null,
    [recipeId, recipes],
  );

  useEffect(() => {
    void api.listAgentProviders().then(setProviders).catch(() => setProviders([]));
  }, []);

  useEffect(() => {
    if (!recipeId && recipes[0]) setRecipeId(recipes[0].id);
  }, [recipeId, recipes]);

  useEffect(() => {
    if (!projectId || !active) return;
    let alive = true;
    const refresh = () => {
      if (busyRef.current) return;
      const sequence = ++requestSequence.current;
      void api.listGenerationExperiments(projectId, { limit: 20, offset: page * 20 })
        .then((items) => {
          if (alive && sequence === requestSequence.current) {
            setExperiments(items);
            setError(null);
            const comparing = items.find((item) => item.id === activeComparisonId);
            if (comparing) {
              onCompare(
                comparing.id,
                comparing.items.map((item) => item.job_id).filter((id): id is string => Boolean(id)),
              );
            }
          }
        })
        .catch((cause) => { if (alive) setError(describe(cause)); });
    };
    refresh();
    const timer = window.setInterval(refresh, 2000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [active, activeComparisonId, onCompare, page, projectId]);

  // Projectが変わると前のProjectの実験は無関係になる。表示の切替では消さず、
  // 隠れている間も直前の一覧を残したまま、復帰時に取り直す。
  useEffect(() => { setPage(0); setExperiments([]); }, [projectId]);

  useEffect(() => { busyRef.current = busy; }, [busy]);

  useEffect(() => { setPreview(null); setPreviewSignature(null); }, [
    name, recipeId, mode, prompt, negative, seedAxis, cfgAxis, stepsAxis,
    fragmentAxis, lookProfileIds, projectId, sceneId, shotId,
  ]);

  const payload = (): GenerationExperimentCreate | null => {
    if (!projectId || !sceneId || !shotId || !recipeId) {
      setError("activeなProject、Scene、Shot、Recipeを選択してください。");
      return null;
    }
    try {
      return {
        name: name.trim() || "探索スイープ",
        scene_id: sceneId,
        shot_id: shotId,
        recipe_id: recipeId,
        look_profile_ids: lookProfileIds,
        base_inputs: {
          ...(prompt.trim() ? { positive_prompt: prompt.trim() } : {}),
          ...(negative.trim() ? { negative_prompt: negative.trim() } : {}),
        },
        input_refs: [],
        axes: {
          seed: numbers(seedAxis, true),
          cfg: numbers(cfgAxis),
          steps: numbers(stepsAxis, true),
          prompt_fragment: fragmentAxis.split("\n").map((item) => item.trim()).filter(Boolean),
        },
        mode,
      };
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    }
  };

  const runPreview = async () => {
    const request = payload();
    if (!projectId || !request) return;
    busyRef.current = true;
    setBusy(true); setError(null);
    try {
      setPreview(await api.previewGenerationExperiment(projectId, request));
      setPreviewSignature(JSON.stringify(request));
    }
    catch (cause) { setError(describe(cause)); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const create = async () => {
    const request = payload();
    if (!projectId || !request) return;
    if (!preview || previewSignature !== JSON.stringify(request)) {
      setError("入力を変更したため、もう一度展開を確認してください。");
      return;
    }
    requestSequence.current += 1;
    busyRef.current = true;
    setBusy(true); setError(null);
    try {
      const created = await api.createGenerationExperiment(projectId, request);
      setExperiments((current) => [created, ...current]);
      setPreview(null);
      setPreviewSignature(null);
      onJobsChanged();
    } catch (cause) { setError(describe(cause)); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const operate = async (experiment: GenerationExperiment, action: "cancel" | "retry") => {
    if (!projectId) return;
    if (
      action === "cancel" &&
      !window.confirm("実験の未実行ジョブをキャンセルします。キャンセルは取り消せません。続けますか？")
    ) {
      return;
    }
    requestSequence.current += 1;
    busyRef.current = true;
    setBusy(true); setError(null);
    try {
      const updated = action === "cancel"
        ? await api.cancelPendingExperimentJobs(projectId, experiment.id)
        : await api.retryFailedExperimentJobs(projectId, experiment.id);
      setExperiments((current) => current.map((item) => item.id === updated.id ? updated : item));
      onJobsChanged();
      if (activeComparisonId === updated.id) {
        onCompare(
          updated.id,
          updated.items.map((item) => item.job_id).filter((id): id is string => Boolean(id)),
        );
      }
    } catch (cause) { setError(describe(cause)); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const remove = async (experiment: GenerationExperiment) => {
    if (!projectId || !window.confirm(`探索実験「${experiment.name}」を削除しますか。JobとArtifactは残ります。`)) return;
    requestSequence.current += 1;
    busyRef.current = true;
    setBusy(true); setError(null);
    try {
      await api.deleteGenerationExperiment(projectId, experiment.id);
      setExperiments((current) => current.filter((item) => item.id !== experiment.id));
    } catch (cause) { setError(describe(cause)); }
    finally { busyRef.current = false; setBusy(false); }
  };

  if (!projectId) {
    return (
      <section className="panel">
        <h2>探索スイープ</h2>
        <EmptyState
          title="Projectを選ぶと利用できます。"
          description="左のシーン一覧でProjectを選ぶと、探索スイープを開始できます。"
          action={
            <button
              type="button"
              onClick={onSelectProject}
            >
              Projectを選ぶ
            </button>
          }
        />
      </section>
    );
  }
  // 実験一覧は右カラムのresultSlotへportalする。未取得時 (初回描画・呼び出し元未対応) は
  // フォームの下にそのまま表示し、一覧が見えなくならないようにする。
  const experimentsPanel = (
    <section className="panel">
      <h2>探索実験一覧</h2>
      <div className="stack">
        <div className="stack">
          {experiments.map((experiment) => {
            const jobIds = experiment.items.map((item) => item.job_id).filter((id): id is string => Boolean(id));
            return <details key={experiment.id}>
              <summary>{experiment.name} / {experiment.state}</summary>
              <p>待機:{experiment.counts.queued ?? 0} / 実行中:{experiment.counts.running ?? 0} / 完了:{experiment.counts.completed ?? 0} / 失敗:{experiment.counts.failed ?? 0} / 取消:{experiment.counts.cancelled ?? 0}</p>
              <div className="row">
                <button type="button" disabled={busy} onClick={() => void operate(experiment, "cancel")}>未開始を中止</button>
                <button type="button" disabled={busy} onClick={() => void operate(experiment, "retry")}>失敗を再実行</button>
                <button type="button" disabled={!jobIds.length} onClick={() => onCompare(experiment.id, jobIds)}>この実験だけ比較</button>
                <button type="button" disabled={busy} onClick={() => void remove(experiment)}>実験を削除</button>
              </div>
              <ol>{experiment.items.map((item) => <li key={item.id}>#{item.ordinal + 1} {item.state} / {JSON.stringify(item.variables)}{item.planning_error ? ` / ${item.planning_error}` : ""}</li>)}</ol>
            </details>;
          })}
        </div>
        <div className="row">
          <button type="button" disabled={page === 0} onClick={() => setPage((current) => Math.max(0, current - 1))}>前の20件</button>
          <span>{page + 1}ページ</span>
          <button type="button" disabled={experiments.length < 20} onClick={() => setPage((current) => current + 1)}>次の20件</button>
        </div>
      </div>
    </section>
  );

  return (
    <>
      <section className="panel">
        <h2>探索スイープ</h2>
        <div className="form-actions">
          <button type="button" disabled={busy || !sceneId || !shotId || !recipeId} onClick={() => void runPreview()}>展開を確認</button>
          <button type="button" className="primary" disabled={busy || !preview} onClick={() => void create()}>{busy ? "処理中..." : "確認した実験を作成"}</button>
        </div>
        <div className="stack">
          {error && <p className="error">{error}</p>}
          <label>実験名<input value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label>ベース (Recipe)<select value={recipeId} onChange={(event) => setRecipeId(event.target.value)}>{recipes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label>展開方式<select value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}><option value="cartesian">直積</option><option value="zip">zip</option></select></label>
          {promptDiff ? (
            <PromptDiffReview
              fields={promptDiff}
              onCancel={() => setPromptDiff(null)}
              onAccept={(result) => {
                if ("positive_prompt" in result) setPrompt(result.positive_prompt);
                if ("negative_prompt" in result) setNegative(result.negative_prompt);
                setPromptDiff(null);
              }}
            >
              {promptDiffNotes && <AssistNotes result={promptDiffNotes} />}
            </PromptDiffReview>
          ) : (
            <PromptAssist
              providers={providers}
              idPrefix="sweep"
              recipeId={recipeId}
              current={{ positive: prompt, negative }}
              projectId={projectId}
              placeholder="例: 夕暮れの海辺に立つ少女。構図は引きで。"
              onApply={(result) => {
                // 既存のプロンプトをすぐ上書きせず、差分レビューを開いて採否を選ばせる。
                setPromptDiffNotes(result.notes);
                setPromptDiff([
                  { key: "positive_prompt", label: "基本プロンプト", current: prompt, proposed: result.positive },
                  { key: "negative_prompt", label: "ネガティブプロンプト", current: negative, proposed: result.negative },
                ]);
              }}
            />
          )}
          {/* 差分レビュー中に書き換えると、反映したときに書いた分が黙って消える。 */}
          <label>基本プロンプト<textarea value={prompt} readOnly={promptDiff !== null} onChange={(event) => setPrompt(event.target.value)} /></label>
          <label>ネガティブプロンプト<textarea value={negative} readOnly={promptDiff !== null} onChange={(event) => setNegative(event.target.value)} /></label>
          <div className="row">
            <label>seed<input value={seedAxis} onChange={(event) => setSeedAxis(event.target.value)} placeholder="-1,1,2" /></label>
            <label>CFG<input value={cfgAxis} onChange={(event) => setCfgAxis(event.target.value)} placeholder="4,5,6" /></label>
            <label>steps<input value={stepsAxis} onChange={(event) => setStepsAxis(event.target.value)} placeholder="20,30" /></label>
          </div>
          <label>プロンプト断片（1行1候補）<textarea value={fragmentAxis} onChange={(event) => setFragmentAxis(event.target.value)} /></label>
          <LookProfileManager kind="image" recipe={recipe} selectedIds={lookProfileIds} onSelectionChange={setLookProfileIds} />
          {preview && <div><p>{preview.job_count}variant / 重複除外{preview.duplicate_count}件</p><ol>{preview.items.map((item) => <li key={item.ordinal} className="mono">#{item.ordinal + 1} {JSON.stringify(item.variables)}</li>)}</ol></div>}
        </div>
      </section>
      {resultSlot ? createPortal(experimentsPanel, resultSlot) : experimentsPanel}
    </>
  );
}
