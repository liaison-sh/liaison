// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Whether this server can ask for a signature, said before anyone prepares a document: a
// server with signatures off refuses every send for signature, and a person should learn it
// on the first screen, not after the work. Read once per page load from the kernel.
import { fetch as hostFetch } from "@liaison/host"
import { type Component, createResource, Show } from "solid-js"
import { tr } from "./i18n"

export type SigningState =
  | { available: true }
  | { available: false; reason: "not_offered" | "no_timestamp" | "demo" | string }

let cached: Promise<SigningState> | null = null

/** The server's answer; an unreadable answer reads as available (the send still refuses). */
export function loadSigningState(): Promise<SigningState> {
  cached ??= hostFetch<SigningState>("/api/client-actions/signing").then(
    (s) => (s && typeof s.available === "boolean" ? s : { available: true }),
    () => ({ available: true }) as SigningState,
  )
  return cached
}

/** For tests: forget the answer read before. */
export function resetSigningState(): void {
  cached = null
}

/** The words for a server where signatures are off, or null when they are on. */
export function signingOffText(state: SigningState | undefined): string | null {
  if (!state || state.available) return null
  // A demo's visitor runs no server: the demo says what it does instead.
  if (state.reason === "demo")
    return tr(
      "In this demo, nothing is sent for signature: a client's approval you see is a stand-in, and nothing is sealed. You can still write and prepare documents.",
    )
  return state.reason === "not_offered"
    ? tr(
        "Signatures are not offered on this hosted service, so nothing can be sent for signature. You can still write and prepare documents.",
      )
    : tr(
        "Signatures are off on this server: it has no timestamp service to date them, so nothing can be sent for signature. Ask whoever runs this server to turn them on. You can still write and prepare documents.",
      )
}

/** A calm line at the top of a screen, shown only when signatures are off. */
export const SigningOff: Component = () => {
  const [state] = createResource(loadSigningState)
  return (
    <Show when={signingOffText(state())}>
      {(text) => (
        <p
          data-testid="agreements-signing-off"
          class="border-b border-border-subtle bg-surface-raised px-5 py-2 text-[12.5px] text-text-secondary"
        >
          {text()}
        </p>
      )}
    </Show>
  )
}
