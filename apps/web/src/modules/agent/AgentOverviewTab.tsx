// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The agent page's landing tab: who this agent is, in the words a colleague
 * would use.
 *
 * NOTHING HERE NAMES A SCOPE, AND NOTHING HERE NAMES A SLUG. The ceiling
 * arrives from the page read already mapped to capability CATEGORIES, and the
 * chips render each one by the NAME a person knows it by: the app's manifest
 * display name, or the role's own name for a category that is really a role
 * ("Tickets" and "C-Level", never "tickets" and "clevel"). A raw grant string
 * is an implementation detail that reads as a secret and teaches nobody
 * anything; a bare slug is the same defect one step down.
 *
 * @base IS A TEMPLATE, NEVER A CORRESPONDENT (charter agent.md): the system
 * agent's page offers no `Add to channel`, and the page header offers it no
 * `Message`. Absent from the DOM, not disabled.
 *
 * THE CHARTER IS READ ONLY, AND ITS INSTRUCTIONS ARE COLLAPSED. The system
 * prompt is long, it is written for the model rather than for the reader, and
 * it is the one part of the page that can carry operational detail, so it sits
 * behind `Show instructions` rather than greeting everyone who opens the page:
 *
 *   GET /api/agents/:agentId/definition -> { systemPrompt, ... }
 *
 * ADD TO CHANNEL is the thread add member call, not a second one:
 * `POST /api/threads/:threadId/participants` with `{ agentId }`, the AGENT seat
 * shape the route stores (`participantType: 'agent'`), offered for the channels
 * the viewer may add to today (thread admin, or a room they created
 * themselves). The channel is only listed as added once the route says so.
 */
