// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4m-T34: the long memory harness, scenarios 2 and 3 of spec-memory.md's
// validation list.
//
// SCENARIO 2, SUPERSESSION. The carrier account number is stated once, then
// corrected later in the same conversation. Two consolidation runs cover the
// two stretches (the second one bounded by the first one's flush marker, which
// is the production rule), and the correction lands as a supersession: the old
// row keeps its body and gains `superseded_at`, the new row points back at it,
// and every read path but `includeSuperseded` stops seeing the old one. The
// turn that asks is answered with the corrected value, from memory, with both
// stating messages long out of the rendered window.
//
// SCENARIO 3, SCOPE. A fact drawn from a message carrying a scope one human
// lacks is absent from that human's recall and search, and present for the
// human who holds it (S8 extended to the two new read paths).
//
// NO FUNDED KEY. Every model backed step is scripted through the production
// seams. The scripted fact extractor READS THE REGION it is handed and emits a
// fact only when the region really carries one, so a wrong region produces no
// memory and these cases fail. See helpers/long-memory.ts.

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { MeiliSearch } from "meilisearch"
import { sql } from "~/db"
import { withRlsContext } from "~/db/rls"
import * as jobsModule from "~/infra/jobs/jobs"
import * as searchClientModule from "~/infra/search/client"
import { CheckpointTestAccess } from "~/modules/agent/context/checkpoint"
import {
  ConsolidationTestAccess,
  type FactCandidate,
  type RegionMessage,
  runConsolidation,
} from "~/modules/agent/memory/consolidation"
import { memorySearch } from "~/modules/agent/memory/memory-search"
import { ExternalSearchHandlersTestAccess } from "~/modules/search/external-handlers"
import { resetOrgRuntimeForTest } from "~/tests/helpers/org-runtime"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { type CapturedTurn, installRequestCapture } from "./helpers/capture-requests"
import {
  ACCOUNT_RE,
  addPerson,
  answerFromRequest,
  driveTurn,
  dropWorld,
  insertMessage,
  padded,
  readerStream,
  seedWorld,
} from "./helpers/long-memory"

const ORIG_KEY = process.env.LIAISON_ANTHROPIC_API_KEY
const spies: Array<{ mockRestore: () => void }> = []

const meili = new MeiliSearch({
  host: process.env.MEILISEARCH_HOST || "http://localhost:7700",
  apiKey: process.env.MEILISEARCH_API_KEY || "dev-master-key",
})

/**
 * The transcript leg runs for real against an index that holds nothing: these
 * two scenarios are about FILES, and a verbatim hit on the original message
 * would answer scenario 2 without memory having decided anything.
 */
const EMPTY_INDEX = `test_p4mt34_${crypto.randomUUID().slice(0, 8)}`

/** The extractor: it reads the region and reports the account number it finds. */
function accountFactExtractor(name: string, description: string) {
  return async (region: RegionMessage[]): Promise<FactCandidate[]> => {
    for (let i = region.length - 1; i >= 0; i--) {
      const match = (region[i].content ?? "").match(ACCOUNT_RE)
      if (!match) continue
      const account = match[match.length - 1]
      return [
        {
          name,
          description,
          body: `The carrier account number is ${account}, confirmed with the carrier.`,
          sourceMessageIds: [region[i].id],
          type: "reference",
        },
      ]
    }
    return []
  }
}

function installConsolidationSeams(extractor: ReturnType<typeof accountFactExtractor>): void {
  ConsolidationTestAccess.setFlush(async () => true)
  ConsolidationTestAccess.setSummarizer(async () => "Scripted episode summary of this stretch.")
  ConsolidationTestAccess.setFactExtractor(extractor)
}

// ---------------------------------------------------------------------------
// Scenario 2: supersession
// ---------------------------------------------------------------------------

const S2_ORG = "4d000000-0000-4000-8000-000000000201"
const S2_USER = "4d000000-0000-4000-8000-000000000202"
const S2_THREAD = "4d000000-0000-4000-8000-000000000203"
const S2_AGENT = "4d000000-0000-4000-8000-000000000204"

const OLD_ACCOUNT = "KRY-55123"
const NEW_ACCOUNT = "KRY-77000"
const FACT_NAME = "carrier-account"
const FACT_PATH = `reference/${FACT_NAME}.md`
const S2_QUESTION = "Which carrier account number should we bill against, please confirm?"

