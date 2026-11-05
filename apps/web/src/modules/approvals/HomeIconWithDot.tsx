// SPDX-License-Identifier: FSL-1.1-ALv2
import { Home as HomeIcon } from "lucide-solid"
import { type Component, Show } from "solid-js"
import { appBadgeCount } from "~/modules/notifications/app-badge-store"
import { attentionStore } from "~/modules/shell/attention-store"

/** Cap the pill's displayed text — the exact count still drives the badge/tab-title math. */
function formatBadgeCount(n: number): string {
  return n > 99 ? "99+" : String(n)
}

// The number is THE badge (rule 6, app-badge-store.ts): the unread things that
// ask for the user, the same number as the phone's icon, the desktop dock and
// the tab title. The quiet dot still marks anything else waiting on Home.
const HomeIconWithDot: Component<{ size?: number }> = (props) => (
  <div class="relative inline-flex" data-testid="home-icon-with-dot">
    <HomeIcon size={props.size ?? 18} />
    <Show
      when={appBadgeCount() > 0}
      fallback={
        <Show when={attentionStore.attentionCount() > 0}>
          <span
            data-testid="activity-bar-home-dot"
            class="absolute right-[-1px] top-[-1px] h-[4px] w-[4px] rounded-full bg-accent"
          />
        </Show>
      }
    >
      <span
        data-testid="activity-bar-home-badge"
        class="absolute -right-2 -top-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold leading-none tabular-nums text-white"
      >
        {formatBadgeCount(appBadgeCount())}
      </span>
    </Show>
  </div>
)

export default HomeIconWithDot
