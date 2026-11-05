// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Sign a built first-party app artifact: write `statement.json` and
// `statement.sig` (packages/shared/src/app-signing/statement.ts) next to it.
//
// <dir> holds the frozen `<name>-<version>.liaisonapp` (bundled-apps/<name>/dist
// after scripts/build-bundled-app.sh). The tool takes ui.js and the manifest
// from inside the package and writes them beside it as `ui.js` and
// `manifest.json` (a loose copy already there must be byte-identical), refuses a
// UI bundle that is not single-file ESM (A8), signs, and verifies its own output
// with the public half before returning. The published artifact is then exactly
// the five files of the dir.
//
// The private key is an Ed25519 PKCS#8 PEM file on the signing machine
// (`openssl genpkey -algorithm ed25519`). It is read from the path given, used in
// memory and never printed. The key id is derived from the public key
// (`keyIdFor`), so `keys.ts` entries and statements always agree.
//
// Usage:
//   bun run scripts/app-signing/sign-artifact.ts <dir> --key <pem-path>
//     [--source-digest <hex> | --source <bundled-apps/<name> dir>]
//   bun run scripts/app-signing/sign-artifact.ts --public-key --key <pem-path>
//     (prints the `keys.ts` entry for the key: {keyId, publicKey})
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  base64ToBytes,
  bytesToBase64,
  sha256Hex,
} from "../../packages/shared/src/app-signing/encoding"
import { type AppStatement, statementBytes } from "../../packages/shared/src/app-signing/statement"
import {
  singleFileBundleProblems,
  verifyArtifact,
} from "../../packages/shared/src/app-signing/verify"
import { sourceDigest as computeSourceDigest, resolveAppDir } from "./source-digest"

/** Key id of a raw Ed25519 public key (base64): `app-` + 16 hex of its sha256. */
export async function keyIdFor(publicKeyBase64: string): Promise<string> {
  const raw = base64ToBytes(publicKeyBase64)
  if (raw?.length !== 32) throw new Error("not a raw 32-byte Ed25519 public key")
  return `app-${(await sha256Hex(raw)).slice(0, 16)}`
}

interface LoadedKey {
  privateKey: CryptoKey
  publicKey: string
  keyId: string
}

async function loadPrivateKey(path: string): Promise<LoadedKey> {
  const pem = readFileSync(path, "utf8")
  const body = /-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/.exec(pem)?.[1]
  const der = body ? base64ToBytes(body.replace(/\s+/g, "")) : null
  if (!der) throw new Error(`${path}: not a PKCS#8 PEM private key`)
  let privateKey: CryptoKey
  try {
    privateKey = await crypto.subtle.importKey("pkcs8", new Uint8Array(der), "Ed25519", true, [
      "sign",
    ])
  } catch {
    throw new Error(`${path}: not an Ed25519 private key`)
  }
  // The JWK of an Ed25519 private key carries its public half as `x` (base64url).
  const jwk = await crypto.subtle.exportKey("jwk", privateKey)
  if (!jwk.x) throw new Error(`${path}: cannot derive the public key`)
  const publicKey = bytesToBase64(
    base64ToBytes(
      jwk.x
        .replace(/-/g, "+")
        .replace(/_/g, "/")
        .padEnd(Math.ceil(jwk.x.length / 4) * 4, "="),
    ) ?? new Uint8Array(),
  )
  return { privateKey, publicKey, keyId: await keyIdFor(publicKey) }
}

function extract(tarball: string): string {
  const stage = mkdtempSync(join(tmpdir(), "liaison-sign-"))
  const res = spawnSync("tar", ["-xzf", tarball, "-C", stage, "--no-same-owner"])
  if (res.status !== 0) {
    rmSync(stage, { recursive: true, force: true })
    throw new Error(`cannot unpack ${tarball}: ${String(res.stderr)}`)
  }
  return stage
}

/** Write `name` into `dir` from `bytes`, or check that the copy already there is identical. */
function placeLoose(dir: string, name: string, bytes: Buffer): void {
  const path = join(dir, name)
  if (existsSync(path)) {
    if (!readFileSync(path).equals(bytes)) {
      throw new Error(
        `${path} differs from the ${name === "ui.js" ? "ui.js" : "manifest"} inside the package`,
      )
    }
    return
  }
  writeFileSync(path, bytes)
}

export interface SignOptions {
  keyPath: string
  /** Hex source digest; computed from `source` when absent. */
  sourceDigest?: string
  /** `bundled-apps/<name>` dir to digest; defaults to this repo's app of the manifest's name. */
  source?: string
  issuedAt?: string
}

