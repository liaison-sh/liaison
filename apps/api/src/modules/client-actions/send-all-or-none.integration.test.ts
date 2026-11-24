// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A send of many signers through the bridge (bridge/client-actions.ts), on real rows: the
// document is read once for the whole send; a failure or a cancelled write after any number of
// signers leaves none of them, no mail and no event; the same send again, at the same moment or
// later, makes and mails nothing more, a signer who answered included; other signers on a
// document already sent are refused. A reminder of many signers reads the document once, and
// the same reminder again mails nobody twice.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import postgres from "postgres"
import { sql } from "~/db"
import { env } from "~/lib/env"
import { toolRegistry } from "~/modules/apps/app-registries"
import { createClientActionsMethods } from "~/modules/apps/sandbox/bridge/client-actions"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import { ClientActionTargetsTestAccess } from "~/modules/client-actions/targets"
import { superuserUrlForTestDb } from "~/tests/route-test-setup"
import { k, useClientActionWorld } from "../../../test-support/client-actions-kit"

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
  ClientActionTargetsTestAccess.set(kit.targetApp, kit.targetType, ["sign"], async () => {
    views += 1
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

const bridge = () =>
  createClientActionsMethods({
    appName: kit.targetApp,
    orgId: kit.w.orgId,
    userId: kit.w.admin.userId,
    approvalContext: {
      approvalRequestId: crypto.randomUUID(),
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
  actions?: Array<{ id: string; status: string; invited_email: string; deduped: boolean }>
  reminded?: Array<{ id: string }>
  recently_mailed?: Array<{ id: string }>
}

const signersOf = (targetId: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({
    email: `s${i + 1}-${targetId.slice(0, 8)}@signers.example`,
    name: `Signer ${i + 1}`,
  }))

async function mint(payload: unknown): Promise<Answer> {
  return JSON.parse(await bridge().client_actions_mint(JSON.stringify(payload))) as Answer
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
    expect(await rowsOf(targetId)).toHaveLength(3)
    expect(await mailsSettle(targetId, 3)).toBe(3)
  })

  it("other signers on a document already sent are refused, and nothing is sent", async () => {
    const targetId = crypto.randomUUID()
    await mint(sendOf(targetId, 2))
    await mailsSettle(targetId, 2)
    const more = await mint(sendOf(targetId, 3))
    expect(more.error?.code).toBe("ALREADY_SENT")
    const fewer = await mint(sendOf(targetId, 1))
    expect(fewer.error?.code).toBe("ALREADY_SENT")
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
