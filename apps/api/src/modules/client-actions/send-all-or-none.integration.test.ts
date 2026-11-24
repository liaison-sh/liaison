// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A send of many signers through the bridge (bridge/client-actions.ts), on real rows: the
// document is read once for the whole send; a failure or a cancelled write after any number of
// signers leaves none of them, no mail and no event; the same send again, at the same moment or
// later, makes and mails nothing more, a signer who answered included; other signers on a
// document already sent are refused. A reminder of many signers reads the document once, and
// the same reminder again mails nobody twice. A link whose mail never started (the server
// stopped after the commit) is mailed once, later; a failed mail is told as such; two people at
// one address are two signers.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import postgres from "postgres"
import { sql } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import { hashToken } from "~/lib/crypto"
import { env } from "~/lib/env"
import { toolRegistry } from "~/modules/apps/app-registries"
import { createClientActionsMethods } from "~/modules/apps/sandbox/bridge/client-actions"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import {
  mailUnsentLink,
  remailClientAction,
  remindClientActions,
  revokeClientAction,
} from "~/modules/client-actions/mint"
import { ClientActionTargetsTestAccess } from "~/modules/client-actions/targets"
import { mailUnsentLinks } from "~/modules/client-actions/unsent-links"
import { superuserUrlForTestDb } from "~/tests/route-test-setup"
import {
  k,
  mailboxOf,
  syncedCopyOf,
  syncPage,
  tokenOf,
  useClientActionWorld,
} from "../../../test-support/client-actions-kit"

const kit = useClientActionWorld("sendmany", "agreement_version")
const SEND_TOOL = "send_for_signature"
const mutableEnv = env as { LIAISON_TSA_URL?: string }
let prevTsa: string | undefined
let views = 0
/** The test database's owner: the app's own role makes no trigger. */
let owner: ReturnType<typeof postgres>

beforeAll(() => {
  owner = postgres(superuserUrlForTestDb() as string, { max: 1, onnotice: () => {} })
  prevTsa = mutableEnv.LIAISON_TSA_URL
  mutableEnv.LIAISON_TSA_URL = "https://tsa.example.test/"
  toolRegistry.set([kit.w.orgId, kit.targetApp, SEND_TOOL], {
    appName: kit.targetApp,
    name: SEND_TOOL,
    gated: true,
    noAutoApprove: true,
    requiredScopes: [`${kit.targetApp}:docs:write`],
  } as never)
})

beforeEach(() => {
  ClientActionTargetsTestAccess.set(kit.targetApp, kit.targetType, ["sign", "accept"], async () => {
    views += 1
    if (kit.viewDelayMs > 0) await new Promise((r) => setTimeout(r, kit.viewDelayMs))
    return kit.viewAnswers ? kit.view : null
  })
})

afterEach(async () => {
  await dropTrigger()
})

afterAll(async () => {
  await owner.end()
  mutableEnv.LIAISON_TSA_URL = prevTsa
  toolRegistry.delete([kit.w.orgId, kit.targetApp, SEND_TOOL])
})

const bridge = (approvalId: string = crypto.randomUUID()) =>
  createClientActionsMethods({
    appName: kit.targetApp,
    orgId: kit.w.orgId,
    userId: kit.w.admin.userId,
    approvalContext: {
      approvalRequestId: approvalId,
      approvalDeciderId: kit.w.admin.userId,
      toolName: `${kit.targetApp}:${SEND_TOOL}`,
    },
    bridgeOptions: undefined,
    bridgeActingAgentId: undefined,
  } as unknown as BridgeContext)

interface Answer {
  status: string
  error?: { code: string; message: string }
  already_sent?: boolean
  group_id?: string
  actions?: Array<{
    id: string
    status: string
    invited_email: string
    invited_name: string
    deduped: boolean
    mail: string | null
  }>
  action?: { id: string; status: string; invited_name: string; deduped: boolean }
  replaced_id?: string
  opened_id?: string | null
  reminded?: Array<{ id: string }>
  recently_mailed?: Array<{ id: string }>
}

const signersOf = (targetId: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({
    email: `s${i + 1}-${targetId.slice(0, 8)}@signers.example`,
    name: `Signer ${i + 1}`,
  }))

async function mint(payload: unknown, approvalId?: string): Promise<Answer> {
  return JSON.parse(await bridge(approvalId).client_actions_mint(JSON.stringify(payload))) as Answer
}

const sendOf = (targetId: string, n: number, extra: Record<string, unknown> = {}) => ({
  send: {
    target_type: kit.targetType,
    target_id: targetId,
    sha256: kit.view.sha256,
    kind: "sign",
    expires_in_days: 7,
    order: "any",
    company_id: kit.w.companyA,
    signers: signersOf(targetId, n),
    ...extra,
  },
})

const rowsOf = async (targetId: string) =>
  (await sql`
    SELECT id, group_id, invited_email, token_hash, revoked_at FROM ${k("client_actions")}
     WHERE target_id = ${targetId}`) as unknown as Array<{
    id: string
    group_id: string
    invited_email: string
    token_hash: string | null
    revoked_at: Date | null
  }>

/** The outbox's word that a send's links exist, for the app that owns the target. */
const sentEvents = async (targetId: string) =>
  (await sql`
    SELECT id FROM kernel.pending_events
     WHERE org_id = ${kit.w.orgId} AND payload::text LIKE ${`%${targetId}%`}
       AND payload::text LIKE '%links_made%'`) as unknown as Array<{ id: string }>

const linkMails = (targetId: string) =>
  kit.capture.sent.filter(
    (m) => m.template === "client-action.link" && m.to.includes(targetId.slice(0, 8)),
  ).length

async function mailsSettle(targetId: string, n: number): Promise<number> {
  const end = Date.now() + 10_000
  while (linkMails(targetId) < n && Date.now() < end) await new Promise((r) => setTimeout(r, 25))
  // A beat more: a mail too many would land here.
  await new Promise((r) => setTimeout(r, 200))
  return linkMails(targetId)
}

/** `act` runs in the database when a target's row number `at + 1` is being written. */
async function triggerAfter(targetId: string, at: number, act: string): Promise<void> {
  const schema = "kernel"
  await owner.unsafe(`CREATE OR REPLACE FUNCTION ${schema}.send_many_test_fn() RETURNS trigger AS $$
    BEGIN
      IF NEW.target_id = '${targetId}' AND
         (SELECT count(*) FROM ${schema}.client_actions WHERE target_id = NEW.target_id) >= ${at} THEN
        ${act}
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql SECURITY DEFINER`)
  await owner.unsafe(`CREATE TRIGGER send_many_test BEFORE INSERT ON ${schema}.client_actions
    FOR EACH ROW EXECUTE FUNCTION ${schema}.send_many_test_fn()`)
}

/** `act` runs in the database when a link's mail is marked as handed over. */
async function triggerOnClaim(targetId: string, act: string): Promise<void> {
  await owner.unsafe(`CREATE OR REPLACE FUNCTION kernel.send_many_test_fn() RETURNS trigger AS $$
    BEGIN
      IF NEW.target_id = '${targetId}' AND OLD.sent_at IS NULL AND NEW.sent_at IS NOT NULL THEN
        ${act}
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql SECURITY DEFINER`)
  await owner.unsafe(`CREATE TRIGGER send_many_test BEFORE UPDATE ON kernel.client_actions
    FOR EACH ROW EXECUTE FUNCTION kernel.send_many_test_fn()`)
}

