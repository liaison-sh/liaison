// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE REMOTE `liaison` COMMAND-LINE CLIENT (`@liaison/cli`) AND WHAT ITS
// SIGN-IN MAY CARRY.
//
// The remote CLI signs in through the login device flow under the client id
// `liaison-cli`: a person approves the code in their browser, and the CLI gets
// a restricted session capped to the scopes it declared (session-ceiling.ts).
// Like the desktop app's id, it is admitted whenever the device flow is on
// (DEVICE_FLOW_CLIENTS non-empty): the id is no credential, a person still
// approves every sign-in, and each deployment would otherwise have to learn a
// new id before its people could use the CLI.
//
// The cap is the server's, not the client's: whatever a `liaison-cli` request
// declares, the session holds at most the person's own scopes and, of those,
//
//  - by default (no scopes declared): app building and app logs, nothing else;
//  - when declared: any read scope (`...:read`), and the opt-in admin scopes
//    below, each shown on the approval page by name. `kernel:apps:admin` is
//    never part of a default sign-in.
//
// Anything else is refused at initiate. What a restricted session does with an
// admin scope is still judged as a program's call: a publish or install parks
// for a person's approval (app-builder/routes.ts, apps/install-routes.ts), a
// gated tool parks (apps/rest-tool-call.ts).

import { HTTPException } from "hono/http-exception"

export const LIAISON_CLI_CLIENT_ID = "liaison-cli"

/** A sign-in that declares nothing: build apps and read their logs. */
export const LIAISON_CLI_DEFAULT_SCOPES = ["kernel:apps:build", "kernel:apps:logs"] as const

/**
 * Scopes a `liaison-cli` sign-in may carry only when it declares them (the
 * person asked for them: `liaison login --admin` / `--config`).
 */
export const LIAISON_CLI_OPT_IN_SCOPES = [
  // Approving the app interface (D2) and the publish card's own decider scope.
  "kernel:apps:admin",
  // The remote `config apply` subset: each change is a gated tool call (a card).
  "kernel:roles:admin",
  "kernel:agents:admin",
  "kernel:skills:write",
  "kernel:routines:write",
] as const

const ALLOWED = new Set<string>([...LIAISON_CLI_DEFAULT_SCOPES, ...LIAISON_CLI_OPT_IN_SCOPES])

/** A read scope: its last segment is `read` (`tickets:read`, `kernel:skills:read`). */
function isReadScope(scope: string): boolean {
  return scope === "read" || scope.endsWith(":read")
}

/**
 * The scopes a `liaison-cli` sign-in is stored with: the default set when none
 * were declared, the declared set when every scope in it is allowed, a 400
 * naming the others otherwise.
 */
export function liaisonCliScopes(declared: readonly string[] | undefined): string[] {
  if (!declared || declared.length === 0) return [...LIAISON_CLI_DEFAULT_SCOPES]
  const refused = declared.filter((s) => !ALLOWED.has(s) && !isReadScope(s))
  if (refused.length > 0) {
    throw new HTTPException(400, {
      message: `The liaison CLI may not ask for ${refused.join(", ")}. It signs in with app building, app logs and read scopes, plus ${LIAISON_CLI_OPT_IN_SCOPES.join(", ")} when asked for.`,
    })
  }
  return [...new Set(declared)]
}
