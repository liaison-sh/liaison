// SPDX-License-Identifier: FSL-1.1-ALv2

/**
 * A permission denial that names the exact missing scope and tells the actor it
 * is requestable. Thrown by `requireScope` (and the scope-request decide path)
 * instead of a bare `HTTPException(403, "Forbidden")` so the error handler can
 * serialize `{ code: "PERMISSION_DENIED", details: { missingScope, requestable } }`.
 *
 * This is a plain `Error` subclass (NOT an `HTTPException`) so the error
 * handler's second branch (`typeof status === "number" && typeof code === "string"`)
 * serializes its `message`/`code`/`details`.
 */
export class PermissionDeniedError extends Error {
  readonly status = 403
  readonly code = "PERMISSION_DENIED"
  readonly details: { missingScope?: string; requestable: boolean }

  constructor(opts: { missingScope?: string; message?: string }) {
    super(
      opts.message ??
        (opts.missingScope
          ? `Permission denied: this action needs the "${opts.missingScope}" scope, which you do not have. Ask an admin to grant it.`
          : "Permission denied: you do not have access to this action."),
    )
    this.name = "PermissionDeniedError"
    // `requestable` is only meaningful when a specific scope is named — the
    // default-deny path (no missingScope) has nothing concrete to request.
    this.details = {
      ...(opts.missingScope ? { missingScope: opts.missingScope } : {}),
      requestable: opts.missingScope !== undefined,
    }
  }
}