/** The trail of a target's links, moved back in time (the trail itself is append only). */
async function age(targetId: string, minutes: number): Promise<void> {
  await owner.begin(async (tx) => {
    await tx.unsafe("SET LOCAL session_replication_role = replica")
    await tx.unsafe(`UPDATE kernel.client_action_events SET at = at - interval '${minutes} minutes'
      WHERE action_id IN (SELECT id FROM kernel.client_actions WHERE target_id = '${targetId}')`)
  })
}

async function dropTrigger(): Promise<void> {
  await owner.unsafe("DROP TRIGGER IF EXISTS send_many_test ON kernel.client_actions")
  await owner.unsafe("DROP FUNCTION IF EXISTS kernel.send_many_test_fn()")
}

describe("a send of 40 signers", () => {
  it("reads the document once and makes one group, one mail each and one event", async () => {
    const targetId = crypto.randomUUID()
    views = 0
    const out = await mint(sendOf(targetId, 40))
    expect(out.status).toBe("ok")
    expect(views).toBe(1)
    const rows = await rowsOf(targetId)
    expect(rows).toHaveLength(40)
    expect(new Set(rows.map((r) => r.group_id)).size).toBe(1)
    expect(new Set(out.actions?.map((a) => a.id)).size).toBe(40)
    expect(await mailsSettle(targetId, 40)).toBe(40)
    expect(await sentEvents(targetId)).toHaveLength(1)
  })

  it("refuses a document that hashes to something else, before any row", async () => {
    const targetId = crypto.randomUUID()
    const out = await mint(sendOf(targetId, 40, { sha256: "c".repeat(64) }))
    expect(out.error?.code).toBe("VERSION_CHANGED")
    expect(await rowsOf(targetId)).toHaveLength(0)
    expect(await sentEvents(targetId)).toHaveLength(0)
  })

  for (const at of [0, 1, 20, 39]) {
    for (const [what, act] of [
      ["one signer's row fails", "RAISE EXCEPTION 'no row for this signer';"],
      [
        "the database cancels the write",
        "PERFORM pg_cancel_backend(pg_backend_pid()); PERFORM pg_sleep(1);",
      ],
    ] as const) {
      it(`after ${at} signers, ${what}: no link, no mail, no event; the retry sends all once`, async () => {
        const targetId = crypto.randomUUID()
        await triggerAfter(targetId, at, act)
        const failed = await mint(sendOf(targetId, 40)).then(
          (o) => o.status,
          () => "threw",
        )
        expect(failed).not.toBe("ok")
        await dropTrigger()
        expect(await rowsOf(targetId)).toHaveLength(0)
        expect(await sentEvents(targetId)).toHaveLength(0)
        expect(await mailsSettle(targetId, 0)).toBe(0)
        const again = await mint(sendOf(targetId, 40))
        expect(again.status).toBe("ok")
        expect(await rowsOf(targetId)).toHaveLength(40)
        expect(await mailsSettle(targetId, 40)).toBe(40)
      })
    }
  }

  it("a signer with no address refuses the send whole", async () => {
    const targetId = crypto.randomUUID()
    const signers = [...signersOf(targetId, 39), { contact_id: crypto.randomUUID() }]
    const out = await mint(sendOf(targetId, 40, { signers }))
    expect(out.error?.code).toBe("NOT_FOUND")
    expect(await rowsOf(targetId)).toHaveLength(0)
    expect(await mailsSettle(targetId, 0)).toBe(0)
  })

  it("the same send twice at the same moment makes and mails each signer once", async () => {
    const targetId = crypto.randomUUID()
    const outs = await Promise.all([mint(sendOf(targetId, 40)), mint(sendOf(targetId, 40))])
    expect(outs.map((o) => o.status)).toEqual(["ok", "ok"])
    expect(outs.filter((o) => o.already_sent === true)).toHaveLength(1)
    expect(await rowsOf(targetId)).toHaveLength(40)
    expect(await mailsSettle(targetId, 40)).toBe(40)
    expect(await sentEvents(targetId)).toHaveLength(1)
  })

  it("the same send after a signer answered makes no second link for anyone", async () => {
    const targetId = crypto.randomUUID()
    const out = await mint(sendOf(targetId, 3))
    await mailsSettle(targetId, 3)
    await sql`UPDATE ${k("client_actions")} SET decided_at = now(), decision = 'signed'
               WHERE id = ${out.actions?.[0]?.id ?? ""}`
    const again = await mint(sendOf(targetId, 3))
    expect(again).toMatchObject({ status: "ok", already_sent: true, group_id: out.group_id })
    expect(again.actions?.map((a) => a.id).sort()).toEqual(out.actions?.map((a) => a.id).sort())
    expect(again.actions?.find((a) => a.id === out.actions?.[0]?.id)?.status).toBe("decided")
    // The app goes over that answer: it may have kept it until a person sent it all the same.
    expect(await sentEvents(targetId)).toHaveLength(2)
    expect(await rowsOf(targetId)).toHaveLength(3)
    expect(await mailsSettle(targetId, 3)).toBe(3)
  })

  it("the same send once every signer answered makes none, even past the links' end", async () => {
    const targetId = crypto.randomUUID()
    await mint(sendOf(targetId, 2))
    await mailsSettle(targetId, 2)
    await sql`UPDATE ${k("client_actions")}
                 SET decided_at = now(), decision = 'signed', expires_at = now() - interval '1 day'
               WHERE target_id = ${targetId}`
    const again = await mint(sendOf(targetId, 2))
    expect(again).toMatchObject({ status: "ok", already_sent: true })
    expect(again.actions?.map((x) => x.status)).toEqual(["decided", "decided"])
    expect(await rowsOf(targetId)).toHaveLength(2)
    expect(await mailsSettle(targetId, 2)).toBe(2)
  })

  it("other signers on a document already sent are refused, and nothing is sent", async () => {
    const targetId = crypto.randomUUID()
    await mint(sendOf(targetId, 2))
    await mailsSettle(targetId, 2)
    const more = await mint(sendOf(targetId, 3))
    expect(more.error?.code).toBe("ALREADY_SENT")
    const fewer = await mint(sendOf(targetId, 1))
    expect(fewer.error?.code).toBe("ALREADY_SENT")
    const other = await mint(
      sendOf(targetId, 2, { signers: [...signersOf(targetId, 1), { email: "x@signers.example" }] }),
    )
    expect(other.error?.code).toBe("ALREADY_SENT")
    expect(await rowsOf(targetId)).toHaveLength(2)
    expect(await mailsSettle(targetId, 2)).toBe(2)
  })

  it("a send whose links were all withdrawn, or all ran out unanswered, can be sent again", async () => {
    for (const end of ["revoked", "expired"]) {
      const targetId = crypto.randomUUID()
      await mint(sendOf(targetId, 2))
      await mailsSettle(targetId, 2)
      if (end === "revoked")
        await sql`UPDATE ${k("client_actions")} SET revoked_at = now(), revoke_reason = 'withdrawn'
                   WHERE target_id = ${targetId}`
      else
        await sql`UPDATE ${k("client_actions")} SET expires_at = now() - interval '1 day'
                   WHERE target_id = ${targetId}`
      const again = await mint(sendOf(targetId, 2))
      expect(again.status).toBe("ok")
      expect(again.already_sent).toBeUndefined()
      expect(await rowsOf(targetId)).toHaveLength(4)
      expect(await mailsSettle(targetId, 4)).toBe(4)
    }
  })
})

