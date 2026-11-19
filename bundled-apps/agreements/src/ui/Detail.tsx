// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One agreement: its actions on top, then Overview (signers in order, dates, versions with
// their fingerprints), Document (the draft's text, or the frozen file itself) and Proof of
// signature (the evidence, checked on request). The less common states (declined, a link that
// ended, withdrawn) say what happened and what can be done next, calmly. The only sign button
// is the reader's own, when it is their turn; nothing here signs for anyone else, and no
// wording says an agent signed.

import { Badge, Button, Segmented } from "@liaison/app-ui/kit"
import { onEntityChange } from "@liaison/host"
import { type Component, createResource, createSignal, For, Match, Show, Switch } from "solid-js"
import { DocumentText } from "./DocumentText"
import { call, go, openPdfFile, openStoredFile, paths } from "./host"
import { tr, uiLocale } from "./i18n"
import { StatusBadge } from "./List"
import {
  type AgreementDetail,
  declinedUnproven,
  editReplacesSent,
  formatMoney,
  KIND_LABEL,
  LINK_LABEL,
  latestVersion,
  relinkable,
  shortHash,
  yourOpenLink,
} from "./model"
import { rememberAgreementLabel } from "./tab-labels"

type Pane = "overview" | "document" | "evidence"

interface Evidence {
  document_sha256: string
  signed_pdf_sha256: string | null
  seal: string | null
  sealed_at: string | null
  timestamp: string
  timestamped_at: string | null
  last_verified_at: string | null
  last_verify_ok: boolean | null
  retention_until: string | null
  devices: "shown" | "withheld"
  signed_pdf_file_id?: string | null
  /** Only for a holder of the devices permission: the evidence file holds each device. */
  evidence_file_id?: string | null
  /** The signature's level: `demo` is a stand-in, with no evidence behind it. */
  level?: string | null
  signers: Array<{
    name: string
    capacity: string | null
    email: string
    signed_at: string
    code_verified_at: string | null
    document_shown_at: string | null
    typed_phrase: string | null
    copy: string
    ip?: string | null
    user_agent?: string | null
  }>
}

/** What the proof shows and does not, how long it is kept, and what leaving Liaison changes (A-10). */
const ProofNotes: Component<{ keptUntil: string | null }> = (props) => (
  <div data-testid="agreement-proof-notes" class="mt-2 flex flex-col gap-3 text-[12.5px] text-text">
    <section class="flex flex-col gap-1">
      <h2 class="text-[12px] font-medium text-text-secondary">
        {tr("What this proves, and what it does not")}
      </h2>
      <p>
        {tr(
          "This is a simple electronic signature. A court cannot refuse it just because it is electronic, and it can be used as evidence.",
        )}
      </p>
      <p>
        {tr(
          "It does not count as a handwritten signature by itself. If someone denied signing, you would have to show that it was them. This file is how.",
        )}
      </p>
      <p>
        {tr(
          "It does not show that a signer had the authority to bind their company, only that they said so.",
        )}
      </p>
      <p class="text-text-tertiary">{tr("General information, not legal advice.")}</p>
    </section>
    <section class="flex flex-col gap-1">
      <h2 class="text-[12px] font-medium text-text-secondary">{tr("How long it is kept")}</h2>
      <p>
        {props.keptUntil
          ? tr(
              "Until {{date}}, at least. Automatic clean-up cannot remove it, and neither can an agent.",
              { date: dateText(props.keptUntil) },
            )
          : tr(
              "As long as the agreement's retention requires. Automatic clean-up cannot remove it, and neither can an agent.",
            )}
      </p>
    </section>
    <section class="flex flex-col gap-1">
      <h2 class="text-[12px] font-medium text-text-secondary">{tr("If you leave Liaison")}</h2>
      <p>
        {tr(
          "The proof of signature file stands on its own. Once downloaded, it still checks with no Liaison and no server, for as long as you keep it.",
        )}
      </p>
    </section>
  </div>
)

