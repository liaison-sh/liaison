#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Computes the release manifest from the current tree + tag and writes it to
// .liaison-release.json at the repo root. The Dockerfile COPYs this file into
// the runtime image at /app/.liaison-release.json so the image carries its
// release version and expected migration head.

import { createHash } from "node:crypto"
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const ROOT = resolve(new URL("..", import.meta.url).pathname)
const MIGRATIONS_DIR = resolve(ROOT, "apps/api/src/db/migrations")
const OUT_PATH = resolve(ROOT, ".liaison-release.json")

// Mirrors apps/api/src/modules/healthz/index.ts:computeMigrationHead(). Full
// 64-char hex SHA-256 over each migration's (filename + NUL + content), sorted
// by filename. The release manifest captures the *expected* head once all the
// migrations shipped in this image have been applied; /healthz returns the
// matching value once that condition holds in the running DB.
function migrationHead(): string {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort()
  const h = createHash("sha256")
  for (const f of files) {
    h.update(f)
    h.update("\0")
    h.update(readFileSync(join(MIGRATIONS_DIR, f)))
  }
  return h.digest("hex")
}

function gitSha(): string {
  const p = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT, stdout: "pipe" })
  return p.success ? p.stdout.toString().trim() : "unknown"
}

const tag = process.env.GIT_TAG ?? process.argv[2] ?? "dev"
const manifest = {
  version: tag,
  gitSha: gitSha(),
  builtAt: new Date().toISOString(),
  migrationHead: migrationHead(),
  schemaBaseline: "v0.1.0",
}

writeFileSync(OUT_PATH, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`wrote ${OUT_PATH}: ${JSON.stringify(manifest)}`)