describe("P4m-T34 long memory scenario 2, supersession", () => {
  let answer = ""
  let turn: CapturedTurn
  let hitsWithout = 0
  let hitsWith = 0
  let supersededRows: Array<{ content: string; path: string | null }> = []

  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-long-memory-stub"
    ExternalSearchHandlersTestAccess.reset()
    spies.push(spyOn(searchClientModule, "effectiveIndexName").mockReturnValue(EMPTY_INDEX))
    spies.push(
      spyOn(searchClientModule, "getMeili").mockReturnValue(
        meili as unknown as ReturnType<typeof searchClientModule.getMeili>,
      ),
    )
    spies.push(spyOn(jobsModule, "enqueueAppJob").mockImplementation(async () => "job") as never)
    const created = await meili.createIndex(EMPTY_INDEX, { primaryKey: "id" })
    await meili.tasks.waitForTask(created.taskUid)
    CheckpointTestAccess.setSummarizer(
      async () => "Summary of the billing conversation so far. No figures retained.",
    )
    await seedWorld({
      orgId: S2_ORG,
      userId: S2_USER,
      userEmail: "supersession@test.com",
      agents: [
        {
          id: S2_AGENT,
          handle: "@supersession",
          displayName: "Supersession",
          kind: "personal",
          ownerUserId: S2_USER,
        },
      ],
      threads: [{ id: S2_THREAD, handle: "supersession-dm" }],
    })

    const filler = async (n: number, label: string) => {
      for (let i = 0; i < n; i++) {
        await insertMessage({
          orgId: S2_ORG,
          threadId: S2_THREAD,
          authorId: S2_USER,
          authorType: i % 2 === 0 ? "user" : "agent",
          ...(i % 2 === 0 ? {} : { authorAgentId: S2_AGENT }),
          content: padded(`${label} exchange ${i}, nothing decided here.`),
        })
      }
    }

    installConsolidationSeams(
      accountFactExtractor(FACT_NAME, "The carrier account number to bill against"),
    )

    // Stretch one states the number, and the first close folds it into memory.
    await filler(2, "Opening")
    await insertMessage({
      orgId: S2_ORG,
      threadId: S2_THREAD,
      authorId: S2_USER,
      authorType: "user",
      content: `The carrier account number is ${OLD_ACCOUNT}, agreed today.`,
    })
    await filler(18, "Planning")
    const first = await runConsolidation({
      orgId: S2_ORG,
      agentId: S2_AGENT,
      threadId: S2_THREAD,
      closeReason: "quiet",
    })
    expect(first.factsWritten).toBe(1)

    // Stretch two corrects it. The close names no region, so it covers what is
    // new since the first close's flush marker: the extractor never sees the
    // old number again, and the supersession is decided at WRITE time.
    await insertMessage({
      orgId: S2_ORG,
      threadId: S2_THREAD,
      authorId: S2_USER,
      authorType: "user",
      content: `Correction: the carrier account number is ${NEW_ACCOUNT}, the old one was closed.`,
    })
    await filler(30, "Shipping")
    const second = await runConsolidation({
      orgId: S2_ORG,
      agentId: S2_AGENT,
      threadId: S2_THREAD,
      closeReason: "quiet",
    })
    expect(second.factsWritten).toBe(1)

    supersededRows = await sql<Array<{ content: string; path: string | null }>>`
      SELECT content, path FROM kernel.agent_memory
      WHERE org_id = ${S2_ORG} AND owner_agent_id = ${S2_AGENT} AND superseded_at IS NOT NULL`

    const actor = {
      actorType: "user" as const,
      userId: S2_USER,
      orgId: S2_ORG,
      scopes: ["*"],
      dimensionGrants: {},
    }
    const ctx = (tx: unknown) =>
      ({ userId: S2_USER, orgId: S2_ORG, db: tx, scopes: [], ownerAgentId: S2_AGENT }) as never
    const without = await withRlsContext(actor, (tx) =>
      memorySearch({ query: "carrier account number" }, ctx(tx)),
    )
    hitsWithout = without.hits.filter((h) => h.kind === "file").length
    const withSuperseded = await withRlsContext(actor, (tx) =>
      memorySearch({ query: "carrier account number", includeSuperseded: true }, ctx(tx)),
    )
    hitsWith = withSuperseded.hits.filter((h) => h.kind === "file").length

    const capture = installRequestCapture({
      currentAgentKey: () => S2_AGENT,
      script: (t) => {
        turn = t
        return readerStream(answerFromRequest(t))
      },
    })
    try {
      answer = await driveTurn({
        orgId: S2_ORG,
        threadId: S2_THREAD,
        userId: S2_USER,
        agentId: S2_AGENT,
        content: S2_QUESTION,
      })
    } finally {
      capture.restore()
    }
  })

  afterAll(async () => {
    ConsolidationTestAccess.resetSeams()
    CheckpointTestAccess.setSummarizer()
    for (const s of spies) s.mockRestore()
    spies.length = 0
    resetOrgRuntimeForTest(S2_ORG)
    if (ORIG_KEY !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_KEY
    else delete process.env.LIAISON_ANTHROPIC_API_KEY
    await meili.deleteIndex(EMPTY_INDEX).catch(() => undefined)
    await dropWorld(S2_ORG)
    await releaseTestLock()
  })

  it("a corrected fact wins and the old file is marked superseded", () => {
    expect(supersededRows.length).toBe(1)
    expect(supersededRows[0].content).toContain(OLD_ACCOUNT)
    // The superseded row loses its path: the tree shows one current file.
    expect(supersededRows[0].path).toBeNull()
    expect(hitsWithout).toBe(1)
    expect(hitsWith).toBe(2)
  })

  it("the turn is answered with the corrected value and never with the one it replaced", () => {
    expect(turn.tailText).toContain(NEW_ACCOUNT)
    expect(turn.tailText).not.toContain(OLD_ACCOUNT)
    expect(answer).toContain(NEW_ACCOUNT)
    expect(answer).not.toContain(OLD_ACCOUNT)
  })

  it("the current file is the one the tree carries at the fact's path", async () => {
    const rows = await sql<Array<{ content: string }>>`
      SELECT content FROM kernel.agent_memory
      WHERE org_id = ${S2_ORG} AND owner_agent_id = ${S2_AGENT} AND path = ${FACT_PATH}`
    expect(rows.length).toBe(1)
    expect(rows[0].content).toContain(NEW_ACCOUNT)
  })
})

