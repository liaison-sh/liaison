// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { selectAppAnchoredSkills } from "~/modules/agent/skills/skill-autosurface"
import { resolveAllSkills } from "~/modules/agent/tools/skills-routines-tools"
import {
  anchorsOf,
  formatSurfacedSkill,
  MAX_CATALOG_DESCRIPTION_CHARS,
  MAX_CATALOG_ENTRIES,
  MAX_SKILLS_PER_RESULT,
  renderSkillCatalog,
  type SurfaceableSkill,
  selectSkillsToSurface,
} from "~/modules/mcp/skill-surfacing"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

// The real prod skill at the centre of the 2026-08-04 field failure: an org
// playbook anchored to the boxtal app, which an MCP client never received.
const PREPARE_SHIPMENT: SurfaceableSkill = {
  name: "prepare-shipment",
  description: "Prepare the shipment for a customer order and buy the carrier label",
  body: "# Prepare an outbound shipment (Tessera orders)\n\n## 1. Identify the order...",
  apps: ["boxtal", "invoicing", "shopify"],
  appName: null,
  source: "org",
}
const BOXTAL_OVERVIEW: SurfaceableSkill = {
  name: "boxtal-overview",
  description: "How to use the Boxtal shipping app with Liaison",
  body: "Boxtal connects your shop's orders to carrier shipping labels...",
  apps: null,
  appName: "boxtal",
  source: "app",
}
const SUPPORT_VOICE: SurfaceableSkill = {
  name: "tessera-support-voice",
  description: "Voice guide for every Fabrikam customer reply",
  body: "Question-first diagnosis, human tone, FR tutoiement.",
  apps: ["tickets"],
  appName: null,
  source: "org",
}

const CATALOG = [PREPARE_SHIPMENT, BOXTAL_OVERVIEW, SUPPORT_VOICE]

describe("selectSkillsToSurface — the field regression", () => {
  it("surfaces the anchored org playbook on the first boxtal tool call", () => {
    // THE FIX. Quinn's client called boxtal__prep_list and got only drafts back;
    // the playbook existed, anchored to boxtal, and was never delivered.
    const picked = selectSkillsToSurface(CATALOG, "boxtal", new Set())
    expect(picked.map((s) => s.name)).toContain("prepare-shipment")
  })

  it("does NOT re-surface a skill already sent on this connection", () => {
    const picked = selectSkillsToSurface(CATALOG, "boxtal", new Set(["prepare-shipment"]))
    expect(picked.map((s) => s.name)).not.toContain("prepare-shipment")
  })

  it("surfaces nothing once every anchored skill has been sent", () => {
    const sent = new Set(["prepare-shipment", "boxtal-overview"])
    expect(selectSkillsToSurface(CATALOG, "boxtal", sent)).toEqual([])
  })

  it("does not surface a skill anchored to a DIFFERENT app", () => {
    const picked = selectSkillsToSurface(CATALOG, "boxtal", new Set())
    expect(picked.map((s) => s.name)).not.toContain("tessera-support-voice")
  })

  it("surfaces the tickets playbook for a tickets tool, not the shipping one", () => {
    const picked = selectSkillsToSurface(CATALOG, "tickets", new Set())
    expect(picked.map((s) => s.name)).toEqual(["tessera-support-voice"])
  })

  it("returns nothing for an app no skill anchors to", () => {
    expect(selectSkillsToSurface(CATALOG, "pennylane", new Set())).toEqual([])
  })

  it("returns nothing for an empty app name (a kernel tool with no prefix)", () => {
    expect(selectSkillsToSurface(CATALOG, "", new Set())).toEqual([])
  })

  it("a platform (kernel) tool call surfaces no skill, kernel-owned or not", () => {
    // Live Oracle walk: describe_user_access over MCP came back carrying the
    // kernel's sub-agent-dispatch and exhaustive-sweeps playbooks, because
    // every kernel skill is owned by `kernel` and the first kernel call
    // anchored them all.
    const kernelSkills: SurfaceableSkill[] = ["sub-agent-dispatch", "exhaustive-sweeps"].map(
      (name) => ({
        name,
        description: "d",
        body: "b",
        apps: null,
        appName: "kernel",
        source: "app",
      }),
    )
    expect(selectSkillsToSurface([...kernelSkills, ...CATALOG], "kernel", new Set())).toEqual([])
    expect(anchorsOf(kernelSkills[0] as SurfaceableSkill).has("kernel")).toBe(false)
  })

  it("caps how many bodies ride on ONE tool result", () => {
    const many: SurfaceableSkill[] = Array.from({ length: 6 }, (_, i) => ({
      name: `s-${i}`,
      description: "d",
      body: "b",
      apps: ["boxtal"],
      appName: null,
      source: "org",
    }))
    expect(selectSkillsToSurface(many, "boxtal", new Set()).length).toBe(MAX_SKILLS_PER_RESULT)
  })

  it("skips a skill with an empty body — there is nothing to teach", () => {
    const empty: SurfaceableSkill = { ...PREPARE_SHIPMENT, body: "" }
    expect(selectSkillsToSurface([empty], "boxtal", new Set())).toEqual([])
  })
})

