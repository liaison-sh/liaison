#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Publishing a previous release's manifest again, to undo a bad release.
//
// The two signature gate stops a manifest that is unsigned, half signed, or
// signed over different bytes. What it cannot stop is a build that signs and
// notarizes perfectly and is broken: it crashes at launch, or its sidecar
// cannot start, and by the time anybody knows, every installed copy has
// already updated itself.
//
// Tauri's updater compares the manifest's version against the running one and
// installs what the manifest names, with no notion of "newer". So the way back
// is to publish the PREVIOUS release's manifest again, byte for byte: the next
// check on every machine offers the older build and rolls forward into it.
//
// Byte for byte matters. If this script could re-sign, the rollback path would
// be a second way to mint a manifest, outside the gate. It fetches, verifies,
// and re-uploads the same bytes, or it refuses.
//
// It republishes to BOTH surfaces, and the one that decides anything is the
// second. The GitHub release is the private record; downloads.liaison.sh is
// what every installed copy actually reads, because the repository is private
// and its assets answer 404 to an anonymous client. A rollback that updated
// only the release asset would log a success and change nothing on a single
// customer machine, which is the same outage with a green line under it.
//
// Usage:
//   bun apps/desktop/ci/rollback-manifest.ts --tag <prior tag> --reason "<why>" [--dry-run]

import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  contentTypeFor,
  isTestVersion,
  MANIFEST_KEY,
  manifestPayloadNames,
  ROLLING_CACHE_CONTROL,
} from "./downloads"
import { verifyMinisign } from "./minisign"
import {
  credentialsFromEnv,
  type DownloadsCredentials,
  type MirrorStep,
  realMirrorIo,
  redact,
  runMirror,
} from "./mirror-to-downloads"
import { configuredPublicKey, type Manifest } from "./verify-and-publish"

export interface RollbackIo {
  run(command: string[]): { code: number; stdout: string; stderr: string }
  /** One asset's text from a release, or undefined when it is not there. */
  fetchAsset(tag: string, name: string): string | undefined
  /** The bytes a manifest's platform url points at. */
  fetchUrl(url: string): Buffer
  upload(tag: string, file: string, contents: string): void
  /** The same manifest, onto the public downloads host, which is the copy an
   *  installed machine reads. Without this the rollback moves nothing. */
  publishManifestToDownloads(contents: string): Promise<void>
  now(): Date
  log(message: string): void
}

export interface RollbackRequest {
  /** The release whose manifest is being restored. */
  tag: string
  /** Why. Required, and published beside the manifest. */
  reason: string
}

export type RollbackResult =
  | { rolledBack: false; reason: string; detail?: string }
  | { rolledBack: true; manifest: string; onto: string; record: string }

export const ROLLBACK_RECORD = "ROLLBACK.txt"

export function realRollbackIo(): RollbackIo {
  const scratch = mkdtempSync(path.join(tmpdir(), "liaison-rollback-"))
  const run = (command: string[]) => {
    const [program, ...args] = command
    const result = spawnSync(program as string, args, { encoding: "utf8" })
    return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
  }
  return {
    run,
    fetchAsset(tag, name) {
      const result = run([
        "gh",
        "release",
        "download",
        tag,
        "--pattern",
        name,
        "--dir",
        scratch,
        "--clobber",
      ])
      if (result.code !== 0) return undefined
      try {
        return readFileSync(path.join(scratch, name), "utf8")
      } catch {
        return undefined
      }
    },
    fetchUrl(url) {
      const target = path.join(scratch, path.basename(new URL(url).pathname))
      const result = run(["curl", "--fail", "--location", "--silent", "--output", target, url])
      if (result.code !== 0) throw new Error(`could not download ${url}`)
      return readFileSync(target)
    },
    upload(tag, file, contents) {
      const staged = path.join(scratch, file)
      writeFileSync(staged, contents)
      const result = run(["gh", "release", "upload", tag, staged, "--clobber"])
      if (result.code !== 0) throw new Error(`could not upload ${file} to ${tag}: ${result.stderr}`)
    },
    async publishManifestToDownloads(contents) {
      // One object, through the same transport the release mirror uses, so
      // there is one way in this repository to put a manifest in front of a
      // customer and it carries the same headers, the same read back and the
      // same retries.
      const staged = path.join(scratch, "rollback-latest.json")
      writeFileSync(staged, contents)
      const step: MirrorStep = {
        stage: "manifest",
        key: MANIFEST_KEY,
        source: staged,
        size: Buffer.byteLength(contents),
        contentType: contentTypeFor("latest.json"),
        cacheControl: ROLLING_CACHE_CONTROL,
      }
      const credentials: DownloadsCredentials = credentialsFromEnv()
      try {
        await runMirror({ steps: [step], credentials, io: realMirrorIo(credentials) })
      } catch (error) {
        // runMirror redacts what it throws; this catch covers anything that
        // escapes around it, so no path out of here can print a key.
        throw new Error(
          redact(error instanceof Error ? error.message : String(error), [
            credentials.secretAccessKey,
            credentials.accessKeyId,
            credentials.accountId,
          ]),
        )
      }
    },
    now: () => new Date(),
    log: (message) => console.log(message),
  }
}

