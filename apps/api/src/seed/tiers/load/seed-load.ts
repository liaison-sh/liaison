// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `seedLoadOrgs`: the `load` tier. N busy orgs for a load run (the flood of
// many tenants, search and list scale, the background of a launch scenario),
// each a full demo world (shape `demo`), and with `volume` thousands of rows
// on top (`seed/bulk/volume.ts`, with its invariant check).
//
// Every load org is DISPOSABLE by construction: its demo marker is a visitor
// marker with `synthetic: true` and an `expiresAt`, so the demo reaper deletes
// it once it expires, and the visitor counts keep it out of the real visitors'
// room. On a box whose load harness is on (`LOAD_HARNESS_KEY`), the org also
// carries the load-org flag (`lib/load-harness.ts`): its agent turns run on
// the scripted load model and its mail goes to the effect sink.
//
// Deterministic and idempotent per slug: org `i` is `<prefix><i>`, a re-run
// adopts the orgs (and their bulk rows) an earlier run wrote and keeps their
// expiry, so re-running cannot extend a load org's life.

import { loadHarnessEnabled } from "~/lib/load-harness"
import { loadDemoMarker, markOrgAsDemo, visitorMarker } from "~/modules/demo/demo-org"
import { DEMO_COMPANY_NAME } from "~/modules/demo/demo-seeder"
import { runAsSeed } from "~/modules/notifications/seeded"
import { DEFAULT_VOLUME, seedVolume, type VolumeResult, type VolumeSpec } from "~/seed/bulk/volume"
import { seedContext } from "~/seed/context"
import { type SeedDemoWorldResult, seedDemoWorld } from "../demo/seed-demo"

export const LOAD_SHAPES = ["demo"] as const
export type LoadShape = (typeof LOAD_SHAPES)[number]

/** How long a load org lives by default before the reaper takes it. */
export const DEFAULT_LOAD_TTL_HOURS = 6

export interface SeedLoadOptions {
  orgs: number
  /** Org `i`'s slug is `<prefix><i>`. */
  prefix?: string
  shape?: LoadShape
  /** Bulk rows per org; absent = no bulk volume. */
  volume?: VolumeSpec
  /** Re-index each bulk org's search documents at the end (default on with volume). */
  reindex?: boolean
  ttlHours?: number
  /** Every person's password, so a load script can sign in (refused in demo mode). */
  personaPassword?: string
  /** Orgs seeded at once. */
  concurrency?: number
  /** The one instant every timestamp is an offset from. Defaults to the moment of the call. */
  now?: Date
  log?: (msg: string) => void
}

export interface LoadOrgSeed {
  index: number
  slug: string
  orgId: string
  /** The founder persona: the person the bulk rows belong to and a load script signs in as. */
  adminEmail: string
  expiresAt: string
  /** The load-harness flag was written (the harness is on for this deployment). */
  loadHarness: boolean
  volume: VolumeResult | null
}

export interface SeedLoadResult {
  orgs: LoadOrgSeed[]
  failures: Array<{ slug: string; message: string }>
  complete: boolean
}

/** An error's message with its cause's (a failed query says why only in its cause). */
function errorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const cause = err.cause instanceof Error ? `: ${err.cause.message}` : ""
  return `${err.message}${cause}`
}

export function loadOrgSlug(prefix: string, index: number): string {
  return `${prefix}${index}`
}

/**
 * Turn a seeded visitor org into a load org: the synthetic marker with its
 * expiry (kept as it stands when the org already is one) and, with the
 * harness on, the load-org flag in the same statement.
 */
async function markLoadOrg(orgId: string, ttlHours: number, now: Date) {
  const existing = await loadDemoMarker(orgId)
  const marker =
    existing?.synthetic === true && existing.expiresAt
      ? existing
      : { ...visitorMarker(ttlHours, now), synthetic: true }
  const loadHarness = loadHarnessEnabled()
  await markOrgAsDemo(orgId, marker, { loadHarness })
  return { expiresAt: String(marker.expiresAt), loadHarness }
}

async function seedOneLoadOrg(
  index: number,
  opts: Required<Pick<SeedLoadOptions, "prefix" | "ttlHours">> & SeedLoadOptions & { now: Date },
): Promise<LoadOrgSeed> {
  const slug = loadOrgSlug(opts.prefix, index)
  const log = (msg: string) => opts.log?.(`${slug}: ${msg}`)
  const world: SeedDemoWorldResult = await seedDemoWorld({
    orgSlug: slug,
    orgName: `${DEMO_COMPANY_NAME} (load ${index})`,
    variant: "visitor",
    personaPassword: opts.personaPassword,
    // The warehouse part stays off on load orgs, whatever the deployment says.
    warehouse: false,
    baseTime: opts.now,
    log,
  })
  if (!world.complete) {
    throw new Error(world.failures.map((f) => `${f.layer}: ${f.message}`).join("; "))
  }
  const { expiresAt, loadHarness } = await markLoadOrg(world.orgId, opts.ttlHours, opts.now)
  const admin = world.org.people.find((p) => p.userId === world.org.adminUserId)
  if (!admin) throw new Error("the seeded world has no founder admin")
  const volume = opts.volume
    ? await seedVolume(seedContext({ orgId: world.orgId, now: opts.now, log }), {
        ownerId: admin.userId,
        spec: opts.volume,
        reindex: opts.reindex,
      })
    : null
  return {
    index,
    slug,
    orgId: world.orgId,
    adminEmail: admin.email,
    expiresAt,
    loadHarness,
    volume,
  }
}

