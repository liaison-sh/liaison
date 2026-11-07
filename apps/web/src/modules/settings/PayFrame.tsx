// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The payment frame of the managed Billing page (spec S17): card entry and
// payment confirmation run on a separate page, embedded here as an iframe, so
// no payment code lives in this app. The server mints a session for one action
// (`/billing/managed/frame-session`: 5 minutes, this org, single use) and
// answers the frame URL on its configured frame origin.
//
// The frame reports its result with `postMessage`, and its content height
// (`liaison-pay-frame-height`, whole CSS pixels) once ready and on every size
// change, so the iframe fits its form without an inner scroll. A message is
// accepted only when it comes from that exact origin, from this iframe's
// window, and names this session's token; anything else is ignored. A height
// is clamped to PAY_FRAME_MIN_HEIGHT..PAY_FRAME_MAX_HEIGHT.
import { type Component, createSignal, onCleanup, onMount, Show } from "solid-js"
import type { ApiClient } from "~/lib/api-client"
import { useI18n } from "~/modules/i18n/i18n-context"
import { Button } from "~/ui/Button"

export type PayFrameAction = "card" | "topup" | "confirm_invoice"

export interface PayFrameSession {
  token: string
  expiresAt: string
  frameOrigin: string
  frameUrl: string
}

/** What the frame posts to its parent. */
export interface PayFrameResult {
  type: "liaison-pay-frame"
  token: string
  ok: boolean
  action: PayFrameAction
  code?: string
}

/** True for a message this session may act on (origin, source window and token all match). */
export function isPayFrameMessage(
  event: Pick<MessageEvent, "origin" | "source" | "data">,
  session: Pick<PayFrameSession, "frameOrigin" | "token">,
  frameWindow: MessageEventSource | null | undefined,
): event is MessageEvent<PayFrameResult> {
  if (event.origin !== session.frameOrigin) return false
  if (!frameWindow || event.source !== frameWindow) return false
  const data = event.data as Partial<PayFrameResult> | null
  return (
    !!data &&
    typeof data === "object" &&
    data.type === "liaison-pay-frame" &&
    data.token === session.token &&
    typeof data.ok === "boolean"
  )
}

/** The frame's content height, posted to its parent. */
export interface PayFrameHeight {
  type: "liaison-pay-frame-height"
  token: string
  height: number
}

/** The iframe's height before the frame reports one, and the bounds a reported one is held to. */
export const PAY_FRAME_DEFAULT_HEIGHT = 420
export const PAY_FRAME_MIN_HEIGHT = 200
export const PAY_FRAME_MAX_HEIGHT = 1600

/** The height to give the iframe for a height message of this session, or null for any other message. */
export function payFrameHeightFrom(
  event: Pick<MessageEvent, "origin" | "source" | "data">,
  session: Pick<PayFrameSession, "frameOrigin" | "token">,
  frameWindow: MessageEventSource | null | undefined,
): number | null {
  if (event.origin !== session.frameOrigin) return null
  if (!frameWindow || event.source !== frameWindow) return null
  const data = event.data as Partial<PayFrameHeight> | null
  if (!data || typeof data !== "object" || data.type !== "liaison-pay-frame-height") return null
  if (data.token !== session.token) return null
  if (typeof data.height !== "number" || !Number.isFinite(data.height)) return null
  return Math.min(PAY_FRAME_MAX_HEIGHT, Math.max(PAY_FRAME_MIN_HEIGHT, Math.ceil(data.height)))
}

export const PayFrame: Component<{
  api: ApiClient
  action: PayFrameAction
  credits?: number
  invoiceId?: string
  onDone: (result: PayFrameResult) => void
  onClose: () => void
}> = (props) => {
  const { t } = useI18n()
  const [session, setSession] = createSignal<PayFrameSession | null>(null)
  const [failed, setFailed] = createSignal(false)
  const [height, setHeight] = createSignal(PAY_FRAME_DEFAULT_HEIGHT)
  let iframe: HTMLIFrameElement | undefined

  const onMessage = (event: MessageEvent) => {
    const s = session()
    if (!s) return
    const reported = payFrameHeightFrom(event, s, iframe?.contentWindow)
    if (reported !== null) {
      setHeight(reported)
      return
    }
    if (!isPayFrameMessage(event, s, iframe?.contentWindow)) return
    props.onDone(event.data)
  }

  onMount(async () => {
    window.addEventListener("message", onMessage)
    try {
      const s = await props.api.post<PayFrameSession>("/billing/managed/frame-session", {
        action: props.action,
        ...(props.credits !== undefined ? { credits: props.credits } : {}),
        ...(props.invoiceId !== undefined ? { invoiceId: props.invoiceId } : {}),
      })
      setSession(s)
    } catch {
      setFailed(true)
    }
  })
  onCleanup(() => window.removeEventListener("message", onMessage))

  return (
    <div data-testid="pay-frame" class="rounded-md border border-border p-4">
      <div class="mb-3 flex items-center justify-between gap-3">
        <h3 class="text-sm font-semibold text-text">{t("cloud-billing.frame.title")}</h3>
        <Button
          variant="ghost"
          size="sm"
          data-testid="pay-frame-close"
          onClick={() => props.onClose()}
        >
          {t("cloud-billing.frame.close")}
        </Button>
      </div>
      <Show
        when={!failed()}
        fallback={<p class="text-sm text-error">{t("cloud-billing.frame.failed")}</p>}
      >
        <Show
          when={session()}
          fallback={<p class="text-sm text-text-secondary">{t("cloud-billing.frame.loading")}</p>}
        >
          {(s) => (
            <iframe
              ref={(el) => {
                iframe = el
              }}
              data-testid="pay-frame-iframe"
              title={t("cloud-billing.frame.title")}
              src={s().frameUrl}
              class="w-full rounded-sm border-0"
              style={{ height: `${height()}px` }}
              allow="payment"
            />
          )}
        </Show>
      </Show>
    </div>
  )
}
