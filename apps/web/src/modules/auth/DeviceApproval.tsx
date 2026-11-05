// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE PAGE THE VERIFICATION URI POINTS AT.
//
// The API mints a device grant with
// `verificationUri = ${BASE_URL}/auth/device?code=<userCode>`, and until this
// route existed that link landed on Home: the desktop app showed a code nobody
// could redeem, and the only way to start a local session was to call the
// approve endpoint by hand with a bearer token.
//
// The code is an AID, not the mechanism: the field is editable, so a user who
// followed a truncated link, or who read the code off the other screen, can
// type it. The server is what validates it, and a wrong one comes back 404.
//
// Signing in is ProtectedRoute's job, and its bounce already carries
// `returnTo=<path+search>`, so a signed-out visit lands back here WITH the code
// still in the query once the login completes.

import { useSearchParams } from "@solidjs/router"
import { type Component, createEffect, createSignal, For, on, onCleanup, Show } from "solid-js"
import { ApiError, createApiClient } from "~/lib/api-client"
import { authApiPath } from "~/lib/env"
import { accessToken } from "~/modules/auth/auth-store"
import { authManager } from "~/modules/auth/createAuthManager"
import { ProtectedRoute } from "~/modules/auth/ProtectedRoute"
import { useI18n } from "~/modules/i18n/i18n-context"
import { Button } from "~/ui/Button"
import { Input } from "~/ui/Input"

/** The user code shape the server mints: 8 characters, uppercase, no punctuation. */
export const USER_CODE_LENGTH = 8

/**
 * The alphabet the server mints user codes from (device-flow-routes.ts). It
 * drops every ambiguous glyph: 0 and O, 1 and I and L are not in it, so a code
 * carrying one of them can only be a misread.
 */
const USER_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"

/** Keep only what a user code can contain, so a pasted link fragment still works. */
export function normalizeUserCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, USER_CODE_LENGTH)
}

/**
 * Can this code have been minted at all?
 *
 * A code a typo put a 0 or an O in is refused HERE, with no request. Approve
 * and deny are both brute-force limited per user code and IP, so sending a
 * code the server could never have issued spends a strike the real code will
 * want, and a user retyping a misread one is exactly who runs out of them.
 */
export function isMintableUserCode(code: string): boolean {
  return code.length === USER_CODE_LENGTH && [...code].every((c) => USER_CODE_ALPHABET.includes(c))
}

type Outcome = "pending" | "approved" | "denied"

const api = createApiClient({
  getAccessToken: accessToken,
  ensureFreshToken: authManager.ensureFreshToken,
  pendingRefresh: authManager.pendingRefresh,
  // A 401 here is the grant's problem, not the session's: this card says so
  // inline rather than throwing the user back out to /login.
  onUnauthorized: () => {},
})

/** What GET /device-flow/pending/:code says about the request (all of it is client-declared except requestIp). */
interface PendingRequest {
  clientId: string
  kind: "mcp" | "session"
  deviceLabel: string | null
  scopes: string[]
  /** MCP grant bound to an agent of the approver's org (verified server side). */
  agent: { id: string; name: string } | null
  /** The grant names an agent this org does not have: it cannot be approved. */
  agentInvalid: boolean
  fullAccess: boolean
  requestIp: string | null
  expiresAt: string
}

interface StepUpSendResponse {
  sent?: boolean
  /** Seconds before a new code can be sent (the code already sent stands meanwhile). */
  retryAfterSeconds?: number
}

interface ApproveResponse {
  approved?: boolean
  clientId?: string
}

