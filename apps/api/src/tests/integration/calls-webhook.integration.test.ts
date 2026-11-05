// SPDX-License-Identifier: FSL-1.1-ALv2
//
// U5.2 — calls knowledge connector: the FULL segment webhook handler against
// the REAL RPC bridge + Postgres (U4.12's ci-webhook.test.ts pattern), with
// the EXACT actor shape production uses: the calls manifest's `segment`
// webhook sets `requiresUserActor: true`, so modules/webhooks/routes.ts
// resolves the org's oldest active user and runs the bridge as a real
// UserContext — required because knowledge's create/update write
// created_by/owner_user_id as `${actor.userId}::uuid` (service.ts), which a
// SystemContext can never satisfy.
//
// This is the first genuinely CROSS-APP webhook write in the estate
// (calls→knowledge via ctx.executeTool / executeToolCore): these tests prove
// (1) the sanctioned cross-app path works from a webhook-shaped bridge,
// (2) the cross_app_calls capability (registered per runtime.ts from the
//     manifest declaration) authorizes it without RBAC knowledge:* scopes on
//     the caller,
// (3) knowledge's REVISION_CONFLICT optimistic-concurrency path — never
//     exercised under concurrent load anywhere upstream — converges under the
//     connector's bounded retry loop (concurrent appends, dedup-under-race).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withRlsContext } from "~/db/rls"
import { appCrossAppCallsRegistry } from "~/modules/apps/app-registries"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import callsManifest from "../../../../../bundled-apps/calls/app.manifest.json"
import type { CallsCtx } from "../../../../../bundled-apps/calls/src/ctx"
import { callTitleFor, parseCallDoc } from "../../../../../bundled-apps/calls/src/doc-format"
import { HANDLER_SCOPES } from "../../../../../bundled-apps/calls/src/lib/hmac"
import {
  callsListHandler,
  callsSegmentsSinceHandler,
} from "../../../../../bundled-apps/calls/src/tools"
import { segmentWebhookHandler } from "../../../../../bundled-apps/calls/src/webhooks"

let orgId: string
let userId: string

// (HANDLER_SCOPES imported above — the calls verifier grants the handler its
// scopes explicitly on success via outcome.scopes, routes.ts:282-290: the
// connector's state lives in knowledge documents, and knowledge's service
// layer authorizes create/update/read against the CALLER's scopes — the
// cross-app RLS union widens row visibility only, never attribution scopes.
// Using the exact production grant runs the same actor shape the route builds.)

function runInWebhookShape<T>(fn: (ctx: CallsCtx) => Promise<T>): Promise<T> {
  return withRlsContext(
    {
      actorType: "user",
      userId,
      orgId,
      scopes: HANDLER_SCOPES,
      dimensionGrants: { "*": ["*"] },
    },
    async (tx) => {
      const bridge = createRpcBridge(
        "calls",
        userId,
        orgId,
        tx,
        callsManifest as never,
        HANDLER_SCOPES,
        "user",
        undefined,
        {
          actor: {
            actorType: "user",
            userId,
            orgId,
            scopes: HANDLER_SCOPES,
            dimensionGrants: { "*": ["*"] },
          },
        },
      )
      // The QuickJS ctx shim exposes every bridge method with the object-arg
      // auto-stringify contract; host-side the bridge's executeTool takes
      // (target, paramsJson) — adapt to the sandbox-visible object signature
      // the handler was written against.
      const rawExecuteTool = (bridge as unknown as Record<string, unknown>).executeTool as (
        target: string,
        paramsJson: string,
      ) => Promise<string>
      const ctx = {
        userId,
        orgId,
        executeTool: async (target: string, args: Record<string, unknown>) =>
          JSON.parse(await rawExecuteTool(target, JSON.stringify(args))),
        config: { get: async () => null },
        logger: {
          info: () => {},
          warn: () => {},
          // Surface handler-side failures in the test output — the handler's
          // 503 catch path logs the real cause here.
          error: (msg: string, data?: unknown) => console.error("[calls-handler]", msg, data),
          debug: () => {},
        },
      } as unknown as CallsCtx
      return fn(ctx)
    },
  )
}