describe("a reminder of 40 signers", () => {
  it("reads the document once, mails each once, and the same reminder again mails nobody", async () => {
    const targetId = crypto.randomUUID()
    const out = await mint(sendOf(targetId, 40))
    const ids = (out.actions ?? []).map((a) => a.id)
    await mailsSettle(targetId, 40)
    views = 0
    const [a, b] = await Promise.all([mint({ remind: { ids } }), mint({ remind: { ids } })])
    expect(views).toBeLessThanOrEqual(2)
    expect((a.reminded?.length ?? 0) + (b.reminded?.length ?? 0)).toBe(40)
    expect((a.recently_mailed?.length ?? 0) + (b.recently_mailed?.length ?? 0)).toBe(40)
    expect(await mailsSettle(targetId, 80)).toBe(80)
    const again = await mint({ remind: { ids } })
    expect(again.reminded).toEqual([])
    expect(again.recently_mailed).toHaveLength(40)
    expect(await mailsSettle(targetId, 80)).toBe(80)
  })

  it("a reminder that fails part way keeps every link it would have replaced", async () => {
    const targetId = crypto.randomUUID()
    const out = await mint(sendOf(targetId, 5))
    const ids = (out.actions ?? []).map((a) => a.id)
    await mailsSettle(targetId, 5)
    const before = (await rowsOf(targetId)).map((r) => r.token_hash).sort()
    await owner.unsafe(`CREATE OR REPLACE FUNCTION kernel.send_many_test_fn() RETURNS trigger AS $$
      BEGIN
        IF NEW.id = '${ids[3]}' THEN RAISE EXCEPTION 'no rotation'; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`)
    await owner.unsafe(`CREATE TRIGGER send_many_test BEFORE UPDATE ON kernel.client_actions
      FOR EACH ROW EXECUTE FUNCTION kernel.send_many_test_fn()`)
    const failed = await mint({ remind: { ids } }).then(
      (o) => o.status,
      () => "threw",
    )
    expect(failed).not.toBe("ok")
    await dropTrigger()
    expect((await rowsOf(targetId)).map((r) => r.token_hash).sort()).toEqual(before)
    expect(await mailsSettle(targetId, 5)).toBe(5)
    const again = await mint({ remind: { ids } })
    expect(again.reminded).toHaveLength(5)
    expect(await mailsSettle(targetId, 10)).toBe(10)
  })
})

/** The links of a target whose mails were never started, as a server that stopped leaves them. */
async function stoppedBeforeMails(
  n: number,
  opts: { approvalId?: string; extra?: (targetId: string) => Record<string, unknown> } = {},
): Promise<{ targetId: string; out: Answer }> {
  const targetId = crypto.randomUUID()
  await triggerOnClaim(targetId, "RAISE EXCEPTION 'the server stopped';")
  const out = await mint(sendOf(targetId, n, opts.extra?.(targetId)), opts.approvalId)
  expect(out.status).toBe("ok")
  expect(await mailsSettle(targetId, 0)).toBe(0)
  await dropTrigger()
  return { targetId, out }
}

describe("links whose server stopped before their mails", () => {
  it("are mailed once by the job, each to its signer, and the same send asked before says so", async () => {
    const { targetId, out } = await stoppedBeforeMails(7)
    const again = await mint(sendOf(targetId, 7))
    expect(again).toMatchObject({ status: "ok", already_sent: true })
    expect(again.actions?.map((a) => a.mail)).toEqual(Array(7).fill("owed"))
    // The minutes after a send are its own run's: the job leaves them to it.
    await mailUnsentLinks()
    expect(await mailsSettle(targetId, 0)).toBe(0)
    await age(targetId, 6)
    const runs = await Promise.all([mailUnsentLinks(), mailUnsentLinks()])
    expect(runs.reduce((t, r) => t + r.mailed, 0)).toBe(7)
    expect(await mailsSettle(targetId, 7)).toBe(7)
    const to = kit.capture.sent.filter((m) => m.to.includes(targetId.slice(0, 8))).map((m) => m.to)
    expect(new Set(to).size).toBe(7)
    await age(targetId, 6)
    expect(await mailUnsentLinks()).toEqual({ mailed: 0 })
    expect(await mailsSettle(targetId, 7)).toBe(7)
    const after = await mint(sendOf(targetId, 7))
    expect(after.actions?.map((a) => a.mail)).toEqual(Array(7).fill("sent"))
    expect(after.actions?.map((a) => a.id)).toEqual(out.actions?.map((a) => a.id))
  })

  it("a mail that starts while the job looks goes out once", async () => {
    const targetId = crypto.randomUUID()
    await triggerOnClaim(targetId, "PERFORM pg_sleep(1);")
    await mint(sendOf(targetId, 3))
    await age(targetId, 6)
    await mailUnsentLinks()
    expect(await mailsSettle(targetId, 3)).toBe(3)
    await new Promise((r) => setTimeout(r, 1200))
    expect(linkMails(targetId)).toBe(3)
  })

  it("a link the job took meanwhile is not mailed by the run that made it, and the mailed one opens", async () => {
    const targetId = crypto.randomUUID()
    // The first five mails wait to start; the sixth is still in the run's queue.
    await triggerOnClaim(
      targetId,
      "IF NEW.invited_name <> 'Signer 6' THEN PERFORM pg_sleep(1); END IF;",
    )
    const out = await mint(sendOf(targetId, 6))
    const sixth = out.actions?.[5]?.id ?? ""
    await age(targetId, 6)
    // The job gave it a fresh token and is still reading the document when the run gets to it.
    kit.viewDelayMs = 2_500
    const taken = mailUnsentLink(kit.w.orgId, sixth)
    expect(await taken).toBe(true)
    expect(await mailsSettle(targetId, 6)).toBe(6)
    const mails = kit.capture.sent.filter(
      (m) => m.to === `s6-${targetId.slice(0, 8)}@signers.example`,
    )
    expect(mails).toHaveLength(1)
    const [row] = (await rowsOf(targetId)).filter((r) => r.id === sixth)
    expect(hashToken(tokenOf(mails[0] as (typeof mails)[number]))).toBe(String(row?.token_hash))
  })

  it("withdrawn, answered or long past, they are not mailed", async () => {
    const { targetId, out } = await stoppedBeforeMails(3)
    await sql`UPDATE ${k("client_actions")} SET revoked_at = now(), revoke_reason = 'withdrawn'
               WHERE id = ${out.actions?.[0]?.id ?? ""}`
    await sql`UPDATE ${k("client_actions")} SET decided_at = now(), decision = 'signed'
               WHERE id = ${out.actions?.[1]?.id ?? ""}`
    await age(targetId, 4 * 24 * 60)
    await mailUnsentLinks()
    expect(await mailsSettle(targetId, 0)).toBe(0)
  })

  it("withdrawn or answered while they wait in the send's queue, they are not mailed", async () => {
    const targetId = crypto.randomUUID()
    await triggerOnClaim(targetId, "PERFORM pg_sleep(1);")
    const out = await mint(sendOf(targetId, 8))
    const ids = (out.actions ?? []).map((a) => a.id)
    await revokeClientAction({
      orgId: kit.w.orgId,
      id: ids[6] ?? "",
      reason: "withdrawn",
      byUserId: kit.w.admin.userId,
    })
    await sql`UPDATE ${k("client_actions")} SET decided_at = now(), decision = 'declined'
               WHERE id = ${ids[7] ?? ""}`
    expect(await mailsSettle(targetId, 6)).toBe(6)
    await new Promise((r) => setTimeout(r, 1500))
    expect(linkMails(targetId)).toBe(6)
  }, 20_000)

  it("a mailed link asked for again is mailed again", async () => {
    const targetId = crypto.randomUUID()
    const out = await mint(sendOf(targetId, 1))
    await mailsSettle(targetId, 1)
    const id = out.actions?.[0]?.id ?? ""
    expect(await remailClientAction(kit.w.orgId, id, { resend: true })).toBe(true)
    expect(await mailsSettle(targetId, 2)).toBe(2)
    const last = kit.capture.sent.filter((m) => m.to.includes(targetId.slice(0, 8))).at(-1)
    const [row] = await rowsOf(targetId)
    expect(hashToken(tokenOf(last as NonNullable<typeof last>))).toBe(String(row?.token_hash))
  })

  it("once one signer declined, the others' are not mailed; a new link for that signer opens them", async () => {
    const { targetId, out } = await stoppedBeforeMails(2)
    const [first] = (out.actions ?? []).map((a) => a.id)
    await sql`UPDATE ${k("client_actions")} SET decided_at = now(), decision = 'declined'
               WHERE id = ${first ?? ""}`
    await age(targetId, 6)
    await mailUnsentLinks()
    expect(await mailsSettle(targetId, 0)).toBe(0)
    // Declined without the code: they are asked again, and so is the other signer.
    expect((await mint({ new_link: { after: first } })).status).toBe("ok")
    expect(await mailsSettle(targetId, 1)).toBe(1)
    await mailUnsentLinks()
    expect(await mailsSettle(targetId, 2)).toBe(2)
  })
})

