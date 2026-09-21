import { useMemo, useState } from "react";
import type { FormEvent } from "react";

import { ApiError, api } from "../api/client";
import type { ProjectRecord, SceneCreate, ShotCreate } from "../api/client";
import type {
  ImmutableReference,
  ProductionStatus,
  SceneEnvelope,
  SceneSummary,
  ShotEnvelope,
  ShotSummary,
} from "../api/aimedia";

const STATUSES: { value: ProductionStatus; label: string }[] = [
  { value: "not_started", label: "未着手" },
  { value: "in_progress", label: "制作中" },
  { value: "has_candidates", label: "候補あり" },
  { value: "accepted", label: "採用済み" },
  { value: "completed", label: "完了" },
];

function statusLabel(value?: ProductionStatus) {
  return STATUSES.find((item) => item.value === value)?.label ?? "";
}

function describe(error: unknown) {
  if (error instanceof ApiError) return `${error.message}(${error.code})`;
  return String(error);
}

function ReferenceView({ reference }: { reference: ImmutableReference }) {
  return (
    <dl className="kv">
      <dt>revision</dt><dd className="mono">{reference.revision}</dd>
      <dt>path</dt><dd className="mono">{reference.path}</dd>
      <dt>sha256</dt><dd className="mono">{reference.sha256}</dd>
    </dl>
  );
}

interface Props {
  projects: ProjectRecord[];
  projectId: string | null;
  onSelectProject: (projectId: string | null) => void;
  onManageProjects: () => void;
  onStructureChanged: () => void;
  scenes: SceneSummary[];
  sceneId: string | null;
  onSelectScene: (sceneId: string) => void;
  scene: SceneEnvelope | null;
  shots: ShotSummary[];
  shotId: string | null;
  onSelectShot: (shotId: string) => void;
  shot: ShotEnvelope | null;
}

type Editor = "create-scene" | "edit-scene" | "create-shot" | "edit-shot" | null;

