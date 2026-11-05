// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The database connector's "Report access" block (custom block
// `DatabaseReportAccess`, declared in the database manifest `settings`): one row
// per domain of the connected catalog, its reads, the tier (the catalog's
// default marked), and the roles or people a confidential or restricted domain
// runs for. The roles and people are chips with an add menu, as in the share
// dialog. One Save writes the whole map (PUT /api/database/domain-access).
//
// A domain left at its catalog default (or internal, with no default) and with
// nobody named carries no rule, so it follows the catalog. Rules for domains the
// catalog no longer has are kept as they are.

import type {
  DatabaseDomainAccess,
  DatabaseDomainAccessEntry,
  DatabaseDomainAccessView,
  DatabaseDomainRule,
  DatabaseDomainTier,
} from "@liaison/shared"
import { Plus, X } from "lucide-solid"
import { type Component, createSignal, For, onMount, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { cn } from "~/lib/cn"
import { useI18n } from "~/modules/i18n/i18n-context"
import { controlClass } from "~/modules/settings/app-page/fields"
import { useApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"
import { PopupMenu } from "~/ui/PopupMenu"
import { getDomainAccess, putDomainAccess } from "./database-api"

const P = "database.reportAccess"
const TIERS: DatabaseDomainTier[] = ["internal", "confidential", "restricted"]
const TIER_KEY: Record<DatabaseDomainTier, string> = {
  internal: `${P}.tierInternal`,
  confidential: `${P}.tierConfidential`,
  restricted: `${P}.tierRestricted`,
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const DatabaseReportAccess: Component = () => {
  const api = useApi()
  const i18n = useI18n()
  const [view, setView] = createSignal<DatabaseDomainAccessView | null>(null)
  const [loadError, setLoadError] = createSignal<string | null>(null)
  const [draft, setDraft] = createStore<DatabaseDomainAccess>({})
  const [dirty, setDirty] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [saved, setSaved] = createSignal(false)
  const [saveError, setSaveError] = createSignal<string | null>(null)

  function adopt(next: DatabaseDomainAccessView): void {
    setView(next)
    setDraft(reconcile(structuredClone(next.domainAccess)))
    setDirty(false)
  }

  onMount(async () => {
    try {
      adopt(await getDomainAccess(api))
    } catch (err) {
      setLoadError(errorMessage(err))
    }
  })

  const defaultTier = (entry: DatabaseDomainAccessEntry): DatabaseDomainTier =>
    entry.catalogTier ?? "internal"
  const tierOf = (entry: DatabaseDomainAccessEntry): DatabaseDomainTier =>
    draft[entry.domain]?.tier ?? defaultTier(entry)

  /** Writes a domain's rule, or drops it when it says no more than the catalog. */
  function setRule(entry: DatabaseDomainAccessEntry, rule: DatabaseDomainRule): void {
    const bare = !rule.roles?.length && !rule.users?.length
    if (bare && rule.tier === defaultTier(entry)) {
      setDraft(entry.domain, undefined as never)
    } else {
      setDraft(entry.domain, reconcile(rule))
    }
    setDirty(true)
    setSaved(false)
  }

  function changeTier(entry: DatabaseDomainAccessEntry, tier: DatabaseDomainTier): void {
    const current = draft[entry.domain]
    const rule: DatabaseDomainRule = { tier }
    if (tier === "confidential" && current?.roles?.length) rule.roles = [...current.roles]
    if (tier === "restricted" && current?.users?.length) rule.users = [...current.users]
    setRule(entry, rule)
  }

  function addRole(entry: DatabaseDomainAccessEntry, id: string): void {
    const roles = [...new Set([...(draft[entry.domain]?.roles ?? []), id])]
    setRule(entry, { tier: "confidential", roles })
  }
  function removeRole(entry: DatabaseDomainAccessEntry, id: string): void {
    const roles = (draft[entry.domain]?.roles ?? []).filter((r) => r !== id)
    setRule(entry, { tier: "confidential", ...(roles.length ? { roles } : {}) })
  }
  function addUser(entry: DatabaseDomainAccessEntry, id: string): void {
    const users = [...new Set([...(draft[entry.domain]?.users ?? []), id])]
    setRule(entry, { tier: "restricted", users })
  }
  function removeUser(entry: DatabaseDomainAccessEntry, id: string): void {
    const users = (draft[entry.domain]?.users ?? []).filter((u) => u !== id)
    setRule(entry, { tier: "restricted", ...(users.length ? { users } : {}) })
  }

  async function save(): Promise<void> {
    setSaving(true)
    setSaveError(null)
    try {
      const map: DatabaseDomainAccess = {}
      for (const [domain, rule] of Object.entries(draft)) if (rule) map[domain] = rule
      adopt(await putDomainAccess(api, map))
      setSaved(true)
    } catch (err) {
      setSaveError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const roleName = (id: string) => view()?.roles.find((r) => r.id === id)?.name ?? id
  const memberName = (id: string) => view()?.members.find((m) => m.id === id)?.name ?? id

  return (
    <div class="flex flex-col gap-4" data-testid="database-report-access">
      <Show when={loadError()}>
        {(message) => (
          <p class="text-xs text-error" data-testid="database-report-access-load-error">
            {i18n.t(`${P}.loadFailed`, { message: message() })}
          </p>
        )}
      </Show>
      <Show when={view()}>
        {(v) => (
          <>
            <p class="text-xs text-text-secondary">{i18n.t(`${P}.intro`)}</p>
            <p class="text-xs text-text-tertiary" data-testid="database-report-access-raw-note">
              {i18n.t(`${P}.rawQueryNote`)}
            </p>
            <Show
              when={v().domains.length > 0}
              fallback={
                <p class="text-xs text-text-tertiary" data-testid="database-report-access-empty">
                  {i18n.t(v().adapter ? `${P}.empty` : `${P}.noCatalog`)}
                </p>
              }
            >
              <ul class="flex flex-col divide-y divide-border rounded-sm border border-border">
                <For each={v().domains}>
                  {(entry) => (
                    <li
                      class="flex flex-col gap-2 p-3"
                      data-testid={`database-report-access-row-${entry.domain}`}
                    >
                      <div class="flex flex-wrap items-start justify-between gap-3">
                        <div class="min-w-0">
                          <div class="font-medium text-[13.5px]">{entry.domain}</div>
                          <div
                            class="text-xs text-text-tertiary"
                            title={entry.reads.map((r) => r.description).join("\n")}
                          >
                            {i18n.t(`${P}.readCount`, { count: entry.reads.length })}:{" "}
                            {entry.reads.map((r) => r.name).join(", ")}
                          </div>
                        </div>
                        <select
                          class={cn(controlClass, "w-auto")}
                          aria-label={i18n.t(`${P}.tierLabel`, { domain: entry.domain })}
                          data-testid={`database-report-access-tier-${entry.domain}`}
                          value={tierOf(entry)}
                          onChange={(e) =>
                            changeTier(entry, e.currentTarget.value as DatabaseDomainTier)
                          }
                        >
                          <For each={TIERS}>
                            {(tier) => (
                              <option value={tier}>
                                {i18n.t(TIER_KEY[tier])}
                                {tier === defaultTier(entry)
                                  ? ` (${i18n.t(`${P}.catalogDefault`)})`
                                  : ""}
                              </option>
                            )}
                          </For>
                        </select>
                      </div>
                      <Show when={tierOf(entry) === "confidential"}>
                        <Chips
                          label={i18n.t(`${P}.roles`)}
                          testId={`database-report-access-roles-${entry.domain}`}
                          chosen={draft[entry.domain]?.roles ?? []}
                          nameOf={roleName}
                          options={v().roles.map((r) => ({ id: r.id, label: r.name }))}
                          addLabel={i18n.t(`${P}.addRole`)}
                          onAdd={(id) => addRole(entry, id)}
                          onRemove={(id) => removeRole(entry, id)}
                        />
                      </Show>
                      <Show when={tierOf(entry) === "restricted"}>
                        <Chips
                          label={i18n.t(`${P}.people`)}
                          testId={`database-report-access-users-${entry.domain}`}
                          chosen={draft[entry.domain]?.users ?? []}
                          nameOf={memberName}
                          options={v().members.map((m) => ({
                            id: m.id,
                            label: `${m.name} (${m.email})`,
                          }))}
                          addLabel={i18n.t(`${P}.addPerson`)}
                          onAdd={(id) => addUser(entry, id)}
                          onRemove={(id) => removeUser(entry, id)}
                        />
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
              <div class="flex items-center gap-3">
                <Button
                  size="sm"
                  disabled={!dirty() || saving()}
                  onClick={() => void save()}
                  data-testid="database-report-access-save"
                >
                  {i18n.t(`${P}.save`)}
                </Button>
                <Show when={dirty()}>
                  <span class="text-xs text-text-tertiary">{i18n.t(`${P}.unsaved`)}</span>
                </Show>
                <Show when={saved() && !dirty()}>
                  <span
                    class="text-xs text-text-secondary"
                    data-testid="database-report-access-saved"
                  >
                    {i18n.t(`${P}.saved`)}
                  </span>
                </Show>
              </div>
              <Show when={saveError()}>
                {(message) => (
                  <p class="text-xs text-error" data-testid="database-report-access-save-error">
                    {i18n.t(`${P}.saveFailed`, { message: message() })}
                  </p>
                )}
              </Show>
            </Show>
          </>
        )}
      </Show>
    </div>
  )
}

interface ChipsProps {
  label: string
  testId: string
  chosen: string[]
  nameOf: (id: string) => string
  options: { id: string; label: string }[]
  addLabel: string
  onAdd: (id: string) => void
  onRemove: (id: string) => void
}

const Chips: Component<ChipsProps> = (props) => {
  const i18n = useI18n()
  const [open, setOpen] = createSignal(false)
  const available = () => props.options.filter((o) => !props.chosen.includes(o.id))
  return (
    <div class="flex flex-wrap items-center gap-2" data-testid={props.testId}>
      <span class="text-xs text-text-secondary">{props.label}</span>
      <For each={props.chosen}>
        {(id) => (
          <span
            class="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs"
            data-testid={`${props.testId}-chip-${id}`}
          >
            {props.nameOf(id)}
            <button
              type="button"
              class="text-text-tertiary hover:text-text"
              aria-label={i18n.t(`${P}.remove`, { name: props.nameOf(id) })}
              data-testid={`${props.testId}-remove-${id}`}
              onClick={() => props.onRemove(id)}
            >
              <X size={12} />
            </button>
          </span>
        )}
      </For>
      <Show when={props.chosen.length === 0}>
        <span class="text-xs text-text-tertiary">{i18n.t(`${P}.nobodyYet`)}</span>
      </Show>
      <Show when={available().length > 0}>
        <PopupMenu open={open()} onOpenChange={setOpen}>
          <PopupMenu.Trigger
            class="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs text-accent hover:bg-surface-hover"
            aria-label={props.addLabel}
            data-testid={`${props.testId}-add`}
          >
            <Plus size={12} />
            {props.addLabel}
          </PopupMenu.Trigger>
          <PopupMenu.Content>
            <For each={available()}>
              {(option) => (
                <PopupMenu.Item
                  onSelect={() => props.onAdd(option.id)}
                  data-testid={`${props.testId}-option-${option.id}`}
                >
                  {option.label}
                </PopupMenu.Item>
              )}
            </For>
          </PopupMenu.Content>
        </PopupMenu>
      </Show>
    </div>
  )
}

export default DatabaseReportAccess