/** The check a card pins for a send, as the app pins it. */
const guardFor = (targetId: string, n: number) => {
  const at = new Date(Date.now() - 60_000).toISOString()
  return {
    v: 1,
    applies: true,
    mode: "plain",
    since: at,
    stagedAt: at,
    addresses: signersOf(targetId, n).map((s) => s.email),
    contactIds: [],
    refs: [],
    classification: "service",
  }
}

/** The card a person approved, with the message its requester typed. */
async function approvedCard(message: string): Promise<string> {
  const id = crypto.randomUUID()
  const thread = crypto.randomUUID()
  await sql`INSERT INTO ${k("threads")} (id, org_id, handle, title, type, created_by)
    VALUES (${thread}, ${kit.w.orgId}, ${`approval-${thread}`}, 'Approval', 'approval', ${kit.w.admin.userId})`
  await sql`INSERT INTO ${k("approval_requests")} (
      id, org_id, handle, thread_id, originating_thread_id, tool_name, tool_params, current_payload,
      expires_at, requested_by, status, summary)
    VALUES (${id}, ${kit.w.orgId}, ${`APR-${id.slice(0, 8)}`}, ${thread}, ${thread},
      ${`${kit.targetApp}:${SEND_TOOL}`}, '{}'::jsonb,
      ${JSON.stringify({ message })}::text::jsonb,
      now() + interval '1 hour', ${kit.w.admin.userId}, 'approved', '{}'::jsonb)`
  return id
}

/** One of the signers writes to the organization after the card. */
async function writesBack(email: string): Promise<void> {
  const { accountId } = await mailboxOf(
    kit,
    kit.w.admin.userId,
    `desk-${crypto.randomUUID().slice(0, 8)}@own.example`,
  )
  await syncPage(kit, accountId, kit.w.admin.userId, [
    syncedCopyOf(
      { to: "desk@own.example", subject: "Wait", html: "<p>Wait</p>", text: "Please wait." },
      { from: { email } },
    ),
  ])
}

/** The words told when a link did not go. */
const notSentTold = async (id: string) =>
  (
    (await sql`
      SELECT id FROM kernel.pending_events
       WHERE org_id = ${kit.w.orgId} AND payload->>'entityId' = ${id}
         AND payload->>'action' = 'send_failed'`) as unknown as unknown[]
  ).length

describe("a link mailed later than its approval", () => {
  afterAll(async () => {
    await sql`DELETE FROM ${k("approval_requests")} WHERE org_id = ${kit.w.orgId}`
    // Who wrote became a contact of that mailbox's person alone.
    for (const table of ["messages", "conversations"])
      await sql`DELETE FROM ${sql(`${schemaRef("app_mail")}.${table}`)} WHERE org_id = ${kit.w.orgId}`
    await sql`DELETE FROM ${k("contacts")}
               WHERE org_id = ${kit.w.orgId} AND email LIKE '%@signers.example'
                 AND owner_user_id IS NOT NULL`
  })

  const late = (n: number, message: string, approvalId?: string) =>
    stoppedBeforeMails(n, {
      approvalId,
      extra: (targetId) => ({ message, send_guard: guardFor(targetId, n) }),
    })

  it("carries the message of the card that was approved, and only that one", async () => {
    const card = await approvedCard("See you on Monday.")
    const same = await late(1, "See you on Monday.", card)
    const other = await late(1, "Another message.", card)
    const unkept = await late(1, "Typed on the screen.")
    for (const t of [same, other, unkept]) await age(t.targetId, 6)
    await mailUnsentLinks()
    const textOf = (targetId: string) =>
      kit.capture.sent.find((m) => m.to.includes(targetId.slice(0, 8)))?.text ?? ""
    for (const t of [same, other, unkept]) expect(await mailsSettle(t.targetId, 1)).toBe(1)
    expect(textOf(same.targetId)).toContain("See you on Monday.")
    expect(textOf(other.targetId)).not.toContain("Monday")
    expect(textOf(other.targetId)).not.toContain("Another message.")
    expect(textOf(unkept.targetId)).not.toContain("Typed on the screen.")
    // The message itself is never kept with the link.
    const kept = (await sql`
      SELECT meta::text AS meta FROM ${k("client_action_events")}
       WHERE action_id = ${same.out.actions?.[0]?.id ?? ""}`) as unknown as Array<{ meta: string }>
    expect(kept.map((e) => e.meta).join()).not.toContain("Monday")
    expect(kept.map((e) => e.meta).join()).not.toContain("signers.example")
  })

  it("does not go once a signer wrote since the card: the links stay unsent, their sender told once", async () => {
    const { targetId, out } = await late(2, "Hello")
    await writesBack(signersOf(targetId, 2)[1]?.email ?? "")
    await age(targetId, 6)
    const ids = (out.actions ?? []).map((a) => a.id) as [string, string]
    for (let i = 0; i < 2; i++) {
      await mailUnsentLinks()
      expect(await mailsSettle(targetId, 0)).toBe(0)
      expect([await notSentTold(ids[0]), await notSentTold(ids[1])]).toEqual([1, 1])
      await age(targetId, 6)
    }
    expect((await mint(sendOf(targetId, 2))).actions?.map((a) => a.mail)).toEqual([
      "failed",
      "failed",
    ])
    // The person who decides to ask all the same reminds them.
    expect((await mint({ remind: { ids } })).reminded).toHaveLength(2)
    expect(await mailsSettle(targetId, 2)).toBe(2)
  })

  it("is not looked at when it is locked, or a member's own: nobody is told", async () => {
    const { targetId, out } = await late(2, "Hello")
    for (const s of signersOf(targetId, 2)) await writesBack(s.email)
    const [locked, own] = (out.actions ?? []).map((a) => a.id) as [string, string]
    await sql`UPDATE ${k("client_actions")} SET code_locked_at = now() WHERE id = ${locked}`
    await sql`UPDATE ${k("client_actions")} SET signer_user_id = ${kit.w.admin.userId} WHERE id = ${own}`
    await age(targetId, 6)
    await mailUnsentLinks()
    expect(await mailsSettle(targetId, 0)).toBe(0)
    expect(await notSentTold(locked)).toBe(0)
    expect(await notSentTold(own)).toBe(0)
  })

  it("a reminder cut off before its mails is held to the reminder's own check", async () => {
    const targetId = crypto.randomUUID()
    const out = await mint(sendOf(targetId, 1, { send_guard: guardFor(targetId, 1) }))
    await mailsSettle(targetId, 1)
    const id = out.actions?.[0]?.id ?? ""
    await writesBack(signersOf(targetId, 1)[0]?.email ?? "")
    // Their mail was read before the reminder's card: it is no reason not to remind them.
    const later = new Date(Date.now() + 1000).toISOString()
    const guard = { ...guardFor(targetId, 1), since: later, stagedAt: later }
    await triggerOnClaim(targetId, "RAISE EXCEPTION 'the server stopped';")
    expect((await mint({ remind: { ids: [id], send_guard: guard } })).reminded).toHaveLength(1)
    expect(await mailsSettle(targetId, 1)).toBe(1)
    await dropTrigger()
    await age(targetId, 6)
    await mailUnsentLinks()
    expect(await mailsSettle(targetId, 2)).toBe(2)
    expect(await notSentTold(id)).toBe(0)
    // One they wrote after holds it back.
    await triggerOnClaim(targetId, "RAISE EXCEPTION 'the server stopped';")
    await age(targetId, 20)
    const since = { ...guardFor(targetId, 1) }
    expect((await mint({ remind: { ids: [id], send_guard: since } })).error?.code).toBe(
      "SEND_GUARD_REPLIED",
    )
    const soon = { ...since, since: new Date().toISOString(), stagedAt: new Date().toISOString() }
    expect((await mint({ remind: { ids: [id], send_guard: soon } })).reminded).toHaveLength(1)
    await writesBack(signersOf(targetId, 1)[0]?.email ?? "")
    await dropTrigger()
    await age(targetId, 6)
    await mailUnsentLinks()
    expect(await mailsSettle(targetId, 2)).toBe(2)
    expect(await notSentTold(id)).toBe(1)
  })
})