export function SceneBrowser(props: Props) {
  const {
    projects, projectId, onSelectProject, onManageProjects, onStructureChanged,
    scenes, sceneId, onSelectScene, scene, shots, shotId, onSelectShot, shot,
  } = props;
  const [projectQuery, setProjectQuery] = useState("");
  const [editor, setEditor] = useState<Editor>(null);
  const [editingScene, setEditingScene] = useState<SceneSummary | null>(null);
  const [editingShot, setEditingShot] = useState<ShotSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedProject = projects.find((item) => item.id === projectId) ?? null;
  const editable = selectedProject?.source_type === "local";
  const visibleProjects = useMemo(() => {
    const query = projectQuery.trim().toLocaleLowerCase();
    if (!query) return projects;
    return projects.filter((project) =>
      [project.name, project.id, ...project.tags].some((value) =>
        value.toLocaleLowerCase().includes(query),
      ),
    );
  }, [projectQuery, projects]);

  const move = async (kind: "scene" | "shot", index: number, offset: number) => {
    if (!projectId) return;
    const items = kind === "scene" ? scenes : shots;
    const target = index + offset;
    if (target < 0 || target >= items.length) return;
    const ids = items.map((item) => item.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    setBusy(true);
    setError(null);
    try {
      if (kind === "scene") await api.reorderScenes(projectId, ids);
      else if (sceneId) await api.reorderShots(projectId, sceneId, ids);
      onStructureChanged();
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (kind: "scene" | "shot", id: string) => {
    if (!projectId || (kind === "shot" && !sceneId)) return;
    setBusy(true);
    setError(null);
    try {
      const impact = kind === "scene"
        ? await api.getSceneDeletionImpact(projectId, id)
        : await api.getShotDeletionImpact(projectId, sceneId!, id);
      const message = [
        `${kind === "scene" ? "Scene" : "Shot"}を削除します。`,
        `配下Shot:${impact.shot_count}件 Job:${impact.job_count}件 Artifact:${impact.artifact_count}件`,
        "履歴は残ります。続行しますか？",
      ].join("\n");
      if (impact.blockers.length > 0) {
        setError(impact.blockers.join(" "));
        return;
      }
      if (!window.confirm(message)) return;
      if (kind === "scene") await api.deleteScene(projectId, id, true);
      else await api.deleteShot(projectId, sceneId!, id, true);
      onStructureChanged();
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <section className="panel">
        <h2>Project</h2>
        <label htmlFor="generation-project-search">Project検索</label>
        <input id="generation-project-search" type="search" value={projectQuery}
          placeholder="名前、ID、タグ" onChange={(event) => setProjectQuery(event.target.value)} />
        <label htmlFor="generation-project" style={{ marginTop: 8 }}>使用するProject</label>
        <select id="generation-project" value={projectId ?? ""}
          onChange={(event) => onSelectProject(event.target.value || null)}>
          <option value="">なし</option>
          {visibleProjects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.favorite ? "★ " : ""}{project.name}
            </option>
          ))}
        </select>
        <button type="button" onClick={onManageProjects} style={{ marginTop: 8 }}>Projectを管理</button>
      </section>

      {error && <p className="error">{error}</p>}
      {selectedProject && !editable && (
        <p className="muted">外部同期ProjectのScene・Shotは読取り専用です。</p>
      )}

      <section className="panel structure-panel">
        <div className="row spread">
          <h2>Scene</h2>
          {editable && <button type="button" disabled={busy} onClick={() => { setEditingScene(null); setEditor("create-scene"); }}>追加</button>}
        </div>
        <ul className="list structure-list">
          {scenes.map((item, index) => (
            <li key={item.id}>
              <button type="button" aria-pressed={item.id === sceneId} onClick={() => onSelectScene(item.id)}>
                <span>#{item.sequence} {item.summary}</span>
                <span className="muted">Shot {item.shot_count}件 {statusLabel(item.production_status)}</span>
              </button>
              {editable && <div className="row structure-actions">
                <button type="button" disabled={busy || index === 0} onClick={() => move("scene", index, -1)}>↑</button>
                <button type="button" disabled={busy || index === scenes.length - 1} onClick={() => move("scene", index, 1)}>↓</button>
                <button type="button" disabled={busy} onClick={() => { setEditingScene(item); setEditor("edit-scene"); }}>編集</button>
                <button type="button" className="danger-button" disabled={busy} onClick={() => remove("scene", item.id)}>削除</button>
              </div>}
            </li>
          ))}
        </ul>
        {scenes.length === 0 && <p className="muted">Sceneがありません。</p>}
        {scene && <div className="stack structure-detail">
          {scene.data.notes && <p>{scene.data.notes}</p>}
          {(scene.data.tags ?? []).map((tag) => <span key={tag} className="badge">{tag}</span>)}
          <p className="muted">
            {scene.data.location?.display_name ?? scene.data.location?.id}
            {scene.data.time_of_day ? ` / ${scene.data.time_of_day}` : ""}
          </p>
          <ReferenceView reference={scene.provenance.resource} />
        </div>}
      </section>

      <section className="panel structure-panel">
        <div className="row spread">
          <h2>Shot</h2>
          {editable && sceneId && <button type="button" disabled={busy} onClick={() => { setEditingShot(null); setEditor("create-shot"); }}>追加</button>}
        </div>
        <ul className="list structure-list">
          {shots.map((item, index) => (
            <li key={item.id}>
              <button type="button" aria-pressed={item.id === shotId} onClick={() => onSelectShot(item.id)}>
                <span>#{item.sequence} {item.summary}</span>
                <span className="muted">{item.duration_sec}秒 {statusLabel(item.production_status)}</span>
              </button>
              {editable && <div className="row structure-actions">
                <button type="button" disabled={busy || index === 0} onClick={() => move("shot", index, -1)}>↑</button>
                <button type="button" disabled={busy || index === shots.length - 1} onClick={() => move("shot", index, 1)}>↓</button>
                <button type="button" disabled={busy} onClick={() => { setEditingShot(item); setEditor("edit-shot"); }}>編集</button>
                <button type="button" className="danger-button" disabled={busy} onClick={() => remove("shot", item.id)}>削除</button>
              </div>}
            </li>
          ))}
        </ul>
        {shots.length === 0 && <p className="muted">Shotがありません。</p>}
        {shot && <div className="stack structure-detail">
          {shot.data.notes && <p>{shot.data.notes}</p>}
          {(shot.data.tags ?? []).map((tag) => <span key={tag} className="badge">{tag}</span>)}
          {shot.data.camera && <p className="muted">カメラ:{shot.data.camera.framing}
            {shot.data.camera.angle ? ` / ${shot.data.camera.angle}` : ""}
            {shot.data.camera.composition ? ` / ${shot.data.camera.composition}` : ""}</p>}
          {(shot.data.dialogue ?? []).length > 0 && <ul className="list">
            {(shot.data.dialogue ?? []).map((line, index) => <li key={index} className="muted">
              {line.speaker}:{line.text}{line.reading ? `(${line.reading})` : ""}
            </li>)}
          </ul>}
          <ReferenceView reference={shot.provenance.resource} />
        </div>}
      </section>

      {(editor === "create-scene" || editor === "edit-scene") && projectId && (
        <StructureEditor kind="scene" initial={editor === "edit-scene" ? editingScene ?? undefined : undefined}
          onCancel={() => setEditor(null)} onSave={async (values) => {
            if (editor === "edit-scene" && editingScene) await api.updateScene(projectId, editingScene.id, values);
            else await api.createScene(projectId, values);
            setEditor(null); onStructureChanged();
          }} />
      )}
      {(editor === "create-shot" || editor === "edit-shot") && projectId && sceneId && (
        <StructureEditor kind="shot" initial={editor === "edit-shot" ? editingShot ?? undefined : undefined}
          onCancel={() => setEditor(null)} onSave={async (values) => {
            if (editor === "edit-shot" && editingShot) await api.updateShot(projectId, sceneId, editingShot.id, values);
            else await api.createShot(projectId, sceneId, values as ShotCreate);
            setEditor(null); onStructureChanged();
          }} />
      )}
    </div>
  );
}

function StructureEditor({ kind, initial, onCancel, onSave }: {
  kind: "scene" | "shot";
  initial?: { summary: string; notes?: string | null; tags?: string[]; production_status?: ProductionStatus; duration_sec?: number };
  onCancel: () => void;
  onSave: (values: SceneCreate | ShotCreate) => Promise<void>;
}) {
  const [summary, setSummary] = useState(initial?.summary ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [tags, setTags] = useState((initial?.tags ?? []).join(", "));
  const [productionStatus, setProductionStatus] = useState<ProductionStatus>(initial?.production_status ?? "not_started");
  const [duration, setDuration] = useState(initial?.duration_sec ?? 5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(null);
    const common = { summary, notes: notes || null, tags: tags.split(",").map((value) => value.trim()).filter(Boolean), production_status: productionStatus };
    try {
      await onSave(kind === "shot" ? { ...common, duration_sec: duration } : common);
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };
  return <section className="panel project-editor" role="dialog" aria-modal="true">
    <h2>{initial ? "編集" : "作成"}:{kind === "scene" ? "Scene" : "Shot"}</h2>
    <form className="stack" onSubmit={submit}>
      <label>概要<input required maxLength={1000} value={summary} onChange={(event) => setSummary(event.target.value)} /></label>
      {kind === "shot" && <label>長さ（秒）<input type="number" min="0.1" max="3600" step="0.1" value={duration} onChange={(event) => setDuration(Number(event.target.value))} /></label>}
      <label>制作状態<select value={productionStatus} onChange={(event) => setProductionStatus(event.target.value as ProductionStatus)}>
        {STATUSES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
      </select></label>
      <label>タグ（カンマ区切り）<input value={tags} onChange={(event) => setTags(event.target.value)} /></label>
      <label>メモ<textarea maxLength={10000} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
      {error && <p className="error">{error}</p>}
      <div className="row"><button type="button" disabled={busy} onClick={onCancel}>キャンセル</button><button type="submit" className="primary" disabled={busy}>{busy ? "保存中..." : "保存"}</button></div>
    </form>
  </section>;
}
