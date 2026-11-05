// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import c2c from "../vectors/c2c.json"
import router from "../vectors/router-lookup.json"
import {
  CONTRACT_VERSION,
  CONTROL_MESSAGE_ID_HEADER,
  CONTROL_REQUEST_WINDOW_SECONDS,
  CONTROL_SIGNATURE_HEADER,
  CONTROL_TO_CELL_KEY_LABEL,
  CONTROL_TS_HEADER,
  cloudCreateOrgReplySchema,
  cloudCreateOrgRequestSchema,
  cloudErrorReplySchema,
  cloudHandoffReplySchema,
  cloudHandoffRequestSchema,
  contractVectors,
  controlCanonicalString,
  messageSchemas,
  ROUTER_LOOKUP_WINDOW_SECONDS,
  ROUTER_SIGNATURE_HEADER,
  ROUTER_TS_HEADER,
  registeredReply,
  routerLookupCanonicalString,
  routerLookupReplySchema,
  routerLookupRequestSchema,
  slugSchema,
} from "./index"
import * as node from "./node"
import * as web from "./web"

/** A verifier outcome as the fixtures write it. */
type Outcome = { ok: boolean; reason?: string; replayKey?: string }

const impls = [
  { name: "node", ...node },
  { name: "web", ...web },
] as const

describe("contract version", () => {
  test("is 2 and version-1 envelopes and replies stay valid", () => {
    expect(CONTRACT_VERSION).toBe(2)
    for (const [type, message] of Object.entries(contractVectors.valid)) {
      const schema = messageSchemas[type as keyof typeof messageSchemas]
      expect(schema.safeParse(message).success).toBe(true)
      expect(schema.safeParse({ ...message, v: 2 }).success).toBe(true)
      expect(schema.safeParse({ ...message, v: 3 }).success).toBe(false)
    }
    expect(registeredReply.safeParse(contractVectors.replies.registered).success).toBe(true)
    expect(
      registeredReply.safeParse({ ...contractVectors.replies.registered, contract: 2 }).success,
    ).toBe(true)
    expect(
      registeredReply.safeParse({ ...contractVectors.replies.registered, contract: 3 }).success,
    ).toBe(false)
  })
})

describe("c2c vectors: constants", () => {
  test("the fixture names the same label, window and headers as the code", () => {
    expect(c2c.label).toBe(CONTROL_TO_CELL_KEY_LABEL)
    expect(c2c.windowSeconds).toBe(CONTROL_REQUEST_WINDOW_SECONDS)
    expect(c2c.headers).toEqual({
      signature: CONTROL_SIGNATURE_HEADER,
      ts: CONTROL_TS_HEADER,
      messageId: CONTROL_MESSAGE_ID_HEADER,
    })
    expect(router.windowSeconds).toBe(ROUTER_LOOKUP_WINDOW_SECONDS)
    expect(router.headers).toEqual({ signature: ROUTER_SIGNATURE_HEADER, ts: ROUTER_TS_HEADER })
  })
})

