/**
 * 読み込み中の領域を空白やテキストだけにせず、形の近いスケルトンで示す。
 *
 * 見た目の行は支援技術から隠し、label を status として読み上げる。
 */
export function LoadingPlaceholder({
  label,
  lines = 3,
  variant = "lines",
}: {
  label: string;
  lines?: number;
  variant?: "lines" | "tiles";
}) {
  return (
    <div
      className={`loading-placeholder loading-placeholder-${variant}`}
      role="status"
    >
      <span className="visually-hidden">{label}</span>
      {Array.from({ length: lines }, (_, index) => (
        <span key={index} className="skeleton" aria-hidden="true" />
      ))}
    </div>
  );
}
