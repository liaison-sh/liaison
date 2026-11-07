// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4c-T48: the fourth leg. Search over the transcript is hybrid — the keyword
// legs fused by reciprocal rank with an embedding leg, RANKING ONLY, never
// visibility.
//
// The embedder is a deterministic fake injected through the provider seam, so
// nothing here reaches the network and a reworded query is a reworded query in
// the same way on every machine.
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { MeiliSearch } from "meilisearch"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import * as searchClientModule from "~/infra/search/client"
import { searchLogger } from "~/lib/logger"
import { memorySearch, parseTimeWindow } from "~/modules/agent/memory/memory-search"
import { ExternalSearchHandlersTestAccess } from "~/modules/search/external-handlers"
import {
  type Embedder,
  isWindowAnchor,
  MessageIndexerTestAccess,
  processMessageIndexerJob,
} from "~/modules/search/message-indexer"

const ORG_ID = crypto.randomUUID()
const NO_KEY_ORG_ID = crypto.randomUUID()
const USER_A = crypto.randomUUID()
const NO_KEY_USER = crypto.randomUUID()
const THREAD_ID = crypto.randomUUID()
const NO_KEY_THREAD = crypto.randomUUID()
const tag = ORG_ID.slice(0, 8)

const THREADS_READ = "kernel:threads:read"
const DEALS = "crm:deals:read"
const INDEX_NAME = `test_p4ct48_${crypto.randomUUID().slice(0, 8)}`

const meili = new MeiliSearch({
  host: process.env.MEILISEARCH_HOST || "http://localhost:7700",
  apiKey: process.env.MEILISEARCH_API_KEY || "dev-master-key",
})

function realClient() {
  return meili as unknown as ReturnType<typeof searchClientModule.getMeili>
}

/* -------------------------------------------------------------------------- */
/* The deterministic fake embedder                                            */
/* -------------------------------------------------------------------------- */

/**
 * Three concepts, three dimensions. Two texts that talk about the same thing in
 * different WORDS land on the same vector; the keyword legs, which only see the
 * words, agree on nothing at all. The third dimension is what a text about
 * neither concept lands on, so no document ever carries a zero vector.
 */
const CONCEPTS: string[][] = [
  ["dhl", "courier", "carrier", "parcel", "parcels", "shipping", "shipment"],
  ["account", "customer", "code", "identifier", "number", "reference"],
  ["warranty", "guarantee", "refund", "claim", "claims"],
]
const DIMENSIONS = CONCEPTS.length + 1

function fakeVector(text: string): number[] {
  const words = new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
  const v = CONCEPTS.map((syns) => (syns.some((s) => words.has(s)) ? 1 : 0))
  // The "about none of these" axis, so no document ever carries a zero vector.
  v.push(v.every((x) => x === 0) ? 1 : 0)
  return v
}

let embedCalls = 0

const fakeEmbedder: Embedder = {
  modelId: "fake-embedding-001",
  dimensions: DIMENSIONS,
  async embed(texts: string[]) {
    embedCalls += texts.length
    return { vectors: texts.map(fakeVector), tokens: texts.length * 4 }
  },
}

const spies: Array<{ mockRestore: () => void }> = []

const actorA: UserContext = {
  actorType: "user",
  userId: USER_A,
  orgId: ORG_ID,
  scopes: ["*"],
  dimensionGrants: {},
}
const actorNoKey: UserContext = {
  actorType: "user",
  userId: NO_KEY_USER,
  orgId: NO_KEY_ORG_ID,
  scopes: ["*"],
  dimensionGrants: {},
}

/** One search, under RLS, with the TURN's grants (never the actor's). */
function search(
  params: { query: string; limit?: number },
  scopes: string[] = [],
  actor: UserContext = actorA,
) {
  return withRlsContext(actor, (tx) =>
    memorySearch(params, {
      userId: actor.userId,
      orgId: actor.orgId,
      db: tx,
      scopes,
    } as never),
  )
}

