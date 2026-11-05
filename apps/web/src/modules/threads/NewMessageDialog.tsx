// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "New message", opened from the "+" beside the Direct messages header.
//
// One "To" field that finds the three things a member means by "write to":
//
//   - a conversation they ALREADY have (listed first, and as "Recent" before
//     anything is typed): pressing it opens it, nothing is created;
//   - an agent: pressing it opens the 1:1 with that agent through the same
//     idempotent `POST /threads/dm` the sidebar row uses;
//   - people: each becomes a chip, and several make a group DM.
//
// Once people are chosen the dialog says, BEFORE anything is pressed, whether
// a DM with exactly them exists. It is the same rule the API applies when it
// dedupes an untitled room (`findExistingPeopleDm`), so "Open conversation"
// never lands anywhere the server would not have.

import { X } from "lucide-solid"
import { createEffect, createMemo, createSignal, For, type JSX, onMount, Show } from "solid-js"
import { ambiguousNameKeys, foldName } from "~/lib/name-collision"
import { ComposerAssist } from "~/modules/assist/ComposerAssist"
import { DictationMic, RecorderRow } from "~/modules/assist/RecorderBar"
import { useDictation } from "~/modules/assist/useDictation"
import { userFromToken } from "~/modules/auth/auth-store"
import { tNow, useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { openTab } from "~/modules/shell/tab-store"
import { addToast } from "~/modules/shell/toast-store"
import {
  type AgentDisplay,
  listAgentDirectory,
  loadAgentDirectory,
} from "~/modules/threads/agent-directory"
import {
  conversationDisplayName,
  isChannel,
  namingAgentSeat,
} from "~/modules/threads/conversation-display"
import { findExistingPeopleDm, visibleDmIds } from "~/modules/threads/dm-dedupe"
import {
  closeNewConversationDialog,
  newConversationDialog,
} from "~/modules/threads/new-conversation-store"
import { createPeopleSearch, type PersonResult } from "~/modules/threads/people-search"
import { previewLine } from "~/modules/threads/system-line"
import {
  addThread,
  allThreads,
  requestThreadReload,
  type Thread,
} from "~/modules/threads/thread-store"
import { AgentGlyph } from "~/ui/AgentGlyph"
import { agentAvatarStyle, avatarColors } from "~/ui/avatar-palette"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"

/** How many existing conversations "Recent" offers before anything is typed. */
const RECENT_LIMIT = 6
/** How many conversation or agent matches a query lists. */
const MATCH_LIMIT = 4

type Option =
  | { kind: "conversation"; thread: Thread }
  | { kind: "agent"; agent: AgentDisplay }
  | { kind: "person"; person: PersonResult }

export default function NewMessageDialog() {
  return (
    <Show when={newConversationDialog() === "message"}>
      <NewMessageDialogContent />
    </Show>
  )
}

function NewMessageDialogContent() {
  const i18n = useI18n()
  const api = useApi()
  const me = () => userFromToken()?.userId ?? ""
  const [recipients, setRecipients] = createSignal<
    Array<{ id: string; name: string; email: string }>
  >([])
  const [message, setMessage] = createSignal("")
  let messageField: HTMLTextAreaElement | undefined
  const messageFieldDictation = useDictation({ target: () => messageField })
  const [active, setActive] = createSignal(0)
  const [busy, setBusy] = createSignal(false)
  const [agents, setAgents] = createSignal<AgentDisplay[]>(listAgentDirectory())
  onMount(() => void loadAgentDirectory(api).then(() => setAgents(listAgentDirectory())))

  const picked = createMemo(() => new Set([me(), ...recipients().map((r) => r.id)]))
  const search = createPeopleSearch(api, picked)
  const query = () => search.query().trim().toLowerCase()

  // Two colleagues sharing a display name are unremarkable; the dropdown row
  // and the chip that follows it only need the email when that ambiguity is
  // actually on screen. Each list is judged on its own: a name ambiguous
  // among the search results is not necessarily ambiguous among the people
  // already picked, and vice versa.
  const ambiguousResultNames = createMemo(() =>
    ambiguousNameKeys(search.results().map((p) => p.name)),
  )
  const ambiguousRecipientNames = createMemo(() =>
    ambiguousNameKeys(recipients().map((r) => r.name)),
  )

  /** Every DM the member has, one per counterpart, most recent first. */
  const dms = createMemo<Thread[]>(() => {
    const rows = allThreads().filter((t) => !isChannel(t, me()))
    const keep = visibleDmIds(rows, me())
    return rows
      .filter((t) => keep.has(t.id))
      .sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0))
  })
  const name = (t: Thread) => conversationDisplayName(t, me())

  /** Agents a member may open a DM with: the org's role agents and their own
   *  personal agent, never a colleague's. */
  const addressableAgents = createMemo(() =>
    agents().filter((a) => a.kind === "role" || (a.ownerUserId != null && a.ownerUserId === me())),
  )

  const options = createMemo<Option[]>(() => {
    const q = query()
    const out: Option[] = []
    // Once people are chosen, the field is building a group: only people.
    if (recipients().length === 0) {
      const convs = q
        ? dms()
            .filter((t) => name(t).toLowerCase().includes(q))
            .slice(0, MATCH_LIMIT)
        : dms().slice(0, RECENT_LIMIT)
      for (const t of convs) out.push({ kind: "conversation", thread: t })
      if (q) {
        // An agent already reached through a listed conversation is not
        // offered twice.
        const listed = new Set(
          convs.flatMap((t) =>
            t.participants.filter((p) => p.participantType === "agent").map((p) => p.agentId),
          ),
        )
        for (const a of addressableAgents()
          .filter(
            (a) =>
              !listed.has(a.id) &&
              (a.name.toLowerCase().includes(q) ||
                a.handle.replace(/^@/, "").toLowerCase().startsWith(q)),
          )
          .slice(0, MATCH_LIMIT)) {
          out.push({ kind: "agent", agent: a })
        }
      }
    }
    if (q) {
      for (const p of search.results()) out.push({ kind: "person", person: p })
    }
    return out
  })

  // The highlight follows the list: a new result set starts at the top.
  createEffect(() => {
    options()
    setActive(0)
  })

  const existing = createMemo(() =>
    findExistingPeopleDm(
      allThreads(),
      me(),
      recipients().map((r) => r.id),
    ),
  )
  const recipientNames = () =>
    recipients()
      .map((r) => r.name)
      .join(", ")

  function close() {
    closeNewConversationDialog()
  }

  function openThread(id: string, label: string) {
    openTab({ type: "thread", entityId: id, label, preview: false })
    close()
  }

  async function openAgentDm(agent: AgentDisplay) {
    if (busy()) return
    setBusy(true)
    try {
      const res: any = await api.post("/threads/dm", { agentId: agent.id })
      const dm = res?.data ?? res
      if (!dm?.id) throw new Error("no dm")
      addThread({
        id: dm.id,
        handle: dm.handle ?? "",
        title: null,
        discoverable: false,
        participants: [
          {
            id: agent.id,
            name: agent.name,
            avatarUrl: agent.avatarUrl,
            participantType: "agent",
            agentId: agent.id,
          },
        ],
      })
      requestThreadReload()
      openThread(dm.id, agent.name)
    } catch {
      addToast({ message: i18n.t("kernel.newConversation.startFailed"), type: "error" })
    } finally {
      setBusy(false)
    }
  }

  function choose(option: Option) {
    if (option.kind === "conversation") {
      openThread(option.thread.id, name(option.thread))
    } else if (option.kind === "agent") {
      void openAgentDm(option.agent)
    } else {
      setRecipients((all) => [
        ...all,
        { id: option.person.id, name: option.person.name, email: option.person.email },
      ])
      search.setQuery("")
    }
  }

  async function submit() {
    if (recipients().length === 0 || busy()) return
    const text = message().trim()
    const known = existing()
    if (known && !text) {
      openThread(known.id, name(known))
      return
    }
    setBusy(true)
    try {
      // The API dedupes an untitled room onto the existing one and forwards
      // the message there, so this is right whether or not `known` is set.
      const res: any = await api.post("/threads", {
        participantIds: recipients().map((r) => r.id),
        ...(text ? { initialMessage: { content: text } } : {}),
      })
      const thread = res?.data ?? res
      addThread(thread)
      requestThreadReload()
      openThread(
        thread.id,
        conversationDisplayName(
          {
            title: thread.title ?? null,
            type: thread.type,
            discoverable: thread.discoverable,
            participants: thread.participants ?? [],
          },
          me(),
        ),
      )
    } catch {
      addToast({ message: i18n.t("kernel.newConversation.startFailed"), type: "error" })
    } finally {
      setBusy(false)
    }
  }

  function onToKeyDown(e: KeyboardEvent) {
    const list = options()
    if (e.key === "ArrowDown" && list.length > 0) {
      e.preventDefault()
      setActive((i) => (i + 1) % list.length)
    } else if (e.key === "ArrowUp" && list.length > 0) {
      e.preventDefault()
      setActive((i) => (i - 1 + list.length) % list.length)
    } else if (e.key === "Enter") {
      e.preventDefault()
      const option = list[active()]
      // With nothing typed, Enter means "go": the chosen people are complete.
      if (option && (query() || recipients().length === 0)) choose(option)
      else if (recipients().length > 0) void submit()
    } else if (e.key === "Backspace" && search.query() === "" && recipients().length > 0) {
      setRecipients((all) => all.slice(0, -1))
    }
  }

  const lastLine = (t: Thread) => {
    const last = t.lastMessage?.content?.trim()
    return last ? previewLine(last, tNow, t.lastMessage?.metadata) : ""
  }

  return (
    <Dialog open={true} onOpenChange={(o) => !o && close()}>
      <Dialog.Content class="w-[480px] max-w-[min(480px,calc(100vw-2rem))] border-border bg-bg p-0 shadow-xl">
        <div class="flex items-center justify-between border-b border-border-subtle px-4 py-3">
          <Dialog.Title class="text-[14px]">
            {i18n.t("kernel.newConversation.newMessageTitle")}
          </Dialog.Title>
          <Dialog.Close
            class="text-text-tertiary transition-colors hover:text-text"
            aria-label={i18n.t("kernel.close")}
          >
            <X size={16} />
          </Dialog.Close>
        </div>

        <div class="space-y-3 p-4">
          <div class="flex flex-wrap items-center gap-1.5 rounded-md border border-border-subtle bg-surface px-2.5 py-1.5 focus-within:border-border">
            <span class="text-[12px] font-medium text-text-secondary">{i18n.t("kernel.to")}</span>
            <For each={recipients()}>
              {(r) => (
                <span
                  data-testid="new-message-recipient"
                  class="flex items-center gap-1 rounded-md bg-accent/15 px-2 py-0.5 text-[12px] text-accent"
                >
                  {ambiguousRecipientNames().has(foldName(r.name))
                    ? `${r.name} (${r.email})`
                    : r.name}
                  <button
                    type="button"
                    aria-label={i18n.t("kernel.newConversation.removePerson", { name: r.name })}
                    onClick={() => setRecipients((all) => all.filter((x) => x.id !== r.id))}
                    class="hover:text-accent-hover"
                  >
                    <X size={12} />
                  </button>
                </span>
              )}
            </For>
            <input
              data-testid="new-message-to"
              autofocus
              type="text"
              role="combobox"
              aria-expanded={options().length > 0}
              aria-controls="new-message-options"
              aria-activedescendant={
                options()[active()] ? `new-message-option-${active()}` : undefined
              }
              placeholder={
                recipients().length === 0
                  ? i18n.t("kernel.newConversation.toPlaceholder")
                  : i18n.t("kernel.newConversation.addMorePeople")
              }
              class="min-w-[120px] flex-1 bg-transparent text-[13px] text-text outline-none placeholder:text-text-tertiary"
              value={search.query()}
              onInput={(e) => search.setQuery(e.currentTarget.value)}
              onKeyDown={onToKeyDown}
            />
          </div>

          <Show when={options().length > 0}>
            <div
              id="new-message-options"
              role="listbox"
              class="max-h-64 overflow-y-auto rounded-md border border-border-subtle bg-surface py-1"
            >
              <For each={options()}>
                {(option, i) => (
                  <>
                    <Show when={i() === 0 || options()[i() - 1].kind !== option.kind}>
                      <div class="px-3 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.04em] text-text-tertiary">
                        {option.kind === "conversation"
                          ? query()
                            ? i18n.t("kernel.newConversation.conversations")
                            : i18n.t("kernel.newConversation.recent")
                          : option.kind === "agent"
                            ? i18n.t("kernel.newConversation.agents")
                            : i18n.t("kernel.newConversation.people")}
                      </div>
                    </Show>
                    <OptionRow
                      id={`new-message-option-${i()}`}
                      option={option}
                      active={active() === i()}
                      label={
                        option.kind === "conversation"
                          ? name(option.thread)
                          : option.kind === "agent"
                            ? option.agent.name
                            : option.person.name
                      }
                      detail={
                        option.kind === "conversation"
                          ? lastLine(option.thread)
                          : option.kind === "agent"
                            ? option.agent.handle.startsWith("@")
                              ? option.agent.handle
                              : `@${option.agent.handle}`
                            : ambiguousResultNames().has(foldName(option.person.name))
                              ? option.person.email
                              : ""
                      }
                      onHover={() => setActive(i())}
                      onChoose={() => choose(option)}
                    />
                  </>
                )}
              </For>
            </div>
          </Show>

          <Show when={recipients().length > 0}>
            <div
              data-testid="new-message-status"
              data-existing={existing() ? "true" : "false"}
              class="rounded-md bg-surface px-3 py-2 text-[12px] text-text-secondary"
            >
              <Show
                when={existing()}
                fallback={i18n.t("kernel.newConversation.startsNew", { names: recipientNames() })}
              >
                {(t) => (
                  <>
                    <div>
                      {i18n.t("kernel.newConversation.alreadyTalking", { names: recipientNames() })}
                    </div>
                    <Show when={lastLine(t())}>
                      <div class="mt-0.5 truncate text-text-tertiary">{lastLine(t())}</div>
                    </Show>
                  </>
                )}
              </Show>
            </div>
            <textarea
              ref={messageField}
              data-testid="new-message-body"
              rows={3}
              placeholder={i18n.t("kernel.newConversation.messagePlaceholder", {
                names: recipientNames(),
              })}
              class="w-full resize-none rounded-md border border-border-subtle bg-surface px-2.5 py-1.5 text-[13px] text-text outline-none placeholder:text-text-tertiary focus:border-border"
              value={message()}
              onInput={(e) => setMessage(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  void submit()
                }
              }}
            />
            {/* The wand stays with the field; the mic sits left of Send. */}
            <div class="-mt-1 flex justify-end gap-0.5">
              <ComposerAssist target={() => messageField} />
            </div>
          </Show>

          <Show when={options().length === 0 && recipients().length === 0}>
            <p class="px-1 text-[12px] text-text-tertiary">
              {query()
                ? i18n.t("kernel.newConversation.noMatch")
                : i18n.t("kernel.newConversation.toHelp")}
            </p>
          </Show>
        </div>

        {/* A take turns this footer into the recorder line. */}
        <div class="flex items-center justify-end gap-2 border-t border-border-subtle px-4 py-3">
          <RecorderRow dictation={messageFieldDictation}>
            <Button variant="outline" size="sm" onClick={close}>
              {i18n.t("kernel.common.cancel")}
            </Button>
            {/* The message field only exists once someone is picked. */}
            <Show when={recipients().length > 0}>
              <DictationMic dictation={messageFieldDictation} />
            </Show>
            <Button
              size="sm"
              data-testid="new-message-submit"
              onClick={() => void submit()}
              disabled={recipients().length === 0}
              loading={busy()}
            >
              {message().trim()
                ? i18n.t("kernel.newConversation.send")
                : existing()
                  ? i18n.t("kernel.newConversation.openConversation")
                  : i18n.t("kernel.newConversation.startConversation")}
            </Button>
          </RecorderRow>
        </div>
      </Dialog.Content>
    </Dialog>
  )
}

