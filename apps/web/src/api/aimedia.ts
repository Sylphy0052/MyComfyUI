/**
 * ai-media 参照 API v1 のうち、画面が読む項目だけの型。
 *
 * 正本は `contracts/ai-media/v1/schema/reference-api.schema.json` とする。
 * Application API はこの本文をそのまま中継するため、OpenAPI 側では任意の object に
 * なる。ここでは表示に使う項目だけを宣言し、本文全体の再定義はしない。
 */

export interface ImmutableReference {
  source_locator: string;
  revision: string;
  path: string;
  sha256: string;
  anchor?: string | null;
  note?: string | null;
}

export interface Project {
  id: string;
  title: string | null;
  source: { source_locator: string; revision: string };
  scene_count: number;
  canon_count: number;
}

export interface ProjectList {
  items: Project[];
}

export interface SceneSummary {
  id: string;
  project_id: string;
  sequence: number;
  summary: string;
  shot_count: number;
  reference: ImmutableReference;
}

export interface SceneList {
  items: SceneSummary[];
}

export interface ShotSummary {
  id: string;
  scene_id: string;
  sequence: number;
  duration_sec: number;
  summary: string;
  reference: ImmutableReference;
}

export interface ShotList {
  items: ShotSummary[];
}

export interface Provenance {
  resource: ImmutableReference;
  schema: { name: string; reference: ImmutableReference };
  references: {
    json_pointer: string;
    declared_path: string;
    reference: ImmutableReference;
  }[];
}

export interface SceneData {
  id: string;
  project_id: string;
  summary: string;
  location?: { id: string; display_name?: string | null };
  time_of_day?: string;
  season?: string | null;
  characters?: { id: string; display_name?: string | null }[];
  goal?: string | null;
}

export interface SceneEnvelope {
  kind: "scene";
  data: SceneData;
  provenance: Provenance;
}

export interface ShotData {
  id: string;
  scene_id: string;
  sequence: number;
  duration_sec: number;
  summary: string;
  camera?: {
    framing: string;
    angle?: string;
    movement?: string;
    composition?: string | null;
  };
  characters?: {
    character_id: string;
    role?: string;
    action?: string | null;
    expression?: string | null;
  }[];
  dialogue?: {
    speaker: string;
    text: string;
    reading?: string | null;
    voice_id: string;
  }[];
}

export interface ShotEnvelope {
  kind: "shot";
  data: ShotData;
  provenance: Provenance;
}
