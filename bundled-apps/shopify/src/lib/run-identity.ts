// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The run's organization and acting user. In the sandbox the context carries
// them as getters, not as the `orgId` / `userId` fields a test context sets:
// `ctx.getOrgId()` / `ctx.getUserId()` answer at once on QuickJS and as a
// promise (a bridge call) on the Workers executor. Read all three shapes, so a
// handler never writes an `undefined` org or user id.
import type { AppContext } from "@liaison/app-sdk"

type IdentityCtx = {
  orgId?: unknown
  userId?: unknown
  getOrgId?: () => unknown
  getUserId?: () => unknown
}

async function pick(field: unknown, getter: (() => unknown) | undefined): Promise<string> {
  if (typeof field === "string" && field.length > 0) return field
  const v = typeof getter === "function" ? await getter() : undefined
  return typeof v === "string" ? v : ""
}

/** The organization the run belongs to ("" when the context names none). */
export function runOrgId(ctx: AppContext): Promise<string> {
  const c = ctx as unknown as IdentityCtx
  return pick(c.orgId, c.getOrgId)
}

/** The user the run acts for ("" when the context names none). */
export function runUserId(ctx: AppContext): Promise<string> {
  const c = ctx as unknown as IdentityCtx
  return pick(c.userId, c.getUserId)
}
