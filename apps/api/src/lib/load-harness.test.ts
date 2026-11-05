// SPDX-License-Identifier: FSL-1.1-ALv2
// The load harness is safe to switch on in production (P3 T17, A13): a flagged
// org's outside effects go to the sink and nowhere else, an unflagged org is
// untouched, the flag does nothing without the box key, and a request signed
// with the key is refused when it is forged, stale or replayed.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { generateText } from "ai"
import { sql } from "~/db"
import { type EmailMessage, type EmailProvider, sendEmailOnce } from "~/infra/email"
import { sinkCount } from "~/lib/effect-sink"
import {
  HARNESS_HEADER_NONCE,
  HARNESS_HEADER_SIGNATURE,
  HARNESS_HEADER_TIMESTAMP,
  isLoadOrg,
  LoadHarnessTestAccess,
  LoadOrgFlagUnreadable,
  signHarnessRequest,
  verifyHarnessSignature,
} from "~/lib/load-harness"
import { LOAD_SCRIPT_REPLIES, loadScriptFor } from "~/modules/agent/providers/load-scripts"
import { resolveModelFromCredit } from "~/modules/agent/providers/provider"
import { markOrgAsDemo, visitorMarker } from "~/modules/demo/demo-org"

const KEY = crypto.randomBytes(32).toString("hex")
const LOAD_ORG = crypto.randomUUID()
const REAL_ORG = crypto.randomUUID()

class Capturing implements EmailProvider {
  sent: EmailMessage[] = []
  async send(m: EmailMessage): Promise<void> {
    this.sent.push(m)
  }
  async verify(): Promise<boolean> {
    return true
  }
}

