// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test"
import {
  type LinkIngestJobDeps,
  type LinkIngestJobPayload,
  processLinkIngestJob,
} from "~/apps/tickets/link-ingest-job"
import { sql } from "~/db"

const ORG = "00000000-0000-4000-8000-0000000d0001"
const TICKET = "00000000-0000-4000-8000-0000000d0010"
const MSG = "00000000-0000-4000-8000-0000000d0011"

async function seedTicketAndMessage(): Promise<void> {
  await sql`INSERT INTO app_tickets.tickets
    (id, org_id, handle, subject, channel, reply_token, sla_target_seconds, sla_deadline)
    VALUES (${TICKET}, ${ORG}, 'TCK-1', 'Broken device', 'email', 'rt_abc', 3600, now() + interval '1 hour')
    ON CONFLICT (id) DO NOTHING`
  await sql`INSERT INTO app_tickets.messages
    (id, org_id, ticket_id, kind, sent_at)
    VALUES (${MSG}, ${ORG}, ${TICKET}, 'inbound', now())
    ON CONFLICT (id) DO NOTHING`
}

function payload(url = "https://swisstransfer.com/d/abc"): LinkIngestJobPayload {
  return { messageId: MSG, orgId: ORG, app: "tickets", entityId: MSG, url }
}

describe("processLinkIngestJob", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug, settings)
      VALUES (${ORG}, 'LinkOrg', ${`link-${ORG}`}, '{}') ON CONFLICT (id) DO UPDATE SET settings = '{}'`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.files WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_tickets.messages WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_tickets.tickets WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  beforeEach(async () => {
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.files WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_tickets.messages WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_tickets.tickets WHERE org_id = ${ORG}`
    await seedTicketAndMessage()
  })

  it("materializes a kernel.files row + queues kernel:file:create via the outbox, no analysis", async () => {
    // Spy the analysis-enqueue surface — the real "no analysis enqueued"
    // invariant is "this BullMQ enqueue is NEVER called with 'files-media-analysis'".
    const enqueueSpy = mock(async () => {})
    const deps: LinkIngestJobDeps = {
      resolverRegistry: {
        "swisstransfer.com": mock(async () => [
          { downloadUrl: "https://swisstransfer.com/dl/1", filename: "photo.jpg" },
        ]),
      } as unknown as LinkIngestJobDeps["resolverRegistry"],
      downloadVerifiedMedia: mock(async () => ({
        bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
        mimeFromMagic: "image/jpeg",
      })) as unknown as LinkIngestJobDeps["downloadVerifiedMedia"],
      putObject: mock(async () => {}),
      enqueueAppJob: enqueueSpy as unknown as LinkIngestJobDeps["enqueueAppJob"],
    }
    await processLinkIngestJob(payload(), deps)

    const files = await sql`SELECT id, app, entity_type, entity_id, mime_type, storage_key
      FROM kernel.files WHERE org_id = ${ORG} AND entity_id = ${MSG}`
    expect(files.length).toBe(1)
    expect(files[0].app).toBe("tickets")
    expect(files[0].entity_type).toBe("message")
    expect(files[0].mime_type).toBe("image/jpeg")
    const newFileId = files[0].id as string

    // The transactional-outbox proof: a pending_events row for kernel/file/create.
    const events = await sql`SELECT payload FROM kernel.pending_events
      WHERE org_id = ${ORG}
        AND payload->>'app' = 'kernel'
        AND payload->>'entity' = 'file'
        AND payload->>'action' = 'create'
        AND payload->>'entityId' = ${newFileId}`
    expect(events.length).toBe(1)
    // The emitted event's `data` payload carries the fields thumbnailing consumes.
    const data = (events[0].payload as { data?: Record<string, unknown> }).data ?? {}
    expect(data.storageKey).toBe(files[0].storage_key)
    expect(data.mimeType).toBe("image/jpeg")
    expect(data.app).toBe("tickets")
    expect(data.entityType).toBe("message")

    // The analysis queue is NEVER touched (analysis is agent-driven, gated at C1).
    expect(enqueueSpy).not.toHaveBeenCalled()
  })

  it("un-fetchable link → no kernel.files row + a tickets_get-visible note with the link + reason", async () => {
    const deps: LinkIngestJobDeps = {
      resolverRegistry: {
        "swisstransfer.com": mock(async () => []),
      } as unknown as LinkIngestJobDeps["resolverRegistry"],
      downloadVerifiedMedia: mock(async () => ({
        error: "should not be called",
      })) as unknown as LinkIngestJobDeps["downloadVerifiedMedia"],
      putObject: mock(async () => {}),
    }
    const url = "https://swisstransfer.com/d/missing"
    await processLinkIngestJob(payload(url), deps)

    const files =
      await sql`SELECT id FROM kernel.files WHERE org_id = ${ORG} AND entity_id = ${MSG}`
    expect(files.length).toBe(0)

    // The note is a `note` message on the same ticket — the surface tickets_get reads.
    const notes = await sql`SELECT text_body FROM app_tickets.messages
      WHERE org_id = ${ORG} AND ticket_id = ${TICKET} AND kind = 'note'`
    expect(notes.length).toBe(1)
    expect(String(notes[0].text_body)).toContain(url)
  })

  it("download reject → no kernel.files row + a note carrying the link + reason", async () => {
    const deps: LinkIngestJobDeps = {
      resolverRegistry: {
        "swisstransfer.com": mock(async () => [{ downloadUrl: "https://swisstransfer.com/dl/x" }]),
      } as unknown as LinkIngestJobDeps["resolverRegistry"],
      downloadVerifiedMedia: mock(async () => ({
        error: "magic-byte mismatch",
      })) as unknown as LinkIngestJobDeps["downloadVerifiedMedia"],
      putObject: mock(async () => {}),
    }
    const url = "https://swisstransfer.com/d/bad"
    await processLinkIngestJob(payload(url), deps)
    const files =
      await sql`SELECT id FROM kernel.files WHERE org_id = ${ORG} AND entity_id = ${MSG}`
    expect(files.length).toBe(0)
    const notes = await sql`SELECT text_body FROM app_tickets.messages
      WHERE org_id = ${ORG} AND ticket_id = ${TICKET} AND kind = 'note'`
    expect(notes.length).toBe(1)
    expect(String(notes[0].text_body)).toContain(url)
    expect(String(notes[0].text_body)).toContain("magic-byte mismatch")
  })
})