describe("a link whose mail failed", () => {
  it("is said to have failed, not to stand, and a reminder a moment later mails it again", async () => {
    const targetId = crypto.randomUUID()
    const failing = `s2-${targetId.slice(0, 8)}@signers.example`
    const real = kit.capture.send.bind(kit.capture)
    kit.capture.send = async (m) => {
      if (m.to === failing) throw new Error("mailbox unavailable")
      return real(m)
    }
    try {
      const out = await mint(sendOf(targetId, 2))
      const ids = (out.actions ?? []).map((a) => a.id)
      const failed = async () =>
        (
          await sql`SELECT 1 FROM ${k("client_action_events")}
            WHERE action_id = ${ids[1] ?? ""} AND event = 'rotated'
              AND meta->>'reason' = 'send_failed'`
        ).length
      const failures = async (n: number) => {
        const end = Date.now() + 5_000
        while ((await failed()) < n && Date.now() < end) await new Promise((r) => setTimeout(r, 25))
        expect(await failed()).toBe(n)
      }
      await failures(1)
      const again = await mint(sendOf(targetId, 2))
      expect(again.actions?.map((a) => a.mail)).toEqual(["sent", "failed"])
      // A failed mail was told to its sender: it is not one to mail by itself.
      await age(targetId, 6)
      await mailUnsentLinks()
      expect(await mailsSettle(targetId, 1)).toBe(1)
      // Reminded twice in a row while the mail fails: each time it is mailed, never "minutes ago".
      for (const n of [2, 3]) {
        const r = await mint({ remind: { ids: [ids[1]] } })
        expect(r.reminded).toHaveLength(1)
        expect(r.recently_mailed).toEqual([])
        await failures(n)
      }
    } finally {
      kit.capture.send = real
    }
  })
})

describe("a first mail that fails after a later one went", () => {
  it("leaves the later link open and tells nobody that it failed", async () => {
    const targetId = crypto.randomUUID()
    const to = `s1-${targetId.slice(0, 8)}@signers.example`
    const real = kit.capture.send.bind(kit.capture)
    let fail: () => void = () => {}
    let held = false
    const hung = new Promise<void>((_ok, no) => {
      fail = () => no(new Error("the provider gave up"))
    })
    kit.capture.send = async (m) => {
      if (m.to === to && !held) {
        held = true
        return hung
      }
      return real(m)
    }
    try {
      const out = await mint(sendOf(targetId, 1))
      const id = out.actions?.[0]?.id ?? ""
      const end = Date.now() + 5_000
      while (!held && Date.now() < end) await new Promise((r) => setTimeout(r, 25))
      expect((await mint({ remind: { ids: [id] } })).reminded).toHaveLength(1)
      expect(await mailsSettle(targetId, 1)).toBe(1)
      fail()
      await new Promise((r) => setTimeout(r, 500))
      const mail = kit.capture.sent.find((m) => m.to === to)
      const [row] = await rowsOf(targetId)
      expect(hashToken(tokenOf(mail as NonNullable<typeof mail>))).toBe(String(row?.token_hash))
      expect(await notSentTold(id)).toBe(0)
      expect((await mint(sendOf(targetId, 1))).actions?.map((a) => a.mail)).toEqual(["sent"])
    } finally {
      kit.capture.send = real
    }
  })

  it("a mail that left after a failed one is recent: the next reminder leaves it alone", async () => {
    const targetId = crypto.randomUUID()
    const to = `s1-${targetId.slice(0, 8)}@signers.example`
    const real = kit.capture.send.bind(kit.capture)
    kit.capture.send = async (m) => {
      if (m.to === to) throw new Error("mailbox unavailable")
      return real(m)
    }
    const out = await mint(sendOf(targetId, 1)).finally(async () => {
      await new Promise((r) => setTimeout(r, 500))
      kit.capture.send = real
    })
    const id = out.actions?.[0]?.id ?? ""
    expect(await notSentTold(id)).toBe(1)
    expect((await mint({ remind: { ids: [id] } })).reminded).toHaveLength(1)
    expect(await mailsSettle(targetId, 1)).toBe(1)
    const again = await mint({ remind: { ids: [id] } })
    expect(again.reminded).toEqual([])
    expect(again.recently_mailed).toHaveLength(1)
    expect(await mailsSettle(targetId, 1)).toBe(1)
  })
})

