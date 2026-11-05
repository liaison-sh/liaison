#!/usr/bin/env bun

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The TEST channel: a build signed exactly like a release (Authenticode, Apple
// notarization, the real updater key) that installed copies of the PRODUCTION
// app never see.
//
// WHY IT EXISTS (2026-09-28). The Windows update failure could only be proven
// fixed end to end with a signed build on a real machine, and the pipeline had
// two modes: a tag push, which publishes desktop/latest.json to every customer,
// and a dry run, which signs nothing and uses a throwaway updater key, so its
// installer is blocked by Smart App Control and its update is refused by every
// installed copy. A test build is the third mode: real signatures, its own
// update channel.
//
// HOW IT STAYS AWAY FROM PRODUCTION. Two things, both structural:
//
//   1. a test version is a semver PRERELEASE of one shape, 1.2.3-test.N, and
//      nothing else is a test version. The downloads layout routes a test
//      version under desktop/test/ by its version string alone
//      (downloads.ts: versionPrefix, manifestKeyFor), so there is no argument
//      anywhere that could put its files under desktop/<version>/ or its
//      manifest at desktop/latest.json;
//   2. the build points the app's updater at desktop/test/latest.json through
//      a config MERGE at build time (`tauri build --config`), never a source
//      edit, so the tree a tag builds from is the tree that was reviewed.
//
// The version order is semver's: 0.1.10-test.1 < 0.1.10-test.2 < 0.1.10, and
// every 0.1.10-test.N is newer than 0.1.9. A test build installed on a machine
// is offered the next test build and nothing else (its endpoint is the test
// manifest); moving that machine back to production is a reinstall.
//
// The workflow hands the choice over in two variables, empty on a tag push:
//   LIAISON_DESKTOP_CHANNEL        "" (production) or "test"
//   LIAISON_DESKTOP_TEST_VERSION   the test version, only with "test"
//
// Usage:
//   bun apps/desktop/ci/channel.ts check [--dry-run true|false]
//   bun apps/desktop/ci/channel.ts config     (prints the --config JSON, or nothing)
//   bun apps/desktop/ci/channel.ts production-only --artifacts <dir>

import { readdirSync, statSync } from "node:fs"
import path from "node:path"
import { isTestVersion, TEST_UPDATER_ENDPOINT, TEST_VERSION } from "./downloads"

export const CHANNEL_ENV = "LIAISON_DESKTOP_CHANNEL"
export const TEST_VERSION_ENV = "LIAISON_DESKTOP_TEST_VERSION"

export { isTestVersion, TEST_VERSION }

export type ChannelBuild = { channel: "production" } | { channel: "test"; version: string }

/** What the environment asks for. Anything that is not exactly production or
 *  a well formed test build is a refusal, never a guess: a typo in the channel
 *  name must not fall back to a production build. */
//
// EXACTLY as typed: no trimming, no case folding. The workflow compares the
// raw input, so a script that read " test" as "test" stamped a test build that
// the workflow then published as a RELEASE (re-review of 2026-09-28).
export function channelBuild(env: Record<string, string | undefined> = process.env): ChannelBuild {
  const channel = env[CHANNEL_ENV] ?? ""
  const version = env[TEST_VERSION_ENV] ?? ""
  if (channel === "") {
    if (version !== "") {
      throw new Error(
        `${TEST_VERSION_ENV} is ${version} but ${CHANNEL_ENV} is empty: a test version is only built on the test channel`,
      )
    }
    return { channel: "production" }
  }
  if (channel !== "test") {
    throw new Error(
      `${CHANNEL_ENV} is ${JSON.stringify(channel)}: the only channels are production (empty) and test, exactly`,
    )
  }
  if (!isTestVersion(version)) {
    throw new Error(
      `${TEST_VERSION_ENV} is "${version}": a test build needs a version like 0.1.10-test.1 (the next release's number, then -test.N)`,
    )
  }
  return { channel: "test", version }
}

/** The JSON merged over tauri.conf.json for a test build: its version and its
 *  update endpoint. Nothing else changes; the updater public key stays the
 *  production one, because the test build is signed with the real key. */
export function testConfigOverride(version: string): {
  version: string
  plugins: { updater: { endpoints: string[] } }
} {
  if (!isTestVersion(version)) throw new Error(`not a test version: ${version}`)
  return { version, plugins: { updater: { endpoints: [TEST_UPDATER_ENDPOINT] } } }
}

/** The extra arguments `tauri build` gets on this channel. */
export function tauriConfigArgs(build: ChannelBuild): string[] {
  if (build.channel === "production") return []
  return ["--config", JSON.stringify(testConfigOverride(build.version))]
}

/** A stamped test version inside an artifact name. */
const TEST_STAMPED = /_\d+\.\d+\.\d+-test\.\d+_/

/** The production publish's own refusal, run from the job before the gate:
 *  the channel variables must be EXACTLY empty, and nothing it downloaded may
 *  carry a test version. It reads the artifacts rather than the config,
 *  because the artifacts are what would be published. */
export function productionRefusal(
  env: Record<string, string | undefined>,
  artifactsDir: string,
): string | null {
  if ((env[CHANNEL_ENV] ?? "") !== "") {
    return `${CHANNEL_ENV} is ${JSON.stringify(env[CHANNEL_ENV])}: the production publish runs only with an empty channel`
  }
  if ((env[TEST_VERSION_ENV] ?? "") !== "") {
    return `${TEST_VERSION_ENV} is ${JSON.stringify(env[TEST_VERSION_ENV])}: a test version is never published as a release`
  }
  const stamped: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const entry = path.join(dir, name)
      if (statSync(entry).isDirectory()) walk(entry)
      else if (TEST_STAMPED.test(name)) stamped.push(name)
    }
  }
  walk(artifactsDir)
  if (stamped.length > 0) {
    return `test builds in the release artifacts: ${stamped.join(", ")}`
  }
  return null
}

/** Refuses a test build that would not be signed: its whole point is a build
 *  Smart App Control lets run and an installed copy accepts. */
export function checkChannel(build: ChannelBuild, dryRun: string | undefined): string | null {
  if (build.channel === "test" && dryRun === "true") {
    return "a test channel build signs exactly like a release: dispatch it with -f dry_run=false"
  }
  return null
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2)
  try {
    if (command === "production-only") {
      const at = rest.indexOf("--artifacts")
      const dir = at === -1 ? undefined : rest[at + 1]
      if (!dir) throw new Error("usage: channel.ts production-only --artifacts <dir>")
      const refusal = productionRefusal(process.env, dir)
      if (refusal) throw new Error(`refusing to publish a release: ${refusal}`)
      console.log("production build: publishing")
      process.exit(0)
    }
    const build = channelBuild()
    if (command === "check") {
      const at = rest.indexOf("--dry-run")
      const refusal = checkChannel(build, at === -1 ? undefined : rest[at + 1])
      if (refusal) throw new Error(refusal)
      console.log(
        build.channel === "test" ? `test channel, version ${build.version}` : "production",
      )
    } else if (command === "config") {
      const args = tauriConfigArgs(build)
      if (args.length > 0) console.log(args[1])
    } else {
      console.error("usage: channel.ts check [--dry-run true|false] | config")
      process.exit(2)
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
