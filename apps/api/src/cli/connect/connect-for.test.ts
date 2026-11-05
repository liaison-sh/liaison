// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `liaison connect <app>/<connection> --for <email>` and `liaison disconnect`:
 * the link is printed (never an authorize URL), the wait ends only on a
 * connection the member owns (an org connection landing meanwhile does not
 * count), and disconnect refuses a member's personal connection without
 * --force, prints what is deleted and needs a confirmation.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { type ConnectDeps, createConnect } from "~/cli/connect"
import { createDisconnect } from "~/cli/disconnect"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import {
  claimConnectLink,
  connectLinkId,
  mintConnectLink,
  recordConnectLinkRefusal,
} from "~/modules/apps/connections/connect-links"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { acquireTestLock, releaseTestLock, truncateOrgTables } from "~/tests/route-test-setup"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

let orgId: string
let adminId: string
let memberId: string
let memberEmail: string

beforeEach(async () => {
  await truncateOrgTables()
  const org = await ensureOrg({
    slug: `cli-for-${crypto.randomUUID().slice(0, 12)}`,
    name: "ConnectForOrg",
  })
  orgId = org.orgId
  adminId = (
    await ensureUser({
      orgId,
      email: `admin-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`,
      name: "Owner",
      password: "pw-connect-1!",
      role: "admin",
    })
  ).userId
  memberEmail = `ana-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`
  memberId = (
    await ensureUser({
      orgId,
      email: memberEmail,
      name: "Ana",
      password: "pw-ana-1!",
      role: "member",
    })
  ).userId
})

async function insertAccount(
  ownerType: "org" | "user",
  ownerId: string | null,
  identifier: string,
) {
  return withPrivilegedDb(orgId, "test-insert-connection", async (tx) => {
    const rows = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.connected_accounts
          (org_id, app_name, connection_name, identifier, owner_type, owner_id, provider_type, status, created_by)
        VALUES (${orgId}::uuid, 'mail', 'gmail', ${identifier}, ${ownerType}, ${ownerId}::uuid, 'oauth2', 'active', ${adminId}::uuid)
        RETURNING id`),
    )
    return rows[0]?.id as string
  })
}

describe("connect --for", () => {
  function deps(onSleep: () => Promise<void>, lines: string[], token = "tok"): ConnectDeps {
    return {
      ensureAppsForOrg: async () => {},
      saveGoogleIntegrationConfig: async () => {},
      startOAuthFlow: async () => {
        throw new Error("--for must never start an operator OAuth flow")
      },
      log: (m) => lines.push(m),
      pollIntervalMs: 1,
      pollTimeoutMs: 50,
      linkPollTimeoutMs: 2_000,
      sleep: onSleep,
      // A stub token has no server record: the link reads as open.
      readConnectLinkStatus: async () => ({
        status: "open",
        expiresAt: new Date(Date.now() + 30 * 60_000),
      }),
      mintConnectLink: async (input) => {
        expect(input.minter).toEqual({ kind: "cli" })
        return {
          url: `https://liaison.example/connect/link?token=${token}`,
          token,
          expiresAt: new Date(Date.now() + 30 * 60_000),
          user: { id: memberId, email: memberEmail, name: "Ana" },
        }
      },
    }
  }

  test("prints the one-time link and waits for a connection the member owns", async () => {
    const lines: string[] = []
    let step = 0
    const run = createConnect(
      deps(async () => {
        step++
        // An org connection lands first: it must not end the wait.
        if (step === 1) await insertAccount("org", null, "support@fabrikam.example")
        if (step === 3) await insertAccount("user", memberId, memberEmail)
      }, lines),
    )
    const res = await run({ ref: "mail/gmail", forEmail: memberEmail })
    expect(res.exitCode).toBe(0)
    const out = lines.join("\n")
    expect(out).toContain("https://liaison.example/connect/link?token=tok")
    expect(out).toContain(`only when ${memberEmail} is signed in`)
    expect(out).toContain(`connected for ${memberEmail} (${memberEmail}), personal`)
    expect(step).toBeGreaterThanOrEqual(3)
  })
})

describe("connect --for, refused", () => {
  test("stops with the reason and exit 1 as soon as the member's connect is refused", async () => {
    const lines: string[] = []
    const token = `tok-refused-${crypto.randomUUID()}`
    let step = 0
    const started = Date.now()
    const run = createConnect({
      ensureAppsForOrg: async () => {},
      saveGoogleIntegrationConfig: async () => {},
      startOAuthFlow: async () => {
        throw new Error("--for must never start an operator OAuth flow")
      },
      log: (m) => lines.push(m),
      pollIntervalMs: 1,
      pollTimeoutMs: 50,
      // Far longer than the test may take: only the refusal can end the wait.
      linkPollTimeoutMs: 10 * 60_000,
      sleep: async () => {
        step++
        // The member followed the link; the callback refused it (app.ts backWith).
        if (step === 2) {
          await recordConnectLinkRefusal(connectLinkId(token), {
            reason: "connection_held_by_other_owner",
            message: "This account is already connected for the whole organization.",
          })
        }
        await Bun.sleep(5)
      },
      readConnectLinkStatus: async () => ({
        status: "open",
        expiresAt: new Date(Date.now() + 30 * 60_000),
      }),
      mintConnectLink: async () => ({
        url: `https://liaison.example/connect/link?token=${token}`,
        token,
        expiresAt: new Date(Date.now() + 30 * 60_000),
        user: { id: memberId, email: memberEmail, name: "Ana" },
      }),
    })
    const res = await run({ ref: "mail/gmail", forEmail: memberEmail })
    expect(res.exitCode).toBe(1)
    const out = lines.join("\n")
    expect(out).toContain(`${memberEmail}'s connect was refused (connection_held_by_other_owner)`)
    expect(out).toContain("already connected for the whole organization")
    expect(out).not.toContain("timed out")
    expect(Date.now() - started).toBeLessThan(30_000)
  })
})

