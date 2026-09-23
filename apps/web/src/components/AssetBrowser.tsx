import { useEffect, useMemo, useState } from "react";

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
import type { SceneSummary, ShotSummary } from "../api/aimedia";
import { ArtifactDetail } from "./ArtifactDetail";
import { ArtifactPreview, mediaLabel } from "./ArtifactPreview";
import { CanonWarning } from "./CanonWarning";
import { DECISION_LABEL, DECISION_OPTIONS } from "./CandidateGallery";
import { ExternalImageImportPanel } from "./ExternalImageImportPanel";
import { AssignmentPicker } from "./AssignmentPicker";
import { LoadingPlaceholder } from "./LoadingPlaceholder";
import { MediaViewer } from "./MediaViewer";
import { Icon } from "./ui/Icon";
import { IconButton } from "./ui/IconButton";
import { useNotify } from "./ui/notify";

const KIND_OPTIONS = [
  { value: "image", label: "画像" },
  { value: "video", label: "動画" },
  { value: "audio", label: "音声・音楽" },
  { value: "workflow", label: "Workflowスナップショット" },
  { value: "log", label: "ログ" },
];

const AVAILABILITY_OPTIONS = [
  { value: "complete", label: "実ファイルあり" },
  { value: "incomplete", label: "実ファイル欠損" },
];

/** 一度に取る件数。資産ブラウザは全件走査ではなく新しい順の窓で見る。 */
const PAGE_SIZE = 60;

/**
 * 選択したArtifactの出自。Artifact自体は持たず、一覧側の最新の値を使う。
 *
 * タグを付け外しすると一覧を取り直すため、Artifactの参照は毎回変わる。ここへ
 * 抱え込むと、変わっていないJob・Manifest・lineageまで取り直すことになる。
 */
interface Detail {
  job: GenerationJob;
  manifest: GenerationManifest;
  canonStatus: CanonStatus;
  lineage: JobLineage;
}

interface Props {
  projectId: string | null;
  scenes: SceneSummary[];
  sceneId: string | null;
  onSelectScene: (sceneId: string | null) => void;
  shots: ShotSummary[];
  shotId: string | null;
  onSelectShot: (shotId: string | null) => void;
  projects: ProjectRecord[];
  onDeriveArtifact: (artifactId: string) => void;
  /** 再実行で作ったJobを、投入直後と同じようにキューへ反映する。 */
  onRerunJob: (job: GenerationJob) => void;
}

function describe(error: unknown): string {
  if (error instanceof ApiError) {
    return error.requestId
      ? `${error.message} (${error.code} / request_id=${error.requestId})`
      : `${error.message} (${error.code})`;
  }
  return String(error);
}

