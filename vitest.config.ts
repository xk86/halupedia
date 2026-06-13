import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Force a single `three` instance across our code, DragControls, and
  // troika-three-text. Without this, vitest can resolve the ESM build for one
  // importer and the CJS build for another, and three logs "Multiple instances
  // of Three.js being imported" (its internal singletons then disagree).
  resolve: { dedupe: ["three"] },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["tests/client/**/*.test.ts", "tests/client/**/*.test.tsx"],
  },
});
