import { createBrowserRouter, Navigate } from "react-router";

import { AppLayout } from "./layout/AppLayout";
import { PlaceholderPage } from "./pages/PlaceholderPage";

export const router = createBrowserRouter([
  {
    path: "/",
    Component: AppLayout,
    children: [
      { index: true, element: <Navigate to="/projects" replace /> },
      { path: "projects", element: <PlaceholderPage title="Project" /> },
      { path: "projects/:projectId", element: <PlaceholderPage title="Project" /> },
      { path: "image", element: <PlaceholderPage title="画像" /> },
      { path: "video", element: <PlaceholderPage title="動画" /> },
      { path: "voice", element: <PlaceholderPage title="音声" /> },
      { path: "bgm", element: <PlaceholderPage title="BGM" /> },
      { path: "viewer", element: <PlaceholderPage title="Viewer" /> },
      { path: "*", element: <Navigate to="/projects" replace /> },
    ],
  },
]);
