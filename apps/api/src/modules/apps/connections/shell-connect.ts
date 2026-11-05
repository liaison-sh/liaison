// SPDX-License-Identifier: FSL-1.1-ALv2
//
// CONNECTING AN APP FROM THE DESKTOP OR MOBILE SHELL.
//
// A connect flow started in a browser tab is bound to that browser by a cookie
// (lib/oauth-browser-binding.ts): the unauthenticated provider callback must
// present it, so a colleague who opens a forwarded authorize link cannot land
// their grant on the initiator's connection. The shells cannot carry that
// cookie. Their page is served from the shell's own origin and every API call
// is a cross-site fetch, so a `SameSite=Lax` cookie set on its response is
// never stored (WKWebView blocks it as third party, Chromium's webviews drop it
// on set), and every connect from the shell failed with
// `oauth_browser_mismatch`.
//
// So a shell binds the flow to ITSELF, the way it already signs in
// (modules/auth/desktop-oauth.ts, RFC 8252):
//
//   1. The shell's page mints a PKCE verifier, keeps it, and starts the flow
//      with its S256 challenge, `client=desktop|mobile` and a `state` of its
//      own. No cookie is set.
//   2. The provider's page runs in the SYSTEM browser (the desktop opens it
//      there; iOS runs it in ASWebAuthenticationSession). The callback, still
//      in that browser, completes NOTHING: it parks the provider's code behind
//      a one-time code of ours and answers the handoff page, which sends the
//      browser to `liaison://oauth-complete?code=...&state=...`.
//   3. The shell receives that link, matches the `state` it minted, and
//      redeems the code at `POST /api/connections/oauth-handoff` with its
//      verifier and its own session. Only then is the provider's code
//      exchanged and the connection stored.
//
// The code is single use (claimed by GETDEL before anything is checked, so a
// wrong verifier burns it), short lived, released only against the verifier
// that never left the shell, and only to the same user in the same org that
// started the flow. A forwarded authorize link therefore ends on a handoff
// page whose code nobody who holds the verifier ever sees.
//
// A flow asks for this mode only from a shell's own origin (the app origin
// allowlist, lib/app-origins.ts): a flow a browser tab starts keeps its cookie
// binding.

import { redis } from "~/lib/redis"
import {
  DESKTOP_EXCHANGE_CODE_TTL_SECONDS,
  mintExchangeCode,
  parseAuthorizeClient,
  verifyS256,
} from "~/modules/auth/desktop-oauth"

/**
 * Redis key prefix of a parked callback waiting for its shell, per flow: an app
 * connection (`connect`) or an MCP server sign-in (`mcp`,
 * apps/mcp-manager/oauth-routes.ts). A code parked by one is never redeemed by
 * the other.
 */
export type HandoffKind = "connect" | "mcp"
const HANDOFF_PREFIX: Record<HandoffKind, string> = {
  connect: "oauth:connect-handoff",
  mcp: "oauth:mcp-handoff",
}

/**
 * How long a parked callback waits: the browser asks the user whether to open
 * the app first, the same hop as a desktop sign-in.
 */
export const CONNECT_HANDOFF_TTL_SECONDS = DESKTOP_EXCHANGE_CODE_TTL_SECONDS

/** What a shell-bound flow carries in its OAuth state record. */
export interface ShellConnectFlow {
  codeChallenge: string
  /** The shell's own `state`, echoed on the handoff link for it to match. */
  returnState: string
}

export type ConnectClient =
  | { kind: "browser" }
  | { kind: "shell"; flow: ShellConnectFlow }
  | { kind: "invalid"; message: string }

/**
 * Reads the authorize request's shell parameters. None of them is the browser
 * flow. Any of them makes it a shell flow, held to the sign-in flow's own
 * checks (`client` desktop or mobile, S256, a SHA-256 challenge, a plain
 * `state`), and accepted only from a shell origin.
 */
