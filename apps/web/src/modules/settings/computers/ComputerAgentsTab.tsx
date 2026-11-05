// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A COMPUTER'S AGENTS TAB (S10, S20, S25, L30, D14, D24): one table of the
// agents that can run on it. Each row: the agent, its level (Strict,
// Standard, Open; a raise is confirmed in the app, and a raise this computer
// has not confirmed yet says so with Confirm) and who may ask it. Edit opens
// who may ask it, the daily caps for other people's requests, the Liaison
// tools in its sessions, the risk note for its model, and Remove. "Add an
// agent" attaches one; a legend says what each level allows.
//
// Live: a `profile` or `attachment` frame reloads the table. A failed read is
// said, with Try again.

import { NODE_LEVELS, type NodeLevel } from "@liaison/shared"
import { Plus } from "lucide-solid"
import { type Component, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useAgentProfile } from "~/modules/nodes/agent-profile"
import {
  attachAgent,
  detachAgent,
  type NodeAttachmentSummary,
  type NodeProfileSummary,
  type NodeSummary,
  nodeAttachments,
  nodeProfiles,
  updateAttachment,
} from "~/modules/nodes/node-api"
import { onNodeChange } from "~/modules/nodes/nodes-store"
import { NodeCapsEditor } from "~/modules/settings/NodeCapsEditor"
import { useApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"
import { localizeAgentName } from "~/modules/threads/agent-name"
import { Button } from "~/ui/Button"
import { Skeleton } from "~/ui/Skeleton"
import { Switch as Toggle } from "~/ui/Switch"
import { type AgentRow, agentRowsFor } from "./computer-model"

interface AgentOption {
  id: string
  name: string
}

function agentOptions(raw: unknown): AgentOption[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((a: any) => ({
      id: typeof a?.id === "string" ? a.id : "",
      name: localizeAgentName(typeof a?.name === "string" ? a.name : (a?.displayName ?? "")),
    }))
    .filter((a) => a.id && a.name)
}

type SectionStatus = "loading" | "error" | "ready"

const target = "min-h-[44px] sm:min-h-0"
const grid = "sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_minmax(0,1fr)] sm:gap-4"

const AgentRowView: Component<{
  row: AgentRow
  node: NodeSummary
  agents: AgentOption[]
  onProfileSaved: (p: NodeProfileSummary) => void
  onAttachmentSaved: (a: NodeAttachmentSummary) => void
  onDetach: (id: string) => void
}> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [editing, setEditing] = createSignal(false)
  const [draft, setDraft] = createSignal<string[] | null>(null)
  const [requestersSaved, setRequestersSaved] = createSignal(false)
  const profile = useAgentProfile({
    agentId: props.row.agentId,
    agentName: props.row.agentName,
    agentModel: () => props.row.agentModel,
    profile: () => props.row.profile,
    nodeId: props.node.id,
    onSaved: props.onProfileSaved,
  })

  const levelName = (l: NodeLevel) => i18n.t(`kernel.nodeSessions.level.${l}`)
  const askers = (): string => {
    const a = props.row.attachment
    if (!a || a.allowedRequesters.length === 0) return i18n.t("kernel.computers.agents.onlyYou")
    return [
      i18n.t("kernel.computers.agents.you"),
      ...a.allowedRequesters.map((r) => localizeAgentName(r.name ?? r.id)),
    ].join(", ")
  }

  const draftOf = (a: NodeAttachmentSummary) =>
    draft() ?? a.allowedRequesters.filter((r) => r.type === "agent").map((r) => r.id)

  function toggleRequester(a: NodeAttachmentSummary, agentId: string, on: boolean): void {
    const current = new Set(draftOf(a))
    if (on) current.add(agentId)
    else current.delete(agentId)
    setDraft([...current])
    setRequestersSaved(false)
  }

  async function saveRequesters(a: NodeAttachmentSummary): Promise<void> {
    const users = a.allowedRequesters
      .filter((r) => r.type === "user")
      .map((r) => ({ type: "user" as const, id: r.id }))
    const agentIds = draftOf(a).map((id) => ({ type: "agent" as const, id }))
    try {
      const saved = await updateAttachment(api, a.id, {
        allowedRequesters: [...users, ...agentIds],
      })
      if (saved?.id) props.onAttachmentSaved(saved)
      setDraft(null)
      setRequestersSaved(true)
    } catch {
      addToast({ message: i18n.t("kernel.computers.actionFailed"), type: "error" })
    }
  }

  return (
    <li
      data-testid={`computer-agent-${props.row.agentId}`}
      data-level={profile.savedLevel()}
      data-attached={String(props.row.attachment !== null)}
      class="py-3"
    >
      <div class={`flex flex-col gap-2 ${grid} sm:items-start`}>
        <p class="min-w-0 pt-1 text-[14px] font-medium text-text">{props.row.agentName}</p>
        <div class="min-w-0">
          <label class="sr-only" for={`level-${props.row.agentId}`}>
            {i18n.t("kernel.computers.agents.levelLabel", { agent: props.row.agentName })}
          </label>
          <select
            id={`level-${props.row.agentId}`}
            data-testid={`computer-agent-level-${props.row.agentId}`}
            value={profile.level()}
            disabled={profile.status() === "saving"}
            onChange={(e) => void profile.choose(e.currentTarget.value as NodeLevel)}
            class="min-h-11 w-full rounded-sm border border-border bg-bg px-2 text-[13px] text-text sm:min-h-9 sm:w-auto"
          >
            <For each={[...NODE_LEVELS]}>
              {(l) => (
                <option value={l}>
                  {profile.suggested() === l
                    ? `${levelName(l)} (${i18n.t("kernel.computers.agents.suggested")})`
                    : levelName(l)}
                </option>
              )}
            </For>
          </select>
          <p class="mt-1 text-[12px] leading-relaxed text-text-secondary">
            {i18n.t(`kernel.computers.agents.short.${profile.level()}`)}
          </p>
          <Show when={profile.unconfirmedHere()}>
            {(here) => (
              <div
                data-testid={`computer-agent-unconfirmed-${props.row.agentId}`}
                class="mt-1 flex flex-col items-start gap-1.5"
              >
                <p class="text-[12px] leading-relaxed text-warning">
                  {i18n.t("kernel.computers.agents.unconfirmed", {
                    from: levelName(here().confirmedLevel),
                    node: props.node.name,
                  })}
                </p>
                <Button
                  variant="outline"
                  class={`w-auto shrink-0 ${target}`}
                  data-testid={`computer-agent-confirm-${props.row.agentId}`}
                  onClick={() => profile.confirmHere()}
                >
                  {i18n.t("kernel.computers.agents.confirm", {
                    level: levelName(profile.savedLevel()),
                  })}
                </Button>
              </div>
            )}
          </Show>
          <Show when={profile.status() === "saved"}>
            <p
              data-testid={`computer-agent-saved-${props.row.agentId}`}
              class="mt-1 text-[12px] text-text-secondary"
            >
              {i18n.t("kernel.computers.agents.levelSaved")}
            </p>
          </Show>
          <Show when={profile.status() === "error"}>
            <p class="mt-1 text-[12px] text-warning">{i18n.t("kernel.computers.actionFailed")}</p>
          </Show>
        </div>
        <div class="flex min-w-0 items-start justify-between gap-3 sm:pt-1">
          <p
            data-testid={`computer-agent-askers-${props.row.agentId}`}
            class="min-w-0 text-[13px] text-text"
          >
            {askers()}
          </p>
          <button
            type="button"
            data-testid={`computer-agent-edit-${props.row.agentId}`}
            aria-expanded={editing()}
            class={`${target} shrink-0 px-1 text-[12.5px] text-accent underline-offset-2 hover:underline`}
            onClick={() => setEditing(!editing())}
          >
            {editing()
              ? i18n.t("kernel.computers.agents.done")
              : i18n.t("kernel.computers.agents.edit")}
          </button>
        </div>
      </div>

      <Show when={editing()}>
        <div
          data-testid={`computer-agent-editor-${props.row.agentId}`}
          class="mt-3 flex flex-col gap-4 rounded-md border border-border-subtle bg-bg-subtle px-3 py-3"
        >
          <Show when={props.row.attachment}>
            {(a) => (
              <>
                <div class="flex flex-col gap-2">
                  <p class="text-[12.5px] font-medium text-text">
                    {i18n.t("kernel.computers.agents.requesters")}
                  </p>
                  <div
                    data-testid={`computer-requesters-${props.row.agentId}`}
                    class="flex flex-wrap gap-x-4 gap-y-1"
                  >
                    <For each={props.agents.filter((o) => o.id !== props.row.agentId)}>
                      {(agent) => (
                        <label class="flex min-h-11 items-center gap-1.5 text-[13px] text-text sm:min-h-0">
                          <input
                            type="checkbox"
                            data-testid={`computer-requester-${props.row.agentId}-${agent.id}`}
                            checked={draftOf(a()).includes(agent.id)}
                            onChange={(e) =>
                              toggleRequester(a(), agent.id, e.currentTarget.checked)
                            }
                          />
                          {agent.name}
                        </label>
                      )}
                    </For>
                  </div>
                  <div class="flex items-center gap-3">
                    <Button
                      variant="outline"
                      class={`w-auto shrink-0 ${target}`}
                      data-testid={`computer-requesters-save-${props.row.agentId}`}
                      onClick={() => void saveRequesters(a())}
                    >
                      {i18n.t("kernel.computers.agents.save")}
                    </Button>
                    <Show when={requestersSaved()}>
                      <span class="text-[12.5px] text-text-secondary">
                        {i18n.t("kernel.computers.agents.saved")}
                      </span>
                    </Show>
                  </div>
                </div>
                <NodeCapsEditor attachment={a()} onSaved={props.onAttachmentSaved} />
              </>
            )}
          </Show>
          <div class="flex items-center justify-between gap-4 text-[13px] text-text">
            <span>{i18n.t("kernel.nodeSessions.profile.liaisonTools")}</span>
            <div class="flex min-h-11 items-center sm:min-h-0">
              <Toggle
                data-testid={`computer-agent-tools-${props.row.agentId}`}
                checked={profile.liaisonTools()}
                disabled={profile.status() === "saving"}
                label={i18n.t("kernel.nodeSessions.profile.liaisonTools")}
                onChange={(on) => void profile.setTools(on)}
              />
            </div>
          </div>
          <p
            data-testid={`computer-agent-risk-${props.row.agentId}`}
            class="text-[12px] leading-relaxed text-text-secondary"
          >
            {i18n.t("kernel.computers.agents.riskNote", {
              level: levelName(profile.suggested()),
            })}
          </p>
          <Show when={props.row.attachment}>
            {(a) => (
              <div>
                <Button
                  variant="outline"
                  class={`w-auto shrink-0 ${target}`}
                  data-testid={`computer-agent-detach-${a().id}`}
                  onClick={() => props.onDetach(a().id)}
                >
                  {i18n.t("kernel.computers.agents.detach")}
                </Button>
              </div>
            )}
          </Show>
        </div>
      </Show>
      <profile.ConfirmDialog />
    </li>
  )
}

