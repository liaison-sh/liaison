// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "Confirm your email so the agents can run."
//
// The code was mailed when the workspace was created, so most visitors only
// paste it. One input, paste friendly (`autocomplete="one-time-code"`,
// numeric keyboard), the masked address it went to, a resend that runs a fresh
// invisible Turnstile, and a success line. It takes focus by itself when a
// spend is refused for want of a confirmed address (demo-store.ts listens).
//
// Two placements, one component: step 1 of the welcome popup (`welcome`,
// DemoWelcome.tsx) and the guided tour's gate on a step that needs the agents
// (`gate`).
import { type Component, createEffect, createSignal, type JSX, on, onMount, Show } from "solid-js"
import {
  type DemoCodeFailure,
  demoHasOwnKey,
  demoVerification,
  demoVerifyFocusRequest,
  demoWorkspace,
  ensureDemoDoorSettings,
  refreshDemoBudget,
  resendDemoCode,
  submitDemoCode,
} from "~/modules/demo/demo-store"
import { createTurnstile } from "~/modules/demo/Turnstile"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"

export type DemoVerifyStatus =
  | "idle"
  | "checking"
  | "sending"
  | "sent"
  | "invalid"
  | "expired"
  | "exhausted"
  | "error"
  | "verified"

export interface DemoVerifyPromptProps {
  variant?: "welcome" | "gate"
  /** Under the form (the welcome popup's "Use your own model key instead"). */
  children?: JSX.Element
}

