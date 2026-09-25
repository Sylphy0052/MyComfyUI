import { useEffect, useState } from "react";
import type { Artifact, GenerationJob, GenerationManifest } from "../api/client";
import { usePanelCollapsed } from "../state/panelCollapseState";
import { ArtifactPreview } from "./ArtifactPreview";
import { Icon } from "./ui/Icon";
import { IconButton } from "./ui/IconButton";
import { PanelCollapseToggle } from "./ui/PanelCollapseToggle";

type Props = {
  // 成功した Job のうち最新のもの。無ければ null。
  job: GenerationJob | null;
  images: Artifact[];
  // job に対応する生成条件。取得前/失敗時は null (#320)。
  manifest: GenerationManifest | null;
  onApplySettings?: (job: GenerationJob, manifest: GenerationManifest) => void;
  onApplyPromptOnly?: (job: GenerationJob, manifest: GenerationManifest) => void;
  onApplySeedOnly?: (job: GenerationJob, manifest: GenerationManifest) => void;
  onDerive?: (artifactId: string) => void;
  onChangeSource?: (artifactId: string) => void;
};

// 最後に成功した Job の画像を1枚ずつ表示する。バッチで複数枚あるときはスライダーで切り替える。
export function LatestImageViewer({
  job,
  images,
  manifest,
  onApplySettings,
  onApplyPromptOnly,
  onApplySeedOnly,
  onDerive,
  onChangeSource,
}: Props) {
  const [index, setIndex] = useState(0);
  const [collapsed, toggleCollapsed] = usePanelCollapsed("latestImage");

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
        <div className="row">
          {job && (
            <span className="muted">
              順番 {job.queue_sequence}
              {count > 1 && ` / ${Math.min(index, count - 1) + 1} / ${count}枚`}
            </span>
          )}
          <PanelCollapseToggle
            collapsed={collapsed}
            onToggle={toggleCollapsed}
            controls="latest-image-body"
            label="最新の生成画像"
          />
        </div>
      </div>
      <div id="latest-image-body" hidden={collapsed}>
        {current ? (
          <ArtifactPreview key={current.id} artifact={current} />
        ) : (
          <p className="muted">
            {job ? "最新のJobに画像がありません。" : "まだ生成した画像がありません。"}
          </p>
        )}
        {job && manifest && current && (
          <div className="candidate-actions">
            <div className="action-group" role="group" aria-label="適用">
              {onApplySettings && (
                <IconButton
                  icon={<Icon name="sliders" />}
                  label="設定を適用"
                  onClick={() => onApplySettings(job, manifest)}
                />
              )}
              {onApplyPromptOnly && (
                <IconButton
                  icon={<Icon name="text" />}
                  label="プロンプトのみ適用"
                  onClick={() => onApplyPromptOnly(job, manifest)}
                />
              )}
              {onApplySeedOnly && (
                <IconButton
                  icon={<Icon name="dice" />}
                  label="seedのみ適用"
                  onClick={() => onApplySeedOnly(job, manifest)}
                />
              )}
            </div>
            <div className="action-group" role="group" aria-label="送る">
              {onDerive && (
                <IconButton
                  icon={<Icon name="branch" />}
                  label="派生生成"
                  onClick={() => onDerive(current.id)}
                />
              )}
              {onChangeSource && (
                <IconButton
                  icon={<Icon name="branch" />}
                  label="この画像を変える"
                  onClick={() => onChangeSource(current.id)}
                />
              )}
            </div>
          </div>
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
      </div>
    </section>
  );
}