export const ComputerAgentsTab: Component<{ node: NodeSummary }> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [attachments, setAttachments] = createSignal<NodeAttachmentSummary[]>([])
  const [profiles, setProfiles] = createSignal<NodeProfileSummary[]>([])
  const [attachmentsStatus, setAttachmentsStatus] = createSignal<SectionStatus>("loading")
  const [profilesStatus, setProfilesStatus] = createSignal<SectionStatus>("loading")
  const [agents, setAgents] = createSignal<AgentOption[]>([])
  const [adding, setAdding] = createSignal(false)
  const [toAttach, setToAttach] = createSignal("")

  const failed = () => addToast({ message: i18n.t("kernel.computers.actionFailed"), type: "error" })

  async function loadAttachments(): Promise<void> {
    if (attachmentsStatus() !== "ready") setAttachmentsStatus("loading")
    try {
      setAttachments(await nodeAttachments(api))
      setAttachmentsStatus("ready")
    } catch {
      setAttachmentsStatus("error")
    }
  }

  async function loadProfiles(): Promise<void> {
    if (profilesStatus() !== "ready") setProfilesStatus("loading")
    try {
      setProfiles(await nodeProfiles(api))
      setProfilesStatus("ready")
    } catch {
      setProfilesStatus("error")
    }
  }

  async function loadAgents(): Promise<void> {
    try {
      setAgents(agentOptions(await api.get<unknown[]>("/agents")))
    } catch {
      // The add picker stays empty; nothing else depends on it.
      setAgents([])
    }
  }

  onMount(() => {
    void loadAttachments()
    void loadProfiles()
    void loadAgents()
    const off = onNodeChange((frame) => {
      if (frame.change === "profile") void loadProfiles()
      if (frame.change === "attachment") void loadAttachments()
    })
    onCleanup(off)
  })

  /** The table's two reads together, so Try again retries both. */
  const status = (): SectionStatus => {
    const a = attachmentsStatus()
    const p = profilesStatus()
    if (a === "error" || p === "error") return "error"
    if (a === "loading" || p === "loading") return "loading"
    return "ready"
  }

  function retry(): void {
    if (attachmentsStatus() === "error") void loadAttachments()
    if (profilesStatus() === "error") void loadProfiles()
  }

  const rows = createMemo(() => agentRowsFor(props.node.id, attachments(), profiles()))
  /** Rows are keyed by agent: a reload updates a row in place, keeping it open. */
  const lastRows = new Map<string, AgentRow>()
  const rowOf = (agentId: string) => {
    const row = rows().find((r) => r.agentId === agentId)
    if (row) lastRows.set(agentId, row)
    return row ?? lastRows.get(agentId)
  }
  const attachable = () => {
    const taken = new Set(rows().map((r) => r.agentId))
    return agents().filter((a) => !taken.has(a.id))
  }

  function replaceAttachment(saved: NodeAttachmentSummary): void {
    setAttachments(attachments().map((a) => (a.id === saved.id ? saved : a)))
  }

  function replaceProfile(saved: NodeProfileSummary): void {
    setProfiles([...profiles().filter((p) => p.agentId !== saved.agentId), saved])
  }

  async function attach(): Promise<void> {
    const agentId = toAttach()
    if (!agentId) return
    try {
      const created = await attachAgent(api, { agentId })
      if (created?.id) setAttachments([...attachments(), created])
      setToAttach("")
      setAdding(false)
    } catch {
      failed()
    }
  }

  async function detach(id: string): Promise<void> {
    try {
      await detachAgent(api, id)
      setAttachments(attachments().filter((a) => a.id !== id))
    } catch {
      failed()
    }
  }

  return (
    <div data-testid="computer-agents" class="flex flex-col gap-8">
      <section>
        <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div class="min-w-0">
            <h2 class="text-[15px] font-medium text-text">
              {i18n.t("kernel.computers.agents.title")}
            </h2>
            <p class="mt-1 max-w-[60ch] text-[12.5px] leading-relaxed text-text-secondary">
              {i18n.t("kernel.computers.agents.hint", { node: props.node.name })}
            </p>
          </div>
          <Show when={status() === "ready" && attachable().length > 0}>
            <Button
              variant="outline"
              class={`w-full shrink-0 sm:w-auto ${target}`}
              data-testid="computer-agents-add"
              aria-expanded={adding()}
              onClick={() => setAdding(!adding())}
            >
              <Plus size={15} aria-hidden="true" />
              {i18n.t("kernel.computers.agents.add")}
            </Button>
          </Show>
        </div>

        <Show when={adding()}>
          <div class="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
            <select
              data-testid="computer-agents-attach-agent"
              aria-label={i18n.t("kernel.computers.agents.add")}
              value={toAttach()}
              onChange={(e) => setToAttach(e.currentTarget.value)}
              class="min-h-11 rounded-sm border border-border bg-bg px-2 text-[13px] text-text sm:min-h-9"
            >
              <option value="">{i18n.t("kernel.computers.agents.choose")}</option>
              <For each={attachable()}>
                {(agent) => <option value={agent.id}>{agent.name}</option>}
              </For>
            </select>
            <Button
              variant="outline"
              class={`w-auto shrink-0 ${target}`}
              data-testid="computer-agents-attach-submit"
              disabled={!toAttach()}
              onClick={() => void attach()}
            >
              {i18n.t("kernel.computers.agents.attach")}
            </Button>
          </div>
        </Show>

        <Show when={status() === "loading"}>
          <div data-testid="computer-agents-loading" class="mt-4 flex flex-col gap-3">
            <Skeleton class="h-12 w-full" />
            <Skeleton class="h-12 w-full" />
          </div>
        </Show>
        <Show when={status() === "error"}>
          <div data-testid="computer-agents-error" class="mt-4 flex flex-wrap items-center gap-4">
            <p class="text-[13px] text-warning">{i18n.t("kernel.computers.sectionError")}</p>
            <Button variant="outline" class="w-auto shrink-0" onClick={retry}>
              {i18n.t("kernel.computers.retry")}
            </Button>
          </div>
        </Show>
        <Show when={status() === "ready"}>
          <Show
            when={rows().length > 0}
            fallback={
              <p data-testid="computer-agents-empty" class="mt-4 text-[13px] text-text-tertiary">
                {i18n.t("kernel.computers.agents.empty")}
              </p>
            }
          >
            <div
              aria-hidden="true"
              class={`mt-4 hidden border-b border-border-subtle pb-2 text-[11.5px] font-medium uppercase tracking-[0.08em] text-text-tertiary ${grid}`}
            >
              <span>{i18n.t("kernel.computers.agents.colAgent")}</span>
              <span>{i18n.t("kernel.computers.agents.colLevel")}</span>
              <span>{i18n.t("kernel.computers.agents.colAskers")}</span>
            </div>
            <ul
              data-testid="computer-agents-list"
              class="flex flex-col divide-y divide-border-subtle border-b border-border-subtle max-sm:mt-4 max-sm:border-t"
            >
              <For each={rows().map((r) => r.agentId)}>
                {(agentId) => (
                  <AgentRowView
                    row={rowOf(agentId) as AgentRow}
                    node={props.node}
                    agents={agents()}
                    onProfileSaved={replaceProfile}
                    onAttachmentSaved={replaceAttachment}
                    onDetach={(id) => void detach(id)}
                  />
                )}
              </For>
            </ul>
          </Show>
        </Show>
      </section>

      <section data-testid="computer-agents-legend" class="flex flex-col gap-2">
        <For each={[...NODE_LEVELS]}>
          {(l) => (
            <p class="text-[12.5px] leading-relaxed text-text-secondary">
              <span class="font-medium text-text">{i18n.t(`kernel.nodeSessions.level.${l}`)}</span>{" "}
              {i18n.t(`kernel.computers.agents.legend.${l}`)}
            </p>
          )}
        </For>
      </section>
    </div>
  )
}
