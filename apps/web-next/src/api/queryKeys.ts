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
  // 生成物の一覧。採否・紐づけ・ゴミ箱の変更で、条件ごとのページをまとめて取り直す。
  mediaItems: ["media-items"] as const,
  viewerImages: (query: string) => ["media-items", "viewer-images", query] as const,
  artifactLists: ["artifact-lists"] as const,
  trashedArtifacts: ["artifact-lists", "trashed"] as const,
  jobArtifacts: (jobId: string) => ["artifact-lists", "job", jobId] as const,
  // `jobs`の無効化に巻き込まれないよう、Job一覧とは別の系統に置く。
  generationJob: (jobId: string) => ["generation-job", jobId] as const,
  generationManifest: (manifestId: string) => ["generation-manifests", manifestId] as const,
};
