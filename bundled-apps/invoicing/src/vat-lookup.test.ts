// SPDX-License-Identifier: FSL-1.1-ALv2
//
// vat_lookup: a business buyer's VAT number from its legal name and city, through the host's web
// search and VIES, so a weak model refused with buyer_vat_id_required needs one call, not a chain.
// Every name, address, URL and number here is invented; the web search and VIES are stubs.

import { describe, expect, test } from "bun:test"
import manifest from "../app.manifest.json"
import { vatLookupCall } from "./buyer-vat"
import type { CrossAppEnvelope } from "./cross-app"
import type { ReadsFetch } from "./reads"
import { extractVatCandidates, VAT_LOOKUP_MAX_SEARCHES, VAT_LOOKUP_MAX_VIES, vatLookup } from "./vat-lookup"

type Hit = { title: string; url: string; snippet: string }
type Vies = Record<string, { valid: boolean; name?: string; address?: string } | "down">

function stubs(hitsPerQuery: Hit[][] | "unavailable" | { error: string }, vies: Vies) {
  const searches: string[] = []
  const viesCalls: string[] = []
  let q = 0
  const executeTool = async (target: string, args: Record<string, unknown>): Promise<CrossAppEnvelope> => {
    if (target !== "kernel:web_search") throw new Error(`unexpected cross-app call ${target}`)
    searches.push(String(args.query))
    if (hitsPerQuery === "unavailable") {
      return { status: "error", error: { code: "tool_not_found", message: "Tool kernel:web_search not found", retryable: false } }
    }
    if (!Array.isArray(hitsPerQuery)) return { status: "completed", result: hitsPerQuery }
    const hits = hitsPerQuery[q++] ?? []
    return {
      status: "completed",
      result: { results: hits.map((h) => ({ ...h, snippet: `<external-content source="untrusted">\n${h.snippet}\n</external-content>`, score: 0.5 })), backend: "exa" },
    }
  }
  const fetch: ReadsFetch = async (url) => {
    const m = /\/ms\/([A-Z]{2})\/vat\/([A-Z0-9]+)$/.exec(url)
    const key = m ? `${m[1]}${m[2]}` : url
    viesCalls.push(key)
    const r = vies[key]
    if (r === "down") return { status: 200, headers: {}, body: JSON.stringify({ isValid: false, userError: "MS_UNAVAILABLE" }) }
    return {
      status: 200,
      headers: {},
      body: JSON.stringify(
        r?.valid
          ? { isValid: true, userError: "VALID", name: r.name ?? "---", address: r.address ?? "---" }
          : { isValid: false, userError: "INVALID" },
      ),
    }
  }
  return { ctx: { executeTool: executeTool as never, fetch }, searches, viesCalls }
}

const NAME = "Lanterna Viola SAS"

