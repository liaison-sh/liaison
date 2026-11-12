// SPDX-License-Identifier: FSL-1.1-ALv2
// Client of the public French business registry search (recherche-entreprises.api.gouv.fr):
// one GET per search, mapped to the fields an identity needs. Never picks a candidate for the
// caller. A 0-result answer is `registry_unconfirmed/no_result` (non-diffusible companies are
// excluded from the registry), never "invalid" or "ceased".
import { namesMatch } from "./identity"

export const REGISTRY_HOST = "recherche-entreprises.api.gouv.fr"
const REGISTRY_URL = `https://${REGISTRY_HOST}/search`
const USER_AGENT = "Liaison invoicing (identity lookup)"

export interface RegistryCandidate {
  siren: string
  /** Head office SIRET. */
  siret: string | null
  /** `nom_complet` (the display name, with the acronym). */
  name: string | null
  /** `nom_raison_sociale` (the registered legal name). */
  legal_name: string | null
  sigle: string | null
  /** Trade names of the head office and of the matching establishments. */
  enseignes: string[]
  /** `etat_administratif`: A active, C ceased. */
  status: "A" | "C" | null
  nature_juridique: string | null
  line1: string | null
  postcode: string | null
  city: string | null
  country_code: "FR"
}

export type RegistryUnconfirmedReason = "no_result" | "unreachable" | "rate_limited"

export type RegistrySearchResult =
  | { status: "ok"; candidates: RegistryCandidate[] }
  | { status: "registry_unconfirmed"; reason: RegistryUnconfirmedReason }

export interface RegistryFetchCtx {
  fetch?: (
    url: string,
    opts?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => Promise<unknown>
}

type Row = Record<string, unknown>

function str(v: unknown): string | null {
  if (typeof v !== "string") return null
  const t = v.trim()
  return t ? t : null
}

function digitsOnly(v: string | null | undefined): string {
  return (v ?? "").replace(/[\s.]/g, "")
}

/** Street line of an establishment: number, repetition, street type and name. */
function streetLine(e: Row): string | null {
  const parts = [e.numero_voie, e.indice_repetition, e.type_voie, e.libelle_voie]
    .map((p) => str(p))
    .filter((p): p is string => !!p)
  return parts.length > 0 ? parts.join(" ") : str(e.adresse)
}

function enseignesOf(e: Row | undefined): string[] {
  const out: string[] = []
  if (!e) return out
  if (Array.isArray(e.liste_enseignes)) {
    for (const n of e.liste_enseignes) {
      const s = str(n)
      if (s) out.push(s)
    }
  }
  const commercial = str(e.nom_commercial)
  if (commercial) out.push(commercial)
  return out
}

export function mapRegistryResult(r: Row): RegistryCandidate | null {
  const siren = str(r.siren)
  if (!siren) return null
  const siege = (r.siege ?? {}) as Row
  const enseignes = [...enseignesOf(siege)]
  if (Array.isArray(r.matching_etablissements)) {
    for (const e of r.matching_etablissements as Row[]) enseignes.push(...enseignesOf(e))
  }
  const status = str(r.etat_administratif)
  return {
    siren,
    siret: str(siege.siret),
    name: str(r.nom_complet),
    legal_name: str(r.nom_raison_sociale),
    sigle: str(r.sigle),
    enseignes: [...new Set(enseignes)],
    status: status === "A" || status === "C" ? status : null,
    nature_juridique: str(r.nature_juridique),
    line1: streetLine(siege),
    postcode: str(siege.code_postal),
    city: str(siege.libelle_commune),
    country_code: "FR",
  }
}

/** Every name the registry records for a candidate (§4.4 match targets). */
export function candidateNames(c: RegistryCandidate): string[] {
  return [c.name, c.legal_name, c.sigle, ...c.enseignes].filter((n): n is string => !!n)
}

/** True when any of `expected` matches any registry name of the candidate. */
export function candidateMatchesName(
  c: RegistryCandidate,
  expected: ReadonlyArray<string | null | undefined>,
): boolean {
  const names = candidateNames(c)
  return expected.some((e) => !!e && names.some((n) => namesMatch(e, n)))
}

interface FetchResponse {
  status?: number
  headers?: Record<string, string>
  body?: string
}

function parseEnvelope(raw: unknown): FetchResponse | null {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as FetchResponse
    } catch {
      return null
    }
  }
  return (raw ?? null) as FetchResponse | null
}

/** The registry search URL for a query (null when there is nothing to search): also the
 *  provenance link of a SIREN the registry confirmed. */
export function registrySearchUrl(input: {
  q?: string | null
  siren?: string | null
  postcode?: string | null
}): string | null {
  const q = digitsOnly(input.siren) || str(input.q)
  if (!q) return null
  const postcode = str(input.postcode)
  const params = [`q=${encodeURIComponent(q)}`, "page=1", "per_page=10"]
  if (postcode && /^\d{5}$/.test(postcode)) params.push(`code_postal=${postcode}`)
  return `${REGISTRY_URL}?${params.join("&")}`
}

/**
 * Search the registry by free text and / or SIREN (a SIREN search keeps the exact hits only),
 * optionally narrowed to a 5-digit postcode. A 429 is answered `rate_limited` at once, never
 * waited out inside the run: the caller's next run (the confirm job, a later issue) asks again.
 */
export async function registrySearch(
  ctx: RegistryFetchCtx,
  input: { q?: string | null; siren?: string | null; postcode?: string | null },
): Promise<RegistrySearchResult> {
  const siren = digitsOnly(input.siren)
  const url = registrySearchUrl(input)
  if (!url || !ctx.fetch) return { status: "registry_unconfirmed", reason: "unreachable" }

  let res: FetchResponse | null
  try {
    res = parseEnvelope(
      await ctx.fetch(url, { method: "GET", headers: { "User-Agent": USER_AGENT } }),
    )
  } catch {
    return { status: "registry_unconfirmed", reason: "unreachable" }
  }
  if (!res) return { status: "registry_unconfirmed", reason: "unreachable" }
  if (res.status === 429) return { status: "registry_unconfirmed", reason: "rate_limited" }
  if (res.status !== 200 || typeof res.body !== "string") {
    return { status: "registry_unconfirmed", reason: "unreachable" }
  }
  let body: { results?: unknown }
  try {
    body = JSON.parse(res.body) as { results?: unknown }
  } catch {
    return { status: "registry_unconfirmed", reason: "unreachable" }
  }
  const rows = Array.isArray(body.results) ? (body.results as Row[]) : []
  let candidates = rows.map(mapRegistryResult).filter((c): c is RegistryCandidate => !!c)
  if (siren) candidates = candidates.filter((c) => c.siren === siren)
  if (candidates.length === 0) return { status: "registry_unconfirmed", reason: "no_result" }
  return { status: "ok", candidates }
}
