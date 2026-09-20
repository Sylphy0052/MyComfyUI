import type { Artifact, ArtifactDecision } from "../api/client";
import { ArtifactPreview } from "./ArtifactPreview";

/** 採否の値と表示名。候補比較と資産ブラウザで同じ文言を使う。 */
export const DECISION_OPTIONS: { value: string; label: string }[] = [
  { value: "undecided", label: "未判断" },
  { value: "accepted", label: "採用" },
  { value: "rejected", label: "却下" },
];

export const DECISION_LABEL: Record<string, string> = Object.fromEntries(
  DECISION_OPTIONS.map((option) => [option.value, option.label]),
);

export interface Candidate {
  artifact: Artifact;
  jobId: string;
}

interface Props {
  candidates: Candidate[];
  busyArtifactId: string | null;
  onDecide: (artifactId: string, decision: ArtifactDecision) => void;
}

export function CandidateGallery({
  candidates,
  busyArtifactId,
  onDecide,
}: Props) {
  return (
    <section className="panel">
      <h2>候補比較</h2>
      {candidates.length === 0 ? (
        <p className="muted">成功したJobの画像がまだありません。</p>
      ) : (
        <div className="gallery">
          {candidates.map(({ artifact }) => (
            <figure key={artifact.id} className={artifact.decision}>
              <ArtifactPreview artifact={artifact} />
              <figcaption>
                <span className="muted">
                  {DECISION_LABEL[artifact.decision] ?? artifact.decision}
                  {artifact.decision_at ? ` / ${artifact.decision_at}` : ""}
                </span>
                <span className="mono">{artifact.sha256.slice(0, 12)}</span>
                <div className="row">
                  <button
                    type="button"
                    disabled={busyArtifactId === artifact.id}
                    onClick={() => onDecide(artifact.id, "accepted")}
                  >
                    採用
                  </button>
                  <button
                    type="button"
                    disabled={busyArtifactId === artifact.id}
                    onClick={() => onDecide(artifact.id, "rejected")}
                  >
                    却下
                  </button>
                  <button
                    type="button"
                    disabled={busyArtifactId === artifact.id}
                    onClick={() => onDecide(artifact.id, "undecided")}
                  >
                    戻す
                  </button>
                </div>
              </figcaption>
            </figure>
          ))}
        </div>
      )}
    </section>
  );
}
