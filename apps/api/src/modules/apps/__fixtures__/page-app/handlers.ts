// SPDX-License-Identifier: FSL-1.1-ALv2
// Handlers of the `pagefx` fixture (descriptor.ts). Import-free: the sandbox
// evaluates this file alone, as a script: the handlers are globals.

interface Ctx {
  getUserId(): string | Promise<string>
  pages: { link(page: string, params?: Record<string, unknown>): Promise<{ handle: string }> }
  store: {
    get(c: string, id: string): Promise<{ data: Record<string, unknown> } | null>
    set(c: string, id: string, data: Record<string, unknown>): Promise<unknown>
  }
}

async function pageLink(p: { tag?: string }, ctx: Ctx) {
  return ctx.pages.link("hello", { tag: p.tag ?? "none" })
}

async function pickerLink(p: { account?: string }, ctx: Ctx) {
  return ctx.pages.link("picker", { account: p.account ?? "" })
}

/** The page's route: answers with what it was given and who it ran as, and records it. */
async function greetRoute(
  p: { body: { name?: string } | null; params: Record<string, unknown>; page: string },
  ctx: Ctx,
) {
  const name = typeof p.body?.name === "string" ? p.body.name : "nobody"
  const by = await ctx.getUserId()
  await ctx.store.set("greetings", "last", { name, by })
  return { greeting: `Hello ${name}`, params: p.params, page: p.page, by }
}

/** Provisioning: the setup lives in the app's own store; reports what differs. */
async function provision(
  p: { config: { greeting: string; folders?: string[] }; dryRun: boolean },
  ctx: Ctx,
) {
  const stored = (await ctx.store.get("setup", "current"))?.data ?? {}
  const changed: string[] = []
  if (stored.greeting !== p.config.greeting) changed.push("greeting")
  const folders = p.config.folders ?? []
  if (JSON.stringify(stored.folders ?? []) !== JSON.stringify(folders)) changed.push("folders")
  if (!p.dryRun && changed.length > 0) {
    await ctx.store.set("setup", "current", { greeting: p.config.greeting, folders })
  }
  return { changed }
}

async function verifySetup(p: { config: { greeting: string } }, ctx: Ctx) {
  const stored = (await ctx.store.get("setup", "current"))?.data ?? {}
  return stored.greeting === p.config.greeting
    ? { ok: true, identity: `greeting: ${p.config.greeting}` }
    : { ok: false, problems: ["the stored greeting differs"] }
}

Object.assign(globalThis, { pageLink, greetRoute, provision, verifySetup })