describe("anchorsOf", () => {
  it("treats an app-shipped skill's owning app as an implicit anchor", () => {
    expect([...anchorsOf(BOXTAL_OVERVIEW)]).toEqual(["boxtal"])
  })

  it("unions declared anchors with the owning app", () => {
    const both: SurfaceableSkill = { ...PREPARE_SHIPMENT, appName: "invoicing" }
    expect([...anchorsOf(both)].sort()).toEqual(["boxtal", "invoicing", "shopify"])
  })

  it("is empty for an unanchored skill", () => {
    const none: SurfaceableSkill = { ...PREPARE_SHIPMENT, apps: null, appName: null }
    expect([...anchorsOf(none)]).toEqual([])
  })
})

describe("renderSkillCatalog", () => {
  it("lists every skill with its declared trigger words", () => {
    const out = renderSkillCatalog([
      {
        name: "prepare-shipment",
        description: "Prepare the shipment for a customer order and buy the carrier label",
        keywords: ["expedition", "colis", "create shipment"],
        source: "org",
      },
    ])
    expect(out).toContain("prepare-shipment")
    expect(out).toContain("expedition")
    expect(out).toContain("create shipment")
  })

  it("puts org and personal skills ahead of app-shipped ones", () => {
    const out = renderSkillCatalog([
      { name: "boxtal-overview", description: "app blurb", source: "app" },
      { name: "prepare-shipment", description: "org playbook", source: "org" },
      { name: "my-macro", description: "personal", source: "personal" },
    ])
    expect(out.indexOf("my-macro")).toBeLessThan(out.indexOf("prepare-shipment"))
    expect(out.indexOf("prepare-shipment")).toBeLessThan(out.indexOf("boxtal-overview"))
  })

  it("tells the client the list is COMPLETE, so a thin search is not proof of absence", () => {
    const out = renderSkillCatalog([{ name: "a", description: "d", source: "org" }])
    expect(out.toLowerCase()).toContain("complete")
  })

  it("steers away from authoring a duplicate", () => {
    const out = renderSkillCatalog([{ name: "a", description: "d", source: "org" }])
    expect(out.toLowerCase()).toContain("do not author a new skill")
  })

  it("returns an empty string when the caller can see no skills", () => {
    expect(renderSkillCatalog([])).toBe("")
  })

  it("caps entries and says how many were omitted rather than truncating silently", () => {
    const many = Array.from({ length: MAX_CATALOG_ENTRIES + 5 }, (_, i) => ({
      name: `s-${String(i).padStart(3, "0")}`,
      description: "d",
      source: "org" as const,
    }))
    const out = renderSkillCatalog(many)
    expect(out).toContain("+5 more")
    expect(out).toContain("kernel__list_skills")
  })

  it("elides an overlong description instead of dumping it", () => {
    const out = renderSkillCatalog([{ name: "a", description: "x".repeat(400), source: "org" }])
    // Assert the LINE is capped, not the whole block (which also carries the
    // header + footer instructions).
    const line = out.split("\n").find((l) => l.startsWith("- a:")) ?? ""
    expect(line.length).toBeLessThanOrEqual(MAX_CATALOG_DESCRIPTION_CHARS + "- a: ".length)
    expect(line).toContain("…")
    expect(line).not.toContain("x".repeat(MAX_CATALOG_DESCRIPTION_CHARS + 1))
  })
})

