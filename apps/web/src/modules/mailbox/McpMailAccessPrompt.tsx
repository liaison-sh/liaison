// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The question an app connected over MCP puts to the user before this window
// decrypts anything for it. One prompt at a time; asks that arrive while one is
// open wait their turn. An unanswered prompt closes itself as a refusal just
// before the waiting call gives up, so a late click never releases mail to a
// call that is no longer listening.

import { type Component, createSignal, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import type { McpAccessAnswer, McpAccessPrompt } from "~/modules/mailbox/mcp-plaintext-responder"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"

/** Under the server's 60 s wait, so the answer still has somewhere to go. */
export const MCP_PROMPT_TIMEOUT_MS = 55_000

interface Pending {
  prompt: McpAccessPrompt
  resolve: (answer: McpAccessAnswer) => void
}

const [current, setCurrent] = createSignal<Pending | null>(null)
const queue: Pending[] = []

function next(): void {
  if (current() || queue.length === 0) return
  const pending = queue.shift() as Pending
  const timer = setTimeout(() => settle("deny"), MCP_PROMPT_TIMEOUT_MS)
  setCurrent({
    prompt: pending.prompt,
    resolve: (answer) => {
      clearTimeout(timer)
      pending.resolve(answer)
    },
  })
}

function settle(answer: McpAccessAnswer): void {
  const pending = current()
  if (!pending) return
  setCurrent(null)
  pending.resolve(answer)
  next()
}

/** Asks the user; resolves to their answer, or to "deny" when nobody answers. */
export function askMcpMailAccess(prompt: McpAccessPrompt): Promise<McpAccessAnswer> {
  return new Promise((resolve) => {
    queue.push({ prompt, resolve })
    next()
  })
}

/** Lock: every open and queued ask is refused. */
export function denyAllMcpMailAccess(): void {
  while (queue.length > 0) queue.shift()?.resolve("deny")
  settle("deny")
}

export const McpMailAccessPrompt: Component = () => {
  const i18n = useI18n()
  return (
    <Show when={current()}>
      {(pending) => (
        <Dialog open onOpenChange={(open) => !open && settle("deny")}>
          <Dialog.Content>
            <div data-testid="mcp-mail-access-prompt">
              <Dialog.Title>{i18n.t("kernel.mailboxMcpAccess.title")}</Dialog.Title>
              <Dialog.Description>
                {pending().prompt.requestKind === "mail.search"
                  ? i18n.t("kernel.mailboxMcpAccess.searchBody", {
                      client: pending().prompt.client,
                      query: pending().prompt.query ?? "",
                    })
                  : i18n.t("kernel.mailboxMcpAccess.readBody", {
                      client: pending().prompt.client,
                      count: pending().prompt.messageCount,
                    })}
              </Dialog.Description>
              {/* Who is asking, from the server's connection record: the name
                  alone is whatever the app registered under. */}
              <p
                data-testid="mcp-mail-access-identity"
                class="mt-2 text-[12px] text-text-secondary"
              >
                {i18n.t("kernel.mailboxMcpAccess.identity", {
                  date: pending().prompt.clientConnectedAt
                    ? i18n.fmtDate(new Date(pending().prompt.clientConnectedAt as string), {
                        year: "numeric",
                        month: "long",
                        day: "numeric",
                      })
                    : i18n.t("kernel.mailboxMcpAccess.unknownDate"),
                  ref: pending().prompt.connectionId.slice(0, 8),
                })}
              </p>
              <p class="mt-2 text-[12px] text-text-tertiary">
                {i18n.t("kernel.mailboxMcpAccess.note")}
              </p>
              <div class="mt-4 flex flex-wrap justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="mcp-mail-access-deny"
                  onClick={() => settle("deny")}
                >
                  {i18n.t("kernel.mailboxMcpAccess.deny")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="mcp-mail-access-window"
                  onClick={() => settle("window")}
                >
                  {i18n.t("kernel.mailboxMcpAccess.allowWindow")}
                </Button>
                <Button size="sm" data-testid="mcp-mail-access-once" onClick={() => settle("once")}>
                  {i18n.t("kernel.mailboxMcpAccess.allowOnce")}
                </Button>
              </div>
            </div>
          </Dialog.Content>
        </Dialog>
      )}
    </Show>
  )
}
