import { Alert, Select, SimpleGrid } from "@mantine/core";

import type { StoryCharacter, StoryScene } from "../api/client";
import { useProjectList } from "../projects/useProjects";
import type { ImageTarget } from "./imageForm";

/** 一覧に無いID (ゴミ箱のProjectなど) も選択中の値として出せるよう、候補へ足す。 */
function withCurrent(options: { value: string; label: string }[], current: string | null) {
  if (current === null || options.some((option) => option.value === current)) return options;
  return [...options, { value: current, label: `(見つかりません) ${current}` }];
}

/** Sceneに登場するキャラなら、その衣装。 */
function castCostumeOf(scene: StoryScene | null, characterId: string): string | null {
  return scene?.cast.find((entry) => entry.character_id === characterId)?.costume_id ?? null;
}

/**
 * 生成対象の選択。Project → Scene → 登場キャラ (キャラと衣装の組) の順に絞る。すべて任意。
 * キャラを選ぶと、Sceneに登場していればその衣装を入れる。
 */
export function TargetPicker({
  target,
  onChange,
  characters,
  scenes,
  missing,
}: {
  target: ImageTarget;
  onChange: (target: ImageTarget) => void;
  characters: StoryCharacter[];
  scenes: StoryScene[];
  /** 指定されたのに見つからない対象の名前。 */
  missing: string[];
}) {
  const projects = useProjectList("active");
  const scene = scenes.find((item) => item.id === target.sceneId) ?? null;
  const character = characters.find((item) => item.id === target.characterId) ?? null;
  const castIds = new Set(scene?.cast.map((entry) => entry.character_id) ?? []);
  const projectOptions = (projects.data ?? []).map((project) => ({ value: project.id, label: project.name }));
  const characterOptions = characters.map((item) => ({
    value: item.id,
    label: castIds.has(item.id) ? `${item.name} (登場)` : item.name,
  }));

  return (
    <>
      <SimpleGrid cols={2} spacing="xs">
        <Select
          label="Project"
          placeholder="指定しない"
          data={withCurrent(projectOptions, target.projectId)}
          value={target.projectId}
          onChange={(projectId) => onChange({ projectId, sceneId: null, characterId: null, costumeId: null })}
          searchable
          clearable
          error={projects.error?.message}
        />
        <Select
          label="Scene"
          placeholder="指定しない"
          data={withCurrent(
            scenes.map((item) => ({ value: item.id, label: item.name })),
            target.sceneId,
          )}
          value={target.sceneId}
          onChange={(sceneId) => {
            const next = scenes.find((item) => item.id === sceneId) ?? null;
            const costumeId =
              target.costumeId ?? (target.characterId ? castCostumeOf(next, target.characterId) : null);
            onChange({ ...target, sceneId, costumeId });
          }}
          disabled={target.projectId === null}
          clearable
        />
        <Select
          label="キャラ"
          placeholder="指定しない"
          data={withCurrent(characterOptions, target.characterId)}
          value={target.characterId}
          onChange={(characterId) =>
            onChange({ ...target, characterId, costumeId: characterId ? castCostumeOf(scene, characterId) : null })
          }
          disabled={target.projectId === null}
          searchable
          clearable
        />
        <Select
          label="衣装"
          placeholder="指定しない"
          data={withCurrent(
            (character?.costumes ?? []).map((item) => ({ value: item.id, label: item.name })),
            target.costumeId,
          )}
          value={target.costumeId}
          onChange={(costumeId) => onChange({ ...target, costumeId })}
          disabled={target.characterId === null}
          clearable
        />
      </SimpleGrid>
      {missing.length > 0 ? (
        <Alert color="yellow" title="指定した対象が見つかりません">
          {missing.join("・")}を選び直すか、外してください。
        </Alert>
      ) : null}
    </>
  );
}
