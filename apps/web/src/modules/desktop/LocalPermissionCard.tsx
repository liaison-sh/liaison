// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P6d-T12: ANSWER THE PROMPT WHERE THE TOOL IS.
//
// The overlay drew this as a sheet floating on the right edge of the window,
// away from the tool it was about, over whatever the page was showing. A
// decision about one tool call belongs inside that tool call, which is exactly
// where this app already answers the same kind of question: ToolCallRow
// renders an ApprovalCard inside the row a blocked tool raised. This is that,
// for a tool running on the user's own machine.
//
// WHAT THE CARD SAYS is deliberately short (T02 verdict on screen 04): a plain
// "Permission needed" label with the runtime glyph, the tool named the way
// every other row names it, the one line the shell summarised, Allow, Deny. No
// request id and no dotted mono meta line: a hex id means nothing to the
// person deciding, and the card is already inside the row it is about.
//
// ONE CARD AT A TIME. Prompts queue in arrival order, and the QUEUE IS THE
// SHELL'S (P6d-FX1, SK-5): it holds every outstanding prompt, so a second one
// arriving before the first is answered no longer takes its slot. This module
// only remembers which ids it has already answered, so a snapshot that still
// carries one cannot re-raise it while the shell is settling. A person
// answering two questions at once answers neither: the second card appears
// when the first is answered.
//
// AND IT SITS IN THE ROW THAT RAISED IT, by the tool use id the shell resolved
// (SK-8). Placement used to be guessed from the tool's name, so two calls to
// one tool in a turn both drew on the second row, and a prompt whose tool had
// no row yet drew nothing at all and stalled the turn.
//
// A PARKED PROMPT IS ALWAYS ACTIONABLE (P6d-FX2, SK-5). In Bypass the SDK never
// calls `canUseTool`, so no prompt arrives; a prompt that arrived BEFORE the
// switch is a different thing entirely, and this module used to hide it. The
// card vanished, the request stayed outstanding in the shell, and the tool call
// blocked until the sidecar's own timeout with nothing anywhere to answer it.
// The shell answers those prompts when the mode changes, so what is still in
// the list is still waiting, whatever mode the pill reads, and it draws.

import { MonitorSmartphone } from "lucide-solid"
import { type Component, createSignal, Show } from "solid-js"
import type { DesktopPermissionRequest } from "~/lib/desktop-shell-contract"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import { formatToolName } from "~/modules/agent/format-tool-name"
import { catalogHasKey, type Translate, useI18n } from "~/modules/i18n/i18n-context"
import { Button } from "~/ui/Button"
import { answerPermission, desktopState, isDesktop, localSessionFor } from "./desktop-store"

/**
 * The label the card leads with. Short on purpose: see the header comment.
 * Catalog keys, because the person deciding may read French: the card is the
 * one place a local command waits on her, so it has to be plain words.
 */
export const PERMISSION_CARD_LABEL = "kernel.desktopUi.permissionCard.label"
export const PERMISSION_ALLOW_ACTION = "kernel.desktopUi.permissionCard.allow"
export const PERMISSION_DENY_ACTION = "kernel.desktopUi.permissionCard.deny"
/** The toast raised when a prompt waits where the reader cannot see it. */
export const PERMISSION_WAITING_NOTICE = "kernel.desktopUi.permissionCard.waiting"
export const PERMISSION_SHOW_ACTION = "kernel.desktopUi.permissionCard.show"
/** The dock pill's badge for a conversation parked on a question. */
export const PERMISSION_WAITING_BADGE = "kernel.desktopUi.permissionCard.badge"

/**
 * The tool, named the way the row names it, or in plain words where the
 * catalog has them. The SDK's own tools (Bash, Write, Edit...) are names a
 * non technical reader cannot act on, so each one the catalog knows says what
 * it does ("Lancer une commande sur cet ordinateur"); English keeps the name
 * the row always showed. A tool the catalog does not know keeps its name.
 */
export function localToolLabel(toolName: string, t: Translate): string {
  const key = `kernel.desktopUi.localTool.${toolName}`
  return catalogHasKey(key) ? t(key) : formatToolName(toolName)
}

/** Ids answered here, so a snapshot the shell has not settled yet cannot re-raise one. */
const [answered, setAnswered] = createSignal<readonly string[]>([])

/** Test and sign-out seam: forgets what this window has answered. */
export function resetLocalPrompts(): void {
  setAnswered([])
}
onSessionTeardown(resetLocalPrompts)

/** The prompt being asked right now, or null. The shell owns the order. */
export function currentLocalPrompt(): DesktopPermissionRequest | null {
  const settled = answered()
  return desktopState().pendingPermissions.find((p) => !settled.includes(p.requestId)) ?? null
}

/**
 * True when THIS conversation's local turn is parked on a question. It is
 * what the dock pill badges: a collapsed conversation waiting on an Allow
 * looked exactly like one with nothing going on.
 */
export function localPromptWaitingIn(threadId: string): boolean {
  if (!isDesktop()) return false
  return localSessionFor(threadId, desktopState().agentId) && currentLocalPrompt() !== null
}

/**
 * Is the card for this prompt on the reader's screen right now: the window
 * focused, the card drawn, and inside the viewport. A toast about a card the
 * reader is already looking at would only be noise.
 */
export function permissionCardOnScreen(requestId: string): boolean {
  if (typeof document === "undefined") return false
  if (typeof document.hasFocus === "function" && !document.hasFocus()) return false
  const card = Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="local-permission-card"]'),
  ).find((el) => el.dataset.requestId === requestId)
  if (!card) return false
  const rect = card.getBoundingClientRect()
  const height = window.innerHeight || document.documentElement.clientHeight
  return rect.height > 0 && rect.bottom > 0 && rect.top < height
}

interface LocalPermissionCardProps {
  /** The tool call row asking whether the card belongs to it. */
  toolCallId: string
}

const LocalPermissionCard: Component<LocalPermissionCardProps> = (props) => {
  const i18n = useI18n()
  const prompt = () => (isDesktop() ? currentLocalPrompt() : null)
  const mine = () => prompt()?.toolUseId === props.toolCallId

  async function decide(decision: "allow" | "deny") {
    const current = prompt()
    if (!current) return
    setAnswered((ids) => [...ids, current.requestId])
    await answerPermission(current.requestId, decision)
  }

  return (
    <Show when={prompt()}>
      {(current) => (
        <Show when={mine()}>
          <div
            data-testid="local-permission-card"
            data-request-id={current().requestId}
            class="my-2 rounded-lg border border-border bg-elevated p-3 text-[13px]"
          >
            <div class="flex items-center gap-2 text-text-secondary">
              <MonitorSmartphone size={14} class="shrink-0" />
              <span class="text-[11px] font-medium uppercase tracking-[0.04em] text-text-tertiary">
                {i18n.t(PERMISSION_CARD_LABEL)}
              </span>
            </div>
            <p class="mt-2 font-medium text-text">{localToolLabel(current().toolName, i18n.t)}</p>
            <p class="mt-0.5 text-text-secondary">{current().summary}</p>
            <div class="mt-3 flex gap-2">
              <Button size="sm" onClick={() => void decide("allow")}>
                {i18n.t(PERMISSION_ALLOW_ACTION)}
              </Button>
              <Button size="sm" variant="outline" onClick={() => void decide("deny")}>
                {i18n.t(PERMISSION_DENY_ACTION)}
              </Button>
            </div>
          </div>
        </Show>
      )}
    </Show>
  )
}

export default LocalPermissionCard