export function parseConnectClient(
  body: Record<string, unknown> | null | undefined,
  fromShellOrigin: boolean,
): ConnectClient {
  const field = (name: string): string | undefined => {
    const value = body?.[name]
    return typeof value === "string" ? value : undefined
  }
  const present = ["client", "code_challenge", "code_challenge_method"].some(
    (name) => body?.[name] !== undefined,
  )
  if (!present) return { kind: "browser" }
  const parsed = parseAuthorizeClient({
    // A `client` that is not a string is still present: it must not read as absent.
    client: body?.client === undefined ? undefined : (field("client") ?? ""),
    codeChallenge: field("code_challenge"),
    codeChallengeMethod: field("code_challenge_method"),
    state: field("state"),
  })
  if (parsed.kind === "invalid") return parsed
  if (parsed.kind === "web") return { kind: "invalid", message: "Unsupported client" }
  if (!fromShellOrigin) {
    return { kind: "invalid", message: "This connect flow is only available to the Liaison apps" }
  }
  return {
    kind: "shell",
    flow: { codeChallenge: parsed.flow.codeChallenge, returnState: field("state") as string },
  }
}

/** A shell flow read back from a state record, or null for a browser flow. */
export function shellConnectFlowOf(value: unknown): ShellConnectFlow | null {
  if (!value || typeof value !== "object") return null
  const { codeChallenge, returnState } = value as Record<string, unknown>
  if (typeof codeChallenge !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) return null
  if (typeof returnState !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(returnState)) return null
  return { codeChallenge, returnState }
}

/** A callback parked for its shell: everything the grant needs, nothing more. */
export interface ConnectHandoff<R> {
  /** The consumed OAuth state record. */
  record: R
  /** The provider's authorization code, exchanged only at redemption. */
  providerCode: string
  /** What the provider put on the callback besides code and state (Shopify's `shop`). */
  callbackParams: Record<string, string | undefined>
  codeChallenge: string
}

/** Parks a callback and answers the one-time code the handoff link carries. */
export async function parkConnectHandoff<R>(
  handoff: ConnectHandoff<R>,
  kind: HandoffKind = "connect",
): Promise<string> {
  const code = mintExchangeCode()
  await redis.set(
    `${HANDOFF_PREFIX[kind]}:${code}`,
    JSON.stringify(handoff),
    "EX",
    CONNECT_HANDOFF_TTL_SECONDS,
  )
  return code
}

/** The redemption was refused. One answer for every reason, like the sign-in exchange. */
export class ConnectHandoffRefusedError extends Error {
  readonly code = "connect_handoff_refused"
  constructor() {
    super("Invalid or expired code")
    this.name = "ConnectHandoffRefusedError"
  }
}

/**
 * Claims a parked callback for the shell that started it. The GETDEL comes
 * first, so whatever is wrong with the request (a replay, no verifier, the
 * wrong verifier, another user) the code is gone and nothing was released.
 */
export async function claimConnectHandoff<R extends { orgId: string; userId: string }>(
  input: {
    code: unknown
    codeVerifier: unknown
    orgId: string
    userId: string
  },
  kind: HandoffKind = "connect",
): Promise<ConnectHandoff<R>> {
  if (typeof input.code !== "string" || !/^[0-9a-f]{64}$/.test(input.code)) {
    throw new ConnectHandoffRefusedError()
  }
  const raw = await redis.getdel(`${HANDOFF_PREFIX[kind]}:${input.code}`)
  if (!raw) throw new ConnectHandoffRefusedError()
  let handoff: ConnectHandoff<R>
  try {
    handoff = JSON.parse(raw) as ConnectHandoff<R>
  } catch {
    throw new ConnectHandoffRefusedError()
  }
  if (typeof handoff.codeChallenge !== "string") throw new ConnectHandoffRefusedError()
  if (!verifyS256(input.codeVerifier, handoff.codeChallenge)) throw new ConnectHandoffRefusedError()
  if (handoff.record?.orgId !== input.orgId || handoff.record?.userId !== input.userId) {
    throw new ConnectHandoffRefusedError()
  }
  return handoff
}
