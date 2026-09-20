import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./workspace.css";
import { WorkspaceApp } from "./workspace";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WorkspaceApp />
  </StrictMode>,
);
