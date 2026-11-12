// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `ctx.pages.link(page, params)`: a handle to one of the app's own pages
 * (manifest `pages`, modules/apps/app-pages.ts) for the person the run acts for,
 * e.g. a tool that answers with "choose your files here". A handle, not a URL:
 * only that person's signed-in app opens it, so the app's code cannot use it as
 * the person. Refused in a run that acts for no person (a job, a webhook): a
 * page always belongs to one person.
 */
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import { typedError } from "~/modules/apps/sandbox/bridge/secret-free"

export function createPagesMethods(ctx: BridgeContext) {
  return {
    pages_link: async (page: unknown, params?: unknown) => {
      if (typeof page !== "string" || page.length === 0) {
        throw typedError(400, "invalid_page", "ctx.pages.link: a page name is required")
      }
      if (ctx.actorType !== "user" || !ctx.userId || ctx.userId.startsWith("system")) {
        throw typedError(
          403,
          "no_person",
          "ctx.pages.link: this run acts for no person; a page link is minted for one",
        )
      }
      // The ctx shim sends an object argument as JSON text (ctx-shim.ts).
      let decoded: unknown = params
      if (typeof params === "string") {
        try {
          decoded = JSON.parse(params)
        } catch {
          throw typedError(400, "invalid_params", "ctx.pages.link: params are not JSON")
        }
      }
      const { createAppPageHandle, AppPageError } = await import("~/modules/apps/app-pages")
      try {
        return await createAppPageHandle({
          orgId: ctx.orgId,
          userId: ctx.userId,
          app: ctx.appName,
          page,
          params: decoded,
        })
      } catch (err) {
        if (err instanceof AppPageError) throw typedError(err.status, err.code, err.message)
        throw err
      }
    },
  }
}
