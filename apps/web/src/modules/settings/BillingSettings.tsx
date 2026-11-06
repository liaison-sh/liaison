// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Settings > Billing (managed edition, org admins; spec S17). Everything shown
// in money comes from the control plane's reply as display strings or terms
// (`/billing/managed/summary`): this app holds no price, minimum or rate.
// Card entry and every payment confirmation (3-D Secure, an upgrade's
// proration invoice, a top-up without a card) run in the payment frame
// (PayFrame.tsx); this page never links to a payment provider's page.
import {
  type Component,
  createResource,
  createSignal,
  For,
  type JSX,
  onCleanup,
  Show,
  Suspense,
} from "solid-js"
import { ApiError } from "~/lib/api-client"
import { useI18n } from "~/modules/i18n/i18n-context"
import { formatCreditAmount } from "~/modules/settings/credits-format"
import { PayFrame, type PayFrameAction, type PayFrameResult } from "~/modules/settings/PayFrame"
import { SettingsPageHeader, SettingsPageSection } from "~/modules/settings/SettingsPageParts"
import { useApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"
import { Skeleton } from "~/ui/Skeleton"
import { Switch } from "~/ui/Switch"

type PlanId = "preview" | "base" | "pro"

/** The subscription's state as the control plane pushes it. */
export type BillingStatus = "active" | "past_due" | "suspended" | "closed"

/** Payment failed: top-ups wait behind the open invoice. */
export function paymentBlocked(status: BillingStatus): boolean {
  return status === "past_due" || status === "suspended" || status === "closed"
}

export interface BillingSummary {
  plan: PlanId
  status: BillingStatus
  periodEnd: string
  previewEndsAt: string | null
  cancelAt: string | null
  nextInvoice: { amountDisplay: string; date: string } | null
  plans: {
    id: PlanId
    priceDisplay: string
    includedCredits: string
    caps: Record<string, number | null>
  }[]
  card?: { brand: string; last4: string; expMonth: number; expYear: number }
  topUp: { minCredits: number; unitPriceCents: number; currency: string }
  autoTopUp: {
    enabled: boolean
    thresholdCredits: number
    amountCredits: number
    lastFailure?: { code: string; at: string }
  }
  pendingChange?: {
    targetPlan: PlanId
    effectiveAt: string
    kind: "upgrade_unpaid" | "downgrade_scheduled"
    invoiceId?: string
  }
  paymentAction?: { invoiceId: string; amountDisplay: string }
  /** The unpaid renewal while past due or suspended; `dueAt` is the next step's date. */
  openInvoice?: { invoiceId: string; amountDisplay: string; dueAt: string }
}

interface Invoice {
  id: string
  number: string | null
  kind: "invoice" | "credit_note"
  issuedAt: string
  amountDisplay: string
  status: "open" | "paid" | "void" | "uncollectible"
}

/** The managed credit balance (`/credits/balance`), read defensively. */
interface CreditBalance {
  credits?: { total?: string | number }
  period?: { usedPercent?: number }
}

interface FrameRequest {
  action: PayFrameAction
  credits?: number
  invoiceId?: string
}

/** Where the page remembers an unpaid upgrade, to say "not applied" once it lapses. */
const PENDING_KEY = "liaison:billing:pending-upgrade"

function readPending(): PlanId | null {
  try {
    const v = localStorage.getItem(PENDING_KEY)
    return v === "preview" || v === "base" || v === "pro" ? v : null
  } catch {
    return null
  }
}

function writePending(plan: PlanId | null): void {
  try {
    if (plan) localStorage.setItem(PENDING_KEY, plan)
    else localStorage.removeItem(PENDING_KEY)
  } catch {
    // storage unavailable: the notice is a convenience only
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  })
}

/** N credits at Control's unit price, in Control's currency. */
export function topUpPrice(credits: number, terms: BillingSummary["topUp"]): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: terms.currency }).format(
    (credits * terms.unitPriceCents) / 100,
  )
}

