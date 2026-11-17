// SPDX-License-Identifier: FSL-1.1-ALv2
//
// R-07, signing in to the client portal. The form asks for an address and always
// answers with the same words, whoever it is. The mailed link opens a page with
// one button: opening it spends nothing (a mail scanner cannot burn the link),
// the click posts the link from memory. A second factor follows when the person
// or the company asked for one. "Access ended" is said plainly, with no detail.

import { type Component, createSignal, Match, Show, Switch } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { type Branding, portalAuthPost, portalPost, setPortalAccessToken } from "./portal-api"
import { forgetSignInLink, heldSignInLink } from "./sign-in-link"

const inputClass =
  "w-full rounded-md border border-border bg-bg px-3 py-2 text-[14px] text-text focus:outline-none focus:ring-2 focus:ring-accent/40"
const primaryClass =
  "min-h-[44px] rounded-md bg-accent px-4 text-[14px] font-medium text-accent-foreground disabled:opacity-60"

export const SignInCard: Component<{ branding: Branding | null; children: unknown }> = (props) => {
  const i18n = useI18n()
  return (
    <main class="flex min-h-screen items-start justify-center bg-bg px-4 py-16 text-text">
      <section
        data-testid="portal-signin"
        class="w-full max-w-[420px] rounded-xl border border-border bg-surface px-5 py-6"
      >
        <p class="text-[12px] uppercase tracking-wide text-text-tertiary">
          {i18n.t("portal.signin.eyebrow")}
        </p>
        <h1 data-testid="portal-signin-title" class="mt-1 text-[18px] font-semibold">
          {props.branding?.name
            ? i18n.t("portal.signin.titleOrg", { org: props.branding.name })
            : i18n.t("portal.signin.title")}
        </h1>
        <div class="mt-4 flex flex-col gap-3">{props.children as never}</div>
        <Show when={props.branding?.notice}>
          {(notice) => (
            <p
              data-testid="portal-signin-notice"
              class="mt-6 whitespace-pre-line border-t border-border pt-4 text-[12.5px] leading-5 text-text-secondary"
            >
              {notice()}
            </p>
          )}
        </Show>
      </section>
    </main>
  )
}

/** The address form: the same reply for every address, known or not. */
export const SignInForm: Component<{
  slug: string | null
  branding: Branding | null
  ended?: boolean
}> = (props) => {
  const i18n = useI18n()
  const [email, setEmail] = createSignal("")
  const [state, setState] = createSignal<"form" | "busy" | "sent" | "down">("form")
  const submit = async (e: Event) => {
    e.preventDefault()
    const slug = props.slug
    if (!slug || email().trim() === "") return
    setState("busy")
    const out = await portalAuthPost("request", { orgSlug: slug, email: email().trim() })
    setState(out.status === 0 || out.status >= 500 ? "down" : "sent")
  }
  return (
    <SignInCard branding={props.branding}>
      <Show when={props.ended}>
        <p data-testid="portal-access-ended" role="status" class="text-[13.5px] text-text">
          {i18n.t("portal.signin.ended")}
        </p>
      </Show>
      <Show
        when={props.slug}
        fallback={
          <p data-testid="portal-signin-no-org" class="text-[13.5px] text-text-secondary">
            {i18n.t("portal.signin.noOrg")}
          </p>
        }
      >
        <Switch>
          <Match when={state() === "sent"}>
            <p data-testid="portal-signin-sent" role="status" class="text-[13.5px] text-text">
              {i18n.t("portal.signin.sent")}
            </p>
          </Match>
          <Match when={state() !== "sent"}>
            <form class="flex flex-col gap-3" onSubmit={submit}>
              <label class="flex flex-col gap-1 text-[13px]">
                {i18n.t("portal.signin.email")}
                <input
                  data-testid="portal-signin-email"
                  type="email"
                  autocomplete="email"
                  required
                  class={inputClass}
                  value={email()}
                  onInput={(e) => setEmail(e.currentTarget.value)}
                />
              </label>
              <button
                type="submit"
                data-testid="portal-signin-submit"
                class={primaryClass}
                disabled={state() === "busy"}
              >
                {i18n.t("portal.signin.submit")}
              </button>
              <Show when={state() === "down"}>
                <p data-testid="portal-signin-down" class="text-[13px] text-text-secondary">
                  {i18n.t("portal.states.down")}
                </p>
              </Show>
            </form>
          </Match>
        </Switch>
      </Show>
    </SignInCard>
  )
}

type VerifyStep = "ready" | "busy" | "totp" | "enrol" | "invalid" | "down"

