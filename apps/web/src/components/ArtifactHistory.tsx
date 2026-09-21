import { useCallback, useEffect, useMemo, useState } from "react";

import { ApiError, api } from "../api/client";
import type {
  Artifact,
  ArtifactImport,
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
  const [importDetail, setImportDetail] = useState<ArtifactImport | null>(null);
  const [importLookup, setImportLookup] = useState<{
    artifactId: string;
    state: "loading" | "found" | "not-found" | "failed";
  } | null>(null);
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
  const selectedDetail =
    detail?.artifact.id === selected?.id ? detail : null;

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

  useEffect(() => {
    if (!selected || selected.job_id) {
      setImportDetail(null);
      setImportLookup(null);
      return;
    }
    let active = true;
    setImportDetail(null);
    setImportLookup({ artifactId: selected.id, state: "loading" });
    api
      .getArtifactImport(selected.id)
      .then((result) => {
        if (active) {
          setImportDetail(result);
          setImportLookup({ artifactId: selected.id, state: "found" });
        }
      })
      .catch((cause) => {
        if (!active) return;
        if (!(cause instanceof ApiError && cause.code === "RESOURCE_NOT_FOUND")) {
          setError(describe(cause));
          setImportLookup({ artifactId: selected.id, state: "failed" });
        } else {
          setImportLookup({ artifactId: selected.id, state: "not-found" });
        }
      });
    return () => {
      active = false;
    };
  }, [selected]);

  const derive = async (mode: "replay" | "regenerate") => {
    if (!selectedDetail) return;
    setBusy(true);
    setError(null);
    try {
      const job =
        mode === "replay"
          ? await api.replayJob(selectedDetail.job.id)
          : await api.regenerateJob(selectedDetail.job.id);
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

        {selectedDetail && (
          <div className="stack">
            <CanonWarning
              status={selectedDetail.canonStatus}
              job={selectedDetail.job}
            />

            <div className="row">
              <button
                type="button"
                className="primary"
                disabled={busy || !selectedDetail.canonStatus.replayable}
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
                initialProjectId={selectedDetail.artifact.assigned_project_id}
                initialSceneId={selectedDetail.artifact.assigned_scene_id}
                initialShotId={selectedDetail.artifact.assigned_shot_id}
                onMove={(target) =>
                  changeAssignment(selectedDetail.artifact, "move", target)
                }
                onCopy={(target) =>
                  changeAssignment(selectedDetail.artifact, "copy", target)
                }
              />
            </div>

            <ArtifactDetail
              artifact={selectedDetail.artifact}
              job={selectedDetail.job}
              manifest={selectedDetail.manifest}
              lineage={selectedDetail.lineage}
            />
          </div>
        )}
        {selected && !selected.job_id && (
          <div className="stack">
            <h3>
              {importDetail?.artifact_id === selected.id
                ? "外部画像"
                : importLookup?.artifactId === selected.id &&
                    importLookup.state === "loading"
                  ? "外部来歴を確認中"
                  : importLookup?.artifactId === selected.id &&
                      importLookup.state === "failed"
                    ? "外部来歴"
                  : "移行したArtifact"}
            </h3>
            {importDetail?.artifact_id === selected.id ? (
              <>
                <p>元ファイル:{importDetail.original_file_name}</p>
                <p>形式:{importDetail.source_format}</p>
                <details>
                  <summary>取込メタデータ</summary>
                  <pre>{JSON.stringify(importDetail.raw_metadata, null, 2)}</pre>
                </details>
                <details>
                  <summary>Recipe下書き（実行不可）</summary>
                  <pre>{JSON.stringify(importDetail.recipe_draft, null, 2)}</pre>
                </details>
              </>
            ) : importLookup?.artifactId === selected.id &&
              importLookup.state === "loading" ? (
              <p className="muted">外部来歴を確認中です。</p>
            ) : importLookup?.artifactId === selected.id &&
              importLookup.state === "failed" ? (
              <p className="error">外部来歴を取得できませんでした。</p>
            ) : (
              <p className="muted">
                元のGeneration Jobを含まない可搬packageから取り込みました。ファイルと所属は利用できますが、再実行と生成時の詳細表示はできません。
              </p>
            )}
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
