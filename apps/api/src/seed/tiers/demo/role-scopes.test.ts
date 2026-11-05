// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The seeded roles must already be what the kernel's own migrations make of
// them. Migration 0254 gave `kernel:products:read` / `:write` to every custom
// role holding the matching contacts scope; the seed lists did not follow, so a
// re-seed of a migrated demo box found five roles "changed on the server since
// the last apply" and the config pass refused (exit 3) without writing anything.
import { describe, expect, it } from "bun:test"
import type { DemoRole } from "~/seed/world/fiction"
import { QA_MEMBER_SCOPES } from "~/seed/world/qa"
import { demoScopesForRole } from "./role-scopes"

/** The scope pairs a migration backfills onto roles that hold the first one. */
const BACKFILLED_PAIRS: ReadonlyArray<readonly [have: string, add: string]> = [
  ["kernel:contacts:read", "kernel:products:read"],
  ["kernel:contacts:write", "kernel:products:write"],
]

const ROLES: readonly DemoRole[] = ["ops_lead", "support", "fulfillment", "finance", "sales"]

function missingBackfills(scopes: readonly string[]): string[] {
  return BACKFILLED_PAIRS.filter(
    ([have, add]) => scopes.includes(have) && !scopes.includes(add),
  ).map(([, add]) => add)
}

describe("seeded role scopes match the migrated server", () => {
  for (const role of ROLES) {
    it(`${role} holds every scope a migration backfills onto it`, () => {
      expect(missingBackfills(demoScopesForRole(role))).toEqual([])
    })
  }

  it("the QA teammate role holds every scope a migration backfills onto it", () => {
    expect(missingBackfills(QA_MEMBER_SCOPES)).toEqual([])
  })
})
