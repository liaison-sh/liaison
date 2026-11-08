// SPDX-License-Identifier: FSL-1.1-ALv2
//
// a config secret goes only where the manifest's `secrets` declaration
// says (host and exact header / query parameter / JSON body path), else a
// typed `secret_placement_refused` before any byte leaves; connection
// credentials only to their connection's own hosts (a custom app's connection
// must name some); and every custom-app run is secret-free on any executor.
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import * as dnsPromises from "node:dns/promises"
import { packageManifestSchema } from "@liaison/app-sdk"
import type { RlsClient } from "~/db"
import { assertCustomAppManifestAllowed } from "~/modules/apps/app-org-scope"
import { validateAppManifest } from "~/modules/apps/contract"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import { createEgressMethods } from "~/modules/apps/sandbox/bridge/egress"
import {
  FetchAuthTestAccess,
  SECRET_PLACEMENT_REFUSED,
} from "~/modules/apps/sandbox/bridge/fetch-auth"
import {
  isWorkersRunBridge,
  SECRET_NOT_AVAILABLE_ON_WORKERS,
} from "~/modules/apps/sandbox/bridge/secret-free"
import {
  type AppManifestForBridge,
  SandboxBridgeTestAccess,
} from "~/modules/apps/sandbox/bridge/shared"
import { createRpcBridge, createSessionRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { assertNoSecretsIn } from "~/modules/apps/workers/secret-scan"
import { createWebhookVerifyBridge } from "~/modules/webhooks/verify-bridge"

const ORG = "00000000-0000-0000-0000-00000000c0de"
const USER = "00000000-0000-0000-0000-000000000001"
const HOOK = "minted-webhook-secret-0f1e2d3c"
const HDR = "signing-key-value-77aa88bb"
const QS = "query-secret-value-1234abcd"
const P = "__LIAISON_CONFIG_SECRET__hookSecret__"
const PH = "__LIAISON_CONFIG_SECRET__hdrSecret__"
const PQ = "__LIAISON_CONFIG_SECRET__qSecret__"
const API = "https://api.carrier.test"

const CONNECTIONS = {
  carrier: {
    type: "credentials",
    allowedDomains: ["api.carrier.test", "files.carrier.test"],
    webhookSecretConfigKey: "hookSecret",
    appSecretConfigKeys: ["hdrSecret", "qSecret", "loose"],
    credentialFields: [
      { name: "key", type: "text" },
      { name: "secret", type: "password" },
    ],
  },
}
const SECRETS = {
  hookSecret: { hosts: ["api.carrier.test"], in: "body:subscription.webhookSecret" },
  hdrSecret: { hosts: ["api.carrier.test"], in: "header:X-Signing-Key" },
  qSecret: { hosts: ["api.carrier.test"], in: "query:key" },
}
const manifest = (name = "carrier", extra: Partial<AppManifestForBridge> = {}) =>
  ({
    name,
    network: { allowedDomains: ["docs.carrier.test"] },
    connections: CONNECTIONS,
    secrets: SECRETS,
    ...extra,
  }) as AppManifestForBridge
const ALLOWED = ["api.carrier.test", "files.carrier.test", "docs.carrier.test"]
const CONFIG = { hookSecret: HOOK, hdrSecret: HDR, qSecret: QS, loose: "loose-secret-0000" }

type Seen = { url: string; headers: Record<string, string>; body: string | null }
let configReads = 0

function upstream(answer: (req: Seen) => Response = (r) => new Response(r.body ?? "ok")): Seen[] {
  const seen: Seen[] = []
  SandboxBridgeTestAccess.setFetchInterceptsHost(() => true)
  SandboxBridgeTestAccess.setFetch((async (url: string, init?: RequestInit) => {
    const req: Seen = {
      url: String(url),
      headers: { ...((init?.headers as Record<string, string>) ?? {}) },
      body: typeof init?.body === "string" ? init.body : null,
    }
    seen.push(req)
    return answer(req)
  }) as unknown as typeof fetch)
  return seen
}

function egress(m: AppManifestForBridge = manifest()): Record<string, any> {
  return createEgressMethods({
    orgId: ORG,
    userId: USER,
    appName: m.name,
    actorType: "user",
    egress: async () => ({ allowedDomains: ALLOWED, manifest: m }),
    callerScopes: [],
    inheritedActor: { actorType: "user" as const },
    manifest: m,
    txDb: null,
    appTable: () => "apps",
    kernelSchema: "kernel",
    bridgeOptions: {
      withShortTx: async (fn: (db: unknown) => Promise<unknown>) =>
        fn({
          execute: async () => {
            configReads++
            return [{ config: CONFIG }]
          },
        }),
    },
    resolveCredentials: async () => ({ key: "carrier-key-1234", secret: "carrier-secret-5678" }),
  } as unknown as BridgeContext)
}

async function send(
  url: string,
  opts: Record<string, unknown>,
  m?: AppManifestForBridge,
): Promise<{ out?: string; err?: { code?: string; status?: number; message?: string } }> {
  try {
    return { out: (await egress(m).fetch(url, JSON.stringify(opts))) as string }
  } catch (e) {
    return { err: e as { code?: string; status?: number; message?: string } }
  }
}

async function refused(url: string, opts: Record<string, unknown>, m?: AppManifestForBridge) {
  const seen = upstream()
  configReads = 0
  const { err } = await send(url, opts, m)
  expect(err?.code).toBe(SECRET_PLACEMENT_REFUSED)
  expect(err?.status).toBe(403)
  expect(seen).toEqual([]) // nothing left
  expect(configReads).toBe(0) // no secret read before the refusal
}

const bodyOpts = (body: string, extra: Record<string, unknown> = {}) => ({
  method: "POST",
  body,
  configSecrets: { [P]: "hookSecret" },
  ...extra,
})

afterEach(() => {
  SandboxBridgeTestAccess.setFetch(null)
  SandboxBridgeTestAccess.setFetchInterceptsHost(null)
  FetchAuthTestAccess.reset()
})

describe("body:<jsonPath>", () => {
  it("writes the secret at exactly the declared path, and redacts an echo", async () => {
    const seen = upstream()
    const { out } = await send(
      `${API}/v3/subscription`,
      bodyOpts(JSON.stringify({ eventType: "TRACKING", subscription: { webhookSecret: P } })),
    )
    expect(JSON.parse(seen[0]!.body!)).toEqual({
      eventType: "TRACKING",
      subscription: { webhookSecret: HOOK },
    })
    assertNoSecretsIn(out!, { hook: HOOK })
  })

  it("refuses the placeholder at another path, twice, in a key, or escaped elsewhere", async () => {
    await refused(`${API}/v3/s`, bodyOpts(JSON.stringify({ note: P })))
    await refused(
      `${API}/v3/s`,
      bodyOpts(JSON.stringify({ subscription: { webhookSecret: P }, note: P })),
    )
    await refused(
      `${API}/v3/s`,
      bodyOpts(JSON.stringify({ subscription: { webhookSecret: P }, [P]: 1 })),
    )
    // Part of a longer string at the right path is not the whole value.
    await refused(
      `${API}/v3/s`,
      bodyOpts(JSON.stringify({ subscription: { webhookSecret: `x${P}` } })),
    )
    // The raw text holds the placeholder once (in `note`); the declared path holds an escaped copy.
    const escaped = `\\u${P.charCodeAt(0).toString(16).padStart(4, "0")}${P.slice(1)}`
    await refused(
      `${API}/v3/s`,
      bodyOpts(`{"subscription":{"webhookSecret":"${escaped}"},"note":"${P}"}`),
    )
  })

  it("refuses the placeholder also in the URL or a header, and a body that is not JSON", async () => {
    const body = JSON.stringify({ subscription: { webhookSecret: P } })
    await refused(`${API}/v3/s?echo=${P}`, bodyOpts(body))
    await refused(`${API}/v3/${P}`, bodyOpts(body))
    await refused(`${API}/v3/s`, bodyOpts(body, { headers: { "X-Note": P } }))
    await refused(`${API}/v3/s`, bodyOpts(`webhookSecret=${P}`))
  })
})

describe("header:<Name>", () => {
  const hdrOpts = (headers: Record<string, string>, extra: Record<string, unknown> = {}) => ({
    method: "POST",
    headers,
    body: "{}",
    configSecrets: { [PH]: "hdrSecret" },
    ...extra,
  })

  it("writes the secret as the whole value of the declared header (any case)", async () => {
    const seen = upstream()
    await send(`${API}/v3/x`, hdrOpts({ "x-signing-key": PH }))
    expect(seen[0]!.headers["x-signing-key"]).toBe(HDR)
  })

  it("refuses another header name, a partial value, or the placeholder anywhere else", async () => {
    await refused(`${API}/v3/x`, hdrOpts({ "X-Other": PH }))
    await refused(`${API}/v3/x`, hdrOpts({ "X-Signing-Key": `Key ${PH}` }))
    await refused(`${API}/v3/x`, hdrOpts({ "X-Signing-Key": PH, "X-Copy": PH }))
    await refused(`${API}/v3/x`, hdrOpts({ "X-Signing-Key": PH }, { body: `{"n":"${PH}"}` }))
    await refused(`${API}/v3/x?n=${PH}`, hdrOpts({ "X-Signing-Key": PH }))
  })
})

describe("query:<param>", () => {
  const qOpts = { method: "GET", configSecrets: { [PQ]: "qSecret" } }

  it("writes the secret as the whole value of the declared parameter", async () => {
    const seen = upstream()
    const { out } = await send(`${API}/v3/report?key=${PQ}&day=1`, qOpts)
    const sent = new URL(seen[0]!.url)
    expect(sent.searchParams.get("key")).toBe(QS)
    expect(sent.searchParams.get("day")).toBe("1")
    assertNoSecretsIn(out!, { q: QS })
  })

  it("refuses another parameter, a repeated one, or the placeholder in the path too", async () => {
    await refused(`${API}/v3/report?other=${PQ}`, qOpts)
    await refused(`${API}/v3/report?key=${PQ}&key=${PQ}`, qOpts)
    await refused(`${API}/v3/${PQ}?key=${PQ}`, qOpts)
    await refused(`${API}/v3/report?key=${PQ}`, { ...qOpts, headers: { "X-N": PQ } })
  })
})

describe("hosts and declarations", () => {
  it("refuses a host outside the declaration's hosts, even one of the connection's", async () => {
    await refused(
      "https://files.carrier.test/v3/s",
      bodyOpts(JSON.stringify({ subscription: { webhookSecret: P } })),
    )
  })

  it("refuses a declared secret key with no placement, and an app that declares none", async () => {
    await refused(`${API}/v3/s`, {
      method: "POST",
      body: JSON.stringify({ v: "__LIAISON_CONFIG_SECRET__loose__" }),
      configSecrets: { __LIAISON_CONFIG_SECRET__loose__: "loose" },
    })
    await refused(
      `${API}/v3/s`,
      bodyOpts(JSON.stringify({ subscription: { webhookSecret: P } })),
      manifest("carrier", { secrets: undefined }),
    )
  })

  describe("redirect hops", () => {
    let lookupSpy: ReturnType<typeof spyOn>
    beforeEach(() => {
      lookupSpy = spyOn(dnsPromises, "lookup").mockImplementation((async () => [
        { address: "93.184.216.34", family: 4 },
      ]) as never)
    })
    afterEach(() => lookupSpy.mockRestore())

    it("refuses a redirect to another host than the secret's (a host of the connection all the same)", async () => {
      const seen: string[] = []
      SandboxBridgeTestAccess.setFetchInterceptsHost(() => false)
      SandboxBridgeTestAccess.setFetch((async (input: unknown) => {
        seen.push(String(input))
        return String(input).startsWith(API)
          ? new Response(null, {
              status: 307,
              headers: { location: "https://files.carrier.test/collect" },
            })
          : new Response("leaked", { status: 200 })
      }) as unknown as typeof fetch)
      const { err } = await send(
        `${API}/v3/s`,
        bodyOpts(JSON.stringify({ subscription: { webhookSecret: P } })),
      )
      expect(err?.code).toBe(SECRET_PLACEMENT_REFUSED)
      expect(seen.every((u) => u.startsWith(API))).toBe(true)
    })
  })
})

describe("auth (connection credentials)", () => {
  it("a custom app's connection that names no domains takes no credential; a first-party one keeps any host", async () => {
    const open = { carrier: { ...CONNECTIONS.carrier, allowedDomains: [] as string[] } }
    upstream()
    const auth = { connection: "carrier", scheme: "header:X-Api-Key", fields: ["key"] }
    const custom = await send(
      "https://docs.carrier.test/v1",
      { auth },
      manifest("crm-o12345678", { connections: open }),
    )
    expect(custom.err?.code).toBe("credential_host_not_allowed")
    const firstParty = await send(
      "https://docs.carrier.test/v1",
      { auth },
      manifest("carrier", { connections: open }),
    )
    expect(firstParty.err).toBeUndefined()
  })

  it("refuses a credential in a header a provider may log", async () => {
    upstream()
    for (const name of ["User-Agent", "Referer", "Origin"]) {
      const { err } = await send(`${API}/v1`, {
        auth: { connection: "carrier", scheme: `header:${name}`, fields: ["key"] },
      })
      expect(err?.code).toBe("invalid_fetch_auth")
    }
  })
})

describe("the manifest field", () => {
  const base = {
    name: "carrier",
    version: "1.0.0",
    network: { allowedDomains: ["docs.carrier.test"] },
    connections: {
      carrier: {
        type: "credentials",
        allowedDomains: ["api.carrier.test"],
        webhookSecretConfigKey: "hookSecret",
        credentialFields: [{ name: "key", type: "password", label: "Key" }],
      },
    },
  }
  const check = (secrets: unknown) => validateAppManifest({ ...base, secrets })
  const pkg = (secrets: unknown) =>
    packageManifestSchema.safeParse({
      ...base,
      packageFormat: 1,
      license: "MIT",
      scopes: [],
      secrets,
    })

  it("accepts each placement form on a host of the owning connection", () => {
    for (const where of ["header:X-Key", "query:key", "body:webhookSecret", "body:a.b[0].c"]) {
      const secrets = { hookSecret: { hosts: ["api.carrier.test"], in: where } }
      expect(check(secrets)).toMatchObject({ success: true })
      const parsed = pkg(secrets)
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
    }
  })

  it("refuses a key that is no declared secret, a host outside the connection, a bad placement", () => {
    const bad = [
      { plain: { hosts: ["api.carrier.test"], in: "body:x" } },
      { hookSecret: { hosts: ["docs.carrier.test"], in: "body:x" } },
      { hookSecret: { hosts: ["api.carrier.test"], in: "cookie:x" } },
      { hookSecret: { hosts: ["api.carrier.test"], in: "header:Cookie" } },
      { hookSecret: { hosts: [], in: "body:x" } },
      { hookSecret: { hosts: ["api.carrier.test"], in: "body:a..b" } },
    ]
    for (const secrets of bad) {
      expect(check(secrets).success, JSON.stringify(secrets)).toBe(false)
      expect(pkg(secrets).success, JSON.stringify(secrets)).toBe(false)
    }
  })

  it("a custom app's connection must name its hosts", () => {
    expect(() =>
      assertCustomAppManifestAllowed({
        connections: { c: { type: "credentials", allowedDomains: [] } },
      }),
    ).toThrow("allowedDomains")
    expect(() =>
      assertCustomAppManifestAllowed({
        connections: { c: { type: "credentials", allowedDomains: ["a.example"] } },
      }),
    ).not.toThrow()
  })
})

describe("a custom app is secret-free on every executor", () => {
  const poison = new Proxy(
    {},
    {
      get: () => () => {
        throw new Error("db touched")
      },
    },
  ) as unknown as RlsClient
  const refusal = (p: Promise<unknown>) =>
    p.then(
      () => ({}) as { code?: string; message?: string },
      (e: unknown) => e as { code?: string; message?: string },
    )
  const CUSTOM = "crm-o12345678"

  it("its QuickJS bridge refuses connections_getToken / getCredentials and config_get of a secret", async () => {
    const m = manifest(CUSTOM)
    const plain = createRpcBridge(CUSTOM, USER, ORG, poison, m, [], "user")
    const session = createSessionRpcBridge(
      CUSTOM,
      USER,
      ORG,
      { run: async (fn) => fn(poison) },
      m,
      [],
      "user",
    )
    for (const bridge of [plain, session]) {
      expect(isWorkersRunBridge(bridge)).toBe(true)
      for (const name of ["connections_getToken", "connections_getCredentials"]) {
        const err = await refusal(bridge[name]("carrier"))
        expect(err.code).toBe(SECRET_NOT_AVAILABLE_ON_WORKERS)
        expect(err.message).toContain("a custom app")
      }
      for (const key of ["hookSecret", "hdrSecret"]) {
        expect((await refusal(bridge.config_get(key))).code).toBe(SECRET_NOT_AVAILABLE_ON_WORKERS)
      }
    }
  })

  it("its webhook verifier reads no secret, and still verifies by key; a first-party one is unchanged", async () => {
    const input = (appName: string) => ({
      appOrgId: ORG,
      appName,
      appConfig: { hookSecret: "plain-not-encrypted" },
      manifestConnections: CONNECTIONS,
    })
    const custom = createWebhookVerifyBridge(input(CUSTOM))
    expect((await refusal(custom.config_get!("hookSecret"))).code).toBe(
      SECRET_NOT_AVAILABLE_ON_WORKERS,
    )
    expect(typeof custom.crypto_verifyHmacForConfig).toBe("function")
    const firstParty = createWebhookVerifyBridge(input("carrier"))
    expect(isWorkersRunBridge(firstParty)).toBe(false)
  })

  it("a first-party app's QuickJS bridge keeps today's methods", () => {
    const bridge = createRpcBridge("carrier", USER, ORG, poison, manifest(), [], "user")
    expect(isWorkersRunBridge(bridge)).toBe(false)
    expect(bridge.connections_getToken.toString()).not.toContain("secretNotAvailableOnWorkers")
  })
})
