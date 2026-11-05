#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Produces the file an installed app downloads when it updates, and signs it
// with the project's updater key. It runs AFTER the operating system signature
// is on the artifact, and that order is the whole point.
//
// Tauri's own `createUpdaterArtifacts` writes the archive during the build,
// before anything is codesigned. On macOS the pipeline signs and notarizes the
// .app after the build, so the archive tauri wrote holds the UNSIGNED app: the
// manifest would then ship an updater payload that Gatekeeper refuses on the
// machine it lands on, while the DMG a human downloads is perfectly fine and
// every check in CI is green. That is the desync shape Buzz shipped.
//
// So the archive is rebuilt here from the final artifact, signed here, and the
// bytes are recorded in a sibling `.sha256` so the publish gate can prove the
// signature covers the file that was actually uploaded.
//
// Usage:
//   bun apps/desktop/ci/sign-updater-artifact.ts <artifact> [--out-dir <dir>]
//
// The private key arrives as TAURI_SIGNING_PRIVATE_KEY (the key itself, or a
// path to it), or as TAURI_SIGNING_PRIVATE_KEY_PATH, plus
// TAURI_SIGNING_PRIVATE_KEY_PASSWORD. Neither is ever printed, and neither
// reaches the signer's COMMAND LINE: a process's arguments are readable by
// every other process on the machine, and on a self hosted runner that is a
// second job reading the project's signing key. The updater key is the one
// credential here that cannot be rotated, since every installed copy verifies
// against the public half compiled into the build it is already running. So
// both halves travel in the child's environment.

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"

/** A macOS .app is a directory: the updater downloads a tarball of it, the way
 *  tauri's own updater expects. Everything else ships as the single file it
 *  already is. */
export function updaterArchiveName(artifact: string): string {
  return artifact.endsWith(".app") ? `${artifact}.tar.gz` : artifact
}

export function makeUpdaterArchive(artifact: string): string {
  const archive = updaterArchiveName(artifact)
  if (archive === artifact) return artifact
  // COPYFILE_DISABLE: macOS tar otherwise writes each file's extended
  // attributes as an AppleDouble `._<name>` entry, and the updater, which
  // unpacks every entry, failed on the first one ("failed to unpack
  // `._Liaison_0.1.12_universal.app`"). The signature lives inside the bundle
  // (_CodeSignature, the stapled ticket), so nothing the app needs is lost.
  // Other platforms' tar ignores the variable.
  const result = spawnSync(
    "tar",
    ["-czf", archive, "-C", path.dirname(artifact), path.basename(artifact)],
    { encoding: "utf8", env: { ...process.env, COPYFILE_DISABLE: "1" } },
  )
  if (result.status !== 0) {
    throw new Error(`could not archive ${artifact}: ${result.stderr}`)
  }
  return archive
}

export function recordChecksum(file: string): string {
  const digest = createHash("sha256").update(readFileSync(file)).digest("hex")
  writeFileSync(`${file}.sha256`, `${digest}  ${path.basename(file)}\n`)
  return digest
}

export interface SignerInvocation {
  args: string[]
  env: Record<string, string | undefined>
  /** Where the signer runs, which is the desktop package, because that is
   *  where its CLI is installed. */
  cwd: string
}

/** What to run and what to run it WITH. Split out so a test can read the
 *  command line back and see no secret in it. */
export interface SignerSecrets {
  TAURI_SIGNING_PRIVATE_KEY?: string
  TAURI_SIGNING_PRIVATE_KEY_PATH?: string
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD?: string
  /** Injected so the decision "is this a path or the key itself" can be driven
   *  without a key on disk. */
  exists?: (file: string) => boolean
}