// ---------------------------------------------------------------------------
// Scenario 3: scope
// ---------------------------------------------------------------------------

const S3_ORG = "4d000000-0000-4000-8000-000000000211"
const S3_LOW_USER = "4d000000-0000-4000-8000-000000000212"
const S3_HIGH_USER = "4d000000-0000-4000-8000-000000000213"
const S3_AGENT = "4d000000-0000-4000-8000-000000000214"
const S3_LOW_THREAD = "4d000000-0000-4000-8000-000000000215"
const S3_HIGH_THREAD = "4d000000-0000-4000-8000-000000000216"
const S3_SCOPE = "crm:deals:read"
const S3_ACCOUNT = "KDL-31337"
const S3_QUESTION = "What is the deal carrier account number on this account?"

const S3_INDEX = `test_p4mt34s3_${crypto.randomUUID().slice(0, 8)}`

describe("P4m-T34 long memory scenario 3, scope", () => {
  const s3spies: Array<{ mockRestore: () => void }> = []
  let lowTurn: CapturedTurn
  let highTurn: CapturedTurn
  let lowHits = 0
  let highHits = 0

  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-long-memory-stub"
    ExternalSearchHandlersTestAccess.reset()
    s3spies.push(spyOn(searchClientModule, "effectiveIndexName").mockReturnValue(S3_INDEX))
    s3spies.push(
      spyOn(searchClientModule, "getMeili").mockReturnValue(
        meili as unknown as ReturnType<typeof searchClientModule.getMeili>,
      ),
    )
    s3spies.push(spyOn(jobsModule, "enqueueAppJob").mockImplementation(async () => "job") as never)
    const created = await meili.createIndex(S3_INDEX, { primaryKey: "id" })
    await meili.tasks.waitForTask(created.taskUid)

    await seedWorld({
      orgId: S3_ORG,
      userId: S3_LOW_USER,
      userEmail: "scopelow@test.com",
      agents: [
        {
          id: S3_AGENT,
          handle: "@scopedesk",
          displayName: "Scope Desk",
          kind: "role",
          scopeCeiling: ["*"],
        },
      ],
      threads: [
        { id: S3_LOW_THREAD, handle: "scope-low-dm" },
        { id: S3_HIGH_THREAD, handle: "scope-high-dm" },
      ],
    })
    await addPerson({
      orgId: S3_ORG,
      userId: S3_HIGH_USER,
      email: "scopehigh@test.com",
      name: "Scope High",
      scopes: [S3_SCOPE],
    })
    await sql`DELETE FROM kernel.thread_participants
      WHERE thread_id = ${S3_HIGH_THREAD} AND user_id = ${S3_LOW_USER}`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${S3_HIGH_THREAD}, ${S3_HIGH_USER}, ${S3_ORG})`
    for (const threadId of [S3_LOW_THREAD, S3_HIGH_THREAD]) {
      await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type)
        VALUES (${threadId}, ${S3_AGENT}, ${S3_ORG}, 'agent')`
    }

    // The fact's source message carries the scope, so the fact does too: the
    // fine grained rule of spec-memory.md L5 step 3.
    installConsolidationSeams(accountFactExtractor("deal-account", "The deal carrier account"))
    await insertMessage({
      orgId: S3_ORG,
      threadId: S3_HIGH_THREAD,
      authorId: S3_HIGH_USER,
      authorType: "user",
      content: `The deal carrier account number is ${S3_ACCOUNT}, commercially sensitive.`,
      requiredScopes: [S3_SCOPE],
    })
    const result = await runConsolidation({
      orgId: S3_ORG,
      agentId: S3_AGENT,
      threadId: S3_HIGH_THREAD,
      closeReason: "quiet",
    })
    expect(result.factsWritten).toBe(1)

    const searchAs = async (userId: string, scopes: string[]) => {
      const res = await withRlsContext(
        { actorType: "user", userId, orgId: S3_ORG, scopes: ["*"], dimensionGrants: {} },
        (tx) =>
          memorySearch({ query: "deal carrier account number" }, {
            userId,
            orgId: S3_ORG,
            db: tx,
            scopes,
            ownerAgentId: S3_AGENT,
          } as never),
      )
      return res.hits.filter((h) => h.kind === "file").length
    }
    lowHits = await searchAs(S3_LOW_USER, [])
    highHits = await searchAs(S3_HIGH_USER, [S3_SCOPE])

    const driveAs = async (params: {
      userId: string
      threadId: string
      scopes: string[]
    }): Promise<CapturedTurn> => {
      let captured: CapturedTurn | undefined
      const capture = installRequestCapture({
        currentAgentKey: () => S3_AGENT,
        script: (t) => {
          captured = t
          return readerStream(answerFromRequest(t))
        },
      })
      try {
        await driveTurn({
          orgId: S3_ORG,
          threadId: params.threadId,
          userId: params.userId,
          agentId: S3_AGENT,
          content: S3_QUESTION,
          scopes: params.scopes,
        })
      } finally {
        capture.restore()
      }
      if (!captured) throw new Error("no turn captured")
      return captured
    }
    lowTurn = await driveAs({ userId: S3_LOW_USER, threadId: S3_LOW_THREAD, scopes: [] })
    highTurn = await driveAs({
      userId: S3_HIGH_USER,
      threadId: S3_HIGH_THREAD,
      scopes: [S3_SCOPE, "kernel:threads:read"],
    })
  })

  afterAll(async () => {
    ConsolidationTestAccess.resetSeams()
    for (const s of s3spies) s.mockRestore()
    s3spies.length = 0
    resetOrgRuntimeForTest(S3_ORG)
    if (ORIG_KEY !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_KEY
    else delete process.env.LIAISON_ANTHROPIC_API_KEY
    await meili.deleteIndex(S3_INDEX).catch(() => undefined)
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${S3_ORG}`
    await dropWorld(S3_ORG)
    await releaseTestLock()
  })

  it("a high scope fact is absent from a low scope room's auto recall and search and present for an admin", () => {
    expect(lowHits).toBe(0)
    expect(highHits).toBe(1)
    expect(lowTurn.tailText).not.toContain(S3_ACCOUNT)
    expect(lowTurn.prefixText).not.toContain(S3_ACCOUNT)
    expect(highTurn.tailText).toContain(S3_ACCOUNT)
  })
})
