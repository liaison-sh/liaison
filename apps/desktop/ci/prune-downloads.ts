// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Pruning old releases off the public downloads host.
//
// Every release writes about 1.2 GB of immutable objects under
// desktop/<version>/ (a test build under desktop/test/<version>/), and nothing
// ever took one away, so the bucket only grew. This runs after a successful
// mirror, in the channel that was just published, and deletes the version
// folders past the newest N.
//
// WHAT IS NEVER DELETED, whatever N is:
//
//   - the version just published;
//   - any version a manifest in the bucket points at, the production one AND
//     the test one: a folder an installed copy can be told to download from is
//     not old, whatever its number says. When a manifest cannot be read the
//     prune does nothing, because "referenced by nothing we could see" is not
//     "referenced by nothing";
//   - anything that is not a version folder of THIS channel: latest.json, the
//     desktop/latest/ aliases, files at the channel root, any prefix whose name
//     is not a version of this channel's shape. A production prune never lists
//     into desktop/test/ as a candidate, and a test prune never leaves it.
//
// ORDER is semver's, prerelease aware (0.1.33-test.1 < 0.1.33-test.2 <
// 0.1.33), never upload date (a re-run of an old release would make it "new")
// and never lexical order (0.1.9 sorts after 0.1.10 as text).
//
// A prune never fails a release. The release already succeeded when this
// runs: every error here is logged and reported as a warning, and the caller
// exits zero.

import { S3Client } from "bun"
import {
  BUCKET,
  DESKTOP_PREFIX,
  isTestVersion,
  keyInChannel,
  MANIFEST_KEY,
  s3Endpoint,
  TEST_MANIFEST_KEY,
  TEST_PREFIX,
} from "./downloads"

/** How many versions of a channel stay on the host when no --keep is given. */
export const DEFAULT_KEEP = 3

/** Bun's S3 client has no DeleteObjects, so the batch is a bounded number of
 *  single deletes in flight at once. */
export const DELETE_CONCURRENCY = 8

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

export interface Semver {
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

export function parseSemver(version: string): Semver | undefined {
  const match = SEMVER.exec(version)
  if (!match) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  }
}

function compareIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left)
  const rightNumeric = /^\d+$/.test(right)
  if (leftNumeric && rightNumeric) return Number(left) - Number(right)
  // A numeric identifier has lower precedence than an alphanumeric one.
  if (leftNumeric) return -1
  if (rightNumeric) return 1
  return left < right ? -1 : left > right ? 1 : 0
}

/** Semver precedence: negative when `left` is older. Throws on a string that
 *  is not a version, which the planner never hands it. */
export function compareVersions(left: string, right: string): number {
  const a = parseSemver(left)
  const b = parseSemver(right)
  if (!a || !b) throw new Error(`not a version: ${a ? right : left}`)
  for (const field of ["major", "minor", "patch"] as const) {
    if (a[field] !== b[field]) return a[field] - b[field]
  }
  // A release outranks every prerelease of the same number.
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return b.prerelease.length - a.prerelease.length
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const x = a.prerelease[index]
    const y = b.prerelease[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const order = compareIdentifier(x, y)
    if (order !== 0) return order
  }
  return 0
}

export type Channel = "production" | "test"

export function channelOf(version: string): Channel {
  return isTestVersion(version) ? "test" : "production"
}

/** The prefix a channel's version folders sit directly under. */
export function channelRoot(channel: Channel): string {
  return channel === "test" ? TEST_PREFIX : DESKTOP_PREFIX
}

/** Whether a folder name is a version of the channel. Anything else under the
 *  channel root (latest/, test/, a name nobody recognises) is not ours to
 *  delete. */
function isChannelVersion(name: string, channel: Channel): boolean {
  if (!parseSemver(name)) return false
  return channel === "test" ? isTestVersion(name) : !isTestVersion(name)
}

export interface ListedObject {
  key: string
  size: number
}

/** Every version a manifest names: its own version, and the version folder of
 *  every url in it, in either channel. */
export function versionsReferencedBy(manifestText: string): string[] {
  const manifest = JSON.parse(manifestText) as {
    version?: unknown
    platforms?: Record<string, { url?: unknown }>
  }
  const found = new Set<string>()
  if (typeof manifest.version === "string" && manifest.version) found.add(manifest.version)
  for (const entry of Object.values(manifest.platforms ?? {})) {
    if (typeof entry?.url !== "string") continue
    let pathname: string
    try {
      pathname = new URL(entry.url).pathname
    } catch {
      continue
    }
    const segments = pathname.split("/").filter(Boolean)
    // desktop/<v>/<file> or desktop/test/<v>/<file>.
    const index = segments[1] === "test" ? 2 : 1
    const version = segments[index]
    if (segments[0] === DESKTOP_PREFIX && version) found.add(version)
  }
  return [...found]
}

