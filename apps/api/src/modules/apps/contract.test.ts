// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { validateAppDescriptor, validateAppManifest } from "~/modules/apps/contract"

describe("app contract validation", () => {
  it("accepts valid minimal descriptor", () => {
    const result = validateAppDescriptor({ name: "test", version: "1.0.0" })
    expect(result.success).toBe(true)
  })

  it("rejects missing name", () => {
    const result = validateAppDescriptor({ version: "1.0.0" })
    expect(result.success).toBe(false)
    expect(result.error).toContain("name")
  })

  it("rejects missing version", () => {
    const result = validateAppDescriptor({ name: "test" })
    expect(result.success).toBe(false)
  })

  it("rejects invalid semver", () => {
    const result = validateAppDescriptor({ name: "test", version: "not-semver" })
    expect(result.success).toBe(false)
  })

  it("rejects name with uppercase", () => {
    const result = validateAppDescriptor({ name: "Test", version: "1.0.0" })
    expect(result.success).toBe(false)
  })

  it("accepts name with hyphens", () => {
    const result = validateAppDescriptor({ name: "my-app", version: "1.0.0" })
    expect(result.success).toBe(true)
  })

  it("accepts a snake_case table name, as the manifest path does", () => {
    const schema = { external_records: { fields: { name: "string" } } }
    expect(validateAppDescriptor({ name: "test", version: "1.0.0", schema }).success).toBe(true)
    expect(validateAppManifest({ name: "test", version: "1.0.0", schema }).success).toBe(true)
  })

  it("rejects an uppercase table name", () => {
    const schema = { Records: { fields: { name: "string" } } }
    expect(validateAppDescriptor({ name: "test", version: "1.0.0", schema }).success).toBe(false)
  })

  it("rejects tool scope not prefixed with app name", () => {
    const result = validateAppDescriptor({
      name: "test",
      version: "1.0.0",
      tools: {
        myTool: {
          description: "A tool",
          requiredScopes: ["other:items:read"],
          handler: async () => {},
        },
      },
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain("requiredScopes")
  })

  it("accepts tool scope prefixed with app name", () => {
    const result = validateAppDescriptor({
      name: "test",
      version: "1.0.0",
      tools: {
        myTool: {
          description: "A tool",
          requiredScopes: ["test:items:read"],
          handler: async () => {},
        },
      },
    })
    expect(result.success).toBe(true)
  })

  it("rejects event type not matching entity:action format", () => {
    const result = validateAppDescriptor({
      name: "test",
      version: "1.0.0",
      events: { emits: ["invalid-format"] },
    })
    expect(result.success).toBe(false)
  })

  it("accepts valid event type", () => {
    const result = validateAppDescriptor({
      name: "test",
      version: "1.0.0",
      events: { emits: ["item:created", "item:updated"] },
    })
    expect(result.success).toBe(true)
  })

  it("rejects handler that is not a function", () => {
    const result = validateAppDescriptor({
      name: "test",
      version: "1.0.0",
      tools: {
        myTool: {
          description: "A tool",
          requiredScopes: ["test:items:read"],
          handler: "not a function",
        },
      },
    })
    expect(result.success).toBe(false)
  })

  it("rejects invalid dimension type", () => {
    const result = validateAppDescriptor({
      name: "test",
      version: "1.0.0",
      schema: {
        items: {
          dimensions: { team: { type: "invalid" } },
        },
      },
    })
    expect(result.success).toBe(false)
  })

  it("rejects a scheduled job whose name has a '.' or ':' (its fan-out run ids could not carry it)", () => {
    for (const name of ["sync.daily", "sync:daily"]) {
      const result = validateAppDescriptor({
        name: "test",
        version: "1.0.0",
        jobs: { [name]: { schedule: "0 3 * * *", handler: async () => {} } },
      })
      expect(result.success).toBe(false)
      if (!result.success) expect(JSON.stringify(result)).toContain("a scheduled job's name")
    }
  })

  it("rejects invalid cron expression in job schedule", () => {
    const result = validateAppDescriptor({
      name: "test",
      version: "1.0.0",
      jobs: {
        myJob: {
          schedule: "not a cron",
          handler: async () => {},
        },
      },
    })
    expect(result.success).toBe(false)
  })

  it("rejects webhook without verify function", () => {
    const result = validateAppDescriptor({
      name: "test",
      version: "1.0.0",
      webhooks: {
        "my-hook": {
          handler: async () => {},
        },
      },
    })
    expect(result.success).toBe(false)
  })

  it("accepts valid webhook", () => {
    const result = validateAppDescriptor({
      name: "test",
      version: "1.0.0",
      webhooks: {
        "my-hook": {
          handler: async () => {},
          verify: async () => true,
        },
      },
      webhookHealth: { probe: null, reason: "no upstream" },
    })
    expect(result.success).toBe(true)
    // The schema keeps the contract: the runtime reads it from the validated data.
    expect((result.data as { webhookHealth?: unknown }).webhookHealth).toEqual({
      probe: null,
      reason: "no upstream",
    })
  })

  it("rejects a descriptor with webhooks and no webhookHealth", () => {
    const result = validateAppDescriptor({
      name: "test",
      version: "1.0.0",
      webhooks: { "my-hook": { handler: async () => {}, verify: async () => true } },
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain("webhookHealth: required")
  })

  it("rejects timeline field referencing nonexistent field", () => {
    const result = validateAppDescriptor({
      name: "test",
      version: "1.0.0",
      schema: {
        items: {
          fields: { title: "string", status: "string" },
          timeline: ["nonexistent"],
        },
      },
    })
    expect(result.success).toBe(false)
  })

  it("accepts valid timeline fields", () => {
    const result = validateAppDescriptor({
      name: "test",
      version: "1.0.0",
      schema: {
        items: {
          fields: { title: "string", status: "string" },
          timeline: ["status"],
        },
      },
    })
    expect(result.success).toBe(true)
  })

  it("empty descriptor (only name + version) passes", () => {
    const result = validateAppDescriptor({ name: "minimal", version: "0.1.0" })
    expect(result.success).toBe(true)
  })

  it("provides actionable error messages", () => {
    const result = validateAppDescriptor({})
    expect(result.success).toBe(false)
    expect(result.error?.length).toBeGreaterThan(0)
  })

  it("toolSchema preserves trustBoundary field", () => {
    const result = validateAppDescriptor({
      name: "test",
      version: "1.0.0",
      tools: {
        myTool: {
          description: "Test",
          requiredScopes: ["test:items:read"],
          handler: () => {},
          trustBoundary: "internal",
        },
      },
    })
    expect(result.success).toBe(true)
    expect(result.data.tools.myTool.trustBoundary).toBe("internal")
  })

  it("toolSchema rejects invalid trustBoundary", () => {
    const result = validateAppDescriptor({
      name: "test",
      version: "1.0.0",
      tools: {
        myTool: {
          description: "Test",
          requiredScopes: ["test:items:read"],
          handler: () => {},
          trustBoundary: "bogus",
        },
      },
    })
    expect(result.success).toBe(false)
  })

  // --- Skills ---

  it("rejects descriptors that still declare skills.overview", () => {
    const r = validateAppDescriptor({
      name: "x",
      version: "1.0.0",
      skills: { overview: { type: "overview", description: "x", content: "x" } } as any,
    })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/skills\.overview/)
  })

  it("accepts a built-in skill with description ≤100 chars and required body", () => {
    const r = validateAppDescriptor({
      name: "tickets",
      version: "1.0.0",
      skills: {
        "draft-reply": {
          description: "Draft a reply from ticket context",
          body: "# How to draft a reply\n…",
          requiredScopes: ["tickets:write"],
        },
      },
    })
    expect(r.success).toBe(true)
  })

  it("rejects a skill description longer than 100 chars", () => {
    const r = validateAppDescriptor({
      name: "tickets",
      version: "1.0.0",
      skills: {
        "draft-reply": { description: "x".repeat(101), body: "x" },
      },
    })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/description/)
  })

  it("accepts an app-internal prompt", () => {
    const r = validateAppDescriptor({
      name: "tickets",
      version: "1.0.0",
      prompts: { summarizer: { content: "# Summarize\n…" } },
    })
    expect(r.success).toBe(true)
  })

  it("rejects a skill name that violates the kebab-case regex", () => {
    const r = validateAppDescriptor({
      name: "tickets",
      version: "1.0.0",
      skills: { "BAD NAME": { description: "x", body: "x" } } as any,
    })
    expect(r.success).toBe(false)
  })

  it("accepts descriptor without skills field (backward compatible)", () => {
    const result = validateAppDescriptor({ name: "test", version: "1.0.0" })
    expect(result.success).toBe(true)
    expect(result.data.skills).toBeUndefined()
  })

  it("approvalCard rejects non-record values", () => {
    const result = validateAppDescriptor({
      name: "test",
      version: "1.0.0",
      tools: {
        myTool: {
          description: "Test",
          requiredScopes: ["test:items:read"],
          handler: () => {},
          approvalCard: "<script>alert(1)</script>",
        },
      },
    })
    expect(result.success).toBe(false)
  })
})

describe("manifest schema extensions", () => {
  const base = {
    name: "ext-test",
    version: "1.0.0",
    _format: "manifest",
    _bundlePath: "/tmp/fake.js",
  }

  it("accepts entity with constraints and indexes", () => {
    const { _format, _bundlePath, ...manifestOnly } = {
      ...base,
      schema: {
        accounts: {
          fields: { emailAddress: "string", syncStatus: "string" },
          constraints: { unique: [["emailAddress"]] },
          indexes: [["syncStatus"]],
        },
      },
    }
    const result = validateAppManifest(manifestOnly)
    expect(result.success).toBe(true)
  })

  it("accepts entity without constraints or indexes (backwards compat)", () => {
    const { _format, _bundlePath, ...manifestOnly } = {
      ...base,
      schema: {
        items: { fields: { title: "string" } },
      },
    }
    const result = validateAppManifest(manifestOnly)
    expect(result.success).toBe(true)
  })

  it("rejects constraints referencing unknown fields", () => {
    const { _format, _bundlePath, ...manifestOnly } = {
      ...base,
      schema: {
        accounts: {
          fields: { emailAddress: "string" },
          constraints: { unique: [["nonExistent"]] },
        },
      },
    }
    const result = validateAppManifest(manifestOnly)
    expect(result.success).toBe(false)
    expect(result.error).toContain("nonExistent")
  })

  it("rejects indexes referencing unknown fields", () => {
    const { _format, _bundlePath, ...manifestOnly } = {
      ...base,
      schema: {
        accounts: {
          fields: { emailAddress: "string" },
          indexes: [["nonExistent"]],
        },
      },
    }
    const result = validateAppManifest(manifestOnly)
    expect(result.success).toBe(false)
    expect(result.error).toContain("nonExistent")
  })

  it("accepts editableFields on a handler-CONDITIONALLY-gated tool (conditionalGate: true)", () => {
    // invoice_issue gates inside its handler (ctx.requestApproval against the issuer threshold), so it
    // keeps `gated` unset; it marks `conditionalGate: true` to opt its approval payload into editing
    // (edit-gated-invoice-payment-terms-before-approve). The contract must accept editableFields here.
    const { _format, _bundlePath, ...manifestOnly } = {
      ...base,
      name: "ext-test",
      tools: {
        ext_test_issue: {
          description: "Issue, gated conditionally in the handler",
          requiredScopes: ["ext-test:documents:write"],
          handler: "issueHandler",
          conditionalGate: true,
          params: {
            type: "object",
            properties: { draft_id: { type: "string" }, due_at: { type: "string" } },
          },
          editableFields: [{ field: "due_at", label: "Due date", widget: "text" }],
        },
      },
    }
    const result = validateAppManifest(manifestOnly)
    expect(result.success).toBe(true)
  })

  it("pinnedParams: top-level keys only, and never editable", () => {
    const manifestWith = (tool: Record<string, unknown>) => {
      const { _format, _bundlePath, ...manifestOnly } = {
        ...base,
        name: "ext-test",
        tools: {
          ext_test_write: {
            description: "Gated write with a pinned target",
            requiredScopes: ["ext-test:documents:write"],
            handler: "writeHandler",
            gated: true,
            params: {
              type: "object",
              properties: { note: { type: "string" }, target: { type: "object" } },
            },
            ...tool,
          },
        },
      }
      return validateAppManifest(manifestOnly)
    }
    expect(manifestWith({ pinnedParams: ["target"] }).success).toBe(true)
    const dotted = manifestWith({ pinnedParams: ["target.host"] })
    expect(dotted.success).toBe(false)
    for (const field of ["target", "target.host"]) {
      const r = manifestWith({
        pinnedParams: ["target"],
        editableFields: [{ field, label: "Target", widget: "text" }],
      })
      expect(r.success).toBe(false)
      expect(r.error).toContain("pinned")
    }
    // A caller's value for a pinned param is dropped before the preflight, so a pinned param
    // the caller must pass could never be satisfied: every call would be refused.
    const required = manifestWith({
      pinnedParams: ["target"],
      params: {
        type: "object",
        properties: { note: { type: "string" }, target: { type: "object" } },
        required: ["target"],
      },
    })
    expect(required.success).toBe(false)
    expect(required.error).toContain('pinned param "target" is required')
  })

  it("descriptor pinnedParams entries never contain a dot", () => {
    const r = validateAppDescriptor({
      name: "test",
      version: "1.0.0",
      tools: {
        t: {
          description: "d",
          requiredScopes: ["test:x:write"],
          handler: async () => ({}),
          gated: true,
          pinnedParams: ["a.b"],
        },
      },
    })
    expect(r.success).toBe(false)
  })

  it("still REJECTS editableFields on a tool that is neither gated nor conditionalGate", () => {
    const { _format, _bundlePath, ...manifestOnly } = {
      ...base,
      name: "ext-test",
      tools: {
        ext_test_plain: {
          description: "Not gated at all",
          requiredScopes: ["ext-test:documents:write"],
          handler: "plainHandler",
          params: { type: "object", properties: { due_at: { type: "string" } } },
          editableFields: [{ field: "due_at", label: "Due date", widget: "text" }],
        },
      },
    }
    const result = validateAppManifest(manifestOnly)
    expect(result.success).toBe(false)
    expect(result.error).toContain("editableFields")
  })

  it("accepts approvalImpact on gated and handler-conditionally-gated tools", () => {
    const { _format, _bundlePath, ...manifestOnly } = {
      ...base,
      name: "ext-test",
      tools: {
        ext_test_send: {
          description: "Gated send",
          requiredScopes: ["ext-test:documents:write"],
          handler: "sendHandler",
          gated: true,
          approvalImpact: "external",
        },
        ext_test_issue: {
          description: "Handler-conditionally-gated issue",
          requiredScopes: ["ext-test:documents:write"],
          handler: "issueHandler",
          conditionalGate: true,
          approvalImpact: "internal",
        },
      },
    }
    const result = validateAppManifest(manifestOnly)
    expect(result.success).toBe(true)
  })

  it("REJECTS approvalImpact on a tool that is neither gated nor conditionalGate", () => {
    const { _format, _bundlePath, ...manifestOnly } = {
      ...base,
      name: "ext-test",
      tools: {
        ext_test_plain: {
          description: "Not gated at all",
          requiredScopes: ["ext-test:documents:write"],
          handler: "plainHandler",
          approvalImpact: "internal",
        },
      },
    }
    const result = validateAppManifest(manifestOnly)
    expect(result.success).toBe(false)
    expect(result.error).toContain("approvalImpact")
  })

  it("REJECTS an approvalImpact value outside the enum", () => {
    const { _format, _bundlePath, ...manifestOnly } = {
      ...base,
      name: "ext-test",
      tools: {
        ext_test_send: {
          description: "Gated send",
          requiredScopes: ["ext-test:documents:write"],
          handler: "sendHandler",
          gated: true,
          approvalImpact: "risky",
        },
      },
    }
    const result = validateAppManifest(manifestOnly)
    expect(result.success).toBe(false)
  })

  it("descriptor path: approvalImpact accepted on gated, rejected on ungated", () => {
    const gatedOk = validateAppDescriptor({
      name: "exttest",
      version: "1.0.0",
      tools: {
        send: {
          description: "Gated send",
          requiredScopes: ["exttest:documents:write"],
          handler: () => Promise.resolve({}),
          gated: true,
          approvalImpact: "external",
        },
      },
    })
    expect(gatedOk.success).toBe(true)

    const ungated = validateAppDescriptor({
      name: "exttest",
      version: "1.0.0",
      tools: {
        read: {
          description: "Plain read",
          requiredScopes: ["exttest:documents:read"],
          handler: () => Promise.resolve({}),
          approvalImpact: "internal",
        },
      },
    })
    expect(ungated.success).toBe(false)
    expect(ungated.error).toContain("approvalImpact")
  })

  it("accepts editableFields invalidates naming a sibling param, rejects unknown or self-referencing keys", () => {
    const makeManifest = (invalidates: unknown) => {
      const { _format, _bundlePath, ...manifestOnly } = {
        ...base,
        name: "ext-test",
        tools: {
          ext_test_send: {
            description: "Gated send with a derived htmlBody",
            requiredScopes: ["ext-test:documents:write"],
            handler: "sendHandler",
            gated: true,
            params: {
              type: "object",
              properties: { textBody: { type: "string" }, htmlBody: { type: "string" } },
            },
            editableFields: [{ field: "textBody", label: "Body", widget: "richtext", invalidates }],
          },
        },
      }
      return manifestOnly
    }

    expect(validateAppManifest(makeManifest(["htmlBody"])).success).toBe(true)

    const unknown = validateAppManifest(makeManifest(["notAParam"]))
    expect(unknown.success).toBe(false)
    expect(unknown.error).toContain("notAParam")

    const self = validateAppManifest(makeManifest(["textBody"]))
    expect(self.success).toBe(false)
    expect(self.error).toContain("cannot invalidate itself")

    // A non-array is rejected structurally by the manifest JSON schema (step 1).
    const notArray = validateAppManifest(makeManifest("htmlBody"))
    expect(notArray.success).toBe(false)
    expect(notArray.error).toContain("invalidates")
  })

  it("accepts oauth2 connection with extraParams", () => {
    const { _format, _bundlePath, ...manifestOnly } = {
      ...base,
      connections: {
        gmail: {
          type: "oauth2",
          authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
          tokenUrl: "https://oauth2.googleapis.com/token",
          extraParams: { access_type: "offline", prompt: "consent" },
          allowedDomains: ["*.googleapis.com"],
        },
      },
    }
    const result = validateAppManifest(manifestOnly)
    expect(result.success).toBe(true)
  })

  it("accepts credentials connection with empty allowedDomains", () => {
    const { _format, _bundlePath, ...manifestOnly } = {
      ...base,
      connections: {
        imap: {
          type: "credentials",
          credentialFields: [{ name: "email", label: "Email", type: "text" }],
          allowedDomains: [],
        },
      },
    }
    const result = validateAppManifest(manifestOnly)
    expect(result.success).toBe(true)
  })

  it("still requires non-empty allowedDomains for oauth2", () => {
    const { _format, _bundlePath, ...manifestOnly } = {
      ...base,
      connections: {
        gmail: {
          type: "oauth2",
          authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
          tokenUrl: "https://oauth2.googleapis.com/token",
          allowedDomains: [],
        },
      },
    }
    const result = validateAppManifest(manifestOnly)
    expect(result.success).toBe(false)
  })

  it("accepts job with onDemand: true and no schedule", () => {
    const { _format, _bundlePath, ...manifestOnly } = {
      ...base,
      jobs: {
        "initial-sync": { handler: "initialSync", onDemand: true },
      },
    }
    const result = validateAppManifest(manifestOnly)
    expect(result.success).toBe(true)
  })
})

describe("user-reference erasure declaration (G1)", () => {
  const base = (fields: any) => ({
    name: "x",
    version: "1.0.0",
    schema: { thing: { fields } },
  })

  it("accepts a well-formed userRef field", () => {
    const r = validateAppManifest(
      base({ ownerId: { type: "uuid", userRef: true, onErase: "anonymize" } }),
    )
    expect(r.success).toBe(true)
  })

  it("rejects userRef without onErase", () => {
    const r = validateAppManifest(base({ ownerId: { type: "uuid", userRef: true } }))
    expect(r.success).toBe(false)
  })

  it("rejects onErase without userRef", () => {
    const r = validateAppManifest(base({ ownerId: { type: "uuid", onErase: "delete" } }))
    expect(r.success).toBe(false)
  })

  it("rejects an invalid onErase value", () => {
    const r = validateAppManifest(
      base({ ownerId: { type: "uuid", userRef: true, onErase: "shred" } }),
    )
    expect(r.success).toBe(false)
  })

  it("also enforces the rule on the in-process descriptor path", () => {
    const ok = validateAppDescriptor({
      name: "x",
      version: "1.0.0",
      schema: {
        thing: { fields: { ownerId: { type: "uuid", userRef: true, onErase: "delete" } } },
      },
    })
    expect(ok.success).toBe(true)
    const bad = validateAppDescriptor({
      name: "x",
      version: "1.0.0",
      schema: { thing: { fields: { ownerId: { type: "uuid", userRef: true } } } },
    })
    expect(bad.success).toBe(false)
  })
})

// Every app with webhooks declares how the kernel judges its stream
// (modules/webhooks/ingest-health.ts): a scheduled probe job, or no probe and why.
describe("webhookHealth contract", () => {
  const base = (extra: Record<string, unknown>) => ({
    name: "hooks",
    version: "1.0.0",
    webhooks: { inbound: { handler: "onInbound", verify: "verifyInbound" } },
    jobs: {
      probe: { handler: "probeJob", schedule: "*/15 * * * *" },
      manual: { handler: "manualJob", onDemand: true },
    },
    ...extra,
  })
  const errorOf = (m: Record<string, unknown>) => {
    const r = validateAppManifest(m)
    expect(r.success).toBe(false)
    return r.error ?? ""
  }

  it("accepts a scheduled probe job", () => {
    expect(
      validateAppManifest(base({ webhookHealth: { probe: "probe" } })).error ?? null,
    ).toBeNull()
  })

  it("accepts probe null with a reason", () => {
    const r = validateAppManifest(base({ webhookHealth: { probe: null, reason: "push only" } }))
    expect(r.error ?? null).toBeNull()
  })

  it("rejects webhooks without webhookHealth", () => {
    expect(errorOf(base({}))).toContain("webhookHealth: required on an app that declares webhooks")
  })

  it("rejects a probe naming a missing job", () => {
    expect(errorOf(base({ webhookHealth: { probe: "nope" } }))).toContain(
      'job "nope" is not declared',
    )
  })

  it("rejects a probe naming an unscheduled job", () => {
    expect(errorOf(base({ webhookHealth: { probe: "manual" } }))).toContain(
      'job "manual" has no "schedule"',
    )
  })

  it("rejects probe null without a non-empty reason", () => {
    expect(errorOf(base({ webhookHealth: { probe: null } }))).toContain("webhookHealth.reason")
    expect(errorOf(base({ webhookHealth: { probe: null, reason: "   " } }))).toContain(
      "webhookHealth.reason",
    )
  })

  it("rejects a reason next to a probe, and a probe that is neither a job name nor null", () => {
    expect(errorOf(base({ webhookHealth: { probe: "probe", reason: "x" } }))).toContain(
      'only allowed when "probe" is null',
    )
    expect(errorOf(base({ webhookHealth: { probe: true } }))).toContain("webhookHealth.probe")
    expect(errorOf(base({ webhookHealth: { probe: "" } }))).toContain("webhookHealth.probe")
  })

  it("accepts a delivery grace next to a probe, and refuses it without one or out of range", () => {
    expect(
      validateAppManifest(base({ webhookHealth: { probe: "probe", deliveryGraceSec: 10800 } }))
        .error ?? null,
    ).toBeNull()
    expect(
      errorOf(base({ webhookHealth: { probe: null, reason: "push only", deliveryGraceSec: 600 } })),
    ).toContain('webhookHealth.deliveryGraceSec: only allowed with a "probe" job')
    for (const bad of [30, 90000, 1.5, "3h"]) {
      expect(errorOf(base({ webhookHealth: { probe: "probe", deliveryGraceSec: bad } }))).toContain(
        "deliveryGraceSec",
      )
    }
  })

  it("rejects the retired silenceSec and upstreamProbe keys by name", () => {
    const m = base({ webhookHealth: { probe: null, reason: "push only" } }) as any
    m.webhooks.inbound.silenceSec = 604800
    m.jobs.probe.upstreamProbe = true
    const error = errorOf(m)
    expect(error).toContain("webhooks.inbound.silenceSec: no longer accepted")
    expect(error).toContain("jobs.probe.upstreamProbe: no longer accepted")
  })

  it("rejects webhookHealth on an app without webhooks", () => {
    expect(
      errorOf({ name: "plain", version: "1.0.0", webhookHealth: { probe: null, reason: "x" } }),
    ).toContain("only allowed on an app that declares webhooks")
  })
})

// Declarative settings on a TS descriptor (settings-overhaul P2 T1): the zod
// descriptor schema strips unknown keys, so `kind` and `settings` must be
// declared to survive validation.
describe("descriptor kind and settings", () => {
  it("keeps kind and settings, and refuses a section naming an unknown tool", () => {
    const settings = {
      sections: [
        {
          id: "general",
          title: "General",
          scope: "org",
          blocks: [
            { block: "list", ops: { list: "items.list" }, columns: [{ key: "n", label: "N" }] },
          ],
        },
      ],
    }
    const tools = {
      "items.list": {
        description: "List",
        requiredScopes: ["descapp:items:read"],
        handler: async () => ({}),
      },
    }
    const ok = validateAppDescriptor({
      name: "descapp",
      version: "1.0.0",
      kind: "connector",
      settings,
      tools,
    })
    expect(ok.error).toBeUndefined()
    expect(ok.data.kind).toBe("connector")
    expect(ok.data.settings).toEqual(settings)

    const bad = validateAppDescriptor({
      name: "descapp",
      version: "1.0.0",
      settings: {
        sections: [
          {
            ...settings.sections[0],
            blocks: [{ ...settings.sections[0].blocks[0], ops: { list: "nope" } }],
          },
        ],
      },
      tools,
    })
    expect(bad.success).toBe(false)
    expect(bad.error).toContain('"nope" is not a tool of this app')
  })
})

// connections.<name>.adminScope: who administers the connection for the organization.
describe("connection adminScope", () => {
  const manifest = (adminScope: string) => ({
    name: "conn-scope",
    version: "1.0.0",
    scopes: ["conn_scope:admin:connection"],
    connections: {
      keys: {
        type: "credentials",
        allowedDomains: ["x.test"],
        credentialFields: [{ name: "token", label: "Token", type: "password" }],
        adminScope,
      },
    },
  })

  it("accepts one of the app's own declared scopes", () => {
    expect(validateAppManifest(manifest("conn_scope:admin:connection")).success).toBe(true)
  })

  it("refuses a scope outside the app's namespace", () => {
    const r = validateAppManifest(manifest("kernel:apps:admin"))
    expect(r.success).toBe(false)
    expect(r.error).toContain("connections.keys.adminScope")
  })

  it("refuses an undeclared scope of its own namespace", () => {
    const r = validateAppManifest(manifest("conn_scope:nobody:has"))
    expect(r.success).toBe(false)
    expect(r.error).toContain("connections.keys.adminScope")
  })
})

describe("app icon as data (S1)", () => {
  const SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/></svg>'

  it("registers a manifest whose iconSvg is clean markup and whose iconName is in the set", () => {
    const result = validateAppManifest({
      name: "acme",
      version: "1.0.0",
      iconSvg: SVG,
      iconName: "gauge",
    })
    expect(result.success).toBe(true)
  })

  it("refuses at registration an iconSvg carrying script, naming it", () => {
    const result = validateAppManifest({
      name: "acme",
      version: "1.0.0",
      iconSvg: SVG.replace("<circle", '<circle onclick="x()"'),
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain("its iconSvg contains the attribute onclick")
  })

  it("refuses an iconSvg over 8 KB and an unknown iconName", () => {
    const big = validateAppManifest({ name: "acme", version: "1.0.0", iconSvg: "x".repeat(8193) })
    expect(big.success).toBe(false)
    const named = validateAppManifest({ name: "acme", version: "1.0.0", iconName: "skull" })
    expect(named.error).toContain("its iconName 'skull' is not an icon of Liaison's icon set")
  })
})

describe("dimension references name a declared dimension", () => {
  const schema = {
    records: {
      fields: { name: "string", market: "string" },
      dimensions: { market: { type: "membership", values: ["eu", "us"] } },
    },
  }
  const searchTool = (dimension: string) => ({
    description: "Search the upstream",
    handler: "search",
    requiredScopes: ["dimref:records:read"],
    returns: { schema: { market: "string" }, dimensions: { market: dimension } },
  })

  it("accepts a tool response filter on a dimension the app declares", () => {
    const manifest = {
      name: "dimref",
      version: "1.0.0",
      schema,
      tools: { search: searchTool("dimref:market") },
    }
    expect(validateAppManifest(manifest).success).toBe(true)
  })

  it("rejects a tool response filter on an undeclared dimension, in the manifest and the descriptor", () => {
    const manifest = {
      name: "dimref",
      version: "1.0.0",
      schema,
      tools: { search: searchTool("dimref:region") },
    }
    const fromManifest = validateAppManifest(manifest)
    expect(fromManifest.success).toBe(false)
    expect(fromManifest.error).toContain(
      `tools.search.returns.dimensions.market: "dimref:region" is not a dimension of "dimref"`,
    )
    expect(fromManifest.error).toContain("declared: dimref:market")
    const fromDescriptor = validateAppDescriptor({
      ...manifest,
      tools: { search: { ...searchTool("dimref:region"), handler: () => [] } },
    })
    expect(fromDescriptor.success).toBe(false)
    expect(fromDescriptor.error).toContain('"dimref:region" is not a dimension of "dimref"')
  })

  it("rejects another app's dimension and one named by its short key", () => {
    for (const key of ["tickets:team", "market"]) {
      const manifest = {
        name: "dimref",
        version: "1.0.0",
        schema,
        tools: { search: searchTool(key) },
      }
      expect(validateAppManifest(manifest).error).toContain(
        `"${key}" is not a dimension of "dimref"`,
      )
    }
  })

  it("rejects an export filter on an undeclared dimension and says none are declared", () => {
    const manifest = {
      name: "dimref",
      version: "1.0.0",
      export: { formats: ["json"], handler: "exportAll", dimensions: { market: "dimref:market" } },
    }
    const result = validateAppManifest(manifest)
    expect(result.success).toBe(false)
    expect(result.error).toContain(
      `export.dimensions.market: "dimref:market" is not a dimension of "dimref"`,
    )
    expect(result.error).toContain("declared: none")
  })
})

describe("knowledgeSources contract", () => {
  const manifest = (kinds: unknown) => ({
    name: "notes-app",
    version: "1.0.0",
    knowledgeSources: kinds,
  })
  const errorOf = (m: Record<string, unknown>) => {
    const r = validateAppManifest(m)
    expect(r.success).toBe(false)
    return r.error ?? ""
  }

  it("accepts a kind with its handler, own read scope, config schema and timeout", () => {
    const r = validateAppManifest(
      manifest({
        notes: {
          title: "Notes",
          handler: "syncNotes",
          readScope: "notes_app:notes:read",
          configSchema: { type: "object", properties: { folder: { type: "string" } } },
          timeoutMs: 30_000,
        },
      }),
    )
    expect(r.error ?? null).toBeNull()
  })

  it("rejects a kind without a handler, a bad name, an unknown key or a timeout past 120 s", () => {
    expect(errorOf(manifest({ notes: { title: "Notes" } }))).toContain("handler")
    expect(errorOf(manifest({ Notes: { title: "Notes", handler: "h" } }))).toContain(
      "knowledgeSources",
    )
    expect(errorOf(manifest({ notes: { title: "N", handler: "h", cursor: 1 } }))).toContain(
      "cursor",
    )
    expect(
      errorOf(manifest({ notes: { title: "N", handler: "h", timeoutMs: 600_000 } })),
    ).toContain("timeoutMs")
  })

  it("rejects a read scope outside the app and a config schema that does not compile", () => {
    expect(
      errorOf(
        manifest({ notes: { title: "N", handler: "h", readScope: "knowledge:documents:read" } }),
      ),
    ).toContain('knowledgeSources.notes.readScope: must start with "notes_app:"')
    expect(
      errorOf(manifest({ notes: { title: "N", handler: "h", configSchema: { type: "nope" } } })),
    ).toContain("knowledgeSources.notes.configSchema: not a valid JSON Schema")
  })
})
