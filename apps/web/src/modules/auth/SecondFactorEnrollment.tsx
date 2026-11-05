// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The screen an administrator lands on when their organisation requires
// two-step verification for administrators and they have not set it up. Their
// session can do nothing else (apps/api modules/auth/admin-second-factor.ts):
// they confirm it is them with an emailed code, scan the authenticator QR code,
// keep the recovery codes, confirm a code, and the session is renewed whole.

import QRCode from "qrcode"
import { type Component, createEffect, createSignal, For, Show } from "solid-js"
import { authApiPath } from "~/lib/env"
import { restoreSession } from "~/modules/auth/auth-store"
import { authManager } from "~/modules/auth/createAuthManager"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"
import { Input } from "~/ui/Input"

const SecondFactorEnrollment: Component = () => {
  const i18n = useI18n()
  const api = useApi()
  const [step, setStep] = createSignal<"verify" | "setup" | "confirm">("verify")
  const [codeSent, setCodeSent] = createSignal(false)
  const [stepUpCode, setStepUpCode] = createSignal("")
  const [otpauthUri, setOtpauthUri] = createSignal("")
  const [recoveryCodes, setRecoveryCodes] = createSignal<string[]>([])
  const [confirmCode, setConfirmCode] = createSignal("")
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal("")

  async function sendCode() {
    setError("")
    setLoading(true)
    try {
      await api.post(authApiPath("/totp/step-up"), {})
      setCodeSent(true)
    } catch {
      setError(i18n.t("kernel.secondFactorRequired.sendFailed"))
    } finally {
      setLoading(false)
    }
  }

  async function submitStepUp(e: Event) {
    e.preventDefault()
    setError("")
    setLoading(true)
    try {
      const result = await api.post<{ otpauthUri: string; recoveryCodes: string[] }>(
        authApiPath("/totp/setup"),
        { stepUpCode: stepUpCode() },
      )
      setOtpauthUri(result.otpauthUri)
      setRecoveryCodes(result.recoveryCodes)
      setStep("setup")
    } catch {
      setError(i18n.t("kernel.secondFactorRequired.invalidCode"))
    } finally {
      setLoading(false)
    }
  }

  let qrCanvasRef!: HTMLCanvasElement
  createEffect(() => {
    const uri = otpauthUri()
    if (uri && step() === "setup") {
      requestAnimationFrame(() => {
        if (qrCanvasRef?.isConnected) QRCode.toCanvas(qrCanvasRef, uri, { width: 200, margin: 2 })
      })
    }
  })

  async function confirm(e: Event) {
    e.preventDefault()
    setError("")
    setLoading(true)
    try {
      await api.post(authApiPath("/totp/confirm"), { code: confirmCode() })
      // The next session carries the person's full access again.
      await restoreSession()
    } catch {
      setError(i18n.t("kernel.secondFactorRequired.invalidCode"))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div class="flex min-h-screen items-center justify-center bg-bg px-4">
      <div
        class="w-full max-w-sm rounded-lg border border-border bg-surface p-6"
        data-testid="second-factor-enrollment"
      >
        <h1 class="mb-2 text-lg font-semibold text-text">
          {i18n.t("kernel.secondFactorRequired.title")}
        </h1>
        <p class="mb-4 text-sm text-text-secondary">{i18n.t("kernel.secondFactorRequired.desc")}</p>

        <Show when={step() === "verify"}>
          <Show
            when={codeSent()}
            fallback={
              <Button
                fullWidth
                onClick={sendCode}
                loading={loading()}
                data-testid="second-factor-send-code"
              >
                {i18n.t("kernel.settingsUi.emailMeACode")}
              </Button>
            }
          >
            <form onSubmit={submitStepUp} class="flex flex-col gap-3">
              <Input
                placeholder="000000"
                maxLength={6}
                value={stepUpCode()}
                onInput={(e) => setStepUpCode((e.currentTarget as HTMLInputElement).value)}
                autofocus
                autocomplete="one-time-code"
                data-testid="second-factor-step-up-code"
              />
              <Button fullWidth type="submit" loading={loading()}>
                {i18n.t("kernel.common.continue")}
              </Button>
              <button
                type="button"
                class="text-xs text-accent-muted hover:text-accent"
                onClick={sendCode}
              >
                {i18n.t("kernel.settingsUi.resendCode")}
              </button>
            </form>
          </Show>
        </Show>

        <Show when={step() === "setup"}>
          <p class="text-sm text-text-secondary">
            {i18n.t("kernel.settingsUi.scanThisQrCodeWithYour")}
          </p>
          <div class="my-4 flex justify-center rounded-md bg-white p-4">
            <canvas ref={qrCanvasRef} />
          </div>
          <h2 class="mb-2 text-xs font-medium text-text-secondary">
            {i18n.t("kernel.recoveryCodes")}
          </h2>
          <p class="mb-1 text-xs text-text-tertiary">
            {i18n.t("kernel.settingsUi.saveTheseCodesSecurelyYouCan")}
          </p>
          <div class="mb-4 grid grid-cols-2 gap-1 rounded-md bg-bg p-3 font-mono text-xs text-text">
            <For each={recoveryCodes()}>{(code) => <span>{code}</span>}</For>
          </div>
          <Button size="sm" onClick={() => setStep("confirm")}>
            {i18n.t("kernel.settingsUi.iVeSavedMyRecoveryCodes")}
          </Button>
        </Show>

        <Show when={step() === "confirm"}>
          <form onSubmit={confirm} class="flex flex-col gap-3">
            <p class="text-sm text-text-secondary">
              {i18n.t("kernel.settingsUi.enterThe6DigitCodeFrom")}
            </p>
            <Input
              placeholder="000000"
              maxLength={6}
              value={confirmCode()}
              onInput={(e) => setConfirmCode((e.currentTarget as HTMLInputElement).value)}
              autofocus
              autocomplete="one-time-code"
              data-testid="second-factor-confirm-code"
            />
            <Button fullWidth type="submit" loading={loading()}>
              {i18n.t("kernel.settingsUi.verifyAndEnable")}
            </Button>
          </form>
        </Show>

        <Show when={error()}>
          <p class="mt-3 text-xs text-error">{error()}</p>
        </Show>

        <button
          type="button"
          class="mt-6 text-xs text-text-secondary hover:text-text"
          onClick={() => void authManager.logout()}
          data-testid="second-factor-sign-out"
        >
          {i18n.t("kernel.secondFactorRequired.signOut")}
        </button>
      </div>
    </div>
  )
}

export default SecondFactorEnrollment
