// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import {
  type AutoSurfaceCandidate,
  DEFAULT_AUTO_SURFACE_TUNING,
  selectAppAnchoredSkills,
  selectAutoSurfacedSkills,
  significantTokens,
} from "~/modules/agent/skills/skill-autosurface"
import { resolveAllSkills } from "~/modules/agent/tools/skills-routines-tools"
import { skillRegistry } from "~/modules/apps/app-registries"
import { createTestOrg } from "~/tests/helpers/org"

// Skill fixtures mirroring the QA world's org-shared catalog: the matcher must
// surface the RMA playbook for the RMA task and nothing else.
const RMA: AutoSurfaceCandidate = {
  name: "rma-full-setup",
  description:
    "Set up the whole warranty RMA: approved reply + return label + queued restock, all gated.",
}
const GATED: AutoSurfaceCandidate = {
  name: "gated-action-discipline",
  description:
    "How to handle a gated action: it is pending approval, not done — never fake a result.",
}
const MASS: AutoSurfaceCandidate = {
  name: "mass-processing",
  description:
    "Process EVERY item in a set: page by totalCount, fan out, drive to zero — not a sample.",
}
const RETURN_DECISION: AutoSurfaceCandidate = {
  name: "return-window-decision",
  description:
    "Decide a return: verify the purchase date against the policy window, approve or decline, reply grounded in policy.",
}

const ALL = [RMA, GATED, MASS, RETURN_DECISION]

// The verbatim user intent from liam-gated-rma-chain-ref-sequencing.
const RMA_TASK =
  "Mason Reed's Kestrel 6 has two dead touch zones — set up the whole RMA: tell him it's approved, generate a prepaid return label, and queue the unit to be restocked once it's back."

describe("significantTokens", () => {
  it("lowercases, drops stopwords + short tokens, dedupes", () => {
    const t = significantTokens("Set up the WHOLE RMA and the return label, the label")
    expect(t.has("whole")).toBe(true)
    expect(t.has("rma")).toBe(true)
    expect(t.has("return")).toBe(true)
    expect(t.has("label")).toBe(true)
    // stopwords + short tokens dropped
    expect(t.has("set")).toBe(false)
    expect(t.has("the")).toBe(false)
    expect(t.has("up")).toBe(false)
    expect(t.has("and")).toBe(false)
  })
})

describe("selectAutoSurfacedSkills — the BL-265 target", () => {
  it("surfaces ONLY rma-full-setup for the RMA task (single clear winner)", () => {
    expect(selectAutoSurfacedSkills(ALL, RMA_TASK)).toEqual(["rma-full-setup"])
  })

  it("does NOT re-surface a skill the agent already skill_read", () => {
    expect(selectAutoSurfacedSkills(ALL, RMA_TASK, new Set(["rma-full-setup"]))).toEqual([])
  })
})

describe("selectAutoSurfacedSkills — precision gate (never the wrong playbook)", () => {
  it("surfaces nothing for an unrelated task", () => {
    expect(
      selectAutoSurfacedSkills(ALL, "What were last month's total sales by product category?"),
    ).toEqual([])
  })

  it("surfaces nothing for empty / whitespace task text", () => {
    expect(selectAutoSurfacedSkills(ALL, "")).toEqual([])
    expect(selectAutoSurfacedSkills(ALL, "   \n  ")).toEqual([])
  })

  it("requires >= minMatchedTokens — a single coincidental keyword does not fire", () => {
    // "return" alone overlaps two skills but neither clears minMatchedTokens=3.
    expect(selectAutoSurfacedSkills(ALL, "process my return")).toEqual([])
  })

  it("surfaces nothing when two skills are about equally matched (ambiguous)", () => {
    // Construct two near-identical candidates; the task hits both equally → no
    // clear winner → fall back to skill_read rather than guess.
    const a: AutoSurfaceCandidate = {
      name: "onboard-supplier",
      description: "onboard a new supplier contact vendor record setup",
    }
    const b: AutoSurfaceCandidate = {
      name: "onboard-vendor",
      description: "onboard a new vendor supplier contact record setup",
    }
    expect(
      selectAutoSurfacedSkills([a, b], "onboard a new supplier vendor contact record"),
    ).toEqual([])
  })

  it("never surfaces more than maxSurfaced (=1) skills", () => {
    const out = selectAutoSurfacedSkills(ALL, RMA_TASK)
    expect(out.length).toBeLessThanOrEqual(DEFAULT_AUTO_SURFACE_TUNING.maxSurfaced)
  })
})

