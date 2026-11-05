// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Why a mail server refused an IMAP (or SMTP) sign-in, as a closed set of codes.
 * The server's own words are only read to pick the code; what the person sees
 * is the code's fixed sentence (`mail.imapLogin.<code>`), with the one next
 * step to take. The account's sync error stores `IMAP authentication failed:
 * <code>` (or `IMAP too many connections`), so the settings, the agent and the
 * retry logic all read the same thing.
 */
export const IMAP_LOGIN_FAILURES = [
  /** The address or password is wrong. */
  "wrong_password",
  /** Gmail: the account has 2-Step Verification; it needs an app password, not the Google password. */
  "app_password_required",
  /** IMAP access is turned off for the mailbox. */
  "imap_disabled",
  /** The provider held the sign-in back until it is confirmed in a browser (Gmail's WEBALERT). */
  "web_login_required",
  /** Too many connections to the mailbox at once: passes on its own. */
  "too_many_connections",
] as const

export type ImapLoginFailure = (typeof IMAP_LOGIN_FAILURES)[number]

/** The sync-error prefix a refused sign-in is stored under. */
export const IMAP_AUTH_FAILED_PREFIX = "IMAP authentication failed"

/**
 * How much of a server's response text is read to classify it. Refusals say
 * why in their first sentence; the rest of a long response is never read, so
 * a server cannot make the classification slow.
 */
const MAX_CLASSIFIED_CHARS = 2048

/**
 * The code of a server's refusal, from its response text (and ImapFlow's
 * server response code). Null when the text is not a sign-in refusal.
 */
export function imapLoginFailure(
  text: string | null | undefined,
  responseCode?: string | null,
): ImapLoginFailure | null {
  const t = String(text ?? "").slice(0, MAX_CLASSIFIED_CHARS)
  if (
    /too many (simultaneous )?connections|maximum number of connections|connection limit/i.test(t)
  ) {
    return "too_many_connections"
  }
  if (/application-specific password|app(lication)? password required/i.test(t)) {
    return "app_password_required"
  }
  if (
    /not enabled for IMAP|IMAP (access )?is disabled|IMAP access disabled|enable [^\n]{0,80}IMAP/i.test(
      t,
    )
  ) {
    return "imap_disabled"
  }
  if (
    /WEBALERT|log ?in via your web browser|web login required|sign in via your web browser/i.test(t)
  ) {
    return "web_login_required"
  }
  if (
    responseCode === "AUTHENTICATIONFAILED" ||
    /AUTHENTICATIONFAILED|invalid credentials|authentication failed|login failed|LOGIN failed|incorrect password|username and password not accepted/i.test(
      t,
    )
  ) {
    return "wrong_password"
  }
  return null
}

/** The code inside a stored sync error, if it names one. */
export function imapLoginFailureFromError(
  message: string | null | undefined,
): ImapLoginFailure | null {
  const m = String(message ?? "")
  if (/^IMAP too many connections/.test(m)) return "too_many_connections"
  const match = /^IMAP authentication failed(?:: ([a-z_]+))?/.exec(m)
  if (!match) return null
  const code = match[1] as ImapLoginFailure | undefined
  return code && (IMAP_LOGIN_FAILURES as readonly string[]).includes(code) ? code : "wrong_password"
}

/**
 * What an IMAP mailbox keeps in step with its server, from the capabilities
 * its sync recorded (`sync_state.capabilities`), for the mailbox settings and
 * the agent. Null until the first sync has read them.
 */
export interface ImapSyncSummary {
  /** Read and star changes made in Liaison reach the server. */
  readAndStar: boolean
  /** Archive reaches the server (Gmail, or a server with an Archive folder). */
  archive: boolean
  /** Trash reaches the server (it has a Trash folder). */
  trash: boolean
  /** Mail in the Sent folder is imported into the conversations. */
  sent: boolean
  /**
   * Archive done in another mail app is seen here. False when the INBOX is too
   * large for the sync to track its membership (IMAP_MEMBERSHIP_MAX_UIDS).
   */
  archiveReadBack: boolean
  /** New mail is fetched every few minutes (IMAP IDLE push is not used). */
  pollMinutes: number
}

export function imapSyncSummary(
  capabilities: unknown,
  syncState?: { inboxTracked?: unknown } | null,
): ImapSyncSummary | null {
  if (!capabilities || typeof capabilities !== "object") return null
  const c = capabilities as { gmail?: unknown; folders?: Record<string, unknown> }
  const folders = c.folders ?? {}
  const has = (key: string) => typeof folders[key] === "string" && folders[key] !== ""
  return {
    readAndStar: true,
    archive: (c.gmail === true && has("all")) || has("archive"),
    trash: has("trash"),
    sent: has("sent"),
    archiveReadBack: syncState?.inboxTracked !== false,
    pollMinutes: 2,
  }
}
