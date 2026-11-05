// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The BUILD half of lib/web-build.ts. Nothing in the browser imports this
// file: `vite.config.ts` does, and it runs in Node during `vite build`.
//
// After bundling, it hashes everything the build emitted into one id, writes
// that id into index.html's `liaison-web-build` meta tag placeholder, and
// emits it as `build-id.txt` beside index.html. The API server reads that file
// at startup and stamps it on its responses; the page compares the two.
//
// Never into a JS chunk: chunk file names are content hashes fixed before this
// hook runs, so a chunk that did not change keeps its name while the id inside
// it changes, and the browser's immutable cached copy then reports the old id
// forever. index.html is revalidated on every load (see lib/web-build.ts).
//
// A CONTENT hash, not a timestamp: two builds of the same source get the same
// id, so a redeploy of an unchanged web app never asks anybody to reload.
//
// It fails the build when index.html carries no placeholder (such a build could
// never notice a deploy, and would say nothing about it), and when a JS chunk
// does (that chunk would go stale under its unchanged name).

import { createHash } from "node:crypto"

/** The literal lib/web-build.ts carries. Spelled out once per file on purpose. */
export const WEB_BUILD_ID_TOKEN = "__LIAISON_WEB_BUILD_ID__"
export const WEB_BUILD_ID_FILE = "build-id.txt"

interface OutputEntry {
  type: "chunk" | "asset"
  fileName: string
  code?: string
  source?: string | Uint8Array
}

/** The id of a bundle: SHA-256 over every emitted file, in file-name order. */
export function computeWebBuildId(bundle: Record<string, OutputEntry>): string {
  const hash = createHash("sha256")
  const entries = Object.values(bundle).sort((a, b) => a.fileName.localeCompare(b.fileName))
  for (const entry of entries) {
    hash.update(entry.fileName)
    hash.update("\0")
    hash.update(entry.type === "chunk" ? (entry.code ?? "") : (entry.source ?? ""))
    hash.update("\0")
  }
  return hash.digest("hex").slice(0, 16)
}

function sourceText(source: string | Uint8Array | undefined): string {
  if (source === undefined) return ""
  return typeof source === "string" ? source : new TextDecoder().decode(source)
}

/**
 * Pure over the bundle so the behaviour is testable without a build. Mutates
 * the HTML pages' source in place and returns the id plus the patched file names.
 */
export function bakeWebBuildId(bundle: Record<string, OutputEntry>): {
  id: string
  patched: string[]
} {
  for (const entry of Object.values(bundle)) {
    if (entry.type === "chunk" && entry.code?.includes(WEB_BUILD_ID_TOKEN)) {
      throw new Error(
        `web build id: chunk ${entry.fileName} carries the build id placeholder; its hashed name would not change with the id, so a cached copy would report a stale build`,
      )
    }
  }
  const id = computeWebBuildId(bundle)
  const patched: string[] = []
  for (const entry of Object.values(bundle)) {
    if (entry.type !== "asset" || !entry.fileName.endsWith(".html")) continue
    const html = sourceText(entry.source)
    if (!html.includes(WEB_BUILD_ID_TOKEN)) continue
    entry.source = html.split(WEB_BUILD_ID_TOKEN).join(id)
    patched.push(entry.fileName)
  }
  if (!patched.includes("index.html")) {
    throw new Error(
      "web build id: index.html carried no build id placeholder, so this build could never notice a newer deploy",
    )
  }
  return { id, patched }
}

interface EmitContext {
  emitFile(file: { type: "asset"; fileName: string; source: string }): string
}

interface VitePluginLike {
  name: string
  enforce: "post"
  apply: "build"
  generateBundle(this: EmitContext, options: unknown, bundle: Record<string, OutputEntry>): void
}

export function webBuildId(): VitePluginLike {
  return {
    name: "liaison-web-build-id",
    // After Vite's own HTML plugin, so index.html is already in the bundle.
    enforce: "post",
    apply: "build",
    generateBundle(_options, bundle) {
      const { id } = bakeWebBuildId(bundle)
      this.emitFile({ type: "asset", fileName: WEB_BUILD_ID_FILE, source: `${id}\n` })
    },
  }
}
