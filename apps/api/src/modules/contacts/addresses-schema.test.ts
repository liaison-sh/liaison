// SPDX-License-Identifier: FSL-1.1-ALv2
//
// kernel.contact_addresses (migration 0253) under the caller's own RLS: an
// address is visible exactly when its contact is, so a restricted contact's
// addresses never show to someone who cannot see the contact; and a contact
// merge carries the source's addresses onto the survivor instead of letting
// the delete cascade them away.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { eq } from "drizzle-orm"
import type { UserContext } from "~/db/rls"
import { contactAddresses } from "~/db/schema/kernel"
import { mergeContacts } from "~/modules/contacts/service"
import { seedContext } from "~/seed/context"
import { actorFor, asUser } from "~/seed/factories/people/actors"
import { resolveContacts } from "~/seed/factories/people/contacts"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let owner: UserContext
let other: UserContext
let privateContact = ""
let orgContact = ""
let orgContact2 = ""

beforeAll(async () => {
  await acquireTestLock()
  const { id: orgId } = await createTestOrg()
  const ctx = seedContext({ orgId, now: new Date() })
  owner = await actorFor(ctx, (await minimal.person(orgId, { name: "Owner" })).id)
  other = await actorFor(ctx, (await minimal.person(orgId, { name: "Other" })).id)
  // A private contact of the owner, and two the whole organisation edits.
  const [mine] = await resolveContacts(
    ctx,
    owner,
    [{ key: "private", email: "rosa@private.test", name: "Rosa Private" }],
    "owner",
  )
  privateContact = mine?.[1].id ?? ""
  orgContact = await minimal.contact(orgId, "hugo@org.test", { name: "Hugo Org" })
  orgContact2 = await minimal.contact(orgId, "hugo2@org.test", { name: "Hugo Duplicate" })
}, 120_000)

afterAll(async () => {
  await releaseTestLock()
})

describe("contact addresses: RLS follows the contact", () => {
  it("a restricted contact's addresses are invisible to a non-owner, visible to the owner", async () => {
    await asUser(owner, (db) =>
      db.insert(contactAddresses).values([
        { orgId: owner.orgId, contactId: privateContact, street1: "1 Quiet Lane", city: "Lyon" },
        { orgId: owner.orgId, contactId: orgContact, street1: "2 Open Street", city: "Lille" },
      ]),
    )
    const cities = (actor: UserContext) =>
      asUser(actor, async (db) =>
        (await db.select({ city: contactAddresses.city }).from(contactAddresses))
          .map((r) => r.city)
          .sort(),
      )
    expect(await cities(owner)).toEqual(["Lille", "Lyon"])
    expect(await cities(other)).toEqual(["Lille"])

    // Nor can the non-owner write one onto the restricted contact.
    let refused = false
    try {
      await asUser(other, (db) =>
        db
          .insert(contactAddresses)
          .values({ orgId: other.orgId, contactId: privateContact, street1: "3 Side Road" }),
      )
    } catch {
      refused = true
    }
    expect(refused).toBe(true)
  })
})

describe("contact addresses: merge", () => {
  it("a merge moves the source's addresses onto the survivor", async () => {
    await asUser(owner, (db) =>
      db.insert(contactAddresses).values([
        { orgId: owner.orgId, contactId: orgContact2, street1: "9 Dock Road", city: "Nantes" },
        { orgId: owner.orgId, contactId: orgContact, street1: "4 Main Square", city: "Rennes" },
      ]),
    )
    await asUser(owner, (db) =>
      mergeContacts(db, {
        orgId: owner.orgId,
        userId: owner.userId,
        sourceId: orgContact2,
        targetId: orgContact,
      }),
    )
    const rows = await asUser(owner, (db) =>
      db
        .select({ city: contactAddresses.city })
        .from(contactAddresses)
        .where(eq(contactAddresses.contactId, orgContact)),
    )
    expect(rows.map((r) => r.city).sort()).toEqual(["Lille", "Nantes", "Rennes"])
  })
})
