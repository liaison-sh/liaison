// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The fixture CRM's request handler: a pure `Request -> Response` function
 * over `data.ts`. The HTTP server (`server.ts`) mounts it on a port; the demo
 * transport calls it in-process (no socket, no outbound request). Every route
 * is described by `openapi.json`, and the drift test keeps the two aligned.
 *
 * All routes live under `/v1` and need the `X-Api-Key` header.
 */
import {
  buildFixtureCrmData,
  type Company,
  type Contact,
  companySummary,
  FIXTURE_CRM_API_KEY_HEADER,
  type FixtureCrmData,
  type Note,
} from "./data"

export interface FixtureCrmHandlerOptions {
  apiKey: string
  /** Dates are computed from this (default: now). */
  referenceDate?: Date
  /**
   * Keep every request in `requests` (default true, for tests). A long-lived
   * handler (the demo's per-org store) turns it off so the log never grows.
   */
  recordRequests?: boolean
  /**
   * The time a write stamps on what it creates (default: now). A store
   * replayed from a shared write log passes the original write's time, so
   * every replica of it holds the same record.
   */
  now?: () => Date
}

export interface FixtureCrmHandler {
  handle(request: Request): Promise<Response>
  readonly data: FixtureCrmData
  /** Notes created through `POST /companies/{id}/notes`, in order. */
  readonly notes: Note[]
  /** Companies created through `POST /companies` or with a new contact, in order. */
  readonly createdCompanies: Company[]
  /** Contacts created through `POST /contacts`, in order. */
  readonly createdContacts: Contact[]
  /** Every request seen (method + path + search), for tests. */
  readonly requests: string[]
}

const DEFAULT_PAGE_SIZE = 25
const MAX_PAGE_SIZE = 100
const MAX_NOTE_LENGTH = 2000
const MAX_NAME_LENGTH = 200
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,253}$/

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function error(status: number, code: string, message: string): Response {
  return json(status, { error: { code, message } })
}

function encodeCursor(offset: number): string {
  return Buffer.from(`o:${offset}`).toString("base64url")
}

function decodeCursor(cursor: string): number | null {
  const text = Buffer.from(cursor, "base64url").toString("utf8")
  const m = /^o:(\d{1,6})$/.exec(text)
  return m ? Number(m[1]) : null
}

function lower(v: string | null): string | null {
  return v === null || v === "" ? null : v.trim().toLowerCase()
}

/** Constant-time string comparison (the fixture models a real API's auth check). */
function sameKey(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  let diff = 0
  for (let i = 0; i < ab.length; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0)
  return diff === 0
}

