// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { type RlsClient, sql } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { entityRegistry } from "~/modules/apps/app-registries"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { resolveReferenceDisplay } from "./reference-display"

const rlsDb = db as unknown as RlsClient

describe("resolveReferenceDisplay — registry-driven app entity labels", () => {
  let orgId: string

  beforeAll(async () => {
    await acquireTestLock()
    const [org] = await sql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'RefDisplay Org', ${`refdisp-${Date.now()}`})
      RETURNING id`
    orgId = org.id
  })

  afterEach(() => {
    entityRegistry.delete([orgId, "tickets", "ticket"])
  })

  afterAll(async () => {
    // releaseTestLock() MUST run even if cleanup DML throws — otherwise the
    // cross-file test lock leaks and every subsequent lock-using suite hangs in
    // beforeEach until its 5000ms timeout (a full-suite cascade).
    try {
      await sql`DELETE FROM app_tickets.tickets WHERE org_id = ${orgId}`
      await sql`DELETE FROM kernel.organizations WHERE id = ${orgId}`
    } finally {
      await releaseTestLock()
    }
  })

  test("resolves a ticket label from the entity registry (labelField + handle), not hardcoded SQL", async () => {
    // The kernel must read the app's declared labelField — here `subject`, the
    // real tickets column — rather than branching on the app name and guessing
    // a `title` column.
    entityRegistry.set([orgId, "tickets", "ticket"], {
      labelField: "subject",
      handlePrefix: "ticket",
      tableName: "tickets",
      indexFields: { title: "subject", handle: "handle" },
    })

    const [ticket] = await sql`
      INSERT INTO app_tickets.tickets
        (id, org_id, subject, handle, channel, reply_token, sla_deadline, sla_target_seconds)
      VALUES (gen_random_uuid(), ${orgId}, 'Refund request', 'ticket-77', 'manual',
              ${`rt-${Date.now()}`}, now() + interval '1 day', 86400)
      RETURNING id`

    const display = await resolveReferenceDisplay(rlsDb, {
      orgId,
      app: "tickets",
      entityType: "ticket",
      entityId: ticket.id,
    })

    expect(display.label).toBe("Refund request")
    expect(display.tabType).toBe("tickets:ticket")
    expect(display.snippet).toContain("#ticket-77")
    expect(display.snippet).toContain("Refund request")
  })

  test("falls back to a short id when an unregistered app entity has no label source", async () => {
    const display = await resolveReferenceDisplay(rlsDb, {
      orgId,
      app: "unregistered",
      entityType: "widget",
      entityId: "abcdef12-0000-0000-0000-000000000000",
    })
    // No registry entry → no per-app SQL → generic id fallback.
    expect(display.label).toContain("#abcdef12")
    expect(display.tabType).toBe("unregistered:widget")
  })
})
