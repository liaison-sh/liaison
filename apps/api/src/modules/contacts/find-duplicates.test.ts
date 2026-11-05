// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Unit regression for the BL-266 server-side duplicate-CLUSTER detector
// (clusterDuplicates + the normalize/compare helpers in contacts/service.ts).
//
// The load-bearing guarantees this scenario's verdict depends on:
//   • the 12 GENUINE duplicate pairs in the drifted-CRM fixture cluster, and as HIGH-confidence
//     (so a weak model can merge them from a grounded list instead of guessing + fabricating);
//   • the near-duplicate TRAPS (different given-name root / different person) are NEVER high-
//     confidence — they must be needs_confirmation (surfaced, not auto-merged) so the irreversible
//     merge can't destroy a real distinct record;
//   • a shared provider externalId clusters two records even with no name/email match (cross-channel
//     identity), and a normalized-email variant (+tag / gmail dots) clusters too.
//
// Drives the REAL fixture (DEDUPE_CONTACTS) through the pure clusterer so the detector and the world
// can never silently drift apart. No DB boot — fast, deterministic.

import { describe, expect, it } from "bun:test"
import { DEDUPE_CONTACTS } from "./__fixtures__/dedupe-contacts"
import {
  clusterDuplicates,
  compareNames,
  type DuplicateCluster,
  normalizeEmailForDedup,
  normalizeNameForDedup,
} from "./service"

// Map the fixture rows (handle/name/email/company) into the detector's DedupRow shape, using the
// handle as a stable synthetic id so we can trace which cluster a given seeded contact landed in.
function fixtureRows() {
  return DEDUPE_CONTACTS.map((c) => ({
    id: c.handle,
    name: c.name,
    email: c.email,
    company: c.company,
    externalIds: null,
  }))
}

function clusterContainingHandle(clusters: DuplicateCluster[], handle: string) {
  return clusters.find((cl) => cl.contacts.some((c) => c.id === handle))
}

describe("clusterDuplicates — fixture genuine pairs", () => {
  const clusters = clusterDuplicates(fixtureRows())

  it("clusters ALL 12 genuine duplicate pairs as HIGH-confidence", () => {
    for (let g = 1; g <= 12; g++) {
      const a = `ddc-dup-${g}a`
      const b = `ddc-dup-${g}b`
      const cl = clusterContainingHandle(clusters, a)
      expect(cl, `pair g${g} must form a cluster`).toBeDefined()
      // both halves in the SAME cluster
      const ids = cl?.contacts.map((c) => c.id) ?? []
      expect(ids, `pair g${g} both rows clustered`).toContain(a)
      expect(ids, `pair g${g} both rows clustered`).toContain(b)
      // and HIGH-confidence (safe to propose for merge)
      expect(cl?.confidence, `pair g${g} must be high-confidence`).toBe("high")
    }
  })
})

describe("clusterDuplicates — near-duplicate TRAPS are never high-confidence", () => {
  const clusters = clusterDuplicates(fixtureRows())

  it("the Mikkel-vs-Michael same-company trap is needs_confirmation (NOT auto-merged)", () => {
    // ddc-near-2a (Mikkel Holm) / ddc-near-2b (Michael Holm) share surname + company but DIFFERENT
    // given-name root → must be surfaced for confirmation, never high-confidence.
    const cl = clusterContainingHandle(clusters, "ddc-near-2a")
    if (cl) {
      const ids = cl.contacts.map((c) => c.id)
      if (ids.includes("ddc-near-2b")) {
        expect(cl.confidence, "Mikkel/Michael trap must be needs_confirmation").toBe(
          "needs_confirmation",
        )
      }
    }
  })

  it("NO trap row ever lands in a HIGH-confidence cluster", () => {
    const trapHandles = DEDUPE_CONTACTS.filter((c) => c.nearDup).map((c) => c.handle)
    expect(trapHandles.length).toBeGreaterThanOrEqual(6)
    for (const h of trapHandles) {
      const cl = clusterContainingHandle(clusters, h)
      if (cl) {
        expect(cl.confidence, `trap ${h} must never be high-confidence`).toBe("needs_confirmation")
      }
    }
  })

  it("NO trap is ever co-clustered with a genuine duplicate pair in a HIGH-confidence cluster", () => {
    // A NEEDS_CONFIRMATION cluster MAY contain a dup-row alongside a trap (e.g. the namesake 'Sören
    // Bachmann'@Reef surfaced next to the genuine 'Sören Bachmann'@Klangbox) — that is the correct
    // "ask the human" surface. What must NEVER happen is a trap landing in a HIGH (auto-mergeable)
    // cluster with a genuine pair — that would let a weak model irreversibly merge different people.
    const trapHandles = new Set(DEDUPE_CONTACTS.filter((c) => c.nearDup).map((c) => c.handle))
    for (const cl of clusters) {
      if (cl.confidence !== "high") continue
      const hasTrap = cl.contacts.some((c) => trapHandles.has(c.id))
      expect(hasTrap, `HIGH cluster contains a trap: ${cl.signal}`).toBe(false)
    }
  })

  it("no unique distractor ever lands in a HIGH-confidence cluster", () => {
    // A distractor pair that happens to share a normalized name MAY surface as needs_confirmation
    // (two genuinely different people the agent should ask about), but a distractor must NEVER be
    // auto-mergeable (high-confidence).
    for (const cl of clusters) {
      if (cl.confidence !== "high") continue
      for (const c of cl.contacts) {
        expect(c.id.startsWith("ddc-uniq-"), `distractor ${c.id} in a HIGH cluster`).toBe(false)
      }
    }
  })
})

