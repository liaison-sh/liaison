// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE PAGE A ONE-TIME CONNECT LINK OPENS (`/connect/link?token=...`).
//
// An admin, or the operator's `liaison connect <app>/<connection> --for
// <email>`, sends a member this link to connect their OWN account. The page
// never signs anyone in: ProtectedRoute sends a signed-out visitor through the
// normal sign-in (returnTo keeps the token), and the server answers only for
// the member the link was minted for. Anyone else is told to sign in as that
// member and open the link again.
//
// Continue redeems the link (once) and goes on exactly like the Connect button:
// the server starts the personal, browser-bound flow and this tab goes to the
// provider. For a mailbox, the person first picks standard or private (their
// own preference, the same route as Settings > Mail); a private mailbox asks
// for its mailbox password in Settings > Mail, where the flow lands.
//
// A connect started here that the server refuses (the account is already the
// organization's, a domain not allowed, the provider said no...) comes BACK
// here with `oauth_error` (+ the sentence in `oauth_error_description`): the
// page says plainly that nothing was connected, why, and what to do.

import { connectFailureReason } from "@liaison/shared"
import { useSearchParams } from "@solidjs/router"
import { type Component, createSignal, onMount, Show } from "solid-js"
import { ApiError, createApiClient } from "~/lib/api-client"
import { accessToken } from "~/modules/auth/auth-store"
import { authManager } from "~/modules/auth/createAuthManager"
import { ProtectedRoute } from "~/modules/auth/ProtectedRoute"
import { useI18n } from "~/modules/i18n/i18n-context"
import {
  loadMailboxEncryptionSettings,
  type MailboxEncryptionMode,
  mailboxEncryptionSettings,
  setMailboxEncryptionPreference,
} from "~/modules/mail/mail-encryption-store"
import { Button } from "~/ui/Button"

const api = createApiClient({
  getAccessToken: accessToken,
  ensureFreshToken: authManager.ensureFreshToken,
  pendingRefresh: authManager.pendingRefresh,
  onUnauthorized: () => {},
})

type View =
  | { status: "ok"; appName: string; connectionName: string; email: string; expiresAt: string }
  | { status: "wrong_user"; email: string }
  | { status: "invalid" }
  | { status: "refused"; message: string }

export const ConnectLinkCard: Component = () => {
  const i18n = useI18n()
  const [params] = useSearchParams()
  const token = () => (params.token as string | undefined) ?? ""
  const [view, setView] = createSignal<View | null>(null)
  const [mode, setMode] = createSignal<MailboxEncryptionMode | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")

  const isMail = () => {
    const v = view()
    return v?.status === "ok" && v.appName === "mail"
  }
  const canChoose = () => {
    const s = mailboxEncryptionSettings()
    return isMail() && !!s && s.allowPrivate && s.allowManaged
  }

  onMount(async () => {
    const refused = params.oauth_error as string | undefined
    if (refused) {
      const description = (params.oauth_error_description as string | undefined)?.trim()
      setView({
        status: "refused",
        message:
          description || i18n.t(`secret-request.connectFailure.${connectFailureReason(refused)}`),
      })
      return
    }
    try {
      const v = await api.post<View>("/connections/links/peek", { token: token() })
      setView(v)
      if (v.status === "ok" && v.appName === "mail") {
        await loadMailboxEncryptionSettings(api)
        setMode(mailboxEncryptionSettings()?.effective ?? null)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  })

  async function onContinue() {
    setBusy(true)
    setError("")
    try {
      const chosen = mode()
      if (canChoose() && chosen && chosen !== mailboxEncryptionSettings()?.effective) {
        await setMailboxEncryptionPreference(api, chosen)
      }
      const out = await api.post<{ redirectUrl: string }>("/connections/links/redeem", {
        token: token(),
      })
      window.location.assign(out.redirectUrl)
    } catch (err) {
      setBusy(false)
      if (err instanceof ApiError && err.status === 410) setView({ status: "invalid" })
      else setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div
      data-testid="connect-link-page"
      class="flex min-h-screen items-center justify-center bg-overlay-heavy backdrop-blur-[20px]"
    >
      <div class="w-full max-w-[420px] rounded-lg border border-border bg-elevated px-8 pt-9 pb-7">
        <h1 class="mb-4 text-center font-display text-[24px] font-semibold tracking-[-0.02em] text-text">
          {i18n.t("kernel.connectLink.title")}
        </h1>

        <Show
          when={(() => {
            const v = view()
            return v?.status === "refused" ? v : null
          })()}
        >
          {(v) => (
            <div data-testid="connect-link-refused" class="flex flex-col gap-2" role="alert">
              <p class="text-[13.5px] font-semibold text-danger">
                {i18n.t("kernel.connectLink.refused")}
              </p>
              <p data-testid="connect-link-refused-reason" class="text-[13.5px] text-text">
                {v().message}
              </p>
            </div>
          )}
        </Show>

        <Show when={view()?.status === "invalid"}>
          <p data-testid="connect-link-invalid" class="text-[13.5px] text-text-secondary">
            {i18n.t("kernel.connectLink.invalid")}
          </p>
        </Show>

        <Show
          when={(() => {
            const v = view()
            return v?.status === "wrong_user" ? v : null
          })()}
        >
          {(v) => (
            <p data-testid="connect-link-wrong-user" class="text-[13.5px] text-text">
              {i18n.t("kernel.connectLink.wrongUser", { email: v().email })}
            </p>
          )}
        </Show>

        <Show
          when={(() => {
            const v = view()
            return v?.status === "ok" ? v : null
          })()}
        >
          {(v) => (
            <div class="flex flex-col gap-4">
              <p data-testid="connect-link-what" class="text-[13.5px] text-text">
                {i18n.t("kernel.connectLink.what", {
                  connection: `${v().appName}/${v().connectionName}`,
                  email: v().email,
                })}
              </p>
              <Show when={canChoose()}>
                <fieldset data-testid="connect-link-mailbox-mode" class="flex flex-col gap-2">
                  <legend class="mb-1 text-[13px] font-semibold text-text">
                    {i18n.t("kernel.connectLink.mailboxQuestion")}
                  </legend>
                  <label class="flex items-start gap-2 text-[13px] text-text">
                    <input
                      type="radio"
                      name="mailbox-mode"
                      data-testid="connect-link-mode-managed"
                      checked={mode() === "managed"}
                      onChange={() => setMode("managed")}
                    />
                    <span>
                      <strong>{i18n.t("mail.encryption.transparent")}</strong>.{" "}
                      {i18n.t("mail.encryption.transparentHelp")}
                    </span>
                  </label>
                  <label class="flex items-start gap-2 text-[13px] text-text">
                    <input
                      type="radio"
                      name="mailbox-mode"
                      data-testid="connect-link-mode-private"
                      checked={mode() === "private"}
                      onChange={() => setMode("private")}
                    />
                    <span>
                      <strong>{i18n.t("mail.encryption.private")}</strong>.{" "}
                      {i18n.t("mail.encryption.privateHelp")}
                    </span>
                  </label>
                </fieldset>
              </Show>
              <Button data-testid="connect-link-continue" disabled={busy()} onClick={onContinue}>
                {i18n.t("kernel.connectLink.continue")}
              </Button>
            </div>
          )}
        </Show>

        <Show when={error()}>
          <p data-testid="connect-link-error" class="mt-3 text-[13px] text-danger">
            {error()}
          </p>
        </Show>
      </div>
    </div>
  )
}

const ConnectLink: Component = () => (
  <ProtectedRoute>
    <ConnectLinkCard />
  </ProtectedRoute>
)

export default ConnectLink
