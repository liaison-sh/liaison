// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The month-end run inside its approval card. Every row is a draft with no number yet; a click
// opens it where it is, with the document editor's own fields, and the total and "Approve N"
// follow what is typed. A run that changed since the panel was drawn says what changed and who
// changed it, and offers to approve what is there now.
import { app, fetch as hostFetch, navigate, onEntityChange } from "@liaison/host"
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, type Component } from "solid-js"
import { type DraftDocument, Editor, rollupTotals } from "./Editor"
import { tr } from "./i18n"
import { formatMoneyMinor } from "./kit"
import {
  type Amounts,
  approveSummary,
  type CardItem,
  changedBy,
  foldRows,
  numberCell,
  rightsOf,
  type RunRow,
  runChanges,
  waitingSentence,
} from "./month-end"

export interface MonthEndRunPanelProps {
  approvalId?: string
  status?: string
  payload?: { run_id?: string; items?: CardItem[] }
  payloadHash?: string
  canDecide?: boolean
  viewerScopes?: string[]
}

interface RunRead {
  run: { id: string; issue_on: string | null; period: string | null; status: string }
  rows: RunRow[]
}

const money = (v: bigint, currency: string) => formatMoneyMinor(v, currency)

/** The month a run bills, read from its period label (`November 2026` → `November`). */
const monthOf = (period: string | null | undefined) => (period ?? "").split(" ")[0] || tr("this month")

async function loadRun(runId: string): Promise<RunRead | null> {
  const res = await app.invokeTool<(RunRead & { status: string }) | { status: "error" }>("recurring_run_get", { run_id: runId })
  return res && res.status === "completed" ? (res as RunRead) : null
}

async function loadDraft(id: string): Promise<DraftDocument | null> {
  const { loadEditorDocument, mapDocumentToDraft } = await import("./index")
  const d = await loadEditorDocument(id)
  return mapDocumentToDraft(d.document, d.lines)
}

/** Names of the people a run's rows mention, best effort: a name that cannot be read is left out. */
async function loadNames(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const id of ids) {
    try {
      const res = await hostFetch<{ data?: { name?: string }; name?: string }>(`/api/users/${encodeURIComponent(id)}/preview`)
      const name = res?.data?.name ?? res?.name
      if (name) out.set(id, name)
    } catch {
      // Unknown here: the row says "a teammate".
    }
  }
  return out
}

