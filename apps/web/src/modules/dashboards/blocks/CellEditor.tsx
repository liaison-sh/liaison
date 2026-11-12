// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One table cell being edited, by its column's type: a text, number, amount or date field
// (Enter or leaving the field saves, Escape cancels), a single choice as chips, multiple
// choices as boxes to tick, a person picked from the member directory, and a link picked from
// the records of the column's `linkTo` app (`GET /dashboards/tables/link-search`, as the person).
// A checkbox has no editor: the grid toggles it in place. The add form uses the same editors
// with `inline` (no autofocus, every change reported at once).
import {
  type Component,
  createEffect,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js"
import { cn } from "~/lib/cn"
import { useI18n } from "~/modules/i18n/i18n-context"
import { type AssignableMember, fetchAssignableMembers } from "~/modules/members/assignable-members"
import { useApi } from "~/modules/shell/ApiContext"
import {
  type LinkCell,
  type LinkPickItem,
  searchTableLinks,
  type TableColumn,
} from "../dashboards-client"
import { isLinkCell } from "./table-cells"
import { personName, rememberPeople } from "./table-people"

export interface CellEditorProps {
  column: TableColumn
  value: unknown
  /** The value as the editor holds it (raw text for a field; parsed by the caller). */
  onCommit: (value: unknown) => void
  onCancel?: () => void
  /** In the add form: no autofocus, each change is committed as it happens. */
  inline?: boolean
  testid: string
}

const FIELD =
  "h-7 w-full min-w-0 rounded border border-border bg-bg px-2 text-[13px] text-text outline-none focus:border-accent"
const SEARCH_DEBOUNCE_MS = 150

export const CellEditor: Component<CellEditorProps> = (props) => {
  switch (props.column.type) {
    case "choice":
      return <ChoiceEditor {...props} />
    case "choices":
      return <ChoicesEditor {...props} />
    case "checkbox":
      return <CheckboxEditor {...props} />
    case "person":
      return <PersonEditor {...props} />
    case "link":
      return <LinkEditor {...props} />
    default:
      return <FieldEditor {...props} />
  }
}

/** Text, number, amount (in the column's currency) and date. */
const FieldEditor: Component<CellEditorProps> = (props) => {
  const i18n = useI18n()
  let input: HTMLInputElement | undefined
  let done = false
  onMount(() => {
    if (!props.inline) {
      input?.focus()
      input?.select()
    }
  })
  const initial = () => {
    const v = props.value
    return v === null || v === undefined ? "" : String(v)
  }
  const commit = () => {
    if (done || props.inline) return
    done = true
    props.onCommit(input?.value ?? "")
  }
  const numeric = () => props.column.type === "number" || props.column.type === "amount"
  return (
    <span class="flex min-w-0 items-center gap-1">
      <input
        ref={input}
        data-testid={props.testid}
        type={props.column.type === "date" ? "date" : "text"}
        inputmode={numeric() ? "decimal" : undefined}
        aria-label={props.column.label}
        value={initial()}
        class={cn(FIELD, numeric() && "text-right tabular-nums")}
        onInput={(e) => {
          if (props.inline) props.onCommit(e.currentTarget.value)
        }}
        onKeyDown={(e) => {
          if (props.inline) return
          if (e.key === "Enter") {
            e.preventDefault()
            commit()
          } else if (e.key === "Escape") {
            e.preventDefault()
            done = true
            props.onCancel?.()
          }
        }}
        onBlur={commit}
      />
      <Show when={props.column.type === "amount" && props.column.currency}>
        <span
          class="shrink-0 text-[11.5px] text-text-tertiary"
          title={i18n.t("kernel.dashboards.tables.currency")}
        >
          {props.column.currency}
        </span>
      </Show>
    </span>
  )
}

/** One chip per choice; picking one saves it. The picked one is lit; picking it again clears it. */
const ChoiceEditor: Component<CellEditorProps> = (props) => {
  const i18n = useI18n()
  const [picked, setPicked] = createSignal(typeof props.value === "string" ? props.value : "")
  return (
    <fieldset
      data-testid={props.testid}
      aria-label={props.column.label}
      class="m-0 flex flex-wrap items-center gap-1 border-0 p-0"
      onKeyDown={(e) => {
        if (e.key === "Escape") props.onCancel?.()
      }}
    >
      <For each={props.column.choices ?? []}>
        {(choice, i) => (
          <button
            type="button"
            data-testid={`${props.testid}-choice-${i()}`}
            aria-pressed={picked() === choice}
            onClick={() => {
              const next = picked() === choice && !props.column.required ? "" : choice
              setPicked(next)
              props.onCommit(next)
            }}
            class={cn(
              "rounded-full border px-2 py-0.5 text-[12px] transition-colors",
              picked() === choice
                ? "border-accent-border bg-accent-glow text-text"
                : "border-border-subtle bg-surface-hover text-text-secondary hover:text-text",
            )}
          >
            {choice}
          </button>
        )}
      </For>
      <Show when={!props.inline}>
        <button
          type="button"
          data-testid={`${props.testid}-cancel`}
          onClick={() => props.onCancel?.()}
          class="px-1 text-[12px] text-text-tertiary hover:text-text-secondary"
        >
          {i18n.t("kernel.common.cancel")}
        </button>
      </Show>
    </fieldset>
  )
}

/** A box per choice; Done saves the ticked ones (in the add form each tick counts at once). */
const ChoicesEditor: Component<CellEditorProps> = (props) => {
  const i18n = useI18n()
  const [ticked, setTicked] = createSignal<string[]>(
    Array.isArray(props.value) ? props.value.map(String) : [],
  )
  const toggle = (choice: string) => {
    const has = ticked().includes(choice)
    const next = (props.column.choices ?? []).filter((c) =>
      c === choice ? !has : ticked().includes(c),
    )
    setTicked(next)
    if (props.inline) props.onCommit(next)
  }
  return (
    <fieldset
      data-testid={props.testid}
      aria-label={props.column.label}
      class="m-0 flex flex-wrap items-center gap-2 border-0 p-0"
    >
      <For each={props.column.choices ?? []}>
        {(choice, i) => (
          <label class="flex items-center gap-1 text-[12.5px] text-text-secondary">
            <input
              type="checkbox"
              data-testid={`${props.testid}-choice-${i()}`}
              checked={ticked().includes(choice)}
              onChange={() => toggle(choice)}
            />
            {choice}
          </label>
        )}
      </For>
      <Show when={!props.inline}>
        <button
          type="button"
          data-testid={`${props.testid}-done`}
          onClick={() => props.onCommit(ticked())}
          class="rounded border border-border px-2 py-0.5 text-[12px] text-text hover:bg-surface-hover"
        >
          {i18n.t("kernel.dashboards.tables.done")}
        </button>
        <button
          type="button"
          data-testid={`${props.testid}-cancel`}
          onClick={() => props.onCancel?.()}
          class="px-1 text-[12px] text-text-tertiary hover:text-text-secondary"
        >
          {i18n.t("kernel.common.cancel")}
        </button>
      </Show>
    </fieldset>
  )
}

/** Only the add form edits a checkbox this way; the grid toggles it in place. */
const CheckboxEditor: Component<CellEditorProps> = (props) => (
  <input
    type="checkbox"
    data-testid={props.testid}
    aria-label={props.column.label}
    checked={props.value === true}
    onChange={(e) => props.onCommit(e.currentTarget.checked)}
  />
)

/** A search field over results; picking one commits it. Shared by the person and link pickers. */
function SearchPicker<R>(props: {
  testid: string
  label: string
  initialText: string
  search: (q: string) => Promise<R[]>
  key: (r: R) => string
  text: (r: R) => string
  sub?: (r: R) => string | undefined
  onPick: (r: R | null) => void
  onCancel?: () => void
  inline?: boolean
  clearable: boolean
}) {
  const i18n = useI18n()
  const [q, setQ] = createSignal("")
  const [results, setResults] = createSignal<R[]>([])
  const [status, setStatus] = createSignal<"idle" | "loading" | "ready" | "error">("idle")
  let seq = 0
  let input: HTMLInputElement | undefined
  onMount(() => {
    if (!props.inline) input?.focus()
  })
  createEffect(
    on(q, (query) => {
      const mine = ++seq
      const run = () => {
        setStatus("loading")
        props
          .search(query)
          .then((rows) => {
            if (mine !== seq) return
            setResults(rows)
            setStatus("ready")
          })
          .catch(() => {
            if (mine === seq) setStatus("error")
          })
      }
      if (!query.trim()) return run()
      const timer = setTimeout(run, SEARCH_DEBOUNCE_MS)
      onCleanup(() => clearTimeout(timer))
    }),
  )
  return (
    <div class="flex min-w-[12rem] flex-col gap-1">
      <input
        ref={input}
        data-testid={props.testid}
        type="text"
        aria-label={props.label}
        placeholder={props.initialText || i18n.t("kernel.dashboards.tables.search")}
        class={FIELD}
        value={q()}
        onInput={(e) => setQ(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault()
            props.onCancel?.()
          }
        }}
      />
      <Show when={status() === "error"}>
        <p data-testid={`${props.testid}-error`} class="text-[11.5px] text-text-tertiary">
          {i18n.t("kernel.dashboards.tables.searchFailed")}
        </p>
      </Show>
      <ul class="max-h-48 overflow-y-auto rounded border border-border-subtle bg-surface">
        <For each={results()}>
          {(r) => (
            <li>
              <button
                type="button"
                data-testid={`${props.testid}-option-${props.key(r)}`}
                onClick={() => props.onPick(r)}
                class="flex w-full flex-col items-start px-2 py-1 text-left text-[12.5px] text-text hover:bg-surface-hover"
              >
                <span class="truncate">{props.text(r)}</span>
                <Show when={props.sub?.(r)}>
                  {(s) => <span class="truncate text-[11px] text-text-tertiary">{s()}</span>}
                </Show>
              </button>
            </li>
          )}
        </For>
        <Show when={status() === "ready" && results().length === 0}>
          <li class="px-2 py-1 text-[12px] text-text-tertiary">
            {i18n.t("kernel.dashboards.tables.noResults")}
          </li>
        </Show>
      </ul>
      <Show when={!props.inline}>
        <div class="flex gap-2">
          <Show when={props.clearable && props.initialText}>
            <button
              type="button"
              data-testid={`${props.testid}-clear`}
              onClick={() => props.onPick(null)}
              class="text-[12px] text-text-tertiary hover:text-text-secondary"
            >
              {i18n.t("kernel.dashboards.tables.clear")}
            </button>
          </Show>
          <button
            type="button"
            data-testid={`${props.testid}-cancel`}
            onClick={() => props.onCancel?.()}
            class="text-[12px] text-text-tertiary hover:text-text-secondary"
          >
            {i18n.t("kernel.common.cancel")}
          </button>
        </div>
      </Show>
    </div>
  )
}