export function signerInvocation(
  archive: string,
  source: SignerSecrets = process.env as SignerSecrets,
): SignerInvocation {
  const exists = source.exists ?? existsSync
  const key = source.TAURI_SIGNING_PRIVATE_KEY_PATH ?? source.TAURI_SIGNING_PRIVATE_KEY
  if (!key) {
    throw new Error(
      "TAURI_SIGNING_PRIVATE_KEY is unset: no updater signature can be produced, and the publish gate will refuse this release",
    )
  }
  // A path or the key itself, so the same script works from this Mac's secrets
  // directory and from a GitHub secret. The variable names below are the ones
  // the signer subcommand itself declares.
  const asPath = Boolean(source.TAURI_SIGNING_PRIVATE_KEY_PATH) || exists(key)
  const env: Record<string, string | undefined> = {
    TAURI_PRIVATE_KEY: asPath ? undefined : key,
    TAURI_PRIVATE_KEY_PATH: asPath ? key : undefined,
    // Always set, even empty: left unset the signer asks for it on a terminal
    // that is not there and the job hangs until its timeout.
    TAURI_PRIVATE_KEY_PASSWORD: source.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "",
  }
  // ABSOLUTE, always. The signer runs from the desktop package, because that
  // is where its CLI is installed, while every caller names the artifact from
  // the repository root: handed on as it arrived, a relative path is resolved
  // against the child's directory and the signer opens nothing ("failed to
  // open data file ...: No such file or directory"). Resolving here is what
  // keeps the two directories from having to agree.
  return { args: ["tauri", "signer", "sign", path.resolve(archive)], env, cwd: signerCwd() }
}

function signerCwd(): string {
  return path.resolve(import.meta.dir, "..")
}

/** Everything the signer said, with anything secret taken back out. The child
 *  echoes the signature, which is public, and its refusals, which are the whole
 *  point of reading it; the key and its password are never on the command line
 *  and never printed, but a redaction here costs nothing and a leak into a
 *  public build log cannot be taken back. */
export function redactSecrets(
  text: string,
  source: SignerSecrets = process.env as SignerSecrets,
): string {
  let redacted = text
  for (const secret of [
    source.TAURI_SIGNING_PRIVATE_KEY,
    source.TAURI_SIGNING_PRIVATE_KEY_PATH,
    source.TAURI_SIGNING_PRIVATE_KEY_PASSWORD,
  ]) {
    if (!secret) continue
    for (const line of secret.split(/\r?\n/)) {
      if (line.length < 8) continue
      redacted = redacted.split(line).join("[redacted]")
    }
  }
  return redacted
}

export interface SignerResult {
  status: number | null
  stdout?: string | null
  stderr?: string | null
  error?: Error
}

/** Why the signer refused, in the message the job's log gets. Without the
 *  child's own stderr the log says only that the exit code was not zero, and
 *  the reason (a path the signer could not open, a password it would not take)
 *  is thrown away at the one moment it is worth having. */
export function signerFailureMessage(
  archive: string,
  result: SignerResult,
  source: SignerSecrets = process.env as SignerSecrets,
): string {
  const said = [result.stderr, result.stdout]
    .map((stream) => (stream ?? "").trim())
    .filter(Boolean)
    .join("\n")
  const reason = result.error ? `${result.error.message}` : ""
  const detail = redactSecrets([reason, said].filter(Boolean).join("\n"), source).trim()
  const head = `tauri signer refused ${archive} (exit ${result.status})`
  return detail ? `${head}: ${detail}` : `${head}, and it said nothing`
}

export function signUpdaterArchive(archive: string): void {
  const invocation = signerInvocation(archive)
  const result = spawnSync("bunx", invocation.args, {
    encoding: "utf8",
    cwd: invocation.cwd,
    env: { ...process.env, ...invocation.env },
    // Captured rather than inherited, so a refusal can be reported with what
    // the signer actually said and a redaction pass stands between that and
    // the build log.
    stdio: ["ignore", "pipe", "pipe"],
    // A signer waiting on a password prompt would otherwise hold a release job
    // open until the job's own timeout.
    timeout: 300_000,
  })
  if (result.status !== 0) {
    throw new Error(signerFailureMessage(archive, result))
  }
  if (!existsSync(`${archive}.sig`)) {
    throw new Error(`tauri signer wrote no signature beside ${archive}`)
  }
}

if (import.meta.main) {
  const [artifact] = process.argv.slice(2)
  if (!artifact) {
    console.error("usage: sign-updater-artifact.ts <artifact>")
    process.exit(2)
  }
  if (!existsSync(artifact)) {
    console.error(`no such artifact: ${artifact}`)
    process.exit(1)
  }
  try {
    const archive = makeUpdaterArchive(artifact)
    signUpdaterArchive(archive)
    const digest = recordChecksum(archive)
    const size = statSync(archive).size
    console.log(`updater archive ${archive} (${size} bytes)`)
    console.log(`sha256 ${digest}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
