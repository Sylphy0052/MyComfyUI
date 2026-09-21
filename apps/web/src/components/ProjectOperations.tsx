import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";

import { ApiError, api } from "../api/client";
import type {
  GenerationBatch,
  GenerationBatchCreate,
  GenerationBatchPreview,
  ProjectRecord,
  ProjectStatistics,
  Recipe,
} from "../api/client";
import type { SceneSummary, ShotSummary } from "../api/aimedia";

type GenerationKind = GenerationBatchCreate["kind"];
type BatchTarget = GenerationBatchCreate["targets"][number];

interface TargetRow extends BatchTarget {
  key: string;
  label: string;
  level: "Scene" | "Shot";
}

const KINDS: { value: GenerationKind; label: string }[] = [
  { value: "image", label: "画像" },
  { value: "video", label: "動画" },
  { value: "voice", label: "音声" },
  { value: "music", label: "音楽" },
  { value: "compose", label: "合成" },
];

const STATE_LABELS: Record<string, string> = {
  pending: "準備中",
  queued: "待機中",
  running: "実行中",
  cancelling: "中止処理中",
  succeeded: "成功",
  failed: "失敗",
  cancelled: "中止",
  planning_failed: "計画失敗",
};

function describe(error: unknown): string {
  if (error instanceof ApiError) return `${error.message}(${error.code})`;
  return String(error);
}

function targetKey(sceneId: string, shotId?: string | null): string {
  return shotId ? `shot:${sceneId}:${shotId}` : `scene:${sceneId}`;
}

function counts(batch: GenerationBatch): string {
  return Object.entries(batch.counts)
    .map(([state, count]) => `${STATE_LABELS[state] ?? state}:${count}`)
    .join(" / ");
}

