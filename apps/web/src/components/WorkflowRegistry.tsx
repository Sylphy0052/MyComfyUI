import { useEffect, useMemo, useState } from "react";

import { ApiError, api } from "../api/client";
import type {
  Artifact,
  Recipe,
  Workflow,
  WorkflowVersion,
} from "../api/client";

/** 実行時スナップショットの取得件数。新しい順に窓で見る。 */
const SNAPSHOT_LIMIT = 30;

interface Props {
  sceneId: string | null;
  shotId: string | null;
}

function describe(error: unknown): string {
  if (error instanceof ApiError) {
    return error.requestId
      ? `${error.message} (${error.code} / request_id=${error.requestId})`
      : `${error.message} (${error.code})`;
  }
  return String(error);
}

function variableNames(variables: Record<string, unknown>): string[] {
  return Object.keys(variables ?? {});
}

export function WorkflowRegistry({ sceneId, shotId }: Props) {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const [versions, setVersions] = useState<WorkflowVersion[]>([]);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [snapshots, setSnapshots] = useState<Artifact[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [workflowList, recipeList] = await Promise.all([
          api.listWorkflows(),
          api.listRecipes(),
        ]);
        if (!active) return;
        setWorkflows(workflowList);
        setRecipes(recipeList);
        setWorkflowId(workflowList[0]?.id ?? null);
      } catch (cause) {
        if (!active) return;
        // 取得できなかったものを古い内容で埋めない。
        setWorkflows([]);
        setRecipes([]);
        setWorkflowId(null);
        setError(describe(cause));
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!workflowId) {
      setVersions([]);
      return;
    }
    let active = true;
    (async () => {
      try {
        const list = await api.listWorkflowVersions(workflowId);
        if (active) setVersions(list);
      } catch (cause) {
        if (!active) return;
        setVersions([]);
        setError(describe(cause));
      }
    })();
    return () => {
      active = false;
    };
  }, [workflowId]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const list = await api.listArtifacts({
          sceneId: sceneId ?? undefined,
          shotId: shotId ?? undefined,
          kind: "workflow",
          limit: SNAPSHOT_LIMIT,
        });
        if (active) setSnapshots(list);
      } catch (cause) {
        if (!active) return;
        setSnapshots([]);
        setError(describe(cause));
      }
    })();
    return () => {
      active = false;
    };
  }, [sceneId, shotId]);

  const workflow = useMemo(
    () => workflows.find((item) => item.id === workflowId) ?? null,
    [workflows, workflowId],
  );

  const versionIds = useMemo(
    () => new Set(versions.map((version) => version.id)),
    [versions],
  );

  // 表示中のWorkflowの版を指すRecipeだけを並べる。Recipeが指定できる範囲は、
  // その版の宣言変数に限られる。
  const relatedRecipes = useMemo(
    () =>
      recipes.filter(
        (recipe) =>
          recipe.workflow_version_id !== null &&
          versionIds.has(recipe.workflow_version_id),
      ),
    [recipes, versionIds],
  );

  return (
    <div className="stack">
      {error && (
        <div className="panel">
          <div className="error">
            <div>{error}</div>
            <button type="button" onClick={() => setError(null)}>
              閉じる
            </button>
          </div>
        </div>
      )}

      <section className="panel">
        <h2>Workflow</h2>
        <p className="muted">
          {
            "Workflowは生成の実行本体。Recipeは版の宣言変数へ値を与えるプリセットで、Workflow自体とは別の情報として扱う。"
          }
        </p>
        <label htmlFor="workflow-select">登録済みWorkflow</label>
        <select
          id="workflow-select"
          value={workflowId ?? ""}
          onChange={(event) => setWorkflowId(event.target.value || null)}
        >
          {workflows.length === 0 && <option value="">(登録なし)</option>}
          {workflows.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name} ({item.kind})
            </option>
          ))}
        </select>
        {workflow && (
          <dl className="kv">
            <dt>Workflow</dt>
            <dd className="mono">{workflow.id}</dd>
            <dt>種別</dt>
            <dd>{workflow.kind}</dd>
            <dt>Backend</dt>
            <dd>{workflow.engines.join(", ")}</dd>
            <dt>登録</dt>
            <dd className="muted">{workflow.created_at}</dd>
          </dl>
        )}
      </section>

      <section className="panel">
        <h2>登録された版</h2>
        <p className="muted">
          {
            "登録された版は宣言変数と対応モデルを持つWorkflowの定義。実行時に保存されたJSONとは別物。"
          }
        </p>
        {versions.length === 0 ? (
          <p className="muted">このWorkflowには版が登録されていません。</p>
        ) : (
          <ul className="list plain">
            {versions.map((version) => (
              <li key={version.id}>
                <span className="row">
                  <span className="badge">{version.version}</span>
                  <span className="muted">{version.created_at}</span>
                </span>
                <span className="mono">
                  template_sha256: {version.template_sha256 ?? "-"}
                </span>
                <span className="muted">
                  宣言変数:{" "}
                  {variableNames(version.variables).join(", ") || "なし"}
                </span>
                <span className="muted">
                  出力: {version.outputs.length} 件 / モデル枠:{" "}
                  {version.model_slots.length} 件
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2>実行時スナップショット</h2>
        <p className="muted">
          {
            "実行時にArtifactとして保存されたWorkflow JSON。登録された版ではなく、そのJobが実際に投げた内容の記録。一覧APIはWorkflowを返さないため、上で選んだWorkflowに限らず対象Scene/Shotの実行をすべて新しい順に並べる。"
          }
        </p>
        {snapshots.length === 0 ? (
          <p className="muted">
            対象のScene/Shotに実行時スナップショットがありません。
          </p>
        ) : (
          <ul className="list plain">
            {snapshots.map((artifact) => (
              <li key={artifact.id}>
                <span className="row">
                  <span className="badge">実行時</span>
                  <span className="muted">{artifact.created_at}</span>
                  {artifact.availability !== "complete" && (
                    <span className="badge change-missing">欠損</span>
                  )}
                </span>
                <span className="mono">Job {artifact.job_id}</span>
                <span>
                  {artifact.availability === "complete" ? (
                    <a
                      href={api.artifactContentUrl(artifact.id)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      実行時のWorkflow JSON
                    </a>
                  ) : (
                    <span className="muted">
                      実ファイルがないため開けません。
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2>このWorkflowを使うRecipe</h2>
        <p className="muted">
          {
            "Recipeが指定できるのは対応する版の宣言変数の範囲だけ。範囲外の値はWorkflowへ渡らない。"
          }
        </p>
        {relatedRecipes.length === 0 ? (
          <p className="muted">
            表示中のWorkflowの版を指すRecipeはありません。
          </p>
        ) : (
          <ul className="list plain">
            {relatedRecipes.map((recipe) => {
              const version = versions.find(
                (item) => item.id === recipe.workflow_version_id,
              );
              const declared = version ? variableNames(version.variables) : [];
              const defaults = Object.keys(recipe.defaults ?? {});
              const outside = defaults.filter(
                (name) => declared.length > 0 && !declared.includes(name),
              );
              return (
                <li key={recipe.id}>
                  <span className="row">
                    <span className="badge">{recipe.kind}</span>
                    <span>{recipe.name}</span>
                    <span className="muted">
                      版 {version?.version ?? "-"} / {recipe.engine}
                    </span>
                  </span>
                  <span className="muted">
                    宣言変数: {declared.join(", ") || "なし"}
                  </span>
                  <span className="muted">
                    Recipeの既定値: {defaults.join(", ") || "なし"}
                  </span>
                  {outside.length > 0 && (
                    <span className="muted">
                      宣言変数に無い既定値: {outside.join(", ")}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
