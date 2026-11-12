// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shared ctx interface types for the ads bundled app.
// Extracted here to avoid duplicating the same shape across pause.ts and
// handlers/shopify-inventory-low.ts.

export interface AppDb {
  insert(entity: string, data: Record<string, unknown>): Promise<{ id: string }>
  findMany(
    entity: string,
    opts?: {
      where?: Record<string, unknown>
      orderBy?: Record<string, "asc" | "desc">
      limit?: number
      offset?: number
    },
  ): Promise<unknown[]>
  findOne(entity: string, id: string): Promise<unknown | null>
  update(entity: string, id: string, data: Record<string, unknown>): Promise<void>
  delete(entity: string, id: string): Promise<void>
  count(entity: string, opts?: { where?: Record<string, unknown> }): Promise<number>
}

export interface AppCtx {
  fetch: (url: string, opts?: Record<string, unknown>) => Promise<unknown>
  connections: unknown
  db?: AppDb
  emit?: (event: string, payload: Record<string, unknown>) => void | Promise<void>
  actorId?: string
}
