// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Per-org maintenance gate. Mirrors maintenance.ts's file-flag shape, but
// keyed by org id instead of being whole-app: the migration script arms an
// org before touching its rows and disarms it after, so the API serves no
// request for that org between migration steps while every other org keeps
// running normally.
//
// Each entry names the process that armed it (pid and host). An entry whose
// owner is gone still gates: a run that died part way may have left the org
// half re-keyed, which A16 says no request may read. It is stale, though: the
// next run for that org takes it over instead of being refused, and finishes
// or rolls back what the dead run left. A live owner's entry is never taken
// over, and a process only ever disarms its own entry.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { hostname } from "node:os"
import { dirname } from "node:path"

// Production path is hardcoded, mirroring maintenance.ts's PROD_FLAG_PATH.
// Tests override via ORG_MAINTENANCE_FLAG_PATH, mirroring the existing
// MAINTENANCE_FLAG_PATH override convention.
const PROD_ORG_FLAG_PATH = "/var/lib/liaison/maintenance-orgs.json"

function orgFlagPath(): string {
  return process.env.ORG_MAINTENANCE_FLAG_PATH || PROD_ORG_FLAG_PATH
}

/** One armed org. An entry written by an older build is a bare org id and has no owner. */
export interface OrgGateEntry {
  orgId: string
  pid?: number
  host?: string
  armedAt?: string
}

function readEntries(path: string): OrgGateEntry[] {
  try {
    if (!existsSync(path)) return []
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((value): OrgGateEntry[] => {
      if (typeof value === "string") return [{ orgId: value }]
      if (typeof value !== "object" || value === null) return []
      const entry = value as Record<string, unknown>
      if (typeof entry.orgId !== "string") return []
      return [
        {
          orgId: entry.orgId,
          pid: typeof entry.pid === "number" ? entry.pid : undefined,
          host: typeof entry.host === "string" ? entry.host : undefined,
          armedAt: typeof entry.armedAt === "string" ? entry.armedAt : undefined,
        },
      ]
    })
  } catch {
    // A missing, empty, or corrupt file means no org is under maintenance;
    // don't block traffic on a transient read failure.
    return []
  }
}

function writeEntries(path: string, entries: OrgGateEntry[]): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(entries))
}

/** Is this org currently under a migration-arm maintenance gate? */
export function isOrgUnderMaintenance(orgId: string): boolean {
  return readEntries(orgFlagPath()).some((entry) => entry.orgId === orgId)
}

function isOwnedByThisProcess(entry: OrgGateEntry): boolean {
  return entry.pid === process.pid && entry.host === hostname()
}

/** Whether `pid` still runs on this host. EPERM means it runs under another user. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * A gate whose owner can no longer finish or undo its run: no owner recorded,
 * or an owner pid no longer running on this host. An owner on another host
 * cannot be checked from here, so its entry is never stale.
 */
function isStale(entry: OrgGateEntry): boolean {
  if (entry.pid === undefined) return true
  return entry.host === hostname() && !isRunning(entry.pid)
}

/** Thrown by armOrgMaintenance when a live process already holds the org's gate. */
export class OrgMaintenanceHeldError extends Error {
  code = "org_maintenance_held"
  constructor(
    public readonly orgId: string,
    public readonly holder: OrgGateEntry,
  ) {
    super(
      `org ${orgId} is already gated by pid ${holder.pid} on ${holder.host ?? "an unknown host"}, which is still running or cannot be checked from this host; wait for that run to finish`,
    )
    this.name = "OrgMaintenanceHeldError"
  }
}

/**
 * Arm the gate for an org, owned by this process. Re-arming an org this
 * process already holds is a no-op. A stale entry (see `isStale`) is taken
 * over and returned as `recoveredFrom`; a live one throws
 * OrgMaintenanceHeldError and is left as it was.
 */
export function armOrgMaintenance(orgId: string): { recoveredFrom?: OrgGateEntry } {
  const path = orgFlagPath()
  const entries = readEntries(path)
  const existing = entries.find((entry) => entry.orgId === orgId)
  if (existing && isOwnedByThisProcess(existing)) return {}
  if (existing && !isStale(existing)) throw new OrgMaintenanceHeldError(orgId, existing)

  const mine: OrgGateEntry = {
    orgId,
    pid: process.pid,
    host: hostname(),
    armedAt: new Date().toISOString(),
  }
  writeEntries(path, [...entries.filter((entry) => entry.orgId !== orgId), mine])
  return existing ? { recoveredFrom: existing } : {}
}

/**
 * Disarm the gate for an org, if this process holds it. Another process's
 * entry, live or stale, is left for its owner or for the next run to take
 * over.
 */
export function disarmOrgMaintenance(orgId: string): void {
  const path = orgFlagPath()
  const entries = readEntries(path)
  const remaining = entries.filter(
    (entry) => !(entry.orgId === orgId && isOwnedByThisProcess(entry)),
  )
  if (remaining.length !== entries.length) writeEntries(path, remaining)
}
