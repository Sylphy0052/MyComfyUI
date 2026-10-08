import { createBrowserRouter, Navigate } from "react-router";

import { AppLayout } from "./layout/AppLayout";
import { BgmPage } from "./pages/BgmPage";
import { ImagePage } from "./pages/ImagePage";
import { ProjectDetailPage } from "./pages/ProjectDetailPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { SceneProducePage } from "./pages/SceneProducePage";
import { VideoPage } from "./pages/VideoPage";
import { ViewerPage } from "./pages/ViewerPage";
import { VoicePage } from "./pages/VoicePage";

export const router = createBrowserRouter([
  {
    path: "/",
    Component: AppLayout,
    children: [
      { index: true, element: <Navigate to="/projects" replace /> },
      { path: "projects", Component: ProjectsPage },
      { path: "projects/:projectId", Component: ProjectDetailPage },
      { path: "scenes/:sceneId/produce", Component: SceneProducePage },
      { path: "image", Component: ImagePage },
      { path: "video", Component: VideoPage },
      { path: "voice", Component: VoicePage },
      { path: "bgm", Component: BgmPage },
      { path: "viewer", Component: ViewerPage },
      { path: "*", element: <Navigate to="/projects" replace /> },
    ],
  },
]);
