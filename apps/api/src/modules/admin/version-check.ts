// SPDX-License-Identifier: FSL-1.1-ALv2
import { eq } from "drizzle-orm"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { withPrivilegedDb } from "~/db/privileged"
import { organizations } from "~/db/schema/kernel"
import { env } from "~/lib/env"
import { redis } from "~/lib/redis"
import { success } from "~/lib/response"

const CACHE_KEY = "versionCheck:latest"
const CACHE_LAST_KEY = "versionCheck:latest:last"
const CACHE_TTL_SECONDS = 6 * 60 * 60
const RELEASES_PATH = "/repos/mathieufro/liaison/releases?per_page=30"
/** A release whose name carries this marker fixes a security issue; the release
 *  workflow adds it from the tag annotation (`Security: yes`). */
const SECURITY_MARKER = "[security]"

// Single-flight guard: if multiple requests arrive while the cache is cold,
// all waiters share the same in-flight GitHub fetch instead of hammering the
// API concurrently. The promise is cleared once the fetch settles.
let inFlightFetch: Promise<LatestFetch | null> | null = null

interface VersionCheckBody {
  running: string
  latest?: string
  latestUrl?: string
  updateAvailable: boolean
  securityUpdate: boolean
  stale?: boolean
  enabled: boolean
}

interface LatestFetch {
  tag: string
  htmlUrl?: string
  /** Tags of the non-draft releases marked `[security]`. Kept as a list, not a
   *  flag: whether one matters depends on the running version, which changes
   *  across an upgrade while the cached entry lives on. */
  securityTags: string[]
}

function encodeCached(value: LatestFetch): string {
  return JSON.stringify(value)
}

function decodeCached(raw: string): LatestFetch | null {
  // Older entries (pre-latestUrl) were stored as the bare tag string.
  if (!raw.startsWith("{")) return { tag: raw, securityTags: [] }
  try {
    const parsed = JSON.parse(raw) as { tag?: string; htmlUrl?: string; securityTags?: unknown }
    if (typeof parsed.tag !== "string") return null
    return {
      tag: parsed.tag,
      htmlUrl: typeof parsed.htmlUrl === "string" ? parsed.htmlUrl : undefined,
      securityTags: Array.isArray(parsed.securityTags)
        ? parsed.securityTags.filter((t): t is string => typeof t === "string")
        : [],
    }
  } catch {
    return null
  }
}

interface ReleaseEntry {
  tag_name?: string
  name?: string | null
  html_url?: string
  draft?: boolean
  prerelease?: boolean
}

function parseSemver(tag: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(tag)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** Positive when `a` is a higher version than `b`. Unparseable tags compare equal. */
function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa || !pb) return 0
  return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2]
}

