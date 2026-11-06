// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeAll, describe, expect, it } from "bun:test"
import path from "node:path"
import { loadBundle } from "~/modules/apps/sandbox/bundle-loader"
import { executeInSandbox } from "~/modules/apps/sandbox/executor"
import { getSandboxPool, initSandboxPool } from "~/modules/apps/sandbox/pool"

describe("verifyGmailPush", () => {
  let bundleSource: string

  beforeAll(async () => {
    await initSandboxPool()
    bundleSource = await loadBundle(path.resolve(import.meta.dir, "handlers.ts"))
  })

  it("returns valid result with replayKey from Pub/Sub messageId", async () => {
    const bridge: Record<string, any> = {
      getUserId: () => "system",
      getOrgId: () => "org-1",
      // No OIDC config — falls back to local-mode query-token verification.
      config_get: async (key: string) => (key === "gmailPushSecret" ? "expected-secret" : null),
      crypto_timingSafeEqual: async (a: string, b: string) => a === b,
      env_allowInsecurePush: async () => true,
      db_findMany: async () => "[]",
      db_findOne: async () => "null",
      db_insert: async () => '{"id":"x"}',
      db_update: async () => {},
      db_updateMany: async () => '{"count":0}',
      db_delete: async () => {},
      db_count: async () => "0",
      emit: async () => {},
      enqueueJob: async () => {},
      connections_getToken: async () => "t",
      connections_getAccounts: async () => "[]",
      connections_disconnect: async () => {},
      hasScope: async () => true,
      resolveContact: async () => '{"id":"c"}',
      fetch: async () => '{"status":200}',
      imap_fetch: async () => '{"messages":[],"done":true,"uidValidity":1}',
      smtp_send: async () => '{"messageId":"<x>"}',
      hasOnlineUsers: async () => "true",
      log_info: () => {},
      log_warn: () => {},
      log_error: () => {},
      log_debug: () => {},
    }

    const result = await executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: "verifyGmailPush",
      params: {
        headers: {},
        body: JSON.stringify({
          message: {
            data: btoa(JSON.stringify({ emailAddress: "test@gmail.com", historyId: "123" })),
            messageId: "pubsub-msg-1",
          },
        }),
        method: "POST",
        query: { token: "expected-secret" },
      },
      bridge,
    })

    expect((result as any).valid).toBe(true)
    expect((result as any).replayKey).toBe("pubsub-msg-1")
    expect((result as any).replayTtlSeconds).toBe(86400)
  })

  it("refuses the static-token fallback unless ALLOW_INSECURE_PUSH is on, whatever NODE_ENV says", async () => {
    const run = (allow: boolean | undefined) =>
      executeInSandbox({
        pool: getSandboxPool(),
        bundleSource,
        exportName: "verifyGmailPush",
        params: {
          headers: {},
          body: JSON.stringify({ message: { data: btoa("{}"), messageId: "pubsub-msg-2" } }),
          method: "POST",
          query: { token: "expected-secret" },
        },
        bridge: {
          getUserId: () => "system",
          getOrgId: () => "org-1",
          config_get: async (key: string) => (key === "gmailPushSecret" ? "expected-secret" : null),
          crypto_timingSafeEqual: async (a: string, b: string) => a === b,
          ...(allow === undefined ? {} : { env_allowInsecurePush: async () => allow }),
          log_info: () => {},
          log_warn: () => {},
          log_error: () => {},
        },
      })
    expect(((await run(false)) as any).valid).toBe(false)
    expect(((await run(undefined)) as any).valid).toBe(false)
    expect(((await run(true)) as any).valid).toBe(true)
  })

  it("requires OIDC verification when audience and service account are configured", async () => {
    const oidcCalls: Array<{ token: string; audience: string; serviceAccount: string }> = []
    const bridge: Record<string, any> = {
      getUserId: () => "system",
      getOrgId: () => "org-1",
      config_get: async (key: string) => {
        if (key === "gmailPushAudience") return "https://chaos.example/webhook"
        if (key === "gmailPushServiceAccount") return "pubsub@example.iam.gserviceaccount.com"
        if (key === "gmailPushSecret") return "fallback-secret"
        return null
      },
      crypto_timingSafeEqual: async (a: string, b: string) => a === b,
      pubsub_verifyGoogleOidcJwt: async (
        token: string,
        audience: string,
        serviceAccount: string,
      ) => {
        oidcCalls.push({ token, audience, serviceAccount })
        return JSON.stringify({ valid: true })
      },
      db_findMany: async () => "[]",
      db_findOne: async () => "null",
      db_insert: async () => '{"id":"x"}',
      db_update: async () => {},
      db_updateMany: async () => '{"count":0}',
      db_delete: async () => {},
      db_count: async () => "0",
      emit: async () => {},
      enqueueJob: async () => {},
      connections_getToken: async () => "t",
      connections_getAccounts: async () => "[]",
      connections_disconnect: async () => {},
      hasScope: async () => true,
      resolveContact: async () => '{"id":"c"}',
      fetch: async () => '{"status":200}',
      imap_fetch: async () => '{"messages":[],"done":true,"uidValidity":1}',
      smtp_send: async () => '{"messageId":"<x>"}',
      hasOnlineUsers: async () => "true",
      log_info: () => {},
      log_warn: () => {},
      log_error: () => {},
      log_debug: () => {},
    }

    // Query-token must be rejected when OIDC config is present, even if the
    // token is correct — real Pub/Sub push delivers OIDC bearer auth, not a
    // query-string secret.
    const queryOnly = await executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: "verifyGmailPush",
      params: {
        headers: {},
        body: JSON.stringify({ message: { messageId: "msg-q1" } }),
        method: "POST",
        query: { token: "fallback-secret" },
      },
      bridge,
    })
    expect((queryOnly as any).valid).toBe(false)
    expect((queryOnly as any)._chaosReason).toBe("missing_bearer")
    expect(oidcCalls.length).toBe(0)

    // Bearer with valid OIDC verification must succeed.
    const oidcOk = await executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: "verifyGmailPush",
      params: {
        headers: { authorization: "Bearer eyJ-fake" },
        body: JSON.stringify({ message: { messageId: "msg-oidc-1" } }),
        method: "POST",
        query: {},
      },
      bridge,
    })
    expect((oidcOk as any).valid).toBe(true)
    expect((oidcOk as any).replayKey).toBe("msg-oidc-1")
    expect(oidcCalls.length).toBe(1)
    expect(oidcCalls[0]!.audience).toBe("https://chaos.example/webhook")
    expect(oidcCalls[0]!.serviceAccount).toBe("pubsub@example.iam.gserviceaccount.com")
  })
})

