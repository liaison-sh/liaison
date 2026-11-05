// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The public download surface, in one module.
//
// The GitHub repository is PRIVATE. Its release assets, and the
// `releases/latest/download/latest.json` the updater used to point at, answer
// 404 to every anonymous client: an installed copy asking for its next version
// and a customer clicking a download link both get nothing, and neither of
// them can be handed a token. So the public surface is a Cloudflare R2 bucket
// on the liaison.sh account, served at downloads.liaison.sh, and the GitHub
// release stays as the private record of what was built.
//
// The layout below is a CONTRACT: the web app links to these paths, the
// updater reads the manifest at one of them, and the mirror writes all of
// them. It lives here rather than in each consumer so that the manifest
// builder, the mirror and the rollback cannot drift into naming three
// different hosts.
//
//   desktop/<version>/<artifact>   every artifact under its canonical name
//                                  from ci/artifact-names.ts, immutable
//   desktop/latest.json            the updater manifest, re-read constantly
//   desktop/latest/<alias>         stable installer links for the web app

import path from "node:path"
import {
  type Arch,
  artifactName,
  type Kind,
  PLATFORM_ARCHES,
  type Platform,
} from "./artifact-names"

export const DOWNLOADS_HOST = "downloads.liaison.sh"
export const DOWNLOADS_BASE = `https://${DOWNLOADS_HOST}`

/** Everything desktop lives under one prefix: the bucket is the project's
 *  public surface and other things will be published beside it. */
export const DESKTOP_PREFIX = "desktop"

/** The object key of the updater manifest, and the url compiled into every
 *  build through tauri.conf.json. One string, so a change here and a stale
 *  endpoint in the config cannot coexist: apps/desktop/updater-endpoint.test.ts
 *  pins the config against this value. */
export const MANIFEST_KEY = `${DESKTOP_PREFIX}/latest.json`
export const UPDATER_ENDPOINT = `${DOWNLOADS_BASE}/${MANIFEST_KEY}`

/** Where the stable installer links live, the ones a download page may hard
 *  code because they never carry a version. */
export const ALIAS_PREFIX = `${DESKTOP_PREFIX}/latest`

/** THE TEST CHANNEL (channel.ts): signed builds nobody on production is
 *  offered. Everything of it lives under this prefix, and a test version is
 *  routed here by its version string alone, so no caller can put one anywhere
 *  else by passing the wrong argument. */
export const TEST_PREFIX = `${DESKTOP_PREFIX}/test`
export const TEST_MANIFEST_KEY = `${TEST_PREFIX}/latest.json`
export const TEST_UPDATER_ENDPOINT = `${DOWNLOADS_BASE}/${TEST_MANIFEST_KEY}`

/** The one shape a test version takes: a semver prerelease, 1.2.3-test.N. */
export const TEST_VERSION = /^\d+\.\d+\.\d+-test\.\d+$/

export function isTestVersion(version: string): boolean {
  return TEST_VERSION.test(version)
}

/** The versioned prefix for one release. Immutable once written. A test
 *  version goes under desktop/test/, and nothing else ever does. */
export function versionPrefix(version: string): string {
  if (isTestVersion(version)) return `${TEST_PREFIX}/${version}`
  if (version === "test" || version.startsWith("test/")) {
    throw new Error(`${version} is not a release version`)
  }
  return `${DESKTOP_PREFIX}/${version}`
}

/** The manifest a version is published in: the test manifest for a test
 *  version, the production one for everything else. */
export function manifestKeyFor(version: string): string {
  return isTestVersion(version) ? TEST_MANIFEST_KEY : MANIFEST_KEY
}

/** Whether an object key belongs to the channel of `version`. The mirror
 *  checks every key against this before it uploads a byte: a test run can
 *  write under desktop/test/ only, and a production run never there. */
export function keyInChannel(key: string, version: string): boolean {
  const test = key.startsWith(`${TEST_PREFIX}/`)
  return isTestVersion(version) ? test : !test
}

/** The public url of an object key. */
export function downloadUrl(key: string): string {
  return `${DOWNLOADS_BASE}/${key}`
}

/** Where one release artifact is downloadable from. This is the only place a
 *  manifest url is built. */
export function artifactUrl(version: string, file: string): string {
  return downloadUrl(`${versionPrefix(version)}/${file}`)
}

/** The stable alias of each installer a human downloads, and the artifact it
 *  is a copy of. The updater archives get no alias: nothing reads them by a
 *  rolling name, and one that lagged the manifest would hand an installed copy
 *  a payload whose signature does not match. */
export interface AliasSpec {
  platform: Platform
  kind: Kind
  /** The file name under `desktop/latest/`. */
  alias: string
}

export const ALIASES: readonly AliasSpec[] = [
  { platform: "macos", kind: "dmg", alias: "Liaison-macos.dmg" },
  { platform: "windows", kind: "exe", alias: "Liaison-windows-setup.exe" },
  { platform: "linux", kind: "AppImage", alias: "Liaison-linux.AppImage" },
  { platform: "linux", kind: "deb", alias: "Liaison-linux.deb" },
]

/** The architectures an alias may be cut from, in preference order. macOS is
 *  built universal, and the one alias has to run on every Mac, so a universal
 *  image wins over a thin one. The thin arches follow for the platforms that
 *  have no universal build. */
export const ALIAS_ARCH_PREFERENCE: readonly Arch[] = ["universal", "aarch64", "x86_64"]

