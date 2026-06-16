import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
// tailwind.css owns the full CSS cascade: it @imports katex, the legacy
// styles.css, and Tailwind's theme/utilities into explicitly ordered layers.
import "./tailwind.css";

const root = createRoot(document.getElementById("root")!);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
