import { useEffect, useMemo, useState } from "react";

import { ApiError, api } from "../api/client";
import type {
  Artifact,
  GenerationJob,
  GenerationManifest,
  JobLineage,
} from "../api/client";
import type { SceneSummary, ShotSummary } from "../api/aimedia";
import { ArtifactDetail } from "./ArtifactDetail";
import { ArtifactPreview, mediaLabel } from "./ArtifactPreview";
import { DECISION_LABEL, DECISION_OPTIONS } from "./CandidateGallery";

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
}: Props) {
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
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // 0件が「条件に合わない」のか「取得に失敗した」のかを区別する。
  const [listFailed, setListFailed] = useState(false);
  const [busyArtifactId, setBusyArtifactId] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

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
        const [manifest, lineage] = await Promise.all([
          api.getManifest(job.manifest_id),
          api.getLineage(job.id),
        ]);
        if (active) setDetail({ job, manifest, lineage });
      } catch (cause) {
        if (!active) return;
        setDetail(null);
        setError(describe(cause));
      }
    })();
    return () => {
      active = false;
    };
  }, [selectedJobId]);

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

  return (
    <section className="panel asset-browser">
      <h2>資産ブラウザ</h2>
      {error && (
        <div className="error">
          <div>{error}</div>
          <button type="button" onClick={() => setError(null)}>
            閉じる
          </button>
        </div>
      )}

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
          {artifacts.length === 0 && !loading ? (
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
          {selected && detail ? (
            <>
              <div className="row">
                <button
                  type="button"
                  onClick={() => {
                    setLineageArtifactId(null);
                    setLineageJobId(detail.job.id);
                  }}
                >
                  このJobの派生で絞り込む
                </button>
              </div>

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
              <ArtifactDetail
                artifact={selected}
                job={detail.job}
                manifest={detail.manifest}
                lineage={detail.lineage}
              />
            </>
          ) : (
            <p className="muted">
              Artifactを選ぶと、出自とlineageを表示します。
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
