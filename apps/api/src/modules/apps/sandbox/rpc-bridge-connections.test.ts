// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import { connectionConfigRegistry, resetAppRegistries } from "~/modules/apps/app-registries"
import * as connectionsService from "~/modules/apps/connections/service"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"

describe("RPC bridge — connections", () => {
  const manifest = {
    name: "conn-test",
    schema: {},
    events: {},
    connections: {
      gitlab: {
        type: "oauth2",
        allowedDomains: ["gitlab.com"],
      },
    },
    network: {},
  }

  // Minimal mock of the Drizzle query builder that returns empty results.
  // Each step returns a thenable that also has builder methods, so
  // .where(), .where().orderBy() and .where().orderBy().limit() all terminate
  // correctly as empty arrays.
  //
  // `orderBy` is part of the chain because the real connection lookup orders by
  // `updated_at`/`created_at` before it limits: a mock missing a step the
  // production query uses fails with a TypeError from the mock rather than
  // exercising the empty-result path the assertion is about.
  function makeEmptyDbMock() {
    function makeChain(): any {
      const p: any = Promise.resolve([])
      p.select = () => makeChain()
      p.from = () => makeChain()
      p.where = () => makeChain()
      p.orderBy = () => makeChain()
      p.limit = () => Promise.resolve([])
      return p
    }
    return makeChain()
  }

  it("bridge exposes connections_getToken and connections_getAccounts", () => {
    const bridge = createRpcBridge("conn-test", "u1", "o1", makeEmptyDbMock(), manifest as any)
    expect(typeof bridge.connections_getToken).toBe("function")
    expect(typeof bridge.connections_getAccounts).toBe("function")
  })

  it("connections_getToken throws when no connected account exists", async () => {
    const bridge = createRpcBridge("conn-test", "u1", "o1", makeEmptyDbMock(), manifest as any)
    await expect(bridge.connections_getToken("gitlab", "")).rejects.toThrow("No connected account")
  })

  it("connections_getAccounts returns empty array when none connected", async () => {
    const bridge = createRpcBridge("conn-test", "u1", "o1", makeEmptyDbMock(), manifest as any)
    const result = await bridge.connections_getAccounts("gitlab")
    expect(JSON.parse(result)).toEqual([])
  })
})

describe("RPC bridge — connections_getCredentials (K-CREDS)", () => {
  afterEach(() => {
    mock.restore()
  })

  const boxtalManifest = {
    name: "boxtal",
    schema: {},
    events: {},
    connections: {
      boxtal: {
        type: "credentials",
        allowedDomains: ["api.boxtal.build"],
        credentialFields: [
          { name: "v1Key", type: "text" },
          { name: "v1Secret", type: "password" },
          { name: "v3Key", type: "text" },
          { name: "v3Secret", type: "password" },
          { name: "environment", type: "text" },
        ],
      },
    },
    network: {},
  }

  function makeEmptyDbMock() {
    function makeChain(): any {
      const p: any = Promise.resolve([])
      p.select = () => makeChain()
      p.from = () => makeChain()
      p.where = () => makeChain()
      p.limit = () => Promise.resolve([])
      return p
    }
    return makeChain()
  }

  /** Stub the service module's credential lookup to return a full map. Uses spyOn (NOT mock.module):
   *  mock.module is NOT reverted by mock.restore, so it LEAKED the always-resolving
   *  getCredentialsForConnection stub into connections/service.test.ts's reject-expecting tests
   *  (its credential lookups resolved instead of throwing "disconnected"/"No credentials stored") —
   *  the apps-suite cross-file contamination [[BL-190]]. spyOn is cleanly reverted by the afterEach. */
  function stubCredentials(map: Record<string, string>): void {
    spyOn(connectionsService, "getCredentialsForConnection").mockImplementation(
      (async () => map) as unknown as typeof connectionsService.getCredentialsForConnection,
    )
  }

  it("bridge exposes connections_getCredentials", () => {
    const bridge = createRpcBridge("boxtal", "u1", "o1", makeEmptyDbMock(), boxtalManifest as any)
    expect(typeof bridge.connections_getCredentials).toBe("function")
  })

  it("returns exactly the declared credentialFields (filters undeclared keys)", async () => {
    stubCredentials({
      v1Key: "k1",
      v1Secret: "s1",
      v3Key: "k3",
      v3Secret: "s3",
      environment: "sandbox",
      // an undeclared key the host happened to store — must be filtered out:
      internalSecret: "leak",
    })
    const bridge = createRpcBridge("boxtal", "u1", "o1", makeEmptyDbMock(), boxtalManifest as any)
    const result = JSON.parse(await bridge.connections_getCredentials("boxtal"))
    expect(result).toEqual({
      v1Key: "k1",
      v1Secret: "s1",
      v3Key: "k3",
      v3Secret: "s3",
      environment: "sandbox",
    })
    expect(result.internalSecret).toBeUndefined()
  })

  it("returns {} when the connection declares no credentialFields", async () => {
    stubCredentials({ anything: "x" })
    const noFields = {
      ...boxtalManifest,
      connections: { boxtal: { type: "credentials", allowedDomains: ["api.boxtal.build"] } },
    }
    const bridge = createRpcBridge("boxtal", "u1", "o1", makeEmptyDbMock(), noFields as any)
    const result = JSON.parse(await bridge.connections_getCredentials("boxtal"))
    expect(result).toEqual({})
  })

  it("throws when the connection is not declared in the manifest", async () => {
    const bridge = createRpcBridge("boxtal", "u1", "o1", makeEmptyDbMock(), boxtalManifest as any)
    await expect(bridge.connections_getCredentials("nope")).rejects.toThrow(
      "not declared in app manifest",
    )
  })
})