/**
 * A message id that never anchors a sliding window. An anchor's window quotes
 * the messages before it, and a window hit is reported as its anchor, so a
 * reworded message that happened to anchor one (one id in four) would carry
 * its neighbours' words ("our", "is") into the keyword legs. The claim below
 * is about the message's OWN words, so its id is drawn until it anchors none.
 */
function nonAnchorId(): string {
  for (;;) {
    const id = crypto.randomUUID()
    if (!isWindowAnchor(id)) return id
  }
}

/** The ids of the messages in the corpus, so assertions can name them. */
const REWORDED_ID = nonAnchorId()
const NOISE_ID = crypto.randomUUID()
const STALE_ID = crypto.randomUUID()
const IN_WEEK_ID = crypto.randomUUID()
const OUT_OF_WEEK_ID = crypto.randomUUID()

/** ISO week 12 of 2026: Monday 16 March to Sunday 22 March. */
const IN_WEEK_AT = "2026-03-18T10:00:00Z"
const OUT_OF_WEEK_AT = "2026-02-04T10:00:00Z"

/**
 * The noise the keyword legs rank ABOVE the answer. A reworded question shares
 * no word with the message that answers it, so Meili falls back to matching
 * nothing in particular and the keyword ranking is, correctly, uninformative:
 * these eight are what a keyword-only top five is made of.
 */
const DISTRACTORS = [
  "Can someone water the plants on the third floor.",
  "The standup moved to half past nine on Thursdays.",
  "Lunch is at the place across the road today.",
  "The printer on level two is out of toner again.",
  "Reminder that the fire drill is next quarter.",
  "Someone left a bicycle in the stairwell.",
  "The kitchen tap drips when the window is open.",
  "Parking permits renew at the end of the season.",
]
const DISTRACTOR_IDS = DISTRACTORS.map(() => crypto.randomUUID())
const DISTRACTOR_AT = "2026-01-12T09:00:00Z"

async function insertMessage(
  id: string,
  threadId: string,
  content: string,
  opts: { scopes?: string[]; createdAt?: string; orgId?: string; userId?: string } = {},
) {
  const orgId = opts.orgId ?? ORG_ID
  const userId = opts.userId ?? USER_A
  await sql`INSERT INTO kernel.messages (id, org_id, thread_id, author_id, author_type, content, required_scopes, created_at)
    VALUES (${id}, ${orgId}, ${threadId}, ${userId}, 'user', ${content},
            ${opts.scopes ?? []}, ${opts.createdAt ?? "2026-03-18T10:00:00Z"})`
}

