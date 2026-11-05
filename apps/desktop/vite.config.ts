// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The desktop OVERLAY, not an application. apps/web is served into the
// webview unmodified (6a T03) and stays frozen; everything the desktop adds on
// top of it is built here into one self contained script that the shell
// injects as a Tauri `initialization_script` before the page loads.
//
// That is why the build is a library in IIFE form with no HTML entry: there is
// no index.html to serve, no module graph for the browser to fetch, and no
// second origin. One file, evaluated in the page.

import { resolve } from "node:path"
import { defineConfig } from "vite"
import solid from "vite-plugin-solid"

export default defineConfig({
  plugins: [solid()],
  resolve: {
    alias: {
      "~": resolve(import.meta.dirname, "src"),
      // See vitest.config.ts: apps/web has no `exports` map, so the shared
      // model gating is reached by workspace path rather than copied.
      "@liaison/web": resolve(import.meta.dirname, "../web/src"),
      "@liaison/shared/": `${resolve(import.meta.dirname, "../../packages/shared/src")}/`,
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // No hashed name and no manifest: the shell includes this exact path at
    // compile time, so the file name is part of the contract.
    lib: {
      entry: resolve(import.meta.dirname, "src/overlay.tsx"),
      name: "LiaisonDesktopOverlay",
      formats: ["iife"],
      fileName: () => "overlay.js",
    },
    // Nothing is external: an injected script has no import map and no module
    // loader behind it, so every dependency has to be in the bundle.
    rollupOptions: { external: [] },
  },
})
