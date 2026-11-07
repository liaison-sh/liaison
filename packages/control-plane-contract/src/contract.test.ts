// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import {
  ackReply,
  billingStateReplySchema,
  canonicalJson,
  cellBillingMessageSchemas,
  contractVectors,
  duplicateReply,
  ENDPOINTS,
  GITHUB_ENDPOINT,
  MESSAGE_TYPES,
  messageSchemas,
  REJECTION_CODES,
  registeredReply,
  rejectionReplySchema,
  retryLaterReplySchema,
} from "./index"
import { deriveInstanceKey, digest, signBody } from "./node"

const SRC = import.meta.dir
const REPO = resolve(SRC, "../../..")

/** The manifest's webhook-name pattern, read from the kernel so the two cannot drift. */
function webhookNamePattern(): RegExp {
  const source = readFileSync(join(REPO, "apps/api/src/modules/apps/manifest-schema.ts"), "utf8")
  const match = source.match(/const WEBHOOK_NAME_PATTERN = "([^"]+)"/)
  if (!match) throw new Error("WEBHOOK_NAME_PATTERN not found in manifest-schema.ts")
  return new RegExp(match[1].replaceAll("\\\\", "\\"))
}

describe("signing vectors", () => {
  test("every vector triple reproduces with node helpers", () => {
    expect(contractVectors.signing.length).toBe(4)
    for (const v of contractVectors.signing) {
      expect(deriveInstanceKey(v.masterSecret, v.instanceId)).toBe(v.instanceKey)
      expect(signBody(v.instanceKey, v.rawBody)).toBe(v.signature)
      expect(signBody(v.instanceKey, new TextEncoder().encode(v.rawBody))).toBe(v.signature)
    }
  })

  test("the same body (same ts) under another instance key does not reproduce the signature", () => {
    const [a, b] = contractVectors.signing
    expect(signBody(b.instanceKey, a.rawBody)).not.toBe(a.signature)
    expect(signBody(a.instanceKey, b.rawBody)).not.toBe(b.signature)
    // A key one character off is a wrong secret too.
    const flipped = `${a.instanceKey.slice(0, -1)}${a.instanceKey.endsWith("0") ? "1" : "0"}`
    expect(signBody(flipped, a.rawBody)).not.toBe(a.signature)
  })

  test("each signed body is a valid envelope of its type", () => {
    for (const v of contractVectors.signing) {
      const body = JSON.parse(v.rawBody) as { type: string }
      const schema =
        body.type in messageSchemas
          ? messageSchemas[body.type as keyof typeof messageSchemas]
          : cellBillingMessageSchemas[body.type as keyof typeof cellBillingMessageSchemas]
      expect({ type: body.type, ok: schema?.safeParse(body).success }).toEqual({
        type: body.type,
        ok: true,
      })
    }
  })
})

describe("endpoint names", () => {
  test("every ENDPOINTS value matches the manifest webhook-key regex", () => {
    const pattern = webhookNamePattern()
    expect(pattern.source).toBe("^[a-z0-9]([a-z0-9-]*[a-z0-9])?$")
    for (const name of [...Object.values(ENDPOINTS), GITHUB_ENDPOINT]) {
      expect({ name, ok: pattern.test(name) }).toEqual({ name, ok: true })
    }
    expect(pattern.test("bug_report")).toBe(false)
  })

  test("every message type has an envelope schema, a valid and an invalid vector", () => {
    expect(Object.keys(messageSchemas).sort()).toEqual([...MESSAGE_TYPES].sort())
    expect(Object.keys(contractVectors.valid).sort()).toEqual([...MESSAGE_TYPES].sort())
    expect(Object.keys(contractVectors.invalid).sort()).toEqual([...MESSAGE_TYPES].sort())
  })
})

