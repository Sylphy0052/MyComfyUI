import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import { api } from "../api/client";
import type { Artifact, ArtifactDecision, GenerationJob, GenerationManifest, JobLineage } from "../api/client";
import { ArtifactDetail } from "./ArtifactDetail";
import { ArtifactPreview } from "./ArtifactPreview";
import { LoadingPlaceholder } from "./LoadingPlaceholder";

export const DECISION_OPTIONS: { value: string; label: string }[] = [
  { value: "undecided", label: "未判断" },
  { value: "accepted", label: "採用" },
  { value: "rejected", label: "却下" },
];

export const DECISION_LABEL: Record<string, string> = Object.fromEntries(
  DECISION_OPTIONS.map((option) => [option.value, option.label]),
);

export interface Candidate { artifact: Artifact; jobId: string; }
interface Props {
  candidates: Candidate[];
  busyArtifactId: string | null;
  onDecide: (artifactId: string, decision: ArtifactDecision) => void;
  onDerive?: (artifactId: string) => void;
  active?: boolean;
  comparisonActive?: boolean;
  onClearComparison?: () => void;
}
type ThumbSize = "s" | "m" | "l";
const THUMB_SIZES: { value: ThumbSize; label: string }[] = [
  { value: "s", label: "S" },
  { value: "m", label: "M" },
  { value: "l", label: "L" },
];
interface CandidateDetail { job: GenerationJob; manifest: GenerationManifest; lineage: JobLineage | null; }
interface ViewTransform { zoom: number; x: number; y: number; }
const INITIAL_TRANSFORM: ViewTransform = { zoom: 1, x: 0, y: 0 };

function clampZoom(value: number): number { return Math.min(8, Math.max(0.25, value)); }
function format(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  return typeof value === "string" ? value : JSON.stringify(value);
}
function detailRows(detail: CandidateDetail | null): Record<string, unknown> {
  const parameters = detail?.manifest.parameters ?? {};
  return {
    model: detail?.manifest.model,
    seed: detail?.manifest.seed,
    prompt: detail?.manifest.resolved_prompt,
    negative: parameters.negative_prompt,
    steps: parameters.steps,
    cfg: parameters.cfg,
    width: parameters.width,
    height: parameters.height,
    workflow: parameters.workflow_template,
    workflow_sha256: parameters.workflow_template_sha256,
    workflow_artifact_id: detail?.manifest.workflow_artifact_id,
  };
}

