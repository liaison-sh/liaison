// SPDX-License-Identifier: FSL-1.1-ALv2

import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { app } from "~/app"
import {
  armOrgMaintenance,
  disarmOrgMaintenance,
  isOrgUnderMaintenance,
  OrgMaintenanceHeldError,
} from "~/middleware/org-maintenance"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"

describe("org-maintenance gate", () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
    delete process.env.ORG_MAINTENANCE_FLAG_PATH
  })

  function useTempFlagPath(): string {
    const d = mkdtempSync(join(tmpdir(), "liaison-org-maint-"))
    dirs.push(d)
    const path = join(d, "maintenance-orgs.json")
    process.env.ORG_MAINTENANCE_FLAG_PATH = path
    return path
  }

  /** A pid that ran on this host and has exited. */
  function deadPid(): number {
    const proc = Bun.spawnSync(["true"])
    return proc.pid
  }

  it("refuses to take over an org gated by another live process on this host", () => {
    const path = useTempFlagPath()
    writeFileSync(path, JSON.stringify([{ orgId: "org-1", pid: process.ppid, host: hostname() }]))

    expect(() => armOrgMaintenance("org-1")).toThrow(OrgMaintenanceHeldError)
    expect(isOrgUnderMaintenance("org-1")).toBe(true)
  })

  it("refuses an org gated by a process on another host, which it cannot check", () => {
    const path = useTempFlagPath()
    writeFileSync(path, JSON.stringify([{ orgId: "org-1", pid: 1, host: "some-other-host" }]))

    expect(() => armOrgMaintenance("org-1")).toThrow(OrgMaintenanceHeldError)
  })

  it("takes over an org whose owner process is gone, and the org stays gated", () => {
    const path = useTempFlagPath()
    const pid = deadPid()
    writeFileSync(path, JSON.stringify([{ orgId: "org-1", pid, host: hostname() }]))

    expect(armOrgMaintenance("org-1").recoveredFrom?.pid).toBe(pid)
    expect(isOrgUnderMaintenance("org-1")).toBe(true)
    disarmOrgMaintenance("org-1")
    expect(isOrgUnderMaintenance("org-1")).toBe(false)
  })

  it("takes over an ownerless entry written by an older build", () => {
    const path = useTempFlagPath()
    writeFileSync(path, JSON.stringify(["org-1"]))

    expect(armOrgMaintenance("org-1").recoveredFrom).toEqual({ orgId: "org-1" })
    expect(isOrgUnderMaintenance("org-1")).toBe(true)
  })

  it("disarm leaves an entry owned by another process in place", () => {
    const path = useTempFlagPath()
    writeFileSync(path, JSON.stringify([{ orgId: "org-1", pid: process.ppid, host: hostname() }]))

    disarmOrgMaintenance("org-1")
    expect(isOrgUnderMaintenance("org-1")).toBe(true)
  })

  it("reports an armed org as under maintenance", () => {
    useTempFlagPath()
    armOrgMaintenance("org-1")
    expect(isOrgUnderMaintenance("org-1")).toBe(true)
  })

  it("does not report an unarmed org as under maintenance", () => {
    useTempFlagPath()
    armOrgMaintenance("org-1")
    expect(isOrgUnderMaintenance("org-2")).toBe(false)
  })

  it("clears the org after disarm", () => {
    useTempFlagPath()
    armOrgMaintenance("org-1")
    disarmOrgMaintenance("org-1")
    expect(isOrgUnderMaintenance("org-1")).toBe(false)
  })

  // Route-level: the gate must actually sit in front of authenticated
  // traffic, not just the bare armOrgMaintenance/isOrgUnderMaintenance
  // helpers -- the middleware is mounted BEFORE authMiddleware resolves
  // `c.get("orgId")`, so a prior version of this check always read
  // `undefined` and never 503'd a single real request.
  it("503s an authenticated request for an armed org, through the real mounted app", async () => {
    useTempFlagPath()
    const session = await minimal.session((await createTestOrg()).id)
    armOrgMaintenance(session.orgId)

    try {
      const r = await app.request("/api/users/me", {
        headers: { Authorization: `Bearer ${session.bearer}` },
      })
      expect(r.status).toBe(503)
    } finally {
      disarmOrgMaintenance(session.orgId)
    }
  })

  it("still serves a 200 to an org that is not armed", async () => {
    useTempFlagPath()
    const armedOrg = await minimal.session((await createTestOrg()).id)
    const otherOrg = await minimal.session((await createTestOrg()).id)
    armOrgMaintenance(armedOrg.orgId)

    try {
      const r = await app.request("/api/users/me", {
        headers: { Authorization: `Bearer ${otherOrg.bearer}` },
      })
      expect(r.status).toBe(200)
    } finally {
      disarmOrgMaintenance(armedOrg.orgId)
    }
  })
})