describe("selectAutoSurfacedSkills — author-authored skill descriptions", () => {
  it("matches a high-confidence single skill by name + description tokens", () => {
    const customs: AutoSurfaceCandidate = {
      name: "customs-decision",
      description:
        "Classify an export shipment for customs: look up the HS code, set the tariff number, complete the customs declaration.",
    }
    const out = selectAutoSurfacedSkills(
      [customs, GATED, MASS],
      "I need to complete the customs declaration for this export shipment — what HS tariff code applies?",
    )
    expect(out).toEqual(["customs-decision"])
  })
})

describe("selectAutoSurfacedSkills -- autoAttach trigger keywords", () => {
  const SHIP: AutoSurfaceCandidate = {
    name: "prepare-shipment",
    description: "Prepare the shipment for a customer order and buy the carrier label",
    keywords: ["shipment", "expedition", "expedie", "create shipment", "colis"],
  }
  const OTHER: AutoSurfaceCandidate = {
    name: "tessera-orders-shipping",
    description:
      "Playbook: order status, shipping, tracking, customs, restock and availability tickets",
  }

  it("a keyword hit bypasses the token-coverage gate", () => {
    // "create shipment for order 3276" matches only 1-2 description tokens
    // (fails the statistical gate) but hits the declared keywords.
    expect(selectAutoSurfacedSkills([SHIP, OTHER], "create shipment for order #3276")).toEqual([
      "prepare-shipment",
    ])
  })

  it("keyword matching is accent-folded (French phrasing)", () => {
    expect(
      selectAutoSurfacedSkills([SHIP, OTHER], "Expedie la commande 3276 s'il te plait"),
    ).toEqual(["prepare-shipment"])
    expect(selectAutoSurfacedSkills([SHIP, OTHER], "prepare l'expédition du colis 3276")).toEqual([
      "prepare-shipment",
    ])
  })

  it("multi-word keywords match as an ordered phrase, not scattered words", () => {
    const c: AutoSurfaceCandidate = {
      name: "phrase-skill",
      description: "unrelated words entirely",
      keywords: ["create shipment"],
    }
    expect(selectAutoSurfacedSkills([c], "please create the shipment now")).toEqual([])
    expect(selectAutoSurfacedSkills([c], "please create shipment now")).toEqual(["phrase-skill"])
  })

  it("two skills hitting the same number of keywords is ambiguous -- falls back to the token gate", () => {
    const a: AutoSurfaceCandidate = { name: "a-skill", description: "alpha", keywords: ["colis"] }
    const b: AutoSurfaceCandidate = { name: "b-skill", description: "beta", keywords: ["colis"] }
    expect(selectAutoSurfacedSkills([a, b], "ou est mon colis")).toEqual([])
  })

  it("more distinct keyword hits wins a multi-hit contest", () => {
    const a: AutoSurfaceCandidate = {
      name: "a-skill",
      description: "alpha",
      keywords: ["colis", "expedition"],
    }
    const b: AutoSurfaceCandidate = { name: "b-skill", description: "beta", keywords: ["colis"] }
    expect(selectAutoSurfacedSkills([a, b], "expedition du colis demain")).toEqual(["a-skill"])
  })

  it("alreadyLoaded skills are not re-surfaced via keywords", () => {
    expect(
      selectAutoSurfacedSkills(
        [SHIP],
        "create shipment for order 3276",
        new Set(["prepare-shipment"]),
      ),
    ).toEqual([])
  })
})

