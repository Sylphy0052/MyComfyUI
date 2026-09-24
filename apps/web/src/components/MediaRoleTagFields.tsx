import { useEffect, useState } from "react";

import { api } from "../api/client";
import type { MediaRole, ProjectCharacterProfile } from "../api/client";
import { MEDIA_ROLE_LABEL, MEDIA_ROLE_OPTIONS_BY_KIND } from "./mediaRole";

/**
 * Projectに登録されたキャラクター。`enabled`がfalseかProject未選択なら空。
 * 取得に失敗しても役割タグ付け以外は継続できるよう、空として扱う。
 */
export function useProjectCharacters(
  projectId: string | null,
  enabled = true,
): ProjectCharacterProfile[] {
  const [characters, setCharacters] = useState<ProjectCharacterProfile[]>([]);
  useEffect(() => {
    if (!enabled || !projectId) {
      setCharacters([]);
      return;
    }
    let active = true;
    api
      .getProjectLocalOverrides(projectId)
      .then((overrides) => {
        if (active) setCharacters(overrides.characters ?? []);
      })
      .catch(() => {
        if (active) setCharacters([]);
      });
    return () => {
      active = false;
    };
  }, [enabled, projectId]);
  return characters;
}

interface MediaRoleTagFieldsProps {
  kind: "image" | "audio";
  role: MediaRole | "";
  onRoleChange: (role: MediaRole | "") => void;
  characters: ProjectCharacterProfile[];
  characterIds: string[];
  onCharacterIdsChange: (characterIds: string[]) => void;
  disabled?: boolean;
}

/** 取込時に付ける役割とキャラクターの選択欄 (Issue #148, #249)。 */
export function MediaRoleTagFields({
  kind,
  role,
  onRoleChange,
  characters,
  characterIds,
  onCharacterIdsChange,
  disabled = false,
}: MediaRoleTagFieldsProps) {
  const toggleCharacter = (characterId: string) => {
    onCharacterIdsChange(
      characterIds.includes(characterId)
        ? characterIds.filter((id) => id !== characterId)
        : [...characterIds, characterId],
    );
  };

  return (
    <div className="row media-picker-role-tagging">
      <select
        value={role}
        disabled={disabled}
        onChange={(event) => onRoleChange(event.target.value as MediaRole | "")}
      >
        <option value="">役割を指定しない</option>
        {MEDIA_ROLE_OPTIONS_BY_KIND[kind].map((item) => (
          <option key={item} value={item}>
            {MEDIA_ROLE_LABEL[item]}
          </option>
        ))}
      </select>
      {characters.length > 0 && (
        <div className="row media-picker-characters">
          {characters.map((character) => (
            <label key={character.id} className="row">
              <input
                type="checkbox"
                checked={characterIds.includes(character.id)}
                disabled={disabled}
                onChange={() => toggleCharacter(character.id)}
              />
              {character.name}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