function duration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}秒`;
  return `${Math.floor(seconds / 60)}分${Math.round(seconds % 60)}秒`;
}

export function ProjectOperations({ project }: { project: ProjectRecord }) {
  const [targets, setTargets] = useState<TargetRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [kind, setKind] = useState<GenerationKind>("image");
  const [name, setName] = useState("一括生成");
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [recipeId, setRecipeId] = useState("");
  const [inputs, setInputs] = useState("{}");
  const [preview, setPreview] = useState<GenerationBatchPreview | null>(null);
  const [batches, setBatches] = useState<GenerationBatch[]>([]);
  const [statistics, setStatistics] = useState<ProjectStatistics | null>(null);
  const [filterOptions, setFilterOptions] = useState<ProjectStatistics | null>(null);
  const [modelFilter, setModelFilter] = useState("");
  const [workflowFilter, setWorkflowFilter] = useState("");
  const [recipeFilter, setRecipeFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadBatches = useCallback(async () => {
    setBatches(await api.listGenerationBatches(project.id));
  }, [project.id]);

  useEffect(() => {
    let active = true;
    setSelected(new Set());
    setPreview(null);
    setError(null);
    (async () => {
      try {
        const [sceneList, recipeList, batchList, initialStatistics] =
          await Promise.all([
            api.listScenes(project.id),
            api.listRecipes(kind),
            api.listGenerationBatches(project.id),
            api.getProjectStatistics(project.id),
          ]);
        const shotLists = await Promise.all(
          sceneList.items.map((scene) => api.listShots(project.id, scene.id)),
        );
        if (!active) return;
        const rows: TargetRow[] = [];
        sceneList.items.forEach((scene: SceneSummary, index) => {
          rows.push({
            key: targetKey(scene.id),
            scene_id: scene.id,
            label: `#${scene.sequence} ${scene.summary}`,
            level: "Scene",
          });
          shotLists[index].items.forEach((shot: ShotSummary) => {
            rows.push({
              key: targetKey(scene.id, shot.id),
              scene_id: scene.id,
              shot_id: shot.id,
              label: `#${scene.sequence}-${shot.sequence} ${shot.summary}`,
              level: "Shot",
            });
          });
        });
        setTargets(rows);
        setRecipes(recipeList);
        setBatches(batchList);
        setStatistics(initialStatistics);
        setFilterOptions(initialStatistics);
      } catch (cause) {
        if (active) setError(describe(cause));
      }
    })();
    return () => {
      active = false;
    };
  }, [project.id]);

  useEffect(() => {
    let active = true;
    api.listRecipes(kind)
      .then((items) => {
        if (!active) return;
        setRecipes(items);
        setRecipeId("");
        setPreview(null);
      })
      .catch((cause) => {
        if (active) setError(describe(cause));
      });
    return () => {
      active = false;
    };
  }, [kind]);

  useEffect(() => {
    if (!batches.some((batch) => batch.state === "running" || batch.state === "pending")) {
      return;
    }
    const timer = window.setInterval(() => {
      loadBatches().catch((cause) => setError(describe(cause)));
    }, 3000);
    return () => window.clearInterval(timer);
  }, [batches, loadBatches]);

  const payload = (): GenerationBatchCreate => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(inputs || "{}");
    } catch {
      throw new Error("生成設定はJSONオブジェクトで入力してください。");
    }
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("生成設定はJSONオブジェクトで入力してください。");
    }
    return {
      name,
      kind,
      targets: targets
        .filter((target) => selected.has(target.key))
        .map(({ scene_id, shot_id }) => ({ scene_id, shot_id })),
      recipe_id: recipeId || null,
      use_inherited_defaults: false,
      inputs: parsed as Record<string, unknown>,
      input_refs: [],
    };
  };

  const run = async (mode: "preview" | "create") => {
    setBusy(true);
    setError(null);
    try {
      const request = payload();
      if (mode === "preview") {
        setPreview(await api.previewGenerationBatch(project.id, request));
      } else {
        await api.createGenerationBatch(project.id, request);
        setPreview(null);
        await loadBatches();
      }
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  const operateBatch = async (
    batchId: string,
    operation: "cancel" | "retry",
  ) => {
    setBusy(true);
    setError(null);
    try {
      if (operation === "cancel") {
        await api.cancelPendingBatchJobs(project.id, batchId);
      } else {
        await api.retryFailedBatchJobs(project.id, batchId);
      }
      await loadBatches();
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  const applyStatistics = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setStatistics(await api.getProjectStatistics(project.id, {
        model: modelFilter || undefined,
        workflowVersionId: workflowFilter || undefined,
        recipeId: recipeFilter || undefined,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
      }));
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  const selectedCount = selected.size;
  const canGenerate = project.lifecycle === "active" && selectedCount >= 2 && name.trim().length > 0;
  const selectedItems = useMemo(
    () => targets.filter((target) => selected.has(target.key)),
    [selected, targets],
  );

  return (
    <section className="project-operations">
      {error && <p className="error">{error}</p>}

      <details open={project.lifecycle === "active"}>
        <summary>一括生成</summary>
        {project.lifecycle !== "active" ? (
          <p className="muted">一括生成するにはProjectを復元してください。</p>
        ) : (
          <div className="stack operation-section">
            <div className="operation-form-grid">
              <label>計画名<input maxLength={120} value={name} onChange={(event) => { setName(event.target.value); setPreview(null); }} /></label>
              <label>種類<select value={kind} onChange={(event) => setKind(event.target.value as GenerationKind)}>
                {KINDS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select></label>
              <label>Recipe<select value={recipeId} onChange={(event) => { setRecipeId(event.target.value); setPreview(null); }}>
                <option value="">Project・Scene・Shotの既定値</option>
                {recipes.map((recipe) => <option key={recipe.id} value={recipe.id}>{recipe.name}</option>)}
              </select></label>
            </div>
            <div className="row">
              <button type="button" onClick={() => { setSelected(new Set(targets.filter((item) => item.level === "Scene").map((item) => item.key))); setPreview(null); }}>全Scene</button>
              <button type="button" onClick={() => { setSelected(new Set(targets.filter((item) => item.level === "Shot").map((item) => item.key))); setPreview(null); }}>全Shot</button>
              <button type="button" onClick={() => { setSelected(new Set()); setPreview(null); }}>選択解除</button>
              <span className="muted">{selectedCount}件選択</span>
            </div>
            <div className="batch-targets">
              {targets.map((target) => (
                <label key={target.key}>
                  <input type="checkbox" checked={selected.has(target.key)} onChange={(event) => {
                    setSelected((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(target.key); else next.delete(target.key);
                      return next;
                    });
                    setPreview(null);
                  }} />
                  <span className="badge">{target.level}</span> {target.label}
                </label>
              ))}
              {targets.length === 0 && <p className="muted">対象のScene・Shotがありません。</p>}
            </div>
            <label>生成設定（JSON）<textarea className="mono" value={inputs} onChange={(event) => { setInputs(event.target.value); setPreview(null); }} /></label>
            <div className="row">
              <button type="button" disabled={busy || !canGenerate} onClick={() => run("preview")}>事前確認</button>
              <button type="button" className="primary" disabled={busy || !canGenerate || !preview} onClick={() => run("create")}>この計画を実行</button>
            </div>
            {selectedCount === 1 && <p className="muted">一括生成には2件以上を選択してください。</p>}
            {preview && (
              <div className="batch-preview">
                <strong>{preview.job_count}件のJobを作成します</strong>
                <p className="muted">Recipe:{preview.recipe_ids.join(", ")} / Workflow:{preview.workflow_dependencies.join(", ") || "版指定なし"}</p>
                <p className="muted">参照依存:{preview.reference_dependencies.length}件</p>
                <ul className="list compact-list">
                  {preview.items.map((item, index) => (
                    <li key={`${item.scene_id}:${item.shot_id ?? "scene"}:${index}`}>
                      {selectedItems[index]?.label ?? item.shot_id ?? item.scene_id} / {item.engine} / {JSON.stringify(item.model)}
                      <br />Recipe:{item.recipe_id}（{item.recipe_origin}） / Workflow:{item.workflow_name ?? "未登録"} / seed:{item.seed}{item.seed_auto ? "（実行時に自動採番）" : ""}
                      <br />入力:{JSON.stringify(item.resolved_inputs)} / パラメータ:{JSON.stringify(item.parameters)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </details>

      <details open>
        <summary>一括生成の進捗</summary>
        <div className="stack operation-section">
          <button type="button" disabled={busy} onClick={() => loadBatches().catch((cause) => setError(describe(cause)))}>更新</button>
          {batches.map((batch) => {
            const retryable = (batch.counts.failed ?? 0) + (batch.counts.planning_failed ?? 0) > 0;
            const cancellable = (batch.counts.queued ?? 0) > 0;
            return <article key={batch.id} className="batch-card">
              <div className="row spread"><strong>{batch.name}</strong><span className="badge">{batch.kind}</span></div>
              <p>{counts(batch) || "進捗なし"}</p>
              <div className="row">
                {cancellable && <button type="button" disabled={busy} onClick={() => operateBatch(batch.id, "cancel")}>未開始を中止</button>}
                {retryable && project.lifecycle === "active" && <button type="button" disabled={busy} onClick={() => operateBatch(batch.id, "retry")}>失敗を再試行</button>}
              </div>
            </article>;
          })}
          {batches.length === 0 && <p className="muted">一括生成の履歴はありません。</p>}
        </div>
      </details>

      <details open>
        <summary>生成統計</summary>
        <form className="stack operation-section" onSubmit={applyStatistics}>
          <div className="operation-form-grid">
            <label>モデル<input value={modelFilter} placeholder="名前の一部" onChange={(event) => setModelFilter(event.target.value)} /></label>
            <label>Workflow<select value={workflowFilter} onChange={(event) => setWorkflowFilter(event.target.value)}>
              <option value="">すべて</option>
              {(filterOptions?.by_workflow ?? []).map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
            </select></label>
            <label>Recipe<select value={recipeFilter} onChange={(event) => setRecipeFilter(event.target.value)}>
              <option value="">すべて</option>
              {(filterOptions?.by_recipe ?? []).map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
            </select></label>
            <label>開始日<input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} /></label>
            <label>終了日<input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} /></label>
          </div>
          <button type="submit" disabled={busy}>絞り込む</button>
          {statistics && <>
            <div className="project-metrics operation-metrics">
              <div className="metric"><span>生成数</span><strong>{statistics.jobs}</strong></div>
              <div className="metric"><span>成功</span><strong>{statistics.succeeded}</strong></div>
              <div className="metric"><span>失敗</span><strong>{statistics.failed}</strong></div>
              <div className="metric"><span>処理時間</span><strong>{duration(statistics.processing_seconds)}</strong></div>
            </div>
            <p className="muted">
              実績コスト:{statistics.cost.actual_usd == null ? "取得不可" : `$${statistics.cost.actual_usd.toFixed(4)}`}
              {" / "}見積コスト:{statistics.cost.estimated_usd == null ? "取得不可" : `$${statistics.cost.estimated_usd.toFixed(4)}`}
              {statistics.cost.source ? ` / 出典:${statistics.cost.source}` : ""}
            </p>
            {statistics.cost.reason && <p className="muted">{statistics.cost.reason}</p>}
            <div className="statistics-breakdowns">
              <Breakdown title="モデル別" rows={statistics.by_model} />
              <Breakdown title="Workflow別" rows={statistics.by_workflow} />
              <Breakdown title="Recipe別" rows={statistics.by_recipe} />
            </div>
          </>}
        </form>
      </details>
    </section>
  );
}

function Breakdown({ title, rows }: {
  title: string;
  rows: ProjectStatistics["by_model"];
}) {
  return <div><strong>{title}</strong><ul className="list compact-list">
    {rows.map((row) => <li key={row.key}>{row.label}: {row.jobs}件（成功{row.succeeded} / 失敗{row.failed}）</li>)}
    {rows.length === 0 && <li className="muted">該当なし</li>}
  </ul></div>;
}
