// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Find a business buyer's VAT number from its legal name and city, in one call. The business-buyer
// guard (buyer-vat.ts) refuses an intra-EU document with no VAT number when the buyer looks like a
// company; a weak model then has to search the web, read the numbers off the results and check
// each one in VIES. This does the whole chain itself, with hard caps:
//
//   1. a web search through the host's own web_search (kernel:web_search, a declared cross-app
//      call: the org's search key, its spend and the turn's web-read guardrails apply), at most
//      VAT_LOOKUP_MAX_SEARCHES queries;
//   2. VAT numbers of the country's national format read off the result titles and snippets
//      (VAT_FORMATS), prefixed ("IT01234567890") or after a label ("P.IVA 01234567890");
//   3. each candidate checked in VIES (the vat_validate path, short deadline, an outage reads
//      "not verified"), at most VAT_LOOKUP_MAX_VIES calls;
//   4. ranked by how well the VIES name and address match the given legal name, city, postcode and
//      street (address-match.ts). A number VIES says is invalid is dropped. A strong match needs
//      every identifying word of the given name in VIES's name: a company that only shares one
//      word with it ("FABBRO SRL" for the person "Elio Fabbro Rocca") is weak.
//
// Even a strong match only says VIES knows that company: the message tells the agent to use it
// only once a solid link ties the company to THIS customer (the same company name on an earlier
// document or order of the customer, the customer's email domain, the company named in the
// customer's own mail or signature, a VAT number already on file), and to ask the user otherwise.
//
// Read-only. The result carries no page text, only the numbers, what VIES says and the page URL.

import { compatibleNames, nameCovers, viesCheck } from "./buyer-vat"
import { addressMatch, normaliseAddress } from "./address-match"
import type { CrossAppExecuteTool } from "./cross-app"
import type { ReadsFetch } from "./reads"
import { isEuCountry } from "./tax"

export const VAT_LOOKUP_MAX_SEARCHES = 2
export const VAT_LOOKUP_MAX_VIES = 6
/** Results read per search. */
const RESULTS_PER_SEARCH = 8
/** No VIES call starts after this long: the tool answers well inside its own timeout. */
const VIES_BUDGET_MS = 25_000
const MAX_CANDIDATES_RETURNED = 4

export interface VatLookupCtx {
  executeTool?: CrossAppExecuteTool
  fetch?: ReadsFetch
}

export interface VatLookupInput {
  legal_name?: string | null
  country?: string | null
  city?: string | null
  postcode?: string | null
  street?: string | null
}

export interface VatLookupCandidate {
  vat_id: string
  /** true: VIES confirms it; null: VIES could not be reached (NOT verified). */
  vies_valid: true | null
  vies_name: string | null
  vies_address: string | null
  /** strong: VIES's name carries every word of the legal name and its address is in the place given.
   *  Not proof it is THIS customer's company: see the result message. */
  match: "strong" | "weak"
  source_url: string | null
}

export interface VatLookupResult {
  status: "found" | "not_found" | "web_search_unavailable" | "invalid_input"
  candidates: VatLookupCandidate[]
  /** Numbers VIES said are NOT valid (dropped from candidates). */
  rejected: string[]
  searches: string[]
  message: string
}

/**
 * National VAT number formats of the EU member states, as VIES knows them: the prefix and the
 * body after it (compact, no separators). Greece registers as EL.
 */
