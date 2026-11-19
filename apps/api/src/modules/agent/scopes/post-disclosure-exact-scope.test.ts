// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A post stamped with an exact-only scope reaches only the people holding it exactly: `*` does
// not hold it (row security checks it with its exact grant), so a person holding only `*` is a
// gap in the post's audience, and an exact holder is not.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { decidePostDisclosure } from "~/modules/agent/scopes/post-disclosure"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const MARGIN = "projects:margin:read"

describe("post audience on an exact-only stamp", () => {
  let orgId: string
  let requester: string
  let starOnly: string
  let exactHolder: string

  beforeAll(async () => {
    await acquireTestLock()
    const org = await createTestOrg()
    orgId = org.id
    requester = (await minimal.session(orgId, { role: "admin" })).userId
    starOnly = (await minimal.session(orgId, { role: "admin" })).userId
    exactHolder = (await minimal.session(orgId, { role: "member" })).userId
    for (const userId of [requester, exactHolder]) {
      await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
        VALUES (${userId}, ${orgId}, ${MARGIN})`
    }
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  it("a person holding only `*` lacks the stamp, so nothing posts to them", async () => {
    const decision = await decidePostDisclosure({
      orgId,
      requesterUserId: requester,
      stamp: [MARGIN],
      target: { participantIds: [starOnly], newThread: true },
    })
    expect(decision.kind).toBe("gap")
    if (decision.kind === "gap") expect(decision.missingScopes).toEqual([MARGIN])
  })

  it("an exact holder is in the audience", async () => {
    const decision = await decidePostDisclosure({
      orgId,
      requesterUserId: requester,
      stamp: [MARGIN],
      target: { participantIds: [exactHolder], newThread: true },
    })
    expect(decision.kind).toBe("clear")
  })

  it("a requester holding only `*` may not disclose it", async () => {
    const decision = await decidePostDisclosure({
      orgId,
      requesterUserId: starOnly,
      stamp: [MARGIN],
      target: { participantIds: [exactHolder], newThread: true },
    })
    expect(decision.kind).toBe("requester_lacks")
  })
})
