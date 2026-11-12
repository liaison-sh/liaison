// SPDX-License-Identifier: FSL-1.1-ALv2
// `ctx.fetch(url, { auth: { connection, account } })`: the host adds the token of
// exactly that connected account, through the real bridge and database. The
// account must be one `ctx.accounts.list` shows the run: the organization's, or
// the acting person's own; never another member's, never another org's.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withRlsContext } from "~/db/rls"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import { SandboxBridgeTestAccess } from "~/modules/apps/sandbox/bridge/shared"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const APP = "acctprobe"
const HOST = "api.acctprobe.test"
const manifest = {
  name: APP,
  schema: {},
  events: {},
  network: { allowedDomains: [HOST] },
  connections: { files: { type: "oauth2", allowedDomains: [HOST] } },
}

let ORG_A = ""
let ORG_B = ""
let ALICE = ""
let BOB = ""
let CAROL = ""
const acc: Record<string, string> = {}

async function oauthAccount(
  org: string,
  createdBy: string,
  owner: { type: "org" } | { type: "user"; id: string },
  identifier: string,
  token: string,
): Promise<string> {
  const [row] = extractRows<{ id: string }>(
    await db.execute(sql`INSERT INTO kernel.connected_accounts
        (org_id, app_name, connection_name, owner_type, owner_id, provider_type, identifier,
         access_token_encrypted, status, created_by, updated_at)
      VALUES (${org}::uuid, ${APP}, 'files', ${owner.type},
              ${owner.type === "user" ? owner.id : null}::uuid, 'oauth2', ${identifier},
              ${encryptSecret(token, env.ENCRYPTION_KEY, CryptoContext.connectedAccountAccessToken)},
              'active', ${createdBy}::uuid, now())
      RETURNING id`),
  )
  return row!.id
}

/** One authenticated call as `user` (a person) or as the app itself ("system"). */
async function call(
  org: string,
  user: string,
  account: string,
): Promise<{ status?: number; sentToken?: string; error?: string }> {
  const sent: string[] = []
  SandboxBridgeTestAccess.setFetchInterceptsHost(() => true)
  SandboxBridgeTestAccess.setFetch((async (_url: string, init?: RequestInit) => {
    sent.push(new Headers(init?.headers).get("authorization") ?? "")
    return new Response("{}", { headers: { "content-type": "application/json" } })
  }) as never)
  const person = user !== "system"
  try {
    const out = await withRlsContext(
      person
        ? { actorType: "user", userId: user, orgId: org, scopes: [], dimensionGrants: {} }
        : { actorType: "system", orgId: org, purpose: "job" },
      (tx) =>
        createRpcBridge(
          APP,
          user,
          org,
          tx as never,
          manifest as never,
          [],
          person ? "user" : "system",
        ).fetch(
          `https://${HOST}/v1/me`,
          JSON.stringify({ auth: { connection: "files", account, scheme: "bearer" } }),
        ),
    )
    return { status: JSON.parse(out as string).status, sentToken: sent[0]?.replace("Bearer ", "") }
  } catch (err) {
    return { error: (err as { code?: string }).code ?? String(err) }
  }
}

beforeAll(async () => {
  await acquireTestLock()
  ORG_A = (await createTestOrg()).id
  ALICE = (await minimal.orgAdmin(ORG_A)).id
  BOB = (await minimal.person(ORG_A)).id
  const second = await minimal.secondOrg()
  ORG_B = second.orgId
  CAROL = second.adminUserId
  acc.orgA = await oauthAccount(ORG_A, ALICE, { type: "org" }, "team@a.test", "tok-org-a")
  acc.alice = await oauthAccount(
    ORG_A,
    ALICE,
    { type: "user", id: ALICE },
    "team@a.test",
    "tok-alice",
  )
  acc.bob = await oauthAccount(ORG_A, BOB, { type: "user", id: BOB }, "bob@a.test", "tok-bob")
  acc.orgB = await oauthAccount(ORG_B, CAROL, { type: "org" }, "team@b.test", "tok-org-b")
}, 120_000)

afterEach(() => {
  SandboxBridgeTestAccess.setFetch(null)
  SandboxBridgeTestAccess.setFetchInterceptsHost(null)
})

afterAll(async () => {
  await db.execute(
    sql`DELETE FROM kernel.connected_accounts WHERE app_name = ${APP} AND org_id IN (${ORG_A}::uuid, ${ORG_B}::uuid)`,
  )
  await releaseTestLock()
})

describe("ctx.fetch auth by account id", () => {
  it("sends the named account's token, even when another account shares its identifier", async () => {
    expect(await call(ORG_A, ALICE, acc.orgA!)).toMatchObject({
      status: 200,
      sentToken: "tok-org-a",
    })
    expect(await call(ORG_A, ALICE, acc.alice!)).toMatchObject({
      status: 200,
      sentToken: "tok-alice",
    })
  })

  it("refuses another member's own account and another org's account, sending nothing", async () => {
    expect(await call(ORG_A, ALICE, acc.bob!)).toEqual({ error: "unknown_account" })
    expect(await call(ORG_A, ALICE, acc.orgB!)).toEqual({ error: "unknown_account" })
  })

  it("a run that acts for no person uses the org's accounts only", async () => {
    expect(await call(ORG_A, "system", acc.orgA!)).toMatchObject({ sentToken: "tok-org-a" })
    expect(await call(ORG_A, "system", acc.alice!)).toEqual({ error: "unknown_account" })
  })
})