export const VAT_FORMATS: Readonly<Record<string, { prefix: string; body: string; term: string }>> = {
  AT: { prefix: "AT", body: "U\\d{8}", term: "UID-Nummer" },
  BE: { prefix: "BE", body: "[01]\\d{9}", term: "numéro de TVA BTW" },
  BG: { prefix: "BG", body: "\\d{9,10}", term: "ДДС VAT number" },
  CY: { prefix: "CY", body: "\\d{8}[A-Z]", term: "VAT number" },
  CZ: { prefix: "CZ", body: "\\d{8,10}", term: "DIČ" },
  DE: { prefix: "DE", body: "\\d{9}", term: "USt-IdNr" },
  DK: { prefix: "DK", body: "\\d{8}", term: "CVR moms" },
  EE: { prefix: "EE", body: "\\d{9}", term: "KMKR" },
  EL: { prefix: "EL", body: "\\d{9}", term: "ΑΦΜ VAT" },
  ES: { prefix: "ES", body: "[A-Z0-9]\\d{7}[A-Z0-9]", term: "CIF NIF IVA" },
  FI: { prefix: "FI", body: "\\d{8}", term: "ALV Y-tunnus" },
  FR: { prefix: "FR", body: "[A-HJ-NP-Z0-9]{2}\\d{9}", term: "numéro de TVA intracommunautaire" },
  HR: { prefix: "HR", body: "\\d{11}", term: "OIB PDV" },
  HU: { prefix: "HU", body: "\\d{8}", term: "adószám" },
  IE: { prefix: "IE", body: "\\d{7}[A-W][A-I]?|\\d[A-Z+*]\\d{5}[A-W]", term: "VAT number" },
  IT: { prefix: "IT", body: "\\d{11}", term: "partita IVA" },
  LT: { prefix: "LT", body: "\\d{12}|\\d{9}", term: "PVM kodas" },
  LU: { prefix: "LU", body: "\\d{8}", term: "numéro TVA" },
  LV: { prefix: "LV", body: "\\d{11}", term: "PVN numurs" },
  MT: { prefix: "MT", body: "\\d{8}", term: "VAT number" },
  NL: { prefix: "NL", body: "\\d{9}B\\d{2}", term: "btw-nummer" },
  PL: { prefix: "PL", body: "\\d{10}", term: "NIP" },
  PT: { prefix: "PT", body: "\\d{9}", term: "NIF contribuinte" },
  RO: { prefix: "RO", body: "\\d{2,10}", term: "CUI cod fiscal" },
  SE: { prefix: "SE", body: "\\d{12}", term: "momsregistreringsnummer" },
  SI: { prefix: "SI", body: "\\d{8}", term: "ID za DDV" },
  SK: { prefix: "SK", body: "\\d{10}", term: "IČ DPH" },
}

/** Words that announce a VAT or tax number in a page ("P.IVA 01234567890", "USt-IdNr.: DE…"). */
const LABEL_RE =
  /(p\.?\s?iva|partita\s+iva|c\.?f\.?\s*\/\s*p\.?\s?iva|vat(?:\s+(?:no|number|id|reg(?:istration)?))?|tva(?:\s+intracommunautaire)?|n[°º]\s*tva|ust-?id(?:nr)?|ust\.?-?idnr|mwst|uid(?:-nummer)?|btw(?:-nummer)?|btw-id|iva|cif|nif|nip|dič|ič dph|oib|cvr|kmkr|alv|pvm|pvn|cui|ddv)\b\.?\s*[:#-]?\s*/gi

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null
}

/** A body pattern that tolerates one space, dot or dash between its characters ("DE 123 456 789"). */
function spacedBody(body: string): string {
  // Insert an optional separator after every single-character token of the pattern.
  return body.replace(/(\\d|\[[^\]]+\]|[A-Z])(\{\d+(?:,\d+)?\}|\?)?/g, (_m, tok: string, q: string | undefined) => {
    if (!q) return `${tok}[ .-]?`
    if (q === "?") return `(?:${tok}[ .-]?)?`
    return `(?:${tok}[ .-]?)${q}`
  })
}

/** The VIES country prefix for a country code (GR registers as EL). */
export function vatPrefixOf(country: string): string {
  const cc = country.trim().toUpperCase()
  return cc === "GR" ? "EL" : cc
}

/**
 * VAT numbers of `country`'s format in `text`, canonical (prefix + compact body), in the order
 * they appear: a number with its country prefix anywhere, a bare number only right after a VAT
 * label. Never a fragment of a longer run of digits.
 */
export function extractVatCandidates(text: string, country: string): string[] {
  const prefix = vatPrefixOf(country)
  const fmt = VAT_FORMATS[prefix]
  if (!fmt || !text) return []
  const upper = text.toUpperCase()
  const body = spacedBody(fmt.body)
  const found: Array<{ at: number; vat: string }> = []
  const add = (at: number, raw: string) => {
    const compact = raw.replace(/[ .-]/g, "")
    // The pattern lets a trailing separator in: the compact body must still be the exact format.
    if (!new RegExp(`^(?:${fmt.body})$`).test(compact)) return
    const vat = `${prefix}${compact}`
    if (!found.some((f) => f.vat === vat)) found.push({ at, vat })
  }
  // Prefixed: "IT01234567890", "IT 012 345 678 90", "NL123456789B01".
  const prefixed = new RegExp(`(?<![A-Z0-9])${prefix}[ .-]?((?:${body}))(?![0-9])`, "g")
  for (const m of upper.matchAll(prefixed)) add(m.index ?? 0, m[1] ?? "")
  // Bare, right after a label: "P.IVA 01234567890", "Partita IVA: 01234567890".
  const bare = new RegExp(`^(?:${prefix}[ .-]?)?((?:${body}))(?![0-9])`)
  for (const m of upper.matchAll(LABEL_RE)) {
    const at = (m.index ?? 0) + m[0].length
    const hit = bare.exec(upper.slice(at, at + 40))
    if (hit && !/[A-Z0-9]/.test(upper.slice(at - m[0].length - 1, at - m[0].length))) add(at, hit[1] ?? "")
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.vat)
}