/** The release GitHub currently serves as `releases/latest`, which is the one
 *  the updater endpoint resolves to and therefore the one the restored
 *  manifest has to land on.
 *
 *  `gh release view` with no tag asks GitHub that exact question. `gh release
 *  list --limit 1` answers a DIFFERENT one, the most recently created release,
 *  drafts and pre-releases included: a rollback uploaded onto a draft nobody
 *  serves changes nothing on a single customer machine, while the log says the
 *  rollback succeeded and the outage runs on. */
function currentLatestTag(io: RollbackIo): string | undefined {
  const viewed = io.run(["gh", "release", "view", "--json", "tagName"])
  if (viewed.code !== 0) return undefined
  try {
    return (JSON.parse(viewed.stdout) as { tagName?: string }).tagName
  } catch {
    return undefined
  }
}

export async function rollbackManifest(
  request: RollbackRequest,
  options: { io?: RollbackIo; publicKey?: string; dryRun?: boolean } = {},
): Promise<RollbackResult> {
  const io = options.io ?? realRollbackIo()
  const publicKey = options.publicKey ?? configuredPublicKey()
  const dryRun = options.dryRun ?? false

  const reason = request.reason.trim()
  if (reason.length === 0) {
    // A rollback nobody wrote down is an outage whose cause is lost.
    return { rolledBack: false, reason: "no reason given" }
  }

  const viewed = io.run(["gh", "release", "view", request.tag, "--json", "tagName"])
  if (viewed.code !== 0) {
    return { rolledBack: false, reason: "tag not found", detail: viewed.stderr.trim() }
  }

  const manifestText = io.fetchAsset(request.tag, "latest.json")
  if (!manifestText) {
    return { rolledBack: false, reason: "no latest.json on that release" }
  }

  let manifest: Manifest
  try {
    manifest = JSON.parse(manifestText) as Manifest
  } catch (error) {
    return {
      rolledBack: false,
      reason: "the prior manifest is not readable",
      detail: error instanceof Error ? error.message : String(error),
    }
  }

  // A test build's manifest (channel.ts) on a release, republished as the
  // production channel, would install a test build on every machine.
  if (isTestVersion(manifest.version ?? "")) {
    return {
      rolledBack: false,
      reason: "that manifest is a test build, never a release",
      detail: `version ${manifest.version}`,
    }
  }

  const entries = Object.entries(manifest.platforms ?? {})
  if (entries.length === 0) {
    return { rolledBack: false, reason: "the prior manifest names no platform" }
  }

  // A prior manifest that still points at the private repository is one no
  // installed copy can download from. Republishing it would replace a broken
  // release with a channel that answers 404 on every platform, which reads in
  // the log as a successful rollback.
  try {
    manifestPayloadNames(manifest)
  } catch (error) {
    return {
      rolledBack: false,
      reason: "the prior manifest does not point at the downloads host",
      detail: error instanceof Error ? error.message : String(error),
    }
  }

  // Every payload it names, verified against the key this build trusts, before
  // a single byte is republished. Rolling back into a corrupt build is a
  // second outage, not a recovery.
  for (const [key, entry] of entries) {
    let payload: Buffer
    try {
      payload = io.fetchUrl(entry.url)
    } catch (error) {
      return {
        rolledBack: false,
        reason: "the prior manifest's payload does not verify",
        detail: `${key}: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    const outcome = verifyMinisign(payload, entry.signature, publicKey)
    if (!outcome.ok) {
      return {
        rolledBack: false,
        reason: "the prior manifest's payload does not verify",
        detail: `${key}: ${outcome.reason}`,
      }
    }
  }

  const onto = currentLatestTag(io)
  if (!onto) {
    return { rolledBack: false, reason: "no current release to publish onto" }
  }

  const record = [
    `rolled back to ${request.tag}`,
    `at ${io.now().toISOString()}`,
    `onto ${onto}`,
    `version now offered: ${manifest.version}`,
    "",
    reason,
    "",
  ].join("\n")

  if (!dryRun) {
    // The manifest goes up UNCHANGED. The record is a sibling asset, so the
    // reason is published without a single byte of the signed release moving.
    io.upload(onto, "latest.json", manifestText)
    io.upload(onto, ROLLBACK_RECORD, record)
    // And then the copy that decides anything. A throw here fails the
    // rollback loudly rather than leaving the record saying it worked.
    await io.publishManifestToDownloads(manifestText)
  }
  io.log(record)
  return { rolledBack: true, manifest: manifestText, onto, record }
}

function argument(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const tag = argument(argv, "--tag")
  const reason = argument(argv, "--reason") ?? ""
  if (!tag) {
    console.error('usage: rollback-manifest.ts --tag <prior tag> --reason "<why>" [--dry-run]')
    process.exit(2)
  }
  const scratch = mkdtempSync(path.join(tmpdir(), "liaison-rollback-cli-"))
  try {
    const result = await rollbackManifest({ tag, reason }, { dryRun: argv.includes("--dry-run") })
    if (!result.rolledBack) {
      console.error(`refusing to roll back: ${result.reason}`)
      if (result.detail) console.error(result.detail)
      process.exit(1)
    }
    console.log(`rolled back onto ${result.onto}`)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
