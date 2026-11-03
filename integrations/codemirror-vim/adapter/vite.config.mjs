// Bundles vimunit/page.ts (with the plugin sources and the workspace's pinned
// CodeMirror packages) into vimunit/dist/vimunit-page.js. Run from
// packages/codemirror-vim: vite build --config vimunit/vite.config.mjs
import { fileURLToPath } from "url";
import * as path from "path";

const dir = path.dirname(fileURLToPath(import.meta.url));

export default {
  logLevel: "warn",
  build: {
    outDir: path.join(dir, "dist"),
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    lib: {
      entry: path.join(dir, "page.ts"),
      name: "vimunitPage",
      formats: ["iife"],
      fileName: () => "vimunit-page.js",
    },
  },
};