describe("vat_lookup", () => {
  test("a P.IVA in a snippet, VIES-valid with a matching name and address, is a strong candidate", async () => {
    const s = stubs(
      [
        [
          {
            title: "LANTERNA VIOLA S.A.S. - Torino - registro imprese",
            url: "https://registry.example/lanterna-viola",
            snippet: "Lanterna Viola S.A.S. di Esempio Marco, Via Esempio Nuova 8, 10100 Torino (TO). P.IVA 01234567890 - REA TO-0000000",
          },
        ],
      ],
      { IT01234567890: { valid: true, name: "LANTERNA VIOLA S.A.S. DI ESEMPIO MARCO", address: "VIA ESEMPIO NUOVA 8 10100 TORINO TO" } },
    )
    const r = await vatLookup(s.ctx, { legal_name: NAME, country: "IT", city: "Torino", postcode: "10100" })
    expect(r.status).toBe("found")
    expect(r.candidates[0]).toEqual({
      vat_id: "IT01234567890",
      vies_valid: true,
      vies_name: "LANTERNA VIOLA S.A.S. DI ESEMPIO MARCO",
      vies_address: "VIA ESEMPIO NUOVA 8 10100 TORINO TO",
      match: "strong",
      source_url: "https://registry.example/lanterna-viola",
    })
    expect(r.message).toContain("counterparty.vat_id")
    // Even a strong match is used only once a solid link ties that company to THIS customer.
    expect(r.message).toContain("Use it ONLY once")
    expect(r.message).toContain("earlier document or order of this customer")
    expect(r.message).toContain("email domain")
    expect(r.message).toContain("mail or signature")
    expect(r.message).toContain("VAT number already on file")
    expect(r.message).toContain("ask the user for the VAT number")
    expect(r.message).not.toMatch(/^VIES confirms [^.]*\. Use it as counterparty\.vat_id/)
    // One search was enough: the second runs only when the first finds no strong candidate.
    expect(s.searches).toHaveLength(1)
    expect(s.searches[0]).toContain(NAME)
    expect(s.searches[0]).toContain("Torino")
    expect(s.searches[0]).toContain("partita IVA")
    expect(s.viesCalls).toEqual(["IT01234567890"])
  })

  test("several numbers: the VIES-invalid one is dropped, the rest ranked by name and address", async () => {
    const s = stubs(
      [
        [
          {
            title: "Lanterna Viola SAS company profile",
            url: "https://directory.example/a",
            snippet: "Partita IVA: 09876543210. A different firm, Studio Esempio SRL, P.IVA 05555555555, Milano.",
          },
          { title: "Lanterna Viola Torino", url: "https://directory.example/b", snippet: "VAT IT01234567890 · Via Esempio Nuova 8" },
        ],
      ],
      {
        IT09876543210: { valid: false },
        IT05555555555: { valid: true, name: "STUDIO ESEMPIO SRL", address: "VIA ALTRA 1 20100 MILANO MI" },
        IT01234567890: { valid: true, name: "LANTERNA VIOLA SAS", address: "VIA ESEMPIO NUOVA 8 10100 TORINO TO" },
      },
    )
    const r = await vatLookup(s.ctx, { legal_name: NAME, country: "IT", city: "Torino", street: "Via Esempio Nuova 8" })
    expect(r.status).toBe("found")
    expect(r.rejected).toEqual(["IT09876543210"])
    expect(r.candidates.map((c) => [c.vat_id, c.match])).toEqual([
      ["IT01234567890", "strong"],
      ["IT05555555555", "weak"],
    ])
    expect(r.candidates[0]?.source_url).toBe("https://directory.example/b")
  })

  test("only weak candidates: no sure match, a second search is tried, the agent asks the user", async () => {
    const s = stubs(
      [
        [{ title: "Esempio", url: "https://x.example/1", snippet: "P.IVA 05555555555" }],
        [{ title: "Esempio 2", url: "https://x.example/2", snippet: "nothing here" }],
      ],
      { IT05555555555: { valid: true, name: "STUDIO ESEMPIO SRL", address: "VIA ALTRA 1 20100 MILANO MI" } },
    )
    const r = await vatLookup(s.ctx, { legal_name: NAME, country: "IT", city: "Torino" })
    expect(r.status).toBe("found")
    expect(r.candidates[0]?.match).toBe("weak")
    expect(r.message).toContain("ask")
    expect(s.searches).toHaveLength(2)
  })

  test("a company named like a FRAGMENT of a person's name is never strong", async () => {
    // The buyer is a person ("Elio Fabbro Rocca"); VIES holds a company that shares one word of it.
    const s = stubs(
      [
        [{ title: "Fabbro S.r.l. Torino", url: "https://registry.example/fabbro", snippet: "FABBRO S.R.L. P.IVA 07777777770" }],
        [],
      ],
      { IT07777777770: { valid: true, name: "FABBRO S.R.L.", address: "CORSO ESEMPIO ALTRO 90 \n10121 TORINO TO" } },
    )
    const r = await vatLookup(s.ctx, { legal_name: "Fabbro Rocca", street: "Via Esempio Nuova 8", postcode: "10124", city: "Torino", country: "IT" })
    expect(r.candidates[0]).toMatchObject({ vat_id: "IT07777777770", vies_name: "FABBRO S.R.L.", match: "weak" })
    expect(r.message).not.toContain("call the refused tool again")
    expect(r.message).toContain("ask")
  })

  test("the VIES name must carry every identifying word of the name given", async () => {
    const vies = { IT01234567890: { valid: true, name: "LANTERNA SRL", address: "VIA ESEMPIO NUOVA 8 10100 TORINO TO" } }
    const hit = [[{ title: "Lanterna", url: "https://x.example/1", snippet: "P.IVA 01234567890" }], []]
    const r = await vatLookup(stubs(hit, vies).ctx, { legal_name: NAME, country: "IT", city: "Torino" })
    expect(r.candidates[0]?.match).toBe("weak")
  })

  test("web search unavailable: says so plainly and looks nothing up", async () => {
    const s = stubs("unavailable", {})
    const r = await vatLookup(s.ctx, { legal_name: NAME, country: "IT", city: "Torino" })
    expect(r.status).toBe("web_search_unavailable")
    expect(r.message).toMatch(/^Web search is not available: web search is not set up for this organization/)
    expect(r.candidates).toEqual([])
    expect(s.viesCalls).toEqual([])
  })

  test("a web search refused by the host (its error result) is reported, not hidden", async () => {
    const s = stubs({ error: "Web search failed: provider down" }, {})
    const r = await vatLookup(s.ctx, { legal_name: NAME, country: "IT" })
    expect(r.status).toBe("web_search_unavailable")
    expect(r.message).toContain("provider down")
  })

  test("no executeTool at all: unavailable", async () => {
    const r = await vatLookup({}, { legal_name: NAME, country: "IT" })
    expect(r.status).toBe("web_search_unavailable")
  })

  test("VIES down: the number is returned NOT verified and never strong", async () => {
    const s = stubs([[{ title: NAME, url: "https://x.example/1", snippet: "P.IVA 01234567890" }], []], { IT01234567890: "down" })
    const r = await vatLookup(s.ctx, { legal_name: NAME, country: "IT", city: "Torino" })
    expect(r.candidates[0]).toMatchObject({ vat_id: "IT01234567890", vies_valid: null, match: "weak" })
    expect(r.message).toContain("VIES could not be reached")
  })

  test("caps: at most 2 searches and 6 VIES calls", async () => {
    const many = Array.from({ length: 10 }, (_, i) => `P.IVA 0123456780${i}`).join(" · ")
    const s = stubs([[{ title: "x", url: "https://x.example", snippet: many }], [{ title: "y", url: "https://y.example", snippet: "P.IVA 09999999999" }], []], {})
    const r = await vatLookup(s.ctx, { legal_name: NAME, country: "IT" })
    expect(s.searches.length).toBeLessThanOrEqual(VAT_LOOKUP_MAX_SEARCHES)
    expect(s.viesCalls.length).toBeLessThanOrEqual(VAT_LOOKUP_MAX_VIES)
    expect(r.status).toBe("not_found")
    expect(r.message).toContain("Do not guess")
  })

  test("bad input: no name, or a country outside the EU", async () => {
    expect((await vatLookup({}, { legal_name: "", country: "IT" })).status).toBe("invalid_input")
    expect((await vatLookup({}, { legal_name: NAME, country: "US" })).status).toBe("invalid_input")
  })
})