describe("connect --for, the link's expiry", () => {
  /** Real links (server-side records) with a short life; the default status reader. */
  function expiringDeps(lines: string[], ttlSeconds: number, onSleep: () => Promise<void>) {
    let token = ""
    const d: ConnectDeps = {
      ensureAppsForOrg: async () => {},
      saveGoogleIntegrationConfig: async () => {},
      startOAuthFlow: async () => {
        throw new Error("--for must never start an operator OAuth flow")
      },
      log: (m) => lines.push(m),
      pollIntervalMs: 1,
      pollTimeoutMs: 50,
      // Far longer than the test may take: only the link's expiry may end it.
      linkPollTimeoutMs: 10 * 60_000,
      sleep: async () => {
        await onSleep()
        await Bun.sleep(20)
      },
      mintConnectLink: async (input) => {
        const link = await mintConnectLink({ ...input, ttlSeconds })
        token = link.token
        return link
      },
    }
    return { deps: d, token: () => token }
  }

  test("stops with exit 1 and how to get a new link once the link expires unused", async () => {
    const lines: string[] = []
    const started = Date.now()
    const { deps: d } = expiringDeps(lines, 1, async () => {})
    const res = await createConnect(d)({ ref: "mail/gmail", forEmail: memberEmail, send: false })
    expect(res.exitCode).toBe(1)
    const out = lines.join("\n")
    expect(out).toContain(`the link for ${memberEmail} expired before it was used`)
    expect(out).toContain(`For a new link, run: liaison connect mail/gmail --for ${memberEmail}`)
    expect(out).not.toContain("timed out")
    expect(out).not.toContain("connected for")
    // Ended by the server's 1 s record, not by the 10 min wait bound.
    expect(Date.now() - started).toBeLessThan(30_000)
  })

  test("a link its person redeemed keeps the wait going past the link's expiry", async () => {
    const lines: string[] = []
    let step = 0
    let redeemedAt = 0
    const handle = expiringDeps(lines, 1, async () => {
      step++
      if (step === 1) {
        const claimed = await claimConnectLink(handle.token(), { orgId, userId: memberId })
        expect(claimed.status).toBe("claimed")
        redeemedAt = Date.now()
      }
      // The consent lands well after the link itself would have expired.
      if (redeemedAt > 0 && Date.now() - redeemedAt > 1_500 && step < 1_000_000) {
        await insertAccount("user", memberId, memberEmail)
        step = 1_000_000
      }
    })
    const res = await createConnect(handle.deps)({ ref: "mail/gmail", forEmail: memberEmail })
    expect(res.exitCode).toBe(0)
    const out = lines.join("\n")
    expect(out).not.toContain("expired")
    expect(out).toContain(`connected for ${memberEmail} (${memberEmail}), personal`)
  })
})

describe("disconnect", () => {
  function run(confirm: boolean | null) {
    const lines: string[] = []
    const fn = createDisconnect({
      log: (m) => lines.push(m),
      confirm: confirm === null ? null : async () => confirm,
      ensureAppsForOrg: async () => {},
    })
    return { fn, lines }
  }

  async function status(id: string) {
    const rows = await withPrivilegedDb(orgId, "test-status", async (tx) =>
      extractRows<{ status: string }>(
        await tx.execute(
          drizzleSql`SELECT status FROM kernel.connected_accounts WHERE id = ${id}::uuid`,
        ),
      ),
    )
    return rows[0]?.status
  }

  test("a member's personal connection needs --force; with it, it is audited", async () => {
    const id = await insertAccount("user", memberId, memberEmail)
    const refused = run(true)
    expect((await refused.fn({ ref: "mail/gmail", account: memberEmail })).exitCode).toBe(2)
    expect(refused.lines.join("\n")).toContain("--force")
    expect(await status(id)).toBe("active")

    const forced = run(null)
    const res = await forced.fn({ ref: "mail/gmail", account: memberEmail, force: true, yes: true })
    expect(res.exitCode).toBe(0)
    expect(forced.lines.join("\n")).toContain("deleted from Liaison")
    expect(await status(id)).toBe("disconnected")
    const audit = await withPrivilegedDb(orgId, "test-audit", async (tx) =>
      extractRows<{ action: string }>(
        await tx.execute(
          drizzleSql`SELECT action FROM kernel.audit_log WHERE org_id = ${orgId}::uuid AND entity_id = ${id}`,
        ),
      ),
    )
    expect(audit.map((a) => a.action)).toContain("connection.disconnect.forced")
  })

  test("asks before deleting: no answer, no terminal or a no changes nothing", async () => {
    const id = await insertAccount("org", null, "support@fabrikam.example")
    const noTty = run(null)
    expect(
      (await noTty.fn({ ref: "mail/gmail", account: "support@fabrikam.example" })).exitCode,
    ).toBe(2)
    const no = run(false)
    expect((await no.fn({ ref: "mail/gmail", account: "SUPPORT@fabrikam.example" })).exitCode).toBe(
      1,
    )
    expect(await status(id)).toBe("active")
    const yes = run(true)
    expect(
      (await yes.fn({ ref: "mail/gmail", account: "support@fabrikam.example" })).exitCode,
    ).toBe(0)
    expect(yes.lines.join("\n")).toContain("organization connection")
    expect(await status(id)).toBe("disconnected")
  })
})