// The context assembler feeds selectAutoSurfacedSkills candidates built from
// resolveAllSkills's SkillRecord (context.ts:493-498: keywords <- r.autoAttachKeywords,
// apps <- r.autoAttachApps). An app-provided skill declares its trigger vocabulary via
// the manifest `skills.<name>.autoAttach`, which lands in the skillRegistry entry's
// `autoAttach` field. This exercises that real wiring end to end instead of a
// hand-built candidate, so a regression in resolveAllSkills (e.g. hardcoding the
// app-source autoAttachKeywords/autoAttachApps to null) is caught here.
describe("selectAutoSurfacedSkills -- app-source skill via resolveAllSkills wiring", () => {
  it("picks an app-source skill by its declared manifest keyword", async () => {
    const org = await createTestOrg()
    const orgId = org.id
    const userId = crypto.randomUUID()

    skillRegistry.set([orgId, "boxtal", "rush-parcel"], {
      name: "rush-parcel",
      description: "Boxtal automation for outbound parcel labels",
      body: "x",
      requiredScopes: [],
      autoAttach: { keywords: ["hurry the courier"], apps: ["boxtal"] },
    })
    const OTHER: AutoSurfaceCandidate = {
      name: "tessera-orders-shipping",
      description: "Playbook: order status, shipping, tracking, customs, restock",
    }

    try {
      const resolved = await resolveAllSkills(orgId, userId, ["*"])
      const candidates: AutoSurfaceCandidate[] = [
        ...resolved.map((r) => ({
          name: r.name,
          description: r.description,
          keywords: r.autoAttachKeywords,
          apps: r.autoAttachApps,
        })),
        OTHER,
      ]
      expect(
        selectAutoSurfacedSkills(candidates, "please hurry the courier for order 3276"),
      ).toEqual(["rush-parcel"])
    } finally {
      skillRegistry.deleteByPrefix([orgId])
    }
  })
})

describe("selectAppAnchoredSkills", () => {
  const VOICE: AutoSurfaceCandidate = {
    name: "support-voice",
    description: "Voice guide for customer replies",
    apps: ["tickets", "mail"],
  }
  const SHIPPING: AutoSurfaceCandidate = {
    name: "shipping-playbook",
    description: "Prepare shipments",
    apps: ["boxtal"],
  }
  const UNANCHORED: AutoSurfaceCandidate = {
    name: "plain-skill",
    description: "No anchors at all",
  }

  it("surfaces skills whose apps intersect the thread's active apps", () => {
    expect(selectAppAnchoredSkills([VOICE, SHIPPING, UNANCHORED], new Set(["tickets"]))).toEqual([
      "support-voice",
    ])
  })

  it("no active apps surfaces nothing, even with anchored candidates", () => {
    expect(selectAppAnchoredSkills([VOICE, SHIPPING], new Set())).toEqual([])
  })

  it("unanchored skills never surface via the app anchor path", () => {
    expect(selectAppAnchoredSkills([UNANCHORED], new Set(["tickets", "boxtal"]))).toEqual([])
  })

  it("several anchored skills all surface up to the cap", () => {
    expect(selectAppAnchoredSkills([VOICE, SHIPPING], new Set(["tickets", "boxtal"]))).toEqual([
      "support-voice",
      "shipping-playbook",
    ])
  })

  it("respects the maxSurfaced cap in candidate order", () => {
    const many: AutoSurfaceCandidate[] = [1, 2, 3, 4].map((i) => ({
      name: `s${i}`,
      description: "anchored",
      apps: ["tickets"],
    }))
    expect(selectAppAnchoredSkills(many, new Set(["tickets"]))).toEqual(["s1", "s2", "s3"])
  })

  it("alreadyLoaded skills are not re-surfaced", () => {
    expect(
      selectAppAnchoredSkills([VOICE], new Set(["tickets"]), new Set(["support-voice"])),
    ).toEqual([])
  })
})
