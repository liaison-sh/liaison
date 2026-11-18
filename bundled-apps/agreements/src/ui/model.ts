// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What the staff screens read and write, as pure functions over the app's own
// tool results: no DOM, no host. The screens (list, agreement, editor, send)
// draw these; the tests pin them without a browser.

import {
  type AgreementSource,
  type Check,
  PRICED_KINDS,
  prepareChecks,
  type SourceBlock,
} from "../checks"

export type { AgreementSource, Check, SourceBlock }

/** One row of `home_load` / `agreements_search`. */
export interface AgreementBrief {
  id: string
  number: string
  title: string
  kind: string
  status: string
  needs: string
  company_id: string | null
  renews_on: string | null
  price_minor: string | null
  currency: string | null
  org_access: string
}

export interface SigningLinkView {
  client_action_id: string
  signer: string
  email: string
  sign_order: number | null
  state: string
  expires_at: string
  /** The signed-in person is this signer (a staff signer reads and signs in session). */
  yours?: boolean
  /** `false` on a decline made without the emailed code: maybe not them. */
  code_verified?: boolean
}

export interface VersionView {
  id: string
  number: number
  status: string
  sha256: string | null
  page_count: number | null
  frozen_at: string | null
  file_id?: string | null
  /** The signed copy did not read as the frozen file: nothing was sealed. */
  copy_differs?: boolean
}

/** `agreement_get`. */
export interface AgreementDetail {
  agreement: AgreementBrief & {
    what_it_is: string | null
    starts_on: string | null
    ends_on: string | null
    project_id?: string | null
    hours_minutes?: number | null
    /** The document's language: the legal layout prints its own words in it. */
    language?: string | null
    template_id: string | null
    template_version: number | null
    status_note?: string
    priced?: boolean
    not_a_guarantee?: boolean
    upload?: boolean
  }
  draft: { lock_version: number; source: AgreementSource | null } | null
  versions: VersionView[]
  shares: Array<{ user_id: string; role: string }>
  signing_links: SigningLinkView[]
}

/** A refusal the app answers with (`status: "error"`), as the host hands it back. */
export interface ToolRefusal {
  status: "error"
  error: { code: string; message: string }
  checks?: Check[]
}

export function isRefusal(v: unknown): v is ToolRefusal {
  return (
    !!v && typeof v === "object" && (v as { status?: unknown }).status === "error" && "error" in v
  )
}

// ── Status words and tones ────────────────────────────────────────────────────

export type Tone = "neutral" | "accent" | "success" | "warning" | "error" | "muted"

/** The badge of an agreement status: the English words (translated where drawn) and a calm tone. */
export const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  sent: "Waiting for signatures",
  change_request_sent: "Waiting for the client's approval",
  partly_signed: "Partly signed",
  signed: "Signed",
  accepted: "Accepted",
  ended: "Ended",
  declined: "Declined",
  expired: "Link expired, not signed",
  voided: "Withdrawn",
  withdrawn: "Withdrawn",
  imported: "Imported, signed outside Liaison",
}

export function statusTone(status: string): Tone {
  if (status === "signed" || status === "accepted") return "success"
  if (status === "sent" || status === "partly_signed") return "accent"
  if (status === "draft") return "neutral"
  return "muted"
}

/** One signer's line, from the state of their link. */
export const LINK_LABEL: Record<string, string> = {
  open: "Link sent, not signed yet",
  waiting_turn: "Waits for the signer before",
  decided: "Signed",
  declined: "Declined",
  revoked: "Link withdrawn",
  expired: "Link expired",
  locked: "Too many wrong codes",
}

export const KIND_LABEL: Record<string, string> = {
  proposal: "Proposal",
  sow: "Statement of work",
  msa: "Master agreement",
  nda: "NDA",
  retainer: "Retainer",
  tm: "Time and materials",
  dpa: "Data processing",
  change_request: "Change request",
  other: "Other document",
}

