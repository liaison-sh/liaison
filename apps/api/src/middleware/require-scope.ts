// SPDX-License-Identifier: FSL-1.1-ALv2
import { createMiddleware } from "hono/factory"
import type { AppEnv } from "~/app"
import { PermissionDeniedError } from "~/modules/permissions/errors"
import { hasScope } from "~/modules/permissions/permissions"

type ScopeSpec = string | Record<string, string>

export function requireScope(spec: ScopeSpec) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const scopes = c.get("scopes") as string[]
    const scope = typeof spec === "string" ? spec : (spec[c.req.method] ?? spec["*"])
    if (!scope) {
      // Default-deny: unlisted methods are forbidden when using object form.
      // No specific scope to name, so no `missingScope`.
      throw new PermissionDeniedError({ message: "Permission denied: method not permitted." })
    }
    if (!hasScope(scope, scopes)) {
      throw new PermissionDeniedError({ missingScope: scope })
    }
    await next()
  })
}
