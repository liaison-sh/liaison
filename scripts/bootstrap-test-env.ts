#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2

import { bootstrap, ensureBundledAppsFresh } from "./bootstrap-env"

const dbName = process.env.E2E_DB_NAME ?? "liaison_test"

if (process.env.SKIP_BOOTSTRAP_TEST_ENV === "1") {
  console.log("[bootstrap:test-env] skip: SKIP_BOOTSTRAP_TEST_ENV=1")
  process.exit(0)
}

// Services and roles only: scripts/test-run.ts gives each run its own database
// cloned from a migrated template, so nothing here touches the shared
// liaison_test. LIAISON_BOOTSTRAP_TEST_DB=1 restores the old migrate-in-place
// for a tool that still reads liaison_test directly.
bootstrap({ dbName, servicesOnly: process.env.LIAISON_BOOTSTRAP_TEST_DB !== "1" })
  // Rebuild any bundled-app tarball whose source is newer than the artifact, so
  // e2e/integration installs never run stale bundled-app code (edit a handler,
  // forget to rebuild → tests silently exercise the old tarball).
  .then(() => ensureBundledAppsFresh())
  .catch((err) => {
    console.error(
      `[bootstrap:test-env] failed: ${err instanceof Error ? err.message : String(err)}`,
    )
    process.exit(1)
  })