for (const impl of impls) {
  describe(`c2c vectors (${impl.name})`, () => {
    test("k_c2c derivation is hex HMAC-SHA256(instanceKey, label)", async () => {
      expect(c2c.derive.length).toBeGreaterThan(0)
      for (const v of c2c.derive) {
        const key = await impl.deriveControlToCellKey(v.instanceKey)
        expect(key).toMatch(/^[0-9a-f]{64}$/)
        expect(key).toBe(v.controlKey)
      }
    })

    test("sign reproduces digest, canonical string and signature", async () => {
      for (const v of c2c.sign) {
        expect(await impl.sha256Hex(v.body)).toBe(v.bodySha256)
        expect(
          controlCanonicalString({
            ts: String(v.ts),
            messageId: v.messageId,
            method: v.method,
            path: v.path,
            bodySha256: v.bodySha256,
          }),
        ).toBe(v.canonical)
        const headers = await impl.signControlRequest(v.controlKey, {
          method: v.method,
          path: v.path,
          body: v.body,
          messageId: v.messageId,
          ts: v.ts,
        })
        expect(headers).toEqual({
          [CONTROL_SIGNATURE_HEADER]: v.signature,
          [CONTROL_TS_HEADER]: String(v.ts),
          [CONTROL_MESSAGE_ID_HEADER]: v.messageId,
        })
        // Bytes and string bodies sign the same; the signed request verifies.
        const fromBytes = await impl.signControlRequest(v.controlKey, {
          method: v.method,
          path: v.path,
          body: new TextEncoder().encode(v.body),
          messageId: v.messageId,
          ts: v.ts,
        })
        expect(fromBytes).toEqual(headers)
        const round = await impl.verifyControlRequest(v.controlKey, {
          method: v.method,
          path: v.path,
          body: v.body,
          headers: new Headers(headers),
          now: v.ts,
        })
        expect(round).toEqual({
          ok: true,
          ts: String(v.ts),
          messageId: v.messageId,
          replayKey: `${v.messageId}:${v.ts}`,
        })
      }
    })

    test("verify cases match the fixture (edges, tamper, malformed)", async () => {
      for (const v of c2c.verify) {
        const got = await impl.verifyControlRequest(v.controlKey, {
          method: v.method,
          path: v.path,
          body: v.body,
          headers: v.headers as Record<string, string>,
          now: v.now,
        })
        const shown: Outcome = got.ok ? { ok: true, replayKey: got.replayKey } : got
        const want: Outcome = v.expect
        expect({ name: v.name, got: shown }).toEqual({ name: v.name, got: want })
      }
    })

    test("each canonical field, tampered alone, fails", async () => {
      const v = c2c.sign[1]
      const headers = await impl.signControlRequest(v.controlKey, {
        method: v.method,
        path: v.path,
        body: v.body,
        messageId: v.messageId,
        ts: v.ts,
      })
      const verify = (over: Partial<{ method: string; path: string; body: string }>, h = headers) =>
        impl.verifyControlRequest(v.controlKey, {
          method: over.method ?? v.method,
          path: over.path ?? v.path,
          body: over.body ?? v.body,
          headers: h,
          now: v.ts,
        })
      const bad = { ok: false, reason: "bad_signature" } as const
      expect(await verify({ method: "GET" })).toEqual(bad)
      expect(await verify({ path: `${v.path}x` })).toEqual(bad)
      expect(await verify({ body: `${v.body} ` })).toEqual(bad)
      expect(await verify({}, { ...headers, [CONTROL_TS_HEADER]: String(v.ts - 1) })).toEqual(bad)
      expect(
        await verify(
          {},
          {
            ...headers,
            [CONTROL_MESSAGE_ID_HEADER]: "00000000-0000-4000-8000-000000000000",
          },
        ),
      ).toEqual(bad)
      // Lower-case method on either side is the same canonical METHOD.
      expect((await verify({ method: v.method.toLowerCase() })).ok).toBe(true)
    })

    test("a path with a query or without a leading slash is never signed", async () => {
      const req = { method: "POST", body: "", messageId: c2c.sign[0].messageId, ts: 1 }
      expect(() => impl.signControlRequest("k", { ...req, path: "/api/cloud/orgs?x=1" })).toThrow()
      expect(() => impl.signControlRequest("k", { ...req, path: "api/cloud/orgs" })).toThrow()
    })
  })

  describe(`router lookup vectors (${impl.name})`, () => {
    test("sign reproduces canonical string and signature", async () => {
      for (const v of router.sign) {
        expect(routerLookupCanonicalString(String(v.ts), v.slug)).toBe(v.canonical)
        const headers = await impl.signRouterLookup(v.routerSecret, v.slug, v.ts)
        expect(headers).toEqual({
          [ROUTER_TS_HEADER]: String(v.ts),
          [ROUTER_SIGNATURE_HEADER]: v.signature,
        })
        expect(
          await impl.verifyRouterLookup(v.routerSecret, { slug: v.slug, headers, now: v.ts }),
        ).toEqual({ ok: true })
      }
    })

    test("verify cases match the fixture (edges, tamper, malformed)", async () => {
      for (const v of router.verify) {
        const got = await impl.verifyRouterLookup(v.routerSecret, {
          slug: v.slug,
          headers: v.headers as Record<string, string>,
          now: v.now,
        })
        const shown: Outcome = got
        const want: Outcome = v.expect
        expect({ name: v.name, got: shown }).toEqual({ name: v.name, got: want })
      }
    })
  })
}

describe("vector coverage", () => {
  test("the fixtures carry window edges and every failure reason", () => {
    const reasons = (cases: { expect: { ok: boolean; reason?: string } }[]) =>
      new Set(cases.filter((c) => !c.expect.ok).map((c) => c.expect.reason))
    expect([...reasons(c2c.verify)].sort()).toEqual([
      "bad_signature",
      "malformed_header",
      "missing_header",
      "stale",
    ])
    expect([...reasons(router.verify)].sort()).toEqual([
      "bad_signature",
      "invalid_slug",
      "malformed_header",
      "missing_header",
      "stale",
    ])
    for (const [cases, window] of [
      [c2c.verify, CONTROL_REQUEST_WINDOW_SECONDS],
      [router.verify, ROUTER_LOOKUP_WINDOW_SECONDS],
    ] as const) {
      const names = cases.map((c) => c.name).join("\n")
      expect(names).toContain(`+${window} (window edge)`)
      expect(names).toContain(`-${window} (window edge)`)
      expect(names).toContain(`+${window + 1}`)
      expect(names).toContain(`-${window + 1}`)
    }
  })
})

