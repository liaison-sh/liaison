// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The question an explicit sign-out asks when some text could not be saved
// (sign-out-guard.ts): the pages, by the title in their draft, with Copy for each;
// "Stay signed in" (the default, and Escape) or "Sign out and discard". Mounted once
// by the shell; importing it installs the guard.

import { type Component, createSignal, For, Show } from "solid-js"
import { userFromToken } from "~/modules/auth/auth-store"
import { createSessionApiClient } from "~/modules/auth/session-api-client"
import { tNow, useI18n } from "~/modules/i18n/i18n-context"
import { addToast } from "~/modules/shell/toast-store"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"
import { liveSavers } from "./autosave"
import { pageDrafts } from "./drafts"
import {
  installKnowledgeSignOutGuard,
  type SignOutChoice,
  type UnsavedPage,
} from "./sign-out-guard"

interface Pending {
  pages: UnsavedPage[]
  resolve: (choice: SignOutChoice) => void
}

const [pending, setPending] = createSignal<Pending | null>(null)

/** Show the list and wait for the person's choice. */
export function askSignOutUnsaved(pages: UnsavedPage[]): Promise<SignOutChoice> {
  pending()?.resolve("stay")
  return new Promise((resolve) => setPending({ pages, resolve }))
}

function choose(choice: SignOutChoice) {
  const p = pending()
  if (!p) return
  setPending(null)
  p.resolve(choice)
}

const REASON_KEYS: Partial<Record<string, string>> = {
  offline: "knowledge.autosave.reasonOffline",
  "too-large": "knowledge.autosave.reasonTooLarge",
  "no-access": "knowledge.autosave.reasonNoAccess",
  error: "knowledge.autosave.reasonError",
  conflict: "knowledge.autosave.reasonConflict",
}

export const SignOutUnsavedDialog: Component = () => {
  const i18n = useI18n()
  const copy = async (page: UnsavedPage) => {
    try {
      await navigator.clipboard.writeText(page.body)
      addToast({ type: "success", message: i18n.t("knowledge.autosave.copied") })
    } catch {
      addToast({ type: "error", message: i18n.t("knowledge.autosave.copyFailed") })
    }
  }
  return (
    <Dialog open={pending() !== null} onOpenChange={(open) => !open && choose("stay")}>
      <Dialog.Content
        class="max-w-lg"
        onOpenAutoFocus={(e) => {
          // Staying signed in is the default: Enter keeps the text.
          e.preventDefault()
          document.querySelector<HTMLElement>('[data-testid="sign-out-unsaved-stay"]')?.focus()
        }}
      >
        <div data-testid="sign-out-unsaved-dialog">
          <Dialog.Title>{i18n.t("knowledge.autosave.signOutTitle")}</Dialog.Title>
          <Dialog.Description>{i18n.t("knowledge.autosave.signOutBody")}</Dialog.Description>
          <ul class="mt-4 flex max-h-64 flex-col gap-1 overflow-y-auto">
            <For each={pending()?.pages ?? []}>
              {(page) => (
                <li
                  data-testid="sign-out-unsaved-page"
                  class="flex items-center justify-between gap-3 rounded-md border border-border-subtle px-3 py-2"
                >
                  <div class="flex min-w-0 flex-col">
                    <span class="truncate text-[13px] text-text">{page.title}</span>
                    <Show when={page.reason && REASON_KEYS[page.reason]}>
                      {(key) => (
                        <span class="text-[12px] text-text-tertiary">
                          {i18n.t(key(), { size: page.body.length.toLocaleString(i18n.locale()) })}
                        </span>
                      )}
                    </Show>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    data-testid="sign-out-unsaved-copy"
                    onClick={() => void copy(page)}
                  >
                    {i18n.t("knowledge.autosave.copy")}
                  </Button>
                </li>
              )}
            </For>
          </ul>
          <div class="mt-6 flex flex-wrap justify-end gap-2">
            <Button
              variant="ghost"
              data-testid="sign-out-unsaved-discard"
              onClick={() => choose("discard")}
            >
              {i18n.t("knowledge.autosave.signOutDiscard")}
            </Button>
            <Button data-testid="sign-out-unsaved-stay" onClick={() => choose("stay")}>
              {i18n.t("knowledge.autosave.staySignedIn")}
            </Button>
          </div>
        </div>
      </Dialog.Content>
    </Dialog>
  )
}

installKnowledgeSignOutGuard({
  api: createSessionApiClient({ onUnauthorized: () => {} }),
  drafts: pageDrafts(),
  savers: liveSavers,
  currentUserId: () => userFromToken()?.userId ?? null,
  untitled: () => tNow("knowledge.untitled"),
  ask: askSignOutUnsaved,
})

export default SignOutUnsavedDialog
