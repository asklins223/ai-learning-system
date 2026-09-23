import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { trackInputModality } from "./app/input-modality";
import "./styles.css";
import "./components/home-room.css";
import "./components/approved-surfaces.css";
import "./components/hud/hud-pages.css";
import "./components/hud/hud-surface.css";
import "./components/hud/hud-controls.css";
import "./components/source-intake.css";
// 理解目标链路的修正层，必须排在 hud 层之后：它覆盖的是 hud-surface.css 自己的规则。
import "./components/objective-flow.css";
import "./components/card-generation-flow.css";
import "./components/surfaces/companion-center.css";

const root = document.getElementById("root");

if (!root) throw new Error("Desktop renderer root is missing");

// Document-wide, not per component: every text field shares the same
// `:focus-visible` behaviour, so every surface needs the same modality signal.
trackInputModality();

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
