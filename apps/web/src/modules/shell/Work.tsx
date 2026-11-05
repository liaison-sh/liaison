// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The phone Work screen (M1-A T3): one grouped list of everything the user can
// reach. The five fixed seats of the phone bar cover Home, Chats, Search and
// You; every other surface the workspace has lives here, derived from the SAME
// activity-bar registry the desktop rail renders, so an app the user cannot
// reach never appears and a newly installed one needs no change here.
//
// It is a phone tab type and nothing else: it registers no activity-bar entry,
// so the desktop rail is untouched.
//
// F3: it hides the phone top bar entirely and carries its own large title,
// with the workspace name as a small muted line under it — the same shape
// Chats' phone-dock title uses, so the two root screens read as one family
// instead of one showing a title and the other not.
import { ChevronRight, ShieldCheck } from "lucide-solid"
import { type Component, createMemo, For, onMount, Show } from "solid-js"
import { Dynamic } from "solid-js/web"
import {
  type ActivityBarEntry,
  getActivityBarEntries,
  registryLabel,
  resolveRegisteredTabType,
} from "~/framework/app-registry"
import { useI18n } from "~/modules/i18n/i18n-context"
import { applyActivityBarOrder } from "~/modules/shell/activity-bar-order-store"
import { appSquareColor } from "~/modules/shell/app-color"
import { attentionStore, getAttentionApi } from "~/modules/shell/attention-store"
import {
  ensureBrandingLoaded,
  ensureSignedInOrgNameLoaded,
  orgName,
} from "~/modules/shell/branding-store"
import { homeApprovalCount } from "~/modules/shell/home-action-count"
import { openTab } from "~/modules/shell/tab-store"
import { ToursWorkRow } from "~/modules/tours/ToursMenu"
import { PullToRefresh } from "~/ui/PullToRefresh"

/** Tab types that already own a fixed seat in the phone bar. */
// `kernel:chats` is the desktop rail's Messages entry; the phone seats it as Chats.
const SEATED_TAB_TYPES = new Set([
  "kernel:home",
  "kernel:chats",
  "kernel:search",
  "kernel:settings",
  "kernel:work",
])

function isSeated(entry: ActivityBarEntry): boolean {
  const type = resolveRegisteredTabType(entry.tabAction.type) ?? entry.tabAction.type
  return SEATED_TAB_TYPES.has(type)
}

const WorkRow: Component<{ entry: ActivityBarEntry }> = (props) => {
  const i18n = useI18n()
  // Final walk F8: an entry with its own badge (Sessions: what waits on you)
  // counts that; the app's attention items are for entries without one. The
  // Sessions entry's app is the kernel, whose items numbered 98 here.
  const count = () =>
    props.entry.badge
      ? props.entry.badge()
      : attentionStore.attentionForApp(props.entry.appId).length
  const label = () => registryLabel(i18n.t, props.entry)
  return (
    <button
      type="button"
      data-testid={`work-row-${props.entry.appId}`}
      aria-label={label()}
      onClick={() => openTab({ ...props.entry.tabAction, preview: false })}
      class="flex h-[46px] w-full shrink-0 items-center gap-3 px-4 text-left text-[16px] text-text hover:bg-surface-hover"
    >
      <span
        aria-hidden="true"
        class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-white"
        style={{ "background-color": appSquareColor(props.entry.appId) }}
      >
        <Dynamic component={props.entry.icon} size={16} />
      </span>
      <span class="min-w-0 flex-1 truncate">{label()}</span>
      <Show when={count() > 0}>
        <span
          data-testid={`work-row-count-${props.entry.appId}`}
          class="shrink-0 rounded-full bg-accent px-1.5 text-[12px] font-semibold leading-[17px] text-accent-foreground"
        >
          {count() > 99 ? "99+" : count()}
        </span>
      </Show>
      <ChevronRight size={16} class="shrink-0 text-text-tertiary" />
    </button>
  )
}

