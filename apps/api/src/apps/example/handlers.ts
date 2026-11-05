// SPDX-License-Identifier: FSL-1.1-ALv2
// Reference app — demonstrates every Liaison SDK surface in the smallest
// possible code. Each handler is a teaching artifact; see README.md for what
// each one demonstrates.
//
// Handlers receive `(params, ctx)` where `ctx` is the real `AppContext` from
// `@liaison/app-sdk` — the exact contract a sandboxed app runs against. Each
// tool in app.manifest.json maps to a named export here by its `handler` string.
import { type AppContext, defineHandlers } from "@liaison/app-sdk"

interface Item {
  id: string
  text: string
  orgId: string
}

/** SDK surface: ctx.db — list persisted items. */
export async function items_list(
  _params: Record<string, unknown>,
  ctx: AppContext,
): Promise<{ data: Item[] }> {
  const rows = await ctx.db.findMany("items", { where: { orgId: ctx.orgId } })
  return { data: rows as Item[] }
}

/** SDK surface: ctx.db + ctx.emit — persist an item and emit a domain event. */
export async function items_create(
  params: { text: string },
  ctx: AppContext,
): Promise<{ id: string }> {
  const { id } = await ctx.db.insert("items", { text: params.text, orgId: ctx.orgId })
  await ctx.emit({ entity: "item", action: "created", entityId: id, data: { text: params.text } })
  return { id }
}

/** SDK surface: ctx.connections + ctx.fetch — call an external API with a token. */
export async function external_fetch(
  _params: Record<string, unknown>,
  ctx: AppContext,
): Promise<{ ok: boolean; status: number }> {
  const token = await ctx.connections.exampleApi?.getToken()
  const res = await ctx.fetch("https://api.example.com/ping", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
  return { ok: res.status >= 200 && res.status < 300, status: res.status }
}

/** SDK surface: ctx.resolveContact — resolve or create a contact by email. */
export async function resolve_contact(
  params: { email: string },
  ctx: AppContext,
): Promise<{ contact: unknown }> {
  const contact = await ctx.resolveContact({ email: params.email })
  return { contact }
}

/**
 * SDK surface: scheduled job — declared in the manifest with a cron schedule.
 * Counts items, records a summary, emits a `summary:computed` event, and uses
 * the structured logger.
 */
export async function nightly_summary(
  _params: Record<string, unknown>,
  ctx: AppContext,
): Promise<{ itemCount: number }> {
  const items = await ctx.db.findMany("items", { where: { orgId: ctx.orgId } })
  const itemCount = items.length
  await ctx.db.insert("summaries", { orgId: ctx.orgId, itemCount, computedAt: new Date() })
  await ctx.emit({ entity: "summary", action: "computed", data: { itemCount } })
  ctx.logger.info("nightly summary computed", { itemCount })
  return { itemCount }
}

/** Handler bundle keyed by the manifest's `handler` strings. */
export const handlers = defineHandlers({
  items_list,
  items_create,
  external_fetch,
  resolve_contact,
  nightly_summary,
})