/** The sidebar's document groups, in the order of the board. */
export const KIND_GROUPS: ReadonlyArray<{ slug: string; label: string }> = [
  { slug: "sow", label: "Statements of work" },
  { slug: "tm", label: "Time and materials" },
  { slug: "retainer", label: "Retainers" },
  { slug: "change_request", label: "Change requests" },
  { slug: "proposal", label: "Proposals" },
  { slug: "nda", label: "NDAs" },
  { slug: "msa", label: "Master agreements" },
  { slug: "dpa", label: "Data processing" },
  { slug: "other", label: "Other documents" },
]

// ── The list ──────────────────────────────────────────────────────────────────

export type ListFilter = "all" | "waiting" | "ending" | string

const WAITING = ["sent", "partly_signed"]

function addDays(date: string, days: number): string {
  const [y, m, day] = date.split("-").map(Number)
  const d = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (day ?? 1) + days))
  return d.toISOString().slice(0, 10)
}

/** Rows of one sidebar entry. The server already ordered them by what needs someone first. */
export function filterRows(rows: AgreementBrief[], filter: ListFilter, today: string) {
  // The home tab's entity is "home": anything that names no entry is the whole list.
  if (filter !== "waiting" && filter !== "ending" && !(filter in KIND_LABEL)) return rows
  if (filter === "waiting") return rows.filter((r) => WAITING.includes(r.status))
  if (filter === "ending")
    return rows.filter(
      (r) => r.status === "signed" && !!r.renews_on && r.renews_on <= addDays(today, 60),
    )
  return rows.filter((r) => r.kind === filter)
}

/** The Needs you block: drafts someone is writing and documents waiting for a signature. */
export function needsYou(rows: AgreementBrief[]): AgreementBrief[] {
  return rows.filter((r) => r.status === "draft" || WAITING.includes(r.status))
}

/** Counts per sidebar entry. */
export function sidebarCounts(rows: AgreementBrief[], today: string): Record<string, number> {
  const out: Record<string, number> = {
    all: rows.length,
    waiting: filterRows(rows, "waiting", today).length,
    ending: filterRows(rows, "ending", today).length,
  }
  for (const g of KIND_GROUPS) out[g.slug] = rows.filter((r) => r.kind === g.slug).length
  return out
}

// ── Money ─────────────────────────────────────────────────────────────────────

/** Minor units of a currency (2 for EUR, 0 for JPY), from the platform's own table. */
export function currencyDigits(currency: string): number {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
      .maximumFractionDigits as number
  } catch {
    return 2
  }
}

/** A price in minor units as the reader reads money: thousands grouped, the currency named. */
export function formatMoney(minor: string | null, currency: string | null, locale = "en"): string {
  if (minor === null || !/^[0-9]+$/.test(minor) || !currency) return ""
  const digits = currencyDigits(currency)
  const padded = minor.padStart(digits + 1, "0")
  const whole = padded.slice(0, padded.length - digits)
  const fraction = digits > 0 ? padded.slice(padded.length - digits) : ""
  // The whole part is an exact integer (a price stays far below 2^53 minor units) and the
  // fraction is pasted back as stored: a price is exact to the cent, never through a float.
  if (whole.length > 15) return `${whole}${fraction ? `.${fraction}` : ""} ${currency}`
  const parts = new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).formatToParts(Number(whole))
  return parts.map((p) => (p.type === "fraction" ? fraction : p.value)).join("")
}

/**
 * What a person typed in the price field, as minor units, or null when it is not a price.
 * Spaces, thin spaces and the group mark are ignored; one decimal mark (`.` or `,`) is allowed.
 */