export const DeviceApprovalCard: Component = () => {
  const i18n = useI18n()
  const [searchParams] = useSearchParams()
  const [code, setCode] = createSignal(
    normalizeUserCode((searchParams.code as string | undefined) ?? ""),
  )
  const [outcome, setOutcome] = createSignal<Outcome>("pending")
  const [clientId, setClientId] = createSignal<string | null>(null)
  const [error, setError] = createSignal("")
  const [loading, setLoading] = createSignal(false)
  // What the code is asking for. Approve stays unavailable until this is on
  // screen: the approver must see who is asking and for what.
  const [pending, setPending] = createSignal<PendingRequest | null>(null)
  const [lookingUp, setLookingUp] = createSignal(false)
  const [confirmedFullAccess, setConfirmedFullAccess] = createSignal(false)
  // A fresh step-up (an emailed code, never a password) for an approval the
  // server says needs one: an MCP grant bound to no agent, asked up front, or
  // any request the server refuses with STEP_UP_REQUIRED. The card emails the
  // code by itself the first time the step-up shows on this page; the server's
  // cooldown keeps a reload from sending a second one.
  const [stepUpAsked, setStepUpAsked] = createSignal(false)
  const [stepUpCode, setStepUpCode] = createSignal("")
  const [stepUpSent, setStepUpSent] = createSignal(false)
  const [sendingCode, setSendingCode] = createSignal(false)
  const [resendIn, setResendIn] = createSignal(0)
  let autoSent = false
  let codeInput: HTMLInputElement | undefined
  let resendTimer: ReturnType<typeof setInterval> | undefined
  function startResendCooldown(seconds: number) {
    if (resendTimer) clearInterval(resendTimer)
    resendTimer = undefined
    setResendIn(Math.max(0, Math.floor(seconds)))
    if (resendIn() <= 0) return
    resendTimer = setInterval(() => {
      const left = resendIn() - 1
      setResendIn(Math.max(0, left))
      if (left <= 0 && resendTimer) {
        clearInterval(resendTimer)
        resendTimer = undefined
      }
    }, 1000)
  }
  onCleanup(() => {
    if (resendTimer) clearInterval(resendTimer)
  })
  const needsStepUp = () => {
    const req = pending()
    return stepUpAsked() || (req !== null && req.kind === "mcp" && req.fullAccess)
  }
  const stepUpReady = () => /^\d{6}$/.test(stepUpCode().trim())

  /**
   * A 401 is the SESSION, not the code (FX: it read as "not valid or has
   * expired", which sent the user back to re-read a code that was fine). The
   * grant lives 15 minutes and the access token can lapse inside that window,
   * so this is a real path, and the way out of it is signing in again, which
   * is why the message comes with the link back through returnTo.
   */
  const [sessionEnded, setSessionEnded] = createSignal(false)

  function reportError(err: unknown) {
    if (err instanceof ApiError && err.status === 401) {
      setSessionEnded(true)
      setError(i18n.t("kernel.deviceApproval.sessionEnded"))
    } else if (err instanceof ApiError && err.code === "STEP_UP_REQUIRED") {
      // The step-up block below appears and says what is needed.
      setStepUpAsked(true)
    } else if (err instanceof ApiError && err.status === 422 && needsStepUp()) {
      setStepUpCode("")
      setError(i18n.t("kernel.deviceApproval.stepUpInvalid"))
    } else if (err instanceof ApiError && err.status === 429) {
      setError(i18n.t("kernel.deviceApproval.tooManyAttempts"))
    } else {
      setError(i18n.t("kernel.deviceApproval.invalidCode"))
    }
  }

  createEffect(
    on(code, (value) => {
      setPending(null)
      setConfirmedFullAccess(false)
      setStepUpAsked(false)
      setStepUpCode("")
      if (!isMintableUserCode(value)) {
        // A full-length code the server could never have minted is a misread:
        // say so here, without a lookup that would spend a brute-force strike.
        setError(
          value.length === USER_CODE_LENGTH ? i18n.t("kernel.deviceApproval.invalidCode") : "",
        )
        return
      }
      setError("")
      setSessionEnded(false)
      setLookingUp(true)
      api
        .get<PendingRequest>(authApiPath(`/device-flow/pending/${encodeURIComponent(value)}`), {
          suppressGlobalError: true,
        })
        .then((result) => {
          if (code() === value) setPending(result)
        })
        .catch((err) => {
          if (code() === value) reportError(err)
        })
        .finally(() => {
          if (code() === value) setLookingUp(false)
        })
    }),
  )

  const canApprove = () => {
    const req = pending()
    return (
      req !== null &&
      !req.agentInvalid &&
      (!req.fullAccess || confirmedFullAccess()) &&
      (!needsStepUp() || stepUpReady())
    )
  }

  // The step-up just showed: email the code once for this page view.
  createEffect(() => {
    if (autoSent || !pending() || !needsStepUp()) return
    autoSent = true
    void sendStepUpCode()
  })

  async function sendStepUpCode() {
    if (sendingCode() || resendIn() > 0) return
    setSendingCode(true)
    setError("")
    try {
      const result = await api.post<StepUpSendResponse>(
        authApiPath("/totp/step-up"),
        { purpose: "mcp_connect" },
        { suppressGlobalError: true },
      )
      setStepUpSent(true)
      startResendCooldown(result?.retryAfterSeconds ?? 0)
      codeInput?.focus()
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 429)) reportError(err)
      else setError(i18n.t("kernel.deviceApproval.stepUpSendFailed"))
    } finally {
      setSendingCode(false)
    }
  }

  /** The approve body: the full-access confirmation and the step-up code, when asked. */
  function approveBody(): Record<string, unknown> {
    const body: Record<string, unknown> = {}
    if (pending()?.fullAccess) body.confirmFullAccess = true
    if (needsStepUp()) body.stepUpCode = stepUpCode().trim()
    return body
  }

  /** Back to login, carrying this exact page (code included) as returnTo. */
  const loginHref = () =>
    `/login?returnTo=${encodeURIComponent(`/auth/device${code() ? `?code=${code()}` : ""}`)}`

  async function decide(action: "approve" | "deny") {
    if (loading()) return
    if (action === "approve" && !canApprove()) return
    const value = code()
    setError("")
    setSessionEnded(false)
    if (value.length !== USER_CODE_LENGTH) {
      setError(i18n.t("kernel.deviceApproval.enterCode"))
      return
    }
    if (!isMintableUserCode(value)) {
      setError(i18n.t("kernel.deviceApproval.invalidCode"))
      return
    }
    setLoading(true)
    try {
      const result = await api.post<ApproveResponse>(
        authApiPath(`/device-flow/${action}/${encodeURIComponent(value)}`),
        action === "approve" ? approveBody() : {},
        { suppressGlobalError: true },
      )
      if (action === "approve") {
        setClientId(typeof result?.clientId === "string" ? result.clientId : null)
        setOutcome("approved")
      } else {
        setOutcome("denied")
      }
    } catch (err) {
      reportError(err)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      data-testid="device-approval-page"
      class="flex min-h-screen items-center justify-center bg-overlay-heavy backdrop-blur-[20px] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]"
    >
      <div
        data-testid="device-approval-card"
        class="w-full max-w-[380px] rounded-lg border border-border bg-elevated px-8 pt-9 pb-7"
      >
        <div class="mb-7 text-center">
          <h1 class="font-display text-[24px] font-semibold tracking-[-0.02em] text-text">
            {i18n.t("kernel.deviceApproval.title")}
          </h1>
          <p class="mt-1 text-[13px] text-text-secondary">
            {i18n.t("kernel.deviceApproval.subtitle")}
          </p>
        </div>

        <Show when={outcome() === "pending"}>
          <div class="flex flex-col gap-4">
            <Input
              label={i18n.t("kernel.deviceApproval.codeLabel")}
              placeholder="ABCD2345"
              value={code()}
              data-testid="device-approval-code-input"
              autofocus
              maxLength={USER_CODE_LENGTH}
              class="font-mono tracking-[0.18em] uppercase"
              onInput={(e) => setCode(normalizeUserCode(e.currentTarget.value))}
            />
            <Show when={lookingUp()}>
              <p class="text-[12.5px] text-text-tertiary">
                {i18n.t("kernel.deviceApproval.lookingUp")}
              </p>
            </Show>
            <Show when={pending()}>
              {(req) => (
                <div
                  data-testid="device-approval-details"
                  class="flex flex-col gap-2 rounded-md border border-border p-3 text-[12.5px]"
                >
                  <p class="font-semibold text-text">
                    {i18n.t("kernel.deviceApproval.reviewTitle")}
                  </p>
                  <p class="text-text-secondary">
                    {i18n.t("kernel.deviceApproval.requestedBy")}{" "}
                    <span data-testid="device-approval-client" class="font-mono text-text">
                      {req().clientId}
                    </span>
                  </p>
                  <p data-testid="device-approval-unverified" class="text-text-tertiary">
                    {i18n.t("kernel.deviceApproval.unverified")}
                  </p>
                  <p class="text-text-secondary">
                    {i18n.t("kernel.deviceApproval.deviceLabel")}:{" "}
                    <span data-testid="device-approval-device" class="text-text">
                      {req().deviceLabel ?? i18n.t("kernel.deviceApproval.unknownDevice")}
                    </span>
                  </p>
                  <p class="text-text-secondary">
                    {i18n.t("kernel.deviceApproval.sourceIp")}:{" "}
                    <span data-testid="device-approval-ip" class="font-mono text-text">
                      {req().requestIp ?? i18n.t("kernel.deviceApproval.unknownDevice")}
                    </span>
                  </p>
                  <Show
                    when={!req().fullAccess}
                    fallback={
                      <div class="flex flex-col gap-2">
                        <p data-testid="device-approval-full-access" class="text-error">
                          {i18n.t("kernel.deviceApproval.fullAccessWarning")}
                        </p>
                        <label class="flex items-start gap-2 text-text">
                          <input
                            type="checkbox"
                            data-testid="device-approval-confirm-full"
                            checked={confirmedFullAccess()}
                            onChange={(e) => setConfirmedFullAccess(e.currentTarget.checked)}
                          />
                          <span>{i18n.t("kernel.deviceApproval.fullAccessConfirm")}</span>
                        </label>
                      </div>
                    }
                  >
                    <Show
                      when={req().agent}
                      fallback={
                        <>
                          <p class="text-text-secondary">
                            {i18n.t("kernel.deviceApproval.scopesTitle")}
                          </p>
                          <ul data-testid="device-approval-scopes" class="list-disc pl-5 font-mono">
                            <For each={req().scopes}>{(scope) => <li>{scope}</li>}</For>
                          </ul>
                        </>
                      }
                    >
                      {(agent) => (
                        <p data-testid="device-approval-agent" class="text-text-secondary">
                          {i18n.t("kernel.deviceApproval.boundAgent", { agent: agent().name })}
                        </p>
                      )}
                    </Show>
                  </Show>
                  <Show when={req().agentInvalid}>
                    <p data-testid="device-approval-agent-invalid" class="text-error">
                      {i18n.t("kernel.deviceApproval.agentInvalid")}
                    </p>
                  </Show>
                </div>
              )}
            </Show>
            <Show when={pending() && needsStepUp()}>
              <div data-testid="device-approval-step-up" class="flex flex-col gap-2 text-[12.5px]">
                <p class="text-text-secondary">{i18n.t("kernel.deviceApproval.stepUpPrompt")}</p>
                <Show when={stepUpSent()}>
                  <p data-testid="device-approval-code-sent" class="text-text-primary">
                    {i18n.t("kernel.deviceApproval.stepUpCodeSent")}
                  </p>
                </Show>
                <Input
                  ref={(el) => {
                    codeInput = el
                  }}
                  type="text"
                  name="code"
                  label={i18n.t("kernel.deviceApproval.stepUpCodeLabel")}
                  value={stepUpCode()}
                  data-testid="device-approval-step-up-code"
                  inputmode="numeric"
                  autocomplete="one-time-code"
                  maxLength={6}
                  onInput={(e) => setStepUpCode(e.currentTarget.value)}
                />
                <p class="text-text-tertiary">
                  {i18n.t("kernel.deviceApproval.stepUpNoCode")}{" "}
                  <button
                    type="button"
                    data-testid="device-approval-resend"
                    class="text-accent-muted underline transition-colors duration-150 hover:text-accent disabled:cursor-default disabled:text-text-tertiary disabled:no-underline"
                    disabled={sendingCode() || resendIn() > 0 || loading()}
                    onClick={() => void sendStepUpCode()}
                  >
                    {i18n.t("kernel.deviceApproval.stepUpResend")}
                  </button>
                  .
                </p>
                <Show when={resendIn() > 0}>
                  <p data-testid="device-approval-resend-wait" class="text-text-tertiary">
                    {i18n.t("kernel.deviceApproval.stepUpResendIn", { count: resendIn() })}
                  </p>
                </Show>
              </div>
            </Show>
            <p class="text-[12.5px] text-text-secondary">
              {i18n.t("kernel.deviceApproval.grants")}
            </p>
            <p class="text-[12.5px] text-text-tertiary">
              {i18n.t("kernel.deviceApproval.grantsDetail")}
            </p>
            <Show when={error()}>
              <p data-testid="device-approval-error" role="alert" class="text-xs text-error">
                {error()}
              </p>
            </Show>
            <Show when={sessionEnded()}>
              <a
                href={loginHref()}
                data-testid="device-approval-signin-again"
                class="text-[12.5px] text-accent-muted transition-colors duration-150 hover:text-accent"
              >
                {i18n.t("kernel.deviceApproval.signInAgain")}
              </a>
            </Show>
            <Button
              fullWidth
              type="button"
              loading={loading()}
              disabled={!canApprove()}
              data-testid="device-approval-approve"
              onClick={() => void decide("approve")}
            >
              {i18n.t("kernel.deviceApproval.approveAction")}
            </Button>
            <Button
              fullWidth
              type="button"
              variant="outline"
              disabled={loading()}
              data-testid="device-approval-deny"
              onClick={() => void decide("deny")}
            >
              {i18n.t("kernel.deviceApproval.denyAction")}
            </Button>
          </div>
        </Show>

        <Show when={outcome() === "approved"}>
          <div data-testid="device-approval-approved" class="flex flex-col gap-2 text-center">
            <p class="text-[13.5px] font-semibold text-text">
              {i18n.t("kernel.deviceApproval.approved")}
            </p>
            <Show when={clientId()}>
              {(id) => (
                <p class="text-[12.5px] text-text-secondary">
                  {i18n.t("kernel.deviceApproval.approvedClient", { clientId: id() })}
                </p>
              )}
            </Show>
          </div>
        </Show>

        <Show when={outcome() === "denied"}>
          <div data-testid="device-approval-denied" class="flex flex-col gap-2 text-center">
            <p class="text-[13.5px] font-semibold text-text">
              {i18n.t("kernel.deviceApproval.denied")}
            </p>
          </div>
        </Show>
      </div>
    </div>
  )
}

const DeviceApproval: Component = () => (
  <ProtectedRoute>
    <DeviceApprovalCard />
  </ProtectedRoute>
)

export default DeviceApproval