/**
 * One idempotency key per user intent. A retry of the same intent (same action,
 * same amount or target) after a timeout or a network error reuses its key, so
 * the control plane answers it once however often it is sent; a definitive
 * reply (success, or a refusal it chose) ends the intent, and a changed
 * amount or target is a new one.
 */
export function createIntentKeys(mint: () => string = () => crypto.randomUUID()) {
  const open = new Map<string, { intent: string; id: string }>()
  return {
    id(action: string, intent: string): string {
      const held = open.get(action)
      if (held && held.intent === intent) return held.id
      const id = mint()
      open.set(action, { intent, id })
      return id
    },
    /** The reply is known: the next request of this action is a new intent. */
    settle(action: string, err?: unknown): void {
      // A network error or a timeout is status 0, the control plane down a 5xx:
      // the outcome is unknown, so the key stays for the retry.
      const refused = err instanceof ApiError && err.status >= 400 && err.status < 500
      if (err === undefined || refused) open.delete(action)
    },
  }
}

const BillingSettings: Component = () => {
  const api = useApi()
  const { t } = useI18n()
  const [notApplied, setNotApplied] = createSignal<PlanId | null>(null)
  const [summary, { refetch }] = createResource(async () => {
    const s = await api.get<BillingSummary>("/billing/managed/summary")
    const remembered = readPending()
    if (remembered && s.pendingChange?.kind === "upgrade_unpaid") {
      // still waiting
    } else if (remembered && remembered !== s.plan) {
      setNotApplied(remembered)
      writePending(null)
    } else if (remembered) {
      writePending(null)
    }
    if (s.pendingChange?.kind === "upgrade_unpaid") writePending(s.pendingChange.targetPlan)
    return s
  })
  const [invoices, { refetch: refetchInvoices }] = createResource(() =>
    api.get<{ invoices: Invoice[]; hasMore: boolean }>("/billing/managed/invoices"),
  )
  const [balance, { refetch: refetchBalance }] = createResource(() =>
    api.get<CreditBalance>("/credits/balance").catch(() => null),
  )
  let rereadTimer: ReturnType<typeof setTimeout> | undefined
  // A payment changes the credits left and adds an invoice: never leave the old numbers on screen.
  const refreshAfterPayment = () => {
    void refetchBalance()
    void refetchInvoices()
    // A payment confirmed in the pay frame reaches Control by webhook just after: read once more.
    clearTimeout(rereadTimer)
    rereadTimer = setTimeout(() => {
      void refetchBalance()
      void refetchInvoices()
      void refetch()
    }, 4000)
  }
  onCleanup(() => clearTimeout(rereadTimer))

  const [notice, setNotice] = createSignal<string | null>(null)
  const [problem, setProblem] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [frame, setFrame] = createSignal<FrameRequest | null>(null)
  const [topUpCredits, setTopUpCredits] = createSignal<number | null>(null)
  const [auto, setAuto] = createSignal<BillingSummary["autoTopUp"] | null>(null)

  const planName = (id: PlanId) => t(`cloud-billing.plan.name.${id}`)
  const intents = createIntentKeys()

  /** POST/PUT one billing call under its intent's key; settles the key on a known reply. */
  async function send<T>(action: string, intent: unknown, call: (requestId: string) => Promise<T>) {
    const requestId = intents.id(action, JSON.stringify(intent))
    try {
      const r = await call(requestId)
      intents.settle(action)
      return r
    } catch (err) {
      intents.settle(action, err)
      throw err
    }
  }

  function errorText(err: unknown): string {
    if (err instanceof ApiError) {
      if (err.code === "caps_exceeded") {
        const caps = (err.details?.caps as string[] | undefined) ?? []
        return t("cloud-billing.plan.capsExceeded", {
          caps: caps.map((c) => t(`cloud-billing.plan.cap.${c}`)).join(", "),
        })
      }
      if (err.code === "change_pending") return t("cloud-billing.plan.changePending")
      if (err.code === "same_plan") return t("cloud-billing.plan.samePlan")
      if (err.code === "payment_failed") return t("cloud-billing.topUp.failed")
      if (err.code === "payment_required") return t("cloud-limits.billing.paymentRequired")
      if (err.code === "below_minimum") {
        return t("cloud-billing.topUp.belowMinimum", {
          min: String(summary()?.topUp.minCredits ?? ""),
        })
      }
    }
    return t("cloud-billing.unavailable")
  }

  async function act(run: () => Promise<void>): Promise<void> {
    setBusy(true)
    setNotice(null)
    setProblem(null)
    try {
      await run()
    } catch (err) {
      setProblem(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const changePlan = (target: PlanId) =>
    act(async () => {
      const r = await send("change-plan", target, (requestId) =>
        api.post<{
          result: "changed" | "scheduled" | "requires_action"
          effectiveAt: string
          invoiceId?: string
        }>("/billing/managed/change-plan", { targetPlan: target, requestId }),
      )
      if (r.result === "changed") {
        setNotice(t("cloud-billing.plan.changed", { plan: planName(target) }))
        refreshAfterPayment()
      }
      if (r.result === "scheduled") {
        setNotice(
          t("cloud-billing.plan.scheduled", {
            plan: planName(target),
            date: formatDate(r.effectiveAt),
          }),
        )
      }
      if (r.result === "requires_action" && r.invoiceId) {
        writePending(target)
        setFrame({ action: "confirm_invoice", invoiceId: r.invoiceId })
      }
      await refetch()
    })

  const buyCredits = (credits: number) =>
    act(async () => {
      try {
        const r = await send("topup", credits, (requestId) =>
          api.post<
            | { result: "paid"; invoiceId: string; credits: number }
            | { result: "requires_action"; invoiceId: string }
          >("/billing/managed/topup", { credits, requestId }),
        )
        if (r.result === "paid") {
          setNotice(t("cloud-billing.topUp.paid", { credits: String(r.credits) }))
          refreshAfterPayment()
        } else setFrame({ action: "confirm_invoice", invoiceId: r.invoiceId })
      } catch (err) {
        // No card yet: the frame takes one and pays this top-up.
        if (err instanceof ApiError && err.code === "no_card") {
          setFrame({ action: "topup", credits })
          return
        }
        throw err
      }
    })

  const saveAuto = () =>
    act(async () => {
      const a = auto()
      if (!a) return
      const settings = {
        enabled: a.enabled,
        thresholdCredits: a.thresholdCredits,
        amountCredits: a.amountCredits,
      }
      await send("auto-topup", settings, (requestId) =>
        api.put("/billing/managed/auto-topup", { ...settings, requestId }),
      )
      setNotice(t("cloud-billing.autoTopUp.saved"))
      setAuto(null)
      await refetch()
    })

  const cancel = () =>
    act(async () => {
      if (!window.confirm(t("cloud-billing.cancel.confirm"))) return
      await send("cancel", null, (requestId) => api.post("/billing/managed/cancel", { requestId }))
      await refetch()
    })

  const resume = () =>
    act(async () => {
      await send("resume", null, (requestId) => api.post("/billing/managed/resume", { requestId }))
      setNotice(t("cloud-billing.cancel.resumed"))
      await refetch()
    })

  async function download(inv: Invoice): Promise<void> {
    setProblem(null)
    try {
      const res = await api.rawGet(`/billing/managed/invoices/${encodeURIComponent(inv.id)}/pdf`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `${inv.number ?? inv.id}.pdf`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      setProblem(
        err instanceof ApiError && err.code === "pdf_too_large"
          ? t("cloud-billing.invoices.tooLarge")
          : t("cloud-billing.invoices.downloadFailed"),
      )
    }
  }

  function frameDone(result: PayFrameResult): void {
    setFrame(null)
    if (!result.ok) {
      setProblem(t("cloud-billing.topUp.failed"))
    } else if (result.action === "card") {
      setNotice(t("cloud-billing.card.updated"))
    }
    if (result.ok) refreshAfterPayment()
    void refetch()
  }

  const row = (children: JSX.Element) => (
    <div class="rounded-md border border-border p-4 text-sm text-text">{children}</div>
  )

  return (
    <div data-testid="billing-settings" class="max-w-2xl">
      <SettingsPageHeader title={t("cloud-billing.title")} intro={t("cloud-billing.intro")} />
      {/* Outside the Suspense: a re-read must not take the notice or an open pay frame away. */}
      <Show when={notice()}>
        <p data-testid="billing-notice" class="mb-4 text-sm text-text" role="status">
          {notice()}
        </p>
      </Show>
      <Show when={problem()}>
        <p data-testid="billing-problem" class="mb-4 text-sm text-error" role="alert">
          {problem()}
        </p>
      </Show>
      <Show when={frame()}>
        {(f) => (
          <div class="mb-6">
            <PayFrame
              api={api}
              action={f().action}
              credits={f().credits}
              invoiceId={f().invoiceId}
              onDone={frameDone}
              onClose={() => setFrame(null)}
            />
          </div>
        )}
      </Show>
      {/* A slow or unreachable Control must not blank the whole tab while it answers. */}
      <Suspense fallback={<Skeleton class="h-32 w-full" />}>
        <Show
          when={!summary.error}
          fallback={
            // A server without managed billing (self-hosted) answers 404: the
            // page is reachable only by its address and nothing will come back
            // on a retry, so it says so plainly.
            summary.error instanceof ApiError && summary.error.status === 404 ? (
              <p data-testid="billing-not-on-this-server" class="text-sm text-text-secondary">
                {t("cloud-billing.notOnThisServer")}
              </p>
            ) : (
              <div
                data-testid="billing-unavailable"
                class="flex items-center gap-3 text-sm text-text-secondary"
              >
                {t("cloud-billing.unavailable")}
                <Button variant="outline" size="sm" onClick={() => void refetch()}>
                  {t("cloud-billing.retry")}
                </Button>
              </div>
            )
          }
        >
          <Show when={summary.latest} fallback={<Skeleton class="h-32 w-full" />}>
            {(s) => (
              <>
                <Show when={paymentBlocked(s().status)}>
                  <div
                    role="alert"
                    data-testid="billing-past-due"
                    class="mb-6 flex flex-col gap-3 rounded-md border border-border p-4 text-sm text-text"
                  >
                    <p class="font-medium">
                      {/* A subscription that ran out has nothing to pay: it is not a failed payment. */}
                      {s().openInvoice || s().status === "past_due"
                        ? t("cloud-limits.billing.pastDue")
                        : t("cloud-limits.billing.ended")}
                    </p>
                    <Show when={s().openInvoice}>
                      {(inv) => (
                        <>
                          <p class="text-text-secondary" data-testid="billing-open-invoice">
                            {t("cloud-limits.billing.openInvoice", {
                              amount: inv().amountDisplay,
                              date: formatDate(inv().dueAt),
                            })}
                          </p>
                          <div>
                            <Button
                              size="sm"
                              variant="primary"
                              data-testid="billing-pay-open-invoice"
                              onClick={() =>
                                setFrame({ action: "confirm_invoice", invoiceId: inv().invoiceId })
                              }
                            >
                              {t("cloud-limits.billing.payOpenInvoice")}
                            </Button>
                          </div>
                        </>
                      )}
                    </Show>
                  </div>
                </Show>
                <SettingsPageSection
                  title={t("cloud-billing.plan.title")}
                  scope="org"
                  data-testid="billing-plan"
                >
                  {row(
                    <>
                      <p class="text-lg font-semibold" data-testid="billing-plan-name">
                        {planName(s().plan)}
                      </p>
                      <p class="mt-1 text-text-secondary">
                        {t(`cloud-billing.plan.status.${s().status}`)}
                      </p>
                      <Show
                        when={
                          s().status === "active" || s().status === "past_due" ? s().cancelAt : null
                        }
                        fallback={
                          <Show when={s().status === "active" || s().status === "past_due"}>
                            <p class="mt-1 text-text-secondary">
                              {t("cloud-billing.plan.renews", { date: formatDate(s().periodEnd) })}
                            </p>
                          </Show>
                        }
                      >
                        {(at) => (
                          <p class="mt-1 text-text-secondary" data-testid="billing-cancel-at">
                            {t("cloud-billing.plan.cancelAt", { date: formatDate(at()) })}
                          </p>
                        )}
                      </Show>
                      <Show when={s().plan === "preview" && s().previewEndsAt}>
                        {(at) => (
                          <p class="mt-1 text-text-secondary" data-testid="billing-preview-ends">
                            {t("cloud-billing.plan.previewEnds", { date: formatDate(at()) })}
                          </p>
                        )}
                      </Show>
                      <p class="mt-2" data-testid="billing-next-invoice">
                        <Show
                          when={s().nextInvoice}
                          fallback={t("cloud-billing.plan.noNextInvoice")}
                        >
                          {(n) =>
                            t("cloud-billing.plan.nextInvoice", {
                              amount: n().amountDisplay,
                              date: formatDate(n().date),
                            })
                          }
                        </Show>
                      </p>
                    </>,
                  )}
                  <Show when={notApplied()}>
                    {(p) => (
                      <p class="mt-3 text-sm text-text" data-testid="billing-change-not-applied">
                        {t("cloud-billing.plan.changeNotApplied", { plan: planName(p()) })}
                      </p>
                    )}
                  </Show>
                  <Show when={s().pendingChange}>
                    {(p) => (
                      <div
                        class="mt-3 flex flex-wrap items-center gap-3 text-sm"
                        data-testid="billing-pending-change"
                      >
                        <span>
                          {p().kind === "upgrade_unpaid"
                            ? t("cloud-billing.plan.pendingUpgrade", {
                                plan: planName(p().targetPlan),
                              })
                            : t("cloud-billing.plan.pendingDowngrade", {
                                plan: planName(p().targetPlan),
                                date: formatDate(p().effectiveAt),
                              })}
                        </span>
                        <Show when={p().kind === "upgrade_unpaid" && p().invoiceId}>
                          <Button
                            size="sm"
                            variant="primary"
                            onClick={() =>
                              setFrame({
                                action: "confirm_invoice",
                                invoiceId: p().invoiceId as string,
                              })
                            }
                          >
                            {t("cloud-billing.plan.confirmPayment")}
                          </Button>
                        </Show>
                      </div>
                    )}
                  </Show>
                  <Show when={s().paymentAction}>
                    {(pa) => (
                      <div
                        class="mt-3 flex flex-wrap items-center gap-3 text-sm"
                        data-testid="billing-payment-action"
                      >
                        <span>
                          {t("cloud-billing.plan.paymentAction", { amount: pa().amountDisplay })}
                        </span>
                        <Button
                          size="sm"
                          variant="primary"
                          data-testid="billing-confirm-payment"
                          onClick={() =>
                            setFrame({ action: "confirm_invoice", invoiceId: pa().invoiceId })
                          }
                        >
                          {t("cloud-billing.plan.confirmPayment")}
                        </Button>
                      </div>
                    )}
                  </Show>
                  <div class="mt-4 grid gap-2 sm:grid-cols-3" data-testid="billing-plans">
                    <For each={s().plans}>
                      {(p) => (
                        <div
                          class="rounded-md border border-border p-3 text-sm"
                          data-testid={`billing-plan-${p.id}`}
                        >
                          <p class="font-semibold text-text">{planName(p.id)}</p>
                          <p class="text-text">{p.priceDisplay}</p>
                          <p class="mt-1 text-xs text-text-secondary">
                            {t("cloud-billing.plan.includedCredits", {
                              credits: p.includedCredits,
                            })}
                          </p>
                          <div class="mt-2">
                            <Show
                              when={p.id !== s().plan}
                              fallback={
                                <span class="text-xs text-text-tertiary">
                                  {t("cloud-billing.plan.current")}
                                </span>
                              }
                            >
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={busy() || !!s().pendingChange}
                                data-testid={`billing-switch-${p.id}`}
                                onClick={() => void changePlan(p.id)}
                              >
                                {t("cloud-billing.plan.switchTo", { plan: planName(p.id) })}
                              </Button>
                            </Show>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </SettingsPageSection>

                <SettingsPageSection
                  title={t("cloud-billing.card.title")}
                  scope="org"
                  data-testid="billing-card"
                >
                  <div class="flex flex-wrap items-center justify-between gap-3 text-sm text-text">
                    <span>
                      <Show when={s().card} fallback={t("cloud-billing.card.none")}>
                        {(c) =>
                          t("cloud-billing.card.onFile", {
                            brand: c().brand,
                            last4: c().last4,
                            month: String(c().expMonth).padStart(2, "0"),
                            year: String(c().expYear),
                          })
                        }
                      </Show>
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      data-testid="billing-change-card"
                      onClick={() => setFrame({ action: "card" })}
                    >
                      {s().card ? t("cloud-billing.card.change") : t("cloud-billing.card.add")}
                    </Button>
                  </div>
                </SettingsPageSection>

                <SettingsPageSection
                  title={t("cloud-billing.credits.title")}
                  scope="org"
                  data-testid="billing-credits"
                >
                  <Show when={balance.latest}>
                    {(b) => (
                      <div class="text-sm text-text">
                        <Show when={b().credits?.total !== undefined}>
                          <p data-testid="billing-credits-left">
                            {t("cloud-billing.credits.left", {
                              credits: formatCreditAmount(b().credits?.total ?? 0),
                            })}
                          </p>
                        </Show>
                        <Show when={typeof b().period?.usedPercent === "number"}>
                          <p class="text-text-secondary" data-testid="billing-credits-used">
                            {t("cloud-billing.credits.usedPercent", {
                              percent: String(Math.round(b().period?.usedPercent ?? 0)),
                            })}
                          </p>
                        </Show>
                      </div>
                    )}
                  </Show>
                </SettingsPageSection>

                {/* While payment failed, top-ups wait behind the open invoice. */}
                <Show when={!paymentBlocked(s().status)}>
                  <SettingsPageSection
                    title={t("cloud-billing.topUp.title")}
                    description={t("cloud-billing.topUp.description")}
                    scope="org"
                    data-testid="billing-topup"
                  >
                    {(() => {
                      const credits = () => topUpCredits() ?? s().topUp.minCredits
                      const valid = () =>
                        Number.isInteger(credits()) && credits() >= s().topUp.minCredits
                      return (
                        <div class="flex flex-wrap items-end gap-3 text-sm">
                          <label class="flex flex-col gap-1">
                            <span class="text-text-secondary">
                              {t("cloud-billing.topUp.amount")}
                            </span>
                            <input
                              type="number"
                              min={s().topUp.minCredits}
                              step="1"
                              inputMode="numeric"
                              data-testid="billing-topup-credits"
                              class="w-32 rounded-sm border border-border bg-transparent px-2 py-1.5 text-text"
                              value={credits()}
                              onInput={(e) => setTopUpCredits(Number(e.currentTarget.value))}
                            />
                          </label>
                          <span class="pb-2 text-text-secondary" data-testid="billing-topup-price">
                            {valid()
                              ? t("cloud-billing.topUp.price", {
                                  price: topUpPrice(credits(), s().topUp),
                                })
                              : t("cloud-billing.topUp.minimum", {
                                  min: String(s().topUp.minCredits),
                                })}
                          </span>
                          <Button
                            size="sm"
                            disabled={busy() || !valid()}
                            data-testid="billing-topup-buy"
                            onClick={() => void buyCredits(credits())}
                          >
                            {t("cloud-billing.topUp.buy", { credits: String(credits()) })}
                          </Button>
                        </div>
                      )
                    })()}
                  </SettingsPageSection>

                  <SettingsPageSection
                    title={t("cloud-billing.autoTopUp.title")}
                    description={t("cloud-billing.autoTopUp.description")}
                    scope="org"
                    data-testid="billing-auto-topup"
                  >
                    {(() => {
                      const a = () => auto() ?? s().autoTopUp
                      const edit = (patch: Partial<BillingSummary["autoTopUp"]>) =>
                        setAuto({ ...a(), ...patch })
                      return (
                        <div class="flex flex-col gap-3 text-sm text-text">
                          <Show when={s().autoTopUp.lastFailure}>
                            {(f) => (
                              <p data-testid="billing-auto-topup-failure">
                                {t("cloud-billing.autoTopUp.lastFailure", {
                                  date: formatDate(f().at),
                                })}
                              </p>
                            )}
                          </Show>
                          <div class="flex items-center justify-between gap-3">
                            <span>{t("cloud-billing.autoTopUp.enabled")}</span>
                            <Switch
                              checked={a().enabled}
                              label={t("cloud-billing.autoTopUp.enabled")}
                              data-testid="billing-auto-topup-enabled"
                              onChange={(enabled) => edit({ enabled })}
                            />
                          </div>
                          <label class="flex items-center justify-between gap-3">
                            <span>{t("cloud-billing.autoTopUp.threshold")}</span>
                            <input
                              type="number"
                              min="0"
                              step="1"
                              data-testid="billing-auto-topup-threshold"
                              class="w-28 rounded-sm border border-border bg-transparent px-2 py-1.5"
                              value={a().thresholdCredits}
                              onInput={(e) =>
                                edit({ thresholdCredits: Number(e.currentTarget.value) })
                              }
                            />
                          </label>
                          <label class="flex items-center justify-between gap-3">
                            <span>{t("cloud-billing.autoTopUp.amount")}</span>
                            <input
                              type="number"
                              min={s().topUp.minCredits}
                              step="1"
                              data-testid="billing-auto-topup-amount"
                              class="w-28 rounded-sm border border-border bg-transparent px-2 py-1.5"
                              value={a().amountCredits}
                              onInput={(e) =>
                                edit({ amountCredits: Number(e.currentTarget.value) })
                              }
                            />
                          </label>
                          <div>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy() || auto() === null}
                              data-testid="billing-auto-topup-save"
                              onClick={() => void saveAuto()}
                            >
                              {t("cloud-billing.autoTopUp.save")}
                            </Button>
                          </div>
                        </div>
                      )
                    })()}
                  </SettingsPageSection>
                </Show>

                <SettingsPageSection
                  title={t("cloud-billing.invoices.title")}
                  scope="org"
                  data-testid="billing-invoices"
                >
                  <Show when={invoices.latest} fallback={<Skeleton class="h-16 w-full" />}>
                    {(list) => (
                      <Show
                        when={list().invoices.length > 0}
                        fallback={
                          <p class="text-sm text-text-secondary">
                            {t("cloud-billing.invoices.none")}
                          </p>
                        }
                      >
                        <ul class="divide-y divide-border rounded-md border border-border text-sm">
                          <For each={list().invoices}>
                            {(inv) => (
                              <li
                                class="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                                data-testid={`billing-invoice-${inv.id}`}
                              >
                                <span class="text-text">
                                  {inv.kind === "credit_note"
                                    ? `${t("cloud-billing.invoices.creditNote")} `
                                    : ""}
                                  {inv.number ?? ""}
                                </span>
                                <span class="text-text-secondary">{formatDate(inv.issuedAt)}</span>
                                <span class="text-text">{inv.amountDisplay}</span>
                                <span class="text-text-secondary">
                                  {t(`cloud-billing.invoices.status.${inv.status}`)}
                                </span>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => void download(inv)}
                                >
                                  {t("cloud-billing.invoices.download")}
                                </Button>
                              </li>
                            )}
                          </For>
                        </ul>
                      </Show>
                    )}
                  </Show>
                </SettingsPageSection>

                <SettingsPageSection
                  title={t("cloud-billing.cancel.title")}
                  description={t("cloud-billing.cancel.description")}
                  scope="org"
                  data-testid="billing-cancel"
                >
                  <Show
                    when={s().cancelAt}
                    fallback={
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy()}
                        data-testid="billing-cancel-action"
                        onClick={() => void cancel()}
                      >
                        {t("cloud-billing.cancel.action")}
                      </Button>
                    }
                  >
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy()}
                      data-testid="billing-resume-action"
                      onClick={() => void resume()}
                    >
                      {t("cloud-billing.cancel.resume")}
                    </Button>
                  </Show>
                </SettingsPageSection>
              </>
            )}
          </Show>
        </Show>
      </Suspense>
    </div>
  )
}

export default BillingSettings
