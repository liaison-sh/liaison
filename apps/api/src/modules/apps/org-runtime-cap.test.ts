// SPDX-License-Identifier: FSL-1.1-ALv2
// The org runtime cap (org-runtime-release.ts `enforceOrgRuntimeCap`): past
// LIAISON_ORG_RUNTIME_MAX_ORGS set-up orgs, the least recently touched ones
// with no live work in the process are released, and the others stay.
import { afterEach, describe, expect, it } from "bun:test"
import {
  holdOrgRuntime,
  initializedOrgRuntimes,
  orgRuntimeHolds,
  orgRuntimeInitPromises,
  orgRuntimeLastTouch,
  registeredApps,
} from "~/modules/apps/app-registries"
import { enforceOrgRuntimeCap, orgRuntimesOverCap } from "~/modules/apps/org-runtime-release"
import { beginOrgActivity, orgTransferView } from "~/modules/org/transfer-state/state"

const made: string[] = []
const realPeek = orgTransferView.peek.bind(orgTransferView)

/** Set up `n` fake orgs, touched in order (the first is the least recent). */
function setUpOrgs(n: number): string[] {
  const base = Date.now() - 1_000_000
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const orgId = crypto.randomUUID()
    initializedOrgRuntimes.add(orgId)
    registeredApps.add(`${orgId}:probe`)
    orgRuntimeLastTouch.set(orgId, base + i * 1_000)
    ids.push(orgId)
    made.push(orgId)
  }
  return ids
}

/** The cap that leaves `keep` of this file's orgs set up, whatever else this process holds. */
function capKeeping(keep: number, ours: string[]): number {
  return initializedOrgRuntimes.size - ours.length + keep
}

/** Only this file's orgs are candidates: others in the process count as held. */
const onlyOurs = (ours: string[]) => (orgId: string) => !ours.includes(orgId)

afterEach(() => {
  orgTransferView.peek = realPeek
  for (const orgId of made.splice(0)) {
    initializedOrgRuntimes.delete(orgId)
    registeredApps.delete(`${orgId}:probe`)
    orgRuntimeLastTouch.delete(orgId)
    orgRuntimeHolds.delete(orgId)
    orgRuntimeInitPromises.delete(orgId)
  }
})

describe("org runtime cap", () => {
  it("is a no-op at or under the cap, and with no cap", () => {
    const ours = setUpOrgs(3)
    expect(orgRuntimesOverCap(capKeeping(3, ours), onlyOurs(ours))).toEqual([])
    expect(orgRuntimesOverCap(0, onlyOurs(ours))).toEqual([])
  })

  it("picks the least recently touched orgs, as many as the excess", () => {
    const ours = setUpOrgs(5)
    expect(orgRuntimesOverCap(capKeeping(3, ours), onlyOurs(ours))).toEqual([ours[0], ours[1]])
  })

  it("follows recency: a touch moves an org to the back", () => {
    const ours = setUpOrgs(3)
    orgRuntimeLastTouch.set(ours[0], Date.now())
    expect(orgRuntimesOverCap(capKeeping(2, ours), onlyOurs(ours))).toEqual([ours[1]])
  })

  it("never picks an org held by a request or socket, being set up, with live work, or moving", () => {
    // A seventh, most recent, keeps the cap above 0 in a process holding no other org.
    const ours = setUpOrgs(7)
    const unhold = holdOrgRuntime(ours[0])
    orgRuntimeInitPromises.set(ours[1], Promise.resolve())
    const endJob = beginOrgActivity(ours[2], "jobs")
    const endTurn = beginOrgActivity(ours[3], "turns")
    orgTransferView.peek = (orgId) =>
      orgId === ours[4] ? { orgId, state: "draining", transferId: "t", at: Date.now() } : null
    try {
      // Default `isHeld`: the process's own holds and transfer accounting.
      const over = orgRuntimesOverCap(initializedOrgRuntimes.size - 6)
      expect(over).not.toContain(ours[0])
      expect(over).not.toContain(ours[1])
      expect(over).not.toContain(ours[2])
      expect(over).not.toContain(ours[3])
      expect(over).not.toContain(ours[4])
      expect(over).toContain(ours[5])
    } finally {
      unhold()
      endJob()
      endTurn()
    }
    expect(orgRuntimeHolds.has(ours[0])).toBe(false)
  })

  it("releases the orgs past the cap and leaves the held one even when it is the oldest", async () => {
    const ours = setUpOrgs(4)
    const unhold = holdOrgRuntime(ours[0])
    try {
      const released = await enforceOrgRuntimeCap(capKeeping(2, ours))
      expect(released).toContain(ours[1])
      expect(released).toContain(ours[2])
      expect(released).not.toContain(ours[0])
      expect(initializedOrgRuntimes.has(ours[0])).toBe(true)
      expect(initializedOrgRuntimes.has(ours[3])).toBe(true)
      expect(initializedOrgRuntimes.has(ours[1])).toBe(false)
      expect(registeredApps.has(`${ours[1]}:probe`)).toBe(false)
      expect(orgRuntimeLastTouch.has(ours[1])).toBe(false)
    } finally {
      unhold()
    }
  })

  it("a hold counts each holder until it ends, once", () => {
    const [orgId] = setUpOrgs(1)
    const a = holdOrgRuntime(orgId)
    const b = holdOrgRuntime(orgId)
    a()
    a()
    expect(orgRuntimeHolds.get(orgId)).toBe(1)
    b()
    expect(orgRuntimeHolds.has(orgId)).toBe(false)
  })
})