function CompareImage({ artifact, transform, onTransform, label }: {
  artifact: Artifact | null;
  transform: ViewTransform;
  onTransform: (next: ViewTransform) => void;
  label: string;
}) {
  const drag = useRef<{ x: number; y: number } | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [artifact?.id]);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const wheel = (event: globalThis.WheelEvent) => {
      event.preventDefault();
      onTransform({
        ...transform,
        zoom: clampZoom(transform.zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15)),
      });
    };
    viewport.addEventListener("wheel", wheel, { passive: false });
    return () => viewport.removeEventListener("wheel", wheel);
  }, [onTransform, transform]);
  if (!artifact) return <div className="compare-empty">{label}を選択してください</div>;
  if (artifact.availability !== "complete" || failed) {
    return <div className="compare-empty">{label}の画像を取得できません。</div>;
  }
  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const dx = event.clientX - drag.current.x;
    const dy = event.clientY - drag.current.y;
    drag.current = { x: event.clientX, y: event.clientY };
    onTransform({ ...transform, x: transform.x + dx, y: transform.y + dy });
  };
  return (
    <div
      ref={viewportRef}
      className="compare-image-viewport"
      onPointerDown={(event) => {
        drag.current = { x: event.clientX, y: event.clientY };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={pointerMove}
      onPointerUp={(event) => {
        drag.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onPointerCancel={() => { drag.current = null; }}
    >
      <span className="compare-side-label">{label}</span>
      <img
        src={api.artifactContentUrl(artifact.id)}
        alt={`${label} ${artifact.id}`}
        onError={() => setFailed(true)}
        draggable={false}
        style={{ transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.zoom})` }}
      />
    </div>
  );
}

async function loadImage(url: string): Promise<HTMLImageElement> {
  return await new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("画像を読み込めませんでした。"));
    image.src = url;
  });
}

export function CandidateGallery({ candidates, busyArtifactId, onDecide, onDerive, active = true, comparisonActive = false, onClearComparison }: Props) {
  const [thumbSize, setThumbSize] = useState<ThumbSize>("m");
  const [leftId, setLeftId] = useState<string | null>(null);
  const [rightId, setRightId] = useState<string | null>(null);
  const [activeSide, setActiveSide] = useState<"A" | "B">("A");
  const [fullscreen, setFullscreen] = useState(false);
  const [syncTransform, setSyncTransform] = useState(true);
  const [leftTransform, setLeftTransform] = useState(INITIAL_TRANSFORM);
  const [rightTransform, setRightTransform] = useState(INITIAL_TRANSFORM);
  const [details, setDetails] = useState<Record<string, CandidateDetail>>({});
  const [error, setError] = useState<string | null>(null);
  const [sheetBusy, setSheetBusy] = useState(false);
  const [detailArtifactId, setDetailArtifactId] = useState<string | null>(null);
  const [metadataErrors, setMetadataErrors] = useState<Record<string, string>>({});
  const [lineageErrors, setLineageErrors] = useState<Record<string, string>>({});
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const ids = new Set(candidates.map(({ artifact }) => artifact.id));
    setLeftId((current) => current && ids.has(current) ? current : candidates[0]?.artifact.id ?? null);
    setRightId((current) => candidates.length > 1 && current && ids.has(current) ? current : candidates[1]?.artifact.id ?? null);
    setDetailArtifactId((current) => current && ids.has(current) ? current : null);
  }, [candidates]);

  const byId = useMemo(
    () => new Map(candidates.map((candidate) => [candidate.artifact.id, candidate])),
    [candidates],
  );
  const left = leftId ? byId.get(leftId)?.artifact ?? null : null;
  const right = rightId ? byId.get(rightId)?.artifact ?? null : null;

  useEffect(() => {
    let active = true;
    const missing = Array.from(
      new Set(
        [leftId, rightId, detailArtifactId].filter(
          (id): id is string => Boolean(id && byId.has(id) && !details[id] && !metadataErrors[id]),
        ),
      ),
    );
    if (!missing.length) return;
    void Promise.all(missing.map(async (artifactId) => {
      const candidate = byId.get(artifactId);
      if (!candidate) return null;
      try {
        const job = await api.getJob(candidate.jobId);
        const manifest = await api.getManifest(job.manifest_id);
        return { artifactId, detail: { job, manifest, lineage: null }, error: null };
      } catch (cause) {
        return { artifactId, detail: null, error: String(cause) };
      }
    })).then((entries) => {
      if (!active) return;
      const loaded = entries.filter(
        (entry): entry is { artifactId: string; detail: CandidateDetail; error: null } =>
          entry !== null && entry.detail !== null,
      );
      if (loaded.length) {
        setDetails((current) => ({
          ...current,
          ...Object.fromEntries(loaded.map((entry) => [entry.artifactId, entry.detail])),
        }));
      }
      const failed = entries.filter(
        (entry): entry is { artifactId: string; detail: null; error: string } =>
          entry !== null && entry.error !== null,
      );
      if (failed.length) {
        setMetadataErrors((current) => ({
          ...current,
          ...Object.fromEntries(failed.map((entry) => [entry.artifactId, entry.error])),
        }));
      }
    });
    return () => { active = false; };
  }, [leftId, rightId, detailArtifactId, byId, metadataErrors, details]);

  useEffect(() => {
    if (!detailArtifactId) return;
    const detail = details[detailArtifactId];
    if (!detail || detail.lineage || lineageErrors[detailArtifactId]) return;
    let active = true;
    void api.getLineage(detail.job.id).then((lineage) => {
      if (!active) return;
      setDetails((current) => ({
        ...current,
        [detailArtifactId]: { ...current[detailArtifactId], lineage },
      }));
    }).catch((cause) => {
      if (active) setLineageErrors((current) => ({ ...current, [detailArtifactId]: String(cause) }));
    });
    return () => { active = false; };
  }, [detailArtifactId, lineageErrors, details]);

  const updateTransform = (side: "A" | "B", next: ViewTransform) => {
    if (syncTransform) { setLeftTransform(next); setRightTransform(next); }
    else if (side === "A") setLeftTransform(next);
    else setRightTransform(next);
  };
  const activeId = activeSide === "A" ? leftId : rightId;
  const assignActive = (id: string) => {
    if (activeSide === "A") setLeftId(id); else setRightId(id);
  };

  useEffect(() => {
    if (!active) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && fullscreen) {
        event.preventDefault();
        setFullscreen(false);
        return;
      }
      const target = event.target as HTMLElement | null;
      const key = event.key.toLowerCase();
      const editing = target?.matches("input, textarea, select, [contenteditable='true']");
      if (key === "f" && !event.repeat && (!editing || fullscreen)) {
        event.preventDefault(); setFullscreen((current) => !current); return;
      }
      if (editing) return;
      if (activeId && !event.repeat && activeId !== busyArtifactId && key === "a") {
        event.preventDefault(); onDecide(activeId, "accepted"); return;
      }
      if (activeId && !event.repeat && activeId !== busyArtifactId && key === "x") {
        event.preventDefault(); onDecide(activeId, "rejected"); return;
      }
      if (activeId && !event.repeat && activeId !== busyArtifactId && key === "u") {
        event.preventDefault(); onDecide(activeId, "undecided"); return;
      }
      if (target?.matches("button, a")) return;
      if (event.key === "[") setActiveSide("A");
      else if (event.key === "]") setActiveSide("B");
      else if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && candidates.length) {
        event.preventDefault();
        const index = Math.max(0, candidates.findIndex(({ artifact }) => artifact.id === activeId));
        const delta = event.key === "ArrowRight" ? 1 : -1;
        assignActive(candidates[(index + delta + candidates.length) % candidates.length].artifact.id);
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [active, activeId, activeSide, busyArtifactId, candidates, fullscreen, onDecide]);

  useEffect(() => {
    if (!active) setFullscreen(false);
  }, [active]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (fullscreen && !dialog.open) {
      dialog.showModal();
      dialog.focus();
    }
    if (!fullscreen && dialog.open) dialog.close();
  }, [fullscreen]);

  const downloadContactSheet = async () => {
    const selected = [left, right].filter((item): item is Artifact => item !== null);
    if (!selected.length) return;
    setSheetBusy(true);
    setError(null);
    let objectUrl: string | null = null;
    try {
      const images = await Promise.all(selected.map((item) => loadImage(api.artifactContentUrl(item.id))));
      const cellWidth = 720;
      const cellHeight = 720;
      const header = 48;
      const canvas = document.createElement("canvas");
      canvas.width = cellWidth * images.length;
      canvas.height = cellHeight + header;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvasを利用できません。");
      context.fillStyle = "#111318";
      context.fillRect(0, 0, canvas.width, canvas.height);
      images.forEach((image, index) => {
        const scale = Math.min(cellWidth / image.width, cellHeight / image.height);
        const width = image.width * scale;
        const height = image.height * scale;
        context.drawImage(image, index * cellWidth + (cellWidth - width) / 2, header + (cellHeight - height) / 2, width, height);
        context.fillStyle = "white";
        context.font = "24px sans-serif";
        context.fillText(index === 0 ? "A" : "B", index * cellWidth + 16, 32);
      });
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("コンタクトシートを作成できません。");
      objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = `mycomfyui-contact-sheet-${Date.now()}.png`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
    } catch (cause) { setError(String(cause)); }
    finally {
      setSheetBusy(false);
      if (objectUrl) window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    }
  };

  const leftRows = detailRows(leftId ? details[leftId] ?? null : null);
  const rightRows = detailRows(rightId ? details[rightId] ?? null : null);
  const selectedDetail = detailArtifactId ? details[detailArtifactId] : null;
  const selectedDetailError = detailArtifactId
    ? metadataErrors[detailArtifactId] ?? lineageErrors[detailArtifactId]
    : null;
  const compare = (
    <div className="candidate-compare">
      <div className="compare-toolbar row">
        <button type="button" aria-pressed={activeSide === "A"} className={activeSide === "A" ? "primary" : undefined} onClick={() => setActiveSide("A")}>Aを操作</button>
        <button type="button" aria-pressed={activeSide === "B"} className={activeSide === "B" ? "primary" : undefined} onClick={() => setActiveSide("B")}>Bを操作</button>
        <label><input type="checkbox" checked={syncTransform} onChange={(event) => setSyncTransform(event.target.checked)} />pan・zoom同期</label>
        <button type="button" onClick={() => { setLeftTransform(INITIAL_TRANSFORM); setRightTransform(INITIAL_TRANSFORM); }}>表示を戻す</button>
        <button type="button" onClick={() => setFullscreen((current) => !current)}>{fullscreen ? "全画面を閉じる" : "全画面A/B"}</button>
        <button type="button" disabled={sheetBusy} onClick={() => void downloadContactSheet()}>{sheetBusy ? "作成中..." : "コンタクトシート"}</button>
      </div>
      <div className="compare-panes">
        <CompareImage artifact={left} transform={leftTransform} onTransform={(next) => updateTransform("A", next)} label="A" />
        <CompareImage artifact={right} transform={rightTransform} onTransform={(next) => updateTransform("B", next)} label="B" />
      </div>
      <div className="row">
        {leftId && metadataErrors[leftId] && (
          <p className="error">A:{metadataErrors[leftId]} <button type="button" onClick={() => setMetadataErrors((current) => { const next = { ...current }; delete next[leftId]; return next; })}>再取得</button></p>
        )}
        {rightId && metadataErrors[rightId] && (
          <p className="error">B:{metadataErrors[rightId]} <button type="button" onClick={() => setMetadataErrors((current) => { const next = { ...current }; delete next[rightId]; return next; })}>再取得</button></p>
        )}
      </div>
      <p className="muted">画像をdragで移動、wheelでzoom。[:A、]:B、←/→:候補移動、A:採用、X:却下、U:未判断、F:全画面。</p>
      <div className="compare-metadata">
        <table><thead><tr><th>項目</th><th>A</th><th>B</th></tr></thead><tbody>
          {Object.keys(leftRows).map((name) => {
            const a = format(leftRows[name]);
            const b = format(rightRows[name]);
            return <tr key={name} className={a === b ? undefined : "changed"}><th>{name}</th><td>{a}</td><td>{b}</td></tr>;
          })}
        </tbody></table>
      </div>
    </div>
  );

  return (
    <section className="panel">
      <div className="gallery-header">
        <h2>候補比較</h2>
        <div className="row">
          {comparisonActive && onClearComparison && (
            <button type="button" className="badge" onClick={onClearComparison}>
              実験の比較絞込みを解除
            </button>
          )}
          <div className="thumb-size" role="group" aria-label="サムネイルの表示サイズ">
            {THUMB_SIZES.map((item) => (
              <button
                key={item.value}
                type="button"
                aria-pressed={thumbSize === item.value}
                onClick={() => setThumbSize(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      {comparisonActive && (
        <p className="muted">
          実験の比較で絞り込み中です。新しく投入した候補は、絞込みを解除するまで表示されません。
        </p>
      )}
      {error && <p className="error">{error}</p>}
      {candidates.length === 0 ? <p className="muted">成功したJobの画像がまだありません。</p> : <>
        {compare}
        {detailArtifactId && byId.has(detailArtifactId) && selectedDetail?.lineage && (
          <ArtifactDetail
            artifact={byId.get(detailArtifactId)!.artifact}
            job={selectedDetail.job}
            manifest={selectedDetail.manifest}
            lineage={selectedDetail.lineage}
          />
        )}
        {detailArtifactId && selectedDetailError && (
          <div className="error">
            <p>{selectedDetailError}</p>
            <button type="button" onClick={() => {
              setMetadataErrors((current) => { const next = { ...current }; delete next[detailArtifactId]; return next; });
              setLineageErrors((current) => { const next = { ...current }; delete next[detailArtifactId]; return next; });
            }}>詳細を再取得</button>
          </div>
        )}
        {detailArtifactId && selectedDetail && !selectedDetail.lineage && !selectedDetailError && (
          <LoadingPlaceholder label="lineageを取得中です。" lines={2} />
        )}
        <div className={`gallery gallery-${thumbSize}`}>
          {candidates.map(({ artifact }) => <figure key={artifact.id} className={artifact.decision}>
            <span className={`badge decision decision-${artifact.decision}`}>
              {DECISION_LABEL[artifact.decision] ?? artifact.decision}
            </span>
            <ArtifactPreview artifact={artifact} />
            <figcaption>
              <span className="row">{artifact.id === leftId && <span className="badge">A</span>}{artifact.id === rightId && <span className="badge">B</span>}{artifact.decision_at && <span className="muted">{artifact.decision_at}</span>}</span>
              <span className="mono">{artifact.sha256.slice(0, 12)}</span>
              <div className="row">
                <button type="button" onClick={() => setLeftId(artifact.id)}>Aへ</button>
                <button type="button" onClick={() => setRightId(artifact.id)}>Bへ</button>
                <button type="button" disabled={busyArtifactId === artifact.id} onClick={() => onDecide(artifact.id, "accepted")}>採用</button>
                <button type="button" disabled={busyArtifactId === artifact.id} onClick={() => onDecide(artifact.id, "rejected")}>却下</button>
                <button type="button" disabled={busyArtifactId === artifact.id} onClick={() => onDecide(artifact.id, "undecided")}>戻す</button>
                <button type="button" onClick={() => setDetailArtifactId((current) => current === artifact.id ? null : artifact.id)}>詳細</button>
                {onDerive && <button type="button" onClick={() => onDerive(artifact.id)}>派生生成</button>}
              </div>
            </figcaption>
          </figure>)}
        </div>
        <dialog
          ref={dialogRef}
          className="compare-fullscreen"
          aria-label="候補の全画面A/B比較"
          tabIndex={-1}
          onClose={() => setFullscreen(false)}
        >
          {fullscreen && <>
            <button type="button" onClick={() => setFullscreen(false)}>全画面を閉じる</button>
            {compare}
          </>}
        </dialog>
      </>}
    </section>
  );
}
