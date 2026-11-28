// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The web build id: the LAST step of `bun run build` and `bun run build:native`
// (apps/web/package.json), after `vite build` and scripts/build-app-frame.ts.
//
// It hashes EVERY file of the finished build root (what Rollup emitted, what
// Vite copied from public/ such as the service worker and _app-runtime/, the
// app frame runtime and the phone's frame document) into one id, writes that id
// into the HTML pages' `__LIAISON_WEB_BUILD_ID__` placeholder (index.html's
// `liaison-web-build` meta tag), and writes it as `build-id.txt` beside
// index.html. The API server reads that file at startup and stamps it on its
// responses; the page compares the two (src/lib/web-build.ts). A signed shell
// statement is looked up by this id (scripts/shell-signing/build-manifest.ts
// recomputes it from the dist), so a change to any byte the server serves for
// the shell gives a new id.
//
// The pages are hashed with the placeholder still in them, so the id never
// depends on itself: put the placeholder back in every page and the files hash
// to the id again.
//
// Never into a JS file: chunk names are content hashes fixed before this step,
// so a chunk that did not change keeps its name while an id inside it would
// change, and the browser's immutable cached copy would then report the old id
// forever. index.html is revalidated on every load (see src/lib/web-build.ts).
// So it fails when a file other than an HTML page carries the placeholder, and
// when index.html does not (such a build could never notice a deploy).
//
// A CONTENT hash, not a timestamp: two builds of the same source get the same
// id, so a redeploy of an unchanged web app never asks anybody to reload.
//
// Usage: bun scripts/stamp-build-id.ts [--native]   (dist, or dist-native)
import { createHash } from "node:crypto"
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

/** The literal index.html carries. Spelled out once per file on purpose. */
export const WEB_BUILD_ID_TOKEN = "__LIAISON_WEB_BUILD_ID__"
export const WEB_BUILD_ID_FILE = "build-id.txt"

/** Every regular file under `root`, relative, `/`-separated, in code-unit order. */
export function listBuildFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir)) {
      const abs = path.join(dir, name)
      const rel = prefix ? `${prefix}/${name}` : name
      const st = lstatSync(abs)
      if (st.isSymbolicLink()) throw new Error(`${rel}: a symbolic link in the build`)
      if (st.isDirectory()) walk(abs, rel)
      else if (st.isFile()) out.push(rel)
      else throw new Error(`${rel}: not a regular file`)
    }
  }
  walk(root, "")
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/**
 * The id of a build: SHA-256 over every file but build-id.txt, as
 * `path \0 bytes \0` in code-unit path order, HTML pages holding the
 * placeholder. 16 hex.
 */
export function computeWebBuildId(files: ReadonlyMap<string, Uint8Array | string>): string {
  const hash = createHash("sha256")
  const paths = [...files.keys()]
    .filter((p) => p !== WEB_BUILD_ID_FILE)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  for (const p of paths) {
    hash.update(p)
    hash.update("\0")
    hash.update(files.get(p) as Uint8Array | string)
    hash.update("\0")
  }
  return hash.digest("hex").slice(0, 16)
}

const isPage = (p: string) => p.endsWith(".html")
const TOKEN_BYTES = new TextEncoder().encode(WEB_BUILD_ID_TOKEN)

function carries(bytes: Uint8Array, needle: Uint8Array): boolean {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(needle)
}

/** Every file of the build root, read. */
export function readBuildFiles(root: string): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>()
  for (const p of listBuildFiles(root)) {
    files.set(p, new Uint8Array(readFileSync(path.join(root, p))))
  }
  return files
}

/**
 * Pure over the files so the rule is testable without a build: the id, and the
 * pages with the id written into their placeholder.
 */
export function bakeWebBuildId(files: ReadonlyMap<string, Uint8Array>): {
  id: string
  pages: Map<string, string>
} {
  if (files.has(WEB_BUILD_ID_FILE)) {
    throw new Error(`web build id: the build already has a ${WEB_BUILD_ID_FILE}`)
  }
  for (const [p, bytes] of files) {
    if (!isPage(p) && carries(bytes, TOKEN_BYTES)) {
      throw new Error(
        `web build id: ${p} carries the build id placeholder; only HTML pages may (a cached copy under an unchanged name would report a stale build)`,
      )
    }
  }
  const index = files.get("index.html")
  if (!index || !carries(index, TOKEN_BYTES)) {
    throw new Error(
      "web build id: index.html carried no build id placeholder, so this build could never notice a newer deploy",
    )
  }
  const id = computeWebBuildId(files)
  const decoder = new TextDecoder()
  const pages = new Map<string, string>()
  for (const [p, bytes] of files) {
    if (!isPage(p) || !carries(bytes, TOKEN_BYTES)) continue
    pages.set(p, decoder.decode(bytes).split(WEB_BUILD_ID_TOKEN).join(id))
  }
  return { id, pages }
}

/** Stamps the build at `dir`: rewrites the pages and writes build-id.txt. Returns the id. */
export function stampWebBuildId(dir: string): string {
  const { id, pages } = bakeWebBuildId(readBuildFiles(dir))
  for (const [p, text] of pages) writeFileSync(path.join(dir, p), text)
  writeFileSync(path.join(dir, WEB_BUILD_ID_FILE), `${id}\n`)
  return id
}

if (import.meta.main) {
  const dir = path.join(
    import.meta.dir,
    process.argv.includes("--native") ? "../dist-native" : "../dist",
  )
  if (!existsSync(dir)) throw new Error(`${dir}: no build to stamp`)
  console.log(`web build id ${stampWebBuildId(dir)} (${dir})`)
}
