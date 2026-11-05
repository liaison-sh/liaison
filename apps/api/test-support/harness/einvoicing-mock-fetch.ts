// SPDX-License-Identifier: FSL-1.1-ALv2
//
// E2E harness for the invoicing e-invoicing agent scenarios: deterministic stand-ins for the
// external boundaries the agent's fix loop crosses, loaded per scenario over HTTP.
//
//  - The French business registry search (recherche-entreprises.api.gouv.fr) and the ECB
//    reference-rate API, reached by the invoicing sandbox through the bridge fetch: a link in the
//    e2e server's sandbox-fetch chain (`makeEinvoicingMockFetch`), every other host delegated.
//    Fixtures: POST /api/_test/einvoicing/fixtures.
//  - The agent's web_search / web_fetch: all four WebToolsTestAccess seams (search, fetch, the
//    mocked-host predicate, deterministic extraction), installed by POST /api/_test/einvoicing/web
//    and removed by POST /api/_test/einvoicing/reset. A query or a URL with no canned answer gets
//    an empty search / a 404, never the live web.
//
// Mounted only when `qaSeedRoutesEnabled` (test / QA harness), like every /api/_test route.
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { qaSeedRoutesEnabled } from "~/lib/env"
import { zValidator } from "~/lib/validate"
import { WebToolsTestAccess } from "~/modules/agent/tools/web-tools"

const REGISTRY_HOST = "recherche-entreprises.api.gouv.fr"
const ECB_HOST = "data-api.ecb.europa.eu"

/** One registry company, in the registry's own field names (fictional values). */
interface RegistryCompany {
  siren: string
  name: string
  postcode: string
  city: string
  /** A active, C ceased. */
  status?: "A" | "C"
}

interface WebPage {
  url: string
  title: string
  /** Text of the page (returned by web_fetch, also its search snippet). */
  content: string
  /** Lower-cased words: a search query containing ALL of them returns this page. */
  match: string[]
}

const state: {
  registry: RegistryCompany[]
  ecb: { status: number; body: string } | null
  pages: WebPage[]
  registryCalls: string[]
  webSearches: string[]
  webFetches: string[]
} = { registry: [], ecb: null, pages: [], registryCalls: [], webSearches: [], webFetches: [] }

/** The registry `/search` result of a company (fields the invoicing lookup maps). */
function registryRow(c: RegistryCompany): Record<string, unknown> {
  return {
    siren: c.siren,
    nom_complet: c.name,
    nom_raison_sociale: c.name,
    sigle: null,
    etat_administratif: c.status ?? "A",
    nature_juridique: "5710",
    siege: {
      siret: `${c.siren}00011`,
      numero_voie: "1",
      type_voie: "RUE",
      libelle_voie: "DE L'EXEMPLE",
      code_postal: c.postcode,
      libelle_commune: c.city,
      etat_administratif: c.status ?? "A",
      liste_enseignes: null,
    },
    matching_etablissements: [],
  }
}

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()

/** A SIREN query matches that SIREN only; a text query matches a company whose name holds every
 *  word of the query (the registry's full-text search, simplified). */
function registryMatches(q: string): RegistryCompany[] {
  const digits = q.replace(/\s/g, "")
  if (/^\d{9}(\d{5})?$/.test(digits))
    return state.registry.filter((c) => c.siren === digits.slice(0, 9))
  const words = norm(q).split(" ").filter(Boolean)
  if (words.length === 0) return []
  return state.registry.filter((c) => {
    const name = ` ${norm(c.name)} `
    return words.every((w) => name.includes(` ${w} `))
  })
}

export function einvoicingMockHandlesHost(host: string): boolean {
  return host === REGISTRY_HOST || host === ECB_HOST
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

/** Sandbox-fetch chain link: registry + ECB answered from the loaded fixtures. */
export function makeEinvoicingMockFetch(inner: typeof fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const raw =
      typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      return inner(input, init)
    }
    if (url.hostname === REGISTRY_HOST) {
      state.registryCalls.push(url.href)
      const q = url.searchParams.get("q") ?? ""
      const hits = registryMatches(q)
      return json({
        results: hits.map(registryRow),
        total_results: hits.length,
        page: 1,
        per_page: 10,
        total_pages: 1,
      })
    }
    if (url.hostname === ECB_HOST) {
      // No canned rate: the reference-rate API is unavailable (an issue never waits on it).
      const r = state.ecb ?? { status: 503, body: "unavailable" }
      return new Response(r.body, { status: r.status })
    }
    return inner(input, init)
  }) as typeof fetch
}

