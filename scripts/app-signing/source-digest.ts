// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Source digest of a bundled app: one sha256 over the app's source tree
// (`bundled-apps/<name>/`), the same on every machine that holds the same
// source. The signed statement of a first-party artifact carries it, and the
// Docker build (scripts/build-app-catalog.ts) uses a signed artifact only when
// its digest equals the one computed from the source being built, so a fork
// that changes an app builds that app itself.
//
// The tree is read from disk, not from git, because the Docker build context has
// no .git. Build output, installs and local clutter are left out (the same names
// .gitignore and .dockerignore leave out), so a clean checkout, a checkout after
// a build and a Docker build context all agree.
//
// Format: sha256 over, for each entry sorted by its `/`-separated relative path,
// `<path>\0F<sha256 hex of content>\n` for a file or `<path>\0L<link target>\n`
// for a symlink.
//
// Usage: bun run scripts/app-signing/source-digest.ts <app-name|app-dir>
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const EXCLUDED_NAMES = new Set([
  ".git",
  ".gitignore",
  ".dockerignore",
  "node_modules",
  "dist",
  "bun.lock",
  ".DS_Store",
  "coverage",
  ".turbo",
  ".cache",
  ".vite",
  "test-results",
  "logs",
  ".chaos",
])

function excluded(name: string): boolean {
  if (EXCLUDED_NAMES.has(name)) return true
  if (name.endsWith(".log")) return true
  // Env files never ship (both ignore files drop them), examples do.
  return name.startsWith(".env") && name !== ".env.example"
}

export function sourceDigest(appDir: string): string {
  const lines: string[] = []
  const walk = (dir: string, rel: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (excluded(e.name)) continue
      const path = join(dir, e.name)
      const relPath = rel ? `${rel}/${e.name}` : e.name
      if (e.isSymbolicLink()) {
        lines.push(`${relPath}\0L${readlinkSync(path)}\n`)
      } else if (e.isDirectory()) {
        walk(path, relPath)
      } else if (e.isFile()) {
        const hash = createHash("sha256").update(readFileSync(path)).digest("hex")
        lines.push(`${relPath}\0F${hash}\n`)
      }
    }
  }
  walk(appDir, "")
  // Code-unit order of the path, independent of locale and of readdir order.
  lines.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const digest = createHash("sha256")
  for (const line of lines) digest.update(line)
  return digest.digest("hex")
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

/** `bundled-apps/<name>` of this repo, or the path itself when it is a directory. */
export function resolveAppDir(nameOrDir: string, repoRoot = REPO_ROOT): string {
  if (/^[a-z][a-z0-9-]*$/.test(nameOrDir)) return join(repoRoot, "bundled-apps", nameOrDir)
  return nameOrDir
}

if (import.meta.main) {
  const arg = process.argv[2]
  if (!arg) {
    console.error("usage: bun run scripts/app-signing/source-digest.ts <app-name|app-dir>")
    process.exit(2)
  }
  const dir = resolveAppDir(arg)
  if (!existsSync(dir)) {
    console.error(`[source-digest] no such app directory: ${dir}`)
    process.exit(2)
  }
  console.log(sourceDigest(dir))
}
