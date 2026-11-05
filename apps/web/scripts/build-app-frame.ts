// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Builds the isolated-app frame runtime (src/app-frame/runtime.ts) into ONE
// classic script, dist/app-frame-runtime.js, which the desktop shell inlines
// under a nonce into the frame document (apps/desktop/src-tauri/src/app_frame.rs,
// read from the embedded web build), and which the server inlines into the same
// document for a browser tab (apps/api modules/apps/app-frame.ts, read from the
// bundled web build).
// One file because the frame's origin is opaque: it loads nothing by URL from
// anywhere, so the runtime carries its own Solid.
//
// `--native` writes into the mobile build (dist-native) instead, and adds the
// frame document itself, app-frame.html: the phone serves its page from local
// files, so the document is a file too, the runtime inlined under a nonce fixed
// at build time and the frame policy as a meta element (`appFrameDocument`,
// @liaison/shared).
import { randomBytes } from "node:crypto"
import { mkdirSync } from "node:fs"
import path from "node:path"
import { appFrameDocument } from "@liaison/shared"

export const APP_FRAME_RUNTIME_FILE = "app-frame-runtime.js"
/** The mobile frame document (web isolated-app.tsx `MOBILE_APP_FRAME_PATH`). */
export const APP_FRAME_DOCUMENT_FILE = "app-frame.html"

/** The frame runtime as one classic script's text (it carries its own Solid). */
export async function bundleAppFrameRuntime(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [path.join(import.meta.dir, "../src/app-frame/runtime.ts")],
    target: "browser",
    format: "iife",
    minify: true,
    conditions: ["browser"],
  })
  if (!result.success) {
    throw new Error(`app frame runtime build failed:\n${result.logs.join("\n")}`)
  }
  return result.outputs[0].text()
}

export async function buildAppFrameRuntime(
  outDir: string,
  options: { document?: boolean } = {},
): Promise<string> {
  const text = await bundleAppFrameRuntime()
  mkdirSync(outDir, { recursive: true })
  const file = path.join(outDir, APP_FRAME_RUNTIME_FILE)
  await Bun.write(file, text)
  if (options.document) {
    const document = path.join(outDir, APP_FRAME_DOCUMENT_FILE)
    await Bun.write(document, appFrameDocument(text, randomBytes(18).toString("hex")))
    return document
  }
  return file
}

if (import.meta.main) {
  const native = process.argv.includes("--native")
  const file = await buildAppFrameRuntime(
    path.join(import.meta.dir, native ? "../dist-native" : "../dist"),
    { document: native },
  )
  console.log(`built ${file}`)
}
