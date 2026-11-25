// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Doors of the signing mail and of server-side egress. A link or code mail is
// system mail, never a connected mailbox's: when a synced mailbox brings one
// back (the sender's Sent folder, a staff signer's own inbox), the page writer
// drops it, so no agent finds the link or the code through Mail. A server-side
// fetch (an agent's web fetch, an app's egress, an API connector) never reaches
// this server's public action or portal routes, so an agent that saw a link
// still cannot open, verify or decide it from the server.
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import * as dnsPromises from "node:dns/promises"
import { type Adapter, validateAdapter } from "@liaison/api-connector-core"
import { env } from "~/lib/env"
import { fetchWithPinnedHost, OutboundFetchTestAccess } from "~/lib/outbound-fetch"
import { handleWebFetch, WebToolsTestAccess } from "~/modules/agent/tools/web-tools"
import { testApiConn } from "~/modules/apps/connections/api/app.test-helpers"
import { ApiConnectorError, callOperation } from "~/modules/apps/connections/api/transport"
import { executeTool } from "~/modules/apps/execute-tool"
import { sandboxEgressPolicy, validateSandboxFetchUrl } from "~/modules/apps/sandbox/bridge/shared"
import {
  call,
  codeFor,
  mailboxOf,
  mailboxRows,
  mintTo,
  nextIp,
  syncedCopyOf,
  syncPage,
  useClientActionWorld,
  waitForMail,
} from "../../../../test-support/client-actions-kit"
import { adminContext } from "./fixture"

const kit = useClientActionWorld("mailegress")

function holds(value: unknown, needles: string[]): string[] {
  const text = JSON.stringify(value)
  return needles.filter((n) => text.includes(n))
}

describe("signing mail never enters Mail", () => {
  it("NT-45 after a send, the sender's synced mailbox holds no token: the link mail synced from Sent is not stored", async () => {
    const sent = await mintTo(kit)
    const box = await mailboxOf(kit, kit.w.admin.userId, kit.w.admin.email)
    const events = await syncPage(
      kit,
      box.accountId,
      kit.w.admin.userId,
      [syncedCopyOf(sent.mail, { direction: "outbound", labels: ["SENT"] })],
      "sent",
    )
    expect(events).toEqual([])
    const rows = await mailboxRows(box.accountId)
    expect(rows).toEqual([])
    expect(holds(rows, [sent.token])).toEqual([])
  }, 60_000)

  it("NT-45b a staff signer's synced inbox finds neither link nor code through mail search or read; a forged header is stored as usual", async () => {
    const sent = await mintTo(kit)
    const ip = nextIp()
    const before = kit.capture.sent.length
    const code = await codeFor(kit, sent.token, ip, kit.w.clientA.email)
    const codeMail = await waitForMail(
      kit,
      (m) => kit.capture.sent.indexOf(m) >= before && m.template === "client-action.code",
    )
    const box = await mailboxOf(kit, kit.w.admin.userId, kit.w.admin.email)
    const forgedId = "0".repeat(32)
    const forged = syncedCopyOf(
      {
        to: kit.w.admin.email,
        subject: "Maison forged notice",
        html: "<p>hello</p>",
        text: "hello",
      },
      { headers: { "x-liaison-action-mail": forgedId } },
    )
    const events = await syncPage(kit, box.accountId, kit.w.admin.userId, [
      syncedCopyOf(sent.mail),
      syncedCopyOf(codeMail),
      forged,
    ])
    // Only the forged one is stored, announced and indexed.
    const rows = await mailboxRows(box.accountId)
    expect(rows.map((r) => r.external_message_id)).toEqual([forged.externalMessageId as string])
    expect(events.filter((e) => e.entity === "message")).toHaveLength(1)
    expect(holds(rows, [sent.token, code])).toEqual([])

    // What the staff signer's agent would call: search, then read every hit.
    const actor = adminContext(kit.w)
    const found = await executeTool({
      toolName: "mail:search",
      orgId: kit.w.orgId,
      actor,
      params: { accountId: box.accountId },
      origin: "in-app-agent",
    })
    expect(JSON.stringify(found)).toContain("Maison forged notice")
    expect(holds(found, [sent.token, code, sent.mail.subject])).toEqual([])
    const ids = [...JSON.stringify(found).matchAll(/"conversationId":"([0-9a-f-]{36})"/g)].map(
      (m) => m[1] as string,
    )
    for (const conversationId of new Set(ids)) {
      const read = await executeTool({
        toolName: "mail:read",
        orgId: kit.w.orgId,
        actor,
        params: { conversationId, includeBody: true },
        origin: "in-app-agent",
      })
      expect(holds(read, [sent.token, code])).toEqual([])
    }

    // The code still works on the page: the drop took nothing from the signer.
    const v = await call(
      "verify",
      { t: sent.token, code, name: kit.w.clientA.name },
      { "x-bun-socket-ip": ip },
    )
    expect(v.status).toBe(200)
  }, 120_000)
})

