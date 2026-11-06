// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The demo's "next steps" dialog: one dialog, two moments.
//
//   budget  the budget is spent (it opens by itself on the first refusal that
//           says so, once per workspace: demo-store `openDemoNextStepsOnce`),
//           or the visitor opened it from the banner (any budget state)
//   end     the visitor finished their last scenario (DemoScenarioRunner): it
//           replaces that scenario's completion card
//
// Both show the same recap with the session's real numbers: scenarios done
// (GET /demo/scenarios, the runner's queue), agent actions and approvals the
// visitor decided and minutes since the workspace started (GET /demo/recap),
// then the ways forward, side by side:
//
//   setup    "We set it up for you": the box's booking link (public branding
//            `demo.bookingUrl`); a web page gets the visitor's address and the
//            scenarios they saw as query parameters, a `mailto:` opens as is
//   key      the demo's own key form (DemoByokPrompt): a key of the visitor's
//            own has no budget here
//   self     the self-hosting guide (`demo.selfHostUrl`)
//
// A work address puts setup first, a personal one (a webmail domain) the key.
// Each link option is absent when the box names no link.
import { type Component, createEffect, createSignal, For, type JSX, on, Show } from "solid-js"
import { cn } from "~/lib/cn"
import { DemoByokPrompt } from "~/modules/demo/DemoByokPrompt"
import { demoScenarioQueue, demoScenarioQueueLoaded } from "~/modules/demo/DemoScenarioRunner"
import { DemoVerifyPrompt } from "~/modules/demo/DemoVerifyPrompt"
import {
  closeDemoNextSteps,
  type DemoBudgetState,
  type DemoNextStepsMoment,
  demoBudget,
  demoBudgetHeadline,
  demoDoorSettings,
  demoLastExhaustedRefusal,
  demoNextSteps,
  ensureDemoDoorSettings,
  openDemoNextSteps,
  refreshDemoBudget,
  requestManagedNotice,
} from "~/modules/demo/demo-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { pluralFormFor } from "~/modules/projects/plural"
import { useOptionalApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"

/** What the visitor did here (GET /demo/recap, apps/api/src/modules/demo/demo-recap.ts). */
export interface DemoRecap {
  startedAt: string
  agentActions: number
  approvalsDecided: number
}

/** Webmail domains matched whole. */
const PERSONAL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "msn.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "tutanota.com",
  "fastmail.com",
  "zoho.com",
  "mail.ru",
  "web.de",
  "free.fr",
  "orange.fr",
  "laposte.net",
  "wanadoo.fr",
  "sfr.fr",
  "neuf.fr",
  "bbox.fr",
])

/** Webmail providers matched on the first label, any country domain (yahoo.fr, gmx.de). */
const PERSONAL_PROVIDERS = new Set([
  "outlook",
  "hotmail",
  "live",
  "yahoo",
  "ymail",
  "gmx",
  "yandex",
])

/** Is `email` a personal (webmail) address? Unknown or malformed reads as work. */
export function isPersonalEmail(email: string | null | undefined): boolean {
  const domain = email?.split("@")[1]?.trim().toLowerCase()
  if (!domain) return false
  return PERSONAL_DOMAINS.has(domain) || PERSONAL_PROVIDERS.has(domain.split(".")[0] ?? "")
}

/**
 * The setup option's link: a web page gets what the contact form needs as
 * query parameters, any other link (a `mailto:`) is used as is.
 */
export function demoContactUrl(
  base: string,
  email: string | null | undefined,
  seen: readonly string[],
): string {
  if (!/^https?:/i.test(base)) return base
  const url = new URL(base)
  url.searchParams.set("topic", "setup")
  url.searchParams.set("from", "demo")
  if (email) url.searchParams.set("email", email)
  if (seen.length > 0) url.searchParams.set("scenarios", seen.join(","))
  return url.toString()
}

type PathId = "setup" | "key" | "self"

/** The options in the visitor's order: setup first for a work address, the key for a personal one. */
export function orderedPaths(available: readonly PathId[], personal: boolean): PathId[] {
  const order: PathId[] = personal ? ["key", "self", "setup"] : ["setup", "key", "self"]
  return order.filter((id) => available.includes(id))
}