// G3 — Approvals was registered as a phone tab type (bootstrap.ts) but never
// wired into any phone navigation surface: no activity-bar entry (by design,
// same as `work`/`chats`) and no row here either, so `/approvals` was reachable
// only by typing the URL. This is a FIXED first row, not a normal activity-bar
// one — Approvals carries no activity-bar entry to derive it from, and it
// belongs first regardless of alphabetical/registration order, the same way
// the desktop rail always seats it as a dedicated affordance.
const ApprovalsWorkRow: Component = () => {
  const i18n = useI18n()
  // THE count Home's approvals card shows (the attention feed's approval rows,
  // peer requests folded when the card folds them): not the approvals-store's
  // decidable list, which only populates once ApprovalsScreen itself has
  // mounted and loaded it, and would show a false zero here otherwise.
  const count = () => homeApprovalCount(attentionStore.items)
  return (
    <button
      type="button"
      data-testid="work-row-approvals"
      aria-label={i18n.t("kernel.workApprovals")}
      onClick={() =>
        openTab({
          type: "kernel:approvals",
          entityId: "approvals",
          label: i18n.t("kernel.shellUi.approvals"),
        })
      }
      class="flex h-[46px] w-full shrink-0 items-center gap-3 px-4 text-left text-[16px] text-text hover:bg-surface-hover"
    >
      <span
        aria-hidden="true"
        class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent text-accent-foreground"
      >
        <ShieldCheck size={16} />
      </span>
      <span class="min-w-0 flex-1 truncate">{i18n.t("kernel.workApprovals")}</span>
      <Show when={count() > 0}>
        <span
          data-testid="work-row-count-approvals"
          class="shrink-0 rounded-full bg-accent px-1.5 text-[12px] font-semibold leading-[17px] text-accent-foreground"
        >
          {count() > 99 ? "99+" : count()}
        </span>
      </Show>
      <ChevronRight size={16} class="shrink-0 text-text-tertiary" />
    </button>
  )
}

const WorkGroup: Component<{ label: string; entries: ActivityBarEntry[]; testId: string }> = (
  props,
) => (
  <Show when={props.entries.length > 0}>
    <div data-testid={props.testId} class="flex flex-col">
      <h2 class="px-4 pb-1 pt-4 text-[12px] font-semibold uppercase tracking-wide text-text-tertiary">
        {props.label}
      </h2>
      <For each={props.entries}>{(entry) => <WorkRow entry={entry} />}</For>
    </div>
  </Show>
)

export const Work: Component = () => {
  const i18n = useI18n()

  onMount(() => {
    // The top bar that used to fetch branding for this screen is hidden now
    // (F3): the org line under this screen's own title needs its own load.
    // Public branding only. The signed-in org name is loaded once per session
    // in `startup.ts`: reading it here raced the attentionStore api
    // registration, which is not set yet at mount, so this screen printed the
    // deployment's name ("Default Organization") for the whole session.
    void ensureBrandingLoaded()
  })

  const rows = createMemo(() =>
    applyActivityBarOrder(
      getActivityBarEntries().filter((entry) => entry.position !== "bottom" && !isSeated(entry)),
    ),
  )
  const modules = createMemo(() => rows().filter((entry) => !entry.external))
  const apps = createMemo(() => rows().filter((entry) => entry.external))

  /**
   * What a pull down actually reloads here. The rows themselves come from the
   * in-memory registry and cannot go stale; the counts on them come from the
   * attention feed, which is polled, and the org line from branding. Those two
   * are the whole of what a user pulls this screen for.
   */
  async function refresh(): Promise<void> {
    const api = getAttentionApi()
    if (api) {
      attentionStore.markStaleAndReload(api)
      await ensureSignedInOrgNameLoaded(() => api.get("/org"))
    }
    await ensureBrandingLoaded()
  }

  return (
    <PullToRefresh
      onRefresh={refresh}
      label={i18n.t("kernel.refreshing")}
      class="flex h-full flex-col"
    >
      <div data-testid="work-screen" class="flex h-full min-h-0 flex-col overflow-y-auto pb-6">
        <div class="shrink-0 px-4 pb-2 pt-3">
          <h1
            data-testid="work-title"
            class="font-display text-[32px] font-semibold leading-tight text-text"
          >
            {i18n.t("kernel.workTitle")}
          </h1>
          <Show when={orgName()}>
            {(name) => (
              <p data-testid="work-title-org" class="truncate text-[12px] text-text-secondary">
                {name()}
              </p>
            )}
          </Show>
        </div>
        <ApprovalsWorkRow />
        <WorkGroup
          testId="work-group-modules"
          label={i18n.t("kernel.workModules")}
          entries={modules()}
        />
        <WorkGroup testId="work-group-apps" label={i18n.t("kernel.workApps")} entries={apps()} />
        <div class="pt-4">
          <ToursWorkRow />
        </div>
      </div>
    </PullToRefresh>
  )
}

export default Work
