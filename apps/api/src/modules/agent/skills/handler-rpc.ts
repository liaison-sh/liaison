// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shared RPC helpers for the Skills + Routines routes — both surfaces are
// thin wrappers over the gated tool handlers in `~/modules/agent/tools`, and the
// per-request `AppContext` shape they need is identical. Routes import these
// helpers instead of redeclaring the same trio per file (skills, routines).

import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import type { AppEnv } from "~/app"
import { rootLogger } from "~/lib/logger"
import { extractRlsContext } from "~/lib/request-rls"
import type { AppContext } from "~/modules/apps/context"

const log = rootLogger.child({ module: "agent-handler-rpc" })

/** Minimal `AppContext` for invoking gated tool handlers from a REST request.
 *  The handlers only touch userId/orgId/scopes/actorType/approverUserId — the
 *  remaining slots are no-op stubs so the structural type is satisfied.
 *
 *  `approverUserId` stays NULL here. It does not mean "who is acting", it means
 *  "this execution carries a DECIDED approval" — the handlers read it exactly
 *  that way (`handleCreateSkill`'s org-visibility gate, `loadEditableSkill`'s
 *  org-skill edit gate). The direct REST surface has no approval round-trip at
 *  all, so stamping the caller into it forged an approval on every request and
 *  made those gates unreachable. Ownership is unaffected: every handler falls
 *  back to `ctx.userId`, which is the same person. */
export function buildAppContext(c: Context<AppEnv>): AppContext & { scopes: string[] } {
  const rls = extractRlsContext(c)
  return {
    userId: rls.userId,
    orgId: rls.orgId,
    scopes: rls.scopes,
    actorType: "user",
    approverUserId: null,
    db: undefined as unknown as AppContext["db"],
    emit: async () => {},
    enqueueJob: async () => {},
    resolveContact: async () => undefined,
    logger: log,
  }
}

export type HandlerResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string }

/** Discriminate handler outputs that carry an `error` envelope (gated-tool
 *  contract) from successful returns. */
export function handlerResult<T = unknown>(result: unknown): HandlerResult<T> {
  if (result && typeof result === "object" && "error" in (result as Record<string, unknown>)) {
    const err = (result as { error: { code: string; message: string } }).error
    return { ok: false, code: err.code, message: err.message }
  }
  return { ok: true, data: result as T }
}

/** Map the well-known handler error codes to HTTP statuses. Codes that aren't
 *  listed fall through to 400 — same default both routes used previously.
 *  Returns a Hono `ContentfulStatusCode` so the result can be passed straight
 *  to `new HTTPException(...)` without a cast. */
export function errToStatus(code: string): ContentfulStatusCode {
  switch (code) {
    case "forbidden":
    case "scope_escalation":
    case "flow_scope_missing":
      return 403
    case "skill_not_found":
    case "routine_not_found":
    case "app_not_enabled":
    case "template_not_found":
      return 404
    case "name_conflict":
    case "already_enabled":
    case "routine_not_runnable":
    case "app_run_routine":
      return 409
    case "unknown_field":
      return 422
    default:
      return 400
  }
}
