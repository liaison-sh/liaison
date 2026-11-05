#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Vendors atelier-cc (MIT) into the desktop sidecar at a pinned tag (S38, A33).
//
//   bun scripts/vendor-atelier.ts <tag> <atelier-cc checkout>
//
// Copies exactly the plugin's runtime files (VENDORED_ATELIER_PATHS) as they
// are in git at the tag's commit, never the working tree, into
// apps/desktop/sidecar/vendor/atelier/, and writes VERSION ("<tag> <sha>")
// and MANIFEST.json (path -> sha256). A dirty checkout or a tag that does not
// resolve is refused. The files keep upstream bytes (D39): the sidecar embeds
// them and checks every one against MANIFEST.json before extracting it.

import { createHash } from "node:crypto"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

/** The plugin's runtime files: a file, or a directory taken whole. */
export const VENDORED_ATELIER_PATHS = [
  "LICENSE",
  ".claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
  "commands/",
  "hooks/",
  "lib/",
  "skills/",
  "scripts/",
  // The guideline the command file reads first (`$P/docs/precepts.md`).
  "docs/precepts.md",
] as const

export const ATELIER_VENDOR_DIR = path.resolve(
  import.meta.dir,
  "..",
  "apps",
  "desktop",
  "sidecar",
  "vendor",
  "atelier",
)

function git(checkout: string, args: string[]): Buffer {
  const r = Bun.spawnSync(["git", "-C", checkout, ...args], { stdout: "pipe", stderr: "pipe" })
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString().trim()}`)
  }
  return r.stdout
}

export function isVendoredAtelierPath(rel: string): boolean {
  return VENDORED_ATELIER_PATHS.some((p) => (p.endsWith("/") ? rel.startsWith(p) : rel === p))
}

export function vendorAtelier(args: { tag: string; checkout: string; dest?: string }): {
  sha: string
  files: Record<string, string>
} {
  const dest = args.dest ?? ATELIER_VENDOR_DIR
  if (git(args.checkout, ["status", "--porcelain"]).toString().trim() !== "") {
    throw new Error(`${args.checkout} has uncommitted changes: vendor from a clean checkout`)
  }
  let sha: string
  try {
    sha = git(args.checkout, ["rev-parse", "--verify", `${args.tag}^{commit}`])
      .toString()
      .trim()
  } catch {
    throw new Error(`tag ${args.tag} does not resolve in ${args.checkout}`)
  }
  const entries = git(args.checkout, ["ls-tree", "-r", "-z", sha])
    .toString()
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const [meta, rel] = line.split("\t") as [string, string]
      const [mode, type, object] = meta.split(" ") as [string, string, string]
      return { mode, type, object, rel }
    })
    .filter((e) => e.type === "blob" && isVendoredAtelierPath(e.rel))
    .sort((a, b) => (a.rel < b.rel ? -1 : 1))
  for (const p of VENDORED_ATELIER_PATHS) {
    if (!entries.some((e) => isVendoredAtelierPath(e.rel) && e.rel.startsWith(p))) {
      throw new Error(`${p} is missing at ${args.tag}`)
    }
  }
  rmSync(dest, { recursive: true, force: true })
  const files: Record<string, string> = {}
  for (const e of entries) {
    const bytes = git(args.checkout, ["cat-file", "blob", e.object])
    const out = path.join(dest, e.rel)
    mkdirSync(path.dirname(out), { recursive: true })
    writeFileSync(out, bytes, { mode: e.mode === "100755" ? 0o755 : 0o644 })
    files[e.rel] = createHash("sha256").update(bytes).digest("hex")
  }
  writeFileSync(path.join(dest, "VERSION"), `${args.tag} ${sha}\n`)
  writeFileSync(path.join(dest, "MANIFEST.json"), `${JSON.stringify(files, null, 2)}\n`)
  return { sha, files }
}

if (import.meta.main) {
  const [tag, checkout] = process.argv.slice(2)
  if (!tag || !checkout) {
    process.stderr.write("usage: bun scripts/vendor-atelier.ts <tag> <atelier-cc checkout>\n")
    process.exit(2)
  }
  const { sha, files } = vendorAtelier({ tag, checkout: path.resolve(checkout) })
  process.stdout.write(`vendored atelier-cc ${tag} ${sha}: ${Object.keys(files).length} files\n`)
}
