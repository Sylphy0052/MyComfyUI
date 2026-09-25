type Props = {
  collapsed: boolean;
  onToggle: () => void;
  /** 開閉する本文のid。aria-controlsに渡す。 */
  controls: string;
  /** 読み上げ用のパネル名。 */
  label: string;
};

/** パネル見出しに置く開閉ボタン (#402)。 */
export function PanelCollapseToggle({
  collapsed,
  onToggle,
  controls,
  label,
}: Props) {
  return (
    <button
      type="button"
      className="panel-collapse-toggle"
      aria-expanded={!collapsed}
      aria-controls={controls}
      aria-label={`${label}を${collapsed ? "開く" : "閉じる"}`}
      onClick={onToggle}
    >
      {collapsed ? "開く" : "閉じる"}
    </button>
  );
}
