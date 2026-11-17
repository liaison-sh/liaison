// SPDX-License-Identifier: FSL-1.1-ALv2
//
// R-01 home, R-02 project, R-03 invoices. Each part renders on its own: a part
// the server could not read says so in place (R-10) and the others stand. What
// the client sees is only what the views give the portal; nothing here filters.
// Hours are a project's total only, billed or a retainer's "so far".

import { type Component, createResource, For, type JSX, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { day, documentState, hoursLine, money, periodLabel } from "./format"
import { portalDownload, portalGet } from "./portal-api"
import type {
  PortalDocument,
  PortalHome,
  PortalInvoice,
  PortalProjectDetail,
  PortalUpcoming,
} from "./types"

export type Go = (path: string) => void

const card = "rounded-xl border border-border bg-surface px-4 py-4"
const rowButton =
  "flex w-full items-center justify-between gap-3 rounded-md px-2 py-2 text-left text-[14px] text-text hover:bg-surface-hover"

/** R-10: one part failed. Said in place, in the same words for every part. */
export const PartFailed: Component<{ part: string }> = (props) => {
  const i18n = useI18n()
  return (
    <p
      data-testid={`portal-part-failed-${props.part}`}
      class="text-[13px] text-text-secondary"
      role="status"
    >
      {i18n.t("portal.states.partFailed")}
    </p>
  )
}

/** "Not available": the same words for another company's object and a missing one. */
export const NotAvailable: Component = () => {
  const i18n = useI18n()
  return (
    <p data-testid="portal-not-available" class="text-[14px] text-text-secondary">
      {i18n.t("portal.states.notAvailable")}
    </p>
  )
}

export const Section: Component<{ title: string; testid: string; children: JSX.Element }> = (
  props,
) => (
  <section data-testid={props.testid} class={card}>
    <h2 class="mb-2 text-[13px] font-semibold uppercase tracking-wide text-text-tertiary">
      {props.title}
    </h2>
    {props.children}
  </section>
)

export const ContactLine: Component<{ name: string | null | undefined }> = (props) => {
  const i18n = useI18n()
  return (
    <Show when={props.name}>
      {(n) => (
        <p data-testid="portal-contact" class="text-[13.5px] text-text-secondary">
          {i18n.t("portal.home.contact", { name: n() })}
        </p>
      )}
    </Show>
  )
}

function invoiceLine(
  inv: PortalInvoice,
  all: PortalInvoice[],
  t: ReturnType<typeof useI18n>["t"],
  locale: string,
): string {
  if (inv.type === "credit_note") {
    const original = all.find((o) => o.id === inv.originalDocumentId)
    return original?.number
      ? t("portal.invoices.corrects", { number: original.number })
      : t("portal.invoices.creditNote")
  }
  if (inv.paidAt || inv.paymentStatus === "paid")
    return t("portal.invoices.paidOn", { date: day(inv.paidAt, locale) })
  if (inv.dueAt) return t("portal.invoices.dueOn", { date: day(inv.dueAt, locale) })
  return t("portal.invoices.issuedOn", { date: day(inv.issuedAt, locale) })
}

export const InvoiceRows: Component<{ invoices: PortalInvoice[] }> = (props) => {
  const i18n = useI18n()
  const locale = () => i18n.locale()
  const download = (inv: PortalInvoice) =>
    portalDownload(`/invoices/${inv.id}/pdf`, `${inv.number ?? inv.id}.pdf`)
  return (
    <ul class="flex flex-col divide-y divide-border">
      <For each={props.invoices}>
        {(inv) => (
          <li
            data-testid={`portal-invoice-${inv.id}`}
            class="flex flex-wrap items-center gap-3 py-2"
          >
            <div class="min-w-0 flex-1">
              <p class="truncate text-[14px] text-text">
                {inv.number} {inv.label ? `· ${inv.label}` : ""}
              </p>
              <p data-testid="portal-invoice-line" class="text-[12.5px] text-text-secondary">
                {invoiceLine(inv, props.invoices, i18n.t, locale())}
              </p>
            </div>
            <span class="text-[14px] tabular-nums text-text">
              {money(inv.grandTotalMinor, inv.currency, locale())}
            </span>
            <Show when={inv.hasPdf}>
              <button
                type="button"
                data-testid={`portal-invoice-pdf-${inv.id}`}
                class="min-h-[36px] rounded-md border border-border px-3 text-[13px] text-text"
                onClick={() => download(inv)}
              >
                {i18n.t("portal.invoices.pdf")}
              </button>
            </Show>
          </li>
        )}
      </For>
    </ul>
  )
}

const UpcomingRows: Component<{ rows: PortalUpcoming[] }> = (props) => {
  const i18n = useI18n()
  return (
    <ul class="flex flex-col divide-y divide-border">
      <For each={props.rows}>
        {(u) => (
          <li class="flex items-center justify-between gap-3 py-2 text-[14px]">
            <span class="min-w-0 truncate text-text">{u.label}</span>
            <span class="text-[13px] text-text-secondary">
              {u.dueOn ? day(u.dueOn, i18n.locale()) : ""}
            </span>
            <span class="tabular-nums text-text">
              {money(u.amountMinor, u.currency, i18n.locale())}
            </span>
          </li>
        )}
      </For>
    </ul>
  )
}

/** R-01: what the company shares, part by part. */
export const HomePage: Component<{
  home: PortalHome
  documents: PortalDocument[] | null
  go: Go
}> = (props) => {
  const i18n = useI18n()
  const failed = (part: string) => props.home.unavailable.includes(part)
  return (
    <div data-testid="portal-home" class="flex flex-col gap-4">
      <div>
        <h1 class="text-[20px] font-semibold text-text">
          {i18n.t("portal.home.hello", { name: props.home.me?.name ?? "" })}
        </h1>
        <ContactLine name={props.home.me?.contactName} />
      </div>
      <Show when={failed("projects") || (props.home.projects?.length ?? 0) > 0}>
        <Section title={i18n.t("portal.nav.projects")} testid="portal-home-projects">
          <Show when={props.home.projects} fallback={<PartFailed part="projects" />}>
            {(projects) => (
              <For each={projects()}>
                {(p) => (
                  <button
                    type="button"
                    class={rowButton}
                    data-testid={`portal-project-row-${p.id}`}
                    onClick={() => props.go(`projects/${p.id}`)}
                  >
                    <span>{p.name}</span>
                    <span aria-hidden="true">›</span>
                  </button>
                )}
              </For>
            )}
          </Show>
        </Section>
      </Show>
      <Show when={(props.documents?.length ?? 0) > 0}>
        <Section title={i18n.t("portal.nav.documents")} testid="portal-home-documents">
          <For each={(props.documents ?? []).filter((d) => d.status !== "voided")}>
            {(d) => (
              <button
                type="button"
                class={rowButton}
                data-testid={`portal-document-row-${d.id}`}
                onClick={() => props.go(`documents/${d.id}`)}
              >
                <span>
                  {d.number} {d.title}
                </span>
                <span class="text-[12.5px] text-text-secondary">
                  {i18n.t(`portal.documents.status.${documentState(d.status)}`)}
                </span>
              </button>
            )}
          </For>
        </Section>
      </Show>
      <Show when={failed("upcoming") || (props.home.upcoming?.length ?? 0) > 0}>
        <Section title={i18n.t("portal.home.upcoming")} testid="portal-home-upcoming">
          <Show when={props.home.upcoming} fallback={<PartFailed part="upcoming" />}>
            {(rows) => <UpcomingRows rows={rows()} />}
          </Show>
        </Section>
      </Show>
      <Show when={failed("invoices") || (props.home.invoices?.length ?? 0) > 0}>
        <Section title={i18n.t("portal.nav.invoices")} testid="portal-home-invoices">
          <Show when={props.home.invoices} fallback={<PartFailed part="invoices" />}>
            {(invoices) => <InvoiceRows invoices={invoices().slice(0, 3)} />}
          </Show>
        </Section>
      </Show>
      <Show
        when={
          failed("requests") || props.home.requestsOpen || (props.home.requests?.length ?? 0) > 0
        }
      >
        <Section title={i18n.t("portal.nav.requests")} testid="portal-home-requests">
          <Show when={props.home.requests} fallback={<PartFailed part="requests" />}>
            {(requests) => (
              <>
                <For each={requests().slice(0, 3)}>
                  {(r) => (
                    <button
                      type="button"
                      class={rowButton}
                      onClick={() => props.go("requests")}
                      data-testid={`portal-home-request-${r.id}`}
                    >
                      <span class="truncate">{r.subject}</span>
                      <span class="text-[12.5px] text-text-secondary">
                        {i18n.t(`portal.requests.status.${requestState(r.status)}`)}
                      </span>
                    </button>
                  )}
                </For>
                <Show when={props.home.requestsOpen}>
                  <button
                    type="button"
                    data-testid="portal-home-new-request"
                    class="mt-2 text-[13.5px] text-accent hover:underline"
                    onClick={() => props.go("requests")}
                  >
                    {i18n.t("portal.requests.new")}
                  </button>
                </Show>
              </>
            )}
          </Show>
        </Section>
      </Show>
    </div>
  )
}

export function requestState(status: string): "open" | "answered" | "closed" {
  if (status === "closed" || status === "resolved") return "closed"
  if (status === "pending" || status === "waiting") return "answered"
  return "open"
}

/** R-02: a project's steps and, when shared, its hours as a total. */
export const ProjectPage: Component<{ id: string }> = (props) => {
  const i18n = useI18n()
  const [project] = createResource(
    () => props.id,
    async (id) => portalGet<PortalProjectDetail>(`/projects/${id}`),
  )
  return (
    <Show when={project()} fallback={<Loading />}>
      {(answer) => (
        <Show
          when={answer().status === 200 && answer().data}
          fallback={answer().status === 404 ? <NotAvailable /> : <PartFailed part="project" />}
        >
          {(p) => (
            <div data-testid="portal-project" class="flex flex-col gap-4">
              <div>
                <h1 class="text-[20px] font-semibold text-text">{p().name}</h1>
                <Show when={p().ownerName}>
                  {(n) => (
                    <p class="text-[13.5px] text-text-secondary">
                      {i18n.t("portal.project.lead", { name: n() })}
                    </p>
                  )}
                </Show>
              </div>
              <Show when={hoursLine(p().hours, i18n.t, i18n.locale())}>
                {(line) => (
                  <Section
                    title={i18n.t("portal.project.hoursTitle")}
                    testid="portal-project-hours"
                  >
                    <p data-testid="portal-hours-line" class="text-[15px] text-text">
                      {line()}
                    </p>
                    <Show when={periodLabel(p().hours?.period ?? null, i18n.locale())}>
                      {(m) => (
                        <p class="text-[12.5px] text-text-secondary">
                          {i18n.t("portal.project.hours.period", { month: m() })}
                        </p>
                      )}
                    </Show>
                  </Section>
                )}
              </Show>
              <Show when={!p().hours && p().hoursNote === "by_milestone"}>
                <Section title={i18n.t("portal.project.hoursTitle")} testid="portal-project-hours">
                  <p data-testid="portal-hours-note" class="text-[14px] text-text-secondary">
                    {i18n.t("portal.project.hours.byMilestone")}
                  </p>
                </Section>
              </Show>
              <Section title={i18n.t("portal.project.steps")} testid="portal-project-steps">
                <Show when={p().steps} fallback={<PartFailed part="steps" />}>
                  {(steps) => (
                    <Show
                      when={steps().length > 0}
                      fallback={
                        <p class="text-[13px] text-text-secondary">
                          {i18n.t("portal.project.noSteps")}
                        </p>
                      }
                    >
                      <ul class="flex flex-col divide-y divide-border">
                        <For each={steps()}>
                          {(s) => (
                            <li
                              data-testid={`portal-step-${s.id}`}
                              class="flex flex-wrap items-center gap-3 py-2 text-[14px]"
                            >
                              <span class="min-w-0 flex-1 text-text">{s.title}</span>
                              <span class="text-[12.5px] text-text-secondary">
                                {s.state === "done"
                                  ? i18n.t("portal.project.stepDone")
                                  : s.doneShare
                                    ? i18n.t("portal.project.stepShare", {
                                        share: String(s.doneShare),
                                      })
                                    : i18n.t("portal.project.stepOpen")}
                              </span>
                              <Show when={s.dueOn}>
                                <span class="text-[12.5px] text-text-secondary">
                                  {day(s.dueOn, i18n.locale())}
                                </span>
                              </Show>
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                  )}
                </Show>
              </Section>
            </div>
          )}
        </Show>
      )}
    </Show>
  )
}

/** R-03: issued invoices only; paid by bank transfer, details on the invoice. */
export const InvoicesPage: Component<{ home: PortalHome }> = (props) => {
  const i18n = useI18n()
  return (
    <div data-testid="portal-invoices" class="flex flex-col gap-4">
      <h1 class="text-[20px] font-semibold text-text">{i18n.t("portal.nav.invoices")}</h1>
      <Show when={(props.home.upcoming?.length ?? 0) > 0}>
        <Section title={i18n.t("portal.home.upcoming")} testid="portal-invoices-upcoming">
          <UpcomingRows rows={props.home.upcoming ?? []} />
        </Section>
      </Show>
      <Section title={i18n.t("portal.invoices.issued")} testid="portal-invoices-list">
        <Show when={props.home.invoices} fallback={<PartFailed part="invoices" />}>
          {(invoices) => (
            <Show
              when={invoices().length > 0}
              fallback={
                <p class="text-[13px] text-text-secondary">{i18n.t("portal.invoices.none")}</p>
              }
            >
              <InvoiceRows invoices={invoices()} />
            </Show>
          )}
        </Show>
        <p class="mt-3 text-[12.5px] text-text-secondary">{i18n.t("portal.invoices.howToPay")}</p>
      </Section>
    </div>
  )
}

export const Loading: Component = () => {
  const i18n = useI18n()
  return (
    <p data-testid="portal-loading" class="text-[13px] text-text-tertiary">
      {i18n.t("portal.states.loading")}
    </p>
  )
}
