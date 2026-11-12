// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The database connector's "Report access" block (custom block
// `DatabaseReportAccess` of the manifest `settings`): one row per domain of the
// connected catalog, its reads, the tier (the catalog's default marked), and the
// roles or people a confidential or restricted domain runs for. One Save writes
// the whole map (tool `report_access_set`).
//
// A domain left at its catalog default (or internal, with no default) and with
// nobody named carries no rule, so it follows the catalog. Rules for domains the
// catalog no longer has are kept as they are.

import { app } from "@liaison/host"
import { type Component, createSignal, For, onMount, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { type StringKey, t } from "./strings"

type Tier = "internal" | "confidential" | "restricted"
interface Rule {
  tier: Tier
  roles?: string[]
  users?: string[]
}
type Access = Record<string, Rule>
interface Entry {
  domain: string
  reads: Array<{ name: string; description: string }>
  catalogTier: Tier | null
  rule: Rule | null
  effectiveTier: Tier
}
interface Person {
  id: string
  name: string
  email: string
}
interface View {
  adapter: string | null
  domains: Entry[]
  domainAccess: Access
  roles: Array<{ id: string; name: string }>
  members: Person[]
}

const TIERS: Tier[] = ["internal", "confidential", "restricted"]
const TIER_KEY: Record<Tier, StringKey> = {
  internal: "tierInternal",
  confidential: "tierConfidential",
  restricted: "tierRestricted",
}
const control =
  "rounded-sm border border-border bg-surface px-2 py-1 text-[13px] text-text focus:outline-none"

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "error" in err) {
    const e = (err as { error?: { message?: string } }).error
    if (e?.message) return e.message
  }
  return err instanceof Error ? err.message : String(err)
}

/** A tool answer, or the `{ error }` it carries thrown. */
async function call<T>(tool: string, args: Record<string, unknown>): Promise<T> {
  const out = await app.invokeTool<T | { error: { message: string } }>(tool, args)
  if (out && typeof out === "object" && "error" in out) throw out
  return out as T
}