export const MonthEndRunPanel: Component<MonthEndRunPanelProps> = (props) => {
  const runId = () => props.payload?.run_id ?? null
  const items = () => props.payload?.items ?? []
  const rights = () => rightsOf(props.viewerScopes ?? [], props.canDecide === true)
  const [run, setRun] = createSignal<RunRead | null>(null)
  const [failed, setFailed] = createSignal(false)
  const [names, setNames] = createSignal<Map<string, string>>(new Map())
  const [openId, setOpenId] = createSignal<string | null>(null)
  const [openDraft, setOpenDraft] = createSignal<DraftDocument | null>(null)
  const [typed, setTyped] = createSignal<Map<string, Amounts>>(new Map())
  const [query, setQuery] = createSignal("")
  const [showFolded, setShowFolded] = createSignal(false)
  const [takingOut, setTakingOut] = createSignal<string | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [discussion, setDiscussion] = createSignal<string | null>(null)
  // The card as first drawn: a later change is listed against it until the person reads it.
  const [shownItems, setShownItems] = createSignal<CardItem[] | null>(null)
  let save: ((extra?: Record<string, unknown>) => Promise<boolean>) | null = null
  let saveError: (() => string | null) | null = null

  const refresh = async () => {
    const id = runId()
    if (!id) return
    try {
      const read = await loadRun(id)
      setFailed(read === null)
      if (!read) return
      setRun(read)
      if (shownItems() === null) setShownItems(items())
      const people = new Set<string>()
      for (const r of read.rows) {
        if (r.account_manager) people.add(r.account_manager)
        const who = r.latest_change?.actor_user_id
        if (typeof who === "string") people.add(who)
      }
      const missing = [...people].filter((p) => !names().has(p))
      if (missing.length > 0) setNames(new Map([...names(), ...(await loadNames(missing))]))
    } catch {
      setFailed(true)
    }
  }

  onMount(() => void refresh())
  // Live: a draft written anywhere, or the run itself, re-reads the rows.
  const stop = onEntityChange(["invoicing:document", "invoicing:recurring_run", "invoicing:recurring_run_item"], () => void refresh())
  onCleanup(stop)
  // The card itself changed (its rows were rewritten): read the rows again.
  createEffect(
    on(
      () => items().map((i) => `${i.item_id}:${i.content_hash}`).join(","),
      () => void refresh(),
      { defer: true },
    ),
  )

  const rows = () => run()?.rows ?? []
  const summary = createMemo(() => approveSummary(rows(), items(), typed()))
  const fold = createMemo(() => foldRows(rows(), query()))
  const month = () => monthOf(run()?.run.period)
  const changes = createMemo(() => {
    const before = shownItems()
    if (!before) return null
    const diff = runChanges(before, items(), rows(), names())
    return diff.changes.length > 0 ? diff : null
  })
  const waiting = () => rows().map(waitingSentence).filter((s): s is string => s !== null)

  const closeRow = () => {
    const id = openId()
    setOpenId(null)
    setOpenDraft(null)
    setTakingOut(null)
    setError(null)
    if (id) {
      const next = new Map(typed())
      next.delete(id)
      setTyped(next)
    }
  }

  const openRow = async (row: RunRow) => {
    if (openId() === row.item_id) return
    closeRow()
    if (!row.draft_id) return
    setOpenId(row.item_id)
    try {
      setOpenDraft(await loadDraft(row.draft_id))
    } catch (e) {
      setError(e instanceof Error ? e.message : tr("The request failed."))
    }
  }

  const onTyped = (row: RunRow, d: DraftDocument) => {
    const t = rollupTotals(d.lines, !!d.prices_include_tax)
    const next = new Map(typed())
    next.set(row.item_id, { net: t.subtotal_minor, vat: t.tax_total_minor, total: t.grand_total_minor })
    setTyped(next)
  }

  const saveRow = async (row: RunRow, applies: "this_month" | "from_now_on" | null) => {
    if (!save) return
    const ok = await save({
      ...(applies ? { applies } : {}),
      ...(row.updated_at ? { if_unchanged_since: row.updated_at } : {}),
    })
    if (!ok) {
      setError(saveError?.() ?? tr("The request failed."))
      return
    }
    closeRow()
    await refresh()
  }

  const call = async (tool: string, args: Record<string, unknown>) => {
    setError(null)
    const res = await app.invokeTool<{ status?: string; error?: { message?: string } }>(tool, args)
    if (res?.status === "error") {
      setError(res.error?.message ?? tr("The request failed."))
      return
    }
    closeRow()
    await refresh()
  }

  const ask = (row: RunRow) => {
    const who = row.account_manager ? names().get(row.account_manager) : null
    setDiscussion(`${who ? `@${who} ` : ""}${row.customer ?? ""}: `)
  }

  const approveNow = async () => {
    if (!props.approvalId) return
    try {
      await app.decideApproval(props.approvalId, "approve", props.payloadHash)
      setShownItems(items())
    } catch (e) {
      setError(e instanceof Error ? e.message : tr("The request failed."))
    }
  }

  const approveLabel = () =>
    tr("Approve {{n}}, {{total}}", { n: summary().count, total: money(summary().total, summary().currency) })

  return (
    <section data-testid="month-end-panel" class="min-w-0 text-[12.5px]">
      <Show when={failed()}>
        <p data-testid="month-end-load-failed" class="text-text-secondary">
          {tr("The rows could not be read. The card above still says what approving does.")}
        </p>
      </Show>

      {/* What changed since this card was drawn, before anything else. */}
      <Show when={changes()}>
        {(c) => (
          <div data-testid="month-end-changed" class="mb-3 rounded border border-border p-2">
            <p class="font-medium text-text">{tr("This run changed since you opened it.")}</p>
            <ul class="mt-1 space-y-0.5 text-text-secondary">
              <For each={c().changes}>
                {(ch) => (
                  <li data-testid={`month-end-change-${ch.item_id}`}>
                    {ch.kind === "added"
                      ? tr("{{customer}} added", { customer: ch.customer })
                      : ch.kind === "removed"
                        ? tr("{{customer}} taken out", { customer: ch.customer })
                        : tr("{{customer}} changed", { customer: ch.customer })}
                    <Show when={ch.who}>{(w) => <>{` (${w()})`}</>}</Show>
                    {`: ${money(ch.before, summary().currency)} → ${money(ch.after, summary().currency)}`}
                  </li>
                )}
              </For>
            </ul>
            <p data-testid="month-end-changed-totals" class="mt-1 text-text-secondary">
              {tr("Total you saw: {{before}}, now {{after}}", {
                before: money(c().before, summary().currency),
                after: money(c().after, summary().currency),
              })}
            </p>
            <div class="mt-2 flex flex-wrap gap-2">
              <Show when={rights().approve && props.status === "pending"}>
                <button
                  type="button"
                  data-testid="month-end-approve-new"
                  class="min-h-11 rounded bg-accent px-3 text-white"
                  onClick={() => void approveNow()}
                >
                  {approveLabel()}
                </button>
              </Show>
              <button
                type="button"
                data-testid="month-end-changed-read"
                class="min-h-11 rounded border border-border px-3"
                onClick={() => setShownItems(items())}
              >
                {tr("Got it")}
              </button>
            </div>
          </div>
        )}
      </Show>

      {/* The count, the total, and who decides: at the top, before any row. */}
      <div data-testid="month-end-summary" class="flex flex-wrap items-baseline justify-between gap-2">
        <span data-testid="month-end-approve-count" class="font-medium text-text">
          {tr("{{n}} invoices to approve, {{total}} incl. VAT", {
            n: summary().count,
            total: money(summary().total, summary().currency),
          })}
        </span>
        <Show when={!rights().approve}>
          <span data-testid="month-end-who-decides" class="text-text-secondary">
            {tr("Someone who can approve invoices decides this card.")}
          </span>
        </Show>
      </div>
      <For each={waiting()}>
        {(line) => (
          <p data-testid="month-end-waiting" class="mt-1 text-text-secondary">
            {line}
          </p>
        )}
      </For>
      <Show when={error()}>
        <p data-testid="month-end-error" class="mt-1 text-error">
          {error()}
        </p>
      </Show>

      <p data-testid="month-end-first-line" class="mt-3 text-text">
        <strong>{tr("Drafts, no legal numbers yet.")}</strong>{" "}
        {tr("Everything here can still change: click a row to open it.")}
      </p>

      <Show when={rows().length > 20}>
        <input
          data-testid="month-end-search"
          type="search"
          class="mt-2 min-h-11 w-full rounded border border-border bg-surface px-2"
          placeholder={tr("Search by customer")}
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
      </Show>

      <ul data-testid="month-end-rows" class="mt-2 divide-y divide-border-subtle">
        <For each={showFolded() ? [...fold().shown, ...fold().folded] : fold().shown}>
          {(row) => {
            const amounts = () => typed().get(row.item_id) ?? null
            const manager = () =>
              row.account_manager ? (names().get(row.account_manager) ?? tr("a teammate")) : tr("None")
            const isOpen = () => openId() === row.item_id
            const shown = () => amounts() ?? { net: BigInt(row.net_minor), vat: BigInt(row.vat_minor), total: BigInt(row.total_minor) }
            const fromSchedule = () => !(row.flags.includes("Added") || row.latest_change?.source === "added")
            return (
              <li data-testid={`month-end-row-${row.item_id}`} data-state={row.state} class="min-w-0 py-2">
                <button
                  type="button"
                  data-testid={`month-end-row-open-${row.item_id}`}
                  class="flex min-h-11 w-full min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 text-left"
                  onClick={() => void openRow(row)}
                >
                  <span class="min-w-0 flex-1 basis-40 break-words font-medium text-text">{row.customer ?? tr("Customer")}</span>
                  <span data-testid={`month-end-row-manager-${row.item_id}`} class="text-text-secondary">
                    {tr("Account manager")}: {manager()}
                  </span>
                  <span data-testid={`month-end-row-total-${row.item_id}`} class="tabular-nums">
                    {money(shown().net, row.currency)} {tr("excl.")} · {money(shown().vat, row.currency)} {tr("VAT")} ·{" "}
                    {money(shown().total, row.currency)} {tr("incl.")}
                  </span>
                  <span data-testid={`month-end-row-number-${row.item_id}`} class="text-text-secondary">
                    {numberCell(row, run()?.run.issue_on ?? null)}
                  </span>
                </button>
                <div class="text-text-secondary">
                  <For each={row.flags}>{(f) => <span class="mr-2">{f}</span>}</For>
                  <Show when={changedBy(row.latest_change, names())}>{(w) => <span>{w()}</span>}</Show>
                </div>
                <Show when={isOpen()}>
                  <div data-testid={`month-end-row-editor-${row.item_id}`} class="mt-2 min-w-0 rounded border border-border">
                    <Show when={amounts() && amounts()?.total !== BigInt(row.total_minor)}>
                      <p data-testid={`month-end-row-unsaved-${row.item_id}`} class="px-3 pt-2 text-text-secondary">
                        {tr("Not saved yet. {{now}}, was {{was}}.", {
                          now: money(amounts()?.total ?? 0n, row.currency),
                          was: money(BigInt(row.total_minor), row.currency),
                        })}
                      </p>
                    </Show>
                    {/* Actions first: an open row's buttons sit above its fields. */}
                    <div class="flex flex-wrap gap-2 px-3 pt-2">
                      <Show when={rights().write}>
                        <Show
                          when={fromSchedule()}
                          fallback={
                            <button type="button" data-testid="month-end-row-save" class="min-h-11 rounded bg-accent px-3 text-white" onClick={() => void saveRow(row, null)}>
                              {tr("Save")}
                            </button>
                          }
                        >
                          <button type="button" data-testid="month-end-row-save-month" class="min-h-11 rounded bg-accent px-3 text-white" onClick={() => void saveRow(row, "this_month")}>
                            {tr("Save for {{month}} only", { month: month() })}
                          </button>
                          <button type="button" data-testid="month-end-row-save-on" class="min-h-11 rounded border border-border px-3" onClick={() => void saveRow(row, "from_now_on")}>
                            {tr("Save from now on")}
                          </button>
                        </Show>
                        <Show
                          when={row.state === "left_out"}
                          fallback={
                            <button type="button" data-testid="month-end-row-take-out" class="min-h-11 rounded border border-border px-3" onClick={() => setTakingOut(row.item_id)}>
                              {tr("Take out")}
                            </button>
                          }
                        >
                          <button type="button" data-testid="month-end-row-put-back" class="min-h-11 rounded border border-border px-3" onClick={() => void call("drafts_update", { draft_id: row.draft_id, put_back: true })}>
                            {tr("Put back")}
                          </button>
                        </Show>
                      </Show>
                      <button type="button" data-testid="month-end-row-ask" class="min-h-11 rounded border border-border px-3" onClick={() => ask(row)}>
                        {row.account_manager && names().get(row.account_manager)
                          ? tr("Ask {{name}}", { name: names().get(row.account_manager) ?? "" })
                          : tr("Ask in the discussion")}
                      </button>
                      <button type="button" data-testid="month-end-row-full-editor" class="min-h-11 rounded border border-border px-3" onClick={() => navigate(`/invoicing/editor/${row.draft_id}`)}>
                        {tr("Open the full editor")}
                      </button>
                      <button type="button" data-testid="month-end-row-cancel" class="min-h-11 rounded px-3" onClick={closeRow}>
                        {tr("Cancel")}
                      </button>
                    </div>
                    <Show when={takingOut() === row.item_id}>
                      <TakeOut
                        row={row}
                        month={month()}
                        fromSchedule={fromSchedule()}
                        onThisMonth={() => void call("drafts_discard", { draft_id: row.draft_id, applies: "this_month" })}
                        onEnd={(endsOn) => void call("drafts_discard", { draft_id: row.draft_id, applies: "end_schedule", ends_on: endsOn })}
                        onRemove={() => void call("drafts_discard", { draft_id: row.draft_id })}
                      />
                    </Show>
                    <Show when={openDraft()}>
                      {(d) => (
                        <Editor
                          compact
                          initial={d()}
                          documentId={row.draft_id ?? undefined}
                          readOnly={!rights().write}
                          onChange={(next) => onTyped(row, next)}
                          onReady={(api) => {
                            save = api.save
                            saveError = api.error
                          }}
                        />
                      )}
                    </Show>
                  </div>
                </Show>
              </li>
            )
          }}
        </For>
      </ul>
      <Show when={fold().foldLabel && !showFolded()}>
        <button type="button" data-testid="month-end-folded" class="mt-2 min-h-11 text-text-secondary underline" onClick={() => setShowFolded(true)}>
          {fold().foldLabel}
        </button>
      </Show>

      <Show when={runId()}>
        {(id) => <RunDiscussion runId={id()} prefill={discussion()} />}
      </Show>
    </section>
  )
}