export async function signArtifactDir(dir: string, opts: SignOptions): Promise<AppStatement> {
  const tarballs = readdirSync(dir).filter((f) => f.endsWith(".liaisonapp"))
  if (tarballs.length !== 1) {
    throw new Error(`${dir}: expected exactly one .liaisonapp, found ${tarballs.length}`)
  }
  const tarballPath = join(dir, tarballs[0])
  const stage = extract(tarballPath)
  try {
    const manifestPath = join(stage, "app.manifest.json")
    const uiPath = join(stage, "ui.js")
    if (!existsSync(manifestPath)) throw new Error(`${tarballPath}: no app.manifest.json`)
    if (!existsSync(uiPath))
      throw new Error(`${tarballPath}: no ui.js (an app without a UI is not signed)`)
    const manifestBytes = readFileSync(manifestPath)
    const uiBytes = readFileSync(uiPath)
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
      name?: string
      version?: string
      host?: string
    }
    const { name, version, host } = manifest
    if (!name || !version) throw new Error(`${tarballPath}: manifest has no name or version`)
    if (!host) throw new Error(`${tarballPath}: manifest declares no host API range ("host")`)
    if (tarballs[0] !== `${name}-${version}.liaisonapp`) {
      throw new Error(`${tarballPath}: file name is not ${name}-${version}.liaisonapp`)
    }
    const problems = singleFileBundleProblems(uiBytes.toString("utf8"))
    if (problems.length > 0) {
      throw new Error(
        `${name}@${version}: ui.js is not a single-file ESM bundle: ${problems.join(", ")}`,
      )
    }

    const digest = opts.sourceDigest ?? computeSourceDigest(opts.source ?? resolveAppDir(name))
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`bad source digest: ${digest}`)
    const key = await loadPrivateKey(opts.keyPath)
    const packageBytes = readFileSync(tarballPath)

    placeLoose(dir, "ui.js", uiBytes)
    placeLoose(dir, "manifest.json", manifestBytes)

    const statement: AppStatement = {
      v: 1,
      keyId: key.keyId,
      name,
      version,
      hostApi: host,
      sha256: {
        ui: await sha256Hex(uiBytes),
        manifest: await sha256Hex(manifestBytes),
        package: await sha256Hex(packageBytes),
      },
      sourceDigest: digest,
      issuedAt: opts.issuedAt ?? new Date().toISOString(),
    }
    const bytes = statementBytes(statement)
    const sig = bytesToBase64(
      new Uint8Array(await crypto.subtle.sign("Ed25519", key.privateKey, new Uint8Array(bytes))),
    )
    // Check the output exactly as a client will before anything is written.
    const check = await verifyArtifact(
      bytes,
      sig,
      {
        name,
        version,
        uiBytes: new Uint8Array(uiBytes),
        manifestBytes: new Uint8Array(manifestBytes),
        packageBytes: new Uint8Array(packageBytes),
      },
      { keys: [{ keyId: key.keyId, publicKey: key.publicKey }] },
    )
    if (!check.ok) throw new Error(`${name}@${version}: self-verification failed: ${check.reason}`)
    writeFileSync(join(dir, "statement.json"), bytes)
    writeFileSync(join(dir, "statement.sig"), sig)
    return statement
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const keyPath = flag(args, "--key")
  if (!keyPath) {
    console.error(
      "usage: bun run scripts/app-signing/sign-artifact.ts <dir> --key <pem-path> [--source-digest <hex> | --source <app-dir>]\n" +
        "       bun run scripts/app-signing/sign-artifact.ts --public-key --key <pem-path>",
    )
    process.exit(2)
  }
  try {
    if (args.includes("--public-key")) {
      const key = await loadPrivateKey(keyPath)
      console.log(JSON.stringify({ keyId: key.keyId, publicKey: key.publicKey }))
    } else {
      const dir = args[0]
      if (!dir || dir.startsWith("--")) throw new Error("missing <dir>")
      const statement = await signArtifactDir(dir, {
        keyPath,
        sourceDigest: flag(args, "--source-digest"),
        source: flag(args, "--source"),
      })
      console.log(
        `[sign-artifact] signed ${statement.name}@${statement.version} with ${statement.keyId} (source ${statement.sourceDigest.slice(0, 12)})`,
      )
    }
  } catch (err) {
    console.error(`[sign-artifact] ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
