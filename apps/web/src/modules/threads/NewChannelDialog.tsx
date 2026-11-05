// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "Create a channel", opened from the "+" beside the Channels header.
//
// A channel is a NAMED place: the name is the only required field, and the
// member creating it may be alone in it (people join a public channel, or are
// added later from the header). Public or private is a visible choice between
// two cards rather than a checkbox that only appeared once a title was typed.
//
// A NAME ALREADY IN USE is caught before anything is created: a channel the
// member is in offers "Open", a public one they are not in offers "Join".
// Private channels they cannot see are, by definition, not in the way.

import { normalizeChannelTitle } from "@liaison/shared"
import { Hash, Lock, X } from "lucide-solid"
import { createMemo, createSignal, For, type JSX, onMount, Show } from "solid-js"
import { ambiguousNameKeys, foldName } from "~/lib/name-collision"
import { userFromToken } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { openTab } from "~/modules/shell/tab-store"
import { addToast } from "~/modules/shell/toast-store"
import { isChannel } from "~/modules/threads/conversation-display"
import {
  closeNewConversationDialog,
  newConversationDialog,
} from "~/modules/threads/new-conversation-store"
import { createPeopleSearch } from "~/modules/threads/people-search"
import { addThread, allThreads, requestThreadReload } from "~/modules/threads/thread-store"
import { avatarColors } from "~/ui/avatar-palette"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"

/** The same bound the API puts on a title. */
const NAME_MAX = 200

interface PublicChannelRow {
  id: string
  handle: string
  title: string | null
  topic?: string | null
  description?: string | null
}

const sameName = (a: string, b: string) =>
  a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase()

export default function NewChannelDialog() {
  return (
    // Show gates mounting, so every opening starts from a clean form.
    <Show when={newConversationDialog() === "channel"}>
      <NewChannelDialogContent />
    </Show>
  )
}

