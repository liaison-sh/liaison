// SPDX-License-Identifier: FSL-1.1-ALv2
// The "Who can use it" choice (S20, prototype S-ACCESS): Everyone in the
// workspace, or only selected roles and people. One component for an app's
// access dialog and an organization MCP server's access, so both read and
// behave the same. Admins always have access, so the admin role is not offered.
// Controlled: the caller holds the mode and the lists and saves them.
import { type Component, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { roleDisplayName } from "~/lib/app-label"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { accessSummary } from "./access-summary"
import type { OrgAppAccessMode } from "./org-apps-store"
import { useWorkspaceRoles, type WorkspaceRole } from "./workspace-roles"

const M = "kernel.appManagement"
const USERS_PAGE = 100
const USERS_MAX_PAGES = 20

interface PersonRow {
  id: string
  name: string
  email?: string
  status?: string
}

/** The admin role: always has every app, never listed. */
export function isAdminRole(role: Pick<WorkspaceRole, "name">): boolean {
  return role.name.toLowerCase() === "admin"
}

export interface AccessValue {
  mode: OrgAppAccessMode
  roleIds: string[]
  userIds: string[]
}

export const AccessPicker: Component<{
  value: AccessValue
  onChange: (next: AccessValue) => void
  /** False when there is nothing to restrict; `restrictHint` says why. */
  canRestrict?: boolean
  restrictHint?: string
  /** The data-testid prefix and radio group name (`app-access` by default). */
  idPrefix?: string
  /** The two choices side by side, for a one-line row in a dialog. */
  compact?: boolean
}> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const roles = useWorkspaceRoles()
  const prefix = () => props.idPrefix ?? "app-access"
  const canRestrict = () => props.canRestrict !== false
  const [query, setQuery] = createSignal("")

  const [people] = createResource(
    () => props.value.mode === "restricted",
    async () => {
      const all: PersonRow[] = []
      for (let page = 1; page <= USERS_MAX_PAGES; page++) {
        const rows = await api.get<PersonRow[]>(`/admin/users?limit=${USERS_PAGE}&page=${page}`, {
          suppressGlobalError: true,
        })
        const list = Array.isArray(rows) ? rows : []
        all.push(...list)
        if (list.length < USERS_PAGE) break
      }
      return all.filter((p) => !p.status || p.status === "active")
    },
  )

  const offeredRoles = createMemo(() => (roles() ?? []).filter((r) => !isAdminRole(r)))
  const roleName = (id: string) => {
    const r = (roles() ?? []).find((x) => x.id === id)
    return r ? roleDisplayName(r.name, i18n.t) : undefined
  }
  const person = (id: string) => (people() ?? []).find((p) => p.id === id)
  const matches = createMemo(() => {
    const q = query().trim().toLowerCase()
    if (!q) return []
    return (people() ?? [])
      .filter((p) => !props.value.userIds.includes(p.id))
      .filter((p) => `${p.name} ${p.email ?? ""}`.toLowerCase().includes(q))
      .slice(0, 8)
  })
  const summary = () => accessSummary(props.value, roleName, i18n.t)

  const set = (patch: Partial<AccessValue>) => props.onChange({ ...props.value, ...patch })
  function toggleRole(id: string): void {
    const list = props.value.roleIds
    set({ roleIds: list.includes(id) ? list.filter((x) => x !== id) : [...list, id] })
  }

  const radio = "mt-0.5 h-4 w-4 flex-none accent-[var(--color-accent)]"
  const hintId = () => `${prefix()}-no-scopes`

  return (
    <div data-testid={`${prefix()}-picker`}>
      <fieldset
        class="flex gap-2.5"
        classList={{ "flex-col": !props.compact, "flex-row flex-wrap gap-x-5": !!props.compact }}
      >
        <legend class="sr-only">{i18n.t(`${M}.whoCanUse`)}</legend>
        <label class="flex items-start gap-2 text-sm font-medium">
          <input
            type="radio"
            name={prefix()}
            class={radio}
            checked={props.value.mode === "everyone"}
            data-testid={`${prefix()}-everyone`}
            onChange={() => set({ mode: "everyone" })}
          />
          {i18n.t(`${M}.accessEveryone`)}
        </label>
        <label
          class="flex items-start gap-2 text-sm"
          classList={{ "cursor-default opacity-60": !canRestrict() }}
        >
          <input
            type="radio"
            name={prefix()}
            class={radio}
            checked={props.value.mode === "restricted"}
            disabled={!canRestrict()}
            aria-describedby={canRestrict() ? undefined : hintId()}
            data-testid={`${prefix()}-some`}
            onChange={() => set({ mode: "restricted" })}
          />
          <span>
            <span class="block font-medium">{i18n.t(`${M}.accessSome`)}</span>
            <Show when={!canRestrict() && props.restrictHint}>
              <span id={hintId()} class="block text-xs text-text-secondary" data-testid={hintId()}>
                {props.restrictHint}
              </span>
            </Show>
          </span>
        </label>
      </fieldset>

      <Show when={props.value.mode === "restricted"}>
        <div class="mt-4 flex flex-col gap-4">
          <fieldset>
            <legend class="mb-1.5 text-xs font-medium text-text-secondary">
              {i18n.t(`${M}.roles`)}
            </legend>
            <div class="flex flex-wrap gap-1.5">
              <For each={offeredRoles()}>
                {(role) => (
                  <button
                    type="button"
                    class="rounded-full border px-2.5 py-0.5 text-[12px]"
                    classList={{
                      "border-accent bg-accent/10 text-text": props.value.roleIds.includes(role.id),
                      "border-border text-text-secondary": !props.value.roleIds.includes(role.id),
                    }}
                    aria-pressed={props.value.roleIds.includes(role.id)}
                    data-testid={`${prefix()}-role-${role.id}`}
                    onClick={() => toggleRole(role.id)}
                  >
                    {roleDisplayName(role.name, i18n.t)}
                  </button>
                )}
              </For>
            </div>
          </fieldset>
          <div>
            <label
              class="mb-1.5 block text-xs font-medium text-text-secondary"
              for={`${prefix()}-person-search`}
            >
              {i18n.t(`${M}.peopleLabel`)}
            </label>
            <div class="flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-bg px-2 py-1">
              <For each={props.value.userIds}>
                {(id) => {
                  const label = () => person(id)?.name ?? id
                  return (
                    <span class="inline-flex items-center gap-1 rounded bg-surface px-1.5 py-0.5 text-xs">
                      {label()}
                      <button
                        type="button"
                        class="text-text-tertiary hover:text-text"
                        aria-label={i18n.t(`${M}.removePerson`, { name: label() })}
                        data-testid={`${prefix()}-person-remove-${id}`}
                        onClick={() =>
                          set({ userIds: props.value.userIds.filter((x) => x !== id) })
                        }
                      >
                        ×
                      </button>
                    </span>
                  )
                }}
              </For>
              <input
                id={`${prefix()}-person-search`}
                class="min-w-[8rem] flex-1 bg-transparent py-0.5 text-[13px] outline-none"
                placeholder={i18n.t(`${M}.addPerson`)}
                autocomplete="off"
                value={query()}
                data-testid={`${prefix()}-person-search`}
                onInput={(e) => setQuery(e.currentTarget.value)}
              />
            </div>
            <Show when={matches().length > 0}>
              <ul
                class="mt-1 overflow-hidden rounded-md border border-border bg-elevated"
                aria-label={i18n.t(`${M}.matchingPeople`)}
              >
                <For each={matches()}>
                  {(p) => (
                    <li>
                      <button
                        type="button"
                        class="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-[13px] hover:bg-surface-hover"
                        data-testid={`${prefix()}-person-add-${p.id}`}
                        onClick={() => {
                          set({ userIds: [...props.value.userIds, p.id] })
                          setQuery("")
                        }}
                      >
                        <span>{p.name}</span>
                        <span class="text-xs text-text-tertiary">{p.email}</span>
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </div>
          <p class="text-xs text-text-secondary">
            {i18n.t(`${M}.summary`)}{" "}
            <span class="font-medium text-text" data-testid={`${prefix()}-summary`}>
              {summary()}
            </span>
          </p>
        </div>
      </Show>
    </div>
  )
}
