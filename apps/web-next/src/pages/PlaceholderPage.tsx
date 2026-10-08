import { Text, Title } from "@mantine/core";

/** 各画面の置き場。中身は後続のIssueで作る。 */
export function PlaceholderPage({ title }: { title: string }) {
  return (
    <>
      <Title order={2}>{title}</Title>
      <Text c="dimmed" mt="sm">この画面はまだ作っていません。</Text>
    </>
  );
}