describe("§3.4 body and reply schemas", () => {
  test("the create-org vector body parses; unknown keys, bad slug and bad plan fail", () => {
    const body = JSON.parse(c2c.sign[0].body)
    expect(cloudCreateOrgRequestSchema.safeParse(body).success).toBe(true)
    expect(
      cloudCreateOrgRequestSchema.safeParse({
        ...body,
        orgId: "7d1f3a52-9c4e-4b8a-8f61-2b0e5c9d4a17",
      }).success,
    ).toBe(true)
    for (const bad of [
      { ...body, extra: 1 },
      { ...body, slug: "Acme" },
      { ...body, slug: "acme-" },
      { ...body, plan: "enterprise" },
      { ...body, ownerEmail: "nope" },
      { ...body, locale: "french" },
    ]) {
      expect(cloudCreateOrgRequestSchema.safeParse(bad).success).toBe(false)
    }
  })

  test("create-org accepts optional includedCredits and caps; rejects malformed ones", () => {
    const body = JSON.parse(c2c.sign[0].body)
    const ok = { ...body, includedCredits: "10", caps: { seats: 3, storageGb: null } }
    expect(cloudCreateOrgRequestSchema.safeParse(ok).success).toBe(true)
    expect(cloudCreateOrgRequestSchema.safeParse({ ...body, includedCredits: "2.5" }).success).toBe(
      true,
    )
    for (const bad of [
      { ...body, includedCredits: "-1" },
      { ...body, includedCredits: 10 },
      { ...body, includedCredits: "1e3" },
      { ...body, caps: { seats: -1 } },
      { ...body, caps: { seats: 1.5 } },
      { ...body, caps: [] },
    ]) {
      expect(cloudCreateOrgRequestSchema.safeParse(bad).success).toBe(false)
    }
  })

  test("handoff body and replies", () => {
    expect(cloudHandoffRequestSchema.safeParse(JSON.parse(c2c.sign[1].body)).success).toBe(true)
    expect(cloudHandoffRequestSchema.safeParse({ orgId: "x" }).success).toBe(false)
    expect(
      cloudHandoffReplySchema.safeParse({
        ok: true,
        url: "https://acme-audio.example.com/login/magic?challengeId=c&token=t",
        expiresAt: "2026-11-02T00:10:00.000Z",
      }).success,
    ).toBe(true)
    expect(
      cloudHandoffReplySchema.safeParse({
        ok: true,
        url: "javascript:alert(1)",
        expiresAt: "2026-11-02T00:10:00.000Z",
      }).success,
    ).toBe(false)
    expect(
      cloudCreateOrgReplySchema.safeParse({
        ok: true,
        orgId: "7d1f3a52-9c4e-4b8a-8f61-2b0e5c9d4a17",
        slug: "acme-audio",
      }).success,
    ).toBe(true)
    expect(cloudErrorReplySchema.safeParse({ ok: false, code: "slug_taken" }).success).toBe(true)
    expect(cloudErrorReplySchema.safeParse({ ok: false, code: "boom" }).success).toBe(false)
  })

  test("router lookup body and replies", () => {
    expect(routerLookupRequestSchema.safeParse({ slug: "acme-audio" }).success).toBe(true)
    expect(routerLookupRequestSchema.safeParse({ slug: "acme.audio" }).success).toBe(false)
    for (const r of router.replies.valid) {
      expect(routerLookupReplySchema.safeParse(r).success).toBe(true)
    }
    for (const r of router.replies.invalid) {
      expect(routerLookupReplySchema.safeParse(r).success).toBe(false)
    }
  })

  test("slug bounds: 3 and 40 chars pass, 2 and 41 fail", () => {
    expect(slugSchema.safeParse("abc").success).toBe(true)
    expect(slugSchema.safeParse(`a${"b".repeat(38)}c`).success).toBe(true)
    expect(slugSchema.safeParse("ab").success).toBe(false)
    expect(slugSchema.safeParse(`a${"b".repeat(39)}c`).success).toBe(false)
  })
})

describe("reply schemas parse without the URL global (Control runs them in the app sandbox)", () => {
  const withoutUrl = <T>(fn: () => T): T => {
    const saved = globalThis.URL
    delete (globalThis as { URL?: unknown }).URL
    try {
      return fn()
    } finally {
      globalThis.URL = saved
    }
  }
  test("handoff reply", () => {
    const ok = withoutUrl(() =>
      cloudHandoffReplySchema.safeParse({
        ok: true,
        url: "https://acme.example.com/login/magic?challengeId=abc&token=x-y_z",
        expiresAt: "2026-11-02T20:00:00.000Z",
      }),
    )
    expect(ok.success).toBe(true)
    for (const url of [
      "ftp://acme.example.com/x",
      "https://",
      "javascript:alert(1)",
      "https://a b/",
    ]) {
      expect(
        withoutUrl(() =>
          cloudHandoffReplySchema.safeParse({
            ok: true,
            url,
            expiresAt: "2026-11-02T20:00:00.000Z",
          }),
        ).success,
      ).toBe(false)
    }
  })
  test("router lookup reply", () => {
    expect(
      withoutUrl(() =>
        routerLookupReplySchema.safeParse({ cellOrigin: "https://cell-t1-origin.example.com" }),
      ).success,
    ).toBe(true)
    expect(withoutUrl(() => routerLookupReplySchema.safeParse({ cellOrigin: null })).success).toBe(
      true,
    )
    expect(
      withoutUrl(() =>
        routerLookupReplySchema.safeParse({ cellOrigin: "http://cell-t1-origin.example.com" }),
      ).success,
    ).toBe(false)
  })
})