export interface PrunePlan {
  channel: Channel
  /** Every version folder found in the channel, newest first. */
  versions: string[]
  /** Kept, newest first, each with why. */
  kept: { version: string; reasons: string[] }[]
  /** To delete, newest first. */
  deleted: { version: string; keys: string[]; bytes: number }[]
  /** Keys under the channel root that are not in a version folder, left alone. */
  ignored: string[]
  bytes: number
}

/**
 * The prune, as data, with no I/O in it.
 *
 * `objects` is a listing of the channel root (for production that is all of
 * desktop/, test folder included: the test keys are recognised and left out
 * here, not trusted to a listing prefix).
 */
export function planPrune(input: {
  objects: ListedObject[]
  /** The version this run published. Decides the channel. */
  published: string
  keep: number
  /** Versions named by any manifest in the bucket. */
  referenced: readonly string[]
}): PrunePlan {
  const { objects, published, keep } = input
  if (!Number.isInteger(keep) || keep < 0) throw new Error(`--keep must be 0 or more, got ${keep}`)
  const channel = channelOf(published)
  const root = `${channelRoot(channel)}/`
  const byVersion = new Map<string, ListedObject[]>()
  const ignored: string[] = []
  for (const object of objects) {
    if (!object.key.startsWith(root)) continue
    // The other channel is not a stray of this one: it is not listed as ignored.
    if (channel === "production" && object.key.startsWith(`${TEST_PREFIX}/`)) continue
    const rest = object.key.slice(root.length)
    const slash = rest.indexOf("/")
    const folder = slash === -1 ? "" : rest.slice(0, slash)
    if (slash === -1 || !isChannelVersion(folder, channel)) {
      ignored.push(object.key)
      continue
    }
    const list = byVersion.get(folder) ?? []
    list.push(object)
    byVersion.set(folder, list)
  }

  const versions = [...byVersion.keys()].sort((left, right) => compareVersions(right, left))
  const referenced = new Set(input.referenced)
  const kept: PrunePlan["kept"] = []
  const deleted: PrunePlan["deleted"] = []
  versions.forEach((version, index) => {
    const reasons: string[] = []
    // --keep 0 turns pruning off: everything is kept.
    if (keep === 0) reasons.push("pruning disabled")
    else if (index < keep) reasons.push(`newest ${keep}`)
    if (version === published) reasons.push("just published")
    if (referenced.has(version)) reasons.push("named by a latest.json")
    if (reasons.length > 0) {
      kept.push({ version, reasons })
      return
    }
    const list = byVersion.get(version) ?? []
    deleted.push({
      version,
      keys: list.map((object) => object.key),
      bytes: list.reduce((sum, object) => sum + object.size, 0),
    })
  })

  // THE WALL, checked over the finished plan: every key is inside a version
  // folder of this channel, and no manifest is among them.
  for (const entry of deleted) {
    for (const key of entry.keys) {
      if (
        !key.startsWith(`${root}${entry.version}/`) ||
        !keyInChannel(key, published) ||
        key === MANIFEST_KEY ||
        key === TEST_MANIFEST_KEY
      ) {
        throw new Error(`refusing to prune ${key}: it is outside ${root}${entry.version}/`)
      }
    }
  }

  return {
    channel,
    versions,
    kept,
    deleted,
    ignored,
    bytes: deleted.reduce((sum, entry) => sum + entry.bytes, 0),
  }
}

