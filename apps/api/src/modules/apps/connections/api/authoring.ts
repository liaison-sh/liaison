// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Adapter authoring, the parts shared by the agent tools (the bridge reads and
 * the host-side save and restore), the settings routes and their tests: the
 * authoring reference split into sections, a stored document returned within
 * a model's reading budget, the kept versions compared with the current
 * credential target, and a credential target in words.
 */
import { readFileSync } from "node:fs"
import type { Adapter, AdapterVersionList } from "@liaison/api-connector-core"
import type { ApiConn } from "./declarations"
import { credentialStatuses, credentialTarget, getAdapterRow, listAdapterVersions } from "./store"

/** The most a reference section or a returned document may hold, in characters. */
export const AUTHORING_TEXT_LIMIT = 30_000

export interface ReferenceSection {
  id: string
  title: string
  text: string
}

const REFERENCE_URL = new URL("./reference/authoring.md", import.meta.url)
const HEADING_RE = /^## (.+?) \[([a-z0-9-]+)\]\s*$/

let cachedSections: ReferenceSection[] | null = null

/** The authoring reference (`reference/authoring.md`), one entry per `## Title [id]` section. */
export function referenceSections(): ReferenceSection[] {
  if (cachedSections) return cachedSections
  const lines = readFileSync(REFERENCE_URL, "utf8").split("\n")
  const sections: ReferenceSection[] = []
  let current: { id: string; title: string; lines: string[] } | null = null
  const flush = () => {
    if (current) {
      sections.push({
        id: current.id,
        title: current.title,
        text: `## ${current.title}\n${current.lines.join("\n")}`.trim(),
      })
    }
  }
  for (const line of lines) {
    const m = HEADING_RE.exec(line)
    if (m) {
      flush()
      current = { id: m[2] ?? "", title: m[1] ?? "", lines: [] }
    } else if (current) {
      current.lines.push(line)
    }
  }
  flush()
  cachedSections = sections
  return sections
}

export type ReferenceAnswer =
  | { sections: { id: string; title: string }[]; section: string; text: string }
  | { error: { code: "unknown_section"; message: string; status: number } }

/** One section of the reference; without `section`, the list of sections and the overview. */
export function readReference(section: string | undefined): ReferenceAnswer {
  const all = referenceSections()
  const index = all.map((s) => ({ id: s.id, title: s.title }))
  const wanted = section?.trim() || "overview"
  const found = all.find((s) => s.id === wanted)
  if (!found) {
    return {
      error: {
        code: "unknown_section",
        message: `No reference section "${wanted}". Sections: ${index.map((s) => s.id).join(", ")}.`,
        status: 404,
      },
    }
  }
  return { sections: index, section: found.id, text: found.text.slice(0, AUTHORING_TEXT_LIMIT) }
}

/** An operation as a page shows it: whole, or (too large for any page) without its body. */
export type PagedOperation =
  | Adapter["operations"][number]
  | {
      name: string
      kind: string
      method: string
      path: string
      role?: string
      description: string
      /** Too large to show in one reply: params, query, body, items and fields are left out. */
      omitted: true
    }

/** The stand-in of an operation too large to show, and whether one was needed. */
function fitOperation(
  op: Adapter["operations"][number],
  budget: number,
): { op: PagedOperation; omitted: boolean } {
  if (JSON.stringify(op).length <= budget) return { op, omitted: false }
  return {
    op: {
      name: op.name,
      kind: op.kind,
      method: op.method,
      path: op.path,
      ...(op.role ? { role: op.role } : {}),
      description: op.description,
      omitted: true,
    },
    omitted: true,
  }
}

/**
 * Split operations into pages whose JSON stays under the limit. An operation
 * that alone would pass it is shown without its body (`omitted: true`), so a
 * page never does.
 */
function operationPages(
  adapter: Adapter,
  limit: number,
): { pages: PagedOperation[][]; omitted: string[] } {
  const base = JSON.stringify({ ...adapter, operations: [] }).length
  const budget = Math.max(1_000, limit - base)
  const pages: PagedOperation[][] = []
  const omitted: string[] = []
  let page: PagedOperation[] = []
  let size = base
  for (const original of adapter.operations) {
    const fitted = fitOperation(original, budget)
    if (fitted.omitted) omitted.push(original.name)
    const opSize = JSON.stringify(fitted.op).length + 1
    if (page.length > 0 && size + opSize > limit) {
      pages.push(page)
      page = []
      size = base
    }
    page.push(fitted.op)
    size += opSize
  }
  if (page.length > 0 || pages.length === 0) pages.push(page)
  return { pages, omitted }
}

