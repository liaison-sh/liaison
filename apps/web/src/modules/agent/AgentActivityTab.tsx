// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The agent page's Activity tab (P4c-T37): ONE timeline of what this agent did,
 * newest first, every row a way into the conversation it happened in.
 *
 * IT RENDERS WHAT THE SERVER SAYS AND NOTHING MORE. `GET /api/agents/:id/activity`
 * answers rows of `{ at, kind, threadId, threadName, summary, runLocation }`,
 * with the summary already built from the audit row's ACTION: no message text,
 * no tool result, nothing this tab could leak by rendering a field it did not
 * expect. A row shape it cannot read is dropped rather than half drawn.
 *
 * THE ROW IS THE ATTENTION FEED'S ROW (`shell/AttentionRow.tsx`): a 40px icon
 * rail, a body whose first line is the summary and whose second is the quiet
 * meta line, and a hover accent rail down the left edge. A timeline that looked
 * like a different product from the feed would be a second thing to learn.
 *
 * THE TAB IS ALREADY GATED. `AgentPage` mounts it only for `kernel:agents:admin`
 * or a personal agent's owner, and the route refuses anybody else (403 for an
 * agent they can see, 404 for one they cannot), so this component carries no
 * permission logic of its own to drift from the server's.
 */
import {
  Bot,
  BrainCircuit,
  CheckCheck,
  type LucideProps,
  MessageSquare,
  Repeat,
  Timer,
} from "lucide-solid"
import { type Component, createSignal, For, onMount, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { formatRelativeTime, rowLocaleFrom } from "~/modules/shell/attention-row-format"
import { openTab } from "~/modules/shell/tab-store"

/** One timeline row, exactly as the activity route answers it. */
export interface AgentActivityRow {
  at: string
  kind: "turn" | "routine_tick" | "sub_run" | "ask" | "memory_write" | "approval"
  threadId: string | null
  threadName: string | null
  summary: string
  /** Catalog key under kernel.agentUi.activity, when the route sends one. */
  summaryKey?: string
  runLocation: "liaison" | "local" | "node"
}

/** The page the route serves, so a short page means the timeline has ended. */
const PAGE_SIZE = 50

const KIND_ICONS: Record<AgentActivityRow["kind"], Component<LucideProps>> = {
  turn: MessageSquare,
  ask: Bot,
  routine_tick: Repeat,
  sub_run: Timer,
  memory_write: BrainCircuit,
  approval: CheckCheck,
}

/** The row's sentence in the reader's language; the route's English otherwise. */
export function activitySummary(
  row: Pick<AgentActivityRow, "summary" | "summaryKey">,
  t: (key: string) => string,
): string {
  if (!row.summaryKey) return row.summary
  const key = `kernel.agentUi.activity.${row.summaryKey}`
  const out = t(key)
  return out === key ? row.summary : out
}

/** What a row of the response must carry to be drawn at all. */
function normalizeRow(raw: any): AgentActivityRow | null {
  if (typeof raw?.at !== "string" || typeof raw?.summary !== "string") return null
  if (!(raw.kind in KIND_ICONS)) return null
  return {
    at: raw.at,
    kind: raw.kind,
    threadId: typeof raw.threadId === "string" ? raw.threadId : null,
    threadName: typeof raw.threadName === "string" ? raw.threadName : null,
    summary: raw.summary,
    summaryKey: typeof raw.summaryKey === "string" ? raw.summaryKey : undefined,
    runLocation:
      raw.runLocation === "local" || raw.runLocation === "node" ? raw.runLocation : "liaison",
  }
}

interface Props {
  agentId: string
}

const AgentActivityTab: Component<Props> = (props) => {
  const api = useApi()
  const i18n = useI18n()
  const [rows, setRows] = createSignal<AgentActivityRow[]>([])
  const [loaded, setLoaded] = createSignal(false)
  const [loading, setLoading] = createSignal(false)
  const [failed, setFailed] = createSignal(false)
  // A page shorter than the server's own is the end of the timeline, which is
  // the one thing "Load more" must not offer after.
  const [ended, setEnded] = createSignal(false)

  async function load(before?: string): Promise<void> {
    if (loading()) return
    setLoading(true)
    try {
      const query = before ? `?before=${encodeURIComponent(before)}` : ""
      const res = await api.get<any>(`/agents/${props.agentId}/activity${query}`)
      const raw = Array.isArray(res) ? res : (res?.data ?? [])
      const page = (Array.isArray(raw) ? raw : [])
        .map(normalizeRow)
        .filter((r: AgentActivityRow | null): r is AgentActivityRow => r !== null)
      setRows(before ? [...rows(), ...page] : page)
      setEnded(page.length < PAGE_SIZE)
      setFailed(false)
    } catch {
      // A first page that fails is a refusal to show; a later one leaves what
      // is already on screen where it is.
      if (!before) setFailed(true)
    } finally {
      setLoading(false)
      setLoaded(true)
    }
  }

  onMount(() => {
    if (props.agentId) void load()
    else setLoaded(true)
  })

  const openRow = (row: AgentActivityRow): void => {
    if (!row.threadId) return
    // `label` is required by the tab store; the shell re-resolves it once the
    // thread loads, so the row's own name is the best first guess and a room
    // this viewer cannot name falls back to a neutral word.
    openTab({
      type: "thread",
      entityId: row.threadId,
      label: row.threadName ?? i18n.t("kernel.agents.activityThread"),
    })
  }

  return (
    <div data-testid="agent-activity" class="px-2 py-2">
      <Show when={loaded() && failed()}>
        <p data-testid="agent-activity-error" class="px-2 py-6 text-[13px] text-text-tertiary">
          {i18n.t("kernel.agents.activityError")}
        </p>
      </Show>
      <Show when={loaded() && !failed() && rows().length === 0}>
        <p data-testid="agent-activity-empty" class="px-2 py-6 text-[13px] text-text-tertiary">
          {i18n.t("kernel.agents.activityEmpty")}
        </p>
      </Show>
      <ul class="flex flex-col divide-y divide-border-subtle">
        <For each={rows()}>
          {(row, index) => {
            const Icon = KIND_ICONS[row.kind]
            return (
              <li
                data-testid={`agent-activity-row-${index()}`}
                data-kind={row.kind}
                class="group/row relative flex flex-wrap items-start gap-x-3 gap-y-1 py-3 pl-0 pr-4 transition-colors hover:bg-surface-hover/50"
                classList={{ "cursor-pointer": row.threadId !== null }}
                onClick={() => openRow(row)}
              >
                <span
                  aria-hidden="true"
                  class="pointer-events-none absolute left-0 top-2 bottom-2 w-[2px] rounded-r bg-accent opacity-0 transition-opacity duration-150 group-hover/row:opacity-100"
                />
                <span class="flex h-5 w-10 shrink-0 items-center justify-center">
                  <Icon
                    size={14}
                    class="text-text-tertiary transition-colors duration-150 group-hover/row:text-text-secondary"
                  />
                </span>
                <div class="flex min-w-[240px] flex-1 flex-col gap-1">
                  <span class="line-clamp-2 text-[14px] font-medium leading-snug text-text">
                    {activitySummary(row, i18n.t)}
                    {/* WHERE IT RAN, on the row that ran there: a turn a
                        colleague's desktop answered is not the same event as
                        one the server answered, and the timeline is the only
                        surface that says so after the fact. */}
                    <Show when={row.runLocation !== "liaison"}>
                      <span
                        data-testid={`agent-activity-badge-${index()}`}
                        data-run-location={row.runLocation}
                        class="ml-1.5 inline-block shrink-0 rounded-full border border-border-subtle px-1.5 py-px align-middle text-[11.5px] font-semibold leading-tight text-text-tertiary"
                      >
                        {i18n.t(
                          row.runLocation === "node"
                            ? "kernel.agents.activityNodeBadge"
                            : "kernel.agents.activityLocalBadge",
                        )}
                      </span>
                    </Show>
                  </span>
                  <span class="flex min-w-0 flex-wrap items-center gap-x-1.5 text-[11px] leading-snug text-text-tertiary">
                    <Show when={row.threadName}>
                      {(name) => (
                        <span data-testid={`agent-activity-thread-${index()}`} class="truncate">
                          {name()}
                          <span aria-hidden="true"> · </span>
                        </span>
                      )}
                    </Show>
                    <span>{formatRelativeTime(row.at, { i18n: rowLocaleFrom(i18n) })}</span>
                  </span>
                </div>
              </li>
            )
          }}
        </For>
      </ul>
      <Show when={rows().length > 0 && !ended()}>
        <button
          type="button"
          data-testid="agent-activity-more"
          disabled={loading()}
          onClick={() => void load(rows().at(-1)?.at)}
          class="mx-auto mt-3 flex min-h-9 items-center rounded-md border border-border px-3 text-[12.5px] text-text-secondary transition-colors hover:bg-surface-hover disabled:opacity-50"
        >
          {i18n.t("kernel.agents.activityLoadMore")}
        </button>
      </Show>
    </div>
  )
}

export default AgentActivityTab
