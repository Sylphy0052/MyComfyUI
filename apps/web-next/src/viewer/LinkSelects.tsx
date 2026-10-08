import { Select } from "@mantine/core";

import { useCharacters, useScenes } from "../projectDetail/useStory";
import { useProjectList } from "../projects/useProjects";
import { NO_LINKS, type StoryLinks } from "./viewerFilters";

type SelectSize = "xs" | "sm";

/** Project配下の選択肢。Projectを選んだときだけ描画し、キャラ・衣装・シーンを取る。 */
function ProjectChildSelects({
  projectId,
  value,
  onChange,
  disabled,
  size,
}: {
  projectId: string;
  value: StoryLinks;
  onChange: (next: StoryLinks) => void;
  disabled: boolean;
  size: SelectSize;
}) {
  const scenes = useScenes(projectId);
  const characters = useCharacters(projectId);
  const character = characters.data?.find((entry) => entry.id === value.character);
  return (
    <>
      <Select
        label="Scene"
        size={size}
        placeholder="指定なし"
        clearable
        searchable
        disabled={disabled}
        data={(scenes.data ?? []).map((scene) => ({ value: scene.id, label: scene.name || "(名前なし)" }))}
        value={value.scene}
        onChange={(scene) => onChange({ ...value, scene })}
      />
      <Select
        label="キャラ"
        size={size}
        placeholder="指定なし"
        clearable
        searchable
        disabled={disabled}
        data={(characters.data ?? []).map((entry) => ({ value: entry.id, label: entry.name }))}
        value={value.character}
        // 衣装はキャラクターのものなので、キャラを変えたら外す。
        onChange={(next) => onChange({ ...value, character: next, outfit: null })}
      />
      <Select
        label="衣装"
        size={size}
        placeholder="指定なし"
        clearable
        searchable
        disabled={disabled || !character}
        data={(character?.costumes ?? []).map((costume) => ({ value: costume.id, label: costume.name }))}
        value={value.outfit}
        onChange={(outfit) => onChange({ ...value, outfit })}
      />
    </>
  );
}

/** Project → Scene → キャラ → 衣装の選択。上の段を変えたら下の段は外す。 */
export function LinkSelects({
  value,
  onChange,
  disabled = false,
  size = "sm",
}: {
  value: StoryLinks;
  onChange: (next: StoryLinks) => void;
  disabled?: boolean;
  size?: SelectSize;
}) {
  const projects = useProjectList("active");
  return (
    <>
      <Select
        label="Project"
        size={size}
        placeholder="指定なし"
        clearable
        searchable
        disabled={disabled}
        data={(projects.data ?? []).map((project) => ({ value: project.id, label: project.name }))}
        value={value.project}
        onChange={(project) => onChange({ ...NO_LINKS, project })}
      />
      {value.project ? (
        <ProjectChildSelects
          key={value.project}
          projectId={value.project}
          value={value}
          onChange={onChange}
          disabled={disabled}
          size={size}
        />
      ) : (
        <>
          <Select label="Scene" size={size} placeholder="Projectを選ぶ" data={[]} disabled />
          <Select label="キャラ" size={size} placeholder="Projectを選ぶ" data={[]} disabled />
          <Select label="衣装" size={size} placeholder="Projectを選ぶ" data={[]} disabled />
        </>
      )}
    </>
  );
}
