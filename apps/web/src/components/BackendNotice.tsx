import type { AgentProvider } from "../api/client";

/**
 * オンデマンドで起動する Backend の副作用を、選ぶ前に知らせる。
 *
 * Remote GPU Host では Qwen と ComfyUI が排他で、Qwen を使うと生成が止まる。
 * 停止からの起動には待ち時間もある。どちらも選んだ後では取り返しがつかないため、
 * 選択肢のそばに出す。常駐する Provider は backend を持たないので何も出さない。
 */
export function backendNotice(provider: AgentProvider): string | null {
  const backend = provider.backend;
  if (!backend) return null;
  if (backend.starting) return "起動中。応答するまで待つ";
  if (backend.conflicts_running) {
    // 排他で動く前提なので ready と両立しないはずだが、状態は API の外で組み立てられる。
    // 両方立っていたら前提が崩れているため、黙って通さず ComfyUI 側の停止を知らせる。
    return backend.ready
      ? "ComfyUI が同時に動いている。使うと ComfyUI が停止して生成が止まる"
      : "停止中。使うと ComfyUI が停止して生成が止まる";
  }
  if (!backend.ready) return "停止中。最初の要求で起動するため待ち時間がある";
  if (backend.sleeping) return "省電力中。最初の要求で復帰する";
  return null;
}

/** `option` のように要素を入れられない場所で使う、文字列だけの注記。 */
export function noticeSuffix(provider: AgentProvider): string {
  const notice = backendNotice(provider);
  return notice ? ` - ${notice}` : "";
}

/** Provider 一覧と選択欄に添える注記。出すものが無ければ何も描画しない。 */
export function BackendNotice({ provider }: { provider: AgentProvider }) {
  const notice = backendNotice(provider);
  if (!notice) return null;
  return <span className="muted"> - {notice}</span>;
}

/**
 * Qwen を使う機能のうち、Provider を選ばずに走るものへ添える注記。
 *
 * 画像タグの整理は `image_tagger_refine` が有効なときだけ推論サーバーを呼ぶ。
 * この設定は API が公開していないため、整理が有効な場合という条件を文面に残す。
 *
 * backend を返すのは整理に使う Qwen だけなので、最初に見つかったものを対象とする。
 * 別の Provider が backend を持つようになったら、対象を id で選び直す必要がある。
 */
export function conflictNotice(providers: AgentProvider[]): string | null {
  const backend = providers.find((provider) => provider.backend)?.backend;
  if (!backend || backend.ready || !backend.conflicts_running) return null;
  return "タグの整理が有効な場合、整理のために ComfyUI が停止して生成が止まる";
}