async function readCallDocRow(
  callRef: string,
): Promise<{ id: string; body: string; revision: number } | null> {
  const rows = extractRows<{ id: string; body: string; revision: number }>(
    await db.execute(drizzleSql`
      SELECT id, body, revision FROM app_knowledge.documents
      WHERE org_id = ${orgId}::uuid AND title = ${callTitleFor(callRef)} AND archived_at IS NULL
    `),
  )
  return rows[0] ?? null
}

async function readCallDocReview(
  callRef: string,
): Promise<{ id: string; review_status: string } | null> {
  const rows = extractRows<{ id: string; review_status: string }>(
    await db.execute(drizzleSql`
      SELECT id, review_status FROM app_knowledge.documents
      WHERE org_id = ${orgId}::uuid AND title = ${callTitleFor(callRef)} AND archived_at IS NULL
    `),
  )
  return rows[0] ?? null
}

async function countCallDocs(callRef: string): Promise<number> {
  const rows = extractRows<{ n: string }>(
    await db.execute(drizzleSql`
      SELECT count(*)::text AS n FROM app_knowledge.documents
      WHERE org_id = ${orgId}::uuid AND title = ${callTitleFor(callRef)} AND archived_at IS NULL
    `),
  )
  return Number(rows[0]?.n ?? 0)
}

function seg(callRef: string, id: string, tsIso: string, text: string, speaker = "Alice") {
  return { callRef, segmentId: id, ts: tsIso, speaker, text }
}

