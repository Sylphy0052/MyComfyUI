import { EMPTY_TARGET, normalizeExtraCast, type CastMember, type ImageTarget } from "./imageForm";

/** URLのクエリ名。衣装は設計文書に合わせて`outfit`とする。2人目以降は繰り返しクエリ`cast=<キャラID>:<衣装ID>`。 */
export const TARGET_PARAMS: ["projectId" | "sceneId" | "characterId" | "costumeId", string][] = [
  ["projectId", "project"],
  ["sceneId", "scene"],
  ["characterId", "character"],
  ["costumeId", "outfit"],
];

/**
 * 2人目以降のキャラ。1人ごとに`cast=<キャラID>:<衣装ID>`を繰り返す。衣装が無ければ`<キャラID>:`。
 * IDはUUIDで`:`を含まないため、最初の`:`で分ける。
 */
const CAST_PARAM = "cast";

function castToParam(member: CastMember): string {
  return `${member.characterId}:${member.costumeId ?? ""}`;
}

function castFromParam(value: string): CastMember[] {
  const at = value.indexOf(":");
  const characterId = at < 0 ? value : value.slice(0, at);
  const costumeId = at < 0 ? "" : value.slice(at + 1);
  return characterId === "" ? [] : [{ characterId, costumeId: costumeId || null }];
}

export function targetFromParams(params: URLSearchParams): ImageTarget {
  const target = { ...EMPTY_TARGET };
  for (const [field, name] of TARGET_PARAMS) target[field] = params.get(name) || null;
  target.extraCast = normalizeExtraCast(target.characterId, params.getAll(CAST_PARAM).flatMap(castFromParam));
  return target;
}

export function paramsFromTarget(target: ImageTarget): URLSearchParams {
  const params = new URLSearchParams();
  for (const [field, name] of TARGET_PARAMS) {
    const value = target[field];
    if (value) params.set(name, value);
  }
  for (const member of target.extraCast) params.append(CAST_PARAM, castToParam(member));
  return params;
}

function hasAny(target: ImageTarget | null): boolean {
  return target !== null && (TARGET_PARAMS.some(([field]) => target[field] !== null) || target.extraCast.length > 0);
}

/**
 * 開いたURLに対象が無ければ、最後に使った対象へ戻す。ナビはProjectだけを引き継ぐため、
 * Projectだけが前回と同じなら、Scene・キャラ・衣装も前回の値へ戻す。
 */
export function initialTarget(fromUrl: ImageTarget, stored: ImageTarget | null): ImageTarget | null {
  if (stored === null || !hasAny(stored)) return null;
  if (!hasAny(fromUrl)) return stored;
  const onlyProject =
    fromUrl.sceneId === null &&
    fromUrl.characterId === null &&
    fromUrl.costumeId === null &&
    fromUrl.extraCast.length === 0;
  return onlyProject && fromUrl.projectId === stored.projectId ? stored : null;
}