/** The mailed link's page: one button. Nothing is spent until it is clicked. */
export const VerifyPage: Component<{
  branding: Branding | null
  onSignedIn: () => void
}> = (props) => {
  const i18n = useI18n()
  const [step, setStep] = createSignal<VerifyStep>(heldSignInLink() ? "ready" : "invalid")
  const [challenge, setChallenge] = createSignal("")
  const [secret, setSecret] = createSignal<string | null>(null)
  const [code, setCode] = createSignal("")
  const [note, setNote] = createSignal<string | null>(null)

  const signedIn = (token: string | undefined) => {
    if (!token) {
      setStep("invalid")
      return
    }
    setPortalAccessToken(token)
    props.onSignedIn()
  }

  const go = async () => {
    const link = heldSignInLink()
    if (!link) {
      setStep("invalid")
      return
    }
    setStep("busy")
    const out = await portalAuthPost<{
      accessToken?: string
      totpRequired?: boolean
      challengeToken?: string
      enrolmentRequired?: boolean
      enrolmentToken?: string
    }>("verify", { challengeId: link.challengeId, token: link.token })
    forgetSignInLink()
    if (out.status === 0 || out.status >= 500) return setStep("down")
    if (out.status !== 200 || !out.data) return setStep("invalid")
    if (out.data.totpRequired && out.data.challengeToken) {
      setChallenge(out.data.challengeToken)
      return setStep("totp")
    }
    if (out.data.enrolmentRequired && out.data.enrolmentToken) {
      setPortalAccessToken(out.data.enrolmentToken)
      const setup = await portalPost<{ secret?: string }>("/me/totp/setup", {})
      if (setup.status !== 200 || !setup.data?.secret) return setStep("invalid")
      setSecret(setup.data.secret)
      return setStep("enrol")
    }
    signedIn(out.data.accessToken)
  }

  const sendTotp = async (e: Event) => {
    e.preventDefault()
    setNote(null)
    const out =
      step() === "totp"
        ? await portalAuthPost<{ accessToken?: string }>("totp", {
            challengeToken: challenge(),
            code: code(),
          })
        : await portalPost<{ accessToken?: string }>("/me/totp/confirm", { code: code() })
    if (out.status === 200) return signedIn(out.data?.accessToken)
    if (out.status === 0 || out.status >= 500) return setStep("down")
    setCode("")
    setNote(
      out.status === 429 ? i18n.t("portal.signin.tooMany") : i18n.t("portal.signin.totpInvalid"),
    )
  }

  return (
    <SignInCard branding={props.branding}>
      <Switch>
        <Match when={step() === "ready" || step() === "busy"}>
          <p class="text-[13.5px] text-text-secondary">{i18n.t("portal.signin.oneClick")}</p>
          <button
            type="button"
            data-testid="portal-verify-continue"
            class={primaryClass}
            disabled={step() === "busy"}
            onClick={go}
          >
            {props.branding?.name
              ? i18n.t("portal.signin.continueOrg", { org: props.branding.name })
              : i18n.t("portal.signin.continue")}
          </button>
        </Match>
        <Match when={step() === "totp" || step() === "enrol"}>
          <Show when={step() === "enrol" && secret()}>
            {(s) => (
              <div class="flex flex-col gap-1 text-[13px] text-text-secondary">
                <p>{i18n.t("portal.signin.enrol")}</p>
                <code
                  data-testid="portal-enrol-secret"
                  class="break-all rounded-md bg-surface-hover px-2 py-1 text-[13px] text-text"
                >
                  {s()}
                </code>
              </div>
            )}
          </Show>
          <form class="flex flex-col gap-3" onSubmit={sendTotp}>
            <label class="flex flex-col gap-1 text-[13px]">
              {i18n.t("portal.signin.totp")}
              <input
                data-testid="portal-totp-code"
                inputmode="numeric"
                autocomplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                class={inputClass}
                value={code()}
                onInput={(e) => setCode(e.currentTarget.value.replace(/\D/g, ""))}
              />
            </label>
            <button type="submit" data-testid="portal-totp-submit" class={primaryClass}>
              {i18n.t("portal.signin.totpSubmit")}
            </button>
            <Show when={note()}>
              {(n) => (
                <p data-testid="portal-totp-note" role="status" class="text-[13px] text-text">
                  {n()}
                </p>
              )}
            </Show>
          </form>
        </Match>
        <Match when={step() === "invalid"}>
          <p data-testid="portal-verify-invalid" role="status" class="text-[13.5px] text-text">
            {i18n.t("portal.signin.linkInvalid")}
          </p>
        </Match>
        <Match when={step() === "down"}>
          <p data-testid="portal-verify-down" role="status" class="text-[13.5px] text-text">
            {i18n.t("portal.states.down")}
          </p>
        </Match>
      </Switch>
    </SignInCard>
  )
}