function webSearch(query: string, numResults: number) {
  state.webSearches.push(query)
  const q = query.toLowerCase()
  return state.pages
    .filter((p) => p.match.every((w) => q.includes(w.toLowerCase())))
    .slice(0, numResults)
    .map((p, i) => ({
      title: p.title,
      url: p.url,
      snippet: p.content.slice(0, 300),
      score: 1 - i / 10,
    }))
}

function pageFor(href: string): WebPage | undefined {
  const strip = (u: string) => u.replace(/\/+$/, "")
  return state.pages.find((p) => strip(p.url) === strip(href))
}

const mockedHosts = () => new Set(state.pages.map((p) => new URL(p.url).hostname))

function installWebSeams(): void {
  WebToolsTestAccess.setWebSearch(webSearch)
  WebToolsTestAccess.setWebFetch((async (input: Parameters<typeof fetch>[0]) => {
    const href =
      typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url
    state.webFetches.push(href)
    const page = pageFor(href)
    if (!page)
      return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } })
    return new Response(
      `<html><head><title>${page.title}</title></head><body><p>${page.content}</p></body></html>`,
      {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      },
    )
  }) as typeof fetch)
  WebToolsTestAccess.setWebFetchMockHosts((host) => mockedHosts().has(host))
  // The page text as is: no model in the extraction path, so what the agent reads is the fixture.
  WebToolsTestAccess.setDeterministicExtraction((content) => {
    const flat = (t: string) => t.replace(/[^A-Za-z0-9]+/g, " ").trim()
    const page = state.pages.find((p) => flat(content).includes(flat(p.content)))
    return page ? `${page.title}\n${page.content}` : null
  })
}

function removeWebSeams(): void {
  WebToolsTestAccess.setWebSearch(null)
  WebToolsTestAccess.setWebFetch(null)
  WebToolsTestAccess.setWebFetchMockHosts(null)
  WebToolsTestAccess.setDeterministicExtraction(null)
}

export const einvoicingTestRoutes = new Hono<AppEnv>()

einvoicingTestRoutes.use("*", async (_c, next) => {
  if (!qaSeedRoutesEnabled) throw new HTTPException(404, { message: "Not found" })
  await next()
})

const companySchema = z.object({
  siren: z.string().regex(/^\d{9}$/),
  name: z.string().min(1),
  postcode: z.string(),
  city: z.string(),
  status: z.enum(["A", "C"]).optional(),
})

/** Add registry companies (merged by SIREN) and optionally a canned ECB answer. */
einvoicingTestRoutes.post(
  "/fixtures",
  zValidator(
    "json",
    z.object({
      registry: z.array(companySchema).default([]),
      ecb: z.object({ status: z.number().int(), body: z.string() }).nullable().optional(),
    }),
  ),
  (c) => {
    const body = c.req.valid("json")
    for (const co of body.registry) {
      state.registry = state.registry.filter((r) => r.siren !== co.siren)
      state.registry.push(co)
    }
    if (body.ecb !== undefined) state.ecb = body.ecb
    return c.json({ ok: true, registry: state.registry.length })
  },
)

/** Add canned web pages (merged by URL) and install the four web-tools seams. */
einvoicingTestRoutes.post(
  "/web",
  zValidator(
    "json",
    z.object({
      pages: z
        .array(
          z.object({
            url: z.string().url(),
            title: z.string(),
            content: z.string(),
            match: z.array(z.string().min(1)).min(1),
          }),
        )
        .default([]),
    }),
  ),
  (c) => {
    const body = c.req.valid("json")
    for (const p of body.pages) {
      state.pages = state.pages.filter((x) => x.url !== p.url)
      state.pages.push(p)
    }
    installWebSeams()
    return c.json({ ok: true, pages: state.pages.length })
  },
)

/** What the boundaries saw: registry queries, web searches and fetched URLs. */
einvoicingTestRoutes.get("/calls", (c) =>
  c.json({
    registry: state.registryCalls,
    webSearches: state.webSearches,
    webFetches: state.webFetches,
  }),
)

einvoicingTestRoutes.post("/reset", (c) => {
  state.registry = []
  state.ecb = null
  state.pages = []
  state.registryCalls = []
  state.webSearches = []
  state.webFetches = []
  removeWebSeams()
  return c.json({ ok: true })
})