export type StoredAdapterAnswer =
  | {
      identifier: string
      status: string
      updatedAt: string
      bytes: number
      truncated: boolean
      adapter: Adapter | (Omit<Adapter, "operations"> & { operations: PagedOperation[] })
      operationsTotal: number
      /** What the document would be refused for if saved today, or may get wrong. */
      warnings?: string[]
      /** Operations too large to show, listed without their body. */
      omittedOperations?: string[]
      operationsPage?: number
      operationsPages?: number
      note?: string
    }
  | { error: { code: "unknown_connection" | "invalid_params"; message: string; status: number } }

/**
 * The stored document of `identifier`. Over AUTHORING_TEXT_LIMIT characters,
 * the document comes with one page of its operations (`operationsPage`,
 * 1-based) and says how many pages there are; a save must still carry every
 * operation the connection keeps.
 */
export async function readStoredAdapter(
  conn: ApiConn,
  identifier: string,
  operationsPage = 1,
): Promise<StoredAdapterAnswer> {
  const row = await getAdapterRow(conn, identifier)
  if (!row) {
    return {
      error: {
        code: "unknown_connection",
        message: `No API connection named "${identifier}".`,
        status: 404,
      },
    }
  }
  const status = (await credentialStatuses(conn)).get(identifier) ?? "needs_credentials"
  const text = JSON.stringify(row.adapter)
  const common = {
    identifier,
    status,
    updatedAt: row.updatedAt,
    bytes: Buffer.byteLength(text, "utf8"),
    operationsTotal: row.adapter.operations.length,
    ...(row.warnings.length > 0 ? { warnings: row.warnings } : {}),
  }
  if (text.length <= AUTHORING_TEXT_LIMIT) {
    return { ...common, truncated: false, adapter: row.adapter }
  }
  const { pages, omitted } = operationPages(row.adapter, AUTHORING_TEXT_LIMIT - 2_000)
  if (!Number.isInteger(operationsPage) || operationsPage < 1 || operationsPage > pages.length) {
    return {
      error: {
        code: "invalid_params",
        message: `operationsPage must be between 1 and ${pages.length}.`,
        status: 400,
      },
    }
  }
  return {
    ...common,
    truncated: true,
    adapter: { ...row.adapter, operations: pages[operationsPage - 1] ?? [] },
    operationsPage,
    ...(omitted.length > 0 ? { omittedOperations: omitted } : {}),
    operationsPages: pages.length,
    note: `This document is large: its operations come ${pages.length} pages at a time. Read every page before saving; a save must carry every operation the connection keeps.${omitted.length > 0 ? ` These operations are too large to show and come without their params, query, body, items and fields (omitted: true): ${omitted.join(", ")}. A save cannot carry them unchanged: rewriting one means writing it in full, removing one needs allowRemovingOperations.` : ""}`,
  }
}

/** A credential target (`credentialTarget`) in words: origin, auth type, where the secret goes. */
export function describeTarget(target: string | null | undefined): string {
  if (!target) return "(none)"
  try {
    const t = JSON.parse(target) as Record<string, unknown>
    const parts = [String(t.origin ?? ""), String(t.type ?? "")]
    if (typeof t.in === "string" && typeof t.name === "string") parts.push(`${t.in} ${t.name}`)
    if (typeof t.tokenUrl === "string") parts.push(`token ${t.tokenUrl}`)
    return parts.filter((p) => p.length > 0).join(", ")
  } catch {
    return target
  }
}

/** The kept versions of `identifier`, each compared with the current credential target. */
export async function listVersionsWithTargets(
  conn: ApiConn,
  identifier: string,
): Promise<AdapterVersionList> {
  const [row, versions] = await Promise.all([
    getAdapterRow(conn, identifier),
    listAdapterVersions(conn, identifier),
  ])
  const currentTarget = row ? credentialTarget(row.adapter) : null
  return {
    identifier,
    current: row
      ? { adapterVersion: row.adapter.version, target: describeTarget(currentTarget) }
      : null,
    versions: versions.map((v) => ({
      id: v.id,
      adapterVersion: v.adapterVersion,
      name: v.name,
      savedBy: v.savedBy,
      savedByName: v.savedByName,
      savedAt: v.savedAt,
      target: v.credentialTarget ? describeTarget(v.credentialTarget) : null,
      targetDiffers: v.credentialTarget !== currentTarget,
    })),
  }
}
