// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `liaison app verify <file|dir>`: check an app package (`.liaisonapp`), a bare
 * `app.manifest.json`, or a signed artifact directory the way an install and a
 * shell would, OFFLINE. This module and what it imports read no environment (no
 * secrets, database or Redis), so the CLI entry runs it before loading the rest
 * of the CLI.
 *
 * The checks: the package's files and limits (a tarball only), the manifest
 * schema and its cross-field rules, the host API range this build provides, and
 * the manifest icon. Then the signed statement of a first-party artifact, when
 * `statement.json` and `statement.sig` sit beside the package (a dir holds one
 * package): its signature against the keys pinned in this build, and the app
 * name, version and the ui.js, manifest and package hashes against the package.
 * The report's `signature` is `{status: "unsigned"}` when there is no statement,
 * `{status: "verified", keyId, name, version, matches}`, or
 * `{status: "refused", reason, ...}`; a refused statement fails the run.
 *
 * Exit codes: 0 every check passed, 1 a check failed (the report on STDOUT
 * names it), 2 usage or an unreadable file.
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { ManifestValidationError, validateManifest } from "@liaison/app-sdk"
import {
  APP_SIGNING_KEYS,
  type AppSigningKey,
  checkArtifact,
  parseStatement,
  verifyStatement,
} from "@liaison/shared"
import { appIconErrors } from "~/modules/apps/contract"
import { hostApiIncompatibility } from "~/modules/apps/host-api"
import { verifyAppPackage } from "~/modules/apps/verify-package"

export const APP_VERIFY_USAGE = "usage: liaison app verify <file|dir>"

export interface AppCliResult {
  exitCode: number
  report: unknown
  message?: string
}

export interface VerifyCheck {
  check: "package" | "manifest" | "host_api" | "icon"
  ok: boolean
  message?: string
}

