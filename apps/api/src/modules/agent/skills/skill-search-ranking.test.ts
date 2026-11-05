// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  contentTokens,
  findDuplicateSkills,
  MIN_STEM_PREFIX,
  rankSkills,
  type SearchCandidate,
  tokenMatches,
} from "~/modules/agent/skills/skill-search-ranking"

// The REAL prod catalog entries involved in the 2026-08-04 field failure. The
// org playbook is English-authored but declares a multilingual trigger list;
// the app blurb carries nothing but its brand name. Verbatim from prod
// (kernel.skills f2baa5c8 + the boxtal app skill registry).
const PREPARE_SHIPMENT: SearchCandidate = {
  name: "prepare-shipment",
  description: "Prepare the shipment for a customer order and buy the carrier label",
  keywords: [
    "shipment",
    "expedition",
    "expedie",
    "expedier",
    "envoi",
    "colis",
    "create shipment",
    "ship the order",
    "carrier label",
  ],
  apps: ["boxtal", "invoicing", "shopify"],
  appName: null,
  source: "org",
}
const BOXTAL_OVERVIEW: SearchCandidate = {
  name: "boxtal-overview",
  description: "How to use the Boxtal shipping app with Liaison",
  keywords: null,
  apps: null,
  appName: "boxtal",
  source: "app",
}
const ORDERS_SHIPPING: SearchCandidate = {
  name: "tessera-orders-shipping",
  description:
    "Playbook: order status, shipping, tracking, customs, restock and availability tickets",
  keywords: null,
  apps: null,
  appName: null,
  source: "org",
}
const WARRANTY_RETURN: SearchCandidate = {
  name: "warranty-return-label",
  description:
    "Stage a prepaid return label (RMA/warranty): reverse quote, customs proforma, gated purchase",
  keywords: null,
  apps: null,
  appName: "boxtal",
  source: "app",
}
const LICENSE: SearchCandidate = {
  name: "tessera-license-activation",
  description:
    "Playbook: TesseraSound and Tessera Lab license, activation, sign-in and machine-limit tickets",
  keywords: null,
  apps: null,
  appName: null,
  source: "org",
}

const CATALOG = [PREPARE_SHIPMENT, BOXTAL_OVERVIEW, ORDERS_SHIPPING, WARRANTY_RETURN, LICENSE]

const names = (query: string) => rankSkills(CATALOG, query).map((r) => r.candidate.name)

describe("rankSkills — the field regression", () => {
  // THE BUG. Quinn's MCP session (transcript b9c6b49f, step 15) searched in
  // French and got back exactly ONE hit: boxtal-overview, the generic app blurb
  // that matched only on the brand name. prepare-shipment scored 0 and was
  // filtered out, so the agent staged five shipments without the playbook.
  const FRENCH_QUERY = "préparer commandes expédition boxtal impression étiquette"

  it("surfaces the org playbook for the exact French query that missed it in prod", () => {
    const hits = names(FRENCH_QUERY)
    expect(hits).toContain("prepare-shipment")
  })

  it("RANKS the org playbook above the generic app blurb for that query", () => {
    // Not merely present: first. A weak model takes the top hit and moves on,
    // which is precisely how boxtal-overview got read instead of the playbook.
    expect(names(FRENCH_QUERY)[0]).toBe("prepare-shipment")
  })

  it("still ranks the playbook first for the English query that worked by luck", () => {
    // The English phrasing already worked pre-fix; it must not regress.
    expect(names("outbound shipment prepare order pack print label invoice")[0]).toBe(
      "prepare-shipment",
    )
  })
})

describe("rankSkills — accent folding", () => {
  it("matches an accented query token against an unaccented declared keyword", () => {
    // "expédition" -> "expedition", which prepare-shipment declares verbatim.
    expect(names("expédition")).toContain("prepare-shipment")
  })

  it("matches an unaccented query against accented text symmetrically", () => {
    const accented: SearchCandidate = {
      name: "facturation-étrangère",
      description: "Émettre une facture à l'étranger",
      keywords: null,
      apps: null,
      appName: null,
      source: "org",
    }
    expect(rankSkills([accented], "facturation etrangere").map((r) => r.candidate.name)).toEqual([
      "facturation-étrangère",
    ])
  })
})

describe("rankSkills — morphology", () => {
  it("matches a French infinitive against the English stem (préparer -> prepare)", () => {
    // Pure label match, no keyword help: this is the morphology gate alone.
    expect(names("préparer")).toContain("prepare-shipment")
  })

  it("matches a plural query token against a singular skill token", () => {
    expect(names("shipments")).toContain("prepare-shipment")
  })

  it("does NOT match on a short coincidental prefix", () => {
    // "activation" and "availability" share only "a"; "license"/"licencier"
    // would share 6 and SHOULD match, but unrelated words must not.
    expect(names("presse")).not.toContain("prepare-shipment")
  })
})

