import { useEffect, useState } from "react";

import { ApiError, api } from "../api/client";
import type { AssignmentTarget, ProjectRecord } from "../api/client";
import type { SceneSummary, ShotSummary } from "../api/aimedia";

interface Props {
  projects: ProjectRecord[];
  initialProjectId?: string | null;
  initialSceneId?: string | null;
  initialShotId?: string | null;
  disabled?: boolean;
  moveLabel?: string;
  onMove: (target: AssignmentTarget) => Promise<void>;
  onCopy?: (target: AssignmentTarget) => Promise<void>;
}

function describe(error: unknown): string {
  if (error instanceof ApiError) {
    return `${error.message} (${error.code})`;
  }
  return String(error);
}

export function AssignmentPicker({
  projects,
  initialProjectId = null,
  initialSceneId = null,
  initialShotId = null,
  disabled = false,
  moveLabel = "移動",
  onMove,
  onCopy,
}: Props) {
  const [projectId, setProjectId] = useState(initialProjectId ?? "");
  const [sceneId, setSceneId] = useState(initialSceneId ?? "");
  const [shotId, setShotId] = useState(initialShotId ?? "");
  const [scenes, setScenes] = useState<SceneSummary[]>([]);
  const [shots, setShots] = useState<ShotSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setProjectId(initialProjectId ?? "");
    setSceneId(initialSceneId ?? "");
    setShotId(initialShotId ?? "");
  }, [initialProjectId, initialSceneId, initialShotId]);

  useEffect(() => {
    if (!projectId) {
      setScenes([]);
      setShots([]);
      return;
    }
    setScenes([]);
    setShots([]);
    let active = true;
    void api
      .listScenes(projectId)
      .then((result) => {
        if (active) setScenes(result.items);
      })
      .catch((cause) => {
        if (active) setError(describe(cause));
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  useEffect(() => {
    if (!projectId || !sceneId) {
      setShots([]);
      return;
    }
    setShots([]);
    let active = true;
    void api
      .listShots(projectId, sceneId)
      .then((result) => {
        if (active) setShots(result.items);
      })
      .catch((cause) => {
        if (active) setError(describe(cause));
      });
    return () => {
      active = false;
    };
  }, [projectId, sceneId]);

  const target: AssignmentTarget = {
    project_id: projectId || null,
    scene_id: sceneId || null,
    shot_id: shotId || null,
  };

  const execute = async (operation: "move" | "copy") => {
    setBusy(true);
    setError(null);
    try {
      if (operation === "copy" && onCopy) {
        await onCopy(target);
      } else {
        await onMove(target);
      }
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="assignment-picker stack">
      <div className="filters">
        <div>
          <label>所属Project</label>
          <select
            value={projectId}
            disabled={disabled || busy}
            onChange={(event) => {
              setProjectId(event.target.value);
              setSceneId("");
              setShotId("");
            }}
          >
            <option value="">Inbox（未所属）</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label>Scene</label>
          <select
            value={sceneId}
            disabled={disabled || busy || !projectId}
            onChange={(event) => {
              setSceneId(event.target.value);
              setShotId("");
            }}
          >
            <option value="">指定なし</option>
            {scenes.map((scene) => (
              <option key={scene.id} value={scene.id}>
                {scene.sequence}. {scene.summary || scene.id}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label>Shot</label>
          <select
            value={shotId}
            disabled={disabled || busy || !sceneId}
            onChange={(event) => setShotId(event.target.value)}
          >
            <option value="">指定なし</option>
            {shots.map((shot) => (
              <option key={shot.id} value={shot.id}>
                {shot.sequence}. {shot.summary || shot.id}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="row">
        <button
          type="button"
          className="primary"
          disabled={disabled || busy}
          onClick={() => void execute("move")}
        >
          {moveLabel}
        </button>
        {onCopy && (
          <button
            type="button"
            disabled={disabled || busy}
            onClick={() => void execute("copy")}
          >
            コピー
          </button>
        )}
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}
