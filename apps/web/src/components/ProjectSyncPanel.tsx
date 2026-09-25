import { useEffect, useState } from "react";
import type { FormEvent } from "react";

import { ApiError, api } from "../api/client";
import type { ExternalProjectCandidate, ProjectRecord } from "../api/client";

function describe(error: unknown): string {
  if (error instanceof ApiError) return `${error.message} (${error.code})`;
  return String(error);
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
        // 同期操作の画面を外したため、取り込みは一度きりとし自動同期は付けない。
        auto_sync: false,
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
