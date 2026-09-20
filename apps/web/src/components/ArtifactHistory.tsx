import { useCallback, useEffect, useMemo, useState } from "react";

import { ApiError, api } from "../api/client";
import type {
  Artifact,
  CanonStatus,
  GenerationJob,
  GenerationManifest,
  JobLineage,
} from "../api/client";
import { ArtifactDetail } from "./ArtifactDetail";
import { CanonWarning } from "./CanonWarning";

interface Detail {
  artifact: Artifact;
  job: GenerationJob;
  manifest: GenerationManifest;
  canonStatus: CanonStatus;
  lineage: JobLineage;
}

interface Props {
  shotId: string | null;
  /** Job を投入したときに値を変え、履歴を取り直させる。 */
  refreshToken: number;
  onDerivedJob: (job: GenerationJob) => void;
}

function describe(error: unknown): string {
  if (error instanceof ApiError) {
    return error.requestId
      ? `${error.message} (${error.code} / request_id=${error.requestId})`
      : `${error.message} (${error.code})`;
  }
  return String(error);
}

export function ArtifactHistory({ shotId, refreshToken, onDerivedJob }: Props) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(
    null,
  );
  const [includeRecords, setIncludeRecords] = useState(false);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!shotId) {
      setArtifacts([]);
      setSelectedArtifactId(null);
      return;
    }
    let active = true;
    (async () => {
      try {
        const list = await api.listArtifacts({
          shotId,
          kind: includeRecords ? undefined : "image",
        });
        if (!active) return;
        setArtifacts(list);
        setSelectedArtifactId((current) =>
          current && list.some((item) => item.id === current)
            ? current
            : (list[0]?.id ?? null),
        );
      } catch (cause) {
        if (active) setError(describe(cause));
      }
    })();
    return () => {
      active = false;
    };
  }, [shotId, includeRecords, refreshToken]);

  const selected = useMemo(
    () => artifacts.find((item) => item.id === selectedArtifactId) ?? null,
    [artifacts, selectedArtifactId],
  );

  const loadDetail = useCallback(async (artifact: Artifact) => {
    const job = await api.getJob(artifact.job_id);
    const [manifest, canonStatus, lineage] = await Promise.all([
      api.getManifest(job.manifest_id),
      api.getCanonStatus(job.id),
      api.getLineage(job.id),
    ]);
    return { artifact, job, manifest, canonStatus, lineage };
  }, []);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let active = true;
    (async () => {
      try {
        const loaded = await loadDetail(selected);
        if (active) setDetail(loaded);
      } catch (cause) {
        if (active) setError(describe(cause));
      }
    })();
    return () => {
      active = false;
    };
  }, [selected, loadDetail, refreshToken]);

  const derive = async (mode: "replay" | "regenerate") => {
    if (!detail) return;
    setBusy(true);
    setError(null);
    try {
      const job =
        mode === "replay"
          ? await api.replayJob(detail.job.id)
          : await api.regenerateJob(detail.job.id);
      onDerivedJob(job);
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel history">
      <h2>Artifact履歴</h2>
      {error && (
        <div className="error">
          <div>{error}</div>
          <button type="button" onClick={() => setError(null)}>
            閉じる
          </button>
        </div>
      )}
      <label className="row">
        <input
          type="checkbox"
          checked={includeRecords}
          onChange={(event) => setIncludeRecords(event.target.checked)}
        />
        Workflowと記録用のArtifactも表示する
      </label>

      <div className="history-body">
        <ul className="list">
          {artifacts.map((artifact) => (
            <li key={artifact.id}>
              <button
                type="button"
                aria-pressed={artifact.id === selectedArtifactId}
                onClick={() => setSelectedArtifactId(artifact.id)}
              >
                <span className="row">
                  <span className="badge">{artifact.kind}</span>
                  <span className="muted">{artifact.created_at}</span>
                </span>
                <span className="mono">{artifact.sha256.slice(0, 16)}</span>
              </button>
            </li>
          ))}
        </ul>
        {artifacts.length === 0 && (
          <p className="muted">このShotのArtifactはまだありません。</p>
        )}

        {detail && (
          <div className="stack">
            <CanonWarning status={detail.canonStatus} job={detail.job} />

            <div className="row">
              <button
                type="button"
                className="primary"
                disabled={busy || !detail.canonStatus.replayable}
                onClick={() => derive("replay")}
              >
                当時の条件で再実行
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => derive("regenerate")}
              >
                現在のCanonで再生成
              </button>
            </div>

            <ArtifactDetail
              artifact={detail.artifact}
              job={detail.job}
              manifest={detail.manifest}
              lineage={detail.lineage}
            />
          </div>
        )}
      </div>
    </section>
  );
}
