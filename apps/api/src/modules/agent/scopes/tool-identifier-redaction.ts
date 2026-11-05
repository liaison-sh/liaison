// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P3b-FX2: keep machine names out of what one agent relays to a person.
//
// An agent's own system prompt may name a tool, and a weak model repeats what
// its prompt says: a decline relayed through a second agent reached a person as
// "does not have the ledger__invoice_total tool available". The callee's own
// speech is prompt discipline (the charter tells it never to name one); this is
// the belt on the RELAY, applied to every string `agents_ask` hands back (the
// answer, the refusal reason and the pending note) and to the answer the callee
// PERSISTS in a coordination exchange, which a person reads when the nested
// exchange is expanded.
//
// The scrub is driven by the registry the tool projection itself builds, in the
// projection's own name form, and by nothing else. A pattern over arbitrary
// text would eat any word carrying a double underscore (a column name, a
// snake_case variable a person actually wants to read), and what counts as a
// tool identifier is a fact the registry holds, never a guess about a string.
// The registry holds the kernel's own tools under the app name `kernel`, so
// `kernel__agents_ask` is on the list for the same reason `ledger__invoice_total`
// is: one walk, one name form, no second source.

import { sdkToolName } from "~/modules/agent/tools/tool-bridge"
import { toolRegistry } from "~/modules/apps/app-registries"

/** What a tool identifier becomes on its way to a person. */
export const REDACTED_TOOL_PHRASE = "a tool"

/** Every tool identifier registered for this org, as the projection names it. */
export function registeredToolIdentifiers(orgId: string): string[] {
  const names: string[] = []
  for (const [key] of toolRegistry.entriesOf(orgId)) {
    names.push(sdkToolName(key[1], key[2]))
  }
  return names
}

function escapeForPattern(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Replace every registered tool identifier in `text` with the phrase, the
 * backticks a model likes to wrap one in included. Longest name first, so a
 * registered name that is a prefix of another cannot shadow it.
 */
export function redactToolIdentifiers(text: string, orgId: string): string
export function redactToolIdentifiers(text: string | null, orgId: string): string | null
export function redactToolIdentifiers(
  text: string | null | undefined,
  orgId: string,
): string | null | undefined
export function redactToolIdentifiers(
  text: string | null | undefined,
  orgId: string,
): string | null | undefined {
  if (!text) return text
  let out: string = text
  const names = registeredToolIdentifiers(orgId).sort((a, b) => b.length - a.length)
  for (const name of names) {
    out = out.replace(new RegExp(`\`?${escapeForPattern(name)}\`?`, "gi"), REDACTED_TOOL_PHRASE)
  }
  return out
}

/** The strings an ask result carries; every other field rides through as it is. */
export interface AskResultText {
  answer?: string | null
  reason?: string
  note?: string
}

/**
 * Every piece of TEXT an `agents_ask` result hands back, scrubbed.
 *
 * The answer was the observed leak, but the answer is not the only string the
 * model reads: a refusal `reason` and a pending `note` reach it on exactly the
 * same path and through it reach a person, so all three go through the one name
 * list. Keys the result does not carry are not invented, so a result with no
 * text at all comes back byte identical.
 */
export function redactAgentsAskResult<T extends object>(result: T, orgId: string): T {
  const out = { ...result } as AskResultText
  if ("answer" in out) out.answer = redactToolIdentifiers(out.answer, orgId)
  if (typeof out.reason === "string") out.reason = redactToolIdentifiers(out.reason, orgId)
  if (typeof out.note === "string") out.note = redactToolIdentifiers(out.note, orgId)
  return out as T
}