export const DemoVerifyPrompt: Component<DemoVerifyPromptProps> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const turnstile = createTurnstile()
  const [code, setCode] = createSignal("")
  const [status, setStatus] = createSignal<DemoVerifyStatus>("idle")
  const [attemptsLeft, setAttemptsLeft] = createSignal(0)
  const [message, setMessage] = createSignal("")
  let input: HTMLInputElement | undefined

  onMount(() => {
    void ensureDemoDoorSettings()
    if (demoVerification() === null && demoWorkspace()) void refreshDemoBudget(api)
  })

  // A refused spend asks for the code: take focus, once per request.
  createEffect(
    on(
      demoVerifyFocusRequest,
      (n) => {
        if (n > 0) input?.focus()
      },
      { defer: true },
    ),
  )

  const visible = () => {
    const v = demoVerification()
    if (status() === "verified") return true
    // A visitor on their own key needs no code: the popup stops asking (the
    // tour's gate, and the budget page, still offer it).
    if (props.variant !== "gate" && demoHasOwnKey()) return false
    return v !== null && !v.verified
  }

  // Say what happened to the code: sent, or not sent (the box could not mail it).
  const body = () =>
    demoVerification()?.codeSent === false && status() !== "sent"
      ? i18n.t("kernel.demo.verifyMailUnavailable")
      : i18n.t("kernel.demo.verifyBody", {
          email: demoVerification()?.emailMasked ?? i18n.t("kernel.demo.verifyYourAddress"),
        })

  function fail(failure: DemoCodeFailure): void {
    switch (failure.kind) {
      case "invalid":
        setAttemptsLeft(failure.attemptsLeft)
        setStatus(failure.attemptsLeft > 0 ? "invalid" : "exhausted")
        return
      case "expired":
        setStatus("expired")
        return
      case "exhausted":
        setStatus("exhausted")
        return
      case "send_limited":
        setMessage(i18n.t("kernel.demo.verifySendLimited"))
        break
      case "verify_limited":
        setMessage(i18n.t("kernel.demo.verifyLimited"))
        break
      case "turnstile":
        setMessage(i18n.t("kernel.demo.errTurnstile"))
        break
      case "mail_unavailable":
        setMessage(i18n.t("kernel.demo.verifyMailUnavailable"))
        break
      default:
        setMessage(i18n.t("kernel.demo.verifyFailed"))
    }
    setStatus("error")
  }

  async function submit(event: Event): Promise<void> {
    event.preventDefault()
    const value = code().replace(/\D/g, "")
    if (value.length !== 6 || status() === "checking") return
    setStatus("checking")
    try {
      await submitDemoCode(api, value)
      setStatus("verified")
      setCode("")
    } catch (err) {
      fail(err as DemoCodeFailure)
    }
  }

  async function resend(): Promise<void> {
    if (status() === "sending") return
    setStatus("sending")
    try {
      const token = await turnstile.token("demo_code")
      await resendDemoCode(api, token)
      setStatus("sent")
    } catch (err) {
      fail(err as DemoCodeFailure)
    }
  }

  const statusLine = () => {
    switch (status()) {
      case "sent":
        return i18n.t("kernel.demo.verifyResent")
      case "invalid":
        return i18n.t("kernel.demo.verifyCodeInvalidLeft", { count: attemptsLeft() })
      case "expired":
        return i18n.t("kernel.demo.verifyCodeExpired")
      case "exhausted":
        return i18n.t("kernel.demo.verifyAttemptsExhausted")
      case "error":
        return message()
      default:
        return ""
    }
  }

  return (
    <Show when={visible()}>
      <div
        data-testid={props.variant === "gate" ? "demo-verify-gate" : "demo-verify"}
        data-status={status()}
        class={
          props.variant === "gate"
            ? "flex flex-col gap-2 rounded-md border border-border bg-surface p-3"
            : "flex flex-col gap-2 rounded-lg border border-border bg-surface p-3"
        }
      >
        <Show
          when={status() !== "verified"}
          fallback={
            <p data-testid="demo-verify-success" role="status" class="text-[13px] text-text">
              {i18n.t("kernel.demo.verifySuccess")}
            </p>
          }
        >
          <div class="flex flex-col gap-0.5">
            <p class="text-[13px] font-medium text-text">
              {props.variant === "gate"
                ? i18n.t("kernel.demo.verifyTitle")
                : i18n.t("tours.engine.welcome.codeLead")}
            </p>
            <p data-testid="demo-verify-body" class="text-[12px] leading-snug text-text-secondary">
              {body()}
            </p>
          </div>
          <form class="flex flex-wrap items-center gap-2" onSubmit={(e) => void submit(e)}>
            <input
              ref={(el) => {
                input = el
              }}
              data-testid="demo-verify-code"
              aria-label={i18n.t("kernel.demo.verifyCodeLabel")}
              placeholder="123456"
              autocomplete="one-time-code"
              inputmode="numeric"
              maxLength={12}
              value={code()}
              onInput={(e) => setCode(e.currentTarget.value)}
              // In the popup the code fills its row on a phone.
              class={`h-8 min-w-0 rounded-sm border border-border bg-bg px-2 font-mono text-[14px] tracking-[0.2em] text-text ${
                props.variant === "gate" ? "w-32" : "flex-1 sm:w-32 sm:flex-none"
              }`}
            />
            <Button
              type="submit"
              size="sm"
              data-testid="demo-verify-submit"
              loading={status() === "checking"}
              disabled={status() === "checking" || code().replace(/\D/g, "").length !== 6}
            >
              {i18n.t("kernel.demo.verifySubmit")}
            </Button>
            <button
              type="button"
              data-testid="demo-verify-resend"
              disabled={status() === "sending"}
              onClick={() => void resend()}
              class={`text-left text-[12px] text-text-secondary underline underline-offset-2 hover:text-text disabled:opacity-50 ${
                props.variant === "gate" ? "" : "basis-full sm:basis-auto"
              }`}
            >
              {status() === "sending"
                ? i18n.t("kernel.demo.verifySending")
                : i18n.t("kernel.demo.verifyResend")}
            </button>
            <turnstile.Widget />
          </form>
          <Show when={statusLine()}>
            <p
              data-testid="demo-verify-status"
              role={status() === "sent" ? "status" : "alert"}
              class={`text-[12px] ${status() === "sent" ? "text-text-secondary" : "text-error"}`}
            >
              {statusLine()}
            </p>
          </Show>
          {props.children}
        </Show>
      </div>
    </Show>
  )
}

/** The tour panel's gate for a step that waits on a confirmed address. */
export const DemoVerifyGate: Component = () => <DemoVerifyPrompt variant="gate" />
