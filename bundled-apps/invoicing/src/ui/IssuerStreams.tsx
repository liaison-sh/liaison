// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "Who issues what", a block of the issuer settings section (no page of its own). For each issuer
// profile: its identity line and its streams. Card subscriptions on Stripe appear only while Stripe
// is connected, with the choice of who issues their invoices in a panel; recurring by transfer and
// one-off invoices are always Liaison's and read "Always: not billed from Stripe". Rows are not
// clickable.
//
// A person's own change runs at once, so it asks a confirm whose text is the panel's warning.
// Stripe's own emails to customers cannot be read, so the block asks the person to check them
// until a person says they did; the word Checked appears only after that click.
import { app } from "@liaison/host"
import { createSignal, For, Show, type Component } from "solid-js"
import { tr } from "./i18n"
import { Badge, Button } from "./kit"

export interface StreamView {
  stream: "card" | "transfer" | "one_off"
  issuer: "liaison" | "stripe" | "undecided"
  notBilledFromStripe?: boolean
  decidedAt?: string | null
  suggested?: { issuer: "liaison"; why: string } | null
}

export interface IssuerStreamsView {
  issuerProfileId: string
  name: string
  country: string | null
  streams: StreamView[]
  stripe_emails: { state: "unknown" | "confirmed"; confirmedBy: string | null; confirmedAt: string | null } | null
}


const STREAM_LABEL: Record<StreamView["stream"], string> = {
  card: "Subscriptions paid by card",
  transfer: "Recurring by transfer",
  one_off: "One-off invoices",
}

/** One table row: the stream's name and who invoices it, in the reader's language. */
export function streamRow(s: StreamView): { name: string; who: string } {
  const name = tr(STREAM_LABEL[s.stream])
  if (s.stream !== "card") return { name, who: tr("Always: not billed from Stripe") }
  const who = s.issuer === "liaison" ? tr("Liaison invoices") : s.issuer === "stripe" ? tr("Stripe invoices") : tr("Not decided yet")
  return { name, who }
}

/** The emails line: a request to check until a person said they did, never the word Checked before. */
export function emailsLine(e: IssuerStreamsView["stripe_emails"], locale?: string): string | null {
  if (!e) return null
  if (e.state !== "confirmed" || !e.confirmedAt) return tr("Please check in Stripe, Settings, Billing: finalized invoices, credit notes and payment receipts should not email customers. Liaison cannot read this setting.")
  const day = new Date(e.confirmedAt).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" })
  return tr("Checked by a person on {{day}}. Liaison cannot read this setting, so check again if someone changes it.", { day })
}

async function loadStreams(): Promise<IssuerStreamsView[]> {
  try {
    const r = await app.invokeTool<{ issuers?: IssuerStreamsView[] }>("issuer_stream_get", {})
    return r?.issuers ?? []
  } catch {
    return []
  }
}

export const InvoicingIssuerStreams: Component = () => {
  const [data, { refetch }] = app.createResource(loadStreams)
  const [error, setError] = createSignal<string | null>(null)

  const run = async (tool: string, params: Record<string, unknown>) => {
    setError(null)
    try {
      const r = await app.invokeTool<{ status?: string; error?: { message?: string } }>(tool, params)
      if (r?.status === "error") setError(r.error?.message ?? tr("Nothing was changed."))
      refetch()
    } catch (e) {
      setError(e instanceof Error ? e.message : tr("Nothing was changed."))
    }
  }

  const choose = (issuerProfileId: string, issuer: "liaison" | "stripe") => {
    if (!window.confirm(tr("Starts with the next renewal, after you confirm. Invoices Liaison already issued stay as they are, with their numbers. Check the change with your accountant."))) return
    void run("issuer_stream_set", { issuerProfileId, stream: "card", issuer })
  }

  return (
    <div class="space-y-6" data-testid="invoicing-issuer-streams">
      <div>
        <h3 class="text-sm font-medium text-[var(--color-text)]">{tr("Who issues what")}</h3>
        <p class="text-xs text-[var(--color-text-secondary)]">{tr("If both invoiced the same sale, it would be invoiced twice.")}</p>
      </div>
      <Show when={error()}>
        <p class="text-xs text-[var(--color-text-secondary)]" data-testid="issuer-streams-error">
          {error()}
        </p>
      </Show>
      <For each={data() ?? []}>
        {(issuer) => {
          const card = () => issuer.streams.find((s) => s.stream === "card")
          return (
            <section class="space-y-3" data-testid={`issuer-streams-${issuer.issuerProfileId}`}>
              <p class="text-sm text-[var(--color-text)]">
                {issuer.name}
                <Show when={issuer.country}>{(c) => <span class="text-[var(--color-text-meta)]"> · {c()}</span>}</Show>
              </p>
              <table class="w-full text-sm">
                <thead>
                  <tr class="text-left text-xs text-[var(--color-text-meta)]">
                    <th class="py-1 font-normal">{tr("Kind of sale")}</th>
                    <th class="py-1 font-normal">{tr("Who invoices")}</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={issuer.streams}>
                    {(s) => (
                      <tr data-testid={`stream-row-${s.stream}`}>
                        <td class="py-1">{streamRow(s).name}</td>
                        <td class="py-1 text-[var(--color-text-secondary)]">{streamRow(s).who}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
              <Show when={card()}>
                {(c) => (
                  <div class="space-y-2 rounded-lg border border-[var(--color-border)] p-3" data-testid="card-stream-panel">
                    <div class="flex items-center gap-2">
                      <span class="text-sm font-medium">{tr("Subscriptions paid by card")}</span>
                      <Show when={c().issuer === "undecided"}>
                        <Badge>{tr("Not decided yet")}</Badge>
                      </Show>
                    </div>
                    <Show when={c().suggested}>
                      {(s) => <p class="text-xs text-[var(--color-text-secondary)]">{tr("Default for French companies")}: {s().why}</p>}
                    </Show>
                    <div class="flex gap-2">
                      <Button
                        data-testid="card-issuer-liaison"
                        disabled={c().issuer === "liaison"}
                        onClick={() => choose(issuer.issuerProfileId, "liaison")}
                      >
                        {tr("Liaison invoices, Stripe only takes the payment")}
                      </Button>
                      <Button
                        data-testid="card-issuer-stripe"
                        disabled={c().issuer === "stripe"}
                        onClick={() => choose(issuer.issuerProfileId, "stripe")}
                      >
                        {tr("Stripe invoices, Liaison only shows you a copy")}
                      </Button>
                    </div>
                    <p class="text-xs text-[var(--color-text-secondary)]" data-testid="stripe-emails-line">
                      {emailsLine(issuer.stripe_emails)}
                    </p>
                    <Show when={issuer.stripe_emails?.state !== "confirmed"}>
                      <Button data-testid="stripe-emails-confirm" onClick={() => void run("issuer_emails_confirm", { issuerProfileId: issuer.issuerProfileId })}>
                        {tr("I checked, they are off")}
                      </Button>
                    </Show>
                  </div>
                )}
              </Show>
            </section>
          )
        }}
      </For>
    </div>
  )
}
