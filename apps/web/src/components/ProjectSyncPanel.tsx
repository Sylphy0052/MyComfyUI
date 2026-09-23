import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

import { ApiError, api } from "../api/client";
import type {
  ExternalProjectCandidate,
  ProjectRecord,
  ProjectSyncPreview,
} from "../api/client";

function describe(error: unknown): string {
  if (error instanceof ApiError) return `${error.message} (${error.code})`;
  return String(error);
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString("ja-JP") : "未同期";
}

const SYNC_LABELS: Record<ProjectRecord["sync_state"], string> = {
  never: "未同期",
  synced: "同期済み",
  outdated: "更新あり",
  conflicted: "競合あり",
  failed: "同期失敗",
};

export function ProjectSyncPanel({
  project,
  onChanged,
}: {
  project: ProjectRecord;
  onChanged: (project: ProjectRecord) => Promise<void>;
}) {
  const [preview, setPreview] = useState<ProjectSyncPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoAttempted = useRef(false);

  const apply = async (choice?: "local" | "external") => {
    if (
      choice === "external" &&
      !window.confirm("競合したローカル変更を外部変更で上書きします。上書きは取り消せません。続けますか？")
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const resolutions = (preview?.changes ?? [])
        .filter((change) => change.conflict)
        .map((change) => ({ path: change.path, choice: choice ?? "local" }));
      const saved = await api.syncProject(project.id, { resolutions });
      setPreview(null);
      await onChanged(saved);
    } catch (cause) {
      setError(describe(cause));
      if (cause instanceof ApiError && cause.code === "PROJECT_SYNC_CONFLICT") {
        try {
          setPreview(await api.previewProjectSync(project.id));
        } catch (previewCause) {
          setError(describe(previewCause));
        }
      }
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!project.auto_sync || autoAttempted.current) return;
    autoAttempted.current = true;
    void apply();
  }, [project.id, project.auto_sync]);

  const inspect = async () => {
    setBusy(true);
    setError(null);
    try {
      setPreview(await api.previewProjectSync(project.id));
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  const toggleAutoSync = async () => {
    setBusy(true);
    setError(null);
    try {
      await onChanged(
        await api.updateProjectSyncSettings(project.id, !project.auto_sync),
      );
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="project-sync-panel">
      <div className="row spread">
        <h3>外部同期</h3>
        <span className={`badge ${project.sync_state === "failed" ? "failed" : ""}`}>
          {SYNC_LABELS[project.sync_state]}
        </span>
      </div>
      <dl className="kv">
        <dt>参照元</dt><dd className="mono">{project.source.source_locator}</dd>
        <dt>revision</dt><dd className="mono">{project.source.revision}</dd>
        <dt>最終同期</dt><dd>{formatDate(project.last_synced_at)}</dd>
        <dt>snapshot</dt><dd className="mono">{project.source_snapshot_sha256 ?? "未作成"}</dd>
      </dl>
      <label className="checkbox-field">
        <input
          type="checkbox"
          checked={project.auto_sync}
          disabled={busy}
          onChange={toggleAutoSync}
        />
        Projectを開いたとき自動同期
      </label>
      {project.sync_error && <p className="error">{project.sync_error}</p>}
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button type="button" disabled={busy} onClick={inspect}>差分を確認</button>
        <button type="button" className="primary" disabled={busy} onClick={() => apply()}>
          {busy ? "同期中..." : project.sync_state === "failed" ? "再試行" : "今すぐ同期"}
        </button>
      </div>
      {preview && (
        <div className="sync-preview">
          <h4>同期差分</h4>
          <p className="muted">取得revision: {preview.source_revision}</p>
          {preview.changes.length === 0 ? (
            <p>外部変更はありません。</p>
          ) : (
            <ul>
              {preview.changes.map((change) => (
                <li key={change.path}>
                  <span className="badge">{change.action}</span> {change.path}
                  {change.conflict && <strong className="danger-text"> 競合</strong>}
                </li>
              ))}
            </ul>
          )}
          {preview.has_conflicts ? (
            <div className="row">
              <button type="button" disabled={busy} onClick={() => apply("local")}>
                ローカル変更を保つ
              </button>
              <button type="button" className="primary" disabled={busy} onClick={() => apply("external")}>
                外部変更を採用
              </button>
            </div>
          ) : preview.changes.length > 0 ? (
            <button type="button" className="primary" disabled={busy} onClick={() => apply()}>
              この差分を同期
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}

export function ExternalProjectImporter({
  onCancel,
  onImported,
}: {
  onCancel: () => void;
  onImported: (project: ProjectRecord) => Promise<void>;
}) {
  const [candidates, setCandidates] = useState<ExternalProjectCandidate[]>([]);
  const [externalId, setExternalId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [autoSync, setAutoSync] = useState(true);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api.listExternalProjectCandidates()
      .then((result) => {
        if (!active) return;
        setCandidates(result.items);
        setExternalId(result.items.find((item) => !item.imported_project_id)?.id ?? "");
      })
      .catch((cause) => active && setError(describe(cause)))
      .finally(() => active && setBusy(false));
    return () => { active = false; };
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const saved = await api.importExternalProject({
        external_id: externalId,
        project_id: projectId || null,
        auto_sync: autoSync,
      });
      await onImported(saved);
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel project-editor" role="dialog" aria-modal="true" aria-labelledby="external-import-title">
      <h2 id="external-import-title">外部作品をインポート</h2>
      <form className="stack" onSubmit={submit}>
        <label>
          参照元の作品
          <select required value={externalId} onChange={(event) => setExternalId(event.target.value)}>
            <option value="">選択してください</option>
            {candidates.map((candidate) => (
              <option key={candidate.id} value={candidate.id} disabled={Boolean(candidate.imported_project_id)}>
                {candidate.title}{candidate.imported_project_id ? "（インポート済み）" : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          Project ID（省略時は参照元ID）
          <input value={projectId} pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,127}" onChange={(event) => setProjectId(event.target.value)} />
        </label>
        <label className="checkbox-field">
          <input type="checkbox" checked={autoSync} onChange={(event) => setAutoSync(event.target.checked)} />
          自動同期を有効にする
        </label>
        {error && <p className="error">{error}</p>}
        <div className="row">
          <button type="button" disabled={busy} onClick={onCancel}>キャンセル</button>
          <button type="submit" className="primary" disabled={busy || !externalId}>
            {busy ? "読込み中..." : "インポート"}
          </button>
        </div>
      </form>
    </section>
  );
}