interface SearchHit {
  title: string
  url: string
  snippet: string
}

type SearchOutcome = { ok: true; hits: SearchHit[] } | { ok: false; reason: string }

/** One web search through the host's web_search. */
async function webSearch(ctx: VatLookupCtx, query: string): Promise<SearchOutcome> {
  if (!ctx.executeTool) return { ok: false, reason: "this app cannot reach the host's web search here" }
  let env: Awaited<ReturnType<CrossAppExecuteTool>>
  try {
    env = await ctx.executeTool("kernel:web_search", { query, numResults: RESULTS_PER_SEARCH })
  } catch (err) {
    return { ok: false, reason: `web search failed (${String(err)})` }
  }
  if (env.status === "error") {
    const code = env.error?.code ?? "error"
    const reason =
      code === "tool_not_found" || code === "not_found" || code === "unknown_tool"
        ? "web search is not set up for this organization (no search provider key)"
        : (env.error?.message ?? code)
    return { ok: false, reason }
  }
  if (env.status !== "completed") return { ok: false, reason: "web search is waiting for an approval" }
  const r = (env.result ?? {}) as { results?: unknown; error?: unknown }
  if (typeof r.error === "string") return { ok: false, reason: r.error }
  const list = Array.isArray(r.results) ? r.results : []
  const hits: SearchHit[] = []
  for (const x of list.slice(0, RESULTS_PER_SEARCH)) {
    const o = (x ?? {}) as Record<string, unknown>
    hits.push({
      title: typeof o.title === "string" ? o.title : "",
      url: typeof o.url === "string" ? o.url : "",
      snippet: typeof o.snippet === "string" ? o.snippet.slice(0, 4000) : "",
    })
  }
  return { ok: true, hits }
}

/** How well VIES's name and address match what the caller gave: a score and strong/weak. */
function rank(
  input: { legal_name: string; city: string | null; postcode: string | null; street: string | null },
  viesName: string | null,
  viesAddress: string | null,
): { score: number; match: "strong" | "weak" } {
  // The whole given name, not one shared word: a person's surname matching a company is not a match.
  const nameOk = nameCovers(input.legal_name, viesName)
  const nameNear = !nameOk && compatibleNames(input.legal_name, viesName)
  const addr = ` ${normaliseAddress(viesAddress)} `
  const cityOk = !!input.city && addr.includes(` ${normaliseAddress(input.city)} `)
  const postcodeOk = !!input.postcode && addr.includes(` ${normaliseAddress(input.postcode)} `)
  const given = [input.street, input.postcode, input.city].filter((s): s is string => !!s).join(", ")
  const streetHow = input.street ? addressMatch(given, viesAddress) : null
  const placeGiven = !!(input.city || input.postcode || input.street)
  const placeOk = cityOk || postcodeOk || streetHow !== null
  const score = (nameOk ? 4 : nameNear ? 1 : 0) + (streetHow === "full" ? 3 : streetHow === "street" ? 2 : 0) + (postcodeOk ? 1 : 0) + (cityOk ? 1 : 0)
  return { score, match: nameOk && (placeOk || !placeGiven) ? "strong" : "weak" }
}

/**
 * Look up a business's VAT number: web search, national-format extraction, VIES, ranking. See the
 * file header. Never throws.
 */