describe("extractVatCandidates: national formats", () => {
  test("IT: prefixed anywhere, bare after a label, never a slice of a longer digit run", () => {
    expect(extractVatCandidates("P.IVA 01234567890", "IT")).toEqual(["IT01234567890"])
    expect(extractVatCandidates("Partita IVA: 01234567890", "IT")).toEqual(["IT01234567890"])
    expect(extractVatCandidates("C.F./P.IVA 01234567890", "IT")).toEqual(["IT01234567890"])
    expect(extractVatCandidates("VAT IT 01234567890 10100 Torino", "IT")).toEqual(["IT01234567890"])
    expect(extractVatCandidates("tel 01234567890", "IT")).toEqual([])
    expect(extractVatCandidates("P.IVA 012345678901234", "IT")).toEqual([])
  })
  test("FR, DE, ES, NL, BE, AT, GR", () => {
    expect(extractVatCandidates("N° TVA : FR 12 345678901", "FR")).toEqual(["FR12345678901"])
    expect(extractVatCandidates("USt-IdNr.: DE 123 456 789", "DE")).toEqual(["DE123456789"])
    expect(extractVatCandidates("CIF: B12345678", "ES")).toEqual(["ESB12345678"])
    expect(extractVatCandidates("btw-nummer NL123456789B01", "NL")).toEqual(["NL123456789B01"])
    expect(extractVatCandidates("TVA BE 0123.456.789", "BE")).toEqual(["BE0123456789"])
    expect(extractVatCandidates("UID-Nummer ATU12345678", "AT")).toEqual(["ATU12345678"])
    expect(extractVatCandidates("VAT EL123456789", "GR")).toEqual(["EL123456789"])
  })
})

describe("buyer_vat_id_required names the exact vat_lookup call", () => {
  test("legal name, country, city and postcode derived from what the guard knows", () => {
    const c = vatLookupCall("Bottega Notturna SAS", "IT", "Via Esempio Nuova, 8\n10100 Torino\nItaly")
    expect(c.text).toBe(
      "call invoicing__vat_lookup with legal_name 'Bottega Notturna SAS', country 'IT', city 'Torino', postcode '10100'",
    )
    expect(c.params).toEqual({ legal_name: "Bottega Notturna SAS", country: "IT", city: "Torino", postcode: "10100" })
  })
})

describe("manifest", () => {
  const m = manifest as unknown as {
    tools: Record<string, { description: string; handler: string; readOnly?: boolean; timeoutMs?: number }>
    cross_app_calls: Array<{ target: string }>
  }
  test("vat_lookup is a short, read-only tool that may call the host's web search", () => {
    const t = m.tools.vat_lookup
    expect(t?.handler).toBe("vatLookupHandler")
    expect(t?.readOnly).toBe(true)
    expect(t?.description).toBe(
      "Find a business buyer's VAT number from its legal name and city (web + VIES). Use after buyer_vat_id_required. Use a number it finds only with a solid link to THIS customer (same company on an earlier document or order, email domain, the customer's mail or signature); a shared word with a person's name is not one. Else ask the user.",
    )
    expect(m.cross_app_calls.map((c) => c.target)).toContain("kernel:web_search")
  })

  test("the guide requires a solid link between a found company and THIS customer, with the bad example", () => {
    const sections = (manifest as unknown as { agentInstructions: { sections: Array<{ tools: string[]; text: string }> } }).agentInstructions
      .sections
    const guide = sections.find((x) => x.tools.length === 1 && x.tools[0] === "vat_lookup")?.text ?? ""
    expect(guide).toContain("at least ONE solid link")
    expect(guide).toContain("earlier document or order of this customer")
    expect(guide).toContain("email domain")
    expect(guide).toContain("mail or signature")
    expect(guide).toContain("VAT number already on file")
    expect(guide).toContain("NOT a link")
    expect(guide).toContain("FABBRO SRL")
    expect(guide).toContain("ask the user for the VAT number and never guess")
  })
})