describe("memory search, hybrid (P4c-T48)", () => {
  beforeAll(async () => {
    ExternalSearchHandlersTestAccess.reset()
    spies.push(spyOn(searchClientModule, "effectiveIndexName").mockReturnValue(INDEX_NAME))
    spies.push(spyOn(searchClientModule, "getMeili").mockReturnValue(realClient()))
    MessageIndexerTestAccess.setEmbedderFactory(async () => fakeEmbedder)

    const { expectedSettings } = await import("~/modules/search/drift")
    const created = await meili.createIndex(INDEX_NAME, { primaryKey: "id" })
    await meili.tasks.waitForTask(created.taskUid)
    const applied = await meili
      .index(INDEX_NAME)
      .updateSettings(
        expectedSettings({ registeredReadScopes: [THREADS_READ], dimensionFields: [] }),
      )
    await meili.tasks.waitForTask(applied.taskUid)

    for (const [orgId, slug] of [
      [ORG_ID, `hybrid-${tag}`],
      [NO_KEY_ORG_ID, `hybrid-nokey-${tag}`],
    ] as const) {
      await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${orgId}, 'HybridOrg', ${slug})`
    }
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${USER_A}, ${ORG_ID}, ${`hybrid-${tag}@test.com`}, 'Hybrid A', 'x')`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${NO_KEY_USER}, ${NO_KEY_ORG_ID}, ${`hybrid-nokey-${tag}@test.com`}, 'Hybrid B', 'x')`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, created_by)
      VALUES (${THREAD_ID}, ${ORG_ID}, ${`hybridthread${tag}`}, ${USER_A})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${THREAD_ID}, ${USER_A}, ${ORG_ID})`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, created_by)
      VALUES (${NO_KEY_THREAD}, ${NO_KEY_ORG_ID}, ${`hybridnokey${tag}`}, ${NO_KEY_USER})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${NO_KEY_THREAD}, ${NO_KEY_USER}, ${NO_KEY_ORG_ID})`

    // The noise goes in FIRST, so a keyword ranking that cannot tell these
    // apart from the answer puts these first.
    for (let i = 0; i < DISTRACTORS.length; i++) {
      await insertMessage(DISTRACTOR_IDS[i] as string, THREAD_ID, DISTRACTORS[i] as string, {
        createdAt: DISTRACTOR_AT,
      })
    }
    // The fact, said in words the reworded query does not use.
    await insertMessage(REWORDED_ID, THREAD_ID, "The DHL account number is 4711.", {
      createdAt: IN_WEEK_AT,
    })
    await insertMessage(NOISE_ID, THREAD_ID, "The office coffee machine is broken again.", {
      createdAt: IN_WEEK_AT,
    })
    // The STALE document: indexed while the row carried no scopes, then the row
    // is narrowed. Meili's filter still admits it; only the DATABASE re-check
    // knows it is hidden.
    await insertMessage(STALE_ID, THREAD_ID, "Our claim window lasts 9999 days.", {
      createdAt: IN_WEEK_AT,
    })
    await insertMessage(IN_WEEK_ID, THREAD_ID, "We decided to ship the zeppelin by sea.", {
      createdAt: IN_WEEK_AT,
    })
    await insertMessage(OUT_OF_WEEK_ID, THREAD_ID, "We decided to ship the zeppelin by air.", {
      createdAt: OUT_OF_WEEK_AT,
    })

    for (const id of [
      ...DISTRACTOR_IDS,
      REWORDED_ID,
      NOISE_ID,
      STALE_ID,
      IN_WEEK_ID,
      OUT_OF_WEEK_ID,
    ]) {
      await processMessageIndexerJob({ action: "upsert", orgId: ORG_ID, messageId: id })
    }
    // Narrow the stale row AFTER it was indexed.
    await sql`UPDATE kernel.messages SET required_scopes = ${[DEALS]} WHERE id = ${STALE_ID}`
  })

  afterAll(async () => {
    MessageIndexerTestAccess.setEmbedderFactory(null)
    MessageIndexerTestAccess.resetEmbedderCache()
    for (const s of spies) s.mockRestore()
    try {
      await meili.deleteIndex(INDEX_NAME)
    } catch {
      /* the index is a test artifact; a failed delete is not a test failure */
    }
    for (const orgId of [ORG_ID, NO_KEY_ORG_ID]) {
      await sql`DELETE FROM kernel.messages WHERE org_id = ${orgId}`
      await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${orgId}`
      await sql`DELETE FROM kernel.threads WHERE org_id = ${orgId}`
      await sql`DELETE FROM kernel.users WHERE org_id = ${orgId}`
      await sql`DELETE FROM kernel.organizations WHERE id = ${orgId}`
    }
  })

  it("a reworded query finds the message the keyword legs miss", async () => {
    // Not one word in common with "The DHL account number is 4711."
    const query = "what is our courier customer reference"
    const keywordOnly = await (async () => {
      MessageIndexerTestAccess.setEmbedderFactory(async () => null)
      try {
        return await search({ query })
      } finally {
        MessageIndexerTestAccess.setEmbedderFactory(async () => fakeEmbedder)
      }
    })()
    const hybrid = await search({ query })

    expect(keywordOnly.hits.some((h) => h.messageId === REWORDED_ID)).toBe(false)
    expect(hybrid.hits.some((h) => h.messageId === REWORDED_ID)).toBe(true)
  })

  it("a document the predicate hides is absent from the vector leg", async () => {
    // The stale document carries NO required_scopes in the index, so Meili's
    // filter admits it, and its vector is the query's vector exactly. Only the
    // database re-check knows the ROW was narrowed to crm:deals:read.
    const query = "what does our warranty guarantee"
    const withoutGrant = await search({ query })
    expect(withoutGrant.hits.some((h) => h.messageId === STALE_ID)).toBe(false)

    const withGrant = await search({ query }, [DEALS])
    expect(withGrant.hits.some((h) => h.messageId === STALE_ID)).toBe(true)
  })

  it("an org without a key searches keyword only and logs embedding_leg_off once", async () => {
    MessageIndexerTestAccess.setEmbedderFactory(null)
    MessageIndexerTestAccess.resetEmbedderCache()
    const savedKey = process.env.GOOGLE_API_KEY
    process.env.GOOGLE_API_KEY = ""
    const infoSpy = spyOn(searchLogger, "info")
    try {
      await search({ query: "courier customer reference" }, [], actorNoKey)
      await search({ query: "shipment identifier" }, [], actorNoKey)
      const offLines = infoSpy.mock.calls.filter((c) => c[1] === "embedding_leg_off")
      expect(offLines).toHaveLength(1)
      expect((offLines[0]?.[0] as { orgId?: string })?.orgId).toBe(NO_KEY_ORG_ID)
    } finally {
      infoSpy.mockRestore()
      if (savedKey === undefined) delete process.env.GOOGLE_API_KEY
      else process.env.GOOGLE_API_KEY = savedKey
      MessageIndexerTestAccess.setEmbedderFactory(async () => fakeEmbedder)
    }
  })

  it("a question naming a week filters to that window", async () => {
    const res = await search({ query: "zeppelin in week 12 of 2026" })
    const ids = res.hits.map((h) => h.messageId)
    expect(ids).toContain(IN_WEEK_ID)
    expect(ids).not.toContain(OUT_OF_WEEK_ID)

    // Without the week, the search reaches both.
    const unbounded = await search({ query: "zeppelin" })
    const allIds = unbounded.hits.map((h) => h.messageId)
    expect(allIds).toContain(IN_WEEK_ID)
    expect(allIds).toContain(OUT_OF_WEEK_ID)
  })

  it("embeds the query once per search, not once per leg", async () => {
    embedCalls = 0
    await search({ query: "courier customer reference" })
    expect(embedCalls).toBe(1)
  })
})

