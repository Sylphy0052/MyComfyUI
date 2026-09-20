import type { Artifact, ArtifactDecision } from "../api/client";
import { ArtifactPreview } from "./ArtifactPreview";

const DECISION_LABEL: Record<string, string> = {
  undecided: "未判断",
  accepted: "採用",
  rejected: "却下",
};

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