/** Take out asks how far: this month only, or the schedule ends. An added row just goes. */
function TakeOut(props: {
  row: RunRow
  month: string
  fromSchedule: boolean
  onThisMonth: () => void
  onEnd: (endsOn: string) => void
  onRemove: () => void
}) {
  const [lastMonth, setLastMonth] = createSignal("")
  const endOfMonth = (ym: string) => {
    const [y, m] = ym.split("-").map(Number)
    if (!y || !m) return ""
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
    return `${ym}-${String(last).padStart(2, "0")}`
  }
  return (
    <div data-testid="month-end-take-out" class="mx-3 mt-2 space-y-2 rounded border border-border p-2">
      <Show
        when={props.fromSchedule}
        fallback={
          <button type="button" data-testid="month-end-take-out-remove" class="min-h-11 rounded border border-border px-3" onClick={props.onRemove}>
            {tr("Remove this added invoice")}
          </button>
        }
      >
        <div>
          <button type="button" data-testid="month-end-take-out-month" class="min-h-11 rounded border border-border px-3" onClick={props.onThisMonth}>
            {tr("Take out of {{month}}", { month: props.month })}
          </button>
          <p class="mt-1 text-text-secondary">{tr("No invoice for {{month}}. It comes back by itself next month.", { month: props.month })}</p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <label class="text-text-secondary">
            {tr("Last month billed")}{" "}
            <input
              data-testid="month-end-take-out-last-month"
              type="month"
              class="min-h-11 rounded border border-border bg-surface px-2"
              value={lastMonth()}
              onInput={(e) => setLastMonth(e.currentTarget.value)}
            />
          </label>
          <button
            type="button"
            data-testid="month-end-take-out-end"
            class="min-h-11 rounded border border-border px-3 disabled:opacity-55"
            disabled={!lastMonth()}
            onClick={() => props.onEnd(endOfMonth(lastMonth()))}
          >
            {tr("End the schedule")}
          </button>
        </div>
        <p class="text-text-secondary">
          {tr("Ending the schedule stops these invoices only: a card link or a subscription elsewhere keeps running until it is turned off there.")}
        </p>
      </Show>
    </div>
  )
}

/** The run's discussion, drawn by the host. "Ask" puts a mention in its box, never sends it. */
function RunDiscussion(props: { runId: string; prefill: string | null }) {
  let anchor: HTMLDivElement | undefined
  let handle: { dispose: () => void } | null = null
  const mount = (prefill: string | null) => {
    handle?.dispose()
    if (!anchor) return
    handle = app.mountEntityDiscussion(anchor as never, {
      entityType: "recurring_run",
      entityId: props.runId,
      testId: "month-end-discussion",
      ...(prefill ? { prefill } : {}),
    })
  }
  onMount(() => mount(props.prefill))
  // A new "Ask" reopens the box with the mention in it.
  let last = props.prefill
  const watch = createMemo(() => props.prefill)
  createMemo(() => {
    const p = watch()
    if (p !== last) {
      last = p
      mount(p)
    }
  })
  onCleanup(() => handle?.dispose())
  return (
    <div class="mt-3" data-testid="month-end-discussion-anchor" data-prefill={props.prefill ?? ""}>
      <h4 class="font-medium text-text">{tr("Discussion")}</h4>
      <div ref={anchor} />
    </div>
  )
}
