// SPDX-License-Identifier: FSL-1.1-ALv2
import { Home as HomeIcon } from "lucide-solid"
import { type Component, Show } from "solid-js"
import { attentionStore } from "~/modules/shell/attention-store"
import { homeActionCount } from "~/modules/shell/home-action-count"

/** Cap the pill's displayed text — the exact count still drives the badge/tab-title math. */
function formatBadgeCount(n: number): string {
  return n > 99 ? "99+" : String(n)
}

// The number is the rows of Home's "Needs you" section, the same number as the
// phone's Home tab, so it can always be opened. The phone's icon, the dock and
// the tab title keep THE badge (app-badge-store.ts), which also counts unread
// messages. The quiet dot still marks anything else waiting on Home.
const HomeIconWithDot: Component<{ size?: number }> = (props) => (
  <div class="relative inline-flex" data-testid="home-icon-with-dot">
    <HomeIcon size={props.size ?? 18} />
    <Show
      when={homeActionCount() > 0}
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
        {formatBadgeCount(homeActionCount())}
      </span>
    </Show>
  </div>
)

export default HomeIconWithDot