/** A versioned object never changes, so it is cached for a year. */
export const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable"

/** The manifest and the aliases are REPLACED by every release, and the
 *  manifest is what an installed copy polls. A long cache here is a release
 *  nobody is offered for as long as the cache lives. */
export const ROLLING_CACHE_CONTROL = "public, max-age=60"

/** Content types by extension. A wrong one here is a browser that renders an
 *  installer as text or downloads a manifest instead of handing it to the
 *  updater, so the ones that matter are spelled out and the fallback is the
 *  type that always downloads. */
export function contentTypeFor(name: string): string {
  const lower = name.toLowerCase()
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "application/gzip"
  if (lower.endsWith(".json")) return "application/json"
  if (lower.endsWith(".dmg")) return "application/x-apple-diskimage"
  if (lower.endsWith(".exe")) return "application/vnd.microsoft.portable-executable"
  if (lower.endsWith(".deb")) return "application/vnd.debian.binary-package"
  if (lower.endsWith(".appimage")) return "application/x-executable"
  if (lower.endsWith(".sig") || lower.endsWith(".sha256") || lower.endsWith(".txt")) {
    return "text/plain; charset=utf-8"
  }
  if (path.basename(lower) === "sha256sums") return "text/plain; charset=utf-8"
  return "application/octet-stream"
}

/** The Cloudflare credentials, by NAME. No value belongs in this repository,
 *  and the names are asserted against the workflow's own env block.
 *
 *  They are R2 S3 credentials, not a Cloudflare API token: the objects are
 *  written through R2's S3 compatible endpoint, because the REST object API
 *  caps a body at 100 MB with no multipart and the disk image alone is past
 *  that. An R2 API token yields both halves at creation time. */
export const ACCESS_KEY_ID_ENV = "LIAISON_DOWNLOADS_R2_ACCESS_KEY_ID"
export const SECRET_ACCESS_KEY_ENV = "LIAISON_DOWNLOADS_R2_SECRET_ACCESS_KEY"
export const ACCOUNT_ENV = "LIAISON_DOWNLOADS_CF_ACCOUNT_ID"

/** The bucket, as a constant rather than an option. One public host means one
 *  bucket, and an override is a way to publish a release where nobody looks
 *  for it while every log says it went out. */
export const BUCKET = "liaison-downloads"

/** The S3 compatible endpoint of one Cloudflare account. */
export function s3Endpoint(accountId: string): string {
  return `https://${accountId}.r2.cloudflarestorage.com`
}

/** The largest object this pipeline will put in one request. R2 accepts a
 *  single PutObject up to 5 GiB; the ceiling here is lower so that an artifact
 *  that grew past what one request can carry fails by name, in the preflight,
 *  rather than at the far end of a long upload. */
export const MAX_SINGLE_PUT_BYTES = 4 * 1024 * 1024 * 1024

/** The manifest shape this module needs, structurally, so the constants do
 *  not have to import the gate that produces one. */
export interface ManifestShape {
  version: string
  /** The copy a customer reads in the update prompt. */
  notes?: string
  platforms: Record<string, { signature: string; url: string }>
}

/** True when a url is served by the public downloads host over https. */
export function isDownloadsUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === "https:" && parsed.hostname === DOWNLOADS_HOST
  } catch {
    return false
  }
}

/**
 * Every payload a manifest names, by file name, or a THROW.
 *
 * This is the refusal that keeps the two surfaces from crossing. A manifest
 * whose urls still point at github.com is a manifest every installed copy
 * fetches a 404 from: the repository is private, so the failure is not a
 * broken link a human sees, it is an update channel that is silently dead.
 * Mirroring such a manifest would publish that state to the one host clients
 * do read, so it is refused before a byte is uploaded.
 */
export function manifestPayloadNames(manifest: ManifestShape): Map<string, string> {
  const version = manifest.version
  if (!version) throw new Error("the manifest names no version")
  const prefix = `${DOWNLOADS_BASE}/${versionPrefix(version)}/`
  const names = new Map<string, string>()
  const entries = Object.entries(manifest.platforms ?? {})
  if (entries.length === 0) throw new Error("the manifest names no platform")
  for (const [key, entry] of entries) {
    const url = entry?.url ?? ""
    if (!isDownloadsUrl(url) || !url.startsWith(prefix)) {
      throw new Error(
        `the manifest points ${key} at ${url}, which is not under ${prefix}. ` +
          "Every url in a published manifest has to be on the public downloads host: " +
          "the GitHub repository is private, so an installed copy reading any other host gets a 404 and is never offered an update again.",
      )
    }
    const name = url.slice(prefix.length)
    if (name.length === 0 || name.includes("/")) {
      throw new Error(`the manifest points ${key} at ${url}, which names no file under ${prefix}`)
    }
    names.set(key, name)
  }
  return names
}

/** The artifact an alias is a copy of, among the files actually present.
 *  Returns undefined when no architecture of that kind was built. */
export function aliasSource(
  spec: AliasSpec,
  version: string,
  present: Set<string>,
): string | undefined {
  const shipped: readonly Arch[] = PLATFORM_ARCHES[spec.platform]
  for (const arch of ALIAS_ARCH_PREFERENCE) {
    if (!shipped.includes(arch)) continue
    const name = artifactName({ platform: spec.platform, kind: spec.kind, version, arch })
    if (present.has(name)) return name
  }
  return undefined
}