import { isAgentAvatarColor } from "@liaison/shared"
import { type Component, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { categoryChip } from "~/lib/capability-copy"
import { hasScope, userFromToken } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { localizeAgentName } from "~/modules/threads/agent-name"
import { isChannel } from "~/modules/threads/conversation-display"
import { allThreads } from "~/modules/threads/thread-store"
import { PopupMenu } from "~/ui/PopupMenu"
import Chip from "./Chip"

/** One channel the agent already sits in, as the page read answers it. */
export interface AgentDetailChannel {
  id: string
  handle: string
  name: string
}

/** `GET /api/agents/:agentId` (P4c-T31), the agent page's one read. */
export interface AgentDetail {
  id: string
  handle: string
  displayName: string
  kind?: "role" | "personal" | "system"
  ownerUserId: string | null
  purpose: string
  avatarUrl: string | null
  /** The stored slot of the agent avatar palette, null when none is stored. */
  avatarColor?: number | null
  state?: string
  lastActivityAt: string | null
  channels: AgentDetailChannel[]
  counts: { skills: number; routines: number; memoryFiles: number; knowledgePointers: number }
  capabilityCategories: string[]
  runsOn: "liaison" | "local"
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

/**
 * What an agent with no stored purpose is for. A personal agent and the org's
 * base agent are product defaults, so they get the product's words in the
 * reader's language rather than "No purpose recorded yet"; any other agent
 * without one still says so.
 */
export function defaultPurpose(
  detail: Pick<AgentDetail, "kind" | "handle"> | null | undefined,
  t: (key: string) => string,
): string {
  if (detail?.kind === "personal") return t("kernel.agents.defaultPurposePersonal")
  if (detail?.kind === "system" || detail?.handle === "@base" || detail?.handle === "base")
    return t("kernel.agents.defaultPurposeBase")
  return t("kernel.agents.purposeEmpty")
}

/** A page read from a backend that answers a thinner shape still renders: every
 *  field falls back rather than throwing the whole tab away. */
export function normalizeAgentDetail(raw: any): AgentDetail | null {
  if (typeof raw?.id !== "string") return null
  return {
    id: raw.id,
    handle: str(raw.handle),
    displayName: localizeAgentName(str(raw.displayName, str(raw.handle, raw.id))),
    kind:
      raw.kind === "role" || raw.kind === "personal" || raw.kind === "system"
        ? raw.kind
        : undefined,
    ownerUserId: typeof raw.ownerUserId === "string" ? raw.ownerUserId : null,
    purpose: str(raw.purpose),
    avatarUrl: typeof raw.avatarUrl === "string" ? raw.avatarUrl : null,
    avatarColor: isAgentAvatarColor(raw.avatarColor) ? raw.avatarColor : null,
    state: typeof raw.state === "string" ? raw.state : undefined,
    lastActivityAt: typeof raw.lastActivityAt === "string" ? raw.lastActivityAt : null,
    channels: (Array.isArray(raw.channels) ? raw.channels : [])
      .filter((c: any) => typeof c?.id === "string")
      .map((c: any) => ({ id: c.id, handle: str(c.handle), name: str(c.name, str(c.handle)) })),
    counts: {
      skills: count(raw.counts?.skills),
      routines: count(raw.counts?.routines),
      memoryFiles: count(raw.counts?.memoryFiles),
      knowledgePointers: count(raw.counts?.knowledgePointers),
    },
    capabilityCategories: (Array.isArray(raw.capabilityCategories)
      ? raw.capabilityCategories
      : []) as string[],
    runsOn: raw.runsOn === "local" ? "local" : "liaison",
  }
}

interface Props {
  agentId: string
  agentName: string
  detail: AgentDetail | null
  /**
   * Whether this agent is something a person corresponds with, decided by the
   * PAGE, which is the only place that sees every read of the agent. Absent,
   * the tab falls back to the page read it was handed, and an agent whose kind
   * nothing has established yet is NOT offered a channel: unknown is not
   * "not a template".
   */
  canCorrespond?: boolean
}

/** The last-activity line. The wording is a catalog entry in every shipped
 *  locale, so the caller hands its translator in rather than a literal. */
export function formatActivity(
  t: (key: string, params?: Record<string, string | number | boolean>) => string,
  iso: string | null,
  locale: string,
): string {
  if (!iso) return t("kernel.agents.activityNone")
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return t("kernel.agents.activityNone")
  return t("kernel.agents.lastActivity", { date: date.toLocaleDateString(locale) })
}

const AgentOverviewTab: Component<Props> = (props) => {
  const api = useApi()
  const i18n = useI18n()
  const [showInstructions, setShowInstructions] = createSignal(false)
  const [addOpen, setAddOpen] = createSignal(false)
  const [addError, setAddError] = createSignal<string | null>(null)
  const [added, setAdded] = createSignal<AgentDetailChannel[]>([])

  /** The charter, read only. The definition is the only place the system
   *  prompt lives; a backend without the route leaves the section empty rather
   *  than failing the tab. */
  const [definition] = createResource<{ systemPrompt: string } | null, string>(
    () => (props.agentId ? props.agentId : undefined),
    async (agentId) => {
      try {
        const res = await api.get<any>(`/agents/${agentId}/definition`)
        const body = res?.data ?? res
        return { systemPrompt: str(body?.systemPrompt) }
      } catch {
        return null
      }
    },
  )

  const channels = createMemo<AgentDetailChannel[]>(() => [
    ...(props.detail?.channels ?? []),
    ...added(),
  ])

  const me = () => userFromToken()?.userId ?? ""

  /**
   * The org's role NAMES, so a capability category that is really a role
   * ("clevel") reads as the role ("C-Level").
   *
   * There are exactly two roles listings: `/admin/roles`, gated on
   * `kernel:users:admin`, and the share picker's `/knowledge/roles`, which any
   * member holding a knowledge read may call. Both are tried, in that order,
   * and a viewer who holds neither is not left with a mangled slug: the chip
   * falls back to a neutral word with the identifier in its title.
   */
  const [roleNames] = createResource<string[]>(async () => {
    const paths = hasScope("kernel:users:admin")
      ? ["/admin/roles", "/knowledge/roles"]
      : ["/knowledge/roles"]
    for (const path of paths) {
      try {
        const res = await api.get<any>(path)
        const rows = res?.data ?? res
        if (!Array.isArray(rows)) continue
        const names = rows.map((r: any) => str(r?.name)).filter((n: string) => n.length > 0)
        if (names.length > 0) return names
      } catch {
        // Refused or absent: try the next one, then give up quietly.
      }
    }
    return []
  })

  /** @base is a template: it is never added to a channel, and neither is an
   *  agent whose kind nothing has established yet. */
  const canCorrespond = () =>
    props.canCorrespond ?? (props.detail?.kind !== undefined && props.detail.kind !== "system")

  /** The gate the thread header applies today: a thread admin, or the person
   *  who created the room. */
  const canAdminThreads = () => hasScope("kernel:threads:admin") || hasScope("kernel:admin")

  const candidates = createMemo(() => {
    const already = new Set(channels().map((c) => c.id))
    return allThreads()
      .filter((t) => !already.has(t.id))
      .filter((t) => isChannel(t, me()))
      .filter((t) => canAdminThreads() || t.createdBy === me())
  })

  async function addToChannel(threadId: string, name: string, handle: string) {
    if (!props.agentId) return
    setAddError(null)
    try {
      // An AGENT seat names `agentId`. Posting the agent's id as `userId`
      // resolved to no user at all: the route answered 404 and the row was
      // marked added anyway, so the page claimed a seat that was never written.
      await api.post(`/threads/${threadId}/participants`, { agentId: props.agentId })
    } catch (err) {
      setAddError(err instanceof Error ? err.message : i18n.t("kernel.agents.addToChannelFailed"))
      return
    }
    setAdded((rows) => [...rows, { id: threadId, handle, name }])
    setAddOpen(false)
  }

  return (
    <div data-testid="agent-overview" class="flex flex-col gap-6 px-4 py-4 text-[13px]">
      <section>
        <h2 class="text-[12px] font-medium uppercase tracking-wide text-text-tertiary">
          {i18n.t("kernel.agents.purpose")}
        </h2>
        <p data-testid="agent-overview-purpose" class="mt-1 text-text-secondary">
          <Show when={props.detail?.purpose} fallback={defaultPurpose(props.detail, i18n.t)}>
            {props.detail?.purpose}
          </Show>
        </p>
      </section>

      <section>
        <h2 class="text-[12px] font-medium uppercase tracking-wide text-text-tertiary">
          {i18n.t("kernel.agents.charter")}
        </h2>
        <p class="mt-1 text-text-secondary">
          {i18n.t("kernel.agents.charterBody", {
            name: props.agentName || i18n.t("kernel.agents.thisAgent"),
          })}
        </p>
        <button
          type="button"
          data-testid="agent-overview-toggle-instructions"
          onClick={() => setShowInstructions((v) => !v)}
          class="mt-2 min-h-9 rounded-md border border-border-subtle px-2.5 text-[12px] text-text-secondary hover:bg-surface-hover"
        >
          {showInstructions()
            ? i18n.t("kernel.agents.hideInstructions")
            : i18n.t("kernel.agents.showInstructions")}
        </button>
        <Show when={showInstructions()}>
          <pre
            data-testid="agent-overview-instructions"
            class="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-surface p-3 text-[12px] text-text-secondary"
          >
            <Show
              when={definition()?.systemPrompt}
              fallback={i18n.t("kernel.agents.instructionsEmpty")}
            >
              {definition()?.systemPrompt}
            </Show>
          </pre>
        </Show>
      </section>

      <section>
        <h2 class="text-[12px] font-medium uppercase tracking-wide text-text-tertiary">
          {i18n.t("kernel.agents.capabilities")}
        </h2>
        <div data-testid="agent-overview-capabilities" class="mt-1.5 flex flex-wrap gap-1.5">
          <For
            each={props.detail?.capabilityCategories ?? []}
            fallback={
              <span class="text-text-tertiary">{i18n.t("kernel.agents.capabilitiesEmpty")}</span>
            }
          >
            {(category) => (
              <Chip
                tone="accent"
                data-testid={`agent-overview-capability-${category}`}
                title={categoryChip(category, i18n.t, roleNames() ?? []).title}
              >
                {categoryChip(category, i18n.t, roleNames() ?? []).label}
              </Chip>
            )}
          </For>
        </div>
      </section>

      <section>
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="text-[12px] font-medium uppercase tracking-wide text-text-tertiary">
            {i18n.t("kernel.agents.channels")}
          </h2>
          {/* The candidates live in the shared menu primitive, not as bare
              text under the list: a popover the keyboard can reach (the
              trigger opens it, arrows move, Enter selects, Escape closes) and
              that is closed until it is asked for. */}
          <Show when={canCorrespond() && candidates().length > 0}>
            <PopupMenu open={addOpen()} onOpenChange={setAddOpen}>
              <PopupMenu.Trigger
                aria-label={i18n.t("kernel.agents.addToChannel")}
                data-testid="agent-overview-add-to-channel"
              >
                <span class="flex min-h-9 items-center rounded-md border border-border-subtle px-2.5 text-[12px] text-text-secondary hover:bg-surface-hover">
                  {i18n.t("kernel.agents.addToChannel")}
                </span>
              </PopupMenu.Trigger>
              <PopupMenu.Content
                aria-label={i18n.t("kernel.agents.addToChannel")}
                class="w-64"
                data-testid="agent-overview-channel-picker"
              >
                <For each={candidates()}>
                  {(thread) => (
                    <PopupMenu.Item
                      data-testid={`agent-overview-add-${thread.id}`}
                      textValue={thread.title ?? thread.handle}
                      onSelect={() =>
                        void addToChannel(thread.id, thread.title ?? thread.handle, thread.handle)
                      }
                    >
                      <span class="truncate">{thread.title || thread.handle}</span>
                    </PopupMenu.Item>
                  )}
                </For>
              </PopupMenu.Content>
            </PopupMenu>
          </Show>
        </div>
        <ul data-testid="agent-overview-channels" class="mt-1.5 flex flex-col gap-1">
          <For
            each={channels()}
            fallback={<li class="text-text-tertiary">{i18n.t("kernel.agents.channelsEmpty")}</li>}
          >
            {(channel) => (
              <li data-testid={`agent-overview-channel-${channel.id}`} class="text-text-secondary">
                {channel.name || channel.handle}
              </li>
            )}
          </For>
        </ul>
        <Show when={addError()}>
          {(text) => (
            <p data-testid="agent-overview-add-error" class="mt-1.5 text-[12px] text-amber-500">
              {text()}
            </p>
          )}
        </Show>
      </section>

      <section>
        <p data-testid="agent-overview-last-activity" class="text-text-tertiary">
          {formatActivity(i18n.t, props.detail?.lastActivityAt ?? null, i18n.locale())}
        </p>
      </section>
    </div>
  )
}

export default AgentOverviewTab
