// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "Add to group" (S15): a small menu over the contact groups, used on a
// contact's page (one contact, with ticks on the groups it is in) and on the
// list's multi-select (several contacts). A new group can be created from it
// and the contacts added in the same gesture.

import { Check, Plus, Users } from "lucide-solid"
import { type Component, createSignal, For, onMount, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"
import {
  addToGroup,
  createGroup,
  groups,
  groupsLoaded,
  loadGroups,
  removeFromGroup,
} from "./contact-groups-store"

interface AddToGroupMenuProps {
  contactIds: string[]
  /** Groups the contact is already in (single-contact use): shown ticked, and a
   *  click removes it from that group. */
  memberOf?: ReadonlySet<string>
  onChanged?: (groupId: string, added: boolean) => void
  onClose?: () => void
}

export const AddToGroupMenu: Component<AddToGroupMenuProps> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [creating, setCreating] = createSignal(false)
  const [name, setName] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  onMount(() => {
    if (!groupsLoaded()) void loadGroups(api as never)
  })

  async function toggle(groupId: string): Promise<void> {
    if (busy()) return
    setBusy(true)
    setError(null)
    try {
      const isMember = props.memberOf?.has(groupId) === true
      if (isMember) {
        await removeFromGroup(api as never, groupId, props.contactIds)
        props.onChanged?.(groupId, false)
      } else {
        await addToGroup(api as never, groupId, props.contactIds)
        props.onChanged?.(groupId, true)
        if (!props.memberOf) props.onClose?.()
      }
    } catch {
      setError(i18n.t("contacts.groups.addFailed"))
    } finally {
      setBusy(false)
    }
  }

  async function createAndAdd(): Promise<void> {
    const trimmed = name().trim()
    if (!trimmed || busy()) return
    setBusy(true)
    setError(null)
    try {
      const group = await createGroup(api as never, trimmed)
      await addToGroup(api as never, group.id, props.contactIds)
      props.onChanged?.(group.id, true)
      setName("")
      setCreating(false)
      if (!props.memberOf) props.onClose?.()
    } catch (err) {
      setError(
        err instanceof Error && err.message ? err.message : i18n.t("contacts.groups.createFailed"),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      data-testid="add-to-group-menu"
      role="menu"
      class="absolute right-0 z-20 mt-1 w-60 overflow-hidden rounded-md border border-border bg-elevated py-1 shadow-popover"
    >
      <Show
        when={groups().length > 0}
        fallback={
          <p class="px-3 py-2 text-[12px] text-text-tertiary">
            {i18n.t("contacts.groups.noGroupsYet")}
          </p>
        }
      >
        <ul class="max-h-60 overflow-y-auto">
          <For each={groups()}>
            {(group) => {
              const ticked = () => props.memberOf?.has(group.id) === true
              return (
                <li>
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={ticked() ? "true" : "false"}
                    data-testid={`add-to-group-${group.id}`}
                    disabled={busy()}
                    class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-text hover:bg-surface-hover disabled:opacity-60"
                    onClick={() => void toggle(group.id)}
                  >
                    <span class="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-accent">
                      <Show
                        when={ticked()}
                        fallback={<Users size={12} class="text-text-tertiary" />}
                      >
                        <Check size={13} />
                      </Show>
                    </span>
                    <span class="min-w-0 flex-1 truncate">{group.name}</span>
                  </button>
                </li>
              )
            }}
          </For>
        </ul>
      </Show>
      <div class="mt-1 border-t border-border-subtle pt-1">
        <Show
          when={creating()}
          fallback={
            <button
              type="button"
              data-testid="add-to-group-new"
              class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-text-secondary hover:bg-surface-hover hover:text-text"
              onClick={() => setCreating(true)}
            >
              <Plus size={13} />
              {i18n.t("contacts.groups.newGroup")}
            </button>
          }
        >
          <form
            class="flex items-center gap-1.5 px-2 py-1"
            onSubmit={(event) => {
              event.preventDefault()
              void createAndAdd()
            }}
          >
            <input
              data-testid="add-to-group-name"
              type="text"
              maxLength={80}
              placeholder={i18n.t("contacts.groups.groupName")}
              aria-label={i18n.t("contacts.groups.groupName")}
              class="min-w-0 flex-1 rounded-sm border border-border-subtle bg-bg px-2 py-1 text-[12.5px] text-text outline-none focus:border-border"
              value={name()}
              onInput={(event) => setName(event.currentTarget.value)}
              ref={(el) => queueMicrotask(() => el.focus())}
            />
            <Button
              type="submit"
              size="sm"
              data-testid="add-to-group-create"
              disabled={busy() || !name().trim()}
            >
              {i18n.t("contacts.groups.create")}
            </Button>
          </form>
        </Show>
      </div>
      <Show when={error()}>
        <p role="alert" class="px-3 py-1.5 text-[12px] text-danger">
          {error()}
        </p>
      </Show>
    </div>
  )
}