const PersonEditor: Component<CellEditorProps> = (props) => {
  const api = useApi()
  const [chosen, setChosen] = createSignal(typeof props.value === "string" ? props.value : "")
  return (
    <SearchPicker<AssignableMember>
      testid={props.testid}
      label={props.column.label}
      initialText={chosen() ? (personName(chosen()) ?? "") : ""}
      inline={props.inline}
      clearable={!props.column.required}
      search={async (q) => {
        const r = await fetchAssignableMembers(api, q, 8)
        rememberPeople(r.items)
        return r.items
      }}
      key={(m) => m.id}
      text={(m) => m.name || m.email}
      sub={(m) => (m.name ? m.email : undefined)}
      onPick={(m) => {
        setChosen(m?.id ?? "")
        props.onCommit(m ? m.id : null)
      }}
      onCancel={props.onCancel}
    />
  )
}

/** A picked record as a link cell: the search names its app and entity type. */
export function linkCellFrom(item: LinkPickItem): LinkCell {
  return { app: item.app, entityType: item.entityType, id: item.id, label: item.label }
}

const LinkEditor: Component<CellEditorProps> = (props) => {
  const api = useApi()
  const [chosen, setChosen] = createSignal<LinkCell | null>(
    isLinkCell(props.value) ? props.value : null,
  )
  return (
    <SearchPicker<LinkPickItem>
      testid={props.testid}
      label={props.column.label}
      initialText={chosen()?.label ?? ""}
      inline={props.inline}
      clearable={!props.column.required}
      search={(q) =>
        searchTableLinks(api, {
          app: props.column.linkTo?.app,
          entityType: props.column.linkTo?.entityType,
          q,
        })
      }
      key={(r) => r.id}
      text={(r) => r.label}
      onPick={(r) => {
        const cell = r ? linkCellFrom(r) : null
        setChosen(cell)
        props.onCommit(cell)
      }}
      onCancel={props.onCancel}
    />
  )
}
