import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";

import { ApiError, api } from "../api/client";
import type {
  Artifact,
  GenerationJob,
  ProjectDeletionImpact,
  ProjectProgress,
  ProjectRecord,
  ProjectStatistics,
} from "../api/client";
import { ProjectGenerationDefaultsEditor } from "./ProjectGenerationDefaultsEditor";
import { ProjectOperations } from "./ProjectOperations";
import { ProjectPackageDialog, ProjectPortabilityPanel } from "./ProjectPortability";
import { ExternalProjectImporter, ProjectSyncPanel } from "./ProjectSyncPanel";
import { LoadingPlaceholder } from "./LoadingPlaceholder";
import { useNotify } from "./ui/notify";

type Lifecycle = ProjectRecord["lifecycle"];
type ProjectStatus = ProjectRecord["status"];
type ProjectSort = "name" | "created" | "updated" | "last_used";

interface Props {
  hidden?: boolean;
  selectedProjectId: string | null;
  onSelectProject: (projectId: string | null) => void;
  /** 取り消しで選択を戻す。onSelectProject と違い、生成画面へは移らない。 */
  onRestoreSelection: (projectId: string) => void;
  onActiveProjectsChanged: (projects: ProjectRecord[]) => void;
}

interface ProjectHome {
  impact: ProjectDeletionImpact;
  jobs: GenerationJob[];
  artifacts: Artifact[];
  progress: ProjectProgress;
  statistics: ProjectStatistics | null;
}

interface PendingAction {
  kind: "archive" | "trash";
  project: ProjectRecord;
  impact: ProjectDeletionImpact;
}

const LIFECYCLES: { value: Lifecycle; label: string }[] = [
  { value: "active", label: "アクティブ" },
  { value: "archived", label: "アーカイブ" },
  { value: "trashed", label: "ゴミ箱" },
];

const SORTS: { value: ProjectSort; label: string }[] = [
  { value: "last_used", label: "最終使用順" },
  { value: "updated", label: "更新順" },
  { value: "created", label: "作成順" },
  { value: "name", label: "名前順" },
];

const STATUS_LABELS: Record<ProjectStatus, string> = {
  planning: "計画中",
  active: "進行中",
  on_hold: "保留",
  completed: "完了",
};

const STATUS_TRANSITIONS: Record<ProjectStatus, ProjectStatus[]> = {
  planning: ["planning", "active", "on_hold"],
  active: ["active", "on_hold", "completed"],
  on_hold: ["on_hold", "active", "completed"],
  completed: ["completed", "active"],
};

function describe(error: unknown): string {
  if (error instanceof ApiError) {
    return error.requestId
      ? `${error.message} (${error.code} / request_id=${error.requestId})`
      : `${error.message} (${error.code})`;
  }
  return String(error);
}

function formatDate(value: string | null): string {
  if (!value) return "未使用";
  return new Date(value).toLocaleString("ja-JP");
}

