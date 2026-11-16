// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A quoted signing link is cut at the door. When an outside signer presses
// Reply on a link mail, their reply quotes the link, token and all; stored as
// is, the sender's synced mailbox (or the ticket the reply lands on) would hold
// a live link any agent with mail or ticket read could open. Every inbound text
// that is stored (a synced mail page, a ticket from outside, a portal reply)
// passes `cutSigningLinks` first, so `/a#t=<token>` never reaches a row.
//
// The rule matches the page's path and fragment however a mail client wrote
// it: plain, as an HTML attribute or entity (`&#35;`), percent-encoded once or
// twice (a link-protection wrapper's `url=` parameter), any case. The URL in
// front of it, when there is one, goes with it.

export const SIGNING_LINK_REMOVED = "[signing link removed]"

const SLASH = "(?:/|%(?:25)?2f|&#0*47;|&#x0*2f;|&sol;)"
const HASH = "(?:#|%(?:25)?23|&#0*35;|&#x0*23;|&num;)"
const EQUALS = "(?:=|%(?:25)?3d|&#0*61;|&#x0*3d;|&equals;)"
/** A token as minted (base64url), never across a separator. */
const TOKEN = "[A-Za-z0-9_-]+"
/** The scheme and host in front of the path, plain or percent-encoded, when present. */
const PREFIX = String.raw`(?:https?(?::|%(?:25)?3a)(?:/|%(?:25)?2f){2}[^\s"'<>()\[\]]*?)?`

const LINK = new RegExp(`${PREFIX}${SLASH}a${HASH}t${EQUALS}${TOKEN}`, "gi")

/** `text` with every signing link replaced by `[signing link removed]`. */
export function cutSigningLinks(text: string): string
export function cutSigningLinks(text: string | null): string | null
export function cutSigningLinks(text: string | undefined): string | undefined
export function cutSigningLinks(text: string | null | undefined): string | null | undefined
export function cutSigningLinks(text: string | null | undefined): string | null | undefined {
  if (!text) return text
  return text.replace(LINK, SIGNING_LINK_REMOVED)
}