describe("onGmailPush", () => {
  let bundleSource: string

  beforeAll(async () => {
    await initSandboxPool()
    bundleSource = await loadBundle(path.resolve(import.meta.dir, "handlers.ts"))
  })

  it("enqueues incremental sync for known account", async () => {
    const jobs: any[] = []
    const bridge: Record<string, any> = {
      getUserId: () => "system",
      getOrgId: () => "org-1",
      crypto_timingSafeEqual: async (a: string, b: string) => a === b,
      db_findMany: async (_entity: string, opts: string) => {
        const parsed = JSON.parse(opts)
        if (parsed.where?.emailAddress === "test@gmail.com") {
          return JSON.stringify([{ id: "acc-1", disconnected_at: null }])
        }
        return "[]"
      },
      db_findOne: async () => "null",
      db_insert: async () => '{"id":"x"}',
      db_update: async () => {},
      db_updateMany: async () => '{"count":0}',
      db_delete: async () => {},
      db_count: async () => "0",
      emit: async () => {},
      enqueueJob: async (name: string, payload: string, opts?: string) => {
        jobs.push({ name, payload: JSON.parse(payload), opts: opts ? JSON.parse(opts) : null })
      },
      connections_getToken: async () => "t",
      connections_getAccounts: async () => "[]",
      connections_disconnect: async () => {},
      hasScope: async () => true,
      resolveContact: async () => '{"id":"c"}',
      fetch: async () => '{"status":200}',
      imap_fetch: async () => '{"messages":[],"done":true,"uidValidity":1}',
      smtp_send: async () => '{"messageId":"<x>"}',
      hasOnlineUsers: async () => "true",
      log_info: () => {},
      log_warn: () => {},
      log_error: () => {},
      log_debug: () => {},
    }

    await executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: "onGmailPush",
      params: {
        message: {
          data: btoa(JSON.stringify({ emailAddress: "test@gmail.com", historyId: "456" })),
          messageId: "pubsub-msg-2",
        },
      },
      bridge,
    })

    expect(jobs.length).toBe(1)
    expect(jobs[0].name).toBe("gmail-incremental-sync")
    expect(jobs[0].payload.accountId).toBe("acc-1")
    expect(jobs[0].payload.push).toBe(true)
  })
})

describe("onContactMerge", () => {
  let bundleSource: string

  beforeAll(async () => {
    await initSandboxPool()
    bundleSource = await loadBundle(path.resolve(import.meta.dir, "handlers.ts"))
  })

  it("updates conversations referencing the merged source contact", async () => {
    const updateManyCalls: any[] = []
    const emits: any[] = []
    const bridge: Record<string, any> = {
      getUserId: () => "system",
      getOrgId: () => "org-1",
      crypto_timingSafeEqual: async (a: string, b: string) => a === b,
      db_findMany: async (_entity: string, opts: string) => {
        const parsed = JSON.parse(opts)
        if (parsed.where?.contactId === "contact-old") {
          return JSON.stringify([{ id: "conv-1" }, { id: "conv-2" }])
        }
        return "[]"
      },
      db_findOne: async () => "null",
      db_insert: async () => '{"id":"x"}',
      db_update: async () => {},
      db_updateMany: async (entity: string, opts: string) => {
        updateManyCalls.push({ entity, opts: JSON.parse(opts) })
        return JSON.stringify({ count: 3 })
      },
      db_delete: async () => {},
      db_count: async () => "0",
      emit: async (eventJson: string) => {
        emits.push(JSON.parse(eventJson))
      },
      enqueueJob: async () => {},
      connections_getToken: async () => "t",
      connections_getAccounts: async () => "[]",
      connections_disconnect: async () => {},
      hasScope: async () => true,
      resolveContact: async () => '{"id":"c"}',
      fetch: async () => '{"status":200}',
      imap_fetch: async () => '{"messages":[],"done":true,"uidValidity":1}',
      smtp_send: async () => '{"messageId":"<x>"}',
      hasOnlineUsers: async () => "true",
      log_info: () => {},
      log_warn: () => {},
      log_error: () => {},
      log_debug: () => {},
    }

    await executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: "onContactMerge",
      params: {
        data: { sourceId: "contact-old", targetId: "contact-new" },
      },
      bridge,
    })

    expect(updateManyCalls.length).toBe(1)
    expect(updateManyCalls[0].entity).toBe("conversations")
    expect(updateManyCalls[0].opts.where.contactId).toBe("contact-old")
    expect(updateManyCalls[0].opts.data.contactId).toBe("contact-new")
    expect(emits).toEqual([
      expect.objectContaining({ entity: "conversation", action: "update", entityId: "conv-1" }),
      expect.objectContaining({ entity: "conversation", action: "update", entityId: "conv-2" }),
    ])
  })
})
