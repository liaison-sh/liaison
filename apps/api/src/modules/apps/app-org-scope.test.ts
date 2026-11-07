// SPDX-License-Identifier: FSL-1.1-ALv2
// The pure half of the org-private app boundary: name rule, capability
// allowlist (pinned), forbidden declarations. The predicate over real rows is
// proven in src/tests/integration/custom-apps-tenant-boundary.test.ts.
import { describe, expect, it, spyOn } from "bun:test"
import { createHash } from "node:crypto"
import * as privileged from "~/db/privileged"
import { _setEdition } from "~/lib/edition"
import {
  appOwnerOrg,
  appVisibleToOrg,
  assertCustomAppName,
  CUSTOM_APP_ALLOWED_CAPABILITIES,
  CustomAppNameError,
  customAppBase,
  customAppNameKey,
  customAppOrgKey,
  expectedCustomAppName,
  firstAppStatus,
  forbiddenCustomAppDeclaration,
  invalidateAppOrgScope,
  isOrgPrivateApp,
} from "~/modules/apps/app-org-scope"
import { sandboxTenantKey } from "~/modules/apps/custom-app-name"
import { KNOWN_CAPABILITIES } from "~/modules/apps/manifest-schema"

const ORG = "11111111-2222-3333-4444-555555555555"
const KEY = createHash("sha256").update(ORG).digest("hex").slice(0, 8)

describe("firstAppStatus: a catalog app on a shared cell (S33)", () => {
  const f = firstAppStatus
  it("stays out of the other workspaces until they add it", () => {
    expect(f({ managed: true, isOperatorOrg: false, instanceInstalled: true })).toBe("removed")
  })
  it("starts On for the operator, for in-tree or custom apps, and on self-hosted", () => {
    expect(f({ managed: true, isOperatorOrg: true, instanceInstalled: true })).toBe("active")
    expect(f({ managed: true, isOperatorOrg: false, instanceInstalled: false })).toBe("active")
    expect(f({ managed: false, isOperatorOrg: false, instanceInstalled: true })).toBe("active")
  })
})