/** Everything the prune does to the bucket, injectable for a test. */
export interface PruneIo {
  /** Every object under a prefix, every page of it. */
  list(prefix: string): Promise<ListedObject[]>
  /** An object's text, or undefined when there is no such object. */
  readText(key: string): Promise<string | undefined>
  /** Deletes a batch, reporting per key: one failure does not stop the rest. */
  deleteKeys(
    keys: string[],
  ): Promise<{ deleted: string[]; failed: { key: string; error: string }[] }>
  log(message: string): void
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"]
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`
}

export interface PruneResult {
  /** False when anything went wrong: the caller turns that into a warning. */
  ok: boolean
  plan?: PrunePlan
  /** Keys actually deleted (none on a dry run). */
  deletedKeys: string[]
  bytesFreed: number
  warnings: string[]
}

/** Runs a prune and never throws: the release it follows already succeeded. */
export async function runPrune(options: {
  published: string
  keep: number
  dryRun: boolean
  io: PruneIo
}): Promise<PruneResult> {
  const { io, published, keep, dryRun } = options
  const warnings: string[] = []
  const result: PruneResult = { ok: true, deletedKeys: [], bytesFreed: 0, warnings }
  if (keep === 0) {
    io.log("prune: --keep 0, pruning disabled")
    return result
  }
  try {
    const referenced: string[] = []
    for (const key of [MANIFEST_KEY, TEST_MANIFEST_KEY]) {
      const text = await io.readText(key)
      if (text === undefined) continue
      try {
        referenced.push(...versionsReferencedBy(text))
      } catch (error) {
        throw new Error(
          `${key} cannot be parsed, so what it points at is unknown: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    const channel = channelOf(published)
    const objects = await io.list(`${channelRoot(channel)}/`)
    const plan = planPrune({ objects, published, keep, referenced })
    result.plan = plan
    for (const entry of plan.kept) {
      io.log(`prune: keep ${entry.version} (${entry.reasons.join(", ")})`)
    }
    if (plan.ignored.length > 0) {
      io.log(`prune: left alone ${plan.ignored.length} object(s) outside version folders`)
    }
    if (plan.deleted.length === 0) {
      io.log(`prune: nothing to delete in the ${plan.channel} channel`)
      return result
    }
    if (dryRun) {
      for (const entry of plan.deleted) {
        io.log(
          `prune: would delete ${entry.version} (${entry.keys.length} objects, ${formatBytes(entry.bytes)})`,
        )
      }
      io.log(`prune: dry run, would free ${formatBytes(plan.bytes)}`)
      return result
    }
    const sizes = new Map<string, number>(objects.map((object) => [object.key, object.size]))
    for (const entry of plan.deleted) {
      const outcome = await io.deleteKeys(entry.keys)
      result.deletedKeys.push(...outcome.deleted)
      const freed = outcome.deleted.reduce((sum, key) => sum + (sizes.get(key) ?? 0), 0)
      result.bytesFreed += freed
      if (outcome.failed.length === 0) {
        io.log(
          `prune: deleted ${entry.version} (${entry.keys.length} objects, ${formatBytes(freed)})`,
        )
      } else {
        result.ok = false
        const warning = `prune: ${entry.version} only partly deleted, ${outcome.failed.length} of ${entry.keys.length} objects failed: ${outcome.failed
          .slice(0, 3)
          .map((failure) => `${failure.key}: ${failure.error}`)
          .join("; ")}`
        warnings.push(warning)
        io.log(warning)
      }
    }
    io.log(`prune: freed ${formatBytes(result.bytesFreed)}`)
  } catch (error) {
    result.ok = false
    const warning = `prune: skipped, ${error instanceof Error ? error.message : String(error)}`
    warnings.push(warning)
    io.log(warning)
  }
  return result
}

/** The real bucket, through the same Bun S3 client and credentials as the
 *  mirror's uploads. `log` is the mirror's, which redacts. */
export function realPruneIo(
  credentials: { accountId: string; accessKeyId: string; secretAccessKey: string },
  log: (message: string) => void,
  endpoint: string = s3Endpoint(credentials.accountId),
): PruneIo {
  const client = new S3Client({
    endpoint,
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    bucket: BUCKET,
    region: "auto",
  })
  return {
    async list(prefix) {
      const found: ListedObject[] = []
      let continuationToken: string | undefined
      do {
        const page = await client.list({ prefix, continuationToken })
        for (const object of page.contents ?? []) {
          found.push({ key: object.key, size: object.size ?? 0 })
        }
        continuationToken = page.isTruncated ? page.nextContinuationToken : undefined
      } while (continuationToken)
      return found
    },
    async readText(key) {
      if (!(await client.exists(key))) return undefined
      return client.file(key).text()
    },
    async deleteKeys(keys) {
      const deleted: string[] = []
      const failed: { key: string; error: string }[] = []
      const queue = [...keys]
      const worker = async () => {
        for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
          try {
            await client.delete(key)
            deleted.push(key)
          } catch (error) {
            failed.push({ key, error: error instanceof Error ? error.message : String(error) })
          }
        }
      }
      await Promise.all(Array.from({ length: DELETE_CONCURRENCY }, worker))
      return { deleted, failed }
    },
    log,
  }
}

/** --keep <n>, or the default. A value that is not a whole number of 0 or
 *  more is a usage error, never a silent default. */
export function parseKeep(argv: string[]): number {
  const index = argv.indexOf("--keep")
  if (index === -1) return DEFAULT_KEEP
  const raw = argv[index + 1] ?? ""
  if (!/^\d+$/.test(raw)) throw new Error(`--keep takes a whole number of 0 or more, got "${raw}"`)
  return Number(raw)
}