describe("who the signers are", () => {
  it("two people at one address are two signers, each with their own link and mail", async () => {
    const targetId = crypto.randomUUID()
    const email = `couple-${targetId.slice(0, 8)}@signers.example`
    const signers = [
      { email, name: "Anne Couple" },
      { email, name: "Jean Couple" },
      { email, name: " anne couple " },
    ]
    for (const order of ["any", "sequential"]) {
      const id = order === "any" ? targetId : crypto.randomUUID()
      const out = await mint(sendOf(id, 0, { signers, order }))
      expect(out.actions?.map((a) => a.invited_name)).toEqual(["Anne Couple", "Jean Couple"])
      expect(out.actions?.map((a) => a.status)).toEqual([
        "open",
        order === "any" ? "open" : "waiting_turn",
      ])
      expect(await rowsOf(id)).toHaveLength(2)
      const again = await mint(sendOf(id, 0, { signers: signers.slice(0, 2).reverse(), order }))
      expect(again).toMatchObject({ status: "ok", already_sent: true })
      const alone = await mint(sendOf(id, 0, { signers: signers.slice(0, 1), order }))
      expect(alone.error?.code).toBe("ALREADY_SENT")
      expect(await rowsOf(id)).toHaveLength(2)
    }
    expect(await mailsSettle(targetId, 2)).toBeGreaterThanOrEqual(2)
  })

  it("signers in any order are kept in the order they were named", async () => {
    const targetId = crypto.randomUUID()
    await mint(sendOf(targetId, 12))
    const again = await mint(sendOf(targetId, 12))
    expect(again.actions?.map((a) => a.invited_name)).toEqual(
      signersOf(targetId, 12).map((s) => s.name),
    )
    const listed = JSON.parse(
      await bridge().client_actions_record(
        JSON.stringify({ target_type: kit.targetType, target_id: targetId }),
      ),
    ) as { links: Array<{ invited_name: string; send_size: number }> }
    expect(listed.links.map((l) => l.invited_name)).toEqual(
      signersOf(targetId, 12).map((s) => s.name),
    )
    expect(listed.links.map((l) => l.send_size)).toEqual(Array(12).fill(12))
  })

  it("the same signers asked to accept instead of sign are another send", async () => {
    const targetId = crypto.randomUUID()
    await mint(sendOf(targetId, 2))
    const out = await mint(sendOf(targetId, 2, { kind: "accept" }))
    expect(out.error?.code).toBe("ALREADY_SENT")
    expect(await rowsOf(targetId)).toHaveLength(2)
  })

  it("a signer moved to a corrected address counts there, not at the address replaced", async () => {
    // Their first link still open, or declined without the code: it is replaced either way.
    for (const declined of [false, true]) {
      const targetId = crypto.randomUUID()
      const out = await mint(sendOf(targetId, 2))
      await mailsSettle(targetId, 2)
      const first = out.actions?.[0]?.id ?? ""
      if (declined)
        await sql`UPDATE ${k("client_actions")} SET decided_at = now(), decision = 'declined'
                   WHERE id = ${first}`
      const fixed = `fixed-${targetId.slice(0, 8)}@signers.example`
      const moved = await mint({ new_link: { after: first, email: fixed } })
      expect(moved.status).toBe("ok")
      const [, second] = signersOf(targetId, 2)
      const again = await mint(
        sendOf(targetId, 2, { signers: [{ email: fixed, name: "Signer 1" }, second] }),
      )
      expect(again).toMatchObject({ status: "ok", already_sent: true })
      expect(again.actions).toHaveLength(2)
      expect((await mint(sendOf(targetId, 2))).error?.code).toBe("ALREADY_SENT")
    }
  })

  it("a restricted document's send names its readers in the word the app hears", async () => {
    const targetId = crypto.randomUUID()
    const readers = [kit.w.admin.userId]
    await mint(sendOf(targetId, 1, { visible_to: readers }))
    const [e] = (await sql`
      SELECT payload FROM kernel.pending_events
       WHERE org_id = ${kit.w.orgId} AND payload::text LIKE ${`%${targetId}%`}
         AND payload::text LIKE '%links_made%'`) as unknown as Array<{
      payload: { data: { visibleTo?: string[] } }
    }>
    expect(e?.payload.data.visibleTo).toEqual(readers)
  })
})

describe("a new link in the turn of a send one after the other", () => {
  const state = async (id: string) =>
    (
      (await sql`SELECT token_hash, revoked_at FROM ${k("client_actions")}
        WHERE id = ${id}`) as unknown as Array<{
        token_hash: string | null
        revoked_at: Date | null
      }>
    )[0]

  it("a withdrawn signer whose turn has not come waits for it, with no link and no mail", async () => {
    const targetId = crypto.randomUUID()
    const out = await mint(sendOf(targetId, 3, { order: "sequential" }))
    const [first, second] = (out.actions ?? []).map((a) => a.id)
    expect(await mailsSettle(targetId, 1)).toBe(1)
    await revokeClientAction({
      orgId: kit.w.orgId,
      id: second ?? "",
      reason: "withdrawn",
      byUserId: kit.w.admin.userId,
    })
    const again = await mint({ new_link: { after: second } })
    expect(again).toMatchObject({ status: "ok", action: { status: "waiting_turn" } })
    const placed = again.action?.id ?? ""
    expect((await state(placed))?.token_hash).toBeNull()
    expect(await mailsSettle(targetId, 1)).toBe(1)
    await sql`UPDATE ${k("client_actions")} SET decided_at = now(), decision = 'signed'
               WHERE id = ${first ?? ""}`
    const turn = await mint({ next_turn_after: first })
    expect(turn.opened_id).toBe(placed)
    expect(await mailsSettle(targetId, 2)).toBe(2)
  })

  it("asked twice it is one link; another address in a place already taken is refused", async () => {
    const targetId = crypto.randomUUID()
    const out = await mint(sendOf(targetId, 2))
    await mailsSettle(targetId, 2)
    const first = out.actions?.[0]?.id ?? ""
    const outs = await Promise.all([
      mint({ new_link: { after: first } }),
      mint({ new_link: { after: first } }),
    ])
    expect(outs.map((o) => o.status)).toEqual(["ok", "ok"])
    expect(new Set(outs.map((o) => o.action?.id)).size).toBe(1)
    expect(await mailsSettle(targetId, 3)).toBe(3)
    const other = await mint({
      new_link: { after: first, email: `x-${targetId.slice(0, 8)}@signers.example` },
    })
    expect(other.error?.code).toBe("ALREADY_REPLACED")
    expect(await rowsOf(targetId)).toHaveLength(3)
    expect((await state(first))?.revoked_at).not.toBeNull()
  })

  it("a document that reads differently now withdraws nothing", async () => {
    const targetId = crypto.randomUUID()
    const out = await mint(sendOf(targetId, 1))
    await mailsSettle(targetId, 1)
    kit.view = { ...kit.view, sha256: "d".repeat(64) }
    const first = out.actions?.[0]?.id ?? ""
    expect((await mint({ new_link: { after: first } })).error?.code).toBe("VERSION_CHANGED")
    expect((await state(first))?.revoked_at).toBeNull()
  })
})

/** Moves the end of one link into the past. */
const runOut = (id: string) =>
  sql`UPDATE ${k("client_actions")} SET expires_at = now() - interval '1 hour' WHERE id = ${id}`

