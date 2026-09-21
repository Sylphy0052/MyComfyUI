import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";

import { ApiError, api } from "../api/client";
import type {
  ProjectPackage,
  ProjectPackagePreflight,
  ProjectRecord,
  ProjectTemplate,
} from "../api/client";

function describe(error: unknown): string {
  return error instanceof ApiError ? `${error.message} (${error.code})` : String(error);
}

function downloadPackage(project: ProjectRecord, payload: ProjectPackage, suffix: string) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${project.id}.${suffix}.mycomfyui-project.json`;
  link.click();
  URL.revokeObjectURL(url);
}

export function ProjectPortabilityPanel({
  project,
  onCreated,
}: {
  project: ProjectRecord;
  onCreated: (project: ProjectRecord) => Promise<void>;
}) {
  const [mode, setMode] = useState<"template" | "clone" | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [includeStructure, setIncludeStructure] = useState(true);
  const [includeArtifacts, setIncludeArtifacts] = useState(false);
  const [exportStructure, setExportStructure] = useState(true);
  const [exportArtifacts, setExportArtifacts] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "template") {
        await api.createProjectTemplate(project.id, { name, description: description || null });
        setMode(null);
      } else {
        const cloned = await api.cloneProject(project.id, {
          name,
          include_structure: includeStructure,
          include_artifact_references: includeArtifacts,
        });
        setMode(null);
        await onCreated(cloned);
      }
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  const exportPackage = async (backup: boolean) => {
    setBusy(true);
    setError(null);
    try {
      downloadPackage(
        project,
        await api.exportProjectPackage(project.id, {
          includeStructure: exportStructure,
          includeArtifacts: exportArtifacts,
          includeArtifactFiles: backup,
        }),
        backup ? "backup" : "export",
      );
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="project-portability-panel">
      <h3>再利用・移行・バックアップ</h3>
      <div className="row">
        <button type="button" disabled={busy} onClick={() => { setMode("template"); setName(`${project.name}テンプレート`); }}>テンプレート保存</button>
        <button type="button" disabled={busy} onClick={() => { setMode("clone"); setName(`${project.name}のコピー`); }}>複製</button>
        <button type="button" disabled={busy} onClick={() => exportPackage(false)}>export</button>
        <button type="button" disabled={busy} onClick={() => exportPackage(true)}>実体込みbackup</button>
      </div>
      <div className="row">
        <label className="checkbox-field"><input type="checkbox" checked={exportStructure} onChange={(event) => setExportStructure(event.target.checked)} />exportにScene・Shotを含める</label>
        <label className="checkbox-field"><input type="checkbox" checked={exportArtifacts} onChange={(event) => setExportArtifacts(event.target.checked)} />exportにArtifact参照を含める</label>
      </div>
      <p className="muted">exportはArtifact参照を、backupは実ファイルも含むJSON packageを保存します。認証情報は含みません。</p>
      {error && <p className="error">{error}</p>}
      {mode && (
        <form className="stack portability-form" onSubmit={save}>
          <h4>{mode === "template" ? "テンプレートとして保存" : "Projectを複製"}</h4>
          <label>名前<input required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} /></label>
          {mode === "template" ? (
            <label>説明<textarea value={description} onChange={(event) => setDescription(event.target.value)} /></label>
          ) : (
            <>
              <label className="checkbox-field"><input type="checkbox" checked={includeStructure} onChange={(event) => setIncludeStructure(event.target.checked)} />Scene・Shotを含める</label>
              <label className="checkbox-field"><input type="checkbox" checked={includeArtifacts} onChange={(event) => setIncludeArtifacts(event.target.checked)} />Artifact参照を含める</label>
            </>
          )}
          <div className="row"><button type="button" onClick={() => setMode(null)}>取消</button><button type="submit" className="primary" disabled={busy}>保存</button></div>
        </form>
      )}
    </section>
  );
}

export function ProjectPackageDialog({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (project: ProjectRecord) => Promise<void>;
}) {
  const [templates, setTemplates] = useState<ProjectTemplate[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [name, setName] = useState("");
  const [packageValue, setPackageValue] = useState<Record<string, unknown> | null>(null);
  const [preflight, setPreflight] = useState<ProjectPackagePreflight | null>(null);
  const [pathFrom, setPathFrom] = useState("");
  const [pathTo, setPathTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.listProjectTemplates().then(setTemplates).catch((cause) => setError(describe(cause)));
  }, []);

  const mapping = pathFrom && pathTo ? { [pathFrom]: pathTo } : {};
  const readFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setError(null);
    setPreflight(null);
    try {
      const parsed = JSON.parse(await file.text()) as Record<string, unknown>;
      setPackageValue(parsed);
      const sourceName = (parsed.project as { name?: unknown } | undefined)?.name;
      if (typeof sourceName === "string") setName(`${sourceName}（取込）`);
    } catch (cause) {
      setError(`JSONを読めません。${String(cause)}`);
    }
  };

  const preview = async () => {
    if (!packageValue) return;
    setBusy(true); setError(null);
    try {
      setPreflight(await api.previewProjectPackage({ package: packageValue, name: name || null, path_remap: mapping }));
    } catch (cause) { setError(describe(cause)); } finally { setBusy(false); }
  };

  const importPackage = async () => {
    if (!packageValue) return;
    setBusy(true); setError(null);
    try {
      await onCreated(await api.importProjectPackage({ package: packageValue, name: name || null, path_remap: mapping }, true));
    } catch (cause) { setError(describe(cause)); } finally { setBusy(false); }
  };

  const instantiate = async (event: FormEvent) => {
    event.preventDefault();
    if (!templateId) return;
    setBusy(true); setError(null);
    try { await onCreated(await api.instantiateProjectTemplate(templateId, { name })); }
    catch (cause) { setError(describe(cause)); } finally { setBusy(false); }
  };

  return (
    <section className="panel project-editor project-package-dialog" role="dialog" aria-modal="true">
      <div className="row spread"><h2>Projectを再利用・復元</h2><button type="button" onClick={onCancel}>閉じる</button></div>
      <form className="stack" onSubmit={instantiate}>
        <h3>テンプレートから作成</h3>
        <label>テンプレート<select required value={templateId} onChange={(event) => setTemplateId(event.target.value)}><option value="">選択</option>{templates.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>新しいProject名<input required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} /></label>
        <button type="submit" className="primary" disabled={busy || !templateId}>作成</button>
      </form>
      <div className="stack package-import-section">
        <h3>packageをimport・restore</h3>
        <input ref={inputRef} type="file" accept="application/json,.json" onChange={readFile} />
        <label>新しいProject名<input maxLength={120} value={name} onChange={(event) => setName(event.target.value)} /></label>
        <div className="row"><label>置換元<input placeholder="artifacts/旧環境" value={pathFrom} onChange={(event) => setPathFrom(event.target.value)} /></label><label>置換先<input placeholder="artifacts/新環境" value={pathTo} onChange={(event) => setPathTo(event.target.value)} /></label></div>
        <div className="row"><button type="button" disabled={busy || !packageValue} onClick={preview}>事前診断</button><button type="button" className="primary" disabled={busy || !packageValue || preflight?.can_import === false} onClick={importPackage}>import・restore</button></div>
        {preflight && <ul className="compact-list"><li>ID衝突:{preflight.id_collisions.length}件（import時に新しいIDへ再割当）</li><li>不足ファイル:{preflight.missing_files.length}件</li><li>利用不可Recipe:{preflight.unavailable_recipes.length}件</li><li>利用不可Workflow:{preflight.unavailable_workflows.length}件</li>{preflight.model_warnings.map((item) => <li key={item}>{item}</li>)}</ul>}
      </div>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
