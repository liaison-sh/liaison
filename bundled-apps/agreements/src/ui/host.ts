// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The screens' one way to the server: the app's own tools through the host (the person's
// click, decided by their own scopes), plus two best-effort kernel reads for names.

import { app, fetch as hostFetch, navigate } from "@liaison/host"
import { isRefusal } from "./model"

export type Outcome<T> = { ok: true; data: T } | { ok: false; code: string; message: string }

/** Runs one of this app's tools. A refusal, answered or thrown, comes back as words. */
export async function call<T>(tool: string, args: Record<string, unknown>): Promise<Outcome<T>> {
  try {
    const data = await app.invokeTool<T>(tool, args)
    if (isRefusal(data)) return { ok: false, code: data.error.code, message: data.error.message }
    return { ok: true, data }
  } catch (err) {
    const e = err as { code?: unknown; message?: unknown } | null
    return {
      ok: false,
      code: typeof e?.code === "string" ? e.code : "failed",
      message: typeof e?.message === "string" && e.message !== "" ? e.message : "",
    }
  }
}

export const paths = {
  home: () => "/agreements",
  list: (filter: string) => (filter === "all" ? "/agreements" : `/agreements/list/${filter}`),
  agreement: (id: string) => `/agreements/agreement/${id}`,
  editor: (id: string) => `/agreements/editor/${id}`,
  send: (id: string) => `/agreements/send/${id}`,
  create: () => "/agreements/new",
  /** The kernel's own Read and sign tab for a staff signer's link. */
  sign: (clientActionId: string) => `/sign/${clientActionId}`,
}

export function go(path: string): void {
  navigate(path)
}

interface Named {
  id: string
  name: string
}

function rowsOf(v: unknown): Named[] {
  const list = Array.isArray(v) ? v : (v as { items?: unknown } | null)?.items
  return Array.isArray(list)
    ? (list as Array<Partial<Named>>).flatMap((r) =>
        typeof r?.id === "string" && typeof r?.name === "string"
          ? [{ id: r.id, name: r.name }]
          : [],
      )
    : []
}

/** The organization's people by id; empty for a reader who cannot list them. */
export async function loadMembers(): Promise<Named[]> {
  try {
    return rowsOf(await hostFetch<unknown>("/api/mentions/members?limit=200"))
  } catch {
    return []
  }
}

/** Company names by id; empty for a reader without the companies scope. */
export async function loadCompanyNames(): Promise<Map<string, string>> {
  try {
    const rows = rowsOf(await hostFetch<unknown>("/api/contacts/companies?limit=100"))
    return new Map(rows.map((r) => [r.id, r.name]))
  } catch {
    return new Map()
  }
}
