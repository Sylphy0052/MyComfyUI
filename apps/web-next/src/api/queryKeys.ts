/** 画面をまたいで使うqueryKey。WebSocketのイベントからの無効化 (events.ts) もここを参照する。 */
export const queryKeys = {
  jobs: ["generation-jobs"] as const,
  // `jobs`の無効化に巻き込まれないよう、Job一覧とは別の系統に置く。
  jobProgress: (jobId: string) => ["generation-job-progress", jobId] as const,
  project: (projectId: string) => ["projects", projectId] as const,
  projects: ["projects"] as const,
  // `projects`の下に置き、Projectの変更で`projects`ごと無効化したときに一緒に取り直す。
  projectList: (lifecycle: "active" | "trashed") => ["projects", "list", lifecycle] as const,
  // キャラクター・衣装・シーンもProjectの下に置き、Projectの変更で一緒に取り直す。
  projectCharacters: (projectId: string) => ["projects", projectId, "characters"] as const,
  projectScenes: (projectId: string) => ["projects", projectId, "story-scenes"] as const,
  sceneAdoptions: (projectId: string, sceneId: string) =>
    ["projects", projectId, "story-scenes", sceneId, "adoptions"] as const,
  artifact: (artifactId: string) => ["artifacts", artifactId] as const,
};