describe("custom app names", () => {
  it("the org key is the first 8 hex of sha256(org id)", () => {
    expect(customAppOrgKey(ORG)).toBe(KEY)
    expect(expectedCustomAppName("crm", ORG)).toBe(`crm-o${KEY}`)
    expect(customAppNameKey(`crm-o${KEY}`)).toBe(KEY)
    expect(customAppNameKey("crm")).toBeNull()
    expect(customAppBase(`my-crm-o${KEY}`)).toBe("my-crm")
  })

  it("accepts <base>-o<own key> with a free base", () => {
    expect(() => assertCustomAppName(`crm-o${KEY}`, ORG, new Set(["tickets"]))).not.toThrow()
  })

  it("refuses a name without the suffix, with the expected name", () => {
    let err: unknown
    try {
      assertCustomAppName("crm", ORG, new Set())
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(CustomAppNameError)
    expect((err as CustomAppNameError).status).toBe(422)
    expect((err as CustomAppNameError).errorFields.expectedName).toBe(`crm-o${KEY}`)
    expect((err as Error).message).toContain(`crm-o${KEY}`)
  })

  it("refuses another org's suffix", () => {
    expect(() => assertCustomAppName("crm-o0badc0de", ORG, new Set())).toThrow(CustomAppNameError)
  })

  it("refuses a base that names a catalog or instance app", () => {
    expect(() => assertCustomAppName(`tickets-o${KEY}`, ORG, new Set(["tickets"]))).toThrow(
      /provides/,
    )
  })
})

describe("what a custom app may declare", () => {
  it("the capability allowlist is pinned (a new capability is refused until judged org-level)", () => {
    expect([...CUSTOM_APP_ALLOWED_CAPABILITIES]).toEqual([
      "agent.run",
      "realtime.publish",
      "bulk.fetch",
      "messages.post",
      "pdf.render",
      "sequences.allocate",
      "contacts.addToOrganisation",
    ])
    const refused = KNOWN_CAPABILITIES.filter(
      (c) => !(CUSTOM_APP_ALLOWED_CAPABILITIES as readonly string[]).includes(c),
    )
    // files.analyzeDocument spends the org's media credits on a file: refused until judged.
    expect(refused.sort()).toEqual(["agent.spawn", "files.analyzeDocument", "grants.setUserScopes"])
  })

  it("names the first forbidden declaration", () => {
    const base = { name: "x", version: "1.0.0" }
    expect(forbiddenCustomAppDeclaration({ ...base, capabilities: ["messages.post"] })).toBeNull()
    expect(forbiddenCustomAppDeclaration({ ...base, capabilities: ["grants.setUserScopes"] })).toBe(
      "grants.setUserScopes",
    )
    expect(forbiddenCustomAppDeclaration({ ...base, capabilities: ["agent.spawn"] })).toBe(
      "agent.spawn",
    )
    expect(
      forbiddenCustomAppDeclaration({ ...base, network: { allowPrivateHostsInTest: true } }),
    ).toBe("network.allowPrivateHostsInTest")
    expect(forbiddenCustomAppDeclaration({ ...base, trusted: true })).toBe("trusted")
    expect(forbiddenCustomAppDeclaration({ ...base, rlsManagedBy: "migration" })).toBe(
      "rlsManagedBy",
    )
    expect(forbiddenCustomAppDeclaration({ ...base, routes: ["/inbox"] })).toBe("routes")
    expect(forbiddenCustomAppDeclaration({ ...base, tools: { t: { timeoutMs: 60_000 } } })).toBe(
      "tools.t.timeoutMs",
    )
    expect(
      forbiddenCustomAppDeclaration({ ...base, tools: { t: { timeoutMs: 2_000 } } }),
    ).toBeNull()
    expect(forbiddenCustomAppDeclaration({ ...base, jobs: { j: { timeoutMs: 600_000 } } })).toBe(
      "jobs.j.timeoutMs",
    )
    expect(
      forbiddenCustomAppDeclaration({ ...base, webhooks: { w: { bodyLimitBytes: 5_000_000 } } }),
    ).toBe("webhooks.w.bodyLimitBytes")
    expect(forbiddenCustomAppDeclaration({ ...base, webhooks: { w: { timeoutMs: 18_000 } } })).toBe(
      "webhooks.w.timeoutMs",
    )
    expect(
      forbiddenCustomAppDeclaration({ ...base, webhooks: { w: { timeoutMs: 5_000 } } }),
    ).toBeNull()
    expect(forbiddenCustomAppDeclaration({ ...base, search: { timeoutMs: 10_000 } })).toBe(
      "search.timeoutMs",
    )
  })

  it("keeps foreign keys inside the app's own schema, and refuses triggers", () => {
    const base = { name: "x", version: "1.0.0" }
    const fk = (references: Record<string, unknown>) => ({
      ...base,
      schema: {
        deals: { fields: { title: "string" } },
        pins: { fields: { label: "string", target: { type: "uuid", references } } },
      },
    })
    // Its own table: allowed (no schema, or an empty one).
    expect(forbiddenCustomAppDeclaration(fk({ table: "deals", column: "id" }))).toBeNull()
    expect(
      forbiddenCustomAppDeclaration(fk({ schema: "", table: "deals", column: "id" })),
    ).toBeNull()
    // The kernel, another app, another tenant's custom app: refused, named.
    for (const schema of ["kernel", "app_crm_oaaaaaaaa", "app_tickets", "public"]) {
      expect(
        forbiddenCustomAppDeclaration(
          fk({ schema, table: "organizations", column: "id", onDelete: "restrict" }),
        ),
      ).toBe("schema.pins.fields.target.references")
    }
    expect(
      forbiddenCustomAppDeclaration({
        ...base,
        schema: {
          deals: {
            fields: { title: "string" },
            triggers: [{ name: "t", timing: "BEFORE", events: ["INSERT"], body: "BEGIN END" }],
          },
        },
      }),
    ).toBe("schema.deals.triggers")
  })
})

describe("every edition (D9): ownership comes from the owner row, never the edition", () => {
  for (const ed of ["self_hosted", "managed"] as const) {
    it(`${ed}: another org's key is refused before any database read; the owner rows decide the rest`, async () => {
      _setEdition(ed)
      invalidateAppOrgScope()
      const read = spyOn(privileged, "withSystemDb").mockImplementation((() => {
        throw new Error("the owner rows are unreadable")
      }) as never)
      try {
        // DB-free: a custom-app name of another org's key is never visible.
        expect(await appVisibleToOrg("crm-o00000000", ORG)).toBe(false)
        expect(await isOrgPrivateApp("crm-o00000000")).toBe(true)
        expect(read).not.toHaveBeenCalled()
        expect(await appVisibleToOrg("kernel", ORG)).toBe(true)
        // Anything else reads the owner rows, and fails closed when it cannot.
        await expect(appVisibleToOrg("tickets", ORG)).rejects.toThrow("unreadable")
        await expect(appVisibleToOrg(`crm-o${KEY}`, ORG)).rejects.toThrow("unreadable")
        await expect(appOwnerOrg("tickets")).rejects.toThrow("unreadable")
      } finally {
        read.mockRestore()
        invalidateAppOrgScope()
        _setEdition(null)
      }
    })
  }
})

describe("sandboxTenantKey (every edition)", () => {
  for (const ed of ["self_hosted", "managed"] as const) {
    it(`${ed}: an org's custom app counts against its org's share; any other app none`, () => {
      _setEdition(ed)
      try {
        expect(sandboxTenantKey(`crm-o${KEY}`)).toBe(`org:${KEY}`)
        expect(sandboxTenantKey("tickets")).toBeUndefined()
        expect(sandboxTenantKey(undefined)).toBeUndefined()
      } finally {
        _setEdition(null)
      }
    })
  }
})