describe("RPC bridge — config_get (K-WEBHOOK-SECRET)", () => {
  const manifest = { name: "boxtal", schema: {}, events: {}, connections: {}, network: {} }

  /** DB mock whose `execute` returns a single apps row with the given config. */
  function makeDbWithConfig(config: Record<string, unknown> | null) {
    return {
      execute: async () => [{ config }],
    } as any
  }

  it("bridge exposes config_get", () => {
    const bridge = createRpcBridge("boxtal", "u1", "o1", makeDbWithConfig({}), manifest as any)
    expect(typeof bridge.config_get).toBe("function")
  })

  it("returns the stored value for a present key", async () => {
    const bridge = createRpcBridge(
      "boxtal",
      "u1",
      "o1",
      makeDbWithConfig({ boxtalWebhookSecret: "abc123" }),
      manifest as any,
    )
    expect(await bridge.config_get("boxtalWebhookSecret")).toBe("abc123")
  })

  it("returns null for an absent key", async () => {
    const bridge = createRpcBridge("boxtal", "u1", "o1", makeDbWithConfig({}), manifest as any)
    expect(await bridge.config_get("missing")).toBeNull()
  })

  it("returns null when the app has no config row", async () => {
    const bridge = createRpcBridge("boxtal", "u1", "o1", makeDbWithConfig(null), manifest as any)
    expect(await bridge.config_get("anything")).toBeNull()
  })
})