describe("parseTimeWindow", () => {
  const now = new Date("2026-04-15T12:00:00Z")

  it("reads an ISO week", () => {
    const w = parseTimeWindow("what did we decide in week 12 of 2026", now)
    expect(w?.from.toISOString().slice(0, 10)).toBe("2026-03-16")
    expect(w?.to.toISOString().slice(0, 10)).toBe("2026-03-22")
  })

  it("reads the 2026-W12 form", () => {
    expect(parseTimeWindow("2026-W12 decisions", now)?.from.toISOString().slice(0, 10)).toBe(
      "2026-03-16",
    )
  })

  it("reads a date", () => {
    const w = parseTimeWindow("anything from 2026-03-18", now)
    expect(w?.from.toISOString().slice(0, 10)).toBe("2026-03-18")
    expect(w?.to.toISOString().slice(0, 10)).toBe("2026-03-18")
  })

  it("reads last week and last month relative to now", () => {
    expect(parseTimeWindow("what happened last week", now)?.from.toISOString().slice(0, 10)).toBe(
      "2026-04-06",
    )
    expect(parseTimeWindow("what happened last month", now)?.from.toISOString().slice(0, 10)).toBe(
      "2026-03-01",
    )
  })

  it("reads a month name, resolving a future month to last year", () => {
    expect(
      parseTimeWindow("what did we decide in March", now)?.from.toISOString().slice(0, 7),
    ).toBe("2026-03")
    expect(
      parseTimeWindow("what did we decide in November", now)?.from.toISOString().slice(0, 7),
    ).toBe("2025-11")
  })

  it("fails open on a question that names no period", () => {
    expect(parseTimeWindow("what is the DHL account number", now)).toBeNull()
  })
})
