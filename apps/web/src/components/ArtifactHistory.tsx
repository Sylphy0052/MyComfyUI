import { useCallback, useEffect, useMemo, useState } from "react";

import { ApiError, api } from "../api/client";
import type {
  Artifact,
  CanonStatus,
  GenerationJob,
  GenerationManifest,
  JobLineage,
  ProjectRecord,
  AssignmentTarget,
} from "../api/client";
import { AssignmentPicker } from "./AssignmentPicker";
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
  unassigned: boolean;
  /** Job を投入したときに値を変え、履歴を取り直させる。 */
  refreshToken: number;
  onDerivedJob: (job: GenerationJob) => void;
  projects: ProjectRecord[];
  onAssignmentsChanged: () => Promise<void>;
}

function describe(error: unknown): string {
  if (error instanceof ApiError) {
    return error.requestId
      ? `${error.message} (${error.code} / request_id=${error.requestId})`
      : `${error.message} (${error.code})`;
  }
  return String(error);
}

export function ArtifactHistory({
  shotId,
  unassigned,
  refreshToken,
  onDerivedJob,
  projects,
  onAssignmentsChanged,
}: Props) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(
    null,
  );
  const [includeRecords, setIncludeRecords] = useState(false);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [assignmentToken, setAssignmentToken] = useState(0);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const list = await api.listArtifacts({
          shotId: shotId ?? undefined,
          unassigned,
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
  }, [shotId, unassigned, includeRecords, refreshToken, assignmentToken]);

  const selected = useMemo(
    () => artifacts.find((item) => item.id === selectedArtifactId) ?? null,
    [artifacts, selectedArtifactId],
  );

  const loadDetail = useCallback(async (artifact: Artifact) => {
    if (!artifact.job_id) return null;
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

  const changeAssignment = async (
    artifact: Artifact,
    operation: "move" | "copy",
    target: AssignmentTarget,
  ) => {
    await api.operateArtifacts({
      artifact_ids: [artifact.id],
      operation,
      target,
    });
    setAssignmentToken((current) => current + 1);
    await onAssignmentsChanged();
  };

  return (
    <section className="panel history">
      <h2>{unassigned ? "Artifact履歴・Inbox" : "Artifact履歴"}</h2>
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
          <p className="muted">
            {unassigned
              ? "未所属のArtifactはまだありません。"
              : "このShotのArtifactはまだありません。"}
          </p>
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

            <div className="stack">
              <h2>Artifactの所属</h2>
              <AssignmentPicker
                projects={projects}
                initialProjectId={detail.artifact.assigned_project_id}
                initialSceneId={detail.artifact.assigned_scene_id}
                initialShotId={detail.artifact.assigned_shot_id}
                onMove={(target) =>
                  changeAssignment(detail.artifact, "move", target)
                }
                onCopy={(target) =>
                  changeAssignment(detail.artifact, "copy", target)
                }
              />
            </div>

            <ArtifactDetail
              artifact={detail.artifact}
              job={detail.job}
              manifest={detail.manifest}
              lineage={detail.lineage}
            />
          </div>
        )}
        {selected && !selected.job_id && (
          <div className="stack">
            <h3>移行したArtifact</h3>
            <p className="muted">元のGeneration Jobを含まない可搬packageから取り込みました。ファイルと所属は利用できますが、再実行と生成時の詳細表示はできません。</p>
            <a href={api.artifactContentUrl(selected.id)} target="_blank" rel="noreferrer">Artifactを開く</a>
            <AssignmentPicker
              projects={projects}
              initialProjectId={selected.assigned_project_id}
              initialSceneId={selected.assigned_scene_id}
              initialShotId={selected.assigned_shot_id}
              onMove={(target) => changeAssignment(selected, "move", target)}
              onCopy={(target) => changeAssignment(selected, "copy", target)}
            />
          </div>
        )}
      </div>
    </section>
  );
}