describe("a new link, as things stand", () => {
  it("a signer whose link ran out before their turn gets a new one, and it opens at their turn or now", async () => {
    for (const firstSigned of [false, true]) {
      const targetId = crypto.randomUUID()
      const out = await mint(sendOf(targetId, 2, { order: "sequential" }))
      const [first, second] = (out.actions ?? []).map((a) => a.id) as [string, string]
      await mailsSettle(targetId, 1)
      const early = await mint({ new_link: { after: second } })
      expect(early.error?.code).toBe("NOT_THEIR_TURN")
      await runOut(second)
      const sign = () =>
        sql`UPDATE ${k("client_actions")} SET decided_at = now(), decision = 'signed'
             WHERE id = ${first}`
      if (firstSigned) await sign()
      const again = await mint({ new_link: { after: second } })
      expect(again.action?.status).toBe(firstSigned ? "open" : "waiting_turn")
      if (!firstSigned) {
        await sign()
        expect((await mint({ next_turn_after: first })).opened_id).toBe(again.action?.id)
      }
      expect(await mailsSettle(targetId, 2)).toBe(2)
    }
  })

  it("an address corrected to another signer's own is refused, and withdraws nothing", async () => {
    for (const ranOut of [false, true]) {
      const targetId = crypto.randomUUID()
      const at = (n: number) => `sam${n}-${targetId.slice(0, 8)}@signers.example`
      const signers = [
        { email: at(1), name: "Sam Same" },
        { email: at(2), name: "Sam Same" },
      ]
      const out = await mint(sendOf(targetId, 0, { signers }))
      const [first, second] = (out.actions ?? []).map((a) => a.id) as [string, string]
      await mailsSettle(targetId, 2)
      if (ranOut) await runOut(second)
      const moved = await mint({ new_link: { after: first, email: at(2) } })
      expect(moved.error?.code).toBe("HOLDS_A_LINK")
      const rows = await rowsOf(targetId)
      expect(rows).toHaveLength(2)
      expect(rows.every((r) => r.revoked_at === null)).toBe(true)
      expect(await mailsSettle(targetId, 2)).toBe(2)
    }
  })

  it("an answer given while the document is read again is kept: no new link is made", async () => {
    const targetId = crypto.randomUUID()
    const out = await mint(sendOf(targetId, 1))
    const first = out.actions?.[0]?.id ?? ""
    await mailsSettle(targetId, 1)
    kit.viewDelayMs = 800
    const asked = mint({ new_link: { after: first } })
    await new Promise((r) => setTimeout(r, 300))
    await sql`UPDATE ${k("client_actions")} SET decided_at = now(), decision = 'signed'
               WHERE id = ${first}`
    expect((await asked).error?.code).toBe("ALREADY_DECIDED")
    expect(await rowsOf(targetId)).toHaveLength(1)
    expect(await mailsSettle(targetId, 1)).toBe(1)
  })

  it("the app hears of it as of a send, once, with the document's readers", async () => {
    const targetId = crypto.randomUUID()
    const out = await mint(sendOf(targetId, 2, { visible_to: [kit.w.admin.userId] }))
    const [first, second] = (out.actions ?? []).map((a) => a.id) as [string, string]
    expect(await sentEvents(targetId)).toHaveLength(1)
    for (let i = 0; i < 2; i++) await mint({ new_link: { after: first } })
    expect(await sentEvents(targetId)).toHaveLength(2)
    await revokeClientAction({
      orgId: kit.w.orgId,
      id: second,
      reason: "withdrawn",
      byUserId: kit.w.admin.userId,
    })
    const signer = { email: `p-${targetId.slice(0, 8)}@signers.example`, name: "Pat Proxy" }
    for (let i = 0; i < 2; i++) await mint({ replace_signer: { after: second, signer } })
    expect(await sentEvents(targetId)).toHaveLength(3)
    const told = (await sql`
      SELECT payload FROM kernel.pending_events
       WHERE org_id = ${kit.w.orgId} AND payload::text LIKE ${`%${targetId}%`}
         AND payload::text LIKE '%links_made%'`) as unknown as Array<{
      payload: { data: { visibleTo?: string[] } }
    }>
    for (const e of told) expect(e.payload.data.visibleTo).toEqual([kit.w.admin.userId])
  })
})

