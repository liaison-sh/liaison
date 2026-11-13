// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Two `ctx.fetch` auth shapes beside header/bearer/basic/exchange (fetch-auth.ts):
//   - `query:<param>`: the credential goes out as a query parameter of the
//     wire URL only, and nothing that comes back carries it;
//   - `grant: "client_credentials"`: an oauth2 connection's app token, obtained
//     host-side from the connection's own OAuth client at its tokenUrl, cached,
//     re-obtained after a 401 or a change of client.
import { afterEach, describe, expect, it } from "bun:test"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import { createEgressMethods } from "~/modules/apps/sandbox/bridge/egress"
import {
  type FetchAuthDeps,
  FetchAuthTestAccess,
  injectFetchAuth,
  parseFetchAuth,
} from "~/modules/apps/sandbox/bridge/fetch-auth"
import {
  type AppManifestForBridge,
  SandboxBridgeTestAccess,
} from "~/modules/apps/sandbox/bridge/shared"
import { assertNoSecretsIn } from "~/modules/apps/workers/secret-scan"

const ORG = "00000000-0000-0000-0000-00000000c0de"
const USER = "00000000-0000-0000-0000-000000000001"
const API_KEY = "query-api-key-0123456789"
const CLIENT_ID = "1234567890"
const CLIENT_SECRET = "client-secret-abcdef012345"
const APP_TOKEN = "app-token-from-grant-98765"

const MANIFEST: AppManifestForBridge = {
  name: "pages",
  connections: {
    page: {
      type: "oauth2",
      tokenUrl: "https://graph.provider.test/oauth/access_token",
      allowedDomains: ["graph.provider.test"],
    },
    keyed: {
      type: "credentials",
      allowedDomains: ["api.keyed.test"],
      credentialFields: [{ name: "apiKey", type: "password" }],
    },
  },
}

afterEach(() => {
  SandboxBridgeTestAccess.setFetch(null)
  SandboxBridgeTestAccess.setFetchInterceptsHost(null)
  FetchAuthTestAccess.reset()
})

type Sent = { url: string; opts: Record<string, any> }

function deps(
  answer: (sent: Sent) => { status: number; body: string },
  client: { clientId: string; clientSecret: string } | null = {
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
  },
): FetchAuthDeps & { sent: Sent[] } {
  const sent: Sent[] = []
  return {
    manifest: MANIFEST,
    orgId: ORG,
    userId: USER,
    appName: "pages",
    readToken: async () => ({ token: "user-token-not-used", identifier: "u1" }),
    readCredentials: async () => ({ apiKey: API_KEY }),
    readConfigSecret: async () => null,
    readOAuthClient: async () => client,
    send: async (url, optsJson) => {
      const s = { url, opts: JSON.parse(optsJson) }
      sent.push(s)
      const a = answer(s)
      return JSON.stringify({ status: a.status, headers: {}, body: a.body })
    },
    sent,
  }
}

const grant = parseFetchAuth({ connection: "page", scheme: "bearer", grant: "client_credentials" })!