export async function vatLookup(ctx: VatLookupCtx, raw: VatLookupInput): Promise<VatLookupResult> {
  const legalName = str(raw?.legal_name)
  const country = (str(raw?.country) ?? "").toUpperCase()
  const city = str(raw?.city)
  const postcode = str(raw?.postcode)
  const street = str(raw?.street)
  const empty = { candidates: [], rejected: [], searches: [] }
  if (!legalName) {
    return { status: "invalid_input", ...empty, message: "Pass the company's legal_name (e.g. the name on its earlier invoice)." }
  }
  const prefix = vatPrefixOf(country)
  const fmt = VAT_FORMATS[prefix]
  if (!fmt || !(isEuCountry(country) || country === "EL")) {
    return {
      status: "invalid_input",
      ...empty,
      message: `country must be the 2-letter code of an EU member state (VIES covers EU VAT numbers only); got "${country || "nothing"}".`,
    }
  }

  // Up to two queries: the name, city and the country's own word for the VAT number, then the
  // name with "VAT" and the prefix, only when the first finds nothing VIES confirms.
  const queries = [
    [legalName, city, fmt.term].filter(Boolean).join(" "),
    [legalName, city ?? postcode, "VAT", prefix].filter(Boolean).join(" "),
  ].slice(0, VAT_LOOKUP_MAX_SEARCHES)
  const searches: string[] = []
  const tried = new Map<string, { vat: string; url: string | null }>()
  const candidates: Array<VatLookupCandidate & { score: number }> = []
  const rejected: string[] = []
  let viesCalls = 0
  const started = Date.now()

  for (const query of queries) {
    if (candidates.some((c) => c.vies_valid === true && c.match === "strong")) break
    const s = await webSearch(ctx, query)
    searches.push(query)
    if (!s.ok) {
      if (searches.length === 1) {
        return {
          status: "web_search_unavailable",
          candidates: [],
          rejected: [],
          searches,
          message: `Web search is not available: ${s.reason}. Nothing was looked up. Ask the user for the buyer's VAT number, or check one you have with invoicing__vat_validate.`,
        }
      }
      break
    }
    // Numbers in result order: a page's title and snippet, the first page first.
    const fresh: Array<{ vat: string; url: string | null }> = []
    for (const h of s.hits) {
      for (const vat of extractVatCandidates(`${h.title}\n${h.snippet}`, prefix)) {
        if (!tried.has(vat) && !fresh.some((f) => f.vat === vat)) fresh.push({ vat, url: h.url || null })
      }
    }
    for (const f of fresh) {
      if (viesCalls >= VAT_LOOKUP_MAX_VIES || Date.now() - started > VIES_BUDGET_MS) break
      tried.set(f.vat, f)
      viesCalls++
      const v = await viesCheck(ctx, f.vat, prefix)
      if (v.status === "invalid") {
        rejected.push(f.vat)
        continue
      }
      const r = rank({ legal_name: legalName, city, postcode, street }, v.name, v.address)
      candidates.push({
        vat_id: f.vat,
        vies_valid: v.status === "valid" ? true : null,
        vies_name: v.name,
        vies_address: v.address,
        // An unverified number is never a strong match.
        match: v.status === "valid" ? r.match : "weak",
        source_url: f.url,
        score: r.score + (v.status === "valid" ? 10 : 0),
      })
    }
  }

  const ranked = candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES_RETURNED)
    .map(({ score: _score, ...c }) => c)
  const best = ranked[0]
  if (!best) {
    return {
      status: "not_found",
      candidates: [],
      rejected,
      searches,
      message:
        `No ${prefix} VAT number that VIES confirms was found for "${legalName}"${city ? ` in ${city}` : ""}` +
        (rejected.length > 0 ? ` (VIES rejected ${rejected.join(", ")})` : "") +
        ". Do not guess one: tell the user the VAT number is missing and ask for it.",
    }
  }
  const message =
    best.match === "strong"
      ? `VIES confirms ${best.vat_id} for "${best.vies_name ?? legalName}"${best.vies_address ? `, ${best.vies_address}` : ""}. ` +
        `That only says VIES knows this company, not that it is THIS customer. Use it ONLY once at least one solid link ties this company to the customer: ` +
        `the same company name on an earlier document or order of this customer, the customer's email domain matching the company, ` +
        `the company named in the customer's own mail or signature, or a VAT number already on file for the customer. ` +
        `A name that only shares a word with the customer's (a person "Elio Fabbro Rocca" and a company "FABBRO SRL") is NOT a link. ` +
        `With that link: use it as counterparty.vat_id, with the VIES name as counterparty.legal_name, and call the refused tool again. ` +
        `Without one: ask the user for the VAT number; never guess.`
      : `Found ${ranked.map((c) => c.vat_id).join(", ")}, but none is a sure match (${
          best.vies_valid === null ? "VIES could not be reached" : "VIES's name or address differs from the buyer's"
        }). Show the user the candidates with their VIES name and address and ask which one is the buyer's; never pick one yourself.`
  return { status: "found", candidates: ranked, rejected, searches, message }
}