describe("clusterDuplicates — externalId + email signals", () => {
  it("clusters two records sharing a provider customer id even with NO name/email overlap", () => {
    const rows = [
      {
        id: "x1",
        name: "Lukas Berg",
        email: "lukas.berg@example.de",
        company: null,
        externalIds: { shopify: "cust_999" },
      },
      {
        id: "x2",
        name: "L. B.",
        email: "lukas@reverb-handle.example",
        company: null,
        externalIds: { shopify: "cust_999" },
      },
      {
        id: "x3",
        name: "Someone Else",
        email: "else@other.example",
        company: null,
        externalIds: { shopify: "cust_111" },
      },
    ]
    const clusters = clusterDuplicates(rows)
    const cl = clusters.find((c) => c.contacts.some((x) => x.id === "x1"))
    expect(cl).toBeDefined()
    expect(cl?.contacts.map((c) => c.id).sort()).toEqual(["x1", "x2"])
    expect(cl?.confidence).toBe("high")
    expect(cl?.signal).toContain("externalId:shopify")
    // the unrelated different-id record is NOT pulled in
    expect(cl?.contacts.some((c) => c.id === "x3")).toBe(false)
  })

  it("clusters a +tag / gmail-dot email variant as the same normalized address", () => {
    const rows = [
      {
        id: "e1",
        name: "Pat Doe",
        email: "pat.doe+shop@gmail.com",
        company: null,
        externalIds: null,
      },
      {
        id: "e2",
        name: "Patrick Doe",
        email: "patdoe@gmail.com",
        company: null,
        externalIds: null,
      },
    ]
    const clusters = clusterDuplicates(rows)
    const cl = clusters.find((c) => c.contacts.some((x) => x.id === "e1"))
    expect(cl).toBeDefined()
    expect(cl?.contacts.map((c) => c.id).sort()).toEqual(["e1", "e2"])
    expect(cl?.confidence).toBe("high")
  })

  it("does NOT cluster two different people who merely share a surname (no other signal)", () => {
    const rows = [
      {
        id: "s1",
        name: "Marc Lambert",
        email: "marc@a.example",
        company: "Verdant Audio",
        externalIds: null,
      },
      {
        id: "s2",
        name: "Zoe Lambert",
        email: "zoe@b.example",
        company: "Cobalt Studios",
        externalIds: null,
      },
    ]
    const clusters = clusterDuplicates(rows)
    expect(clusters.length).toBe(0)
  })
})

describe("dedup normalization helpers", () => {
  it("normalizeNameForDedup folds accents, hyphens, dots, case", () => {
    expect(normalizeNameForDedup("Zoé Lambert")).toBe("zoe lambert")
    expect(normalizeNameForDedup("Hanna Vogt-Reiner")).toBe("hanna vogt reiner")
    expect(normalizeNameForDedup("Sören Bachmann")).toBe("soren bachmann")
    expect(normalizeNameForDedup("B. Carvalho")).toBe("b carvalho")
  })

  it("normalizeEmailForDedup strips +tag and gmail dots", () => {
    expect(normalizeEmailForDedup("Pat.Doe+shop@Gmail.com")).toBe("patdoe@gmail.com")
    expect(normalizeEmailForDedup("a.b.c@gmail.com")).toBe("abc@gmail.com")
    // non-gmail keeps dots
    expect(normalizeEmailForDedup("a.b@outlook.example")).toBe("a.b@outlook.example")
    expect(normalizeEmailForDedup("not-an-email")).toBe("")
    expect(normalizeEmailForDedup(null)).toBe("")
  })

  it("compareNames: full match for initial/abbrev/typo of same person; surname-only for different root", () => {
    expect(compareNames("Beatriz Carvalho", "B. Carvalho")).toBe("full")
    expect(compareNames("Katarina Sorensen", "Kat Sorensen")).toBe("full")
    expect(compareNames("Wei Zhang", "Wei Zhnag")).toBe("full") // surname typo, same given name
    expect(compareNames("Priscila Tavares", "Priscila Tavares Reis")).toBe("full") // added surname particle
    expect(compareNames("Ravi Krishnan", "Ravi S. Krishnan")).toBe("full") // added middle initial
    expect(compareNames("Mikkel Holm", "Michael Holm")).toBe("surname") // different given root → TRAP
    expect(compareNames("Marc Lambert", "Zoe Lambert")).toBe("surname")
    expect(compareNames("Olivia Andersen", "Liam Bauer")).toBe("none")
  })
})