describe("RPC bridge — config_get decrypts secret keys, passes non-secret keys through", () => {
  const ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

  afterEach(() => {
    resetAppRegistries()
  })

  /** DB mock whose `execute` returns a single apps row with the given config. */
  function makeDbWithConfig(config: Record<string, unknown> | null) {
    return { execute: async () => [{ config }] } as any
  }

  // Production path: the secret-key declaration lives on the MANIFEST the bridge
  // receives (`createRpcBridge(..., manifest)`) — the stable source always present
  // at the `config_get` call site. This is where the kernel resolves "which keys
  // are encrypted" from, so the test must carry it on the manifest (not depend on
  // the in-memory registry, which can be empty after a restart).
  const manifestWithSecretKey = {
    name: "boxtal",
    schema: {},
    events: {},
    connections: {
      boxtal: {
        type: "credentials",
        allowedDomains: ["api.boxtal.build"],
        webhookSecretConfigKey: "boxtalWebhookSecret",
      },
    },
    network: {},
  }

  it("decrypts the manifest-declared secret key but returns a non-secret key verbatim", async () => {
    process.env.ENCRYPTION_KEY = ENCRYPTION_KEY
    // NOTE: the in-memory connectionConfigRegistry is INTENTIONALLY left empty —
    // the bridge must identify the secret key from the manifest alone (the
    // production-stable source), so a registry gap can never leak ciphertext.

    const realSecret = "the-real-webhook-secret"
    const config = {
      // secret key → stored as ciphertext at rest
      boxtalWebhookSecret: encryptSecret(
        realSecret,
        ENCRYPTION_KEY,
        CryptoContext.appConfigConnectionSecret,
      ),
      // non-secret key → plaintext, must pass through untouched
      apiBaseUrl: "https://api.boxtal.build",
    }
    const bridge = createRpcBridge(
      "boxtal",
      "u1",
      "o1",
      makeDbWithConfig(config),
      manifestWithSecretKey as any,
    )

    // Secret key decrypts to the plaintext the connect handler / verifier needs.
    expect(await bridge.config_get("boxtalWebhookSecret")).toBe(realSecret)
    // Non-secret key is returned verbatim (never decrypted).
    expect(await bridge.config_get("apiBaseUrl")).toBe("https://api.boxtal.build")
  })

  it("falls back to the in-memory registry when the manifest declares no connections", async () => {
    process.env.ENCRYPTION_KEY = ENCRYPTION_KEY
    // A manifest with no connection declarations (legacy / in-process caller) —
    // the registry remains a valid fallback source for secret-key identification.
    const emptyManifest = { name: "boxtal", schema: {}, events: {}, connections: {}, network: {} }
    connectionConfigRegistry.set(["o1", "boxtal", "boxtal"], {
      type: "credentials",
      allowedDomains: ["api.boxtal.build"],
      webhookSecretConfigKey: "boxtalWebhookSecret",
    })

    const realSecret = "the-real-webhook-secret"
    const config = {
      boxtalWebhookSecret: encryptSecret(
        realSecret,
        ENCRYPTION_KEY,
        CryptoContext.appConfigConnectionSecret,
      ),
    }
    const bridge = createRpcBridge(
      "boxtal",
      "u1",
      "o1",
      makeDbWithConfig(config),
      emptyManifest as any,
    )
    expect(await bridge.config_get("boxtalWebhookSecret")).toBe(realSecret)
  })
})

describe("RPC bridge — config_get falls back to an instance default (Mail's Gmail push topic)", () => {
  const mail = { name: "mail", schema: {}, events: {}, connections: {}, network: {} }
  const other = { name: "boxtal", schema: {}, events: {}, connections: {}, network: {} }
  const mutableEnv = env as { GMAIL_PUBSUB_TOPIC?: string }
  const saved = mutableEnv.GMAIL_PUBSUB_TOPIC
  afterEach(() => {
    mutableEnv.GMAIL_PUBSUB_TOPIC = saved
  })
  const db = (config: Record<string, unknown> | null) =>
    ({ execute: async () => [{ config }] }) as never

  it("Mail with no topic of its own reads the instance's GMAIL_PUBSUB_TOPIC", async () => {
    mutableEnv.GMAIL_PUBSUB_TOPIC = "projects/p/topics/shared-push"
    const bridge = createRpcBridge("mail", "u1", "o1", db({}), mail as never)
    expect(await bridge.config_get("gmailPushTopic")).toBe("projects/p/topics/shared-push")
  })

  it("Mail's own topic wins over the instance's", async () => {
    mutableEnv.GMAIL_PUBSUB_TOPIC = "projects/p/topics/shared-push"
    const bridge = createRpcBridge(
      "mail",
      "u1",
      "o1",
      db({ gmailPushTopic: "projects/own/topics/own-push" }),
      mail as never,
    )
    expect(await bridge.config_get("gmailPushTopic")).toBe("projects/own/topics/own-push")
  })

  it("no instance topic: null, as before (poll-only)", async () => {
    mutableEnv.GMAIL_PUBSUB_TOPIC = undefined
    const bridge = createRpcBridge("mail", "u1", "o1", db({}), mail as never)
    expect(await bridge.config_get("gmailPushTopic")).toBeNull()
  })

  it("another app's key of the same name gets no instance default", async () => {
    mutableEnv.GMAIL_PUBSUB_TOPIC = "projects/p/topics/shared-push"
    const bridge = createRpcBridge("boxtal", "u1", "o1", db({}), other as never)
    expect(await bridge.config_get("gmailPushTopic")).toBeNull()
  })
})