describe("message vectors", () => {
  test("valid examples parse, invalid examples fail with the named path", () => {
    for (const type of MESSAGE_TYPES) {
      const valid = messageSchemas[type].safeParse(contractVectors.valid[type])
      expect({ type, error: valid.error?.issues ?? null }).toEqual({ type, error: null })

      const { message, path } = contractVectors.invalid[type]
      const invalid = messageSchemas[type].safeParse(message)
      expect({ type, success: invalid.success }).toEqual({ type, success: false })
      const paths = invalid.error?.issues.map((i) => i.path.map(String)) ?? []
      expect({ type, paths }).toEqual({ type, paths: expect.arrayContaining([[...path]]) })
    }
  })

  test("an envelope of one type does not parse as another", () => {
    expect(messageSchemas.heartbeat.safeParse(contractVectors.valid.deregister).success).toBe(false)
  })

  test("a bug-report without the email tick carries no reporter key", () => {
    const { reporter: _reporter, ...anonymous } = contractVectors.valid["bug-report"].data
    const parsed = messageSchemas["bug-report"].parse({
      ...contractVectors.valid["bug-report"],
      data: anonymous,
    })
    expect("reporter" in parsed.data).toBe(false)
  })

  test("a lead-update with no change is refused", () => {
    const empty = {
      ...contractVectors.valid["lead-update"],
      data: { leadId: contractVectors.valid.lead.data.leadId },
    }
    expect(messageSchemas["lead-update"].safeParse(empty).success).toBe(false)
  })
})

describe("reply vectors", () => {
  test("success replies parse", () => {
    expect(registeredReply.safeParse(contractVectors.replies.registered).success).toBe(true)
    expect(ackReply.safeParse(contractVectors.replies.ack).success).toBe(true)
    expect(duplicateReply.safeParse(contractVectors.replies.duplicate).success).toBe(true)
  })

  test("rejection and retry_later vectors parse", () => {
    const codes = contractVectors.rejections.map((r) => r.body.error.message).sort()
    expect(codes).toEqual(Object.values(REJECTION_CODES).sort())
    for (const r of contractVectors.rejections) {
      expect(r.status >= 400 && r.status < 500).toBe(true)
      expect(rejectionReplySchema.safeParse(r.body).success).toBe(true)
    }
    expect(rejectionReplySchema.safeParse({ error: { message: "Webhook rejected" } }).success).toBe(
      false,
    )
    expect(contractVectors.retryLater.length).toBeGreaterThan(0)
    for (const r of contractVectors.retryLater) {
      expect(retryLaterReplySchema.safeParse(r).success).toBe(true)
    }
  })

  test("a billing-state reply missing periodEnd fails", () => {
    const ok = {
      tier: "team",
      status: "active",
      billingPortalUrl: "https://cp.example/portal",
      checkoutUrl: "https://cp.example/checkout",
      includedCredits: "500",
      periodEnd: "2026-06-19T00:00:00Z",
    }
    expect(billingStateReplySchema.safeParse(ok).success).toBe(true)
    const { periodEnd: _periodEnd, ...missing } = ok
    expect(billingStateReplySchema.safeParse(missing).success).toBe(false)
  })
})

describe("canonical JSON and digest", () => {
  test("key order does not change the canonical form or the digest", () => {
    const a = { b: 1, a: { d: [3, { y: 1, x: 2 }], c: "s" }, u: undefined }
    const b = { a: { c: "s", d: [3, { x: 2, y: 1 }] }, b: 1 }
    expect(canonicalJson(a)).toBe('{"a":{"c":"s","d":[3,{"x":2,"y":1}]},"b":1}')
    expect(canonicalJson(a)).toBe(canonicalJson(b))
    expect(digest(a)).toBe(digest(b))
    expect(digest(a)).toMatch(/^[0-9a-f]{64}$/)
    expect(digest({ ...b, b: 2 })).not.toBe(digest(b))
  })
})

describe("sandbox safety", () => {
  test("index.ts has no node: import", () => {
    // index.ts and everything it pulls in is bundled into a sandboxed app.
    const files = readdirSync(SRC).filter(
      (f) => f.endsWith(".ts") && f !== "node.ts" && !f.endsWith(".test.ts"),
    )
    expect(files).toContain("index.ts")
    for (const file of files) {
      const text = readFileSync(join(SRC, file), "utf8")
      expect({ file, nodeImport: /from\s+["']node:|require\(\s*["']node:/.test(text) }).toEqual({
        file,
        nodeImport: false,
      })
    }
  })
})
