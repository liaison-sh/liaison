// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A fake `ctx` for the app's unit tests: the person's (and the org's) Drive
// accounts, a fake Drive answering `ctx.fetch` by path, and recorders for every
// platform call the app makes (page links, metadata writes, imports, sources).

import type { AppAccount } from "@liaison/app-sdk"
import type { DriveCtx } from "./ctx"

export interface FetchCall {
  url: string
  method: string
  account?: string
  headers: Record<string, string>
  body?: unknown
  convert?: string
}

export type DriveAnswer = { status?: number; body: unknown }

export function account(over: Partial<AppAccount> & { id: string; identifier: string }): AppAccount {
  return {
    ownerType: "user",
    ownerId: "user-1",
    displayName: null,
    status: "active",
    metadata: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    canManage: true,
    ...over,
  }
}

export function fakeCtx(opts: {
  accounts?: AppAccount[]
  /** Answers a Drive call (path after /drive/v3 or /upload/drive/v3, and the query). */
  drive?: (path: string, query: URLSearchParams, call: FetchCall) => DriveAnswer
  config?: Record<string, unknown>
  sources?: Array<Record<string, unknown>>
}) {
  const calls: FetchCall[] = []
  const metadataWrites: Array<{ id: string; patch: Record<string, unknown> }> = []
  const links: Array<{ page: string; params: Record<string, unknown> }> = []
  const imports: Array<Record<string, unknown>> = []
  const sourceOps: Array<Record<string, unknown>> = []
  const rows: Array<{ entity: string; data: Record<string, unknown> }> = []
  const deleted: string[] = []
  const logs: Array<{ level: string; msg: string }> = []
  const accounts = opts.accounts ?? []
  const ctx = {
    userId: "user-1",
    orgId: "org-1",
    accounts: {
      async list(_connection: string, o?: { identifier?: string }) {
        return accounts.filter((a) => !o?.identifier || a.identifier === o.identifier)
      },
      async setMetadata(id: string, patch: Record<string, unknown>) {
        metadataWrites.push({ id, patch })
        const a = accounts.find((x) => x.id === id)
        if (!a) throw new Error("unknown account")
        a.metadata = { ...a.metadata, ...patch }
        return a
      },
    },
    async fetch(url: string, o: Record<string, unknown> = {}) {
      const u = new URL(url)
      const auth = o.auth as { account?: string } | undefined
      const call: FetchCall = {
        url,
        method: String(o.method ?? "GET"),
        headers: (o.headers as Record<string, string>) ?? {},
        ...(auth?.account ? { account: auth.account } : {}),
        ...(o.body !== undefined ? { body: o.body } : {}),
        ...(typeof o.convert === "string" ? { convert: o.convert } : {}),
      }
      calls.push(call)
      const path = u.pathname.replace(/^\/(upload\/)?drive\/v3/, "")
      const answer = opts.drive?.(path, u.searchParams, call) ?? { status: 404, body: { error: { message: "not found" } } }
      return {
        status: answer.status ?? 200,
        headers: {},
        body: typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body),
      }
    },
    pages: {
      async link(page: string, params: Record<string, unknown> = {}) {
        links.push({ page, params })
        return { handle: `lpg_${"a".repeat(43)}`, app: "google-drive", page, expiresInSeconds: 300 }
      },
    },
    config: {
      async get(key: string) {
        return opts.config?.[key] ?? null
      },
    },
    db: {
      async insert(entity: string, data: Record<string, unknown>) {
        rows.push({ entity, data })
        return { id: `row-${rows.length}` }
      },
      async delete(_entity: string, id: string) {
        deleted.push(id)
      },
    },
    async files_importFromUrl(argsJson: string) {
      const args = JSON.parse(argsJson) as Record<string, unknown>
      imports.push(args)
      return JSON.stringify({ id: "file-1", filename: args.filename, mimeType: args.mimeType, sizeBytes: 3 })
    },
    async knowledge_appSource(paramsJson: string) {
      const p = JSON.parse(paramsJson) as Record<string, unknown>
      sourceOps.push(p)
      if (p.op === "list") return JSON.stringify(opts.sources ?? [])
      return JSON.stringify(null)
    },
    async knowledge_appSourceWrite(paramsJson: string) {
      const p = JSON.parse(paramsJson) as Record<string, unknown>
      sourceOps.push(p)
      if (p.op === "ensure") return JSON.stringify({ id: "source-1", kind: p.kind, ref: p.ref })
      return JSON.stringify({ ok: true })
    },
    logger: {
      info: (msg: string) => logs.push({ level: "info", msg }),
      warn: (msg: string) => logs.push({ level: "warn", msg }),
      error: (msg: string) => logs.push({ level: "error", msg }),
      debug: () => {},
    },
  }
  return {
    ctx: ctx as unknown as DriveCtx,
    calls,
    metadataWrites,
    links,
    imports,
    sourceOps,
    rows,
    deleted,
    logs,
  }
}
