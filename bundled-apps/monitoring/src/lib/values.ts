// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Small value helpers shared by the tool, comment and webhook handlers.
import type { AppContext } from "@liaison/app-sdk"

/** A timestamp column as an ISO string (the bridge may hand back a Date or a string). */
export function toIsoOrNull(v: unknown): string | null {
  if (v == null) return null
  if (v instanceof Date) return v.toISOString()
  return String(v)
}

export function strOrNull(v: unknown): string | null {
  return v == null ? null : String(v)
}

/**
 * A log-safe summary of an error: its first line, at most 200 characters. A failed bridge
 * write rethrows the driver's "Failed query: ...\nparams: ..." text, and the params carry
 * row content (an alert body, a resolution note), which must not be copied into the logs.
 */
export function errSummary(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return (text.split("\n")[0] ?? "").slice(0, 200)
}

/** Postgres refuses U+0000 in text: strip it from free text before it is stored. */
export function stripNul(s: string): string {
  return s.split("\u0000").join("")
}

/**
 * The acting user's id when it can be stored in a `uuid` user column, else null (shown as
 * "System"). The pattern is the one the bridge applies to a `uuid` field (lowercase only), so
 * an id accepted here is never refused at write; a system actor or an uppercase uuid is null.
 * For an agent this is the user it acts for (the SDK exposes no actor type).
 */
export function actorUserId(userId: unknown): string | null {
  return typeof userId === "string" && /^[0-9a-f-]{36}$/.test(userId) ? userId : null
}

/**
 * The acting user's id as the sandbox exposes it. `AppContext.userId` is declared on the SDK
 * type but is NOT populated inside the QuickJS sandbox (the bridge exposes `getUserId()`
 * instead), so reading the field there yields undefined and every author/actor column stays
 * null. Prefer the bridge accessor, fall back to the field for a host-side context, then apply
 * the `actorUserId` guard.
 */
export async function resolveActorUserId(ctx: AppContext): Promise<string | null> {
  const bridged = (ctx as unknown as { getUserId?: () => Promise<unknown> | unknown }).getUserId
  const id = typeof bridged === "function" ? await bridged.call(ctx) : ctx.userId
  return actorUserId(id)
}
