import { useEffect, useState } from "react";
import type { Artifact, GenerationJob } from "../api/client";
import { ArtifactPreview } from "./ArtifactPreview";

type Props = {
  // 成功した Job のうち最新のもの。無ければ null。
  job: GenerationJob | null;
  images: Artifact[];
};

// 最後に成功した Job の画像を1枚ずつ表示する。バッチで複数枚あるときはスライダーで切り替える。
export function LatestImageViewer({ job, images }: Props) {
  const [index, setIndex] = useState(0);

  // 新しい Job に切り替わったら1枚目へ戻す。
  useEffect(() => {
    setIndex(0);
  }, [job?.id]);

  const count = images.length;
  const current = count > 0 ? images[Math.min(index, count - 1)] : null;

  return (
    <section className="panel latest-image">
      <div className="row spread">
        <h2>最新の生成画像</h2>
        {job && (
          <span className="muted">
            順番 {job.queue_sequence}
            {count > 1 && ` / ${Math.min(index, count - 1) + 1} / ${count}枚`}
          </span>
        )}
      </div>
      {current ? (
        <ArtifactPreview key={current.id} artifact={current} />
      ) : (
        <p className="muted">
          {job ? "最新のJobに画像がありません。" : "まだ生成した画像がありません。"}
        </p>
      )}
      {count > 1 && (
        <div className="row latest-image-slider">
          <button
            type="button"
            aria-label="前の画像"
            disabled={index <= 0}
            onClick={() => setIndex((value) => Math.max(0, value - 1))}
          >
            ‹
          </button>
          <input
            type="range"
            aria-label="表示する画像"
            min={0}
            max={count - 1}
            step={1}
            value={Math.min(index, count - 1)}
            onChange={(event) => setIndex(Number(event.target.value))}
          />
          <button
            type="button"
            aria-label="次の画像"
            disabled={index >= count - 1}
            onClick={() => setIndex((value) => Math.min(count - 1, value + 1))}
          >
            ›
          </button>
        </div>
      )}
    </section>
  );
}
