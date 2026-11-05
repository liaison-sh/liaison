// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shared, precise tool/handler context shape. Mirrors boxtal's `src/ctx.ts`:
// `db` is the generic CRUD bridge (`DbClient`); `fetch` is the host fetch shaped
// like `PennylaneFetch`; `connections` is the dual-shape credentials accessor
// (resolved in `lib/get-client.ts`); `logger` is the optional structured logger.
// The `__client` field is a TEST-ONLY injection seam — production never sets it,
// so reads resolve the live client via `getClient(ctx)`.

import type { DbClient } from "@liaison/app-sdk"
import type { PennylaneClient, PennylaneFetch } from "./lib/pennylane-client"

export interface PennylaneLogger {
  info?(msg: string, data?: unknown): void
  warn?(msg: string, data?: unknown): void
  error?(msg: string, data?: unknown): void
  debug?(msg: string, data?: unknown): void
}

/** A minimal client surface the reads consume — `list` + `get`. */
export interface PennylaneClientLike {
  list<T>(
    path: string,
    q?: { cursor?: string; limit?: number; filter?: unknown[]; params?: Record<string, string> },
  ): Promise<{ items: T[]; next_cursor: string | null; has_more: boolean }>
  get<T>(path: string): Promise<T>
}

/**
 * The context every Pennylane tool handler receives. `db` is the generic CRUD
 * bridge (`DbClient`); `fetch` is the host fetch shaped like `PennylaneFetch`;
 * `connections` is the dual-shape credentials accessor (resolved in
 * `get-client.ts`).
 */
export interface PennylaneToolCtx {
  orgId: string
  db: DbClient
  fetch: PennylaneFetch
  connections: unknown
  logger?: PennylaneLogger
  /**
   * Host-side download onto a file parent (`credentials: "first-hop-only"` for a received
   * invoice's file); the reception ops use it, reads never do.
   */
  files_importFromUrl?(argsJson: string): Promise<string>
  /** TEST-ONLY: a pre-built client injected by unit tests; absent in production. */
  __client?: PennylaneClientLike | PennylaneClient
}
