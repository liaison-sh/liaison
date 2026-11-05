// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The org setup stamp: a hash of everything an org's persistent app setup
 * depends on (the build and every app at its version), stored on `kernel.organizations.app_setup_stamp` once every app registered.
 * A registration whose computed stamp matches the stored one, with no app in
 * error and every `kernel.apps` row at its version, skips the org's row writes.
 *
 * Persistent setup writes of one org are serialized across processes by the
 * org's `org-setup` advisory xact lock. A caller that found a mismatch takes
 * the lock with `withOrgSetupLock`, re-reads the state with the lock's
 * transaction (`readOrgSetupState(orgId, apps, tx)`) and skips the writes when
 * another process already stamped the org meanwhile (double-checked).
 *
 * The lock is per org: everything it guards (the org's stamp, its `kernel.apps`
 * rows, settings defaults and manifest roles) belongs to that org alone. A
 * cell-wide lock made every org's setup wait on every other's, so after an
 * upgrade (a new build id stales every stamp) the new processes set up the
 * live orgs one at a time and visitors' first requests queued past the edge
 * timeout. Schema DDL on the tables every org shares keeps its own cell-wide
 * `app-ddl` lock (runtime.ts).
 */
import { createHash, randomUUID } from "node:crypto"
import { and, sql as drizzleSql, eq } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { apps as appsTable } from "~/db/schema/kernel/apps"
import { organizations } from "~/db/schema/kernel/organizations"
import { env } from "~/lib/env"

/** Test seam, like `appSchemaDdlReuse`: off, no stamp ever matches. Never disabled globally. */
export const orgSetupStamp = { enabled: true }

/** FNV-1a 32-bit, the same mapping `runtime.ts` uses for its advisory lock ids. */
function fnv1a32(str: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 1
}

/**
 * The class key of the per-org `org-setup` advisory lock (two-key form: this
 * class, then a hash of the org id). Lock order: `app-ddl` → `org-setup`.
 */
export const ORG_SETUP_LOCK = fnv1a32("org-setup")

/** `SELECT pg_advisory_xact_lock(...)` for the org's `org-setup` lock. */
export function orgSetupLockSql(orgId: string) {
  return drizzleSql`SELECT pg_advisory_xact_lock(${ORG_SETUP_LOCK}::int, hashtext(${orgId}))`
}

const PROCESS_NONCE = randomUUID()

/**
 * The build component of the stamp: `LIAISON_VERSION`. When it is `"dev"` (no
 * build id passed), a per-process nonce, so each process start re-runs setup
 * once per org, as before the stamp existed; under `NODE_ENV=test` the plain
 * `"dev"` constant.
 */
export function setupBuildId(e: { LIAISON_VERSION: string; NODE_ENV: string } = env): string {
  if (e.LIAISON_VERSION !== "dev") return e.LIAISON_VERSION
  if (e.NODE_ENV === "test") return "dev"
  return `dev+${PROCESS_NONCE}`
}

export interface SetupApp {
  name: string
  version: string
}

/**
 * sha256 over the build id and the apps sorted by name. The Google login
 * provider is not in it: `setUpOrg` reconciles that on every first touch.
 */
export function computeSetupStamp(i: { buildId: string; apps: ReadonlyArray<SetupApp> }): string {
  const apps = [...i.apps]
    .map((a) => [a.name, a.version] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
  return createHash("sha256")
    .update(JSON.stringify([i.buildId, apps]))
    .digest("hex")
}

export interface OrgSetupState {
  /** The stored stamp, null when the org was never stamped. */
  stored: string | null
  /** Names of the org's apps in `status = 'error'`, sorted. */
  erroredApps: string[]
  /** Every expected app has its `kernel.apps` row at the expected version. */
  rowsCurrent: boolean
}

async function readState(
  db: PrivilegedDb,
  orgId: string,
  apps: ReadonlyArray<SetupApp>,
): Promise<OrgSetupState> {
  const [org] = await db
    .select({ stamp: organizations.appSetupStamp })
    .from(organizations)
    .where(eq(organizations.id, orgId))
  const rows = await db
    .select({ name: appsTable.name, version: appsTable.version, status: appsTable.status })
    .from(appsTable)
    .where(eq(appsTable.orgId, orgId))
  const versions = new Map(rows.map((r) => [r.name, r.version]))
  return {
    stored: org?.stamp ?? null,
    erroredApps: rows
      .filter((r) => r.status === "error")
      .map((r) => r.name)
      .sort(),
    rowsCurrent: apps.every((a) => versions.get(a.name) === a.version),
  }
}

/**
 * The org's stored stamp, app error flags and row currency. With `tx` (a
 * transaction holding the `org-setup` lock, from `withOrgSetupLock`) it reads
 * there, for the double-checked re-read; otherwise in its own system read.
 */
export async function readOrgSetupState(
  orgId: string,
  apps: ReadonlyArray<SetupApp>,
  tx?: PrivilegedDb,
): Promise<OrgSetupState> {
  if (tx) return readState(tx, orgId, apps)
  return withSystemDb("org-setup-stamp-read", (db) => readState(db, orgId, apps))
}

/** True when the org's persistent setup is current for `expected` and may be skipped. */
export function stampMatches(expected: string, s: OrgSetupState): boolean {
  return (
    orgSetupStamp.enabled && s.stored === expected && s.erroredApps.length === 0 && s.rowsCurrent
  )
}

async function takeOrgSetupLock(db: PrivilegedDb, orgId: string): Promise<void> {
  await db.execute(orgSetupLockSql(orgId))
}

/** Run `fn` in a system transaction that holds the org's `org-setup` advisory xact lock. */
export async function withOrgSetupLock<T>(
  reason: string,
  orgId: string,
  fn: (tx: PrivilegedDb) => Promise<T>,
): Promise<T> {
  return withSystemDb(reason, async (tx) => {
    await takeOrgSetupLock(tx, orgId)
    return fn(tx)
  })
}

async function writeStamp(db: PrivilegedDb, orgId: string, stamp: string): Promise<void> {
  await takeOrgSetupLock(db, orgId)
  await db
    .update(organizations)
    .set({ appSetupStamp: stamp })
    .where(
      and(
        eq(organizations.id, orgId),
        drizzleSql`${organizations.appSetupStamp} IS DISTINCT FROM ${stamp}`,
      ),
    )
}

/**
 * Store the org's stamp under its `org-setup` lock; writes nothing when it is
 * already there. With `tx` it writes in that transaction (the lock is
 * re-entrant within it).
 */
export async function writeOrgSetupStamp(
  orgId: string,
  stamp: string,
  tx?: PrivilegedDb,
): Promise<void> {
  if (tx) return writeStamp(tx, orgId, stamp)
  await withSystemDb("org-setup-stamp-write", (db) => writeStamp(db, orgId, stamp))
}