describe("another person in a withdrawn signer's place", () => {
  const withdraw = (id: string, reason: "withdrawn" | "replaced" | "sender_voided" = "withdrawn") =>
    revokeClientAction({ orgId: kit.w.orgId, id, reason, byUserId: kit.w.admin.userId })
  const proxyOf = (targetId: string) => ({
    email: `proxy-${targetId.slice(0, 8)}@signers.example`,
    name: "Pat Proxy",
  })
  const place = (after: string, signer: object) => mint({ replace_signer: { after, signer } })

  it("takes the same turn, group, phrase and fingerprint, and the turns go on", async () => {
    const targetId = crypto.randomUUID()
    const out = await mint(
      sendOf(targetId, 3, { order: "sequential", required_phrase: "Bon pour accord" }),
    )
    const [first, second, third] = (out.actions ?? []).map((a) => a.id) as [string, string, string]
    await mailsSettle(targetId, 1)
    await withdraw(first)
    const placed = await place(first, proxyOf(targetId))
    expect(placed).toMatchObject({
      status: "ok",
      replaced_id: first,
      action: { status: "open", invited_name: "Pat Proxy" },
    })
    expect(await mailsSettle(targetId, 2)).toBe(2)
    const id = placed.action?.id ?? ""
    const rows = (await sql`
      SELECT id, group_id, sign_order, kind, target_sha256, required_phrase
        FROM ${k("client_actions")} WHERE id IN (${first}, ${id})`) as unknown as Array<
      Record<string, unknown>
    >
    const [a, b] = [rows.find((r) => r.id === first), rows.find((r) => r.id === id)]
    expect({ ...b, id: null }).toEqual({ ...a, id: null })
    // Asked again (its answer lost), it is the same link, and nobody is mailed.
    expect((await place(first, proxyOf(targetId))).action).toMatchObject({ id, deduped: true })
    // Another person in a place already taken is refused.
    expect((await place(first, { email: "q@signers.example" })).error?.code).toBe(
      "ALREADY_REPLACED",
    )
    await sql`UPDATE ${k("client_actions")} SET decided_at = now(), decision = 'signed'
               WHERE id = ${id}`
    expect((await mint({ next_turn_after: id })).opened_id).toBe(second)
    // One who waits is withdrawn and replaced: the proxy waits too, then is asked.
    await withdraw(third)
    const late = await place(third, { email: `late-${targetId.slice(0, 8)}@signers.example` })
    expect(late.action?.status).toBe("waiting_turn")
    expect(await mailsSettle(targetId, 3)).toBe(3)
    await sql`UPDATE ${k("client_actions")} SET decided_at = now(), decision = 'signed'
               WHERE id = ${second}`
    expect((await mint({ next_turn_after: second })).opened_id).toBe(late.action?.id)
    expect(await mailsSettle(targetId, 4)).toBe(4)
  })

  it("refuses anyone who holds a link of the send, open or waiting, and a signer not withdrawn", async () => {
    for (const order of ["any", "sequential"]) {
      const targetId = crypto.randomUUID()
      const out = await mint(sendOf(targetId, 3, { order }))
      const [first, second, third] = (out.actions ?? []).map((a) => a.id) as [
        string,
        string,
        string,
      ]
      const holder = signersOf(targetId, 2)[1] as { email: string; name: string }
      expect((await place(first, proxyOf(targetId))).error?.code).toBe("SIGNER_NOT_WITHDRAWN")
      await withdraw(first)
      for (const name of [holder.name, "Another Name"])
        expect((await place(first, { email: holder.email.toUpperCase(), name })).error?.code).toBe(
          "HOLDS_A_LINK",
        )
      for (const reason of ["replaced", "sender_voided"] as const) {
        const id = reason === "replaced" ? second : third
        await withdraw(id, reason)
        expect((await place(id, proxyOf(targetId))).error?.code).toBe("SIGNER_NOT_WITHDRAWN")
      }
      expect(await rowsOf(targetId)).toHaveLength(3)
    }
  })

  it("a signer who answered is never replaced, and one who signed may sign for a withdrawn one", async () => {
    const targetId = crypto.randomUUID()
    const out = await mint(sendOf(targetId, 2))
    const [first, second] = (out.actions ?? []).map((a) => a.id) as [string, string]
    await sql`UPDATE ${k("client_actions")} SET decided_at = now(), decision = 'signed'
               WHERE id = ${first}`
    expect((await place(first, proxyOf(targetId))).error?.code).toBe("SIGNER_NOT_WITHDRAWN")
    await withdraw(second)
    const [signed] = signersOf(targetId, 1)
    expect((await place(second, signed as object)).status).toBe("ok")
  })

  it("a place whose link ended is asked again on that link, not on the one it replaced", async () => {
    const targetId = crypto.randomUUID()
    const out = await mint(sendOf(targetId, 1))
    const first = out.actions?.[0]?.id ?? ""
    await withdraw(first)
    const placed = (await place(first, proxyOf(targetId))).action?.id ?? ""
    await withdraw(placed)
    expect((await place(first, proxyOf(targetId))).error?.code).toBe("ALREADY_REPLACED")
    expect((await mint({ new_link: { after: placed } })).status).toBe("ok")
  })

  it("the signer before signs while the proxy is being written: the proxy is asked", async () => {
    const targetId = crypto.randomUUID()
    const out = await mint(sendOf(targetId, 3, { order: "sequential" }))
    const [first, second] = (out.actions ?? []).map((a) => a.id) as [string, string]
    await mailsSettle(targetId, 1)
    await withdraw(second)
    await triggerAfter(targetId, 3, "PERFORM pg_sleep(1.5);")
    const placing = place(second, proxyOf(targetId))
    await new Promise((r) => setTimeout(r, 600))
    await sql`UPDATE ${k("client_actions")} SET decided_at = now(), decision = 'signed'
               WHERE id = ${first}`
    const opened = await mint({ next_turn_after: first })
    const placed = await placing
    expect(placed.status).toBe("ok")
    expect(opened.opened_id).toBe(placed.action?.id)
    expect(await mailsSettle(targetId, 2)).toBe(2)
  })

  it("a proxy after a proxy is asked once the first one signed", async () => {
    const targetId = crypto.randomUUID()
    const out = await mint(sendOf(targetId, 2, { order: "sequential" }))
    const [first, second] = (out.actions ?? []).map((a) => a.id) as [string, string]
    await withdraw(first)
    const one = (await place(first, proxyOf(targetId))).action?.id ?? ""
    await sql`UPDATE ${k("client_actions")} SET decided_at = now(), decision = 'signed'
               WHERE id = ${one}`
    expect((await mint({ next_turn_after: one })).opened_id).toBe(second)
    await withdraw(second)
    const two = await place(second, { email: `q-${targetId.slice(0, 8)}@signers.example` })
    expect(two.action?.status).toBe("open")
  })

  it("a signer whose own link ran out still holds their place", async () => {
    const targetId = crypto.randomUUID()
    const out = await mint(sendOf(targetId, 2))
    const [first, second] = (out.actions ?? []).map((a) => a.id) as [string, string]
    await withdraw(first)
    await runOut(second)
    const [, holder] = signersOf(targetId, 2)
    for (const name of [holder?.name, "Another Name"])
      expect((await place(first, { email: holder?.email, name })).error?.code).toBe("HOLDS_A_LINK")
    expect((await mint({ new_link: { after: second } })).action?.deduped).toBe(false)
  })

  it("a contact who holds a link at an address they left holds it all the same", async () => {
    const targetId = crypto.randomUUID()
    const contact = crypto.randomUUID()
    const at = (n: number) => `c${n}-${targetId.slice(0, 8)}@signers.example`
    await sql`INSERT INTO ${k("contacts")} (id, org_id, handle, name, email)
      VALUES (${contact}, ${kit.w.orgId}, ${`contact-${contact.slice(0, 8)}`}, 'Cleo Contact', ${at(1)})`
    const out = await mint(
      sendOf(targetId, 0, { signers: [...signersOf(targetId, 1), { contact_id: contact }] }),
    )
    const first = out.actions?.[0]?.id ?? ""
    await withdraw(first)
    await sql`UPDATE ${k("contacts")} SET email = ${at(2)} WHERE id = ${contact}`
    expect((await place(first, { contact_id: contact })).error?.code).toBe("HOLDS_A_LINK")
  })

  it("a link a later one replaced, left open by an earlier release, holds nobody", async () => {
    const targetId = crypto.randomUUID()
    const out = await mint(sendOf(targetId, 2))
    const [first, second] = (out.actions ?? []).map((a) => a.id) as [string, string]
    const fixed = `fixed-${targetId.slice(0, 8)}@signers.example`
    expect((await mint({ new_link: { after: second, email: fixed } })).status).toBe("ok")
    await sql`UPDATE ${k("client_actions")} SET revoked_at = NULL, revoke_reason = NULL, revoked_by = NULL
               WHERE id = ${second}`
    await withdraw(first)
    const [, left] = signersOf(targetId, 2)
    expect((await place(first, left as object)).status).toBe("ok")
  })

  it("two proxies at the same moment: one takes the place", async () => {
    const targetId = crypto.randomUUID()
    const out = await mint(sendOf(targetId, 1))
    const first = out.actions?.[0]?.id ?? ""
    await withdraw(first)
    const outs = await Promise.all([
      place(first, proxyOf(targetId)),
      place(first, { email: `other-${targetId.slice(0, 8)}@signers.example` }),
    ])
    expect(outs.map((o) => o.error?.code ?? "ok").sort()).toEqual(["ALREADY_REPLACED", "ok"])
    expect(await rowsOf(targetId)).toHaveLength(2)
  })
})

describe("a reminder's check", () => {
  it("stops it before any link is replaced, and covers every address it mails", async () => {
    const targetId = crypto.randomUUID()
    const out = await mint(sendOf(targetId, 2))
    const ids = (out.actions ?? []).map((a) => a.id)
    await mailsSettle(targetId, 2)
    const before = (await rowsOf(targetId)).map((r) => r.token_hash).sort()
    const stopped = await remindClientActions({
      orgId: kit.w.orgId,
      targetApp: kit.targetApp,
      ids,
      check: async () => ({ code: "SEND_GUARD_REPLIED", message: "They wrote back." }),
    })
    expect(stopped).toEqual({
      stopped: { code: "SEND_GUARD_REPLIED", message: "They wrote back." },
    })
    expect((await rowsOf(targetId)).map((r) => r.token_hash).sort()).toEqual(before)
    // The second link is locked when the check reads the addresses, and open again right after.
    await sql`UPDATE ${k("client_actions")} SET code_locked_at = now() WHERE id = ${ids[1] ?? ""}`
    let covered: string[] = []
    const r = await remindClientActions({
      orgId: kit.w.orgId,
      targetApp: kit.targetApp,
      ids,
      check: async (emails) => {
        covered = emails
        await sql`UPDATE ${k("client_actions")} SET code_locked_at = NULL WHERE id = ${ids[1] ?? ""}`
        return null
      },
    })
    expect(covered).toEqual([`s1-${targetId.slice(0, 8)}@signers.example`])
    expect("reminded" in r ? r.reminded.map((x) => x.id) : []).toEqual([ids[0] ?? ""])
    expect(await mailsSettle(targetId, 3)).toBe(3)
  })
})