describe("calls segment webhook — real bridge + Postgres", () => {
  beforeAll(async () => {
    await acquireTestLock()
    const slug = `calls-webhook-${Date.now()}`
    const [org] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), 'Calls Webhook Org', ${slug}) RETURNING id
      `),
    )
    orgId = org!.id
    const [admin] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version, created_at)
        VALUES (gen_random_uuid(), ${orgId}::uuid,
                ${`calls-admin-${Date.now()}@test.com`}, 'Calls Admin',
                'active', 'hash', 1, 1, now() - interval '1 day')
        RETURNING id
      `),
    )
    userId = admin!.id
    // Register the in-tree default apps (knowledge among them) for this org so
    // executeToolCore resolves knowledge's tool registry entries.
    await ensureAppsForOrg(orgId)
    // Register the calls app's install-approved cross-app capability exactly
    // as runtime.ts:1198-1211 does from the manifest at registration time
    // (the bundled app is catalog-installed in a real deployment; tests
    // invoke the handler directly, so mirror just this registration step).
    const targets = (callsManifest.cross_app_calls ?? []).map((c) => c.target)
    appCrossAppCallsRegistry.set([orgId, "calls"], { targets })
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  it("creates the per-call knowledge doc on the first segment (cross-app knowledge:create from a webhook bridge)", async () => {
    const callRef = `it-call-a-${Date.now()}`
    const res = await runInWebhookShape((ctx) =>
      segmentWebhookHandler(seg(callRef, "s1", new Date().toISOString(), "premier segment"), ctx),
    )
    expect(res.status).toBe(200)

    const row = await readCallDocRow(callRef)
    expect(row).not.toBeNull()
    const parsed = parseCallDoc(row!.body)
    expect(parsed.segments.map((s) => s.segmentId)).toEqual(["s1"])
    expect(parsed.segments[0]!.text).toBe("premier segment")
    expect(await countCallDocs(callRef)).toBe(1)
  })

  it("appends subsequent segments to the SAME doc, in ts order even when arriving out of order", async () => {
    const callRef = `it-call-b-${Date.now()}`
    const t0 = Date.now()
    const iso = (offsetS: number) => new Date(t0 + offsetS * 1000).toISOString()
    await runInWebhookShape((ctx) => segmentWebhookHandler(seg(callRef, "s1", iso(0), "un"), ctx))
    await runInWebhookShape((ctx) =>
      segmentWebhookHandler(seg(callRef, "s3", iso(40), "trois"), ctx),
    )
    const late = await runInWebhookShape((ctx) =>
      segmentWebhookHandler(seg(callRef, "s2", iso(20), "deux"), ctx),
    )
    expect(late.status).toBe(200)

    expect(await countCallDocs(callRef)).toBe(1)
    const parsed = parseCallDoc((await readCallDocRow(callRef))!.body)
    expect(parsed.segments.map((s) => s.segmentId)).toEqual(["s1", "s2", "s3"])
  })

  it("dedups a re-delivered segmentId at the document layer (different delivery, same segment ⇒ one marker)", async () => {
    const callRef = `it-call-c-${Date.now()}`
    const ts = new Date().toISOString()
    await runInWebhookShape((ctx) => segmentWebhookHandler(seg(callRef, "s1", ts, "original"), ctx))
    const dup = await runInWebhookShape((ctx) =>
      segmentWebhookHandler(seg(callRef, "s1", ts, "ALTERED RESEND"), ctx),
    )
    expect(dup.status).toBe(200)

    const parsed = parseCallDoc((await readCallDocRow(callRef))!.body)
    expect(parsed.segments.length).toBe(1)
    expect(parsed.segments[0]!.text).toBe("original")
  })

  it("CONCURRENT appends both land — first real exercise of knowledge's REVISION_CONFLICT path under load", async () => {
    const callRef = `it-call-d-${Date.now()}`
    const t0 = Date.now()
    // Seed the doc so both racers contend on the same revision.
    await runInWebhookShape((ctx) =>
      segmentWebhookHandler(seg(callRef, "s0", new Date(t0).toISOString(), "seed"), ctx),
    )
    const [a, b] = await Promise.all([
      runInWebhookShape((ctx) =>
        segmentWebhookHandler(
          seg(callRef, "sA", new Date(t0 + 15_000).toISOString(), "racer A"),
          ctx,
        ),
      ),
      runInWebhookShape((ctx) =>
        segmentWebhookHandler(
          seg(callRef, "sB", new Date(t0 + 16_000).toISOString(), "racer B"),
          ctx,
        ),
      ),
    ])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)

    expect(await countCallDocs(callRef)).toBe(1)
    const parsed = parseCallDoc((await readCallDocRow(callRef))!.body)
    expect(parsed.segments.map((s) => s.segmentId)).toEqual(["s0", "sA", "sB"])
  })

  it("concurrent FIRST segments of the same call converge to ONE doc (create race + sender-retry contract)", async () => {
    const callRef = `it-call-e-${Date.now()}`
    const t0 = Date.now()
    const deliveries = [
      seg(callRef, "s1", new Date(t0).toISOString(), "first A"),
      seg(callRef, "s2", new Date(t0 + 1000).toISOString(), "first B"),
    ]
    const results = await Promise.all(
      deliveries.map((d) => runInWebhookShape((ctx) => segmentWebhookHandler(d, ctx))),
    )
    // The idempotency reservation serializes the double-create: the winner
    // lands 200; the loser either replays the winner's cached create (200) or
    // — if the winner's create is still in flight past the bounded retries —
    // returns 503 so the SENDER retries (the U5.3 transport contract: "Bot
    // must implement its own send-retry-with-backoff on 503"). Model that
    // sender retry here; what matters is convergence with NO duplicate doc
    // and NO lost segment.
    for (let i = 0; i < results.length; i++) {
      expect([200, 503]).toContain(results[i]!.status)
      for (let retry = 0; retry < 5 && results[i]!.status === 503; retry++) {
        await new Promise((r) => setTimeout(r, 100))
        results[i] = await runInWebhookShape((ctx) => segmentWebhookHandler(deliveries[i]!, ctx))
      }
      expect(results[i]!.status).toBe(200)
    }
    expect(await countCallDocs(callRef)).toBe(1)
    const parsed = parseCallDoc((await readCallDocRow(callRef))!.body)
    expect(parsed.segments.map((s) => s.segmentId).sort()).toEqual(["s1", "s2"])
  })

  it("summary deliveries replace the Résumé section wholesale (rolling → final), segments untouched", async () => {
    const callRef = `it-call-f-${Date.now()}`
    const ts = new Date().toISOString()
    await runInWebhookShape((ctx) => segmentWebhookHandler(seg(callRef, "s1", ts, "contenu"), ctx))
    await runInWebhookShape((ctx) =>
      segmentWebhookHandler(
        {
          callRef,
          kind: "summary",
          ts: new Date().toISOString(),
          text: "V1 rolling",
          isFinal: false,
        },
        ctx,
      ),
    )
    const fin = await runInWebhookShape((ctx) =>
      segmentWebhookHandler(
        {
          callRef,
          kind: "summary",
          ts: new Date().toISOString(),
          text: "V2 finale",
          isFinal: true,
        },
        ctx,
      ),
    )
    expect(fin.status).toBe(200)

    const body = (await readCallDocRow(callRef))!.body
    const parsed = parseCallDoc(body)
    expect(parsed.summary!.text).toBe("V2 finale")
    expect(parsed.summary!.isFinal).toBe(true)
    expect(body).not.toContain("V1 rolling")
    expect(parsed.segments.length).toBe(1)
  })

  // A45: the webhook ingestion path is an APP write, not an agent decision, so
  // it never parks an approval. The human check moves behind the write: the
  // ingested document is not verified and the knowledge review queue holds it,
  // where knowledge:verify promotes it.
  it("the ingested document is unverified and sits in the knowledge review queue", async () => {
    const callRef = `it-call-review-${Date.now()}`
    const res = await runInWebhookShape((ctx) =>
      segmentWebhookHandler(
        seg(callRef, "s1", new Date().toISOString(), "a reviewer reads this"),
        ctx,
      ),
    )
    expect(res.status).toBe(200)

    const row = await readCallDocReview(callRef)
    expect(row).not.toBeNull()
    expect(row!.review_status).not.toBe("verified")

    // The review-queue read path: knowledge's review_queue tool is this exact
    // call (rpc-bridge knowledge_attentionItems, aggregate off so every
    // document stays individually addressable).
    const { computeAttentionItems } = await import("~/apps/knowledge/attention")
    const queue = await computeAttentionItems(db as never, orgId, userId, new Date(), {
      aggregate: false,
    })
    expect(queue.map((i) => i.entityId)).toContain(row!.id)
  })

  // The same gate is UNTOUCHED for an agent-initiated create: no declared
  // caller app, so knowledge:create still parks an approval instead of writing.
  //
  // The stage-time preflight (execute-tool.ts) now runs the knowledge bridge's
  // PLACEMENT guard BEFORE staging, so an agent create that is going to be
  // queued has to carry a real placement (collection + sensitivity) and the
  // scope that placement needs. Both halves are asserted here: WITH the scope
  // the call reaches staging (pending_approval), WITHOUT it the preflight
  // answers a TYPED refusal and nothing is queued.
  const AGENT_CREATE_SCOPES = [...HANDLER_SCOPES, "knowledge:collections:manage"]
  let agentCollectionId: string

  async function countKnowledgeCreateApprovals(): Promise<number> {
    const rows = extractRows<{ n: string }>(
      await db.execute(drizzleSql`
        SELECT count(*)::text AS n FROM kernel.approval_requests
        WHERE org_id = ${orgId}::uuid AND tool_name = 'knowledge:create'`),
    )
    return Number(rows[0]?.n ?? "0")
  }

  beforeAll(async () => {
    const { createKnowledgeCollection } = await import("~/apps/knowledge/collections")
    const actor = {
      actorType: "user" as const,
      userId,
      orgId,
      scopes: AGENT_CREATE_SCOPES,
      dimensionGrants: { "*": ["*"] },
    }
    agentCollectionId = await withRlsContext(actor, async (tx) => {
      const row = await createKnowledgeCollection(
        tx as never,
        { name: `agent-create-collection-${Date.now()}` },
        actor as never,
      )
      return row.id
    })
  })

  it("an agent-initiated knowledge:create still gates (no declared caller app)", async () => {
    const { executeTool } = await import("~/modules/apps/execute-tool")
    const out = await executeTool<{ status?: string; approval_id?: string }>({
      toolName: "knowledge:create",
      orgId,
      actor: {
        actorType: "user",
        userId,
        orgId,
        scopes: AGENT_CREATE_SCOPES,
        dimensionGrants: { "*": ["*"] },
      } as never,
      params: {
        title: `agent-create-${Date.now()}`,
        body: "agent authored",
        documentScope: "organization",
        collectionId: agentCollectionId,
        sensitivity: "internal",
      },
      origin: "in-app-agent",
    })
    expect(out.data.status).toBe("pending_approval")
    expect(typeof out.data.approval_id).toBe("string")
  })

  // The sibling half, and the error-reporting contract (apps/api/CLAUDE.md): a
  // gated create whose stage-time preflight REFUSES must answer a typed refusal
  // carrying the real code, never a bare 500 that reads as a server fault, and
  // must never queue an approval a human would then have to decide on a call
  // that can never execute.
  it("a gated create whose preflight fails answers a typed refusal, not a 500", async () => {
    const { executeTool } = await import("~/modules/apps/execute-tool")
    const before = await countKnowledgeCreateApprovals()
    const err = await executeTool({
      toolName: "knowledge:create",
      orgId,
      actor: {
        actorType: "user",
        userId,
        orgId,
        // HANDLER_SCOPES deliberately excludes knowledge:collections:manage.
        scopes: HANDLER_SCOPES,
        dimensionGrants: { "*": ["*"] },
      } as never,
      params: {
        title: `agent-create-unscoped-${Date.now()}`,
        body: "agent authored",
        documentScope: "organization",
        sensitivity: "internal",
      },
      origin: "in-app-agent",
    }).then(
      () => null,
      (e: Error & { code?: string; status?: number }) => e,
    )
    expect(err).not.toBeNull()
    expect(err!.code).toBe("collections_scope_required")
    expect(err!.status).toBe(403)
    expect(err!.message).toContain("knowledge:collections:manage")
    expect(await countKnowledgeCreateApprovals()).toBe(before)
  })

  it("rejects a malformed envelope with 400 before any knowledge write", async () => {
    const callRef = `it-call-g-${Date.now()}`
    const res = await runInWebhookShape((ctx) =>
      segmentWebhookHandler({ callRef, text: "no segmentId" }, ctx),
    )
    expect(res.status).toBe(400)
    expect(await countCallDocs(callRef)).toBe(0)
  })

  it("read tools serve the ingested transcript through the SAME cross-app surface (since filter + lastSegmentTs)", async () => {
    const callRef = `it-call-h-${Date.now()}`
    const t0 = Date.now()
    const iso = (offsetS: number) => new Date(t0 + offsetS * 1000).toISOString()
    await runInWebhookShape((ctx) => segmentWebhookHandler(seg(callRef, "s1", iso(0), "un"), ctx))
    await runInWebhookShape((ctx) =>
      segmentWebhookHandler(seg(callRef, "s2", iso(20), "deux"), ctx),
    )

    // The read tool's callRef→doc resolution rides knowledge's Meili-backed
    // search. In production the boot-time indexer consumer
    // (registerIndexerConsumer, infra/boot-phase10.ts) indexes each document
    // event; a bare bun:test process never boots that pipeline, so drive the
    // SAME indexer job directly for the doc this test created — the staging
    // live smoke proves the event→index wiring end-to-end.
    const docRow = await readCallDocRow(callRef)
    expect(docRow).not.toBeNull()
    // Provision the index settings the boot path (detectDrift) would have
    // applied — a bare addDocuments-created index has no filterableAttributes,
    // so the permission-filtered search errors out.
    const { detectDrift } = await import("~/modules/search/drift")
    const { collectSearchableRegistrations } = await import("~/modules/search/searchable-entities")
    const regs = collectSearchableRegistrations(orgId)
    await detectDrift({
      registeredReadScopes: regs.registeredReadScopes,
      dimensionFields: regs.dimensionFields,
      aclFieldNames: regs.aclFieldNames,
    })
    const { processIndexerJob } = await import("~/modules/search/indexer")
    await processIndexerJob({
      action: "upsert",
      orgId,
      app: "knowledge",
      entityType: "document",
      entityId: docRow!.id,
    })

    const out = await runInWebhookShape((ctx) => callsSegmentsSinceHandler({ callRef }, ctx))
    expect(out.data.segments.map((s) => s.segmentId)).toEqual(["s1", "s2"])
    expect(out.data.lastSegmentTs).toBe(new Date(t0 + 20_000).toISOString())

    const since = await runInWebhookShape((ctx) =>
      callsSegmentsSinceHandler({ callRef, since: new Date(t0).toISOString() }, ctx),
    )
    expect(since.data.segments.map((s) => s.segmentId)).toEqual(["s2"])
    expect(since.data.lastSegmentTs).toBe(new Date(t0 + 20_000).toISOString())

    const listed = await runInWebhookShape((ctx) => callsListHandler({ limit: 50 }, ctx))
    expect(listed.data.calls.some((c) => c.callRef === callRef)).toBe(true)
  }, 15_000)
})
