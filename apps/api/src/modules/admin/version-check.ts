// SPDX-License-Identifier: FSL-1.1-ALv2
import { eq } from "drizzle-orm"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { withPrivilegedDb } from "~/db/privileged"
import { organizations } from "~/db/schema/kernel"
import { env, type ReleaseChannel } from "~/lib/env"
import { redis } from "~/lib/redis"
import { success } from "~/lib/response"

const CACHE_KEY = "versionCheck:latest"
const CACHE_LAST_KEY = "versionCheck:latest:last"
const CACHE_TTL_SECONDS = 6 * 60 * 60
// Fourteen of these are nightly pre-releases, so the page is wider than the
// default: a security release must stay in view behind them.
const RELEASES_PATH = "/repos/mathieufro/liaison/releases?per_page=100"
/** A release whose name carries this marker fixes a security issue; the release
 *  workflow adds it from the tag annotation (`Security: yes`). */
const SECURITY_MARKER = "[security]"

// Single-flight guard: if multiple requests arrive while the cache is cold,
// all waiters share the same in-flight GitHub fetch instead of hammering the
// API concurrently. The promise is cleared once the fetch settles.
let inFlightFetch: Promise<PublishedRelease[] | null> | null = null

interface VersionCheckBody {
  running: string
  channel: ReleaseChannel
  latest?: string
  latestUrl?: string
  updateAvailable: boolean
  securityUpdate: boolean
  stale?: boolean
  enabled: boolean
}

/**
 * One published release, as cached. The cache holds the list, not an answer,
 * because the answer depends on the running version and the channel, which both
 * change across an upgrade while the cached entry lives on.
 */
export interface PublishedRelease {
  tag: string
  htmlUrl?: string
  /** When the release's commit was made (GitHub's `created_at`), in ms. */
  commitAt?: number
  prerelease: boolean
  security: boolean
}

function decodeCached(raw: string): PublishedRelease[] | null {
  const plain = (tag: string, security: boolean, htmlUrl?: string): PublishedRelease => ({
    tag,
    htmlUrl,
    prerelease: false,
    security,
  })
  // Older entries (pre-latestUrl) were stored as the bare tag string.
  if (!raw.startsWith("{")) return [plain(raw, false)]
  try {
    const parsed = JSON.parse(raw) as {
      releases?: PublishedRelease[]
      tag?: string
      htmlUrl?: string
      securityTags?: unknown
    }
    if (Array.isArray(parsed.releases)) return parsed.releases
    // Entries from before the channels: the newest release and the security tags.
    if (typeof parsed.tag !== "string") return null
    const securityTags = Array.isArray(parsed.securityTags)
      ? parsed.securityTags.filter((t): t is string => typeof t === "string")
      : []
    return [
      plain(
        parsed.tag,
        securityTags.includes(parsed.tag),
        typeof parsed.htmlUrl === "string" ? parsed.htmlUrl : undefined,
      ),
      ...securityTags.filter((t) => t !== parsed.tag).map((t) => plain(t, true)),
    ]
  } catch {
    return null
  }
}

