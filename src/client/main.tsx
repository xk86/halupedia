import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
// tailwind.css owns the full CSS cascade: it @imports katex, the legacy
// styles.css, and Tailwind's theme/utilities into explicitly ordered layers.
import "./tailwind.css";

// The ::highlight(halu-selection) rule styles the CSS Custom Highlight API mark
// used to persist the selection while the edit tray is open (see App.tsx). It's
// injected at runtime rather than authored in styles.css because the bundler's
// CSS engine (Lightning CSS 1.32) doesn't yet recognize the ::highlight()
// pseudo-element and emits a build warning for it.
const haluHighlightStyle = document.createElement("style");
haluHighlightStyle.textContent =
  "::highlight(halu-selection){background-color:var(--accent,#c9a227);color:inherit;opacity:.35}";
document.head.appendChild(haluHighlightStyle);

const root = createRoot(document.getElementById("root")!);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
