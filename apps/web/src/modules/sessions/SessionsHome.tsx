// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE SESSIONS HOME (P2-T10; `/sessions` with no session picked). On a wide
// screen the list is the sidebar, so the main area shows the empty state when
// there is no session at all, else "Pick a session on the left". Below the md
// breakpoint the list itself is the screen, full width (P4's two-screen seam).
// At phone tier (P4-T10) the list is the whole screen and nothing else.

import { createSignal, onMount, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { NewSessionDialog } from "./NewSessionDialog"
import { isPhone } from "./phone"
import SessionList, { noSessionsAtAll, SessionsEmpty } from "./SessionList"
import { ensureListLoaded } from "./session-list"

export default function SessionsHome(_props: { entityId?: string }) {
  const t = useI18n().t
  const [newOpen, setNewOpen] = createSignal(false)
  onMount(() => void ensureListLoaded())
  return (
    <section data-testid="sessions-home" class="flex h-full min-w-0 flex-col">
      <div class="h-full md:hidden">
        <SessionList />
      </div>
      <Show when={!isPhone()}>
        <div class="hidden h-full items-center justify-center md:flex">
          <Show
            when={!noSessionsAtAll()}
            fallback={
              <div class="max-w-md">
                <SessionsEmpty onNew={() => setNewOpen(true)} />
              </div>
            }
          >
            <p class="text-[13px] text-text-tertiary">{t("kernel.nodeSessions.app.pick")}</p>
          </Show>
        </div>
      </Show>
      <Show when={newOpen()}>
        <NewSessionDialog open onOpenChange={setNewOpen} />
      </Show>
    </section>
  )
}
