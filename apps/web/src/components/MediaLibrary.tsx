import { useEffect, useMemo, useState } from "react";

import { ApiError, api } from "../api/client";
import type {
  MediaItem,
  MediaItemSource,
  MediaRole,
  ProjectCharacterProfile,
} from "../api/client";
import { LoadingPlaceholder } from "./LoadingPlaceholder";
import { MediaViewer } from "./MediaViewer";
import type { MediaViewerItem } from "./MediaViewer";
import { Icon } from "./ui/Icon";
import { IconButton } from "./ui/IconButton";

/** 一度に取る件数。一覧は新しい順の窓で見る (他のブラウザ系コンポーネントと同じ考え方)。 */
const PAGE_SIZE = 100;

const SOURCE_LABEL: Record<MediaItemSource, string> = {
  generated: "生成物",
  external_import: "外部取込",
  registered: "登録素材",
  registered_input: "登録素材(入力cache)",
  character_reference: "人物参照",
};
const SOURCE_OPTIONS = Object.keys(SOURCE_LABEL) as MediaItemSource[];

const ROLE_LABEL: Record<MediaRole, string> = {
  appearance_reference: "外見参照",
  pose: "ポーズ",
  background: "背景",
  costume: "衣装",
  other: "その他",
};
const ROLE_OPTIONS = Object.keys(ROLE_LABEL) as MediaRole[];

const KIND_OPTIONS = ["image", "audio", "video", "workflow", "log"];

interface Props {
  projectId: string | null;
  sceneId: string | null;
  shotId: string | null;
}

function describe(error: unknown): string {
  if (error instanceof ApiError) {
    return `${error.message} (${error.code})`;
  }
  return String(error);
}

/**
 * 生成物・登録素材・外部取込・人物参照を1つの一覧で探す (Issue #148 受入基準2・3)。
 * 役割・キャラクター・出自・種別で絞り込める。対象範囲はProjectブラウザの選択に
 * 追従し、Project未選択時は未整理分を見る (AssetBrowser・IntegrityListと同じ挙動)。
 */
export function MediaLibrary({ projectId, sceneId, shotId }: Props) {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [characters, setCharacters] = useState<ProjectCharacterProfile[]>([]);
  const [source, setSource] = useState<MediaItemSource | "">("");
  const [role, setRole] = useState<MediaRole | "">("");
  const [characterId, setCharacterId] = useState("");
  const [kind, setKind] = useState("");
  const [keyword, setKeyword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  useEffect(() => {
    if (!projectId) {
      setCharacters([]);
      setCharacterId("");
      return;
    }
    let active = true;
    api
      .getProjectLocalOverrides(projectId)
      .then((overrides) => {
        if (active) setCharacters(overrides.characters ?? []);
      })
      .catch(() => {
        if (active) setCharacters([]);
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    api
      .listMediaItems({
        projectId: projectId ?? undefined,
        sceneId: sceneId ?? undefined,
        shotId: shotId ?? undefined,
        unassigned: !projectId,
        kind: kind || undefined,
        source: source || undefined,
        role: role || undefined,
        characterId: characterId || undefined,
        limit: PAGE_SIZE,
      })
      .then((found) => {
        if (active) setItems(found);
      })
      .catch((cause) => {
        if (!active) return;
        setItems([]);
        setError(describe(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId, sceneId, shotId, kind, source, role, characterId]);

  const filtered = useMemo(
    () =>
      keyword
        ? items.filter((item) =>
            `${item.label ?? ""} ${item.relative_path}`
              .toLowerCase()
              .includes(keyword.toLowerCase()),
          )
        : items,
    [items, keyword],
  );

  // ビューアは Artifact の配信経路で表示するため、Artifact 由来の素材だけを前後移動の対象にする。
  // 一覧に載っている素材は実ファイルがある前提で availability を complete とする。
  const viewerItems = useMemo<MediaViewerItem[]>(
    () =>
      filtered.flatMap((item) =>
        item.artifact_id
          ? [
              {
                id: item.artifact_id,
                media_type: item.media_type,
                availability: "complete" as const,
              },
            ]
          : [],
      ),
    [filtered],
  );

  return (
    <section className="panel">
      <h2>素材ライブラリ</h2>
      <p className="muted">
        {
          "生成物・登録素材・外部取込・人物参照を横断して探す。役割・キャラクターで絞り込める。"
        }
      </p>
      {error && (
        <div className="error">
          <div>{error}</div>
          <button type="button" onClick={() => setError(null)}>
            閉じる
          </button>
        </div>
      )}

      <div className="row">
        <select value={source} onChange={(event) => setSource(event.target.value as MediaItemSource | "")}>
          <option value="">出自: すべて</option>
          {SOURCE_OPTIONS.map((item) => (
            <option key={item} value={item}>
              {SOURCE_LABEL[item]}
            </option>
          ))}
        </select>
        <select value={role} onChange={(event) => setRole(event.target.value as MediaRole | "")}>
          <option value="">役割: すべて</option>
          {ROLE_OPTIONS.map((item) => (
            <option key={item} value={item}>
              {ROLE_LABEL[item]}
            </option>
          ))}
        </select>
        {characters.length > 0 && (
          <select value={characterId} onChange={(event) => setCharacterId(event.target.value)}>
            <option value="">キャラクター: すべて</option>
            {characters.map((character) => (
              <option key={character.id} value={character.id}>
                {character.name}
              </option>
            ))}
          </select>
        )}
        <select value={kind} onChange={(event) => setKind(event.target.value)}>
          <option value="">種別: すべて</option>
          {KIND_OPTIONS.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
        <input
          type="search"
          placeholder="ファイル名で絞り込み"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
        />
      </div>

      {loading && <LoadingPlaceholder label="読み込み中。" lines={3} />}

      {!loading && filtered.length === 0 && (
        <p className="muted">条件に合う素材は見つからなかった。</p>
      )}

      {!loading && filtered.length > 0 && (
        <ul className="list plain">
          {filtered.map((item) => (
            <li key={item.key} className="stack">
              <span className="row spread">
                <span className="row">
                  <span className="badge">{SOURCE_LABEL[item.source]}</span>
                  <span className="badge">{item.kind}</span>
                  {item.role && (
                    <span className="badge">
                      {ROLE_LABEL[item.role as MediaRole] ?? item.role}
                    </span>
                  )}
                </span>
                <span className="muted">{item.created_at}</span>
              </span>
              {item.artifact_id && item.kind === "image" && (
                <img
                  src={api.artifactContentUrl(item.artifact_id)}
                  alt=""
                  loading="lazy"
                  className="preview compact"
                />
              )}
              <span className="mono">{item.label ?? item.relative_path}</span>
              {item.artifact_id && (
                <IconButton
                  icon={<Icon name="expand" />}
                  label="拡大"
                  onClick={() =>
                    setViewerIndex(
                      viewerItems.findIndex(
                        (entry) => entry.id === item.artifact_id,
                      ),
                    )
                  }
                />
              )}
              {(item.character_ids ?? []).length > 0 && (
                <span className="row">
                  {(item.character_ids ?? []).map((id) => {
                    const character = characters.find((entry) => entry.id === id);
                    return (
                      <span key={id} className="badge">
                        {character?.name ?? id}
                      </span>
                    );
                  })}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <MediaViewer
        items={viewerItems}
        index={viewerIndex}
        onIndexChange={setViewerIndex}
        onClose={() => setViewerIndex(null)}
      />
    </section>
  );
}
