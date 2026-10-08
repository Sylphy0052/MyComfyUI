import { ActionIcon, Alert, Button, Group, Select, SimpleGrid, Stack } from "@mantine/core";
import { IconX } from "@tabler/icons-react";

import type { StoryCharacter, StoryScene } from "../api/client";
import { useProjectList } from "../projects/useProjects";
import { CAST_MAX, type CastMember, type ImageTarget } from "./imageForm";

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
 * `multi`のとき (新規タブ) だけ、2人目以降のキャラと衣装の行を足せる。合計は`CAST_MAX`人まで。
 */
export function TargetPicker({
  target,
  onChange,
  characters,
  scenes,
  missing,
  multi,
  lockScene = false,
}: {
  target: ImageTarget;
  onChange: (target: ImageTarget) => void;
  characters: StoryCharacter[];
  scenes: StoryScene[];
  /** 指定されたのに見つからない対象の名前。 */
  missing: string[];
  /** 2人目以降を足せるか。参照・修正は1人ずつ。 */
  multi: boolean;
  /** ProjectとSceneを選び直せなくする。シーン生成の工程に埋め込むとき。 */
  lockScene?: boolean;
}) {
  const projects = useProjectList("active");
  const scene = scenes.find((item) => item.id === target.sceneId) ?? null;
  const character = characters.find((item) => item.id === target.characterId) ?? null;
  const castIds = new Set(scene?.cast.map((entry) => entry.character_id) ?? []);
  const projectOptions = (projects.data ?? []).map((project) => ({ value: project.id, label: project.name }));
  const extra = target.extraCast;
  /** 候補から除く、ほかの行で選んだキャラ。同じキャラは重ねて選べない。 */
  const optionsFor = (own: string | null) => {
    const others = new Set([target.characterId, ...extra.map((member) => member.characterId)]);
    return characters
      .filter((item) => item.id === own || !others.has(item.id))
      .map((item) => ({ value: item.id, label: castIds.has(item.id) ? `${item.name} (登場)` : item.name }));
  };
  const characterOptions = optionsFor(target.characterId);
  const total = (target.characterId === null ? 0 : 1) + extra.length;
  const firstFree = optionsFor(null)[0];
  const sceneCast = (scene?.cast ?? []).filter((entry) => characters.some((item) => item.id === entry.character_id));
  const setExtra = (index: number, member: CastMember) =>
    onChange({ ...target, extraCast: extra.map((item, i) => (i === index ? member : item)) });
  const selectSceneCast = () => {
    const [first, ...rest] = sceneCast.slice(0, CAST_MAX);
    if (!first) return;
    onChange({
      ...target,
      characterId: first.character_id,
      costumeId: first.costume_id ?? null,
      extraCast: rest.map((entry) => ({ characterId: entry.character_id, costumeId: entry.costume_id ?? null })),
    });
  };

  return (
    <>
      <SimpleGrid cols={2} spacing="xs">
        <Select
          label="Project"
          placeholder="指定しない"
          data={withCurrent(projectOptions, target.projectId)}
          value={target.projectId}
          onChange={(projectId) => onChange({ projectId, sceneId: null, characterId: null, costumeId: null, extraCast: [] })}
          searchable
          clearable={!lockScene}
          disabled={lockScene}
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
            const extraCast = extra.map((member) => ({
              ...member,
              costumeId: member.costumeId ?? castCostumeOf(next, member.characterId),
            }));
            onChange({ ...target, sceneId, costumeId, extraCast });
          }}
          disabled={target.projectId === null || lockScene}
          clearable={!lockScene}
        />
        <Select
          label="キャラ"
          placeholder="指定しない"
          data={withCurrent(characterOptions, target.characterId)}
          value={target.characterId}
          onChange={(characterId) =>
            onChange({
              ...target,
              characterId,
              costumeId: characterId ? castCostumeOf(scene, characterId) : null,
              extraCast: characterId ? extra : [],
            })
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
      {multi ? (
        <Stack gap="xs" data-testid="extra-cast">
          {extra.map((member, index) => (
            <Group key={member.characterId} gap="xs" align="flex-end" wrap="nowrap" data-testid="extra-cast-row">
              <Select
                label={`キャラ${index + 2}`}
                data={withCurrent(optionsFor(member.characterId), member.characterId)}
                value={member.characterId}
                onChange={(characterId) =>
                  characterId && setExtra(index, { characterId, costumeId: castCostumeOf(scene, characterId) })
                }
                searchable
                allowDeselect={false}
                style={{ flex: 1 }}
              />
              <Select
                label={`衣装${index + 2}`}
                placeholder="指定しない"
                data={withCurrent(
                  (characters.find((item) => item.id === member.characterId)?.costumes ?? []).map((item) => ({
                    value: item.id,
                    label: item.name,
                  })),
                  member.costumeId,
                )}
                value={member.costumeId}
                onChange={(costumeId) => setExtra(index, { ...member, costumeId })}
                clearable
                style={{ flex: 1 }}
              />
              <ActionIcon
                variant="subtle"
                color="gray"
                mb={4}
                aria-label={`キャラ${index + 2}を外す`}
                onClick={() => onChange({ ...target, extraCast: extra.filter((_, i) => i !== index) })}
              >
                <IconX size={16} />
              </ActionIcon>
            </Group>
          ))}
          <Group gap="xs">
            <Button
              size="compact-sm"
              variant="light"
              onClick={() =>
                firstFree &&
                onChange({
                  ...target,
                  extraCast: [
                    ...extra,
                    { characterId: firstFree.value, costumeId: castCostumeOf(scene, firstFree.value) },
                  ],
                })
              }
              disabled={target.characterId === null || total >= CAST_MAX || firstFree === undefined}
            >
              キャラを追加
            </Button>
            {scene !== null && scene.cast.length >= 2 ? (
              <Button size="compact-sm" variant="default" onClick={selectSceneCast} disabled={sceneCast.length < 2}>
                登場キャラをすべて選ぶ
              </Button>
            ) : null}
          </Group>
        </Stack>
      ) : null}
      {missing.length > 0 ? (
        <Alert color="yellow" title="指定した対象が見つかりません">
          {missing.join("・")}を選び直すか、外してください。
        </Alert>
      ) : null}
    </>
  );
}