describe("tokenMatches", () => {
  it("accepts identical tokens", () => {
    expect(tokenMatches("colis", "colis")).toBe(true)
  })

  it("accepts strict prefix containment past the stem threshold", () => {
    expect(tokenMatches("preparer", "prepare")).toBe(true)
    expect(tokenMatches("commandes", "commande")).toBe(true)
  })

  it("rejects a shared prefix shorter than the stem threshold", () => {
    expect(MIN_STEM_PREFIX).toBe(4)
    expect(tokenMatches("pre", "prepare")).toBe(false)
    expect(tokenMatches("cola", "colis")).toBe(false)
  })

  it("rejects a partial overlap that is not strict containment", () => {
    // Shares "expedi" (6 >= 4) but neither token is a prefix of the other, so
    // an edit-distance matcher would accept this and we must not.
    expect(tokenMatches("expedition", "expedie")).toBe(false)
  })
})

describe("rankSkills — weighting", () => {
  it("weights a declared trigger keyword above an incidental description word", () => {
    const declared: SearchCandidate = {
      name: "alpha",
      description: "unrelated prose",
      keywords: ["colis"],
      apps: null,
      appName: null,
      source: "org",
    }
    const incidental: SearchCandidate = {
      name: "beta",
      description: "mentions colis once in passing",
      keywords: null,
      apps: null,
      appName: null,
      source: "org",
    }
    expect(rankSkills([incidental, declared], "colis").map((r) => r.candidate.name)).toEqual([
      "alpha",
      "beta",
    ])
  })

  it("matches an app anchor so an app-named query finds the org playbook", () => {
    // "boxtal" alone must reach prepare-shipment via auto_attach.apps, not just
    // the app's own overview skill.
    expect(names("boxtal")).toContain("prepare-shipment")
  })

  it("rewards a declared multi-word keyword appearing verbatim in the query", () => {
    expect(names("create shipment for order 3310")[0]).toBe("prepare-shipment")
  })
})

describe("rankSkills — output discipline", () => {
  it("returns nothing for an empty or punctuation-only query", () => {
    expect(rankSkills(CATALOG, "")).toEqual([])
    expect(rankSkills(CATALOG, "   ...  ")).toEqual([])
  })

  it("excludes zero-scoring candidates rather than padding the list", () => {
    const hits = names("expédition")
    expect(hits).not.toContain("tessera-license-activation")
  })

  it("orders by descending score", () => {
    const ranked = rankSkills(CATALOG, "shipment expedition colis")
    const scores = ranked.map((r) => r.score)
    expect(scores).toEqual([...scores].sort((a, b) => b - a))
  })

  it("is deterministic across repeated calls", () => {
    expect(names("expédition colis")).toEqual(names("expédition colis"))
  })
})

describe("findDuplicateSkills", () => {
  const dupeNames = (name: string, description: string) =>
    findDuplicateSkills({ name, description }, CATALOG).map((d) => d.name)

  it("flags a near-restatement of an existing playbook", () => {
    // What a fresh session proposes when search told it nothing existed.
    expect(
      dupeNames(
        "shipment-preparation",
        "Prepare the shipment for a customer order and buy the carrier label",
      ),
    ).toContain("prepare-shipment")
  })

  it("flags a reworded duplicate, not just a verbatim one", () => {
    expect(
      dupeNames("carrier-label-prep", "Prepare a customer order shipment, buy carrier label"),
    ).toContain("prepare-shipment")
  })

  it("does NOT flag a genuinely distinct skill", () => {
    // Packing dimensions is reference data about cartons and weights — it shares
    // a domain with shipping but not a task, and must stay authorable.
    expect(
      dupeNames("packing-dimensions", "Carton sizes and gross weights per product combo"),
    ).toEqual([])
  })

  it("does not flag across unrelated domains", () => {
    expect(dupeNames("vat-validation", "Check a customer VAT number before invoicing")).toEqual([])
  })

  it("ignores stopword overlap so any two skills do not look alike", () => {
    // "for the and with a" carries no signal; without stopword filtering this
    // would cover a large fraction of every candidate's tokens.
    expect(dupeNames("xyzzy", "for the and with a")).toEqual([])
  })

  it("needs more than a couple of matching words to fire", () => {
    // Two content words in common is coincidence, not duplication.
    expect(dupeNames("order-notes", "customer order")).toEqual([])
  })

  it("orders the strongest overlap first", () => {
    const hits = findDuplicateSkills(
      {
        name: "prepare-shipment-v2",
        description: "Prepare the shipment for a customer order and buy the carrier label",
      },
      CATALOG,
    )
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].name).toBe("prepare-shipment")
    expect(hits[0].coverage).toBeGreaterThanOrEqual(hits[hits.length - 1].coverage)
  })

  it("returns nothing against an empty catalog", () => {
    expect(findDuplicateSkills({ name: "a", description: "b" }, [])).toEqual([])
  })
})

describe("contentTokens", () => {
  it("drops stopwords and short tokens", () => {
    const t = contentTokens("Prepare the shipment for a customer order")
    expect(t.has("the")).toBe(false)
    expect(t.has("for")).toBe(false)
    expect(t.has("shipment")).toBe(true)
    expect(t.has("customer")).toBe(true)
  })

  it("folds accents so French content compares against English", () => {
    expect(contentTokens("expédition").has("expedition")).toBe(true)
  })
})