async function fetchLatest(): Promise<LatestFetch | null> {
  try {
    const r = await fetch(`${env.GITHUB_API_BASE}${RELEASES_PATH}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "liaison-version-check" },
      signal: AbortSignal.timeout(5_000),
    })
    if (!r.ok) return null
    const releases = (await r.json()) as ReleaseEntry[]
    if (!Array.isArray(releases)) return null
    const published = releases.filter(
      (rel) => !rel.draft && typeof rel.tag_name === "string" && parseSemver(rel.tag_name),
    )
    const stable = published.filter((rel) => !rel.prerelease)
    const newest = stable.reduce<ReleaseEntry | null>(
      (best, rel) => (!best || compareSemver(rel.tag_name!, best.tag_name!) > 0 ? rel : best),
      null,
    )
    if (!newest?.tag_name) return null
    // Only allow GitHub release URLs to prevent open-redirect if the GitHub
    // response is ever spoofed or the API base is redirected.
    const rawUrl = typeof newest.html_url === "string" ? newest.html_url : undefined
    const safeUrl = rawUrl && /^https:\/\/github\.com\//.test(rawUrl) ? rawUrl : undefined
    return {
      tag: newest.tag_name,
      htmlUrl: safeUrl,
      securityTags: stable
        .filter((rel) => typeof rel.name === "string" && rel.name.includes(SECURITY_MARKER))
        .map((rel) => rel.tag_name!),
    }
  } catch {
    return null
  }
}

/** A release tag (`v1.2.3`, `1.2.3`, `v1.2.3-rc.1`), as opposed to a branch
 *  build (`main-<sha>`), `dev`, or a deployment's own label. */
const RELEASE_TAG = /^v?\d+\.\d+\.\d+/

/**
 * Whether the running build is a release other than the latest one. A build
 * that is not a release (a branch build, a local `dev`) is never "behind": it
 * matches no tag, and announcing an update to it would never go away.
 */
export function isUpdateAvailable(running: string, latest: string): boolean {
  if (!RELEASE_TAG.test(running)) return false
  return latest.replace(/^v/, "") !== running.replace(/^v/, "")
}

/**
 * Whether a security release is newer than the running build. A build that is
 * not a release is never behind, as in {@link isUpdateAvailable}.
 */
export function isSecurityUpdate(running: string, securityTags: string[]): boolean {
  if (!RELEASE_TAG.test(running)) return false
  return securityTags.some((tag) => compareSemver(tag, running) > 0)
}

async function readOrgEnabled(orgId: string): Promise<boolean> {
  const [row] = await withPrivilegedDb(orgId, "version-check-org-setting", async (tx) =>
    tx
      .select({ enabled: organizations.updateChecksEnabled })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1),
  )
  return row?.enabled ?? true
}

export const versionCheckRoutes = new Hono<AppEnv>().get("/", async (c) => {
  const running = env.LIAISON_VERSION
  const orgId = c.get("orgId")
  const enabled = await readOrgEnabled(orgId)
  if (!enabled) {
    return success(c, {
      running,
      updateAvailable: false,
      securityUpdate: false,
      enabled: false,
    } satisfies VersionCheckBody)
  }

  const cachedRaw = await redis.get(CACHE_KEY)
  const cached = cachedRaw ? decodeCached(cachedRaw) : null
  if (cached) {
    return success(c, {
      running,
      latest: cached.tag,
      latestUrl: cached.htmlUrl,
      updateAvailable: isUpdateAvailable(running, cached.tag),
      securityUpdate: isSecurityUpdate(running, cached.securityTags),
      enabled: true,
    } satisfies VersionCheckBody)
  }

  // Single-flight: reuse an in-flight fetch if one is already underway.
  if (!inFlightFetch) {
    inFlightFetch = fetchLatest().finally(() => {
      inFlightFetch = null
    })
  }
  const latest = await inFlightFetch
  if (latest) {
    const encoded = encodeCached(latest)
    await redis.set(CACHE_KEY, encoded, "EX", CACHE_TTL_SECONDS)
    await redis.set(CACHE_LAST_KEY, encoded)
    return success(c, {
      running,
      latest: latest.tag,
      latestUrl: latest.htmlUrl,
      updateAvailable: isUpdateAvailable(running, latest.tag),
      securityUpdate: isSecurityUpdate(running, latest.securityTags),
      enabled: true,
    } satisfies VersionCheckBody)
  }

  // Fetch failed — serve the no-TTL last known value if present.
  const staleRaw = await redis.get(CACHE_LAST_KEY)
  const stale = staleRaw ? decodeCached(staleRaw) : null
  if (stale) {
    return success(c, {
      running,
      latest: stale.tag,
      latestUrl: stale.htmlUrl,
      updateAvailable: isUpdateAvailable(running, stale.tag),
      securityUpdate: isSecurityUpdate(running, stale.securityTags),
      stale: true,
      enabled: true,
    } satisfies VersionCheckBody)
  }

  return success(c, {
    running,
    updateAvailable: false,
    securityUpdate: false,
    stale: true,
    enabled: true,
  } satisfies VersionCheckBody)
})