export function AssetBrowser({
  projectId,
  scenes,
  sceneId,
  onSelectScene,
  shots,
  shotId,
  onSelectShot,
  projects,
  onDeriveArtifact,
  onRerunJob,
}: Props) {
  const notify = useNotify();
  const [kind, setKind] = useState("");
  const [decision, setDecision] = useState("");
  const [availability, setAvailability] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState("");
  // 選択中のArtifactへ付けるタグ。絞込み用の入力とは別に持つ。
  const [assignDraft, setAssignDraft] = useState("");
  // 派生関係の起点。指定したArtifact/Jobの祖先と子孫だけへ絞る。
  const [lineageArtifactId, setLineageArtifactId] = useState<string | null>(
    null,
  );
  const [lineageJobId, setLineageJobId] = useState<string | null>(null);

  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(
    null,
  );
  const [detail, setDetail] = useState<Detail | null>(null);
  const [importDetail, setImportDetail] = useState<ArtifactImport | null>(null);
  const [importLookup, setImportLookup] = useState<{
    artifactId: string;
    state: "loading" | "found" | "not-found" | "failed";
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // 0件が「条件に合わない」のか「取得に失敗した」のかを区別する。
  const [listFailed, setListFailed] = useState(false);
  const [busyArtifactId, setBusyArtifactId] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batchTag, setBatchTag] = useState("");
  const [batchBusy, setBatchBusy] = useState(false);
  const [rerunBusy, setRerunBusy] = useState(false);
  // 再実行するとcanon整合の判定が変わる。一覧とは別に詳細だけ取り直す。
  const [detailToken, setDetailToken] = useState(0);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    (async () => {
      try {
        const list = await api.listArtifacts({
          projectId: projectId ?? undefined,
          sceneId: sceneId ?? undefined,
          shotId: shotId ?? undefined,
          unassigned: !projectId,
          kind: kind || undefined,
          decision: decision || undefined,
          availability: availability || undefined,
          tags: tags.length > 0 ? tags : undefined,
          lineageArtifactId: lineageArtifactId ?? undefined,
          lineageJobId: lineageJobId ?? undefined,
          limit: PAGE_SIZE,
        });
        if (!active) return;
        setListFailed(false);
        setArtifacts(list);
        setSelectedIds((current) =>
          current.filter((id) => list.some((item) => item.id === id)),
        );
        setSelectedArtifactId((current) =>
          current && list.some((item) => item.id === current)
            ? current
            : (list[0]?.id ?? null),
        );
      } catch (cause) {
        if (!active) return;
        // 失敗した条件の結果を残すと、表示が最新の絞込みを反映しているか判らない。
        setArtifacts([]);
        setSelectedArtifactId(null);
        setListFailed(true);
        setError(describe(cause));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [
    projectId,
    sceneId,
    shotId,
    kind,
    decision,
    availability,
    tags,
    lineageArtifactId,
    lineageJobId,
    reloadToken,
  ]);

  const selected = useMemo(
    () => artifacts.find((item) => item.id === selectedArtifactId) ?? null,
    [artifacts, selectedArtifactId],
  );

  const selectedJobId = selected?.job_id ?? null;
  const selectedDetail =
    detail?.job.id === selectedJobId ? detail : null;
  const selectedImportDetail =
    importDetail?.artifact_id === selected?.id ? importDetail : null;
  const selectedImportState =
    importLookup && importLookup.artifactId === selected?.id
      ? importLookup.state
      : "loading";

  useEffect(() => {
    if (!selectedJobId) {
      setDetail(null);
      return;
    }
    let active = true;
    // 取得が終わるまで前の詳細を残さない。選択と違うArtifactの出自を見せない。
    setDetail(null);
    (async () => {
      try {
        const job = await api.getJob(selectedJobId);
        const [manifest, canonStatus, lineage] = await Promise.all([
          api.getManifest(job.manifest_id),
          api.getCanonStatus(job.id),
          api.getLineage(job.id),
        ]);
        if (active) setDetail({ job, manifest, canonStatus, lineage });
      } catch (cause) {
        if (!active) return;
        setDetail(null);
        setError(describe(cause));
      }
    })();
    return () => {
      active = false;
    };
  }, [selectedJobId, detailToken]);

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

  const addTagFilter = () => {
    const value = tagDraft.trim();
    if (!value || tags.includes(value)) {
      setTagDraft("");
      return;
    }
    setTags((current) => [...current, value]);
    setTagDraft("");
  };

  // タグを変えると絞込み条件との一致も変わる。手元の配列を書き換えるだけでは
  // 条件から外れたArtifactが残るため、一覧ごと取り直す。
  const applyTag = async (artifact: Artifact, tag: string) => {
    setBusyArtifactId(artifact.id);
    setError(null);
    try {
      await api.addArtifactTag(artifact.id, tag);
      setReloadToken((current) => current + 1);
      return true;
    } catch (cause) {
      setError(describe(cause));
      return false;
    } finally {
      setBusyArtifactId(null);
    }
  };

  const dropTag = async (artifact: Artifact, tag: string) => {
    setBusyArtifactId(artifact.id);
    setError(null);
    try {
      await api.removeArtifactTag(artifact.id, tag);
      setReloadToken((current) => current + 1);
      notify({
        tone: "success",
        message: `タグ「${tag}」を外しました`,
        action: {
          label: "取り消す",
          onAction: async () => {
            await api.addArtifactTag(artifact.id, tag);
            setReloadToken((current) => current + 1);
          },
        },
      });
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusyArtifactId(null);
    }
  };

  const assignTag = async (artifact: Artifact) => {
    const value = assignDraft.trim();
    if (!value) return;
    // 失敗したときは入力を残す。打ち直さずに再送できる。
    if (await applyTag(artifact, value)) {
      setAssignDraft("");
    }
  };

  const clearFilters = () => {
    setKind("");
    setDecision("");
    setAvailability("");
    setTags([]);
    setTagDraft("");
    setLineageArtifactId(null);
    setLineageJobId(null);
  };

  const lineageActive = lineageArtifactId !== null || lineageJobId !== null;

  /** 選択中のArtifactを作ったJobを、当時の条件または現在のCanonで実行し直す。 */
  const rerun = async (mode: "replay" | "regenerate") => {
    if (!selectedDetail) return;
    setRerunBusy(true);
    setError(null);
    try {
      const job =
        mode === "replay"
          ? await api.replayJob(selectedDetail.job.id)
          : await api.regenerateJob(selectedDetail.job.id);
      onRerunJob(job);
      // 再実行したJobの記録も一覧へ出す。成果物はJobの完了後、「再取得」で現れる。
      setReloadToken((current) => current + 1);
      setDetailToken((current) => current + 1);
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setRerunBusy(false);
    }
  };

  const operateSelected = async (
    operation: "move" | "copy" | "unassign" | "tag",
    target?: AssignmentTarget,
    tag?: string,
  ) => {
    if (selectedIds.length === 0) return;
    setBatchBusy(true);
    setError(null);
    try {
      await api.operateArtifacts({
        artifact_ids: selectedIds,
        operation,
        target,
        tag,
      });
      setSelectedIds([]);
      setBatchTag("");
      setReloadToken((current) => current + 1);
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBatchBusy(false);
    }
  };

  return (
    <section className="panel asset-browser">
      <h2>{projectId ? "資産ブラウザ" : "資産ブラウザ・Inbox"}</h2>
      {error && (
        <div className="error">
          <div>{error}</div>
          <button type="button" onClick={() => setError(null)}>
            閉じる
          </button>
        </div>
      )}
      <ExternalImageImportPanel
        assignment={{
          project_id: projectId,
          scene_id: projectId ? sceneId : null,
          shot_id: projectId && sceneId ? shotId : null,
        }}
        onImported={async () => {
          setReloadToken((current) => current + 1);
        }}
      />

      <div className="panel stack assignment-batch">
        <div className="row spread">
          <strong>一括操作</strong>
          <span className="muted">{selectedIds.length}件選択中</span>
        </div>
        <AssignmentPicker
          projects={projects}
          disabled={batchBusy || selectedIds.length === 0}
          onMove={(target) => operateSelected("move", target)}
          onCopy={(target) => operateSelected("copy", target)}
        />
        <div className="row">
          <input
            value={batchTag}
            disabled={batchBusy || selectedIds.length === 0}
            onChange={(event) => setBatchTag(event.target.value)}
            placeholder="一括付与するタグ"
          />
          <button
            type="button"
            disabled={
              batchBusy || selectedIds.length === 0 || !batchTag.trim()
            }
            onClick={() =>
              void operateSelected("tag", undefined, batchTag.trim())
            }
          >
            タグ付与
          </button>
          <button
            type="button"
            disabled={batchBusy || selectedIds.length === 0}
            onClick={() => void operateSelected("unassign")}
          >
            Inboxへ移動
          </button>
          <button
            type="button"
            disabled={batchBusy || artifacts.length === 0}
            onClick={() =>
              setSelectedIds(
                selectedIds.length === artifacts.length
                  ? []
                  : artifacts.map((artifact) => artifact.id),
              )
            }
          >
            {selectedIds.length === artifacts.length ? "選択解除" : "すべて選択"}
          </button>
        </div>
      </div>

      <div className="filters">
        <div>
          <label htmlFor="asset-scene">Scene</label>
          <select
            id="asset-scene"
            value={sceneId ?? ""}
            onChange={(event) => onSelectScene(event.target.value || null)}
          >
            <option value="">すべて</option>
            {scenes.map((scene) => (
              <option key={scene.id} value={scene.id}>
                {scene.sequence}. {scene.summary}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="asset-shot">Shot</label>
          <select
            id="asset-shot"
            value={shotId ?? ""}
            onChange={(event) => onSelectShot(event.target.value || null)}
          >
            <option value="">すべて</option>
            {shots.map((shot) => (
              <option key={shot.id} value={shot.id}>
                {shot.sequence}. {shot.summary}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="asset-kind">種別</label>
          <select
            id="asset-kind"
            value={kind}
            onChange={(event) => setKind(event.target.value)}
          >
            <option value="">すべて</option>
            {KIND_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="asset-decision">採否</label>
          <select
            id="asset-decision"
            value={decision}
            onChange={(event) => setDecision(event.target.value)}
          >
            <option value="">すべて</option>
            {DECISION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="asset-availability">実ファイル</label>
          <select
            id="asset-availability"
            value={availability}
            onChange={(event) => setAvailability(event.target.value)}
          >
            <option value="">すべて</option>
            {AVAILABILITY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="asset-tag">タグ (すべて付いたものだけ)</label>
          <div className="row">
            <input
              id="asset-tag"
              value={tagDraft}
              onChange={(event) => setTagDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addTagFilter();
                }
              }}
              placeholder="タグを追加"
            />
            <button type="button" onClick={addTagFilter}>
              追加
            </button>
          </div>
        </div>
      </div>

      <div className="row">
        {tags.map((tag) => (
          <button
            key={tag}
            type="button"
            className="badge"
            onClick={() =>
              setTags((current) => current.filter((item) => item !== tag))
            }
          >
            {tag} ×
          </button>
        ))}
        {lineageActive && (
          <span className="badge">
            派生で絞込み中:{" "}
            <span className="mono">{lineageArtifactId ?? lineageJobId}</span>
          </span>
        )}
        <button type="button" onClick={clearFilters}>
          絞込みを解除
        </button>
        <button type="button" onClick={() => setReloadToken((n) => n + 1)}>
          再取得
        </button>
        <span className="muted">
          {loading ? "取得中" : `${artifacts.length} 件`}
          {artifacts.length >= PAGE_SIZE ? ` (上限 ${PAGE_SIZE} 件まで)` : ""}
        </span>
      </div>

      <div className="asset-body">
        <div>
          {loading && artifacts.length === 0 ? (
            <LoadingPlaceholder label="取得中" lines={6} variant="tiles" />
          ) : artifacts.length === 0 ? (
            <p className="muted">
              {listFailed
                ? "一覧を取得できませんでした。条件を変えるか再取得してください。"
                : "条件に合うArtifactがありません。"}
            </p>
          ) : (
            <div className="gallery">
              {artifacts.map((artifact) => (
                <figure
                  key={artifact.id}
                  className={`${artifact.decision}${
                    artifact.id === selectedArtifactId ? " current" : ""
                  }`}
                >
                  <label className="checkbox-field">
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(artifact.id)}
                      onChange={(event) =>
                        setSelectedIds((current) =>
                          event.target.checked
                            ? [...current, artifact.id]
                            : current.filter((id) => id !== artifact.id),
                        )
                      }
                    />
                    一括操作に選択
                  </label>
                  <ArtifactPreview artifact={artifact} compact />
                  <figcaption>
                    <span className="row">
                      <span className="badge">{artifact.kind}</span>
                      <span className="badge">
                        {mediaLabel(artifact.media_type)}
                      </span>
                      <span className="muted">
                        {DECISION_LABEL[artifact.decision] ?? artifact.decision}
                      </span>
                      {artifact.availability !== "complete" && (
                        <span className="badge change-missing">欠損</span>
                      )}
                    </span>
                    <span className="mono">{artifact.sha256.slice(0, 12)}</span>
                    <span className="row">
                      {(artifact.tags ?? []).map((tag) => (
                        <span key={tag} className="badge">
                          {tag}
                        </span>
                      ))}
                    </span>
                    <div className="row">
                      <IconButton
                        icon={<Icon name="expand" />}
                        label="拡大"
                        onClick={() =>
                          setViewerIndex(
                            artifacts.findIndex((item) => item.id === artifact.id),
                          )
                        }
                      />
                      <button
                        type="button"
                        aria-pressed={artifact.id === selectedArtifactId}
                        onClick={() => setSelectedArtifactId(artifact.id)}
                      >
                        詳細
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setLineageJobId(null);
                          setLineageArtifactId(artifact.id);
                        }}
                      >
                        派生を辿る
                      </button>
                    </div>
                  </figcaption>
                </figure>
              ))}
            </div>
          )}
        </div>

        <div className="stack">
          {selected ? (
            <>
              {selectedDetail && (
                <div className="row">
                  <button
                    type="button"
                    onClick={() => {
                      setLineageArtifactId(null);
                      setLineageJobId(selectedDetail.job.id);
                    }}
                  >
                    このJobの派生で絞り込む
                  </button>
                </div>
              )}

              <div className="stack">
                <label htmlFor="asset-detail-tag">タグ</label>
                <div className="row">
                  {(selected.tags ?? []).map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      className="badge"
                      disabled={busyArtifactId === selected.id}
                      onClick={() => void dropTag(selected, tag)}
                      title="クリックでタグを外す"
                    >
                      {tag} ×
                    </button>
                  ))}
                  {(selected.tags ?? []).length === 0 && (
                    <span className="muted">タグなし</span>
                  )}
                </div>
                <div className="row">
                  <input
                    id="asset-detail-tag"
                    value={assignDraft}
                    onChange={(event) => setAssignDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void assignTag(selected);
                      }
                    }}
                    placeholder="付けるタグ"
                  />
                  <button
                    type="button"
                    disabled={busyArtifactId === selected.id}
                    onClick={() => void assignTag(selected)}
                  >
                    付与
                  </button>
                </div>
              </div>
              <ArtifactPreview artifact={selected} />
              {selected.kind === "image" && selected.availability === "complete" && (
                <button
                  type="button"
                  className="primary"
                  onClick={() => onDeriveArtifact(selected.id)}
                >
                  この画像から派生生成
                </button>
              )}
              {selectedDetail ? (
                <>
                  <CanonWarning
                    status={selectedDetail.canonStatus}
                    job={selectedDetail.job}
                  />
                  <div className="row">
                    <button
                      type="button"
                      className="primary"
                      disabled={
                        rerunBusy || !selectedDetail.canonStatus.replayable
                      }
                      onClick={() => void rerun("replay")}
                    >
                      当時の条件で再実行
                    </button>
                    <button
                      type="button"
                      disabled={rerunBusy}
                      onClick={() => void rerun("regenerate")}
                    >
                      現在のCanonで再生成
                    </button>
                  </div>
                  <ArtifactDetail
                    artifact={selected}
                    job={selectedDetail.job}
                    manifest={selectedDetail.manifest}
                    lineage={selectedDetail.lineage}
                  />
                </>
              ) : selectedImportDetail ? (
                <div className="stack">
                  <h3>外部画像の来歴</h3>
                  <p>元ファイル:{selectedImportDetail.original_file_name}</p>
                  <p>形式:{selectedImportDetail.source_format}</p>
                  <details>
                    <summary>取込メタデータ</summary>
                    <pre>
                      {JSON.stringify(selectedImportDetail.raw_metadata, null, 2)}
                    </pre>
                  </details>
                  <details open>
                    <summary>Recipe下書き（実行不可）</summary>
                    <pre>
                      {JSON.stringify(selectedImportDetail.recipe_draft, null, 2)}
                    </pre>
                  </details>
                </div>
              ) : selectedImportState === "loading" ? (
                <p className="muted">外部来歴を確認中です。</p>
              ) : selectedImportState === "failed" ? (
                <p className="error">外部来歴を取得できませんでした。</p>
              ) : (
                <p className="muted">生成Jobを持たないArtifactです。</p>
              )}
            </>
          ) : (
            <p className="muted">
              Artifactを選ぶと、出自とlineageを表示します。
            </p>
          )}
        </div>
      </div>
      <MediaViewer
        items={artifacts}
        index={viewerIndex}
        onIndexChange={setViewerIndex}
        onClose={() => setViewerIndex(null)}
      />
    </section>
  );
}
