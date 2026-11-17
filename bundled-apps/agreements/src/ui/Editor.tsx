// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The agreement editor: the paper on the left, the rail of fields and checks on the right,
// the actions on top. A clause an agent wrote carries a mark until a person reads it (or
// writes it themselves); the price is a person's own field, never filled by anyone else;
// Prepare is offered only once no blocking check fails and everything is saved. Editing a
// sent agreement says first that it makes a new version and withdraws the open links.
import { Button } from "@liaison/app-ui/kit"
import { onEntityChange } from "@liaison/host"
import {
  type Component,
  createEffect,
  createResource,
  createSignal,
  For,
  Match,
  on,
  Show,
  Switch,
} from "solid-js"
import { articleLabel } from "./DocumentText"
import { CHECK_WORDS } from "./Editor-words"
import { call, go, loadMembers, openPdfFile, paths } from "./host"
import { tr, uiLocale } from "./i18n"
import { StatusBadge } from "./List"
import {
  type AgreementDetail,
  type AgreementSource,
  addBlock,
  agentBlockCount,
  articleNumbers,
  blocksOf,
  canPrepare,
  clearAgentMark,
  editorChecks,
  editReplacesSent,
  formatMoney,
  isPricedKind,
  isTextBlock,
  latestVersion,
  layoutOf,
  type NewBlockKind,
  PREPARE_WHY,
  parsePrice,
  prepareWhy,
  removeBlock,
  setArticleHeading,
  setBlockText,
  setLayout,
} from "./model"
import { SigningOff } from "./signing"

const INPUT =
  "w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-[12.5px] text-text outline-none focus:border-accent-border"

const CURRENCIES = ["EUR", "USD", "GBP", "CHF", "CAD"]