interface ReleaseEntry {
  tag_name?: string
  name?: string | null
  html_url?: string
  created_at?: string
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

/**
 * The day of a nightly: `YYYYMMDD` from the pre-release tag `nightly-YYYYMMDD`
 * or the version an image reports, `nightly-YYYYMMDD-<shortsha>`.
 */
function nightlyDay(version: string): string | null {
  return /^nightly-(\d{8})(?:-[0-9a-f]{7,40})?$/.exec(version)?.[1] ?? null
}

async function fetchReleases(): Promise<PublishedRelease[] | null> {
  try {
    const r = await fetch(`${env.GITHUB_API_BASE}${RELEASES_PATH}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "liaison-version-check" },
      signal: AbortSignal.timeout(5_000),
    })
    if (!r.ok) return null
    const entries = (await r.json()) as ReleaseEntry[]
    if (!Array.isArray(entries)) return null
    const releases = entries.flatMap((rel): PublishedRelease[] => {
      const tag = rel.tag_name
      if (rel.draft || typeof tag !== "string") return []
      if (!parseSemver(tag) && !(rel.prerelease && nightlyDay(tag))) return []
      const commitAt = rel.created_at ? Date.parse(rel.created_at) : Number.NaN
      // Only allow GitHub release URLs to prevent open-redirect if the GitHub
      // response is ever spoofed or the API base is redirected.
      const rawUrl = typeof rel.html_url === "string" ? rel.html_url : undefined
      return [
        {
          tag,
          htmlUrl: rawUrl && /^https:\/\/github\.com\//.test(rawUrl) ? rawUrl : undefined,
          commitAt: Number.isNaN(commitAt) ? undefined : commitAt,
          prerelease: rel.prerelease === true,
          security: typeof rel.name === "string" && rel.name.includes(SECURITY_MARKER),
        },
      ]
    })
    return releases.length > 0 ? releases : null
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
 * Whether a release or nightly is newer than the running build. A build that is
 * neither (a branch build, a local `dev`) is never behind.
 *
 * Two nightlies compare by day and two releases by version. A release and a
 * nightly compare by when their commits were made, since a release is cut from
 * a nightly's commit, and main is linear: the same commit is not newer.
 */
function isNewerThanRunning(
  candidate: PublishedRelease,
  running: string,
  releases: PublishedRelease[],
): boolean {
  const runningDay = nightlyDay(running)
  if (!runningDay && !RELEASE_TAG.test(running)) return false
  const candidateDay = nightlyDay(candidate.tag)
  if (runningDay && candidateDay) return candidateDay > runningDay
  if (!runningDay && !candidateDay) return compareSemver(candidate.tag, running) > 0
  if (candidate.commitAt === undefined) return false
  if (runningDay) {
    // A pruned nightly is no longer listed. Its commit was made on or before
    // its day, so a commit after that day is certainly newer.
    const own = releases.find((r) => r.tag === `nightly-${runningDay}`)?.commitAt
    return candidate.commitAt > (own ?? endOfDay(runningDay))
  }
  const own = releases.find((r) => r.tag.replace(/^v/, "") === running.replace(/^v/, ""))?.commitAt
  // A release no longer on the page is older than everything on it.
  return own === undefined || candidate.commitAt > own
}

function endOfDay(day: string): number {
  return Date.parse(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T23:59:59.999Z`)
}

function newest(
  list: PublishedRelease[],
  isAhead: (a: PublishedRelease, b: PublishedRelease) => boolean,
): PublishedRelease | undefined {
  return list.reduce<PublishedRelease | undefined>(
    (best, rel) => (!best || isAhead(rel, best) ? rel : best),
    undefined,
  )
}

export interface VersionStatus {
  latest?: PublishedRelease
  updateAvailable: boolean
  securityUpdate: boolean
}

/**
 * What Settings > System says for a running build on a channel.
 *
 * `release` compares against the newest release. `nightly` compares against the
 * newest nightly, or a release whose commit is newer than that nightly's (or the
 * newest release while no nightly exists). A security release counts on either
 * channel when it is newer than the running build.
 */
export function resolveVersionStatus(
  channel: ReleaseChannel,
  running: string,
  releases: PublishedRelease[],
): VersionStatus {
  const stable = releases.filter((r) => !r.prerelease && parseSemver(r.tag))
  const newestStable = newest(stable, (a, b) => compareSemver(a.tag, b.tag) > 0)
  const newestNightly = newest(
    releases.filter((r) => r.prerelease && nightlyDay(r.tag)),
    (a, b) => a.tag > b.tag,
  )

  let latest = newestStable
  if (channel === "nightly" && newestNightly) {
    const stableIsAhead =
      newestStable?.commitAt !== undefined &&
      newestNightly.commitAt !== undefined &&
      newestStable.commitAt > newestNightly.commitAt
    latest = stableIsAhead ? newestStable : newestNightly
  }

  const updateAvailable = !latest
    ? false
    : RELEASE_TAG.test(running) && !nightlyDay(latest.tag)
      ? isUpdateAvailable(running, latest.tag)
      : isNewerThanRunning(latest, running, releases)
  return {
    latest,
    updateAvailable,
    securityUpdate: stable.some((r) => r.security && isNewerThanRunning(r, running, releases)),
  }
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

function statusBody(releases: PublishedRelease[], stale?: true): VersionCheckBody {
  const running = env.LIAISON_VERSION
  const channel = env.LIAISON_RELEASE_CHANNEL
  const status = resolveVersionStatus(channel, running, releases)
  return {
    running,
    channel,
    latest: status.latest?.tag,
    latestUrl: status.latest?.htmlUrl,
    updateAvailable: status.updateAvailable,
    securityUpdate: status.securityUpdate,
    ...(stale ? { stale } : {}),
    enabled: true,
  }
}

export const versionCheckRoutes = new Hono<AppEnv>().get("/", async (c) => {
  const running = env.LIAISON_VERSION
  const channel = env.LIAISON_RELEASE_CHANNEL
  const orgId = c.get("orgId")
  const enabled = await readOrgEnabled(orgId)
  if (!enabled) {
    return success(c, {
      running,
      channel,
      updateAvailable: false,
      securityUpdate: false,
      enabled: false,
    } satisfies VersionCheckBody)
  }

  const cachedRaw = await redis.get(CACHE_KEY)
  const cached = cachedRaw ? decodeCached(cachedRaw) : null
  if (cached) return success(c, statusBody(cached))

  // Single-flight: reuse an in-flight fetch if one is already underway.
  if (!inFlightFetch) {
    inFlightFetch = fetchReleases().finally(() => {
      inFlightFetch = null
    })
  }
  const releases = await inFlightFetch
  if (releases) {
    const encoded = JSON.stringify({ releases })
    await redis.set(CACHE_KEY, encoded, "EX", CACHE_TTL_SECONDS)
    await redis.set(CACHE_LAST_KEY, encoded)
    return success(c, statusBody(releases))
  }

  // Fetch failed, or nothing is published yet: serve the no-TTL last known
  // value if present.
  const staleRaw = await redis.get(CACHE_LAST_KEY)
  const stale = staleRaw ? decodeCached(staleRaw) : null
  if (stale) return success(c, statusBody(stale, true))

  return success(c, {
    running,
    channel,
    updateAvailable: false,
    securityUpdate: false,
    stale: true,
    enabled: true,
  } satisfies VersionCheckBody)
})