describe("formatSurfacedSkill", () => {
  it("frames the body as org procedure, not as fetched data", () => {
    const f = formatSurfacedSkill(PREPARE_SHIPMENT)
    expect(f.body).toContain("## Skill: prepare-shipment")
    expect(f.body).toContain("# Prepare an outbound shipment")
    expect(f.reason.toLowerCase()).toContain("org procedure")
  })
})

// --- P3-T21: the two channels draw from ONE source -------------------------
//
// spec-runtime.md's note is "already unified, confirm not rebuild": the MCP
// catalog (`transport-routes.ts`, rendered by renderSkillCatalog) and the in-app
// auto-surfacing path (`context.ts`, fed by selectAutoSurfacedSkills /
// selectAppAnchoredSkills) both resolve their skills through resolveAllSkills.
// These cases drive that real path against the database so an admin editing a
// skill cannot change one channel without the other.
describe("skill surfacing parity: MCP catalog vs in-app auto surfacing", () => {
  const ORG_ID = "00000000-0000-0000-0000-000000cf0041"
  const USER_ID = "00000000-0000-0000-0000-000000cf0042"
  const SEEDED = [
    {
      name: "parity-prepare-shipment",
      description: "Prepare the shipment for a customer order and buy the label",
      keywords: ["shipment", "label"],
    },
    {
      name: "parity-support-voice",
      description: "Voice guide for every customer reply",
      keywords: ["reply", "tone"],
    },
    {
      name: "parity-rma",
      description: "Run the whole warranty RMA end to end",
      keywords: ["rma", "warranty"],
    },
  ]

  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'ParityOrg', 'parity-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_ID}, ${ORG_ID}, 'parity@test.com', 'Parity User') ON CONFLICT DO NOTHING`
    for (const s of SEEDED) {
      const autoAttach = JSON.stringify({ apps: ["tickets"], keywords: s.keywords })
      await sql`INSERT INTO kernel.skills (org_id, author_user_id, name, description, body, auto_attach, created_by_actor_type)
        VALUES (${ORG_ID}, NULL, ${s.name}, ${s.description}, ${`${s.name} body`}, ${autoAttach}::jsonb, 'user')
        ON CONFLICT DO NOTHING`
    }
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.skills WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
    await releaseTestLock()
  })

  /** Exactly what context.ts builds its surfacing candidates from. */
  const inAppCandidates = (rows: Awaited<ReturnType<typeof resolveAllSkills>>) =>
    rows.map((r) => ({
      name: r.name,
      description: r.description,
      keywords: r.autoAttachKeywords,
      apps: r.autoAttachApps,
    }))

  it("renderSkillCatalog's name set equals the in-app surfaced set for the same agent", async () => {
    const resolved = await resolveAllSkills(ORG_ID, USER_ID, ["*"])
    const catalogNames = renderSkillCatalog(
      resolved.map((r) => ({
        name: r.name,
        description: r.description,
        keywords: r.autoAttachKeywords,
        source: r.source,
      })),
    )
      .split("\n")
      .filter((l) => l.startsWith("- "))
      .map((l) => l.slice(2).split(":")[0])
    // The in-app channel, driven by the same rows: all three are anchored to
    // the tickets app, which is the thread's conversation evidence.
    const surfaced = selectAppAnchoredSkills(inAppCandidates(resolved), new Set(["tickets"]))
    expect(new Set(catalogNames)).toEqual(new Set(SEEDED.map((s) => s.name)))
    expect(new Set(surfaced)).toEqual(new Set(catalogNames))
  })

  it("renders each shared skill's description and triggers byte for byte as the in-app path sees them", async () => {
    const resolved = await resolveAllSkills(ORG_ID, USER_ID, ["*"])
    const catalog = renderSkillCatalog(
      resolved.map((r) => ({
        name: r.name,
        description: r.description,
        keywords: r.autoAttachKeywords,
        source: r.source,
      })),
    )
    for (const candidate of inAppCandidates(resolved)) {
      const line = catalog.split("\n").find((l) => l.startsWith(`- ${candidate.name}:`))
      expect(line).toBeDefined()
      const rendered = (line as string).slice(`- ${candidate.name}: `.length)
      const triggers = ` [triggers: ${(candidate.keywords ?? []).join(", ")}]`
      expect(rendered).toBe(`${candidate.description}${triggers}`)
    }
  })
})