export function ProjectWorkspace({
  hidden,
  selectedProjectId,
  onSelectProject,
  onRestoreSelection,
  onActiveProjectsChanged,
}: Props) {
  const [lifecycle, setLifecycle] = useState<Lifecycle>("active");
  const notify = useNotify();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ProjectSort>("last_used");
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [focusedId, setFocusedId] = useState<string | null>(selectedProjectId);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [editor, setEditor] = useState<"create" | "edit" | null>(null);
  const [externalImporter, setExternalImporter] = useState(false);
  const [packageDialog, setPackageDialog] = useState(false);
  const [defaultsEditor, setDefaultsEditor] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [home, setHome] = useState<ProjectHome | null>(null);
  const [homeLoading, setHomeLoading] = useState(false);
  const [homeError, setHomeError] = useState<string | null>(null);

  const selected = useMemo(
    () => projects.find((project) => project.id === focusedId) ?? null,
    [focusedId, projects],
  );

  const syncActiveProjects = useCallback(async () => {
    const active = await api.listProjects({ lifecycle: "active" });
    onActiveProjectsChanged(active.items);
  }, [onActiveProjectsChanged]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setListError(null);
    (async () => {
      try {
        const result = await api.listProjects({
          lifecycle,
          query,
          sort,
          favoriteOnly,
        });
        if (!active) return;
        setProjects(result.items);
        setFocusedId((current) => {
          if (current && result.items.some((project) => project.id === current)) {
            return current;
          }
          if (
            selectedProjectId &&
            result.items.some((project) => project.id === selectedProjectId)
          ) {
            return selectedProjectId;
          }
          return result.items[0]?.id ?? null;
        });
        if (lifecycle === "active") onActiveProjectsChanged(result.items);
      } catch (cause) {
        if (active) setListError(describe(cause));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [
    lifecycle,
    query,
    sort,
    favoriteOnly,
    refreshToken,
    selectedProjectId,
    onActiveProjectsChanged,
  ]);

  useEffect(() => {
    if (!selected) {
      setHome(null);
      setHomeError(null);
      return;
    }
    let active = true;
    setHome(null);
    setHomeLoading(true);
    setHomeError(null);
    (async () => {
      try {
        const [impact, jobs, artifacts, progress, statistics] = await Promise.all([
          api.getProjectDeletionImpact(selected.id),
          api.listJobs({ projectId: selected.id }),
          api.listArtifacts({ projectId: selected.id, limit: 6 }),
          api.getProjectProgress(selected.id),
          selected.lifecycle === "trashed"
            ? Promise.resolve(null)
            : api.getProjectStatistics(selected.id),
        ]);
        if (active) setHome({ impact, jobs, artifacts, progress, statistics });
      } catch (cause) {
        if (active) setHomeError(describe(cause));
      } finally {
        if (active) setHomeLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [selected, refreshToken]);

  const refresh = async () => {
    setRefreshToken((value) => value + 1);
    await syncActiveProjects();
  };

  const toggleFavorite = async (project: ProjectRecord) => {
    setBusy(true);
    setActionError(null);
    try {
      await api.updateProject(project.id, { favorite: !project.favorite });
      await refresh();
    } catch (cause) {
      setActionError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  const prepareAction = async (
    kind: PendingAction["kind"],
    project: ProjectRecord,
  ) => {
    setBusy(true);
    setActionError(null);
    try {
      const impact = await api.getProjectDeletionImpact(project.id);
      setPendingAction({ kind, project, impact });
    } catch (cause) {
      setActionError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  const executeAction = async () => {
    if (!pendingAction) return;
    setBusy(true);
    setActionError(null);
    try {
      const { kind, project } = pendingAction;
      const wasSelected = project.id === selectedProjectId;
      if (kind === "archive") {
        await api.archiveProject(project.id);
      } else {
        await api.trashProject(project.id, true);
      }
      if (wasSelected) {
        onSelectProject(null);
      }
      setPendingAction(null);
      setFocusedId(null);
      await refresh();
      // 復元APIは常にactiveへ戻すため、activeから移したときだけ取り消せる。
      notify({
        tone: "success",
        message: `「${project.name}」を${kind === "archive" ? "アーカイブ" : "ゴミ箱へ移動"}しました`,
        action:
          project.lifecycle === "active"
            ? {
                label: "取り消す",
                onAction: async () => {
                  await api.restoreProject(project.id);
                  await refresh();
                  setFocusedId(project.id);
                  if (wasSelected) onRestoreSelection(project.id);
                },
              }
            : undefined,
      });
    } catch (cause) {
      setActionError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  const restore = async (project: ProjectRecord) => {
    setBusy(true);
    setActionError(null);
    try {
      await api.restoreProject(project.id);
      setFocusedId(null);
      await refresh();
    } catch (cause) {
      setActionError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  const useProject = async (project: ProjectRecord) => {
    setBusy(true);
    setActionError(null);
    try {
      await api.touchProject(project.id);
      onSelectProject(project.id);
      await refresh();
    } catch (cause) {
      setActionError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  const failedJobs = home?.jobs.filter((job) => job.state === "failed").length ?? 0;

  return (
    <main className="full project-workspace" hidden={hidden}>
      <section className="panel project-toolbar">
        <div className="row spread">
          <div>
            <h2>Project</h2>
            <p className="muted">制作単位の作成、切替え、整理を行います。</p>
          </div>
          <div className="row">
            <button type="button" onClick={() => setPackageDialog(true)}>
              再利用・復元
            </button>
            <button type="button" onClick={() => setExternalImporter(true)}>
              外部作品をインポート
            </button>
            <button type="button" className="primary" onClick={() => setEditor("create")}>
              新規Project
            </button>
          </div>
        </div>
        <nav className="project-lifecycle-tabs" aria-label="Projectの保管場所">
          {LIFECYCLES.map((item) => (
            <button
              key={item.value}
              type="button"
              aria-pressed={lifecycle === item.value}
              className={lifecycle === item.value ? "primary" : undefined}
              onClick={() => setLifecycle(item.value)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="filters">
          <label>
            検索
            <input
              type="search"
              value={query}
              placeholder="名前または説明"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <label>
            並べ替え
            <select
              value={sort}
              onChange={(event) => setSort(event.target.value as ProjectSort)}
            >
              {SORTS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={favoriteOnly}
              onChange={(event) => setFavoriteOnly(event.target.checked)}
            />
            お気に入りのみ
          </label>
        </div>
      </section>

      {listError && <p className="error">Project一覧を取得できません。{listError}</p>}
      {actionError && <p className="error">{actionError}</p>}

      <div className="project-layout">
        <section className="panel project-list-panel" aria-busy={loading}>
          <h2>{LIFECYCLES.find((item) => item.value === lifecycle)?.label}</h2>
          {loading && <LoadingPlaceholder label="読込み中..." />}
          {!loading && !listError && projects.length === 0 && (
            <p className="muted">条件に一致するProjectはありません。</p>
          )}
          <ul className="list project-list">
            {projects.map((project) => (
              <li key={project.id}>
                <button
                  type="button"
                  aria-pressed={project.id === focusedId}
                  onClick={() => setFocusedId(project.id)}
                >
                  <span className="row spread">
                    <strong>{project.name}</strong>
                    <span aria-label={project.favorite ? "お気に入り" : undefined}>
                      {project.favorite ? "★" : ""}
                    </span>
                  </span>
                  <span className="muted">
                    {STATUS_LABELS[project.status]} / 更新{formatDate(project.updated_at)}
                  </span>
                  <span className="muted">最終使用{formatDate(project.last_used_at)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="panel project-home" aria-busy={homeLoading}>
          {!selected && <p className="muted">Projectを選択してください。</p>}
          {selected && (
            <>
              {selected.thumbnail_artifact_id && (
                <img
                  className="project-thumbnail"
                  src={api.artifactContentUrl(selected.thumbnail_artifact_id)}
                  alt={`${selected.name}のサムネイル`}
                />
              )}
              <div className="row spread">
                <div>
                  <h2>{selected.name}</h2>
                  <p className="muted">{selected.description || "説明はありません。"}</p>
                </div>
                <button
                  type="button"
                  aria-label={selected.favorite ? "お気に入りを解除" : "お気に入りに追加"}
                  aria-pressed={selected.favorite}
                  disabled={busy || selected.lifecycle === "trashed"}
                  onClick={() => toggleFavorite(selected)}
                >
                  {selected.favorite ? "★ お気に入り" : "☆ お気に入り"}
                </button>
              </div>

              <div className="project-actions row">
                {selected.lifecycle === "active" && (
                  <button
                    type="button"
                    className="primary"
                    disabled={busy}
                    onClick={() => useProject(selected)}
                  >
                    生成で使う
                  </button>
                )}
                {selected.lifecycle !== "trashed" && (
                  <button type="button" disabled={busy} onClick={() => setEditor("edit")}>
                    編集
                  </button>
                )}
                {selected.lifecycle !== "trashed" && (
                  <button type="button" disabled={busy} onClick={() => setDefaultsEditor(true)}>
                    生成既定値
                  </button>
                )}
                {selected.lifecycle === "active" && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => prepareAction("archive", selected)}
                  >
                    アーカイブ
                  </button>
                )}
                {selected.lifecycle !== "trashed" && (
                  <button
                    type="button"
                    className="danger-button"
                    disabled={busy}
                    onClick={() => prepareAction("trash", selected)}
                  >
                    ゴミ箱へ移動
                  </button>
                )}
                {selected.lifecycle !== "active" && (
                  <button type="button" disabled={busy} onClick={() => restore(selected)}>
                    復元
                  </button>
                )}
              </div>

              {selected.tags.length > 0 && (
                <div className="row" aria-label="タグ">
                  {selected.tags.map((tag) => (
                    <span key={tag} className="badge">
                      {tag}
                    </span>
                  ))}
                </div>
              )}

              {homeLoading && <LoadingPlaceholder label="Projectホームを読込み中..." lines={4} />}
              {homeError && <p className="error">Projectホームを取得できません。{homeError}</p>}
              {home && (
                <>
                  <div className="project-metrics">
                    <Metric label="Scene" value={selected.scene_count} />
                    <Metric label="Shot" value={selected.shot_count} />
                    <Metric label="Artifact" value={home.impact.artifact_count} />
                    <Metric label="実行中Job" value={home.impact.active_job_count} />
                    <Metric label="失敗Job" value={failedJobs} tone={failedJobs ? "danger" : undefined} />
                    {home.statistics && <Metric label="生成合計" value={home.statistics.jobs} />}
                    {home.statistics && <Metric label="生成成功" value={home.statistics.succeeded} />}
                    {home.statistics && <Metric label="処理時間(秒)" value={Math.round(home.statistics.processing_seconds)} />}
                  </div>
                  {selected.source_type === "local" && (
                    <>
                      <h3>制作進捗</h3>
                      <div className="progress-grid">
                        {[
                          ["未着手", "not_started"],
                          ["制作中", "in_progress"],
                          ["候補あり", "has_candidates"],
                          ["採用済み", "accepted"],
                          ["完了", "completed"],
                        ].map(([label, key]) => (
                          <div key={key} className="metric">
                            <span>{label}</span>
                            <strong>{home.progress.scenes[key] ?? 0}/{home.progress.shots[key] ?? 0}</strong>
                            <span>Scene / Shot</span>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                  <h3>最近の生成物</h3>
                  {home.artifacts.length === 0 ? (
                    <p className="muted">このProjectの生成物はまだありません。</p>
                  ) : (
                    <ul className="recent-artifacts">
                      {home.artifacts.map((artifact) => (
                        <li key={artifact.id}>
                          <span className="badge">{artifact.kind}</span>
                          <span>{formatDate(artifact.created_at)}</span>
                          <a href={api.artifactContentUrl(artifact.id)} target="_blank" rel="noreferrer">
                            開く
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}

              {selected.lifecycle !== "trashed" && (
                <ProjectOperations key={`operations-${selected.id}`} project={selected} />
              )}

              {selected.source_type === "external" && (
                <ProjectSyncPanel
                  key={`sync-${selected.id}`}
                  project={selected}
                  onChanged={async (project) => {
                    setFocusedId(project.id);
                    await refresh();
                  }}
                />
              )}

              {selected.lifecycle !== "trashed" && (
                <ProjectPortabilityPanel
                  project={selected}
                  onCreated={async (project) => {
                    setLifecycle("active");
                    setFocusedId(project.id);
                    await refresh();
                  }}
                />
              )}

              <dl className="kv project-metadata">
                <dt>ID</dt>
                <dd className="mono">{selected.id}</dd>
                <dt>source</dt>
                <dd>{selected.source_type}</dd>
                {selected.external_id && (
                  <><dt>外部ID</dt><dd className="mono">{selected.external_id}</dd></>
                )}
                <dt>作成</dt>
                <dd>{formatDate(selected.created_at)}</dd>
                <dt>更新</dt>
                <dd>{formatDate(selected.updated_at)}</dd>
              </dl>
            </>
          )}
        </section>
      </div>

      {editor && (
        <ProjectEditor
          project={editor === "edit" ? selected : null}
          onCancel={() => setEditor(null)}
          onSaved={async (project) => {
            setEditor(null);
            setLifecycle("active");
            setFocusedId(project.id);
            await refresh();
          }}
        />
      )}

      {externalImporter && (
        <ExternalProjectImporter
          onCancel={() => setExternalImporter(false)}
          onImported={async (project) => {
            setExternalImporter(false);
            setLifecycle("active");
            setFocusedId(project.id);
            await refresh();
          }}
        />
      )}

      {packageDialog && (
        <ProjectPackageDialog
          onCancel={() => setPackageDialog(false)}
          onCreated={async (project) => {
            setPackageDialog(false);
            setLifecycle("active");
            setFocusedId(project.id);
            await refresh();
          }}
        />
      )}

      {defaultsEditor && selected && (
        <ProjectGenerationDefaultsEditor
          projectId={selected.id}
          onCancel={() => setDefaultsEditor(false)}
          onSaved={async () => {
            setDefaultsEditor(false);
            await refresh();
          }}
        />
      )}

      {pendingAction && (
        <section className="panel project-confirm" role="dialog" aria-modal="true" aria-labelledby="project-confirm-title">
          <h2 id="project-confirm-title">
            {pendingAction.kind === "archive" ? "アーカイブ" : "ゴミ箱へ移動"}の確認
          </h2>
          <p>{pendingAction.project.name}の関連データは削除されません。</p>
          <dl className="kv">
            <dt>Scene</dt><dd>{pendingAction.impact.scene_count}件</dd>
            <dt>Shot</dt><dd>{pendingAction.impact.shot_count}件</dd>
            <dt>Job</dt><dd>{pendingAction.impact.job_count}件</dd>
            <dt>Artifact</dt><dd>{pendingAction.impact.artifact_count}件</dd>
          </dl>
          {pendingAction.impact.blockers.map((blocker) => (
            <p key={blocker} className="error">{blocker}</p>
          ))}
          <div className="row">
            <button type="button" onClick={() => setPendingAction(null)}>戻る</button>
            <button
              type="button"
              className={pendingAction.kind === "trash" ? "danger-button" : "primary"}
              disabled={busy || pendingAction.impact.blockers.length > 0}
              onClick={executeAction}
            >
              実行
            </button>
          </div>
        </section>
      )}
    </main>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "danger";
}) {
  return (
    <div className={tone === "danger" ? "metric danger" : "metric"}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ProjectEditor({
  project,
  onCancel,
  onSaved,
}: {
  project: ProjectRecord | null;
  onCancel: () => void;
  onSaved: (project: ProjectRecord) => Promise<void>;
}) {
  const [id, setId] = useState("");
  const [name, setName] = useState(project?.name ?? "");
  const [description, setDescription] = useState(project?.description ?? "");
  const [status, setStatus] = useState<ProjectStatus>(project?.status ?? "planning");
  const [tags, setTags] = useState(project?.tags.join(", ") ?? "");
  const [thumbnailId, setThumbnailId] = useState(project?.thumbnail_artifact_id ?? "");
  const [favorite, setFavorite] = useState(project?.favorite ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const values = {
      name,
      description: description || null,
      status,
      tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean),
      thumbnail_artifact_id: thumbnailId || null,
      favorite,
    };
    try {
      const saved = project
        ? await api.updateProject(project.id, values)
        : await api.createProject({ ...values, id: id || null });
      await onSaved(saved);
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  const availableStatuses = project
    ? STATUS_TRANSITIONS[project.status]
    : (Object.keys(STATUS_LABELS) as ProjectStatus[]);

  return (
    <section className="panel project-editor" role="dialog" aria-modal="true" aria-labelledby="project-editor-title">
      <h2 id="project-editor-title">{project ? "Projectを編集" : "Projectを作成"}</h2>
      <form className="stack" onSubmit={submit}>
        {!project && (
          <label>
            ID（省略時は自動採番）
            <input value={id} pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,127}" onChange={(event) => setId(event.target.value)} />
          </label>
        )}
        <label>
          名前
          <input required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          説明
          <textarea maxLength={10000} value={description} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <label>
          状態
          <select value={status} onChange={(event) => setStatus(event.target.value as ProjectStatus)}>
            {availableStatuses.map((value) => (
              <option key={value} value={value}>{STATUS_LABELS[value]}</option>
            ))}
          </select>
        </label>
        <label>
          タグ（カンマ区切り）
          <input value={tags} onChange={(event) => setTags(event.target.value)} />
        </label>
        <label>
          サムネイルArtifact ID
          <input value={thumbnailId} onChange={(event) => setThumbnailId(event.target.value)} />
        </label>
        <label className="checkbox-field">
          <input type="checkbox" checked={favorite} onChange={(event) => setFavorite(event.target.checked)} />
          お気に入り
        </label>
        {error && <p className="error">{error}</p>}
        <div className="row">
          <button type="button" disabled={busy} onClick={onCancel}>キャンセル</button>
          <button type="submit" className="primary" disabled={busy}>{busy ? "保存中..." : "保存"}</button>
        </div>
      </form>
    </section>
  );
}
