// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Build the FIRST-PARTY APP CATALOG: one `.liaisonapp` per `bundled-apps/<name>/`,
// plus a `catalog.json` index, under a single output directory. The runtime image
// bakes this directory in (see `apps/api/Dockerfile`); the catalog module
// (`modules/apps/catalog.ts`) reads it so the Apps UI / `liaison config apply`
// can install a first-party app with one click.
//
// Per app, the catalog takes the SIGNED release artifact when there is one for
// exactly this source, and builds the app locally otherwise:
//  1. compute the app's source digest (scripts/app-signing/source-digest.ts);
//  2. look it up in the artifacts index: `LIAISON_APP_ARTIFACTS_DIR` (an offline
//     mirror) when set, else https://downloads.liaison.sh/apps/index.json. The image
//     build fetches that index itself (`ADD` in apps/api/Dockerfile, so a changed index
//     invalidates the catalog layer) and hands it over with `--index-file`;
//  3. use the artifact only when its signed statement verifies with the keys
//     committed in packages/shared/src/app-signing/keys.ts and names this app,
//     version and source digest, and every file matches its hash. The package,
//     statement.json and statement.sig go into the catalog; shells verify them
//     before running the app's UI in their main page.
//  4. otherwise (no key pinned yet, no entry, a fork's changed source, host
//     unreachable, any verification failure) freeze locally as before, unsigned:
//     the app works everywhere and runs in the sandbox frame in the shells.
// Never fails the build for a fetch error: one log line per app says what was used.
//
// Locally built apps are frozen `--skip-sign` (cosign keyless needs interactive
// OIDC) and the catalog install path installs them with `requireSignature: false`:
// the trust boundary for the server is the image itself.
//
// Usage (from repo root or inside liaison/):
//   bun run scripts/build-app-catalog.ts [--out-dir <abs-path>]
//     [--index-file <path> [--index-url <url>]] [--no-artifacts]
//
//   --index-file  read the artifacts index from this file instead of fetching it; the
//                 artifacts themselves are still fetched, from the directory of
//                 --index-url (default https://downloads.liaison.sh/apps/index.json)
//   --no-artifacts  look nothing up: every app is built locally, unsigned
//
// Default out dir: <repoRoot>/app-catalog
import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { AppListing } from "../packages/app-sdk/src/app-listing"
import { listingDeclarationErrors } from "../packages/app-sdk/src/app-listing"
import { utf8 } from "../packages/shared/src/app-signing/encoding"
import { APP_SIGNING_KEYS, type AppSigningKey } from "../packages/shared/src/app-signing/keys"
import { verifyArtifact } from "../packages/shared/src/app-signing/verify"
import { sourceDigest } from "./app-signing/source-digest"
import { acquireSlot } from "./lib/machine-slots"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const BUNDLED_ROOT = join(REPO_ROOT, "bundled-apps")
const BUILD_SCRIPT = join(REPO_ROOT, "scripts", "build-bundled-app.sh")

/** Where signed first-party artifacts are published. */
export const DEFAULT_ARTIFACTS_URL = "https://downloads.liaison.sh/apps"

/** One catalog entry, mirrored by `CatalogEntry` in modules/apps/catalog.ts. */
export interface CatalogEntry {
  name: string
  displayName?: string
  description?: string
  version: string
  /** `app` or `connector`. */
  kind?: "app" | "connector"
  /** SPDX license expression (required: every catalog entry is listed). */
  license: string
  author?: string
  /** The store listing, copied from the manifest. Mandatory for a catalog entry. */
  listing: AppListing
  /** Tarball filename, relative to the catalog dir. */
  file: string
  /** Scopes the app's manifest requests — granted in full on a first-party install. */
  scopes: string[]
  /** Connection ids the app declares (granted in full on install). */
  connections: string[]
  /** sha256 of the package's worker.js (its Worker module): the install refuses other bytes. */
  workerSha256?: string
  /** Present when `file` is the signed release artifact: its statement files. */
  signed?: { statement: string; signature: string }
}

/** Where to look for signed artifacts: a local mirror dir or an HTTP base URL. */
export type ArtifactSource =
  | { dir: string }
  | {
      url: string
      fetch?: (input: string) => Promise<Response>
      timeoutMs?: number
    }

/** `index.json` at the root of the artifacts location. */
interface ArtifactIndex {
  v: 1
  apps: Array<{ name: string; version: string; sourceDigest: string }>
}