// ── Egress ─────────────────────────────────────────────────────────────────

const SELF = "https://liaison-self.example.com"
const ACTION_URLS = [
  `${SELF}/api/public/client-actions/decide`,
  `${SELF}/api/portal/requests`,
  `${SELF}/API/%70ublic/client-actions/open`,
  `${SELF}/docs/../api/portal/me`,
]

describe("server-side egress never reaches this server's action routes", () => {
  let savedBase: string
  let reached: string[] = []
  let lookupSpy: ReturnType<typeof spyOn>
  const answer = (async (input: string | URL | Request) => {
    reached.push(String(input instanceof Request ? input.url : input))
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  }) as typeof fetch

  beforeEach(() => {
    savedBase = env.BASE_URL
    env.BASE_URL = SELF
    reached = []
    lookupSpy = spyOn(dnsPromises, "lookup").mockImplementation((async () => [
      { address: "93.184.216.34", family: 4 },
    ]) as never)
    OutboundFetchTestAccess.setFetch(answer)
    WebToolsTestAccess.setWebFetch(answer)
  })
  afterEach(() => {
    env.BASE_URL = savedBase
    lookupSpy.mockRestore()
    OutboundFetchTestAccess.setFetch(null)
    WebToolsTestAccess.setWebFetch(null)
  })

  it("NT-46 the agent's web fetch is refused for the public and portal routes of this server", async () => {
    for (const url of ACTION_URLS) {
      const r = (await handleWebFetch({ url }, { orgId: kit.w.orgId })) as { error?: string }
      expect(r.error ?? "").toContain("public or portal routes")
    }
    expect(reached).toEqual([])
    // The same host's other pages are fetched as before.
    await handleWebFetch({ url: `${SELF}/docs` }, { orgId: kit.w.orgId })
    expect(reached).toEqual([`${SELF}/docs`])
  })

  it("NT-46 an app's sandbox egress is refused for the public and portal routes of this server", async () => {
    for (const url of ACTION_URLS) {
      expect(() =>
        validateSandboxFetchUrl(url, ["liaison-self.example.com"], false, "mailegress"),
      ).toThrow("public or portal routes")
      await expect(
        fetchWithPinnedHost(url, { method: "POST", body: "{}" }, sandboxEgressPolicy("mailegress")),
      ).rejects.toThrow("public or portal routes")
    }
    expect(reached).toEqual([])
    await fetchWithPinnedHost(`${SELF}/docs`, {}, sandboxEgressPolicy("mailegress"))
    expect(reached).toEqual([`${SELF}/docs`])
  })

  it("NT-46 an API connector is refused for the public and portal routes of this server", async () => {
    const adapterAt = (baseUrl: string, path: string): Adapter => {
      const r = validateAdapter({
        id: "self",
        name: "Self",
        version: "1",
        baseUrl,
        auth: { type: "bearer" },
        operations: [
          {
            name: "poke",
            description: "Poke.",
            kind: "read",
            method: "GET",
            path,
            params: { type: "object", properties: {} },
            items: "/data",
            fields: ["id"],
          },
        ],
      })
      if (!r.ok) throw new Error(JSON.stringify(r.issues))
      return r.adapter
    }
    const run = (adapter: Adapter) =>
      callOperation({
        ...testApiConn(kit.w.orgId),
        identifier: "self",
        adapter,
        credentials: { token: "tok_abcdef" },
        credentialVersion: "v-test",
        operation: adapter.operations[0] as Adapter["operations"][number],
        params: {},
      })
    for (const [base, path] of [
      [`${SELF}/api/public`, "/client-actions/open"],
      [`${SELF}/api/portal`, "/requests"],
    ] as const) {
      let refused: unknown = null
      try {
        await run(adapterAt(base, path))
      } catch (err) {
        refused = err
      }
      expect(refused).toBeInstanceOf(ApiConnectorError)
    }
    expect(reached).toEqual([])
    await run(adapterAt(`${SELF}/api/v1`, "/things")).catch(() => {})
    expect(reached).toEqual([`${SELF}/api/v1/things`])
  })
})