export function createFixtureCrmHandler(options: FixtureCrmHandlerOptions): FixtureCrmHandler {
  const data = buildFixtureCrmData(options.referenceDate ?? new Date())
  const now = options.now ?? (() => new Date())
  const notes: Note[] = []
  const createdCompanies: Company[] = []
  const createdContacts: Contact[] = []
  const requests: string[] = []

  function listCompanies(url: URL): Response {
    const email = lower(url.searchParams.get("email"))
    const domain = lower(url.searchParams.get("domain"))
    const phone = url.searchParams.get("phone")?.replace(/\D/g, "") || null
    const q = lower(url.searchParams.get("q"))
    const limitRaw = url.searchParams.get("limit")
    const limit = limitRaw === null ? DEFAULT_PAGE_SIZE : Number(limitRaw)
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      return error(400, "invalid_limit", `limit must be an integer between 1 and ${MAX_PAGE_SIZE}`)
    }
    const cursorRaw = url.searchParams.get("cursor")
    const offset = cursorRaw === null ? 0 : decodeCursor(cursorRaw)
    if (offset === null) return error(400, "invalid_cursor", "cursor is not valid")

    let rows = data.companies
    if (email) {
      const ids = new Set(
        data.contacts.filter((c) => c.email.toLowerCase() === email).map((c) => c.company_id),
      )
      rows = rows.filter((c) => ids.has(c.id))
    }
    if (phone) {
      const ids = new Set(
        data.contacts.filter((c) => c.phone.replace(/\D/g, "") === phone).map((c) => c.company_id),
      )
      rows = rows.filter((c) => ids.has(c.id))
    }
    if (domain) rows = rows.filter((c) => c.domain === domain)
    if (q) rows = rows.filter((c) => c.name.toLowerCase().includes(q))
    const page = rows.slice(offset, offset + limit)
    const next = offset + limit < rows.length ? encodeCursor(offset + limit) : null
    return json(200, { data: page, next_cursor: next, total: rows.length })
  }

  /** The latest orders across every customer, newest first, each naming its company. */
  function recentOrders(url: URL): Response {
    const since = url.searchParams.get("since")
    const status = url.searchParams.get("status")
    const limitRaw = url.searchParams.get("limit")
    const limit = limitRaw === null ? DEFAULT_PAGE_SIZE : Number(limitRaw)
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      return error(400, "invalid_limit", `limit must be an integer between 1 and ${MAX_PAGE_SIZE}`)
    }
    if (since !== null && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
      return error(400, "invalid_since", "since must be a date (YYYY-MM-DD)")
    }
    const names = new Map(data.companies.map((c) => [c.id, c.name]))
    const rows = data.orders
      .filter((o) => (since === null || o.date >= since) && (!status || o.status === status))
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.number < b.number ? 1 : -1))
      .slice(0, limit)
      .map((o) => ({ ...o, company_name: names.get(o.company_id) ?? "" }))
    return json(200, { data: rows })
  }

  function companyExists(id: string): boolean {
    return data.companies.some((c) => c.id === id)
  }

  function companyScoped(id: string, sub: string, url: URL): Response {
    if (!companyExists(id)) return error(404, "not_found", "no such company")
    switch (sub) {
      case "contacts":
        return json(200, { data: data.contacts.filter((c) => c.company_id === id) })
      case "deals": {
        const stage = url.searchParams.get("stage")
        return json(200, {
          data: data.deals.filter((d) => d.company_id === id && (!stage || d.stage === stage)),
        })
      }
      case "orders": {
        const since = url.searchParams.get("since")
        const status = url.searchParams.get("status")
        if (since !== null && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
          return error(400, "invalid_since", "since must be a date (YYYY-MM-DD)")
        }
        const rows = data.orders
          .filter(
            (o) =>
              o.company_id === id &&
              (since === null || o.date >= since) &&
              (!status || o.status === status),
          )
          .sort((a, b) => (a.date < b.date ? 1 : -1))
        return json(200, { data: rows })
      }
      case "invoices": {
        const status = url.searchParams.get("status")
        return json(200, {
          data: data.invoices.filter(
            (i) => i.company_id === id && (!status || i.status === status),
          ),
        })
      }
      default:
        return error(404, "not_found", "no such route")
    }
  }

  async function createNote(id: string, request: Request): Promise<Response> {
    if (!companyExists(id)) return error(404, "not_found", "no such company")
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return error(400, "invalid_body", "body must be JSON")
    }
    const note =
      typeof body === "object" && body !== null && "note" in body
        ? (body as { note: unknown }).note
        : undefined
    if (typeof note !== "object" || note === null) {
      return error(400, "invalid_body", "body must be {note: {body, pinned?}}")
    }
    const text = (note as { body?: unknown }).body
    const pinned = (note as { pinned?: unknown }).pinned
    if (typeof text !== "string" || text.length === 0 || text.length > MAX_NOTE_LENGTH) {
      return error(400, "invalid_body", `note.body must be 1 to ${MAX_NOTE_LENGTH} characters`)
    }
    if (pinned !== undefined && typeof pinned !== "boolean") {
      return error(400, "invalid_body", "note.pinned must be a boolean")
    }
    const created: Note = {
      id: `note_${String(notes.length + 1).padStart(3, "0")}`,
      company_id: id,
      body: text,
      pinned: pinned ?? false,
      created_at: now().toISOString(),
    }
    notes.push(created)
    return json(201, { note: created })
  }

  async function jsonBody(request: Request): Promise<unknown> {
    try {
      return await request.json()
    } catch {
      return undefined
    }
  }

  /** `body[key]` when it is an object, else undefined. */
  function member(body: unknown, key: string): Record<string, unknown> | undefined {
    if (typeof body !== "object" || body === null || !(key in body)) return undefined
    const v = (body as Record<string, unknown>)[key]
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined
  }

  /** An optional string field: undefined when absent, null when it is not a short string. */
  function optionalText(o: Record<string, unknown>, key: string): string | undefined | null {
    const v = o[key]
    if (v === undefined) return undefined
    return typeof v === "string" && v.length <= MAX_NAME_LENGTH ? v.trim() : null
  }

  /** Validate a new company's fields and add it; an error Response when refused. */
  function addCompany(input: Record<string, unknown>): Company | Response {
    const name = optionalText(input, "name")
    if (!name)
      return error(400, "invalid_body", `company.name must be 1 to ${MAX_NAME_LENGTH} characters`)
    const fields: Record<string, string> = {}
    for (const key of ["domain", "industry", "city", "country"] as const) {
      const v = optionalText(input, key)
      if (v === null) return error(400, "invalid_body", `company.${key} must be a short string`)
      fields[key] = v ?? ""
    }
    const domain = (fields.domain ?? "").toLowerCase()
    if (domain !== "" && !DOMAIN_RE.test(domain)) {
      return error(400, "invalid_body", "company.domain must be a domain name (e.g. example.com)")
    }
    if (domain !== "" && data.companies.some((c) => c.domain === domain)) {
      return error(409, "conflict", "a company with this domain already exists")
    }
    const company: Company = {
      id: `cmp_${String(data.companies.length + 1).padStart(3, "0")}`,
      name,
      domain,
      industry: fields.industry ?? "",
      city: fields.city ?? "",
      country: fields.country ?? "",
      tier: "bronze",
      currency: "EUR",
      created_on: now().toISOString().slice(0, 10),
      account_manager: { name: "", email: "", phone_private: "" },
      internal_notes: "",
      credit_check: { rating: "", raw_score: 0 },
    }
    data.companies.push(company)
    createdCompanies.push(company)
    return company
  }

  async function createCompany(request: Request): Promise<Response> {
    const input = member(await jsonBody(request), "company")
    if (!input) return error(400, "invalid_body", "body must be {company: {name, domain?, ...}}")
    const created = addCompany(input)
    if (created instanceof Response) return created
    return json(201, { company: created })
  }

  /**
   * A new contact, attached to an existing company (`company_id`) or to a new
   * one created in the same call (`company`): exactly one of the two.
   */
  async function createContact(request: Request): Promise<Response> {
    const input = member(await jsonBody(request), "contact")
    if (!input) {
      return error(
        400,
        "invalid_body",
        "body must be {contact: {first_name, last_name, email, ...}}",
      )
    }
    const text: Record<string, string> = {}
    for (const key of ["first_name", "last_name", "email", "phone", "title"] as const) {
      const v = optionalText(input, key)
      if (v === null) return error(400, "invalid_body", `contact.${key} must be a short string`)
      text[key] = v ?? ""
    }
    if (!text.first_name || !text.last_name) {
      return error(400, "invalid_body", "contact.first_name and contact.last_name are required")
    }
    const email = (text.email ?? "").toLowerCase()
    if (!EMAIL_RE.test(email))
      return error(400, "invalid_body", "contact.email must be an email address")
    if (data.contacts.some((c) => c.email.toLowerCase() === email)) {
      return error(409, "conflict", "a contact with this email already exists")
    }
    const companyId = input.company_id
    const newCompany = member(input, "company")
    if ((companyId === undefined) === (newCompany === undefined)) {
      return error(
        400,
        "invalid_body",
        "give exactly one of contact.company_id and contact.company",
      )
    }
    let company: Company | null = null
    if (companyId !== undefined) {
      if (typeof companyId !== "string" || !companyExists(companyId)) {
        return error(404, "not_found", "no such company")
      }
    } else if (newCompany) {
      const created = addCompany(newCompany)
      if (created instanceof Response) return created
      company = created
    }
    const contact: Contact = {
      id: `ct_${String(data.contacts.length + 1).padStart(3, "0")}`,
      company_id: company?.id ?? (companyId as string),
      first_name: text.first_name,
      last_name: text.last_name,
      email,
      phone: text.phone ?? "",
      title: text.title ?? "",
    }
    data.contacts.push(contact)
    createdContacts.push(contact)
    return json(201, company ? { contact, company } : { contact })
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (options.recordRequests !== false)
      requests.push(`${request.method} ${url.pathname}${url.search}`)
    const key = request.headers.get(FIXTURE_CRM_API_KEY_HEADER)
    if (key === null || !sameKey(key, options.apiKey)) {
      return error(401, "unauthorized", "missing or invalid API key")
    }
    const path = url.pathname.replace(/\/+$/, "")
    const method = request.method

    if (path === "/v1/companies" && method === "GET") return listCompanies(url)
    if (path === "/v1/companies" && method === "POST") return createCompany(request)
    if (path === "/v1/contacts" && method === "POST") return createContact(request)
    if (path === "/v1/orders" && method === "GET") return recentOrders(url)
    if (path === "/v1/stock" && method === "GET") {
      const sku = url.searchParams.get("sku")
      const q = lower(url.searchParams.get("q"))
      return json(200, {
        data: data.stock.filter(
          (s) => (!sku || s.sku === sku) && (!q || s.name.toLowerCase().includes(q)),
        ),
      })
    }
    const one = /^\/v1\/companies\/([A-Za-z0-9_]+)$/.exec(path)
    if (one && method === "GET") {
      const summary = companySummary(data, one[1] ?? "")
      return summary ? json(200, { company: summary }) : error(404, "not_found", "no such company")
    }
    const scoped = /^\/v1\/companies\/([A-Za-z0-9_]+)\/([a-z]+)$/.exec(path)
    if (scoped) {
      const [, id = "", sub = ""] = scoped
      if (sub === "notes" && method === "POST") return createNote(id, request)
      if (method === "GET" && sub !== "notes") return companyScoped(id, sub, url)
      return error(405, "method_not_allowed", "method not allowed")
    }
    return error(404, "not_found", "no such route")
  }

  return { handle, data, notes, createdCompanies, createdContacts, requests }
}