interface ArtifactReader {
  read(path: string): Promise<Uint8Array>
  describe: string
}

function readerFor(source: ArtifactSource): ArtifactReader {
  if ("dir" in source) {
    return {
      describe: source.dir,
      read: async (path) => new Uint8Array(readFileSync(join(source.dir, path))),
    }
  }
  const doFetch = source.fetch ?? ((input: string) => fetch(input))
  const base = source.url.replace(/\/+$/, "")
  return {
    describe: base,
    read: async (path) => {
      const url = `${base}/${path}`
      // A pending timer would hold the build process open after the catalog is done.
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const res = await Promise.race([
          doFetch(url),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`timed out fetching ${url}`)),
              source.timeoutMs ?? 15_000,
            )
          }),
        ])
        if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
        return new Uint8Array(await res.arrayBuffer())
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

function parseIndex(bytes: Uint8Array): ArtifactIndex {
  const raw = JSON.parse(utf8.decode(bytes)) as Partial<ArtifactIndex>
  if (raw.v !== 1 || !Array.isArray(raw.apps)) throw new Error("index.json: unknown format")
  return { v: 1, apps: raw.apps }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The files inside a package, by name; null when it cannot be unpacked. */
function packageFile(packageBytes: Uint8Array, inner: string): Uint8Array | null {
  const stage = mkdtempSync(join(tmpdir(), "liaison-catalog-signed-"))
  try {
    const tarball = join(stage, "pkg.liaisonapp")
    writeFileSync(tarball, packageBytes)
    const out = join(stage, "x")
    mkdirSync(out)
    const res = spawnSync("tar", ["-xzf", tarball, "-C", out, "--no-same-owner"])
    if (res.status !== 0 || !existsSync(join(out, inner))) return null
    return new Uint8Array(readFileSync(join(out, inner)))
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

const sameBytes = (a: Uint8Array | null, b: Uint8Array): boolean =>
  a !== null && a.length === b.length && a.every((v, i) => v === b[i])

interface SignedArtifact {
  keyId: string
  packageBytes: Uint8Array
  statementBytes: Uint8Array
  sig: Uint8Array
}

/**
 * The signed artifact for exactly this app, version and source, verified; or the
 * reason there is none. Never throws.
 */
async function findSignedArtifact(
  app: { name: string; version: string; sourceDigest: string },
  index: ArtifactIndex,
  reader: ArtifactReader,
  keys: readonly AppSigningKey[],
): Promise<SignedArtifact | { reason: string }> {
  const listed = index.apps.find(
    (e) => e.name === app.name && e.version === app.version && e.sourceDigest === app.sourceDigest,
  )
  if (!listed) {
    const sameVersion = index.apps.some((e) => e.name === app.name && e.version === app.version)
    return {
      reason: sameVersion
        ? "the source differs from the signed release of this version"
        : "no signed release of this version",
    }
  }
  const at = `${app.name}/${app.version}`
  try {
    const [statementBytes, sig, uiBytes, manifestBytes, packageBytes] = await Promise.all([
      reader.read(`${at}/statement.json`),
      reader.read(`${at}/statement.sig`),
      reader.read(`${at}/ui.js`),
      reader.read(`${at}/manifest.json`),
      reader.read(`${at}/${app.name}-${app.version}.liaisonapp`),
    ])
    const verified = await verifyArtifact(
      statementBytes,
      utf8.decode(sig),
      { name: app.name, version: app.version, uiBytes, manifestBytes, packageBytes },
      { keys },
    )
    if (!verified.ok) {
      const detail =
        verified.reason === "artifact_mismatch" ? `: ${verified.problems.join(", ")}` : ""
      return { reason: `signed artifact refused (${verified.reason}${detail})` }
    }
    if (verified.statement.sourceDigest !== app.sourceDigest) {
      return { reason: "signed artifact refused (source digest differs from its index entry)" }
    }
    // A package from before Worker modules were packaged is not used: every catalog
    // package carries its worker.js (the install records it, catalog.json pins it).
    if (packageFile(packageBytes, "worker.js") === null) {
      return { reason: "signed artifact refused (the package carries no worker.js)" }
    }
    // The installed files come from the package: they must be the signed loose ones.
    if (
      !sameBytes(packageFile(packageBytes, "ui.js"), uiBytes) ||
      !sameBytes(packageFile(packageBytes, "app.manifest.json"), manifestBytes)
    ) {
      return { reason: "signed artifact refused (package contents differ from the signed files)" }
    }
    return { keyId: verified.statement.keyId, packageBytes, statementBytes, sig }
  } catch (err) {
    return { reason: `signed artifact unavailable: ${errorText(err)}` }
  }
}

/** Freeze `bundled-apps/<name>` with the repo's build script; returns the tarball path. */
function freezeLocally(name: string, bundledRoot: string): string {
  execFileSync("bash", [BUILD_SCRIPT, name, "--skip-sign", "--skip-typecheck"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  })
  const manifest = JSON.parse(readFileSync(join(bundledRoot, name, "app.manifest.json"), "utf8"))
  return join(bundledRoot, name, "dist", `${name}-${manifest.version ?? "0.1.0"}.liaisonapp`)
}

export interface BuildCatalogOptions {
  bundledRoot: string
  outDir: string
  /** Where signed artifacts are looked up; null skips the lookup. */
  source: ArtifactSource | null
  /**
   * The artifacts index, already fetched (the image build `ADD`s it so that a changed
   * index invalidates the build cache). When set, `source` serves only the artifacts.
   */
  indexFile?: string
  /** Pinned public keys (production: APP_SIGNING_KEYS). */
  keys: readonly AppSigningKey[]
  /** Builds one app locally and returns its tarball path (default: the freeze script). */
  buildLocal?: (name: string) => string
  log?: (line: string) => void
}

export async function buildAppCatalog(opts: BuildCatalogOptions): Promise<CatalogEntry[]> {
  const log = opts.log ?? ((line: string) => console.log(line))
  const buildLocal = opts.buildLocal ?? ((name: string) => freezeLocally(name, opts.bundledRoot))
  // Fresh output each run so a removed/renamed app never lingers in the catalog.
  rmSync(opts.outDir, { recursive: true, force: true })
  mkdirSync(opts.outDir, { recursive: true })

  // The index is read once; when it cannot be, every app says why and builds locally.
  let index: ArtifactIndex | null = null
  let indexProblem: string | null = null
  const reader = opts.source ? readerFor(opts.source) : null
  if (opts.keys.length === 0) {
    indexProblem = "no pinned app-signing key in this source"
  } else if (!reader) {
    indexProblem = "signed artifacts lookup off (no artifacts location)"
  } else if (opts.indexFile) {
    try {
      index = parseIndex(new Uint8Array(readFileSync(opts.indexFile)))
    } catch (err) {
      indexProblem = `index ${opts.indexFile} unreadable: ${errorText(err)}`
    }
  } else {
    try {
      index = parseIndex(await reader.read("index.json"))
    } catch (err) {
      indexProblem = `${reader.describe} unreachable: ${errorText(err)}`
    }
  }

  const entries: CatalogEntry[] = []
  for (const name of readdirSync(opts.bundledRoot).sort()) {
    const appDir = join(opts.bundledRoot, name)
    if (!statSync(appDir).isDirectory()) continue
    const manifestPath = join(appDir, "app.manifest.json")
    if (!existsSync(manifestPath)) continue

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      name: string
      displayName?: string
      description?: string
      version?: string
      kind?: "app" | "connector"
      license?: string
      author?: string
      listing?: AppListing
      scopes?: string[]
      connections?: Record<string, unknown>
    }
    const version = manifest.version ?? "0.1.0"
    // A catalog entry is a store listing: refuse to bake one without it (or with an
    // invalid one), before spending a freeze on the app.
    const listingErrors = manifest.listing
      ? listingDeclarationErrors(manifest)
      : ["listing: a catalog app needs a store listing (category, icon, summary, sourceRepository)"]
    if (listingErrors.length > 0 || !manifest.listing || !manifest.license) {
      throw new Error(`[build-app-catalog] ${name}: ${listingErrors.join("; ")}`)
    }

    // Computed before any build step, which writes dist/, node_modules/ and bun.lock.
    const digest = sourceDigest(appDir)
    const file = `${name}-${version}.liaisonapp`
    const found =
      index && reader
        ? await findSignedArtifact(
            { name, version, sourceDigest: digest },
            index,
            reader,
            opts.keys,
          )
        : { reason: indexProblem ?? "no artifacts index" }

    let signed: CatalogEntry["signed"]
    if ("keyId" in found) {
      writeFileSync(join(opts.outDir, file), found.packageBytes)
      signed = {
        statement: `${name}-${version}.statement.json`,
        signature: `${name}-${version}.statement.sig`,
      }
      writeFileSync(join(opts.outDir, signed.statement), found.statementBytes)
      writeFileSync(join(opts.outDir, signed.signature), found.sig)
      log(`[build-app-catalog] ${name}@${version}: signed release artifact (key ${found.keyId})`)
    } else {
      log(`[build-app-catalog] ${name}@${version}: building locally (unsigned): ${found.reason}`)
      const tarball = buildLocal(name)
      if (!existsSync(tarball)) {
        throw new Error(`[build-app-catalog] freeze produced no tarball for ${name} at ${tarball}`)
      }
      copyFileSync(tarball, join(opts.outDir, file))
    }

    // The package's Worker module, pinned in catalog.json: the catalog install
    // refuses a package whose worker.js hashes to anything else.
    const worker = packageFile(new Uint8Array(readFileSync(join(opts.outDir, file))), "worker.js")
    if (!worker) {
      throw new Error(`[build-app-catalog] ${name}@${version}: the package carries no worker.js`)
    }
    const workerSha256 = createHash("sha256").update(worker).digest("hex")

    entries.push({
      name,
      ...(manifest.displayName ? { displayName: manifest.displayName } : {}),
      ...(manifest.description ? { description: manifest.description } : {}),
      version,
      ...(manifest.kind ? { kind: manifest.kind } : {}),
      license: manifest.license,
      ...(manifest.author ? { author: manifest.author } : {}),
      listing: manifest.listing,
      file,
      scopes: manifest.scopes ?? [],
      connections: Object.keys(manifest.connections ?? {}),
      workerSha256,
      ...(signed ? { signed } : {}),
    })
  }

  writeFileSync(join(opts.outDir, "catalog.json"), `${JSON.stringify(entries, null, 2)}\n`)
  return entries
}

interface CliArgs {
  outDir: string
  indexFile?: string
  indexUrl: string
  noArtifacts: boolean
}

/** The value after `--name`, or undefined. */
function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : undefined
}

export function parseCliArgs(args: string[]): CliArgs {
  return {
    outDir: argValue(args, "--out-dir") ?? join(REPO_ROOT, "app-catalog"),
    indexFile: argValue(args, "--index-file"),
    indexUrl: argValue(args, "--index-url") ?? `${DEFAULT_ARTIFACTS_URL}/index.json`,
    noArtifacts: args.includes("--no-artifacts"),
  }
}

/** The artifacts base for an index URL: the URL must end in `/index.json`. */
export function artifactsBaseOf(indexUrl: string): string {
  if (!/^https?:\/\/.+\/index\.json$/.test(indexUrl)) {
    throw new Error(`[build-app-catalog] the index URL must end in /index.json: ${indexUrl}`)
  }
  return indexUrl.slice(0, -"/index.json".length)
}

if (import.meta.main) {
  if (!existsSync(BUNDLED_ROOT)) {
    console.error(`[build-app-catalog] no bundled-apps/ at ${BUNDLED_ROOT} — nothing to build`)
  } else {
    const cli = parseCliArgs(process.argv.slice(2))
    // Building every app is heavy work: hold one of the machine-wide slots
    // (machine-slots.ts), unless a caller above already does. Inside a container
    // build the slot directory is the container's own, so this never waits there.
    if (process.env.LIAISON_TEST_LOCK_HELD !== "1") {
      await acquireSlot({ cmd: "build-app-catalog.ts" })
      process.env.LIAISON_TEST_LOCK_HELD = "1"
    }
    const mirror = process.env.LIAISON_APP_ARTIFACTS_DIR
    // A mirror carries its own index.json; --no-artifacts looks nothing up.
    const source: ArtifactSource | null = mirror
      ? { dir: mirror }
      : cli.noArtifacts
        ? null
        : { url: artifactsBaseOf(cli.indexUrl) }
    const entries = await buildAppCatalog({
      bundledRoot: BUNDLED_ROOT,
      outDir: cli.outDir,
      source,
      ...(source && "url" in source && cli.indexFile ? { indexFile: cli.indexFile } : {}),
      keys: APP_SIGNING_KEYS,
    })
    const signedCount = entries.filter((e) => e.signed).length
    console.log(
      `[build-app-catalog] wrote ${entries.length} apps (${signedCount} signed) + catalog.json to ${cli.outDir}: ${entries
        .map((e) => e.name)
        .join(", ")}`,
    )
  }
}