export const AgreementEditor: Component<{ entityId?: string }> = (props) => {
  const id = () => props.entityId ?? ""
  const [detail, { refetch }] = createResource(id, async (agreementId) => {
    const out = await call<AgreementDetail>("agreement_get", { id: agreementId })
    if (!out.ok) throw new Error(out.message)
    return out.data
  })
  const loaded = () => (detail.error ? undefined : detail())
  // Another writer (the agent drafting the text, another tab) changed it: read it again.
  // Unsaved writing here is kept (the effect below leaves a dirty source alone).
  onEntityChange("agreements:agreement", (events) => {
    const ours = events.some(
      (e) => e.resync || (e.data as { agreement_id?: string } | null)?.agreement_id === id(),
    )
    if (ours) void refetch()
  })
  const [members] = createResource(loadMembers)
  const [source, setSource] = createSignal<AgreementSource | null>(null)
  const [dirty, setDirty] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [note, setNote] = createSignal<{ text: string; error: boolean } | null>(null)
  const [price, setPrice] = createSignal("")
  const [currency, setCurrency] = createSignal("EUR")
  const [title, setTitle] = createSignal("")
  const [whatItIs, setWhatItIs] = createSignal("")

  createEffect(
    on(loaded, (d) => {
      if (!d) return
      if (currency() === "EUR" && d.agreement.currency) setCurrency(d.agreement.currency)
      // A reload after another action (the price, who can see it) keeps unsaved writing.
      if (dirty()) return
      setSource(d.draft?.source ?? { body: { blocks: [] } })
      setTitle(d.agreement.title)
      setWhatItIs(d.agreement.what_it_is ?? "")
    }),
  )

  const edit = (next: AgreementSource) => {
    setSource(next)
    setDirty(true)
  }
  const checks = () => {
    const d = loaded()
    return d ? editorChecks(d, source()) : []
  }
  const failed = () => checks().filter((c) => c.blocking && !c.ok)
  const numbers = () => articleNumbers(blocksOf(source()))
  const say = (text: string, error = false) => setNote({ text, error })

  const save = async () => {
    const d = loaded()
    if (!d) return
    setBusy(true)
    setNote(null)
    const out = await call("agreement_update", {
      id: id(),
      ...(d.draft ? { lock_version: d.draft.lock_version } : {}),
      source: source(),
      ...(title().trim() && title().trim() !== d.agreement.title ? { title: title().trim() } : {}),
      ...(d.agreement.kind === "other" && whatItIs().trim() !== (d.agreement.what_it_is ?? "")
        ? { what_it_is: whatItIs().trim() }
        : {}),
    })
    setBusy(false)
    if (!out.ok) return say(out.message || tr("It could not be saved. Nothing was changed."), true)
    setDirty(false)
    say(tr("Saved."))
    void refetch()
  }

  const setThePrice = async () => {
    const minor = parsePrice(price(), currency())
    if (!minor) return say(tr("Type the price as a number, such as 38000 or 38,000.50."), true)
    setBusy(true)
    setNote(null)
    const out = await call("agreement_price_set", {
      id: id(),
      price_minor: minor,
      currency: currency(),
    })
    setBusy(false)
    if (!out.ok) return say(out.message || tr("The price could not be set."), true)
    setPrice("")
    say(tr("The price is set."))
    void refetch()
  }

  const setNotGuarantee = async (value: boolean) => {
    setBusy(true)
    const out = await call("agreement_update", { id: id(), not_a_guarantee: value })
    setBusy(false)
    if (!out.ok) return say(out.message, true)
    void refetch()
  }

  const setAccess = async (orgAccess: string, shares: Array<{ user_id: string; role: string }>) => {
    setBusy(true)
    const out = await call("agreement_update", { id: id(), org_access: orgAccess, shares })
    setBusy(false)
    if (!out.ok) return say(out.message || tr("Who can see it did not change."), true)
    void refetch()
  }

  const memberName = (userId: string) => members()?.find((m) => m.id === userId)?.name ?? userId

  return (
    <div data-testid="agreement-editor" class="flex h-full min-h-0 flex-col bg-bg">
      <Switch>
        <Match when={detail.error}>
          <p data-testid="agreement-editor-error" class="px-6 py-10 text-[13px] text-text">
            {tr("This agreement cannot be opened")}
          </p>
        </Match>
        <Match when={loaded()}>
          {(d) => {
            const a = () => d().agreement
            const editable = () => a().status === "draft" || editReplacesSent(a().status)
            // The document is a file: it is read and signed as that file, and a change
            // to it is another upload, never text added here.
            const isUpload = () => a().upload === true
            const uploadFile = () => latestVersion(d())?.file_id ?? null
            return (
              <>
                <header class="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle px-5 py-3">
                  <div class="flex min-w-0 items-center gap-2">
                    <span class="font-mono text-[12px] text-text-tertiary">{a().number}</span>
                    <StatusBadge status={a().status} kind={a().kind} />
                    <span class="truncate text-[13px] font-semibold text-text">{a().title}</span>
                  </div>
                  <div class="flex items-center gap-2">
                    <Button
                      testid="agreement-editor-back"
                      variant="ghost"
                      onClick={() => go(paths.agreement(id()))}
                    >
                      {tr("Back to the agreement")}
                    </Button>
                    <Show when={editable()}>
                      <Button
                        testid="agreement-editor-save"
                        disabled={busy() || !dirty()}
                        onClick={() => void save()}
                      >
                        {dirty() ? tr("Save") : tr("Saved")}
                      </Button>
                    </Show>
                    <Show when={a().status === "draft"}>
                      <Button
                        variant="primary"
                        testid="agreement-editor-prepare"
                        disabled={busy() || dirty() || !canPrepare(checks())}
                        title={dirty() ? tr("Save first") : undefined}
                        onClick={() => go(paths.send(id()))}
                      >
                        {tr("Prepare for signature")}
                      </Button>
                    </Show>
                  </div>
                </header>
                <SigningOff />
                {/* Why Prepare is greyed, said on screen rather than in a hover. */}
                <Show when={a().status === "draft" && !busy() && prepareWhy(dirty(), checks())}>
                  {(why) => (
                    <p
                      data-testid="agreement-editor-prepare-why"
                      class="border-b border-border-subtle px-5 py-1.5 text-[12px] text-text-secondary"
                    >
                      {tr(PREPARE_WHY[why()])}
                    </p>
                  )}
                </Show>
                <div class="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
                  <div class="min-h-0 flex-1 px-5 py-4 lg:overflow-y-auto pb-dock-runway">
                    <Show when={editReplacesSent(a().status)}>
                      <div
                        data-testid="agreement-editor-replaces"
                        class="mb-4 rounded-md border border-border-subtle bg-surface px-4 py-3 text-[12.5px]"
                      >
                        <p class="font-medium text-text">
                          {tr("This version went out for signature.")}
                        </p>
                        <p class="mt-1 text-text-secondary">
                          {tr(
                            "Saving a change makes a new version and withdraws its open links, so nobody signs what you did not approve. Signatures already given stay on the old version.",
                          )}
                        </p>
                      </div>
                    </Show>
                    <Show when={!editable()}>
                      <p
                        data-testid="agreement-editor-readonly"
                        class="mb-4 text-[12.5px] text-text-secondary"
                      >
                        {tr("This agreement no longer changes here.")}
                      </p>
                    </Show>
                    <Show when={note()}>
                      {(n) => (
                        <p
                          data-testid="agreement-editor-note"
                          role={n().error ? "alert" : "status"}
                          class={`mb-3 text-[12.5px] ${n().error ? "text-error" : "text-text-secondary"}`}
                        >
                          {n().text}
                        </p>
                      )}
                    </Show>
                    <Show when={editable()}>
                      <label class="mb-4 flex flex-col gap-1">
                        <span class="text-[10.5px] uppercase tracking-wider text-text-tertiary">
                          {tr("Title")}
                        </span>
                        <input
                          data-testid="agreement-editor-title"
                          class={INPUT}
                          value={title()}
                          onInput={(e) => {
                            setTitle(e.currentTarget.value)
                            setDirty(true)
                          }}
                        />
                      </label>
                    </Show>
                    <div class="flex flex-col gap-3" data-testid="agreement-editor-blocks">
                      <Show when={isUpload() && blocksOf(source()).length === 0}>
                        <div
                          data-testid="agreement-editor-upload"
                          class="flex flex-col gap-2 rounded-md border border-border-subtle bg-surface px-3 py-2 text-[12.5px] text-text-secondary"
                        >
                          <p>
                            {tr(
                              "This document is an uploaded PDF: it is read and signed as that file. A change to it is a new upload.",
                            )}
                          </p>
                          <Show when={uploadFile()}>
                            {(f) => (
                              <div>
                                <Button
                                  testid="agreement-editor-upload-open"
                                  onClick={() =>
                                    void openPdfFile(f(), `${a().number}.pdf`).then(
                                      (ok) => ok || say(tr("The file could not be opened."), true),
                                    )
                                  }
                                >
                                  {tr("Open the PDF")}
                                </Button>
                              </div>
                            )}
                          </Show>
                        </div>
                      </Show>
                      <Show when={!isUpload() && blocksOf(source()).length === 0}>
                        <p class="text-[12.5px] text-text-tertiary">
                          {tr(
                            "The document has no text yet. Add a block, or ask the agent to draft it.",
                          )}
                        </p>
                      </Show>
                      <For each={blocksOf(source())}>
                        {(b, i) => (
                          <div
                            data-testid={`agreement-block-${i()}`}
                            data-agent={b.agent_draft === true ? "true" : undefined}
                            class={`rounded-md border px-3 py-2 ${b.agent_draft === true ? "border-accent-border bg-accent-tint" : "border-border-subtle bg-surface"}`}
                          >
                            <Show when={b.agent_draft === true}>
                              <div class="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                                <span class="text-[11.5px] text-text-secondary">
                                  {tr("Draft, written by an agent. Read it to clear this mark.")}
                                </span>
                                <Show when={editable()}>
                                  <Button
                                    testid={`agreement-block-read-${i()}`}
                                    onClick={() => edit(clearAgentMark(source(), i()))}
                                  >
                                    {tr("I read it")}
                                  </Button>
                                </Show>
                              </div>
                            </Show>
                            <Switch>
                              <Match when={isTextBlock(b) && editable()}>
                                <Show when={b.type === "article"}>
                                  <div class="mb-1 flex items-center gap-2">
                                    <span class="shrink-0 text-[12px] font-semibold text-text-secondary">
                                      {articleLabel(
                                        numbers()[i()] ?? null,
                                        layoutOf(source()),
                                        Number(b.level ?? 1),
                                      )}
                                    </span>
                                    <input
                                      data-testid={`agreement-block-heading-${i()}`}
                                      class={INPUT}
                                      placeholder={tr("Heading")}
                                      value={typeof b.heading === "string" ? b.heading : ""}
                                      onInput={(e) =>
                                        edit(
                                          setArticleHeading(source(), i(), e.currentTarget.value),
                                        )
                                      }
                                    />
                                  </div>
                                </Show>
                                <textarea
                                  data-testid={`agreement-block-text-${i()}`}
                                  class={`${INPUT} ${b.type === "heading" ? "font-semibold" : ""}`}
                                  rows={b.type === "heading" ? 1 : 4}
                                  value={typeof b.text === "string" ? b.text : ""}
                                  onInput={(e) =>
                                    edit(setBlockText(source(), i(), e.currentTarget.value))
                                  }
                                />
                                <div class="mt-1 flex justify-end">
                                  <button
                                    type="button"
                                    data-testid={`agreement-block-remove-${i()}`}
                                    class="text-[11.5px] text-text-tertiary hover:text-text"
                                    onClick={() => edit(removeBlock(source(), i()))}
                                  >
                                    {tr("Remove")}
                                  </button>
                                </div>
                              </Match>
                              <Match when={isTextBlock(b)}>
                                <p class="whitespace-pre-wrap text-[12.5px] text-text">
                                  {typeof b.text === "string" ? b.text : ""}
                                </p>
                              </Match>
                              <Match when={true}>
                                <p class="text-[12px] italic text-text-tertiary">
                                  {tr(
                                    "A block from the template, filled when the document is drawn.",
                                  )}
                                </p>
                              </Match>
                            </Switch>
                          </div>
                        )}
                      </For>
                    </div>
                    <Show when={editable() && !isUpload()}>
                      <div
                        class="mt-3 flex flex-wrap items-center gap-2 text-[12px]"
                        data-testid="agreement-add-block"
                      >
                        <span class="text-text-tertiary">{tr("Add a block")}</span>
                        <For
                          each={
                            [
                              ["paragraph", "Text"],
                              ["heading", "Heading"],
                              ["article", "Article"],
                            ] as Array<[NewBlockKind, string]>
                          }
                        >
                          {([kind, label]) => (
                            <Button
                              testid={`agreement-add-${kind}`}
                              variant="ghost"
                              onClick={() => edit(addBlock(source(), kind))}
                            >
                              {tr(label)}
                            </Button>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>

                  <aside
                    data-testid="agreement-editor-rail"
                    class="flex w-full shrink-0 flex-col gap-5 border-t border-border-subtle px-5 py-4 lg:w-80 lg:overflow-y-auto lg:border-l lg:border-t-0 pb-dock-runway"
                  >
                    <Show when={isPricedKind(a().kind)}>
                      <section data-testid="agreement-price-panel">
                        <h2 class="mb-1 text-[12px] font-medium text-text">
                          {tr("The price is yours")}
                        </h2>
                        <Show
                          when={a().price_minor !== null}
                          fallback={
                            <p class="mb-2 text-[12px] text-text-tertiary">
                              {tr("No price yet. A person sets it here; an agent never does.")}
                            </p>
                          }
                        >
                          <p
                            data-testid="agreement-price-current"
                            class="mb-2 text-[12.5px] text-text"
                          >
                            {formatMoney(a().price_minor, a().currency, uiLocale())}{" "}
                            {tr("excl. VAT")}
                          </p>
                        </Show>
                        <Show when={a().status === "draft"}>
                          <div class="flex gap-2">
                            <input
                              data-testid="agreement-price-input"
                              class={INPUT}
                              inputmode="decimal"
                              placeholder={tr("Fixed price excl. VAT")}
                              aria-label={tr("Fixed price excl. VAT")}
                              value={price()}
                              onInput={(e) => setPrice(e.currentTarget.value)}
                            />
                            <select
                              data-testid="agreement-price-currency"
                              class="rounded-md border border-border bg-bg px-1.5 text-[12.5px] text-text"
                              aria-label={tr("Currency")}
                              value={currency()}
                              onChange={(e) => setCurrency(e.currentTarget.value)}
                            >
                              <For
                                each={
                                  CURRENCIES.includes(currency())
                                    ? CURRENCIES
                                    : [currency(), ...CURRENCIES]
                                }
                              >
                                {(c) => <option value={c}>{c}</option>}
                              </For>
                            </select>
                          </div>
                          <Button
                            class="mt-2"
                            testid="agreement-price-set"
                            disabled={busy() || price().trim() === ""}
                            onClick={() => void setThePrice()}
                          >
                            {tr("Set price")}
                          </Button>
                        </Show>
                      </section>
                    </Show>

                    <Show when={a().kind === "other"}>
                      <label class="flex flex-col gap-1">
                        <span class="text-[12px] font-medium text-text">{tr("What it is")}</span>
                        <input
                          data-testid="agreement-what-it-is"
                          class={INPUT}
                          value={whatItIs()}
                          disabled={!editable()}
                          onInput={(e) => {
                            setWhatItIs(e.currentTarget.value)
                            setDirty(true)
                          }}
                        />
                      </label>
                    </Show>

                    <Show when={editable()}>
                      <label class="flex flex-col gap-1">
                        <span class="text-[12px] font-medium text-text">{tr("Layout")}</span>
                        <select
                          data-testid="agreement-layout"
                          class="rounded-md border border-border bg-bg px-2 py-1.5 text-[12.5px] text-text"
                          value={layoutOf(source())}
                          onChange={(e) =>
                            edit(
                              setLayout(
                                source(),
                                e.currentTarget.value === "legal" ? "legal" : "standard",
                                uiLocale().startsWith("fr") ? "fr" : "en",
                              ),
                            )
                          }
                        >
                          <option value="standard">{tr("Standard")}</option>
                          <option value="legal">{tr("Classic legal layout")}</option>
                        </select>
                        <span class="text-[11px] text-text-tertiary">
                          {tr(
                            "Numbers, cross-references and page numbers are computed when it is drawn. Nobody types them.",
                          )}
                        </span>
                      </label>
                    </Show>

                    <section data-testid="agreement-access">
                      <h2 class="mb-1 text-[12px] font-medium text-text">
                        {tr("Who can see this")}
                      </h2>
                      <div class="flex flex-col gap-1 text-[12.5px] text-text">
                        <label class="flex items-center gap-2">
                          <input
                            type="radio"
                            name="agreement-access"
                            data-testid="agreement-access-everyone"
                            checked={a().org_access !== "none"}
                            disabled={busy() || a().status !== "draft"}
                            onChange={() => void setAccess("editor", d().shares)}
                          />
                          {tr("Everyone with Agreements")}
                        </label>
                        <label class="flex items-center gap-2">
                          <input
                            type="radio"
                            name="agreement-access"
                            data-testid="agreement-access-list"
                            checked={a().org_access === "none"}
                            disabled={busy() || a().status !== "draft"}
                            onChange={() => void setAccess("none", d().shares)}
                          />
                          {tr("Only these people")}
                        </label>
                      </div>
                      <Show when={a().org_access === "none" && a().status === "draft"}>
                        <ul class="mt-2 flex flex-col gap-1">
                          <For each={d().shares}>
                            {(s) => (
                              <li class="flex items-center justify-between text-[12.5px] text-text">
                                <span>{memberName(s.user_id)}</span>
                                <button
                                  type="button"
                                  class="text-[11.5px] text-text-tertiary hover:text-text"
                                  data-testid={`agreement-access-remove-${s.user_id}`}
                                  onClick={() =>
                                    void setAccess(
                                      "none",
                                      d().shares.filter((x) => x.user_id !== s.user_id),
                                    )
                                  }
                                >
                                  {tr("Remove")}
                                </button>
                              </li>
                            )}
                          </For>
                        </ul>
                        <select
                          data-testid="agreement-access-add"
                          class="mt-2 w-full rounded-md border border-border bg-bg px-2 py-1.5 text-[12.5px] text-text"
                          value=""
                          onChange={(e) => {
                            const userId = e.currentTarget.value
                            if (userId)
                              void setAccess("none", [
                                ...d().shares,
                                { user_id: userId, role: "editor" },
                              ])
                          }}
                        >
                          <option value="">{tr("Add a person")}</option>
                          <For
                            each={(members() ?? []).filter(
                              (m) => !d().shares.some((s) => s.user_id === m.id),
                            )}
                          >
                            {(m) => <option value={m.id}>{m.name}</option>}
                          </For>
                        </select>
                        <p class="mt-1 text-[11px] text-text-tertiary">
                          {tr(
                            "Nobody else can open it, find it or ask an agent about it, admins included.",
                          )}
                        </p>
                      </Show>
                    </section>

                    <section data-testid="agreement-checks">
                      <h2 class="mb-1 text-[12px] font-medium text-text">
                        {tr("Before it can be sent")}
                      </h2>
                      <Show when={agentBlockCount(source()) > 0}>
                        <p
                          data-testid="agreement-checks-agent"
                          class="mb-1 text-[12px] text-text-secondary"
                        >
                          {tr("{{n}} clause(s) written by an agent still to read.", {
                            n: agentBlockCount(source()),
                          })}
                        </p>
                      </Show>
                      <ul class="flex flex-col gap-1.5">
                        <For each={checks()}>
                          {(c) => (
                            <li
                              data-testid={`agreement-check-${c.code}`}
                              data-ok={c.ok ? "true" : "false"}
                              class="flex gap-2 text-[12px]"
                            >
                              <span
                                aria-hidden="true"
                                class={c.ok ? "text-success" : "text-text-tertiary"}
                              >
                                {c.ok ? "✓" : "○"}
                              </span>
                              <span class={c.ok ? "text-text-tertiary" : "text-text"}>
                                {CHECK_WORDS[c.code]
                                  ? tr(CHECK_WORDS[c.code]?.[c.ok ? 0 : 1] ?? "")
                                  : c.message}
                              </span>
                            </li>
                          )}
                        </For>
                      </ul>
                      <Show
                        when={
                          failed().some((c) => c.code === "PERSONAL_GUARANTEE") ||
                          a().not_a_guarantee
                        }
                      >
                        <label class="mt-2 flex items-center gap-2 text-[12px] text-text">
                          <input
                            type="checkbox"
                            data-testid="agreement-not-a-guarantee"
                            checked={a().not_a_guarantee === true}
                            disabled={busy() || a().status !== "draft"}
                            onChange={(e) => void setNotGuarantee(e.currentTarget.checked)}
                          />
                          {tr("I checked: this is not a personal guarantee")}
                        </label>
                      </Show>
                    </section>
                  </aside>
                </div>
              </>
            )
          }}
        </Match>
        <Match when={true}>
          <div data-testid="agreement-editor-loading" class="px-6 py-10" aria-busy="true" />
        </Match>
      </Switch>
    </div>
  )
}
