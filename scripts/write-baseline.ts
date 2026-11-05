#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `bun run scripts/write-baseline.ts`
//
// Invoked by the release workflow when cutting the v0.1.0 tag. Computes the
// sha256 of each protected migration file and writes the baseline manifest at
// apps/api/src/db/migrations/.baseline. Subsequent CI runs validate against
// this file (see scripts/check-migration-baseline.ts).

import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const REPO_ROOT = resolve(new URL("..", import.meta.url).pathname)
const MIGRATIONS_DIR = resolve(REPO_ROOT, "apps/api/src/db/migrations")
const BASELINE_PATH = resolve(MIGRATIONS_DIR, ".baseline")
const PROTECTED_FILES = ["0000_initial.sql"]

const baseline = {
  tag: process.env.GIT_TAG ?? "v0.1.0",
  frozenAt: process.env.BASELINE_FROZEN_AT ?? new Date().toISOString(),
  protected: PROTECTED_FILES.map((f) => ({
    path: `apps/api/src/db/migrations/${f}`,
    sha256: createHash("sha256")
      .update(readFileSync(resolve(MIGRATIONS_DIR, f)))
      .digest("hex"),
  })),
}

writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`)
console.log(`wrote ${BASELINE_PATH} for tag ${baseline.tag}`)