describe("ctx.fetch auth: client credentials grant", () => {
  it("posts the connection's client to its tokenUrl once, then sends the cached app token", async () => {
    const d = deps(() => ({ status: 200, body: JSON.stringify({ access_token: APP_TOKEN }) }))
    for (let i = 0; i < 2; i++) {
      const headers: Record<string, string> = {}
      const out = await injectFetchAuth(
        "https://graph.provider.test/1/subscriptions",
        headers,
        grant,
        d,
      )
      expect(headers.Authorization).toBe(`Bearer ${APP_TOKEN}`)
      expect(out.secrets).toEqual([APP_TOKEN])
      expect(out.bearerKey).toBeTruthy()
    }
    expect(d.sent).toHaveLength(1)
    expect(d.sent[0]!.url).toBe("https://graph.provider.test/oauth/access_token")
    expect(d.sent[0]!.opts.method).toBe("POST")
    expect(new URLSearchParams(d.sent[0]!.opts.body).get("grant_type")).toBe("client_credentials")
    expect(new URLSearchParams(d.sent[0]!.opts.body).get("client_id")).toBe(CLIENT_ID)
  })

  it("a changed client gets a new token, never the old client's", async () => {
    let n = 0
    const answer = () => ({ status: 200, body: JSON.stringify({ access_token: `tok-${++n}` }) })
    const first: Record<string, string> = {}
    await injectFetchAuth("https://graph.provider.test/x", first, grant, deps(answer))
    const second: Record<string, string> = {}
    await injectFetchAuth(
      "https://graph.provider.test/x",
      second,
      grant,
      deps(answer, { clientId: CLIENT_ID, clientSecret: "rotated-secret-000000" }),
    )
    expect([first.Authorization, second.Authorization]).toEqual(["Bearer tok-1", "Bearer tok-2"])
  })

  it("a refused grant answers the token endpoint's status with the client secret redacted", async () => {
    const d = deps(() => ({ status: 400, body: `bad client ${CLIENT_SECRET}` }))
    const out = await injectFetchAuth("https://graph.provider.test/x", {}, grant, d)
    expect(out.failed?.status).toBe(400)
    expect(out.failed?.body).not.toContain(CLIENT_SECRET)
  })

  it("is refused for a credentials connection, without a client, and with any other auth field", async () => {
    await expect(
      injectFetchAuth(
        "https://api.keyed.test/x",
        {},
        parseFetchAuth({ connection: "keyed", scheme: "bearer", grant: "client_credentials" })!,
        deps(() => ({ status: 200, body: "{}" })),
      ),
    ).rejects.toThrow(/needs an oauth2 connection/)
    const noClient = (await injectFetchAuth(
      "https://graph.provider.test/x",
      {},
      grant,
      deps(() => ({ status: 200, body: "{}" }), null),
    ).catch((e: unknown) => e)) as { status?: number; code?: string }
    expect([noClient.status, noClient.code]).toEqual([409, "credential_missing"])
    expect(() =>
      parseFetchAuth({ connection: "page", scheme: "header:X-T", grant: "client_credentials" }),
    ).toThrow(/grant is for the bearer scheme/)
    expect(() =>
      parseFetchAuth({
        connection: "page",
        scheme: "bearer",
        grant: "client_credentials",
        identifier: "u1",
      }),
    ).toThrow(/names only the connection/)
  })
})

describe("ctx.fetch auth: query:<param>", () => {
  it("parses only a parameter name", () => {
    expect(
      parseFetchAuth({ connection: "keyed", scheme: "query:api_key", fields: ["apiKey"] }),
    ).toMatchObject({ scheme: "query:api_key" })
    expect(() =>
      parseFetchAuth({ connection: "keyed", scheme: "query:a b", fields: ["apiKey"] }),
    ).toThrow(/not a parameter name/)
  })

  it("the wire URL carries the field, the app's answer never does (even echoed)", async () => {
    const seen: string[] = []
    SandboxBridgeTestAccess.setFetchInterceptsHost(() => true)
    SandboxBridgeTestAccess.setFetch((async (url: string) => {
      seen.push(String(url))
      return new Response(JSON.stringify({ echoed: String(url) }), { status: 200 })
    }) as unknown as typeof fetch)
    const bridge = createEgressMethods({
      orgId: ORG,
      userId: USER,
      appName: "pages",
      actorType: "user",
      egress: async () => ({ allowedDomains: ["api.keyed.test"], manifest: MANIFEST }),
      callerScopes: [],
      inheritedActor: { actorType: "user" as const },
      manifest: MANIFEST,
      txDb: null,
      appTable: () => "apps",
      kernelSchema: "kernel",
      bridgeOptions: {},
      resolveCredentials: async () => ({ apiKey: API_KEY }),
    } as unknown as BridgeContext)
    const out = (await bridge.fetch(
      "https://api.keyed.test/v1/items?page=2",
      JSON.stringify({
        auth: { connection: "keyed", scheme: "query:api_key", fields: ["apiKey"] },
      }),
    )) as string
    expect(new URL(seen[0]!).searchParams.get("api_key")).toBe(API_KEY)
    expect(new URL(seen[0]!).searchParams.get("page")).toBe("2")
    assertNoSecretsIn(out, { apiKey: API_KEY })
  })
})
