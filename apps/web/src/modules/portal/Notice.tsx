// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The org's notice, to read and acknowledge once per version. The page sends
// back the version it showed; when the org wrote a new text since, the server
// records nothing (409 NOTICE_CHANGED) and the page shows the new text to read
// again. The notice is the org's text, shown as text.

import { type Component, createSignal, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { type Branding, portalPost } from "./portal-api"

const primary =
  "rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-foreground disabled:opacity-60"

export const NoticeToRead: Component<{
  branding: Branding | null
  /** The version the person acknowledged, or null. */
  acknowledged: number | null
  /** The notice changed since it was shown: read the org's branding again. */
  onChanged: () => void
}> = (props) => {
  const i18n = useI18n()
  const [done, setDone] = createSignal<number | null>(null)
  const [changed, setChanged] = createSignal(false)
  const [failed, setFailed] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const version = () => props.branding?.noticeVersion ?? null
  const toRead = () => {
    const v = version()
    return Boolean(props.branding?.notice) && v !== null && v !== props.acknowledged && v !== done()
  }

  const ack = async () => {
    const v = version()
    if (v === null) return
    setBusy(true)
    setFailed(false)
    const out = await portalPost("/me/notice-ack", { version: v })
    setBusy(false)
    if (out.status === 200) {
      setChanged(false)
      setDone(v)
      return
    }
    const code = (out.body?.error as { code?: unknown } | undefined)?.code
    if (out.status === 409 && code === "NOTICE_CHANGED") {
      setChanged(true)
      props.onChanged()
      return
    }
    setFailed(true)
  }

  return (
    <Show when={toRead()}>
      <section
        data-testid="portal-notice-read"
        class="mb-4 flex flex-col gap-2 rounded-xl border border-border bg-surface px-4 py-4"
      >
        <Show when={changed()}>
          <p data-testid="portal-notice-changed" class="text-[13px] text-text-secondary">
            {i18n.t("portal.notice.changed")}
          </p>
        </Show>
        <p class="whitespace-pre-line text-[14px] text-text">{props.branding?.notice}</p>
        <div class="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="portal-notice-ack"
            class={primary}
            disabled={busy()}
            onClick={() => void ack()}
          >
            {i18n.t("portal.notice.ack")}
          </button>
          <Show when={failed()}>
            <span role="status" class="text-[13px] text-text-secondary">
              {i18n.t("portal.notice.failed")}
            </span>
          </Show>
        </div>
      </section>
    </Show>
  )
}
