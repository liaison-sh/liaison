// SPDX-License-Identifier: FSL-1.1-ALv2
// Verification of a `.liaisonapp` tarball: unpack into an isolated staging dir,
// assert the required files are present, validate the manifest against the
// package-format schema, compute the artifact sha256, and (optionally) verify a
// cosign keyless signature against a trusted publisher identity.
//
// The staging dir is cleaned up on EVERY failure path. On success it is returned
// to the caller (the install service), which MUST clean it up in a try/finally.
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gunzipSync } from "node:zlib"
import {
  ManifestValidationError,
  type PackageManifest,
  REQUIRED_FILES,
  validateManifest,
} from "@liaison/app-sdk"
import { assertManifestPatternsSafe, UnsafeManifestPatternError } from "~/lib/manifest-regex"
import { withOpenFileSync } from "~/lib/read-checked-file"

export interface VerifyOptions {
  /** Require a valid cosign signature. Production default is `true`. */
  requireSignature?: boolean
  /**
   * Path to the detached cosign signature bundle (the `<tarball>.cosign.bundle`
   * sibling file). When present — or when `requireSignature` is set — the
   * signature is verified against the tarball's exact bytes.
   */
  signatureBundlePath?: string
  /**
   * Regex matched against the cosign certificate identity. MUST be set (and not
   * a `.*` wildcard) whenever signature verification runs — accepting any signer
   * is no better than accepting unsigned packages.
   */
  cosignIdentityRegex?: string
  /** Expected OIDC issuer. Defaults to GitHub Actions' issuer. */
  cosignIssuer?: string
}

export interface VerifyResult {
  manifest: PackageManifest
  sha256: string
  /** The verified cosign bundle's contents — stored for later re-verification. */
  signatureBundle?: string
  /** Caller owns cleanup of this directory (try/finally rmSync). */
  stagingDir: string
}

/** Largest `.liaisonapp` (and detached signature bundle) the platform will download or open. */
export const MAX_PACKAGE_BYTES = 50 * 1024 * 1024
export const MAX_SIGNATURE_BUNDLE_BYTES = 1024 * 1024
/** Limits on what a package may EXPAND to: guards against decompression bombs. */
export const MAX_PACKAGE_EXPANDED_BYTES = 200 * 1024 * 1024
export const MAX_PACKAGE_ENTRIES = 2_000

/**
 * Anchor an operator-supplied cosign identity regex. cosign's
 * `--certificate-identity-regexp` is an unanchored search, so `https://github.com/org/.*`
 * would also match `https://evil.example/?https://github.com/org/x`. The value is wrapped
 * as `^(?:...)$` so it always has to match the WHOLE identity.
 */
export function anchorIdentityRegex(regex: string): string {
  return `^(?:${regex})$`
}

/** True for a regex that accepts any signer (`.*`, `^.*$`, `(.*)`, `.+`...). */
export function isMatchAllIdentityRegex(regex: string): boolean {
  let r = regex.trim()
  for (;;) {
    const next = r
      .replace(/^\^/, "")
      .replace(/\$$/, "")
      .replace(/^\((?:\?:)?(.*)\)$/, "$1")
    if (next === r) break
    r = next
  }
  return r === "" || /^\.[*+]\??$/.test(r)
}

/**
 * Inspect the gzip'd tar BEFORE extracting it: bound the expanded size (the gunzip itself
 * is capped, so a bomb never materialises), the entry count and each file's size, and
 * refuse entries that are not plain files/directories or that escape the extraction root.
 */
