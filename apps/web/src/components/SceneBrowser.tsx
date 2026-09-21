import { useMemo, useState } from "react";

import type { ProjectRecord } from "../api/client";
import type {
  ImmutableReference,
  SceneEnvelope,
  SceneSummary,
  ShotEnvelope,
  ShotSummary,
} from "../api/aimedia";

/**
 * 参照情報は画面から変更できない。`novel-writer` のデータは読むだけとする。
 */
function ReferenceView({ reference }: { reference: ImmutableReference }) {
  return (
    <dl className="kv">
      <dt>revision</dt>
      <dd className="mono">{reference.revision}</dd>
      <dt>path</dt>
      <dd className="mono">{reference.path}</dd>
      <dt>sha256</dt>
      <dd className="mono">{reference.sha256}</dd>
    </dl>
  );
}

interface Props {
  projects: ProjectRecord[];
  projectId: string | null;
  onSelectProject: (projectId: string | null) => void;
  onManageProjects: () => void;
  scenes: SceneSummary[];
  sceneId: string | null;
  onSelectScene: (sceneId: string) => void;
  scene: SceneEnvelope | null;
  shots: ShotSummary[];
  shotId: string | null;
  onSelectShot: (shotId: string) => void;
  shot: ShotEnvelope | null;
}

export function SceneBrowser({
  projects,
  projectId,
  onSelectProject,
  onManageProjects,
  scenes,
  sceneId,
  onSelectScene,
  scene,
  shots,
  shotId,
  onSelectShot,
  shot,
}: Props) {
  const [projectQuery, setProjectQuery] = useState("");
  const visibleProjects = useMemo(() => {
    const query = projectQuery.trim().toLocaleLowerCase();
    if (!query) return projects;
    return projects.filter((project) =>
      [project.name, project.id, ...project.tags].some((value) =>
        value.toLocaleLowerCase().includes(query),
      ),
    );
  }, [projectQuery, projects]);

  return (
    <div>
      <section className="panel">
        <h2>Project</h2>
        <label htmlFor="generation-project-search">Project検索</label>
        <input
          id="generation-project-search"
          type="search"
          value={projectQuery}
          placeholder="名前、ID、タグ"
          onChange={(event) => setProjectQuery(event.target.value)}
        />
        <label htmlFor="generation-project" style={{ marginTop: 8 }}>
          使用するProject
        </label>
        <select
          id="generation-project"
          value={projectId ?? ""}
          onChange={(event) => onSelectProject(event.target.value || null)}
        >
          <option value="">なし</option>
          {visibleProjects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.favorite ? "★ " : ""}
              {project.name}
            </option>
          ))}
        </select>
        <button type="button" onClick={onManageProjects} style={{ marginTop: 8 }}>
          Projectを管理
        </button>
      </section>

      <section className="panel">
        <h2>Scene</h2>
        <ul className="list">
          {scenes.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                aria-pressed={item.id === sceneId}
                onClick={() => onSelectScene(item.id)}
              >
                <span>{item.summary}</span>
                <span className="muted">
                  {item.id} / Shot {item.shot_count}件
                </span>
              </button>
            </li>
          ))}
        </ul>
        {scenes.length === 0 && <p className="muted">Sceneがありません。</p>}
        {scene && (
          <div className="stack" style={{ marginTop: 8 }}>
            <p className="muted">
              {scene.data.location?.display_name ?? scene.data.location?.id}
              {scene.data.time_of_day ? ` / ${scene.data.time_of_day}` : ""}
            </p>
            <ReferenceView reference={scene.provenance.resource} />
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Shot</h2>
        <ul className="list">
          {shots.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                aria-pressed={item.id === shotId}
                onClick={() => onSelectShot(item.id)}
              >
                <span>
                  #{item.sequence} {item.summary}
                </span>
                <span className="muted">{item.duration_sec}秒</span>
              </button>
            </li>
          ))}
        </ul>
        {shots.length === 0 && <p className="muted">Shotがありません。</p>}
        {shot && (
          <div className="stack" style={{ marginTop: 8 }}>
            {shot.data.camera && (
              <p className="muted">
                カメラ: {shot.data.camera.framing}
                {shot.data.camera.angle ? ` / ${shot.data.camera.angle}` : ""}
                {shot.data.camera.composition
                  ? ` / ${shot.data.camera.composition}`
                  : ""}
              </p>
            )}
            {(shot.data.dialogue ?? []).length > 0 && (
              <ul className="list">
                {(shot.data.dialogue ?? []).map((line, index) => (
                  <li key={index} className="muted">
                    {line.speaker}: {line.text}
                    {line.reading ? `(${line.reading})` : ""}
                  </li>
                ))}
              </ul>
            )}
            <ReferenceView reference={shot.provenance.resource} />
          </div>
        )}
      </section>
    </div>
  );
}
