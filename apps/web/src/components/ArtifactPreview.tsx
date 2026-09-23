import { useEffect, useState } from "react";

import { api } from "../api/client";
import type { Artifact } from "../api/client";
import { startArtifactDrag } from "./artifactDrag";

/**
 * 種別ごとのプレビュー。分岐は kind ではなく media_type で行う。
 *
 * 音楽は audio、最終動画は video として記録されるため、kind では画像・動画・音声・
 * 音楽・最終動画の 5 種類を分けられない。生成の由来は Job の kind が持つ。
 */
interface Props {
  artifact: Artifact;
  /** 一覧のサムネイルでは操作系を省き、高さを抑える。 */
  compact?: boolean;
}

/** media_type から画面に出す種別の名前を決める。 */
export function mediaLabel(mediaType: string): string {
  if (mediaType.startsWith("image/")) return "画像";
  if (mediaType.startsWith("video/")) return "動画";
  if (mediaType.startsWith("audio/")) return "音声";
  if (mediaType === "application/json") return "JSON";
  if (mediaType.startsWith("text/")) return "テキスト";
  return mediaType;
}

export function ArtifactPreview({ artifact, compact = false }: Props) {
  // 実ファイルを失った Artifact も記録としては残る。壊れた表示ではなく理由を出す。
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [artifact.id]);

  const url = api.artifactContentUrl(artifact.id);
  const className = compact ? "preview compact" : "preview";

  // availability が complete でないことは、取得を試す前から判っている。
  if (artifact.availability !== "complete") {
    return (
      <p className="preview-missing muted">
        実ファイルがなく、記録だけが残っています。
        <span className="muted">availability: {artifact.availability}</span>
      </p>
    );
  }

  if (failed) {
    return (
      <p className="preview-missing muted">
        ファイルを取得できません。移動または削除された可能性があります。
      </p>
    );
  }

  const mediaType = artifact.media_type;

  // onError は src より前に置く。React は props の順に属性を設定してリスナを登録する
  // ため、src を先に書くと初回の読み込み失敗を取りこぼす (音声で実測)。
  if (mediaType.startsWith("image/")) {
    return (
      <img
        className={className}
        onError={() => setFailed(true)}
        src={url}
        alt={`Artifact ${artifact.id}`}
        loading="lazy"
        draggable
        onDragStart={(event) =>
          startArtifactDrag(event, { id: artifact.id, media_type: mediaType })
        }
      />
    );
  }

  if (mediaType.startsWith("video/")) {
    return (
      <video
        className={className}
        onError={() => setFailed(true)}
        src={url}
        controls
        preload="metadata"
      />
    );
  }

  if (mediaType.startsWith("audio/")) {
    return (
      <audio
        className={className}
        onError={() => setFailed(true)}
        src={url}
        controls
        preload="metadata"
      />
    );
  }

  // 再生できない種別は中身を推測せずリンクだけを出す。
  return (
    <p className={`${className} preview-link`}>
      <a href={url} target="_blank" rel="noreferrer">
        {mediaLabel(mediaType)}を開く
      </a>
      <span className="muted"> ({mediaType})</span>
    </p>
  );
}