function mail(key: string): EmailMessage {
  return { to: "someone@example.com", subject: "s", html: "<p>x</p>", idempotencyKey: key }
}

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug, settings) VALUES
    (${LOAD_ORG}, 'Load org', ${`load-${LOAD_ORG.slice(0, 8)}`}, ${JSON.stringify({ loadHarness: true })}::jsonb),
    (${REAL_ORG}, 'Real org', ${`real-${REAL_ORG.slice(0, 8)}`}, '{}'::jsonb)`
})

afterEach(() => LoadHarnessTestAccess.setKey(undefined))

afterAll(async () => {
  await sql`DELETE FROM kernel.organizations WHERE id IN (${LOAD_ORG}, ${REAL_ORG})`
})

describe("the load org flag", () => {
  it("a flagged org's mail goes to the sink, an unflagged org's to the provider", async () => {
    LoadHarnessTestAccess.setKey(KEY)
    const provider = new Capturing()
    const k1 = `t:${crypto.randomUUID()}`
    const k2 = `t:${crypto.randomUUID()}`
    expect(await sendEmailOnce(LOAD_ORG, provider, mail(k1))).toBe("sunk")
    expect(provider.sent.length).toBe(0)
    expect(await sinkCount(LOAD_ORG, "mail", k1)).toBe(1)

    expect(await sendEmailOnce(REAL_ORG, provider, mail(k2))).toBe("sent")
    expect(provider.sent.map((m) => m.idempotencyKey)).toEqual([k2])
    expect(await sinkCount(REAL_ORG, "mail", k2)).toBe(0)
  })

  it("an unset key disables everything even for a flagged org", async () => {
    LoadHarnessTestAccess.setKey(null)
    expect(await isLoadOrg(LOAD_ORG)).toBe(false)
    const provider = new Capturing()
    const k = `t:${crypto.randomUUID()}`
    expect(await sendEmailOnce(LOAD_ORG, provider, mail(k))).toBe("sent")
    expect(provider.sent.length).toBe(1)
    expect(await sinkCount(LOAD_ORG, "mail", k)).toBe(0)
  })

  it("only a literal true flags an org", async () => {
    LoadHarnessTestAccess.setKey(KEY)
    await sql`UPDATE kernel.organizations SET settings = ${JSON.stringify({ loadHarness: { on: true } })}::jsonb
      WHERE id = ${REAL_ORG}`
    expect(await isLoadOrg(REAL_ORG)).toBe(false)
    expect(await isLoadOrg(LOAD_ORG)).toBe(true)
  })

  it("an unreadable flag is never guessed: no mail goes out, no turn gets a real model", async () => {
    LoadHarnessTestAccess.setKey(KEY)
    // An org id the flag read cannot run on stands for a database that fails the read.
    const broken = "not-a-uuid"
    await expect(isLoadOrg(broken)).rejects.toThrow(LoadOrgFlagUnreadable)
    const provider = new Capturing()
    await expect(sendEmailOnce(broken, provider, mail(`t:${crypto.randomUUID()}`))).rejects.toThrow(
      LoadOrgFlagUnreadable,
    )
    expect(provider.sent.length).toBe(0)
    await expect(
      resolveModelFromCredit(
        {
          model: { provider: "openrouter", modelId: "m" },
          providerKey: "k",
          loadOrgId: broken,
        },
        { threadId: crypto.randomUUID() },
      ),
    ).rejects.toThrow(LoadOrgFlagUnreadable)
  })

  it("the same mail sent twice reaches the provider once (the ledger)", async () => {
    LoadHarnessTestAccess.setKey(null)
    const provider = new Capturing()
    const k = `t:${crypto.randomUUID()}`
    expect(await sendEmailOnce(REAL_ORG, provider, mail(k))).toBe("sent")
    expect(await sendEmailOnce(REAL_ORG, provider, mail(k))).toBe("replayed")
    expect(provider.sent.length).toBe(1)
  })
})

describe("harness request signatures", () => {
  const path = "/api/demo/orgs"
  const body = JSON.stringify({ email: "a@load.invalid" })

  function signed(over: { ts?: number; nonce?: string; sig?: string; body?: string } = {}) {
    const timestamp = over.ts ?? Date.now()
    const nonce = over.nonce ?? crypto.randomBytes(16).toString("hex")
    const sig =
      over.sig ?? signHarnessRequest({ method: "POST", path, timestamp, nonce, body }, KEY)
    const headers: Record<string, string> = {
      [HARNESS_HEADER_TIMESTAMP]: String(timestamp),
      [HARNESS_HEADER_NONCE]: nonce,
      [HARNESS_HEADER_SIGNATURE]: sig,
    }
    return {
      method: "POST",
      path,
      header: (n: string) => headers[n],
      body: over.body ?? body,
    }
  }

  it("a request without harness headers is absent", async () => {
    LoadHarnessTestAccess.setKey(KEY)
    expect(
      await verifyHarnessSignature({ method: "POST", path, header: () => undefined, body }),
    ).toEqual({ kind: "absent" })
  })

  it("a valid signature passes once; the replay is refused", async () => {
    LoadHarnessTestAccess.setKey(KEY)
    const req = signed()
    expect(await verifyHarnessSignature(req)).toEqual({ kind: "valid" })
    expect(await verifyHarnessSignature(req)).toEqual({ kind: "refused", reason: "replayed" })
  })

  it("a bad or replayed signature is refused", async () => {
    LoadHarnessTestAccess.setKey(KEY)
    const forged = signHarnessRequest(
      { method: "POST", path, timestamp: Date.now(), nonce: "n".repeat(32), body },
      crypto.randomBytes(32).toString("hex"),
    )
    expect(await verifyHarnessSignature(signed({ sig: forged, nonce: "n".repeat(32) }))).toEqual({
      kind: "refused",
      reason: "bad_signature",
    })
    // The body is covered: the same headers over another body fail.
    expect(await verifyHarnessSignature(signed({ body: `${body} ` }))).toEqual({
      kind: "refused",
      reason: "bad_signature",
    })
    expect(await verifyHarnessSignature(signed({ ts: Date.now() - 60_000 }))).toEqual({
      kind: "refused",
      reason: "skew",
    })
  })

  it("any harness header on a box without the key is refused", async () => {
    LoadHarnessTestAccess.setKey(KEY)
    const req = signed()
    LoadHarnessTestAccess.setKey(null)
    expect(await verifyHarnessSignature(req)).toEqual({ kind: "refused", reason: "harness_off" })
  })
})

describe("a load org's agent turns", () => {
  const credit = (loadOrgId?: string) => ({
    model: { provider: "anthropic", modelId: "claude-test" },
    providerKey: "sk-test-not-a-key",
    ...(loadOrgId ? { loadOrgId } : {}),
  })

  it("a load org gets the scripted load model, with the catalog's reply for its thread", async () => {
    LoadHarnessTestAccess.setKey(KEY)
    const threadId = crypto.randomUUID()
    const model = await resolveModelFromCredit(credit(LOAD_ORG), { threadId })
    expect(typeof model === "object" && model.provider).toBe("scripted")
    const out = await generateText({ model, prompt: "hello" })
    expect(out.text).toBe(loadScriptFor(threadId)[0]!.text!)
    expect(LOAD_SCRIPT_REPLIES).toContain(out.text as (typeof LOAD_SCRIPT_REPLIES)[number])
  })

  it("a real org never does, not even with a stale load credit, nor any org once the key is unset", async () => {
    LoadHarnessTestAccess.setKey(KEY)
    const real = await resolveModelFromCredit(credit(REAL_ORG), { threadId: crypto.randomUUID() })
    expect(typeof real === "object" && real.provider).not.toBe("scripted")
    const plain = await resolveModelFromCredit(credit(), { threadId: crypto.randomUUID() })
    expect(typeof plain === "object" && plain.provider).not.toBe("scripted")
    LoadHarnessTestAccess.setKey(null)
    const off = await resolveModelFromCredit(credit(LOAD_ORG), { threadId: crypto.randomUUID() })
    expect(typeof off === "object" && off.provider).not.toBe("scripted")
  })

  it("the same thread always picks the same script", () => {
    const t = crypto.randomUUID()
    expect(loadScriptFor(t)).toEqual(loadScriptFor(t))
  })
})

describe("flagging an org", () => {
  it("is refused while the harness is off, and is written with the demo marker while it is on", async () => {
    const org = crypto.randomUUID()
    await sql`INSERT INTO kernel.organizations (id, name, slug, settings)
      VALUES (${org}, 'Mark org', ${`mark-${org.slice(0, 8)}`}, '{"keep":1}'::jsonb)`
    try {
      LoadHarnessTestAccess.setKey(null)
      const marker = visitorMarker(24)
      await expect(markOrgAsDemo(org, marker, { loadHarness: true })).rejects.toThrow(/off/)
      const [untouched] = await sql<{ settings: Record<string, unknown> }[]>`
        SELECT settings FROM kernel.organizations WHERE id = ${org}`
      expect(untouched!.settings).toEqual({ keep: 1 })
      LoadHarnessTestAccess.setKey(KEY)
      await markOrgAsDemo(org, marker, { loadHarness: true })
      const [row] = await sql<{ settings: Record<string, unknown> }[]>`
        SELECT settings FROM kernel.organizations WHERE id = ${org}`
      expect(row!.settings).toEqual({ keep: 1, demo: marker, loadHarness: true })
      expect(await isLoadOrg(org)).toBe(true)
    } finally {
      await sql`DELETE FROM kernel.organizations WHERE id = ${org}`
    }
  })
})
