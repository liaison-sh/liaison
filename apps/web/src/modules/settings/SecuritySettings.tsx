// SPDX-License-Identifier: FSL-1.1-ALv2

import QRCode from "qrcode"
import { type Component, createEffect, createResource, createSignal, For, Show } from "solid-js"
import { authApiPath } from "~/lib/env"
import { canAccessScope, setTokens } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import DeleteAccountSection from "~/modules/settings/DeleteAccountSection"
import SignInMethodsSection, {
  SIGN_IN_METHODS_SCOPE,
} from "~/modules/settings/SignInMethodsSection"
import { useApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"
import { Input } from "~/ui/Input"

const SecuritySettings: Component = () => {
  const i18n = useI18n()
  const api = useApi()

  const [totpStatus, { mutate: mutateTotpStatus }] = createResource(async () => {
    const res = await api.get<{ totpEnabled: boolean }>(authApiPath("/totp/status"))
    return res
  })

  const [totpDialogOpen, setTotpDialogOpen] = createSignal(false)
  const [totpStep, setTotpStep] = createSignal<"verify" | "setup" | "confirm" | "done">("verify")
  const [otpauthUri, setOtpauthUri] = createSignal("")
  const [recoveryCodes, setRecoveryCodes] = createSignal<string[]>([])
  const [confirmCode, setConfirmCode] = createSignal("")
  const [stepUpCode, setStepUpCode] = createSignal("")
  const [codeSent, setCodeSent] = createSignal(false)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal("")

  function openTotpSetup() {
    setStepUpCode("")
    setCodeSent(false)
    setError("")
    setTotpStep("verify")
    setTotpDialogOpen(true)
  }

  // Email a fresh step-up code to re-confirm identity before enabling 2FA.
  // Works for every account (passwordless or password) — no current-password prompt.
  async function sendStepUpCode() {
    setError("")
    setLoading(true)
    try {
      await api.post(authApiPath("/totp/step-up"), {})
      setCodeSent(true)
    } catch {
      setError("Couldn't send a code. Try again.")
    } finally {
      setLoading(false)
    }
  }

  async function submitStepUp(e: Event) {
    e.preventDefault()
    setError("")
    setLoading(true)
    try {
      const result = await api.post<{
        otpauthUri: string
        recoveryCodes: string[]
      }>(authApiPath("/totp/setup"), { stepUpCode: stepUpCode() })
      setOtpauthUri(result.otpauthUri)
      setRecoveryCodes(result.recoveryCodes)
      setTotpStep("setup")
    } catch {
      setError("Invalid or expired code")
    } finally {
      setLoading(false)
    }
  }

  let qrCanvasRef!: HTMLCanvasElement
  createEffect(() => {
    const uri = otpauthUri()
    if (uri && totpDialogOpen() && totpStep() === "setup") {
      requestAnimationFrame(() => {
        if (qrCanvasRef?.isConnected) {
          QRCode.toCanvas(qrCanvasRef, uri, { width: 200, margin: 2 })
        }
      })
    }
  })

  async function confirmTotp(e: Event) {
    e.preventDefault()
    setError("")
    setLoading(true)
    try {
      await api.post(authApiPath("/totp/confirm"), { code: confirmCode() })
      setTotpStep("done")
      mutateTotpStatus({ totpEnabled: true })
      addToast({
        message: i18n.t("kernel.settingsUi.twoFactorAuthenticationEnabled"),
        type: "success",
      })
    } catch {
      setError("Invalid code")
    } finally {
      setLoading(false)
    }
  }

  const [currentPassword, setCurrentPassword] = createSignal("")
  const [newPassword, setNewPassword] = createSignal("")
  const [confirmNewPassword, setConfirmNewPassword] = createSignal("")
  const [passwordError, setPasswordError] = createSignal("")
  const [passwordSaving, setPasswordSaving] = createSignal(false)

  async function handlePasswordChange(e: Event) {
    e.preventDefault()
    setPasswordError("")
    if (newPassword().length < 8) {
      setPasswordError(i18n.t("kernel.settingsUi.passwordMustBeAtLeast8"))
      return
    }
    if (newPassword() !== confirmNewPassword()) {
      setPasswordError(i18n.t("kernel.settingsUi.passwordsDoNotMatch"))
      return
    }
    setPasswordSaving(true)
    try {
      const result = await api.post<{ accessToken: string }>(authApiPath("/password/change"), {
        currentPassword: currentPassword(),
        newPassword: newPassword(),
      })
      // Update in-memory access token since all old sessions were invalidated
      if (result?.accessToken) {
        setTokens(result.accessToken)
      }
      addToast({ message: i18n.t("kernel.settingsUi.passwordUpdated"), type: "success" })
      setCurrentPassword("")
      setNewPassword("")
      setConfirmNewPassword("")
    } catch {
      setPasswordError(i18n.t("kernel.settingsUi.failedToUpdatePassword"))
    } finally {
      setPasswordSaving(false)
    }
  }

  return (
    <div>
      <h1 class="mb-6 text-lg font-semibold text-text">{i18n.t("kernel.security")}</h1>

      <div class="mb-6 rounded-lg border border-border p-4">
        <h2 class="text-sm font-medium text-text">{i18n.t("kernel.changePassword")}</h2>
        <form onSubmit={handlePasswordChange} class="mt-3 flex flex-col gap-3">
          <Input
            type="password"
            label={i18n.t("kernel.settingsUi.currentPassword")}
            value={currentPassword()}
            onInput={(e) => setCurrentPassword((e.currentTarget as HTMLInputElement).value)}
            autocomplete="current-password"
          />
          <Input
            type="password"
            label={i18n.t("kernel.settingsUi.newPassword")}
            value={newPassword()}
            onInput={(e) => setNewPassword((e.currentTarget as HTMLInputElement).value)}
            autocomplete="new-password"
          />
          <Input
            type="password"
            label={i18n.t("kernel.settingsUi.confirmNewPassword")}
            value={confirmNewPassword()}
            onInput={(e) => setConfirmNewPassword((e.currentTarget as HTMLInputElement).value)}
            autocomplete="new-password"
          />
          <Show when={passwordError()}>
            <p class="text-xs text-error">{passwordError()}</p>
          </Show>
          <div>
            <Button type="submit" variant="outline" size="sm" loading={passwordSaving()}>
              {i18n.t("kernel.settingsUi.updatePassword")}
            </Button>
          </div>
        </form>
      </div>

      <div class="rounded-lg border border-border p-4">
        <h2 class="text-sm font-medium text-text">{i18n.t("kernel.twoFactorAuthentication")}</h2>
        <p class="mt-1 text-xs text-text-secondary">
          {i18n.t("kernel.settingsUi.addAnExtraLayerOfSecurity")}
        </p>
        <div class="mt-3">
          <Show
            when={totpStatus()?.totpEnabled}
            fallback={
              <Button variant="outline" size="sm" onClick={openTotpSetup} loading={loading()}>
                {i18n.t("kernel.settingsUi.enable2fa")}
              </Button>
            }
          >
            <div class="flex items-center gap-2">
              <span class="inline-block h-2 w-2 rounded-full bg-success" />
              <span class="text-xs text-text-secondary">
                {i18n.t("kernel.twoFactorAuthenticationIsEnabled")}
              </span>
            </div>
          </Show>
        </div>
      </div>

      <DeleteAccountSection />

      {/* The organisation's sign-in methods, for org admins (S16). */}
      <Show when={canAccessScope(SIGN_IN_METHODS_SCOPE)}>
        <div class="mt-10 border-t border-border pt-6">
          <SignInMethodsSection />
        </div>
      </Show>

      <Dialog open={totpDialogOpen()} onOpenChange={setTotpDialogOpen}>
        <Dialog.Content>
          <Show when={totpStep() === "verify"}>
            <Dialog.Title>{i18n.t("kernel.setUpTwoFactorAuthentication")}</Dialog.Title>
            <Dialog.Description>{i18n.t("kernel.settingsUi.weLlEmailYouA6")}</Dialog.Description>
            <Show
              when={codeSent()}
              fallback={
                <div class="mt-4 flex flex-col gap-3">
                  <Show when={error()}>
                    <p class="text-xs text-error">{error()}</p>
                  </Show>
                  <Button fullWidth onClick={sendStepUpCode} loading={loading()}>
                    {i18n.t("kernel.settingsUi.emailMeACode")}
                  </Button>
                </div>
              }
            >
              <form onSubmit={submitStepUp} class="mt-4 flex flex-col gap-3">
                <Input
                  placeholder="000000"
                  maxLength={6}
                  value={stepUpCode()}
                  onInput={(e) => setStepUpCode((e.currentTarget as HTMLInputElement).value)}
                  autofocus
                  autocomplete="one-time-code"
                />
                <Show when={error()}>
                  <p class="text-xs text-error">{error()}</p>
                </Show>
                <Button fullWidth type="submit" loading={loading()}>
                  {i18n.t("kernel.common.continue")}
                </Button>
                <button
                  type="button"
                  class="text-xs text-accent-muted hover:text-accent"
                  onClick={sendStepUpCode}
                >
                  {i18n.t("kernel.settingsUi.resendCode")}
                </button>
              </form>
            </Show>
          </Show>

          <Show when={totpStep() === "setup"}>
            <Dialog.Title>{i18n.t("kernel.setUpTwoFactorAuthentication")}</Dialog.Title>
            <Dialog.Description>
              {i18n.t("kernel.settingsUi.scanThisQrCodeWithYour")}
            </Dialog.Description>
            <div class="my-4 flex justify-center rounded-md bg-white p-4">
              <canvas ref={qrCanvasRef} id="totp-qr" />
            </div>
            <div class="mb-4">
              <h3 class="mb-2 text-xs font-medium text-text-secondary">
                {i18n.t("kernel.recoveryCodes")}
              </h3>
              <p class="mb-1 text-xs text-text-tertiary">
                {i18n.t("kernel.settingsUi.saveTheseCodesSecurelyYouCan")}
              </p>
              <div
                data-testid="recovery-codes-grid"
                class="grid grid-cols-2 gap-1 rounded-md bg-bg p-3 font-mono text-xs text-text"
              >
                <For each={recoveryCodes()}>{(code) => <span>{code}</span>}</For>
              </div>
            </div>
            <Button size="sm" onClick={() => setTotpStep("confirm")}>
              {i18n.t("kernel.settingsUi.iVeSavedMyRecoveryCodes")}
            </Button>
          </Show>

          <Show when={totpStep() === "confirm"}>
            <Dialog.Title>{i18n.t("kernel.confirmSetup")}</Dialog.Title>
            <Dialog.Description>
              {i18n.t("kernel.settingsUi.enterThe6DigitCodeFrom")}
            </Dialog.Description>
            <form onSubmit={confirmTotp} class="mt-4 flex flex-col gap-3">
              <Input
                placeholder="000000"
                maxLength={6}
                value={confirmCode()}
                onInput={(e) => setConfirmCode((e.currentTarget as HTMLInputElement).value)}
                autofocus
                autocomplete="one-time-code"
              />
              <Show when={error()}>
                <p class="text-xs text-error">{error()}</p>
              </Show>
              <Button fullWidth type="submit" loading={loading()}>
                {i18n.t("kernel.settingsUi.verifyAndEnable")}
              </Button>
            </form>
          </Show>

          <Show when={totpStep() === "done"}>
            <Dialog.Title>{i18n.t("kernel.twoFactorAuthenticationEnabled")}</Dialog.Title>
            <Dialog.Description>
              {i18n.t("kernel.settingsUi.yourAccountIsNowProtectedWith")}
            </Dialog.Description>
            <div class="mt-4">
              <Button fullWidth onClick={() => setTotpDialogOpen(false)}>
                {i18n.t("kernel.done")}
              </Button>
            </div>
          </Show>
        </Dialog.Content>
      </Dialog>
    </div>
  )
}

export default SecuritySettings