export function parsePrice(text: string, currency: string): string | null {
  const digits = currencyDigits(currency)
  const t = text.replace(/[\s  ']/g, "")
  if (t === "") return null
  // A comma followed by exactly three digits and no other mark is a group mark (38,000).
  const m = /^([0-9]{1,15}(?:[.,][0-9]{3})*)(?:[.,]([0-9]{1,2}))?$/.exec(t)
  if (!m) return null
  const wholeRaw = (m[1] ?? "").replace(/[.,]/g, "")
  const frac = m[2] ?? ""
  if (frac.length > digits) return null
  const minor = `${wholeRaw}${frac.padEnd(digits, "0")}`.replace(/^0+(?=\d)/, "")
  return /^[0-9]{1,18}$/.test(minor) ? minor : null
}

// ── The document ──────────────────────────────────────────────────────────────

export function blocksOf(source: AgreementSource | null | undefined): SourceBlock[] {
  return source?.body?.blocks ?? []
}

/** Blocks a person writes here: a heading, a paragraph or an article. Others keep their data. */
export function isTextBlock(b: SourceBlock): boolean {
  return b.type === "heading" || b.type === "paragraph" || b.type === "article"
}

/**
 * The computed numbers of the articles, as the classic layout prints them: level 1 is
 * "Article 3", level 2 "3.1", level 3 "3.1.1". Nobody types a number.
 */
export function articleNumbers(blocks: SourceBlock[]): Array<string | null> {
  const counters = [0, 0, 0, 0, 0]
  return blocks.map((b) => {
    if (b.type !== "article") return null
    const level = Math.min(Math.max(Number(b.level ?? 1) || 1, 1), 5)
    counters[level - 1] = (counters[level - 1] ?? 0) + 1
    for (let i = level; i < counters.length; i++) counters[i] = 0
    return counters.slice(0, level).join(".")
  })
}

function withBlocks(source: AgreementSource | null, blocks: SourceBlock[]): AgreementSource {
  const s = source ?? {}
  return { ...s, body: { ...(s.body ?? {}), blocks } }
}

/** The block a person read: its agent mark goes, its text stays. */
export function clearAgentMark(source: AgreementSource | null, index: number): AgreementSource {
  const blocks = blocksOf(source).map((b, i) => {
    if (i !== index) return b
    const { agent_draft: _gone, ...rest } = b
    return rest as SourceBlock
  })
  return withBlocks(source, blocks)
}

/** A person's own text for a block: it is theirs, so no agent mark stays on it. */
export function setBlockText(
  source: AgreementSource | null,
  index: number,
  text: string,
): AgreementSource {
  const blocks = blocksOf(source).map((b, i) => {
    if (i !== index) return b
    const { agent_draft: _gone, ...rest } = b
    return { ...rest, text } as SourceBlock
  })
  return withBlocks(source, blocks)
}

export function setArticleHeading(
  source: AgreementSource | null,
  index: number,
  heading: string,
): AgreementSource {
  const blocks = blocksOf(source).map((b, i) => {
    if (i !== index) return b
    const { agent_draft: _gone, ...rest } = b
    return { ...rest, heading } as SourceBlock
  })
  return withBlocks(source, blocks)
}

export type NewBlockKind = "paragraph" | "heading" | "article"

export function addBlock(source: AgreementSource | null, kind: NewBlockKind): AgreementSource {
  const block: SourceBlock =
    kind === "heading"
      ? { type: "heading", level: 2, text: "" }
      : kind === "article"
        ? { type: "article", level: 1, heading: "", text: "" }
        : { type: "paragraph", text: "" }
  return withBlocks(source, [...blocksOf(source), block])
}

export function removeBlock(source: AgreementSource | null, index: number): AgreementSource {
  return withBlocks(
    source,
    blocksOf(source).filter((_, i) => i !== index),
  )
}

export type Layout = "standard" | "legal"

export function layoutOf(source: AgreementSource | null | undefined): Layout {
  const page = (source?.body as { page?: { layout?: unknown } } | undefined)?.page
  return page?.layout === "legal" ? "legal" : "standard"
}

/** The classic legal layout is a page setting: `body.page.layout`, its language beside it. */
export function setLayout(
  source: AgreementSource | null,
  layout: Layout,
  lang: string,
): AgreementSource {
  const s = source ?? {}
  const body = { ...(s.body ?? {}) } as Record<string, unknown>
  const page = { ...((body.page as Record<string, unknown> | undefined) ?? {}) }
  if (layout === "legal") {
    page.layout = "legal"
    page.lang = page.lang ?? lang
  } else delete page.layout
  body.page = page
  return { ...s, body: body as AgreementSource["body"] }
}

export function agentBlockCount(source: AgreementSource | null | undefined): number {
  return blocksOf(source).filter((b) => b.agent_draft === true).length
}

// ── Checks and actions ────────────────────────────────────────────────────────

/** The checks Prepare runs, drawn before it is pressed (the same pure function the server runs). */
export function editorChecks(detail: AgreementDetail, source: AgreementSource | null): Check[] {
  const a = detail.agreement
  const checks = prepareChecks(
    {
      number: a.number,
      kind: a.kind,
      title: a.title,
      what_it_is: a.what_it_is,
      price_minor: a.price_minor,
      not_a_guarantee_by_user_id: a.not_a_guarantee ? "set" : null,
      project_id: a.project_id ?? null,
      hours_minutes: a.hours_minutes ?? null,
      starts_on: a.starts_on,
    },
    source,
    { upload: a.upload === true },
  )
  // A document with no text has no clause anyone read: "every clause was read" would tick on
  // nothing, so that line waits until there is text.
  const empty = checks.some((c) => c.code === "DOCUMENT_EMPTY" && !c.ok)
  return empty ? checks.filter((c) => c.code !== "AGENT_TEXT_UNREAD") : checks
}

/** Why Prepare for signature is not offered yet (translated where drawn). */
export const PREPARE_WHY: Record<"unsaved" | "checks", string> = {
  unsaved: "Save your changes first: then it can be prepared for signature.",
  checks: "It can be prepared for signature once every line of Before it can be sent is ticked.",
}

/** Why Prepare for signature is not offered yet (a PREPARE_WHY key); null when it is. */
export function prepareWhy(dirty: boolean, checks: Check[]): keyof typeof PREPARE_WHY | null {
  if (dirty) return "unsaved"
  if (!canPrepare(checks)) return "checks"
  return null
}

/** The STATUS_LABEL key of an agreement: a change request is approved by the client, never signed. */
export function statusKey(status: string, kind?: string): string {
  return kind === "change_request" && status === "sent" ? "change_request_sent" : status
}

/** Prepare is offered only when no blocking check fails. */
export function canPrepare(checks: Check[]): boolean {
  return checks.every((c) => !c.blocking || c.ok)
}

export function isPricedKind(kind: string): boolean {
  return (PRICED_KINDS as readonly string[]).includes(kind)
}

/** The signed-in person's own open link, when it is their turn: the one sign button shown. */
export function yourOpenLink(links: SigningLinkView[]): SigningLinkView | null {
  return links.find((l) => l.yours === true && l.state === "open") ?? null
}

const ENDED_LINK = new Set(["expired", "revoked", "locked"])

/**
 * Links that ended before everyone signed and whose signer holds no newer link: a new link
 * may be sent for these. An ended link a new one already replaced offers nothing more.
 */
export function relinkable(links: SigningLinkView[]): SigningLinkView[] {
  return links.filter(
    (l) =>
      ENDED_LINK.has(l.state) &&
      !links.some(
        (o) =>
          o !== l && o.email.toLowerCase() === l.email.toLowerCase() && !ENDED_LINK.has(o.state),
      ),
  )
}

/** A decline made without the emailed code: "If this was not them, send a new link". */
export function declinedUnproven(link: SigningLinkView): boolean {
  return link.state === "declined" && link.code_verified === false
}

export function latestVersion(detail: AgreementDetail): VersionView | null {
  return detail.versions[detail.versions.length - 1] ?? null
}

/** Editing a sent agreement makes a new version and withdraws its open links. */
export function editReplacesSent(status: string): boolean {
  return WAITING.includes(status)
}

/** A short fingerprint for a line; the full one is one click away. */
export function shortHash(sha: string | null | undefined): string {
  return sha ? `${sha.slice(0, 8)}…${sha.slice(-4)}` : ""
}

/** The signers a person types, as the send tool takes them; null when one is incomplete. */
export interface SignerInput {
  name: string
  email: string
}

export function signersForSend(rows: SignerInput[]): SignerInput[] | null {
  const out = rows
    .map((r) => ({ name: r.name.trim(), email: r.email.trim() }))
    .filter((r) => r.name !== "" || r.email !== "")
  if (out.length === 0) return null
  for (const r of out) if (r.name === "" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email)) return null
  return out
}