interface Manifest {
  name: string
  version: string
  host?: string
  iconSvg?: unknown
  iconName?: unknown
  noRollback?: boolean
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** What the signed statement check found (see the header). */
export type SignatureReport =
  | { status: "unsigned" }
  | {
      status: "verified" | "refused"
      reason?: string
      keyId?: string
      name?: string
      version?: string
      matches?: {
        name: boolean
        version: boolean
        ui: boolean
        manifest: boolean
        package: boolean
      }
      problems?: string[]
    }

const UNSIGNED: SignatureReport = { status: "unsigned" }

function report(
  file: string,
  checks: VerifyCheck[],
  manifest: Manifest | null,
  signature: SignatureReport = UNSIGNED,
): AppCliResult {
  const ok = checks.every((c) => c.ok) && signature.status !== "refused"
  return {
    exitCode: ok ? 0 : 1,
    report: {
      ok,
      file,
      ...(manifest ? { name: manifest.name, version: manifest.version } : {}),
      ...(manifest?.noRollback ? { noRollback: true } : {}),
      checks,
      signature,
    },
  }
}

/** The statement beside a package, checked against the package's own files. */
async function checkStatement(
  pkgPath: string,
  stagingDir: string,
  manifest: Manifest,
  keys: readonly AppSigningKey[],
): Promise<SignatureReport> {
  const dir = dirname(pkgPath)
  const statementPath = join(dir, "statement.json")
  const sigPath = join(dir, "statement.sig")
  if (!existsSync(statementPath) && !existsSync(sigPath)) return UNSIGNED
  if (!existsSync(statementPath) || !existsSync(sigPath)) {
    return { status: "refused", reason: "statement.json and statement.sig must come together" }
  }
  const bytes = new Uint8Array(readFileSync(statementPath))
  const parsed = parseStatement(bytes)
  const read = (f: string) =>
    existsSync(join(stagingDir, f)) ? new Uint8Array(readFileSync(join(stagingDir, f))) : null
  const uiBytes = read("ui.js")
  const manifestBytes = read("app.manifest.json")
  let matchInfo: Pick<SignatureReport & { status: "refused" }, "matches" | "problems"> = {}
  if (parsed && uiBytes && manifestBytes) {
    const problems = await checkArtifact(parsed, {
      name: manifest.name,
      version: manifest.version,
      uiBytes,
      manifestBytes,
      packageBytes: new Uint8Array(readFileSync(pkgPath)),
    })
    matchInfo = {
      matches: {
        name: !problems.includes("name"),
        version: !problems.includes("version"),
        ui: !problems.includes("ui_hash"),
        manifest: !problems.includes("manifest_hash"),
        package: !problems.includes("package_hash"),
      },
      problems,
    }
  }
  const identity = parsed ? { keyId: parsed.keyId, name: parsed.name, version: parsed.version } : {}
  if (!uiBytes) return { status: "refused", reason: "the package has no ui.js", ...identity }
  const verified = await verifyStatement(bytes, readFileSync(sigPath, "utf8"), keys)
  if (!verified.ok) return { status: "refused", reason: verified.reason, ...identity, ...matchInfo }
  if ((matchInfo.problems ?? ["unreadable"]).length > 0) {
    return { status: "refused", reason: "artifact_mismatch", ...identity, ...matchInfo }
  }
  return { status: "verified", ...identity, matches: matchInfo.matches }
}

/** A dir holding one package resolves to that package; anything else is itself. */
function resolveTarget(target: string): { file: string } | { error: string } {
  let isDir = false
  try {
    isDir = statSync(target).isDirectory()
  } catch {
    return { file: target }
  }
  if (!isDir) return { file: target }
  const pkgs = readdirSync(target).filter((f) => f.endsWith(".liaisonapp"))
  if (pkgs.length !== 1) {
    return { error: `'${target}' must hold exactly one .liaisonapp (found ${pkgs.length})` }
  }
  return { file: join(target, pkgs[0]) }
}

/** The manifest's own checks, after it parsed: host API range and icon. */
function manifestChecks(manifest: Manifest): VerifyCheck[] {
  const host = hostApiIncompatibility(manifest)
  const icon = appIconErrors(manifest)
  return [
    host ? { check: "host_api", ok: false, message: host } : { check: "host_api", ok: true },
    icon.length > 0
      ? { check: "icon", ok: false, message: icon.join("; ") }
      : { check: "icon", ok: true },
  ]
}

export async function runAppVerify(
  target: string,
  opts: { keys?: readonly AppSigningKey[] } = {},
): Promise<AppCliResult> {
  const resolved = resolveTarget(target)
  if ("error" in resolved) return { exitCode: 2, report: { ok: false }, message: resolved.error }
  const file = resolved.file
  let bytes: Buffer
  try {
    bytes = readFileSync(file)
  } catch (err) {
    return {
      exitCode: 2,
      report: { ok: false },
      message: `cannot read '${file}': ${errorText(err)}`,
    }
  }

  // A gzip stream is a package; anything else is read as a manifest.
  const isPackage = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b
  if (!isPackage) {
    let raw: unknown
    try {
      raw = JSON.parse(bytes.toString("utf8"))
    } catch (err) {
      return report(file, [{ check: "manifest", ok: false, message: errorText(err) }], null)
    }
    try {
      const manifest = validateManifest(raw) as Manifest
      return report(file, [{ check: "manifest", ok: true }, ...manifestChecks(manifest)], manifest)
    } catch (err) {
      const message = err instanceof ManifestValidationError ? err.message : errorText(err)
      return report(file, [{ check: "manifest", ok: false, message }], null)
    }
  }

  // Signature checking is off here: the report states it was not checked.
  let verified: Awaited<ReturnType<typeof verifyAppPackage>>
  try {
    verified = await verifyAppPackage(file, { requireSignature: false })
  } catch (err) {
    const message = errorText(err)
    const check = message.startsWith("Invalid app manifest") ? "manifest" : "package"
    return report(
      file,
      check === "manifest"
        ? [
            { check: "package", ok: true },
            { check, ok: false, message },
          ]
        : [{ check, ok: false, message }],
      null,
    )
  }
  try {
    const manifest = verified.manifest as Manifest
    const signature = await checkStatement(
      file,
      verified.stagingDir,
      manifest,
      opts.keys ?? APP_SIGNING_KEYS,
    )
    return report(
      file,
      [
        { check: "package", ok: true },
        { check: "manifest", ok: true },
        ...manifestChecks(manifest),
      ],
      manifest,
      signature,
    )
  } finally {
    rmSync(verified.stagingDir, { recursive: true, force: true })
  }
}

/**
 * The `app` subcommands that need no environment: `verify <file|dir>`. Null for the
 * others (`status`, `rollback`), which the full CLI runs.
 */
export async function runAppOffline(args: readonly string[]): Promise<AppCliResult | null> {
  const [sub, file] = args
  if (sub !== "verify") return null
  if (!file || file.startsWith("--"))
    return { exitCode: 2, report: null, message: APP_VERIFY_USAGE }
  return runAppVerify(file)
}