export function assertTarballWithinLimits(tarballPath: string): void {
  // Sized and read through one descriptor: the file measured is the file read.
  const compressed = withOpenFileSync(tarballPath, ({ size }, read) => {
    if (size > MAX_PACKAGE_BYTES) {
      throw new Error(`Package is too large: ${size} bytes (limit ${MAX_PACKAGE_BYTES})`)
    }
    return read()
  })
  let raw: Buffer
  try {
    raw = gunzipSync(compressed, { maxOutputLength: MAX_PACKAGE_EXPANDED_BYTES })
  } catch (e) {
    if ((e as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") {
      throw new Error(
        `Package expands beyond ${MAX_PACKAGE_EXPANDED_BYTES} bytes: refusing (possible decompression bomb)`,
      )
    }
    throw new Error(`Invalid tarball: ${(e as Error).message}`)
  }
  let offset = 0
  let entries = 0
  let total = 0
  let longName: string | null = null
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512)
    if (header.every((b) => b === 0)) break
    const field = (from: number, to: number) => {
      const slice = header.subarray(from, to)
      const nul = slice.indexOf(0)
      return slice.subarray(0, nul === -1 ? slice.length : nul).toString("utf8")
    }
    const fileSize = Number.parseInt(field(124, 136).trim() || "0", 8)
    if (!Number.isFinite(fileSize) || fileSize < 0) throw new Error("Invalid tarball header")
    const type = String.fromCharCode(header[156] || 48)
    const prefix = field(345, 500)
    const name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100))
    longName = null
    const dataBlocks = Math.ceil(fileSize / 512) * 512
    if (type === "L") {
      longName = raw
        .subarray(offset + 512, offset + 512 + fileSize)
        .toString("utf8")
        .replace(/\0+$/, "")
    } else if (type === "x" || type === "g") {
      // pax metadata: carries no payload of its own
    } else {
      entries++
      if (entries > MAX_PACKAGE_ENTRIES) {
        throw new Error(`Package has too many entries (limit ${MAX_PACKAGE_ENTRIES})`)
      }
      if (type === "1" || type === "2") {
        // Hard link ("1") or symlink ("2"): extracted, it would point outside the package.
        throw new Error(
          `Refusing package: '${name}' is a ${type === "2" ? "symlink" : "hard link"}`,
        )
      }
      if (type !== "0" && type !== "\0" && type !== "5") {
        throw new Error(`Refusing package: '${name}' is not a regular file or directory`)
      }
      if (name.startsWith("/") || name.split("/").includes("..")) {
        throw new Error(`Refusing package: '${name}' escapes the package root`)
      }
      if (type === "0" || type === "\0") {
        if (fileSize > MAX_PACKAGE_BYTES) {
          throw new Error(`Refusing package: '${name}' is too large`)
        }
        total += fileSize
        if (total > MAX_PACKAGE_EXPANDED_BYTES) {
          throw new Error(`Package expands beyond ${MAX_PACKAGE_EXPANDED_BYTES} bytes`)
        }
      }
    }
    offset += 512 + dataBlocks
  }
}

const DEFAULT_COSIGN_ISSUER = "https://token.actions.githubusercontent.com"

/**
 * Thrown when signature verification is required but no usable trusted-publisher
 * identity is configured (empty or `.*` wildcard). Carries `status` (400) +
 * `code` so the API `errorHandler` surfaces an actionable client error naming
 * the env var to set, rather than flattening a bare `Error` to an opaque 500.
 */
export class MissingTrustedPublisherError extends Error {
  readonly status = 400
  readonly code = "APP_SIGNATURE_PUBLISHER_UNCONFIGURED"
  constructor() {
    super(
      "App signature verification is required but no trusted publisher is configured. " +
        "Set LIAISON_TRUSTED_APP_PUBLISHERS to an explicit cosign certificate-identity " +
        "regex (a '.*' wildcard is refused), or set LIAISON_REQUIRE_APP_SIGNATURE=false " +
        "to run an unsigned/dev instance — do not disable signing just to work around this.",
    )
    this.name = "MissingTrustedPublisherError"
  }
}

/**
 * Recursively reject any symlink in the extracted package. A malicious tarball
 * can ship `bundle.js` (or any file) as a symlink pointing at a host path or
 * into another installed app's directory — `existsSync` would follow it and the
 * later `cpSync` would copy the link out of the staging dir. Every entry must
 * be a regular file or a real directory.
 */
function assertNoSymlinks(dir: string): void {
  for (const name of readdirSync(dir)) {
    const entry = join(dir, name)
    const st = lstatSync(entry)
    if (st.isSymbolicLink()) {
      throw new Error(
        `Refusing package: '${name}' is a symlink — packages must contain only regular files`,
      )
    }
    if (st.isDirectory()) {
      assertNoSymlinks(entry)
    } else if (!st.isFile()) {
      throw new Error(`Refusing package: '${name}' is not a regular file`)
    }
  }
}

