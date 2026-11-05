// SPDX-License-Identifier: FSL-1.1-ALv2
import { resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"
import solid from "vite-plugin-solid"
import { devProxyFor } from "./src/lib/dev-proxy"
import { webBuildId } from "./src/lib/web-build-id-plugin"
import { mailboxWorkerIntegrity } from "./src/modules/mailbox/worker-integrity-plugin"

const apiTarget = process.env.VITE_API_TARGET ?? "http://localhost:3000"

/**
 * Shared by `server` and `preview`. The e2e lane can serve a real BUILD through
 * `vite preview` (`E2E_WEB_PREVIEW=1`), and without this the preview server has
 * no `/api` proxy and every request 404s against the static server.
 *
 * A build is not a nicety for the mailbox lane: `worker: { format: "iife" }`
 * below exists so the crypto worker is ONE self-contained file, which is what
 * makes the blob-URL boot possible. In `vite dev` the worker is served as a
 * module with imports, which a blob module worker cannot resolve, so the dev
 * boot starts it from its own URL instead (crypto-worker-boot.ts).
 */
const devProxy = devProxyFor(apiTarget)

/**
 * `vite build --mode native` is the build the mobile app wraps
 * (apps/mobile/scripts/build-mobile.ts). It differs from the web build in one
 * module: the legacy passphrase KDF (Argon2id through hash-wasm) is replaced by
 * a stand-in that carries none, so the iOS bundle holds only the cryptography
 * the operating system provides (WebCrypto, TLS), which is what keeps it exempt
 * from export documentation (apps/mobile/STORE_CHECKLIST.md). A legacy password
 * row is then refused on the device with its own message. It writes to
 * `dist-native`, never `dist`: the desktop shell embeds `dist`, and it must keep
 * the legacy KDF that converts those rows.
 */
export const NATIVE_MODE = "native"
export const NATIVE_OUT_DIR = "dist-native"
const LEGACY_KDF_SPECIFIER = /^\.\/legacy-passphrase-kdf$/
const NATIVE_LEGACY_KDF = resolve(
  __dirname,
  "../../packages/mailbox-crypto/src/legacy-passphrase-kdf.native.ts",
)

export default defineConfig(({ mode }) => ({
  // The mailbox crypto worker is booted from a blob URL after the page verifies
  // its SHA-256, so it must be ONE self-contained file with no imports of its
  // own: a blob has no path for a sibling chunk to resolve against, and a
  // sibling fetched at runtime would not have been verified anyway.
  worker: { format: "iife" },
  // The plugin is typed structurally rather than against rollup's own types, so
  // it is cast in here.
  // webBuildId runs last: it hashes what the build finally emits (lib/web-build.ts).
  plugins: [solid(), tailwindcss(), mailboxWorkerIntegrity() as never, webBuildId() as never],
  resolve: {
    alias: [
      { find: "~", replacement: resolve(__dirname, "src") },
      // Every `from "zod"` gets zod configured jitless before any schema is built, so nothing in
      // the bundle reaches for eval under the CSP (src/lib/zod-jitless.ts).
      { find: /^zod$/, replacement: resolve(__dirname, "src/lib/zod-jitless.ts") },
      ...(mode === NATIVE_MODE
        ? [{ find: LEGACY_KDF_SPECIFIER, replacement: NATIVE_LEGACY_KDF }]
        : []),
    ],
    // One marked: the editor's markdown extension asks for an older major,
    // which would otherwise ship a second copy inside the editor chunk.
    dedupe: ["marked"],
  },
  build: mode === NATIVE_MODE ? { outDir: NATIVE_OUT_DIR } : {},
  preview: {
    proxy: devProxy,
  },
  server: {
    port: 5173,
    proxy: devProxy,
    watch: {
      ignored: ["**/logs/**", "**/test-results/**", "**/playwright-report/**"],
    },
  },
  optimizeDeps: {
    entries: ["index.html", "src/**/*.{ts,tsx}"],
    exclude: ["fsevents"],
  },
}))