function NewChannelDialogContent() {
  const i18n = useI18n()
  const api = useApi()
  const me = () => userFromToken()?.userId ?? ""
  const [name, setName] = createSignal("")
  const [isPublic, setIsPublic] = createSignal(true)
  const [people, setPeople] = createSignal<Array<{ id: string; name: string; email: string }>>([])
  const [publicChannels, setPublicChannels] = createSignal<PublicChannelRow[]>([])
  const [creating, setCreating] = createSignal(false)
  const [joining, setJoining] = createSignal(false)

  const picked = createMemo(() => new Set([me(), ...people().map((p) => p.id)]))
  const search = createPeopleSearch(api, picked)

  // As in the new-message picker: the email is only shown next to a name that
  // another candidate in the SAME list also carries.
  const ambiguousResultNames = createMemo(() =>
    ambiguousNameKeys(search.results().map((p) => p.name)),
  )
  const ambiguousPeopleNames = createMemo(() => ambiguousNameKeys(people().map((p) => p.name)))

  onMount(async () => {
    try {
      const res: any = await api.get("/threads/discoverable")
      const rows = res?.data ?? res
      setPublicChannels(Array.isArray(rows) ? rows : [])
    } catch {
      // Without the listing the name check covers joined channels only.
    }
  })

  /** What the server will store: no leading "#", no outer whitespace. */
  const trimmed = () => normalizeChannelTitle(name())

  /** A channel the member is already in, under this exact name. */
  const joinedClash = createMemo(() => {
    const n = trimmed()
    if (!n) return undefined
    return allThreads().find((t) => t.title && isChannel(t, me()) && sameName(t.title, n))
  })
  /** A public channel they could join instead, under this exact name. */
  const publicClash = createMemo(() => {
    const n = trimmed()
    if (!n || joinedClash()) return undefined
    const known = new Set(allThreads().map((t) => t.id))
    return publicChannels().find((c) => !known.has(c.id) && c.title && sameName(c.title, n))
  })
  const canCreate = () => trimmed().length > 0 && !joinedClash() && !publicClash()

  function close() {
    closeNewConversationDialog()
  }

  function openChannel(id: string, label: string) {
    openTab({ type: "thread", entityId: id, label, preview: false })
    close()
  }

  async function joinExisting(channel: PublicChannelRow) {
    if (joining()) return
    setJoining(true)
    try {
      await api.post(`/threads/${channel.id}/join`)
      addThread({
        id: channel.id,
        handle: channel.handle,
        title: channel.title,
        discoverable: true,
        topic: channel.topic ?? null,
        description: channel.description ?? null,
      })
      requestThreadReload()
      openChannel(channel.id, channel.title ?? channel.handle)
    } catch {
      addToast({ message: i18n.t("kernel.newConversation.joinFailed"), type: "error" })
    } finally {
      setJoining(false)
    }
  }

  async function create() {
    if (!canCreate() || creating()) return
    setCreating(true)
    try {
      const res: any = await api.post("/threads", {
        title: trimmed(),
        participantIds: people().map((p) => p.id),
        discoverable: isPublic(),
        // A new channel is a deliberate new room: the same people already
        // sharing another channel is normal, not the duplicate the guard is for.
        forceCreate: true,
      })
      const thread = res?.data ?? res
      addThread(thread)
      requestThreadReload()
      openChannel(thread.id, thread.title ?? trimmed())
    } catch {
      addToast({ message: i18n.t("kernel.newConversation.createChannelFailed"), type: "error" })
    } finally {
      setCreating(false)
    }
  }

  return (
    <Dialog open={true} onOpenChange={(o) => !o && close()}>
      <Dialog.Content class="w-[480px] max-w-[min(480px,calc(100vw-2rem))] border-border bg-bg p-0 shadow-xl">
        <div class="flex items-center justify-between border-b border-border-subtle px-4 py-3">
          <Dialog.Title class="text-[14px]">
            {i18n.t("kernel.newConversation.newChannelTitle")}
          </Dialog.Title>
          <Dialog.Close
            class="text-text-tertiary transition-colors hover:text-text"
            aria-label={i18n.t("kernel.close")}
          >
            <X size={16} />
          </Dialog.Close>
        </div>

        <form
          class="space-y-4 p-4"
          onSubmit={(e) => {
            e.preventDefault()
            void create()
          }}
        >
          <div>
            <label
              for="new-channel-name"
              class="mb-1 block text-[12px] font-medium text-text-secondary"
            >
              {i18n.t("kernel.newConversation.channelName")}
            </label>
            <div class="flex items-center gap-1.5 rounded-md border border-border-subtle bg-surface px-2.5 py-1.5 focus-within:border-border">
              <Show
                when={isPublic()}
                fallback={<Lock size={14} class="shrink-0 text-text-tertiary" />}
              >
                <Hash size={14} class="shrink-0 text-text-tertiary" />
              </Show>
              <input
                id="new-channel-name"
                data-testid="new-channel-name"
                autofocus
                type="text"
                maxLength={NAME_MAX}
                placeholder={i18n.t("kernel.newConversation.channelNamePlaceholder")}
                class="w-full bg-transparent text-[13px] text-text outline-none placeholder:text-text-tertiary"
                value={name()}
                onInput={(e) => setName(e.currentTarget.value)}
              />
            </div>
            <Show when={trimmed() !== name().trim() && trimmed().length > 0}>
              <div data-testid="new-channel-preview" class="mt-1.5 text-[12px] text-text-tertiary">
                {i18n.t("kernel.newConversation.channelNamePreview", { name: trimmed() })}
              </div>
            </Show>
            <Show when={joinedClash()}>
              {(t) => (
                <div
                  data-testid="new-channel-clash"
                  data-clash="joined"
                  class="mt-2 flex items-center justify-between gap-2 rounded-md bg-surface px-2.5 py-2 text-[12px] text-text-secondary"
                >
                  <span>{i18n.t("kernel.newConversation.alreadyInChannel")}</span>
                  <Button
                    size="sm"
                    variant="outline"
                    type="button"
                    onClick={() => openChannel(t().id, t().title ?? t().handle)}
                  >
                    {i18n.t("kernel.newConversation.openChannel")}
                  </Button>
                </div>
              )}
            </Show>
            <Show when={publicClash()}>
              {(c) => (
                <div
                  data-testid="new-channel-clash"
                  data-clash="public"
                  class="mt-2 flex items-center justify-between gap-2 rounded-md bg-surface px-2.5 py-2 text-[12px] text-text-secondary"
                >
                  <span>{i18n.t("kernel.newConversation.publicChannelExists")}</span>
                  <Button
                    size="sm"
                    variant="outline"
                    type="button"
                    loading={joining()}
                    onClick={() => void joinExisting(c())}
                  >
                    {i18n.t("kernel.newConversation.joinChannel")}
                  </Button>
                </div>
              )}
            </Show>
          </div>

          <fieldset>
            <legend class="mb-1 block text-[12px] font-medium text-text-secondary">
              {i18n.t("kernel.newConversation.visibility")}
            </legend>
            <div class="grid grid-cols-2 gap-2">
              <VisibilityCard
                testid="new-channel-public"
                selected={isPublic()}
                onSelect={() => setIsPublic(true)}
                icon={<Hash size={14} />}
                label={i18n.t("kernel.newConversation.public")}
                help={i18n.t("kernel.newConversation.publicHelp")}
              />
              <VisibilityCard
                testid="new-channel-private"
                selected={!isPublic()}
                onSelect={() => setIsPublic(false)}
                icon={<Lock size={14} />}
                label={i18n.t("kernel.newConversation.private")}
                help={i18n.t("kernel.newConversation.privateHelp")}
              />
            </div>
          </fieldset>

          <div>
            <label
              for="new-channel-people"
              class="mb-1 block text-[12px] font-medium text-text-secondary"
            >
              {i18n.t("kernel.newConversation.addPeople")}{" "}
              <span class="text-text-tertiary">{i18n.t("kernel.threadsUi.optional")}</span>
            </label>
            <div class="flex flex-wrap items-center gap-1.5 rounded-md border border-border-subtle bg-surface px-2.5 py-1.5 focus-within:border-border">
              <For each={people()}>
                {(p) => (
                  <span class="flex items-center gap-1 rounded-md bg-accent/15 px-2 py-0.5 text-[12px] text-accent">
                    {ambiguousPeopleNames().has(foldName(p.name))
                      ? `${p.name} (${p.email})`
                      : p.name}
                    <button
                      type="button"
                      aria-label={i18n.t("kernel.newConversation.removePerson", { name: p.name })}
                      onClick={() => setPeople((all) => all.filter((x) => x.id !== p.id))}
                      class="hover:text-accent-hover"
                    >
                      <X size={12} />
                    </button>
                  </span>
                )}
              </For>
              <input
                id="new-channel-people"
                data-testid="new-channel-people"
                type="text"
                placeholder={i18n.t("kernel.searchPeople")}
                class="min-w-[100px] flex-1 bg-transparent text-[13px] text-text outline-none placeholder:text-text-tertiary"
                value={search.query()}
                onInput={(e) => search.setQuery(e.currentTarget.value)}
                onKeyDown={(e) => {
                  // Enter in the people field picks the top match rather than
                  // submitting the form half filled in.
                  const top = search.results()[0]
                  if (e.key === "Enter" && top) {
                    e.preventDefault()
                    setPeople((all) => [...all, { id: top.id, name: top.name, email: top.email }])
                    search.setQuery("")
                    return
                  }
                  if (e.key === "Enter" && search.query().trim() !== "") {
                    e.preventDefault()
                    return
                  }
                  if (e.key === "Backspace" && search.query() === "" && people().length > 0) {
                    setPeople((all) => all.slice(0, -1))
                  }
                }}
              />
            </div>
            <Show when={search.results().length > 0}>
              <div class="mt-1 max-h-48 overflow-y-auto rounded-md border border-border-subtle bg-surface">
                <For each={search.results()}>
                  {(p) => (
                    <button
                      type="button"
                      data-testid="new-channel-person-result"
                      class="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-hover"
                      onClick={() => {
                        setPeople((all) => [...all, { id: p.id, name: p.name, email: p.email }])
                        search.setQuery("")
                      }}
                    >
                      <span
                        class="flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-medium"
                        style={{
                          "background-color": avatarColors(p.id).bg,
                          color: avatarColors(p.id).text,
                        }}
                      >
                        {p.name.charAt(0).toUpperCase()}
                      </span>
                      <span class="text-[13px] text-text">{p.name}</span>
                      <Show when={ambiguousResultNames().has(foldName(p.name))}>
                        <span class="truncate text-[11px] text-text-tertiary">{p.email}</span>
                      </Show>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>

          <div class="-mx-4 -mb-4 flex justify-end gap-2 border-t border-border-subtle px-4 py-3">
            <Button variant="outline" size="sm" type="button" onClick={close}>
              {i18n.t("kernel.common.cancel")}
            </Button>
            <Button size="sm" type="submit" disabled={!canCreate()} loading={creating()}>
              {i18n.t("kernel.newConversation.createChannel")}
            </Button>
          </div>
        </form>
      </Dialog.Content>
    </Dialog>
  )
}

function VisibilityCard(props: {
  testid: string
  selected: boolean
  onSelect: () => void
  icon: JSX.Element
  label: string
  help: string
}) {
  return (
    <label
      data-testid={props.testid}
      class={`flex cursor-pointer flex-col items-start gap-1 rounded-md border px-3 py-2 text-left transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent ${
        props.selected
          ? "border-accent bg-accent/10"
          : "border-border-subtle hover:bg-surface-hover"
      }`}
    >
      <input
        type="radio"
        name="new-channel-visibility"
        class="sr-only"
        checked={props.selected}
        onChange={props.onSelect}
      />
      <span class="flex items-center gap-1.5 text-[13px] font-medium text-text">
        {props.icon}
        {props.label}
      </span>
      <span class="text-[11px] leading-snug text-text-tertiary">{props.help}</span>
    </label>
  )
}