export async function verifyAppPackage(
  tarballPath: string,
  opts: VerifyOptions = {},
): Promise<VerifyResult> {
  if (!existsSync(tarballPath)) throw new Error(`Tarball not found: ${tarballPath}`)
  assertTarballWithinLimits(tarballPath)
  const stage = mkdtempSync(join(tmpdir(), "liaison-app-"))
  // Single try/catch: the staging dir is cleaned up on ANY failure path —
  // untar error, missing file, manifest parse error, missing signature, or
  // signature verification failure.
  try {
    const untar = spawnSync("tar", [
      "-xzf",
      tarballPath,
      "-C",
      stage,
      "--no-same-owner",
      "--no-same-permissions",
    ])
    if (untar.status !== 0) {
      throw new Error(`Invalid tarball: ${untar.stderr?.toString() ?? "untar failed"}`)
    }

    // Reject symlinks before any file is read or copied (zip-slip / link attack).
    assertNoSymlinks(stage)

    for (const f of REQUIRED_FILES) {
      const p = join(stage, f)
      // lstatSync (not existsSync) so a symlink masquerading as a required file
      // cannot satisfy the check — though assertNoSymlinks already rejected it.
      if (!existsSync(p) || !lstatSync(p).isFile()) {
        throw new Error(`Missing required file: ${f}`)
      }
    }

    // Phase 17 — switched from `packageManifestSchema.safeParse` to
    // `validateManifest` so cross-app-calls → dependencies.tools synthesis +
    // cross-field rules (pdf_templates requires pdf.render; cross_app_calls
    // and dependencies.tools must agree) run here at install time. Errors
    // are thrown as a typed `ManifestValidationError` and re-shaped to the
    // existing "Invalid app manifest: ..." surface so callers don't change.
    let manifest: PackageManifest
    try {
      manifest = validateManifest(
        JSON.parse(readFileSync(join(stage, "app.manifest.json"), "utf8")),
      )
      // Patterns run on the host's event loop: only linear ones install.
      assertManifestPatternsSafe(manifest)
    } catch (e: unknown) {
      if (e instanceof ManifestValidationError || e instanceof UnsafeManifestPatternError) {
        throw new Error(`Invalid app manifest: ${e.message}`)
      }
      throw e
    }

    const sha256 = createHash("sha256").update(readFileSync(tarballPath)).digest("hex")

    let signatureBundle: string | undefined
    const sigBundlePath = opts.signatureBundlePath
    const haveSignature = !!sigBundlePath && existsSync(sigBundlePath)
    if (haveSignature && statSync(sigBundlePath as string).size > MAX_SIGNATURE_BUNDLE_BYTES) {
      throw new Error(`Signature bundle is too large (limit ${MAX_SIGNATURE_BUNDLE_BYTES} bytes)`)
    }
    if (opts.requireSignature || haveSignature) {
      if (!haveSignature) {
        throw new Error(
          "Missing signature — requireSignature is on but no detached cosign bundle was provided",
        )
      }
      // The identity regex must NOT default to `.*` — accepting any signer
      // defeats the purpose of signature verification. This is an OPERATOR
      // MISCONFIGURATION (signing on, no trusted publisher), not a bad package:
      // tag the error with `status`/`code` so the API error handler surfaces an
      // actionable 400 naming the env var instead of an opaque 500 that pushes
      // operators to disable signing entirely. (Route handlers also pre-check
      // this via `resolveSignatureConfig`; this is the defense-in-depth backstop
      // for direct service-layer callers.)
      const identityRegex = opts.cosignIdentityRegex
      if (!identityRegex || isMatchAllIdentityRegex(identityRegex)) {
        throw new MissingTrustedPublisherError()
      }
      // Verify the signature against the tarball's exact bytes. The bundle is a
      // detached sibling file, so the signed blob and the verified blob are
      // guaranteed identical (no re-tar between signing and verification).
      const verify = spawnSync(
        "cosign",
        [
          "verify-blob",
          "--bundle",
          sigBundlePath as string,
          "--certificate-identity-regexp",
          anchorIdentityRegex(identityRegex),
          "--certificate-oidc-issuer",
          opts.cosignIssuer ?? DEFAULT_COSIGN_ISSUER,
          tarballPath,
        ],
        // Pass `env` explicitly: Bun's spawnSync does not re-snapshot
        // `process.env` between calls, so a test (or operator) that mutates
        // PATH at runtime would otherwise be ignored. Forwarding process.env
        // makes the PATH-lookup behavior consistent with Node and lets the
        // verify-package.test.ts stub on PATH take effect.
        { env: { ...process.env } },
      )
      if (verify.error) {
        throw new Error(
          `cosign binary not available: ${verify.error.message} — install cosign or disable signature verification`,
        )
      }
      if (verify.status !== 0) {
        throw new Error(`Signature verification failed: ${verify.stderr?.toString() ?? ""}`)
      }
      signatureBundle = readFileSync(sigBundlePath as string, "utf8")
    }

    return { manifest, sha256, signatureBundle, stagingDir: stage }
  } catch (e) {
    rmSync(stage, { recursive: true, force: true })
    throw e
  }
}
