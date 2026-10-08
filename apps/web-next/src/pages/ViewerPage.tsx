import { Alert, Stack, Tabs, Title } from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";

import { ArtifactDrawer } from "../viewer/ArtifactDrawer";
import { MediaTab } from "../viewer/MediaTab";
import { TrashTab } from "../viewer/TrashTab";
import { useJobArtifact } from "../viewer/useViewer";
import { ViewerFilterBar } from "../viewer/ViewerFilterBar";
import {
  MEDIA_TABS,
  mediaItemsQuery,
  readFilters,
  readTab,
  writeFilters,
  type MediaTabId,
  type ViewerFilters,
} from "../viewer/viewerFilters";

const MEDIA_TAB_LABELS: Record<MediaTabId, string> = { image: "画像", video: "動画", voice: "音声", bgm: "BGM" };
const MEDIA_TAB_IDS = Object.keys(MEDIA_TABS) as MediaTabId[];

/**
 * `/viewer`。タブとフィルタはURLに持たせ、開き直すと同じ条件で出す。
 * `?artifact=`で来たときは (生成画面の「Viewerで開く」)、その生成物を詳細で開く。
 * `?job=`で来たときは (Jobのドロワーの「結果を開く」)、そのJobの生成物を詳細で開く。
 */
export function ViewerPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = readTab(searchParams);
  const filters = readFilters(searchParams);
  const linkedArtifactId = searchParams.get("artifact") || null;
  const jobId = searchParams.get("job") || null;
  const jobArtifact = useJobArtifact(jobId);
  const [openedId, setOpenedId] = useState<string | null>(null);
  const drawerId = openedId ?? linkedArtifactId ?? (jobId !== null ? (jobArtifact.data?.id ?? null) : null);

  // react-routerの`setSearchParams`は関数で渡しても描画時のURLを元にするので、URLへの反映前に続けて操作すると
  // 前の変更が消える。最後に書いたURLを持っておき、そこへ重ねる。
  const latestParams = useRef(searchParams);
  useEffect(() => {
    latestParams.current = searchParams;
  }, [searchParams]);
  const updateParams = (update: (params: URLSearchParams) => URLSearchParams) => {
    const params = update(new URLSearchParams(latestParams.current));
    latestParams.current = params;
    setSearchParams(params, { replace: true });
  };

  const setFilters = (patch: Partial<ViewerFilters>) =>
    updateParams((params) => writeFilters(params, { ...readFilters(params), ...patch }));
  const setTab = (next: string | null) =>
    updateParams((params) => {
      if (next === "trash" || next === "video" || next === "voice" || next === "bgm") params.set("tab", next);
      else params.delete("tab");
      return params;
    });
  const closeDrawer = () => {
    setOpenedId(null);
    // 閉じたあとに同じ生成物が開き直さないよう、`artifact`と`job`を外す。
    if (linkedArtifactId !== null || jobId !== null)
      updateParams((params) => {
        params.delete("artifact");
        params.delete("job");
        return params;
      });
  };

  return (
    <Stack>
      <Title order={2}>Viewer</Title>
      {jobId !== null && jobArtifact.data === null ? (
        <Alert color="yellow" variant="light">
          このJobの生成物はありません (まだ終わっていないか、ゴミ箱にあります)。
        </Alert>
      ) : null}
      {jobArtifact.error ? <Alert color="red">Jobの生成物を取得できません: {jobArtifact.error.message}</Alert> : null}
      <Tabs value={tab} onChange={setTab}>
        <Tabs.List>
          {MEDIA_TAB_IDS.map((id) => (
            <Tabs.Tab key={id} value={id}>
              {MEDIA_TAB_LABELS[id]}
            </Tabs.Tab>
          ))}
          <Tabs.Tab value="trash">ゴミ箱</Tabs.Tab>
        </Tabs.List>
        {MEDIA_TAB_IDS.map((id) => (
          <Tabs.Panel key={id} value={id} pt="md">
            {tab === id ? (
              <Stack gap="sm">
                <ViewerFilterBar filters={filters} onChange={setFilters} />
                {/* 条件が変わったら選択を持ち越さないよう、絞り込みごとに作り直す。 */}
                <MediaTab
                  key={mediaItemsQuery(MEDIA_TABS[id], filters).toString()}
                  spec={MEDIA_TABS[id]}
                  filters={filters}
                  onOpen={setOpenedId}
                />
              </Stack>
            ) : null}
          </Tabs.Panel>
        ))}
        <Tabs.Panel value="trash" pt="md">
          {tab === "trash" ? <TrashTab onOpen={setOpenedId} /> : null}
        </Tabs.Panel>
      </Tabs>
      <ArtifactDrawer artifactId={drawerId} onClose={closeDrawer} />
    </Stack>
  );
}
