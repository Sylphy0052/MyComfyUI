import { useEffect, useMemo, useState } from "react";

import { api, type Artifact, type GenerationJob } from "../api/client";
import { PIPELINE_STEPS, type PipelineStepId } from "../state/pipelineState";
import { Button } from "./ui/Button";
import { Badge } from "./ui/Badge";
import { ToggleGroup } from "./ui/ToggleGroup";

export type StepReadiness = "ready" | "missing";

export interface PipelineReadiness {
  steps: Record<PipelineStepId, StepReadiness>;
  /** 前の工程の成果物。次の工程の入力へ自動で入れるのに使う。APIの並びは新しい順。 */
  acceptedImages: Artifact[];
  referenceArtifactIds: string[];
  audios: Artifact[];
}

const EMPTY: PipelineReadiness = {
  steps: { background: "missing", character: "missing", audio: "missing", video: "missing", finish: "missing" },
  acceptedImages: [],
  referenceArtifactIds: [],
  audios: [],
};

/**
 * 場面の成果物から、各工程が揃っているかを判定する。API側に工程の状態機械は無いため、
 * 既存のArtifact・MediaItem・Jobの一覧から画面側で導く。
 * jobs が変わる (生成が終わる) たびに取り直す。
 */
export function usePipelineReadiness(
  projectId: string | null,
  sceneId: string | null,
  jobs: GenerationJob[],
): PipelineReadiness {
  const [readiness, setReadiness] = useState<PipelineReadiness>(EMPTY);
  const succeededKey = jobs.filter((job) => job.state === "succeeded").length;

  const composed = useMemo(
    () =>
      Boolean(sceneId) &&
      jobs.some(
        (job) => job.kind === "compose" && job.state === "succeeded" && job.assigned_scene_id === sceneId,
      ),
    [jobs, sceneId],
  );

  useEffect(() => {
    if (!projectId || !sceneId) {
      setReadiness(EMPTY);
      return;
    }
    let cancelled = false;
    Promise.all([
      api.listArtifacts({ projectId, sceneId, kind: "image", limit: 200 }),
      api.listArtifacts({ projectId, sceneId, kind: "audio", limit: 200 }),
      api.listArtifacts({ projectId, sceneId, kind: "video", limit: 200 }),
      api.listMediaItems({ projectId, role: "appearance_reference", limit: 200 }),
    ])
      .then(([images, audios, videos, references]) => {
        if (cancelled) return;
        const acceptedImages = images.filter((item) => item.decision === "accepted");
        const referenceArtifactIds = references.flatMap((item) => (item.artifact_id ? [item.artifact_id] : []));
        setReadiness({
          steps: {
            background: acceptedImages.length > 0 ? "ready" : "missing",
            character: references.length > 0 ? "ready" : "missing",
            audio: audios.length > 0 ? "ready" : "missing",
            video: videos.length > 0 ? "ready" : "missing",
            finish: composed ? "ready" : "missing",
          },
          acceptedImages,
          referenceArtifactIds,
          audios,
        });
      })
      .catch(() => {
        // 判定に失敗しても生成画面自体は使えるようにする。全工程を「足りない」のままにする。
        if (!cancelled) setReadiness(EMPTY);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, sceneId, succeededKey, composed]);

  return readiness;
}

interface Props {
  step: PipelineStepId;
  onStepChange: (step: PipelineStepId) => void;
  readiness: PipelineReadiness;
  audioTab: "voice" | "music";
  onAudioTabChange: (tab: "voice" | "music") => void;
  disabled: boolean;
}

/** 作品制作の工程を常時見せる。現在地、揃っているか、前後への移動を出す。 */
export function PipelineStepper({ step, onStepChange, readiness, audioTab, onAudioTabChange, disabled }: Props) {
  const index = PIPELINE_STEPS.findIndex((item) => item.id === step);
  const current = PIPELINE_STEPS[index];
  const previous = PIPELINE_STEPS[index - 1];
  const next = PIPELINE_STEPS[index + 1];
  const currentReady = readiness.steps[step] === "ready";

  return (
    <section className="pipeline-stepper" aria-label="制作工程">
      <ol className="pipeline-steps">
        {PIPELINE_STEPS.map((item, position) => {
          const ready = readiness.steps[item.id] === "ready";
          return (
            <li key={item.id}>
              <button
                type="button"
                className={item.id === step ? "pipeline-step primary" : "pipeline-step"}
                aria-current={item.id === step ? "step" : undefined}
                disabled={disabled}
                onClick={() => onStepChange(item.id)}
              >
                <span className="pipeline-step-no">{position + 1}</span>
                {item.label}
                <Badge tone={ready ? "decision-accepted" : "pipeline-missing"}>{ready ? "揃っている" : "足りない"}</Badge>
              </button>
            </li>
          );
        })}
      </ol>
      {!currentReady && !disabled && <p className="pipeline-missing-note">{current.missing}</p>}
      <div className="pipeline-actions">
        {step === "audio" && (
          <ToggleGroup
            label="音声かBGM"
            options={[
              { value: "voice", label: "音声" },
              { value: "music", label: "BGM" },
            ]}
            value={audioTab}
            onChange={onAudioTabChange}
          />
        )}
        <Button variant="secondary" disabled={disabled || !previous} onClick={() => previous && onStepChange(previous.id)}>
          {previous ? `戻る: ${previous.label}` : "戻る"}
        </Button>
        <Button variant="primary" disabled={disabled || !next} onClick={() => next && onStepChange(next.id)}>
          {next ? `次へ: ${next.label}` : "最終工程"}
        </Button>
      </div>
    </section>
  );
}
