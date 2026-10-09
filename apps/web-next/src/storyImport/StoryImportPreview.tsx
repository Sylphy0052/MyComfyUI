import { Stack, Table, Text } from "@mantine/core";

import type { StoryImportResult } from "../api/client";

/** 取り込みの通知に出す、作った件数の要約。 */
export function summarizeImport(result: StoryImportResult): string {
  return `キャラクター${result.characters.created}件・衣装${result.costumes.created}件・シーン${result.scenes.created}件を作りました`;
}

/** 取り込み前のプレビューとして、作る件数を表で出す。 */
export function StoryImportCounts({ result }: { result: StoryImportResult }) {
  const rows = [
    { label: "キャラクター", counts: result.characters },
    { label: "衣装", counts: result.costumes },
    { label: "シーン", counts: result.scenes },
  ];
  const nothingToCreate = rows.every((row) => row.counts.created === 0);
  const { imported, not_imported } = result.reference_images;
  return (
    <Stack gap="xs">
      <Table withTableBorder data-testid="story-import-counts">
        <Table.Thead>
          <Table.Tr>
            <Table.Th />
            <Table.Th>作成する</Table.Th>
            <Table.Th>スキップ (取り込み済み)</Table.Th>
            <Table.Th>重複 (取り込み元内)</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map(({ label, counts }) => (
            <Table.Tr key={label}>
              <Table.Td>{label}</Table.Td>
              <Table.Td>{counts.created}件</Table.Td>
              <Table.Td>{counts.skipped}件</Table.Td>
              <Table.Td>{counts.duplicated}件</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Text size="sm">
        参照画像: 衣装へ取り込む{imported}件、画像ファイルが見つからず取り込めない{not_imported}件
      </Text>
      {nothingToCreate ? (
        <Text size="sm" c="dimmed">
          新しく作るものはありません。実行しても何も増えません。
        </Text>
      ) : null}
    </Stack>
  );
}