export const DatabaseReportAccess: Component = () => {
  const [view, setView] = createSignal<View | null>(null)
  const [people, setPeople] = createSignal<Person[]>([])
  const [loadError, setLoadError] = createSignal<string | null>(null)
  const [draft, setDraft] = createStore<Access>({})
  const [dirty, setDirty] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [saved, setSaved] = createSignal(false)
  const [saveError, setSaveError] = createSignal<string | null>(null)

  function adopt(next: View): void {
    setView(next)
    setPeople((known) => [
      ...next.members,
      ...known.filter((p) => !next.members.some((m) => m.id === p.id)),
    ])
    setDraft(reconcile(structuredClone(next.domainAccess)))
    setDirty(false)
  }

  onMount(async () => {
    try {
      adopt(await call<View>("report_access_get", {}))
    } catch (err) {
      setLoadError(errorMessage(err))
    }
  })

  const defaultTier = (entry: Entry): Tier => entry.catalogTier ?? "internal"
  const tierOf = (entry: Entry): Tier => draft[entry.domain]?.tier ?? defaultTier(entry)

  /** Writes a domain's rule, or drops it when it says no more than the catalog. */
  function setRule(entry: Entry, rule: Rule): void {
    const bare = !rule.roles?.length && !rule.users?.length
    if (bare && rule.tier === defaultTier(entry)) {
      setDraft(entry.domain, undefined as never)
    } else {
      setDraft(entry.domain, reconcile(rule))
    }
    setDirty(true)
    setSaved(false)
  }

  function changeTier(entry: Entry, tier: Tier): void {
    const current = draft[entry.domain]
    const rule: Rule = { tier }
    if (tier === "confidential" && current?.roles?.length) rule.roles = [...current.roles]
    if (tier === "restricted" && current?.users?.length) rule.users = [...current.users]
    setRule(entry, rule)
  }

  function toggle(entry: Entry, field: "roles" | "users", id: string, on: boolean): void {
    const tier: Tier = field === "roles" ? "confidential" : "restricted"
    const list = (draft[entry.domain]?.[field] ?? []).filter((x) => x !== id)
    if (on) list.push(id)
    setRule(entry, { tier, ...(list.length ? { [field]: list } : {}) })
  }

  async function addPerson(entry: Entry, email: string): Promise<string | null> {
    const found = await call<{ members: Person[] }>("report_access_find_people", {
      emails: [email.trim()],
    })
    const person = found.members[0]
    if (!person) return t("noSuchPerson")
    setPeople((known) => [...known.filter((p) => p.id !== person.id), person])
    toggle(entry, "users", person.id, true)
    return null
  }

  async function save(): Promise<void> {
    setSaving(true)
    setSaveError(null)
    try {
      const map: Access = {}
      for (const [domain, rule] of Object.entries(draft)) if (rule) map[domain] = rule
      adopt(await call<View>("report_access_set", { domainAccess: map }))
      setSaved(true)
    } catch (err) {
      setSaveError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const roleName = (id: string) => view()?.roles.find((r) => r.id === id)?.name ?? id
  const personName = (id: string) => {
    const p = people().find((m) => m.id === id)
    return p ? `${p.name} (${p.email})` : id
  }

  return (
    <div class="flex flex-col gap-4" data-testid="database-report-access">
      <Show when={loadError()}>
        {(message) => (
          <p class="text-xs text-error" data-testid="database-report-access-load-error">
            {t("loadFailed", { message: message() })}
          </p>
        )}
      </Show>
      <Show when={view()}>
        {(v) => (
          <>
            <p class="text-xs text-text-secondary">{t("intro")}</p>
            <p class="text-xs text-text-tertiary" data-testid="database-report-access-raw-note">
              {t("rawQueryNote")}
            </p>
            <Show
              when={v().domains.length > 0}
              fallback={
                <p class="text-xs text-text-tertiary" data-testid="database-report-access-empty">
                  {t(v().adapter ? "empty" : "noCatalog")}
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
                            {t("readCount", { count: entry.reads.length })}:{" "}
                            {entry.reads.map((r) => r.name).join(", ")}
                          </div>
                        </div>
                        <select
                          class={control}
                          aria-label={t("tierLabel", { domain: entry.domain })}
                          data-testid={`database-report-access-tier-${entry.domain}`}
                          value={tierOf(entry)}
                          onChange={(e) => changeTier(entry, e.currentTarget.value as Tier)}
                        >
                          <For each={TIERS}>
                            {(tier) => (
                              <option value={tier}>
                                {t(TIER_KEY[tier])}
                                {tier === defaultTier(entry) ? ` (${t("catalogDefault")})` : ""}
                              </option>
                            )}
                          </For>
                        </select>
                      </div>
                      <Show when={tierOf(entry) === "confidential"}>
                        <Chips
                          label={t("roles")}
                          testId={`database-report-access-roles-${entry.domain}`}
                          chosen={draft[entry.domain]?.roles ?? []}
                          nameOf={roleName}
                          options={v().roles.map((r) => ({ id: r.id, label: r.name }))}
                          addLabel={t("addRole")}
                          onAdd={(id) => toggle(entry, "roles", id, true)}
                          onRemove={(id) => toggle(entry, "roles", id, false)}
                        />
                      </Show>
                      <Show when={tierOf(entry) === "restricted"}>
                        <Chips
                          label={t("people")}
                          testId={`database-report-access-users-${entry.domain}`}
                          chosen={draft[entry.domain]?.users ?? []}
                          nameOf={personName}
                          options={[]}
                          addLabel={t("addPerson")}
                          onAdd={() => {}}
                          onRemove={(id) => toggle(entry, "users", id, false)}
                          onAddEmail={(email) => addPerson(entry, email)}
                        />
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
              <div class="flex items-center gap-3">
                <button
                  type="button"
                  class="rounded-sm bg-accent px-3 py-1 text-[13px] text-accent-foreground disabled:opacity-50"
                  disabled={!dirty() || saving()}
                  onClick={() => void save()}
                  data-testid="database-report-access-save"
                >
                  {t("save")}
                </button>
                <Show when={dirty()}>
                  <span class="text-xs text-text-tertiary">{t("unsaved")}</span>
                </Show>
                <Show when={saved() && !dirty()}>
                  <span
                    class="text-xs text-text-secondary"
                    data-testid="database-report-access-saved"
                  >
                    {t("saved")}
                  </span>
                </Show>
              </div>
              <Show when={saveError()}>
                {(message) => (
                  <p class="text-xs text-error" data-testid="database-report-access-save-error">
                    {t("saveFailed", { message: message() })}
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
  options: Array<{ id: string; label: string }>
  addLabel: string
  onAdd: (id: string) => void
  onRemove: (id: string) => void
  /** People are added by email: resolves to an error message, or null when added. */
  onAddEmail?: (email: string) => Promise<string | null>
}

const Chips: Component<ChipsProps> = (props) => {
  const [email, setEmail] = createSignal("")
  const [problem, setProblem] = createSignal<string | null>(null)
  const available = () => props.options.filter((o) => !props.chosen.includes(o.id))
  async function submitEmail(): Promise<void> {
    if (!props.onAddEmail || !email().trim()) return
    try {
      const error = await props.onAddEmail(email())
      setProblem(error)
      if (!error) setEmail("")
    } catch (err) {
      setProblem(errorMessage(err))
    }
  }
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
              aria-label={t("remove", { name: props.nameOf(id) })}
              data-testid={`${props.testId}-remove-${id}`}
              onClick={() => props.onRemove(id)}
            >
              ×
            </button>
          </span>
        )}
      </For>
      <Show when={props.chosen.length === 0}>
        <span class="text-xs text-text-tertiary">{t("nobodyYet")}</span>
      </Show>
      <Show when={available().length > 0}>
        <select
          class={control}
          aria-label={props.addLabel}
          data-testid={`${props.testId}-add`}
          value=""
          onChange={(e) => {
            const id = e.currentTarget.value
            if (id) props.onAdd(id)
            e.currentTarget.value = ""
          }}
        >
          <option value="">{props.addLabel}</option>
          <For each={available()}>{(o) => <option value={o.id}>{o.label}</option>}</For>
        </select>
      </Show>
      <Show when={props.onAddEmail}>
        <form
          class="inline-flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault()
            void submitEmail()
          }}
        >
          <input
            type="email"
            class={control}
            placeholder={t("emailPlaceholder")}
            aria-label={t("addByEmail")}
            data-testid={`${props.testId}-email`}
            value={email()}
            onInput={(e) => setEmail(e.currentTarget.value)}
          />
          <button
            type="submit"
            class="rounded-sm px-1.5 py-0.5 text-xs text-accent hover:bg-surface-hover"
            data-testid={`${props.testId}-add-email`}
          >
            {props.addLabel}
          </button>
        </form>
        <Show when={problem()}>
          {(message) => <span class="text-xs text-error">{message()}</span>}
        </Show>
      </Show>
    </div>
  )
}