/** Seed `orgs` load orgs. A failed org is recorded and the rest still run; `complete` says whether all landed. */
export function seedLoadOrgs(opts: SeedLoadOptions): Promise<SeedLoadResult> {
  return runAsSeed(async () => {
    const full = {
      ...opts,
      prefix: opts.prefix ?? "load-",
      ttlHours: opts.ttlHours ?? DEFAULT_LOAD_TTL_HOURS,
      now: opts.now ?? new Date(Date.now()),
    }
    const orgs: LoadOrgSeed[] = []
    const failures: SeedLoadResult["failures"] = []
    let next = 0
    const worker = async () => {
      while (next < opts.orgs) {
        const index = next++
        try {
          orgs.push(await seedOneLoadOrg(index, full))
          opts.log?.(`load org ${orgs.length}/${opts.orgs} ready`)
        } catch (err) {
          const message = errorText(err)
          failures.push({ slug: loadOrgSlug(full.prefix, index), message })
          opts.log?.(`${loadOrgSlug(full.prefix, index)}: FAILED: ${message}`)
        }
      }
    }
    const lanes = Math.max(1, Math.min(opts.concurrency ?? 1, opts.orgs))
    await Promise.all(Array.from({ length: lanes }, worker))
    orgs.sort((a, b) => a.index - b.index)
    return { orgs, failures, complete: failures.length === 0 }
  })
}

//   liaison seed --tier load --orgs N [--prefix load-] [--shape demo] [--volume]
//       [--threads N --contacts N --tickets N --projects N] [--no-reindex]
//       [--ttl-hours H] [--concurrency N] [--passwords-env VAR]
//
// Prints one line `[load-seed] result <json>` (slugs, org ids, admin
// addresses, expiry) for the script that drives the run. Exit 0 every org
// seeded in full, 1 an org failed, 2 usage.

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`)
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1]
  const inline = argv.find((a) => a.startsWith(`--${name}=`))
  return inline ? inline.slice(name.length + 3) : undefined
}

function positiveInt(value: string | undefined): number | null {
  if (value === undefined) return null
  const n = Number(value)
  return Number.isInteger(n) && n >= 0 ? n : Number.NaN
}

export async function runSeedLoadCli(
  argv: readonly string[],
  deps: { seed?: typeof seedLoadOrgs } = {},
): Promise<{ exitCode: 0 | 1 | 2; result?: SeedLoadResult }> {
  const usage = (msg: string) => {
    console.error(`[load-seed] ${msg}`)
    return { exitCode: 2 as const }
  }
  const orgs = positiveInt(flag(argv, "orgs"))
  if (orgs === null || !(orgs >= 1 && orgs <= 1000)) return usage("--orgs N (1..1000) is required")
  const shape = flag(argv, "shape") ?? "demo"
  if (!LOAD_SHAPES.includes(shape as LoadShape)) {
    return usage(`--shape ${shape}: the shapes are ${LOAD_SHAPES.join(", ")}`)
  }
  const ttlHours = Number(flag(argv, "ttl-hours") ?? DEFAULT_LOAD_TTL_HOURS)
  if (!(ttlHours > 0)) return usage("--ttl-hours must be a positive number")
  const concurrency = positiveInt(flag(argv, "concurrency")) ?? 1
  if (!(concurrency >= 1)) return usage("--concurrency must be a positive integer")
  let volume: VolumeSpec | undefined
  if (argv.includes("--volume")) {
    volume = { ...DEFAULT_VOLUME }
    for (const kind of Object.keys(DEFAULT_VOLUME) as Array<keyof VolumeSpec>) {
      const n = positiveInt(flag(argv, kind))
      if (Number.isNaN(n)) return usage(`--${kind} must be a non-negative integer`)
      if (n !== null) volume[kind] = n
    }
  }
  const envName = flag(argv, "passwords-env")
  const password = envName ? process.env[envName] : undefined
  if (envName && !password) return usage(`--passwords-env names ${envName}, which is not set`)

  const started = performance.now()
  const seed = deps.seed ?? seedLoadOrgs
  const result = await seed({
    orgs,
    prefix: flag(argv, "prefix") ?? "load-",
    shape: shape as LoadShape,
    volume,
    reindex: !argv.includes("--no-reindex"),
    ttlHours,
    concurrency,
    personaPassword: password,
    log: (msg) => console.log(`[load-seed] ${msg}`),
  })
  const seconds = ((performance.now() - started) / 1000).toFixed(1)
  console.log(
    `[load-seed] result ${JSON.stringify({
      orgs: result.orgs.map(({ volume: v, ...o }) => ({
        ...o,
        ...(v ? { volume: v.invariant.counts, volumeSeconds: Number(v.seconds.toFixed(1)) } : {}),
      })),
      failures: result.failures,
      seconds: Number(seconds),
    })}`,
  )
  if (!result.complete) {
    console.error(
      `[load-seed] FAILED: ${result.failures.length} of ${orgs} load org(s) did not seed`,
    )
    return { exitCode: 1, result }
  }
  console.log(`[load-seed] ${result.orgs.length} load org(s) seeded in full in ${seconds}s`)
  return { exitCode: 0, result }
}