export function dateText(iso: string | null | undefined): string {
  if (!iso) return ""
  const [y, m, day] = iso.split("-").map(Number)
  // A date alone is read at noon UTC, so it names the same day in every time zone.
  const d =
    iso.length === 10 ? new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, day ?? 1, 12)) : new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(uiLocale(), { day: "numeric", month: "short", year: "numeric" })
}

const Line: Component<{ k: string; v: string; testid?: string }> = (props) => (
  <div class="flex gap-3 py-1 text-[12.5px]" data-testid={props.testid}>
    <span class="w-40 shrink-0 text-text-tertiary">{props.k}</span>
    <span class="min-w-0 flex-1 break-words text-text">{props.v}</span>
  </div>
)

const Note: Component<{ testid: string; title: string; children: string }> = (props) => (
  <div
    data-testid={props.testid}
    class="mb-4 rounded-md border border-border-subtle bg-surface px-4 py-3 text-[12.5px]"
  >
    <p class="font-medium text-text">{props.title}</p>
    <p class="mt-1 text-text-secondary">{props.children}</p>
  </div>
)

export const AgreementDetailView: Component<{ entityId?: string; id?: string }> = (props) => {
  const id = () => props.entityId ?? props.id ?? ""
  const [pane, setPane] = createSignal<Pane>("overview")
  const [note, setNote] = createSignal<{ text: string; error: boolean } | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [voiding, setVoiding] = createSignal(false)
  const [reason, setReason] = createSignal("")

  const [detail, { refetch }] = createResource(id, async (agreementId) => {
    const out = await call<AgreementDetail>("agreement_get", { id: agreementId })
    if (!out.ok) throw new Error(out.message || tr("Could not load this agreement"))
    rememberAgreementLabel(agreementId, out.data.agreement.number)
    return out.data
  })
  const loaded = () => (detail.error ? undefined : detail())
  // Changed elsewhere (the agent's text, a price set in the editor): read it again.
  onEntityChange("agreements:agreement", (events) => {
    const ours = events.some(
      (e) => e.resync || (e.data as { agreement_id?: string } | null)?.agreement_id === id(),
    )
    if (ours) void refetch()
  })
  const [evidence, { refetch: refetchEvidence }] = createResource(
    // Read for a signed agreement on any pane: the overview says when its signature is a
    // demo stand-in, before anyone opens the proof.
    () => (loaded()?.agreement.status === "signed" ? id() : null),
    async (agreementId) => {
      const out = await call<Evidence>("agreement_evidence_get", { id: agreementId })
      return out.ok ? out.data : null
    },
  )
  const [check, setCheck] = createSignal<"none" | "matches" | "changed">("none")

  const run = async (tool: string, args: Record<string, unknown>, done: string) => {
    setBusy(true)
    setNote(null)
    const out = await call<{ message?: string; blocked?: unknown }>(tool, args)
    setBusy(false)
    if (!out.ok) {
      setNote({ text: out.message || tr("That did not work. Nothing was changed."), error: true })
      return false
    }
    setNote({ text: done, error: false })
    void refetch()
    return true
  }

  const openLinks = () => (loaded()?.signing_links ?? []).filter((l) => l.state === "open")

  const remind = () =>
    void run(
      "agreement_reminder_send",
      { client_action_ids: openLinks().map((l) => l.client_action_id) },
      tr("The reminder went to the signers whose link is still open."),
    )

  const voidIt = async () => {
    if (reason().trim() === "") return
    const ok = await run(
      "agreement_void",
      { id: id(), reason: reason().trim() },
      tr("Withdrawn. Anyone opening the link now sees the Withdrawn page."),
    )
    if (ok) {
      setVoiding(false)
      setReason("")
    }
  }

  const newLink = (clientActionId: string) =>
    void run(
      "agreement_new_link",
      { client_action_id: clientActionId },
      tr("A new link went to this signer."),
    )

  const verify = async () => {
    setBusy(true)
    const out = await call<{ matches?: boolean }>("agreement_verify", { id: id() })
    setBusy(false)
    if (out.ok) setCheck(out.data.matches === true ? "matches" : "changed")
    else setNote({ text: out.message || tr("The check could not run."), error: true })
    void refetchEvidence()
  }

  const openPdf = async (fileId: string, name: string) => {
    if (!(await openPdfFile(fileId, name)))
      setNote({ text: tr("The file could not be opened."), error: true })
  }

  return (
    <div data-testid="agreement-detail" class="flex h-full min-h-0 flex-col bg-bg">
      <Switch>
        <Match when={detail.error}>
          <div data-testid="agreement-detail-error" class="px-6 py-10 text-[13px] text-text">
            <p class="font-medium">{tr("This agreement cannot be opened")}</p>
            <p class="mt-1 text-text-tertiary">
              {tr("It may have been removed, or you are not on its list.")}
            </p>
          </div>
        </Match>
        <Match when={loaded()}>
          {(d) => {
            const a = () => d().agreement
            const latest = () => latestVersion(d())
            const mine = () => yourOpenLink(d().signing_links)
            // The signed copy read differently from the frozen file: nothing was sealed, and a
            // person withdraws it to send it again from a clean file (never a repair).
            const copyDiffers = () => a().status === "signed" && latest()?.copy_differs === true
            return (
              <>
                <header class="flex flex-wrap items-start justify-between gap-3 border-b border-border-subtle px-5 py-3">
                  <div class="min-w-0">
                    <div class="flex flex-wrap items-center gap-2 text-[12px] text-text-tertiary">
                      <span class="font-mono" data-testid="agreement-number">
                        {a().number}
                      </span>
                      <span>{tr(KIND_LABEL[a().kind] ?? "Other document")}</span>
                      <StatusBadge status={a().status} kind={a().kind} testid="agreement-status" />
                    </div>
                    <h1
                      class="mt-1 text-[15px] font-semibold text-text"
                      data-testid="agreement-title"
                    >
                      {a().title}
                    </h1>
                    <p class="text-[12px] text-text-tertiary">
                      {tr("Simple electronic signature")}
                    </p>
                  </div>
                  <div class="flex flex-wrap items-center gap-2" data-testid="agreement-actions">
                    <Show when={mine()}>
                      {(l) => (
                        <Button
                          variant="primary"
                          testid="agreement-read-and-sign"
                          onClick={() => go(paths.sign(l().client_action_id))}
                        >
                          {tr("Read and sign")}
                        </Button>
                      )}
                    </Show>
                    <Show when={a().status === "draft"}>
                      <Button testid="agreement-edit" onClick={() => go(paths.editor(id()))}>
                        {tr("Edit")}
                      </Button>
                      <Button
                        variant="primary"
                        testid="agreement-prepare"
                        onClick={() => go(paths.send(id()))}
                      >
                        {tr("Prepare for signature")}
                      </Button>
                    </Show>
                    <Show when={editReplacesSent(a().status)}>
                      <Show when={openLinks().length > 0}>
                        <Button testid="agreement-remind" disabled={busy()} onClick={remind}>
                          {tr("Remind signers")}
                        </Button>
                      </Show>
                      <Button testid="agreement-edit" onClick={() => go(paths.editor(id()))}>
                        {tr("Edit")}
                      </Button>
                      <Button
                        variant="ghost"
                        testid="agreement-void-open"
                        onClick={() => setVoiding(!voiding())}
                      >
                        {tr("Withdraw")}
                      </Button>
                    </Show>
                    <Show when={copyDiffers()}>
                      <Button testid="agreement-void-open" onClick={() => setVoiding(!voiding())}>
                        {tr("Withdraw")}
                      </Button>
                    </Show>
                  </div>
                </header>

                <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4 pb-dock-runway">
                  <Show when={voiding()}>
                    <div
                      data-testid="agreement-void-form"
                      class="mb-4 flex flex-col gap-2 rounded-md border border-border-subtle bg-surface px-4 py-3"
                    >
                      <label class="text-[12.5px] text-text" for="agreement-void-reason">
                        {tr("Why is it withdrawn? The signers do not see this reason.")}
                      </label>
                      <input
                        id="agreement-void-reason"
                        data-testid="agreement-void-reason"
                        class="rounded-md border border-border bg-bg px-2.5 py-1.5 text-[12.5px] text-text"
                        value={reason()}
                        onInput={(e) => setReason(e.currentTarget.value)}
                      />
                      <div class="flex gap-2">
                        <Button
                          variant="danger"
                          testid="agreement-void"
                          disabled={busy() || reason().trim() === ""}
                          onClick={() => void voidIt()}
                        >
                          {tr("Withdraw every open link")}
                        </Button>
                        <Button variant="ghost" onClick={() => setVoiding(false)}>
                          {tr("Cancel")}
                        </Button>
                      </div>
                    </div>
                  </Show>
                  <Show when={note()}>
                    {(n) => (
                      <p
                        data-testid="agreement-note"
                        role={n().error ? "alert" : "status"}
                        class={`mb-4 text-[12.5px] ${n().error ? "text-error" : "text-text-secondary"}`}
                      >
                        {n().text}
                      </p>
                    )}
                  </Show>

                  <Show when={a().status === "declined"}>
                    <Note testid="agreement-state-declined" title={tr("A signer declined")}>
                      {tr(
                        "Nothing was signed. You can send a new version, or a new link if it was not them.",
                      )}
                    </Note>
                  </Show>
                  <Show when={copyDiffers()}>
                    <Note
                      testid="agreement-state-copy-differs"
                      title={tr("The signed copy differs")}
                    >
                      {tr(
                        "The signed copy did not match what was read. Nothing was sealed. Send it again.",
                      )}
                    </Note>
                  </Show>
                  <Show when={a().status === "expired"}>
                    <Note
                      testid="agreement-state-expired"
                      title={tr("The link ended before everyone signed")}
                    >
                      {tr(
                        "One signature does not make an agreement. Send a new link, or leave it closed.",
                      )}
                    </Note>
                  </Show>
                  <Show when={a().status === "voided" || a().status === "withdrawn"}>
                    <Note testid="agreement-state-withdrawn" title={tr("Withdrawn")}>
                      {tr("Anyone opening the link now sees the Withdrawn page.")}
                    </Note>
                  </Show>

                  <Segmented
                    ariaLabel={tr("Agreement")}
                    testidPrefix="agreement-pane"
                    value={pane()}
                    onChange={setPane}
                    options={[
                      { value: "overview", label: tr("Overview") },
                      { value: "document", label: tr("Document") },
                      { value: "evidence", label: tr("Proof of signature") },
                    ]}
                  />

                  <div class="mt-4">
                    <Switch>
                      <Match when={pane() === "overview"}>
                        <section data-testid="agreement-overview" class="flex flex-col gap-5">
                          <Show when={evidence()?.level === "demo"}>
                            <p
                              data-testid="agreement-stand-in"
                              class="rounded-md border border-border-default px-3 py-2 text-[12.5px] text-text"
                            >
                              {tr(
                                "In this demo the signature, seal and timestamp are stand-ins. No signature took place.",
                              )}
                            </p>
                          </Show>
                          <div>
                            <h2 class="mb-2 text-[12px] font-medium text-text-secondary">
                              {tr("Signers, in order")}
                            </h2>
                            <Show
                              when={d().signing_links.length > 0}
                              fallback={
                                <p class="text-[12.5px] text-text-tertiary">
                                  {tr("Not sent yet. Signers are chosen when it is prepared.")}
                                </p>
                              }
                            >
                              <ol class="flex flex-col gap-1.5">
                                <For each={d().signing_links}>
                                  {(l, i) => (
                                    <li
                                      data-testid={`agreement-signer-${l.client_action_id}`}
                                      class="flex flex-wrap items-center gap-3 rounded-md border border-border-subtle bg-surface px-3 py-2 text-[12.5px]"
                                    >
                                      <span class="w-5 tabular-nums text-text-tertiary">
                                        {l.sign_order ?? i() + 1}
                                      </span>
                                      <span class="min-w-0 flex-1">
                                        <span class="text-text">{l.signer}</span>{" "}
                                        <span class="text-text-tertiary">{l.email}</span>
                                      </span>
                                      <Badge tone={l.state === "decided" ? "success" : "neutral"}>
                                        {tr(LINK_LABEL[l.state] ?? "Link sent, not signed yet")}
                                      </Badge>
                                      <Show when={l.state === "open"}>
                                        <span class="text-[11.5px] text-text-tertiary">
                                          {tr("Link works until {{date}}", {
                                            date: dateText(l.expires_at),
                                          })}
                                        </span>
                                      </Show>
                                      <Show when={declinedUnproven(l)}>
                                        <Button
                                          testid={`agreement-not-them-${l.client_action_id}`}
                                          disabled={busy()}
                                          onClick={() => newLink(l.client_action_id)}
                                        >
                                          {tr("If this was not them, send a new link")}
                                        </Button>
                                      </Show>
                                      <Show when={relinkable(d().signing_links).includes(l)}>
                                        <Button
                                          testid={`agreement-new-link-${l.client_action_id}`}
                                          disabled={busy()}
                                          onClick={() => newLink(l.client_action_id)}
                                        >
                                          {tr("Send a new link")}
                                        </Button>
                                      </Show>
                                    </li>
                                  )}
                                </For>
                              </ol>
                            </Show>
                          </div>
                          <div>
                            <h2 class="mb-1 text-[12px] font-medium text-text-secondary">
                              {tr("Dates and price")}
                            </h2>
                            <Show when={a().price_minor !== null}>
                              <Line
                                testid="agreement-price"
                                k={tr("Price excl. VAT")}
                                v={formatMoney(a().price_minor, a().currency, uiLocale())}
                              />
                            </Show>
                            <Show when={a().starts_on}>
                              <Line k={tr("Starts")} v={dateText(a().starts_on)} />
                            </Show>
                            <Show when={a().ends_on}>
                              <Line k={tr("Ends")} v={dateText(a().ends_on)} />
                            </Show>
                            <Show when={a().renews_on}>
                              <Line k={tr("Renews")} v={dateText(a().renews_on)} />
                            </Show>
                            <Show when={a().what_it_is}>
                              <Line k={tr("What it is")} v={a().what_it_is ?? ""} />
                            </Show>
                            <Line
                              k={tr("Who can see this")}
                              v={
                                a().org_access === "none"
                                  ? tr("Only the people on its list")
                                  : tr("Everyone with Agreements")
                              }
                            />
                          </div>
                          <div>
                            <h2 class="mb-2 text-[12px] font-medium text-text-secondary">
                              {tr("Versions")}
                            </h2>
                            <Show
                              when={d().versions.length > 0}
                              fallback={
                                <p class="text-[12.5px] text-text-tertiary">
                                  {tr("No version frozen yet.")}
                                </p>
                              }
                            >
                              <ul class="flex flex-col gap-1">
                                <For each={d().versions}>
                                  {(v) => (
                                    <li
                                      data-testid={`agreement-version-${v.number}`}
                                      class="flex flex-wrap items-center gap-3 text-[12.5px]"
                                    >
                                      <span class="text-text">
                                        {tr("Version {{n}}", { n: v.number })}
                                      </span>
                                      <span class="text-text-tertiary">
                                        {dateText(v.frozen_at)}
                                      </span>
                                      <span
                                        class="font-mono text-[11.5px] text-text-tertiary"
                                        title={v.sha256 ?? ""}
                                      >
                                        {shortHash(v.sha256)}
                                      </span>
                                    </li>
                                  )}
                                </For>
                              </ul>
                            </Show>
                          </div>
                        </section>
                      </Match>
                      <Match when={pane() === "document"}>
                        <section data-testid="agreement-document">
                          <Switch>
                            <Match when={a().status === "draft" && d().draft?.source}>
                              <DocumentText source={d().draft?.source ?? null} />
                            </Match>
                            <Match when={latest()?.file_id}>
                              <div class="flex flex-col items-start gap-2 text-[12.5px]">
                                <p class="text-text-secondary">
                                  {tr(
                                    "The frozen file of version {{n}}, exactly as the signers read it.",
                                    {
                                      n: latest()?.number ?? 1,
                                    },
                                  )}
                                </p>
                                <p class="font-mono text-[11.5px] text-text-tertiary">
                                  {latest()?.sha256}
                                </p>
                                <Button
                                  testid="agreement-open-pdf"
                                  onClick={() =>
                                    void openPdf(
                                      latest()?.file_id ?? "",
                                      `${a().number}-v${latest()?.number ?? 1}.pdf`,
                                    )
                                  }
                                >
                                  {tr("Open the PDF")}
                                </Button>
                              </div>
                            </Match>
                            <Match when={true}>
                              <p class="text-[12.5px] text-text-tertiary">
                                {tr("Nothing to show yet.")}
                              </p>
                            </Match>
                          </Switch>
                        </section>
                      </Match>
                      <Match when={pane() === "evidence"}>
                        <section data-testid="agreement-evidence" class="flex flex-col gap-3">
                          <Show
                            when={evidence()}
                            fallback={
                              <p class="text-[12.5px] text-text-tertiary">
                                {a().status === "signed"
                                  ? tr("Loading the proof of signature…")
                                  : tr("The proof of signature is made once everyone has signed.")}
                              </p>
                            }
                          >
                            {(e) => (
                              <Show
                                when={e().level !== "demo"}
                                fallback={
                                  <p
                                    data-testid="agreement-evidence-stand-in"
                                    class="text-[12.5px] text-text"
                                  >
                                    {tr(
                                      "In this demo the signature, seal and timestamp are stand-ins. No signature took place.",
                                    )}{" "}
                                    {tr("There is no evidence file to download or check.")}
                                  </p>
                                }
                              >
                                <>
                                  <div class="flex flex-wrap items-center gap-2">
                                    <Button
                                      testid="agreement-verify"
                                      disabled={busy()}
                                      onClick={() => void verify()}
                                    >
                                      {tr("Check the stored files")}
                                    </Button>
                                    <Show when={e().signed_pdf_file_id}>
                                      {(f) => (
                                        <Button
                                          testid="agreement-download-signed"
                                          onClick={() =>
                                            void openPdf(f(), `${a().number}-signed.pdf`)
                                          }
                                        >
                                          {tr("Download signed PDF")}
                                        </Button>
                                      )}
                                    </Show>
                                    <Show when={e().evidence_file_id}>
                                      {(f) => (
                                        <Button
                                          testid="agreement-download-evidence"
                                          onClick={() =>
                                            void openStoredFile(
                                              f(),
                                              `${a().number}-proof-of-signature.zip`,
                                              "application/zip",
                                            ).then(
                                              (ok) =>
                                                ok ||
                                                setNote({
                                                  text: tr("The file could not be opened."),
                                                  error: true,
                                                }),
                                            )
                                          }
                                        >
                                          {tr("Download proof of signature")}
                                        </Button>
                                      )}
                                    </Show>
                                    <Show when={check() === "matches"}>
                                      <span
                                        data-testid="agreement-verify-matches"
                                        class="text-[12.5px] text-text"
                                      >
                                        {tr("The stored files match what was signed.")}
                                      </span>
                                    </Show>
                                    <Show when={check() === "changed"}>
                                      <span
                                        data-testid="agreement-verify-changed"
                                        class="text-[12.5px] text-text"
                                      >
                                        {tr(
                                          "This stored file no longer matches what was signed. Use the copy each signer received. Liaison cannot repair this.",
                                        )}
                                      </span>
                                    </Show>
                                  </div>
                                  <Line
                                    k={tr("Document fingerprint (SHA-256)")}
                                    v={e().document_sha256}
                                  />
                                  <Show when={e().signed_pdf_sha256}>
                                    <Line
                                      k={tr("Signed copy fingerprint")}
                                      v={e().signed_pdf_sha256 ?? ""}
                                    />
                                  </Show>
                                  <Line
                                    k={tr("Seal")}
                                    v={
                                      e().sealed_at
                                        ? tr(
                                            "Sealed on {{date}}. The seal locks the file; it is not a signature.",
                                            {
                                              date: dateText(e().sealed_at),
                                            },
                                          )
                                        : tr(
                                            "Not sealed yet. The seal is retried every 10 minutes.",
                                          )
                                    }
                                  />
                                  <Line
                                    testid="agreement-timestamp"
                                    k={tr("Independent timestamp")}
                                    v={
                                      e().timestamped_at
                                        ? tr("Stamped on {{date}}", {
                                            date: dateText(e().timestamped_at),
                                          })
                                        : tr(
                                            "No independent timestamp yet. Trying again every 10 minutes.",
                                          )
                                    }
                                  />
                                  <Show when={e().retention_until}>
                                    <Line k={tr("Kept until")} v={dateText(e().retention_until)} />
                                  </Show>
                                  <h2 class="mt-2 text-[12px] font-medium text-text-secondary">
                                    {tr("Each signature")}
                                  </h2>
                                  <For each={e().signers}>
                                    {(s) => (
                                      <div class="rounded-md border border-border-subtle bg-surface px-3 py-2">
                                        <Line
                                          k={tr("Signer")}
                                          v={s.capacity ? `${s.name}, ${s.capacity}` : s.name}
                                        />
                                        <Line k={tr("Signed on")} v={dateText(s.signed_at)} />
                                        <Line
                                          k={tr("Code sent by email")}
                                          v={
                                            s.code_verified_at
                                              ? tr("Confirmed")
                                              : tr("Not confirmed")
                                          }
                                        />
                                        <Show when={s.typed_phrase}>
                                          <Line k={tr("Words typed")} v={s.typed_phrase ?? ""} />
                                        </Show>
                                        <Line
                                          k={tr("Their signed copy")}
                                          v={s.copy === "sent" ? tr("Sent") : tr("Not sent yet")}
                                        />
                                        <Show when={e().devices === "shown"}>
                                          <Line k={tr("IP address")} v={s.ip ?? ""} />
                                          <Line k={tr("Browser")} v={s.user_agent ?? ""} />
                                        </Show>
                                      </div>
                                    )}
                                  </For>
                                  <Show when={e().devices === "withheld"}>
                                    <p
                                      data-testid="agreement-devices-withheld"
                                      class="text-[12px] text-text-tertiary"
                                    >
                                      {tr(
                                        "IP addresses and browsers are hidden from you. They are for the people who hold the devices permission.",
                                      )}
                                    </p>
                                  </Show>
                                  <ProofNotes keptUntil={e().retention_until} />
                                </>
                              </Show>
                            )}
                          </Show>
                        </section>
                      </Match>
                    </Switch>
                  </div>
                </div>
              </>
            )
          }}
        </Match>
        <Match when={true}>
          <div data-testid="agreement-detail-loading" class="px-6 py-10" aria-busy="true" />
        </Match>
      </Switch>
    </div>
  )
}