function OptionRow(props: {
  id: string
  option: Option
  active: boolean
  label: string
  detail: string
  onHover: () => void
  onChoose: () => void
}) {
  const me = () => userFromToken()?.userId ?? ""
  const isAgent = () =>
    props.option.kind === "agent" ||
    (props.option.kind === "conversation" && namingAgentSeat(props.option.thread, me()) !== null)
  const personStyle = () => {
    const c = avatarColors(props.option.kind === "person" ? props.option.person.id : props.label)
    return { "background-color": c.bg, color: c.text }
  }
  const mark = (): JSX.Element => {
    if (isAgent()) {
      return (
        <span
          class="flex h-6 w-6 items-center justify-center rounded-full"
          style={agentAvatarStyle(
            props.option.kind === "agent"
              ? props.option.agent.id
              : props.option.kind === "conversation"
                ? namingAgentSeat(props.option.thread, me())?.id
                : null,
            props.option.kind === "agent" ? props.option.agent.avatarColor : null,
          )}
        >
          <AgentGlyph />
        </span>
      )
    }
    return (
      <span
        class="flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-medium"
        style={personStyle()}
      >
        {props.label.charAt(0).toUpperCase()}
      </span>
    )
  }
  return (
    <button
      type="button"
      id={props.id}
      role="option"
      aria-selected={props.active}
      data-testid={`new-message-option-${props.option.kind}`}
      class={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${
        props.active ? "bg-surface-hover" : ""
      }`}
      onMouseEnter={props.onHover}
      onMouseDown={(e) => e.preventDefault()}
      onClick={props.onChoose}
    >
      {mark()}
      <span class="shrink-0 text-[13px] text-text">{props.label}</span>
      <span class="min-w-0 truncate text-[11px] text-text-tertiary">{props.detail}</span>
    </button>
  )
}
