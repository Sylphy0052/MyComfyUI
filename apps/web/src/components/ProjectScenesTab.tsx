import { useEffect, useMemo, useState } from "react";

import { api } from "../api/client";
import type { Artifact } from "../api/client";
import type { SceneSummary, ShotSummary } from "../api/aimedia";
import { LoadingPlaceholder } from "./LoadingPlaceholder";

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** 一覧APIの上限。これを超える分は古い画像から表示されない。 */
const IMAGE_LIMIT = 200;
/** Scene直下・Shotごとに並べるサムネイルの上限。 */
const THUMBS_PER_GROUP = 8;

interface ImageIndex {
  /** Sceneに割り当てられた画像。Shotまで割り当てられた画像も含む。 */
  byScene: Map<string, Artifact[]>;
  /** Shotに割り当てられた画像。キーは`sceneId/shotId`。 */
  byShot: Map<string, Artifact[]>;
}

function indexImages(artifacts: Artifact[]): ImageIndex {
  const byScene = new Map<string, Artifact[]>();
  const byShot = new Map<string, Artifact[]>();
  for (const artifact of artifacts) {
    const sceneId = artifact.assigned_scene_id;
    if (!sceneId) continue;
    byScene.set(sceneId, [...(byScene.get(sceneId) ?? []), artifact]);
    if (artifact.assigned_shot_id) {
      const key = `${sceneId}/${artifact.assigned_shot_id}`;
      byShot.set(key, [...(byShot.get(key) ?? []), artifact]);
    }
  }
  return { byScene, byShot };
}

/** Scene IDからProject IDの接頭辞を外した短い表示名。 */
function sceneLabel(projectId: string, scene: SceneSummary): string {
  const prefix = `${projectId}-`;
  return scene.id.startsWith(prefix) ? scene.id.slice(prefix.length) : scene.id;
}

/**
 * シーンタブ本体。Projectの生成画像を1回で取り、Scene・Shotへ振り分けて並べる。
 * 画像が1枚でもあれば、既定では画像のあるSceneだけを表示する。
 */
export function ProjectScenesTab({ projectId, scenes }: { projectId: string; scenes: SceneSummary[] }) {
  const [images, setImages] = useState<ImageIndex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlyWithImages, setOnlyWithImages] = useState(true);

  useEffect(() => {
    let active = true;
    setImages(null);
    setError(null);
    api
      .listArtifacts({ projectId, kind: "image", limit: IMAGE_LIMIT })
      .then((items) => {
        if (active) setImages(indexImages(items));
      })
      .catch((cause) => {
        if (active) setError(describe(cause));
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  const hasImages = (images?.byScene.size ?? 0) > 0;
  const filtering = hasImages && onlyWithImages;
  const shown = useMemo(
    () => (filtering && images ? scenes.filter((scene) => images.byScene.has(scene.id)) : scenes),
    [filtering, images, scenes],
  );

  if (error) return <p className="error">生成画像を取得できません。{error}</p>;
  if (!images) return <LoadingPlaceholder label="Sceneを読込み中..." lines={3} />;

  return (
    <div className="stack project-scene-tab">
      <div className="row spread">
        <p className="muted">
          {hasImages
            ? `${scenes.length}件のSceneのうち${images.byScene.size}件に生成画像があります。`
            : `${scenes.length}件のScene。生成画像はまだありません。`}
        </p>
        {hasImages && (
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={onlyWithImages}
              onChange={(event) => setOnlyWithImages(event.target.checked)}
            />
            画像のあるSceneだけ表示
          </label>
        )}
      </div>
      {shown.map((scene) => (
        <SceneDetails
          key={scene.id}
          projectId={projectId}
          scene={scene}
          label={sceneLabel(projectId, scene)}
          images={images}
        />
      ))}
    </div>
  );
}

function Thumbs({ artifacts, alt }: { artifacts: Artifact[]; alt: string }) {
  if (artifacts.length === 0) return null;
  return (
    <div className="scene-tab-thumbs">
      {artifacts.slice(0, THUMBS_PER_GROUP).map((artifact) => (
        <a key={artifact.id} href={api.artifactContentUrl(artifact.id)} target="_blank" rel="noreferrer">
          <img className="scene-tab-thumb" src={api.artifactContentUrl(artifact.id)} alt={alt} loading="lazy" />
        </a>
      ))}
      {artifacts.length > THUMBS_PER_GROUP && (
        <span className="muted">ほか{artifacts.length - THUMBS_PER_GROUP}枚</span>
      )}
    </div>
  );
}

/** Scene 1件。開いたときだけShot一覧を取りに行く。 */
function SceneDetails({
  projectId,
  scene,
  label,
  images,
}: {
  projectId: string;
  scene: SceneSummary;
  label: string;
  images: ImageIndex;
}) {
  const [shots, setShots] = useState<ShotSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sceneImages = images.byScene.get(scene.id) ?? [];
  // Shotまで割り当てられていない画像だけをScene直下に出す。
  const looseImages = sceneImages.filter((artifact) => !artifact.assigned_shot_id);

  const load = () => {
    if (shots || loading || scene.shot_count === 0) return;
    setLoading(true);
    setError(null);
    api
      .listShots(projectId, scene.id)
      .then((list) => setShots(list.items))
      .catch((cause) => setError(describe(cause)))
      .finally(() => setLoading(false));
  };

  return (
    <details
      className="scene-tab-scene"
      onToggle={(event) => {
        if (event.currentTarget.open) load();
      }}
    >
      <summary>
        <span className="mono scene-tab-label">{label}</span>
        <span className="scene-tab-summary">{scene.summary}</span>
        {scene.shot_count > 0 && <span className="badge">Shot {scene.shot_count}</span>}
        {sceneImages.length > 0 && <span className="badge">画像 {sceneImages.length}</span>}
      </summary>
      <p>{scene.summary}</p>
      <Thumbs artifacts={looseImages} alt={`${label}の生成画像`} />
      {loading && <LoadingPlaceholder label="Shotを読込み中..." lines={2} />}
      {error && <p className="error">Shot一覧を取得できません。{error}</p>}
      {shots && shots.length > 0 && (
        <ul className="list scene-tab-shots">
          {shots.map((shot) => (
            <li key={shot.id} className="scene-tab-shot">
              <p>
                <span className="mono">Shot {shot.sequence}</span> {shot.summary}
              </p>
              <Thumbs
                artifacts={images.byShot.get(`${scene.id}/${shot.id}`) ?? []}
                alt={`${label} Shot ${shot.sequence}の生成画像`}
              />
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
