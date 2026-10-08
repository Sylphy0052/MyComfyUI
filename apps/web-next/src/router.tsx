import { createBrowserRouter, Navigate } from "react-router";

import { AppLayout } from "./layout/AppLayout";
import { ImagePage } from "./pages/ImagePage";
import { PlaceholderPage } from "./pages/PlaceholderPage";
import { ProjectDetailPage } from "./pages/ProjectDetailPage";
import { ProjectsPage } from "./pages/ProjectsPage";

export const router = createBrowserRouter([
  {
    path: "/",
    Component: AppLayout,
    children: [
      { index: true, element: <Navigate to="/projects" replace /> },
      { path: "projects", Component: ProjectsPage },
      { path: "projects/:projectId", Component: ProjectDetailPage },
      { path: "image", Component: ImagePage },
      { path: "video", element: <PlaceholderPage title="動画" /> },
      { path: "voice", element: <PlaceholderPage title="音声" /> },
      { path: "bgm", element: <PlaceholderPage title="BGM" /> },
      { path: "viewer", element: <PlaceholderPage title="Viewer" /> },
      { path: "*", element: <Navigate to="/projects" replace /> },
    ],
  },
]);
