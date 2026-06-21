import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: "src/client",
  publicDir: resolve(__dirname, "src/client/public"),
  resolve: {
    alias: {
      "@": resolve(__dirname, "src/client"),
    },
  },
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // Anchored + trailing-slash so these never swallow client source modules
    // (e.g. a bare "/wiki" prefix would capture "/wikiPath.ts"). The SPA owns
    // /wiki/* routing itself; only the API needs forwarding to the server.
    proxy: {
      "^/api/": "http://127.0.0.1:8787",
      "^/media/": "http://127.0.0.1:8787",
    },
  },
});
