// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The business registry client against the recorded, anonymised registry answers: mapping,
// zero results, the 429 without Retry-After (one retry), an outage, and never picking among
// several candidates.
import { describe, expect, test } from "bun:test"
import { candidateMatchesName, registrySearch } from "./lookup"
import {
  REGISTRY_RATE_LIMITED,
  REGISTRY_SEARCH_EMPTY,
  REGISTRY_SEARCH_HIT,
  registryResponse,
  registryResultWith,
} from "./lookup.fixtures"
import { FICTIONAL_SIRENS } from "./test-fixtures"

type Answer = { status: number; headers: Record<string, string>; body: string } | Error

function fakeFetch(answers: Answer[]) {
  const calls: Array<{ url: string; headers?: Record<string, string> }> = []
  const fetch = async (url: string, opts?: { headers?: Record<string, string> }) => {
    calls.push({ url, headers: opts?.headers })
    const next = answers.shift()
    if (!next) throw new Error("no more answers")
    if (next instanceof Error) throw next
    return next
  }
  return { fetch, calls }
}

const ok = (body: unknown) => ({ status: 200, headers: {}, body: JSON.stringify(body) })

describe("registrySearch", () => {
  test("maps the recorded hit to a candidate", async () => {
    const { fetch, calls } = fakeFetch([ok(REGISTRY_SEARCH_HIT)])
    const r = await registrySearch({ fetch }, { q: "exemple menuiserie", postcode: "75002" })
    expect(r.status).toBe("ok")
    if (r.status !== "ok") return
    expect(r.candidates).toHaveLength(1)
    const c = r.candidates[0]!
    expect(c).toMatchObject({
      siren: "902000009",
      siret: "90200000900032",
      name: "EXEMPLE MENUISERIE ATELIER (E.M.A)",
      legal_name: "EXEMPLE MENUISERIE ATELIER",
      sigle: "E.M.A",
      status: "A",
      nature_juridique: "5499",
      line1: "1 RUE DE L'EXEMPLE",
      postcode: "75002",
      city: "PARIS",
      country_code: "FR",
    })
    expect(c.enseignes).toContain("EXEMPLE MENUISERIE")
    expect(calls[0]!.url).toBe(
      "https://recherche-entreprises.api.gouv.fr/search?q=exemple%20menuiserie&page=1&per_page=10&code_postal=75002",
    )
    expect(calls[0]!.headers?.["User-Agent"]).toContain("Liaison")
  })

  test("a SIREN search keeps only the exact hit", async () => {
    const other = registryResultWith({ siren: FICTIONAL_SIRENS[2], nom_complet: "AUTRE EXEMPLE" })
    const { fetch } = fakeFetch([registryResponse([other, REGISTRY_SEARCH_HIT.results[0]])])
    const r = await registrySearch({ fetch }, { siren: "902 000 009" })
    expect(r.status).toBe("ok")
    if (r.status === "ok") expect(r.candidates.map((c) => c.siren)).toEqual(["902000009"])
  })

  test("0 results -> registry_unconfirmed/no_result (never invalid or ceased)", async () => {
    const { fetch } = fakeFetch([ok(REGISTRY_SEARCH_EMPTY)])
    expect(await registrySearch({ fetch }, { q: "nobody" })).toEqual({
      status: "registry_unconfirmed",
      reason: "no_result",
    })
  })

  test("429 -> rate_limited at once: no wait and no second call inside the run", async () => {
    const { fetch, calls } = fakeFetch([REGISTRY_RATE_LIMITED, ok(REGISTRY_SEARCH_HIT)])
    const r = await registrySearch({ fetch }, { q: "exemple" })
    expect(r).toEqual({ status: "registry_unconfirmed", reason: "rate_limited" })
    expect(calls).toHaveLength(1)
  })

  test("network error -> unreachable", async () => {
    const { fetch } = fakeFetch([new Error("ECONNRESET")])
    expect(await registrySearch({ fetch }, { q: "exemple" })).toEqual({
      status: "registry_unconfirmed",
      reason: "unreachable",
    })
  })

  test("a 5xx -> unreachable", async () => {
    const { fetch } = fakeFetch([{ status: 503, headers: {}, body: "" }])
    expect(await registrySearch({ fetch }, { q: "exemple" })).toEqual({
      status: "registry_unconfirmed",
      reason: "unreachable",
    })
  })

  test("two candidates are both returned, none picked", async () => {
    const a = registryResultWith({ siren: FICTIONAL_SIRENS[0], nom_complet: "EXEMPLE INDUSTRIES" })
    const b = registryResultWith({
      siren: FICTIONAL_SIRENS[2],
      nom_complet: "EXEMPLE INDUSTRIES NORD",
    })
    const { fetch } = fakeFetch([registryResponse([a, b])])
    const r = await registrySearch({ fetch }, { q: "exemple industries" })
    expect(r.status).toBe("ok")
    if (r.status !== "ok") return
    expect(r.candidates).toHaveLength(2)
    expect("picked" in r).toBe(false)
  })

  test("the name match covers raison sociale, sigle and enseignes", async () => {
    const { fetch } = fakeFetch([ok(REGISTRY_SEARCH_HIT)])
    const r = await registrySearch({ fetch }, { q: "x" })
    if (r.status !== "ok") throw new Error("expected ok")
    const c = r.candidates[0]!
    expect(candidateMatchesName(c, ["Exemple Menuiserie Atelier SARL"])).toBe(true)
    expect(candidateMatchesName(c, ["Exemple Menuiserie"])).toBe(true)
    expect(candidateMatchesName(c, ["Autre Societe Exemple"])).toBe(false)
  })
})