/** What the budget moment headlines (the refusal that opened it wins over a stale read). */
type Headline = "spent" | "box" | "unverified" | "open"

function headlineFor(b: DemoBudgetState | null, refusal: string | null): Headline {
  const h = demoBudgetHeadline(b) ?? "open"
  const ownKey = (b?.byok?.length ?? 0) > 0
  if (h !== "open" || ownKey) return h
  if (refusal === "demo_box_exhausted") return "box"
  if (refusal === "demo_budget_exhausted" || refusal === "demo_network_exhausted") return "spent"
  return h
}

function euros(micro: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency: "EUR" }).format(micro / 1e6)
}

export const DemoNextSteps: Component = () => {
  const i18n = useI18n()
  const api = useOptionalApi()
  const [recap, setRecap] = createSignal<DemoRecap | null>(null)
  const [keyOpen, setKeyOpen] = createSignal(false)
  const [notifyState, setNotifyState] = createSignal<"idle" | "sending" | "verify" | "done">("idle")

  // Fresh numbers each time it opens.
  createEffect(
    on(demoNextSteps, (moment) => {
      if (!moment) return
      setKeyOpen(false)
      setNotifyState("idle")
      void ensureDemoDoorSettings()
      if (!api) return
      void refreshDemoBudget(api)
      api
        .get<DemoRecap>("/demo/recap", { suppressGlobalError: true })
        .then(setRecap)
        .catch(() => {
          // The recap line shows what it has; the scenario count needs no read.
        })
    }),
  )

  const moment = (): DemoNextStepsMoment => demoNextSteps() ?? "budget"
  const plural = (n: number) => pluralFormFor(i18n.locale(), n)
  const b = demoBudget
  const ownKey = () => (b()?.byok?.length ?? 0) > 0
  const headline = () => headlineFor(b(), demoLastExhaustedRefusal())
  const leftMicro = () => {
    const budget = b()?.budget
    return budget ? Math.max(0, budget.capMicroEur - budget.usedMicroEur) : 0
  }
  const cap = () => euros(b()?.budget.capMicroEur ?? 0, i18n.locale())

  const queue = () => (demoScenarioQueueLoaded() ? demoScenarioQueue() : [])
  const done = () => queue().filter((item) => item.status === "completed")
  const remaining = () => queue().filter((item) => item.status !== "completed")
  const minutes = () => {
    const at = Date.parse(recap()?.startedAt ?? "")
    return Number.isFinite(at) ? Math.max(0, Math.round((Date.now() - at) / 60_000)) : null
  }

  const eyebrow = () => {
    if (moment() === "end") return i18n.t("kernel.demo.next.eyebrowEnd")
    return headline() === "spent" || headline() === "box"
      ? i18n.t("kernel.demo.next.eyebrowSpent")
      : i18n.t("kernel.demo.next.eyebrowBudget")
  }
  const title = () => {
    if (moment() === "end") {
      const n = queue().length
      return plural(n) === "one"
        ? i18n.t("kernel.demo.next.endTitleOne")
        : i18n.t("kernel.demo.next.endTitleOther", { count: n })
    }
    switch (headline()) {
      case "spent":
        return i18n.t("kernel.demo.next.spentTitle")
      case "box":
        return i18n.t("kernel.demo.budgetTitleBox")
      case "unverified":
        return i18n.t("kernel.demo.budgetTitleUnverified")
      default:
        return i18n.t("kernel.demo.budgetTitleOpen")
    }
  }
  const lead = () => {
    if (moment() === "end") return i18n.t("kernel.demo.next.endLead")
    switch (headline()) {
      case "spent":
        return i18n.t("kernel.demo.next.spentLead", {
          used: euros(b()?.budget.usedMicroEur ?? 0, i18n.locale()),
          cap: cap(),
        })
      case "box":
        return i18n.t("kernel.demo.budgetLeadBox")
      case "unverified":
        return i18n.t("kernel.demo.budgetLeadUnverified")
      default:
        return i18n.t("kernel.demo.budgetLeadOpen")
    }
  }

  // "Keep exploring" leads while the agents can still run.
  const showExplore = () =>
    b() !== null &&
    (moment() === "end" || headline() === "open") &&
    (ownKey() || (headline() === "open" && leftMicro() > 0))
  const spent = () => headline() === "spent" || headline() === "box"

  const personal = () => isPersonalEmail(b()?.email)
  const paths = () =>
    orderedPaths(
      [
        ...(demoDoorSettings()?.bookingUrl ? (["setup"] as const) : []),
        ...(ownKey() ? [] : (["key"] as const)),
        ...(demoDoorSettings()?.selfHostUrl ? (["self"] as const) : []),
      ],
      personal(),
    )
  // The first option stands out; at the end only setup does (the key is no
  // urgent step while the budget lasts).
  const primary = (id: PathId) => paths()[0] === id && (moment() === "budget" || id === "setup")

  function openLink(href: string): void {
    if (/^https?:/i.test(href)) window.open(href, "_blank", "noopener,noreferrer")
    else window.location.href = href
  }

  async function notify(): Promise<void> {
    if (!api || notifyState() === "sending") return
    setNotifyState("sending")
    try {
      setNotifyState((await requestManagedNotice(api)) ? "done" : "verify")
    } catch {
      setNotifyState("idle")
    }
  }
  // Ticked on the form but not confirmed yet is not done: the button stays, and
  // pressing it asks for the code.
  const notified = () =>
    notifyState() === "done" || (b()?.notifyManaged === true && b()?.verified === true)

  const card = (id: PathId): JSX.Element => {
    const title = () =>
      id === "setup"
        ? i18n.t("kernel.demo.next.setupTitle")
        : id === "self"
          ? i18n.t("kernel.demo.next.selfTitle")
          : moment() === "end"
            ? i18n.t("kernel.demo.next.keyTitleEnd")
            : i18n.t("kernel.demo.next.keyTitleBudget")
    const badge = () => i18n.t(`kernel.demo.next.${id}Badge`)
    const body = () =>
      id === "setup"
        ? i18n.t("kernel.demo.next.setupBody")
        : id === "self"
          ? i18n.t("kernel.demo.next.selfBody")
          : moment() === "end"
            ? i18n.t("kernel.demo.next.keyBodyEnd", { cap: cap() })
            : i18n.t("kernel.demo.next.keyBodyBudget")
    const action = () =>
      id === "setup"
        ? i18n.t("kernel.demo.next.setupAction")
        : id === "self"
          ? i18n.t("kernel.demo.next.selfAction")
          : i18n.t("kernel.demo.next.keyAction")
    const onClick = () => {
      const settings = demoDoorSettings()
      if (id === "key") setKeyOpen((v) => !v)
      else if (id === "setup" && settings?.bookingUrl)
        openLink(
          demoContactUrl(
            settings.bookingUrl,
            b()?.email,
            done().map((item) => item.need),
          ),
        )
      else if (id === "self" && settings?.selfHostUrl) openLink(settings.selfHostUrl)
    }
    return (
      <section
        data-testid={`demo-next-${id}`}
        data-primary={primary(id) ? "" : undefined}
        class={cn(
          "flex min-w-0 flex-col gap-1.5 rounded-lg border bg-surface px-3.5 py-3",
          primary(id) ? "border-border-strong ring-[3px] ring-surface-active" : "border-border",
        )}
      >
        <h3 class="flex flex-wrap items-center gap-1.5 text-[14px] font-semibold text-text">
          {title()}
          <span
            class={cn(
              "rounded-full px-2 py-0.5 text-[11px] font-semibold",
              primary(id)
                ? "bg-accent text-accent-foreground"
                : "bg-surface-active text-text-secondary",
            )}
          >
            {badge()}
          </span>
        </h3>
        <p class="flex-1 text-[12.5px] leading-snug text-text-secondary">{body()}</p>
        <Button
          size="md"
          variant={primary(id) ? "default" : "outline"}
          class="mt-1 w-full"
          data-testid={`demo-next-${id}-action`}
          aria-expanded={id === "key" ? keyOpen() : undefined}
          onClick={onClick}
        >
          {action()}
        </Button>
        <Show when={id === "key" && keyOpen()}>
          <div
            data-testid="demo-next-key-form"
            class="mt-1 flex flex-col gap-1 border-t border-dashed border-border pt-2"
          >
            <DemoByokPrompt standalone />
            <p class="text-[11.5px] text-text-tertiary">{i18n.t("kernel.demo.next.keyHint")}</p>
          </div>
        </Show>
      </section>
    )
  }

  return (
    <Dialog open={demoNextSteps() !== null} onOpenChange={(open) => !open && closeDemoNextSteps()}>
      <Dialog.Content class="max-h-[calc(100dvh-24px)] max-w-[800px] overflow-y-auto p-0">
        <div
          data-testid="demo-next-steps"
          data-moment={moment()}
          data-state={b() ? headline() : undefined}
          data-tour-clear=""
        >
          <header class="relative px-6 pb-1 pt-5">
            <button
              type="button"
              data-testid="demo-next-close"
              aria-label={i18n.t("kernel.demo.next.close")}
              onClick={closeDemoNextSteps}
              class="absolute right-4 top-4 flex h-7 w-7 items-center justify-center rounded-md text-text-tertiary hover:bg-surface-hover"
            >
              ✕
            </button>
            <p class="font-mono text-[11px] uppercase tracking-wider text-text-tertiary">
              {eyebrow()}
            </p>
            <Dialog.Title class="mt-1.5 pr-8 text-[22px] font-medium leading-tight">
              {title()}
            </Dialog.Title>
            <p
              data-testid="demo-next-lead"
              class="mt-1.5 text-[14px] leading-snug text-text-secondary"
            >
              {lead()}
            </p>
          </header>

          <div
            data-testid="demo-next-recap"
            class="mx-6 mt-3 flex flex-wrap gap-x-5 gap-y-1.5 rounded-lg border border-border bg-surface px-3 py-2 text-[12.5px] text-text-secondary"
          >
            <Show when={queue().length > 0}>
              <span class="flex items-baseline gap-1.5">
                <b
                  data-testid="demo-next-recap-scenarios"
                  class="text-[16px] font-medium text-text"
                >
                  {`${done().length} / ${queue().length}`}
                </b>
                {i18n.t("kernel.demo.next.recapScenarios")}
              </span>
            </Show>
            <Show when={recap()}>
              {(r) => (
                <>
                  <span class="flex items-baseline gap-1.5">
                    <b
                      data-testid="demo-next-recap-actions"
                      class="text-[16px] font-medium text-text"
                    >
                      {r().agentActions}
                    </b>
                    {plural(r().agentActions) === "one"
                      ? i18n.t("kernel.demo.next.recapActionsOne")
                      : i18n.t("kernel.demo.next.recapActionsOther")}
                  </span>
                  <span class="flex items-baseline gap-1.5">
                    <b
                      data-testid="demo-next-recap-approvals"
                      class="text-[16px] font-medium text-text"
                    >
                      {r().approvalsDecided}
                    </b>
                    {plural(r().approvalsDecided) === "one"
                      ? i18n.t("kernel.demo.next.recapApprovalsOne")
                      : i18n.t("kernel.demo.next.recapApprovalsOther")}
                  </span>
                </>
              )}
            </Show>
            <Show when={minutes() !== null}>
              <span class="flex items-baseline gap-1.5">
                <b data-testid="demo-next-recap-minutes" class="text-[16px] font-medium text-text">
                  {i18n.t("kernel.demo.next.recapMinutes", { count: minutes() ?? 0 })}
                </b>
                {i18n.t("kernel.demo.next.recapMinutesLabel")}
              </span>
            </Show>
          </div>

          <Show when={moment() === "budget" && headline() === "unverified"}>
            <div class="mx-6 mt-3">
              <DemoVerifyPrompt variant="gate" />
            </div>
          </Show>

          <Show when={showExplore()}>
            <div
              data-testid="demo-next-explore"
              class="mx-6 mt-3 grid grid-cols-[1fr_auto] items-center gap-4 rounded-lg border border-border-strong px-3.5 py-2.5 ring-[3px] ring-surface-active"
            >
              <div class="min-w-0">
                <p class="text-[15px] font-semibold text-text">
                  {i18n.t("kernel.demo.next.exploreTitle")}
                </p>
                <p
                  data-testid="demo-next-explore-body"
                  class="mt-1 text-[12.5px] leading-snug text-text-secondary"
                >
                  {ownKey()
                    ? i18n.t("kernel.demo.next.exploreOwnKey", {
                        example: i18n.t("kernel.demo.next.exploreExample"),
                      })
                    : i18n.t("kernel.demo.next.exploreBody", {
                        left: euros(leftMicro(), i18n.locale()),
                        cap: cap(),
                        example: i18n.t("kernel.demo.next.exploreExample"),
                      })}
                </p>
                <Show when={!ownKey()}>
                  <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-active">
                    <div
                      data-testid="demo-next-explore-bar"
                      class="h-full bg-success"
                      style={{
                        width: `${Math.round((leftMicro() / Math.max(1, b()?.budget.capMicroEur ?? 1)) * 100)}%`,
                      }}
                    />
                  </div>
                </Show>
              </div>
              <Button data-testid="demo-next-explore-action" onClick={closeDemoNextSteps}>
                {i18n.t("kernel.demo.next.exploreTitle")}
              </Button>
            </div>
          </Show>

          <Show when={paths().length > 0}>
            <h2 class="mx-6 mb-2 mt-4 text-[13px] font-semibold text-text">
              {moment() === "end"
                ? i18n.t("kernel.demo.next.pathsEnd")
                : i18n.t("kernel.demo.next.pathsBudget")}
            </h2>
            <div
              data-testid="demo-next-paths"
              class={cn(
                "mx-6 grid grid-cols-1 gap-2.5",
                paths().length === 3 ? "sm:grid-cols-3" : paths().length === 2 && "sm:grid-cols-2",
              )}
            >
              <For each={paths()}>{(id) => card(id)}</For>
            </div>
          </Show>

          <Show when={moment() === "budget" && remaining().length > 0}>
            <div
              data-testid="demo-next-remaining"
              class="mx-6 mt-3 flex flex-wrap items-center gap-1.5 text-[12.5px] text-text-secondary"
            >
              <span>
                {i18n.t(
                  `kernel.demo.next.remaining${spent() ? "Key" : ""}${plural(remaining().length) === "one" ? "One" : "Other"}`,
                  { count: remaining().length },
                )}
              </span>
              <For each={queue()}>
                {(item) => (
                  <span
                    data-testid={`demo-next-chip-${item.need}`}
                    data-done={item.status === "completed" ? "" : undefined}
                    class={cn(
                      "rounded-full border border-border bg-surface px-2 py-0.5 text-[11.5px]",
                      item.status === "completed" && "text-text-tertiary line-through",
                    )}
                  >
                    {i18n.t(`kernel.demo.needShort.${item.need}`)}
                  </span>
                )}
              </For>
            </div>
          </Show>

          <footer class="mt-3.5 flex flex-wrap items-center justify-between gap-3 border-t border-border px-6 py-3 text-[13px]">
            <div class="min-w-0">
              <Show
                when={!notified()}
                fallback={
                  <p data-testid="demo-next-notify-done" role="status" class="text-text">
                    {i18n.t("kernel.demo.next.notifyDone")}
                  </p>
                }
              >
                <Show
                  when={notifyState() !== "verify"}
                  fallback={<DemoVerifyPrompt variant="gate" />}
                >
                  <button
                    type="button"
                    data-testid="demo-next-notify"
                    disabled={notifyState() === "sending"}
                    onClick={() => void notify()}
                    class="text-text-secondary underline underline-offset-2 hover:text-text"
                  >
                    {i18n.t("kernel.demo.next.notify")}
                  </button>
                </Show>
              </Show>
            </div>
            <Show when={!showExplore()}>
              <Button
                variant="outline"
                data-testid="demo-next-continue"
                onClick={closeDemoNextSteps}
              >
                {i18n.t("kernel.demo.next.continue")}
              </Button>
            </Show>
          </footer>
        </div>
      </Dialog.Content>
    </Dialog>
  )
}

/** "Want this for your company?" in the demo banner: opens the dialog. */
export const DemoNextStepsBannerEntry: Component = () => {
  const i18n = useI18n()
  return (
    <button
      type="button"
      data-testid="demo-next-steps-open"
      onClick={() => openDemoNextSteps("budget")}
      class="font-medium text-text underline underline-offset-2"
    >
      {i18n.t("kernel.demo.next.bannerLink")}
    </button>
  )
}
