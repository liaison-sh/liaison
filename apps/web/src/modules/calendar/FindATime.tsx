// SPDX-License-Identifier: FSL-1.1-ALv2
// "Find a time" in the event tab: free slots of the event's length over the next week when the
// person and every guest are free (the `find_free_slots` tool). Guests' busy times need Google's
// free/busy permission, asked for the first time it is needed (incremental consent): the strip
// then offers Allow, which reconnects the person's Google account with that one extra scope.
import { type Component, createSignal, For, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { connectWithOAuth } from "~/modules/settings/oauth-connect"
import { useApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"
import { type FreeSlotsResult, findFreeSlots } from "./calendar-api"

const DAY_MS = 86_400_000
const AUTHORIZE_PATH = "/connections/calendar/google-calendar/authorize"

/** `YYYY-MM-DDTHH:MM` in the browser's zone, the shape the event form's time inputs hold. */
export function toLocalInput(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** The search window: from the event's day (never before now) over the following week. */
export function searchWindow(startLocal: string, now: Date): { timeMin: string; timeMax: string } {
  const day = new Date(startLocal)
  const from = Number.isNaN(day.getTime()) ? now : day
  from.setHours(0, 0, 0, 0)
  const min = from.getTime() < now.getTime() ? now : from
  return {
    timeMin: min.toISOString(),
    timeMax: new Date(min.getTime() + 7 * DAY_MS).toISOString(),
  }
}

export const FindATime: Component<{
  attendees: string[]
  startLocal: string
  endLocal: string
  onPick: (slot: { startLocal: string; endLocal: string }) => void
}> = (props) => {
  const api = useApi()
  const i18n = useI18n()
  const [result, setResult] = createSignal<FreeSlotsResult | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  const duration = () => {
    const ms = new Date(props.endLocal).getTime() - new Date(props.startLocal).getTime()
    return Number.isFinite(ms) && ms >= 5 * 60_000 ? Math.round(ms / 60_000) : 30
  }

  async function search(): Promise<void> {
    setLoading(true)
    setError(null)
    try {
      setResult(
        await findFreeSlots(api, {
          durationMinutes: duration(),
          attendees: props.attendees,
          ...searchWindow(props.startLocal, new Date()),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          maxResults: 8,
          maxPerDay: 2,
        }),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  async function allow(scope: string): Promise<void> {
    try {
      await connectWithOAuth(api, AUTHORIZE_PATH, { mode: "personal", scopes: [scope] })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const slotLabel = (iso: string) =>
    new Date(iso).toLocaleString(i18n.locale(), {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    })
  const unknown = () =>
    (result()?.attendees ?? []).filter((a) => a.status === "unknown").map((a) => a.email)
  const noAccount = () => (result()?.attendees ?? []).some((a) => a.status === "no_account")

  return (
    <div class="flex flex-col gap-2" data-testid="event-find-time">
      <div class="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => void search()}
          disabled={loading()}
          data-testid="event-find-time-search"
        >
          {loading() ? i18n.t("calendar.findTimeLoading") : i18n.t("calendar.findTime")}
        </Button>
      </div>
      <Show when={result()}>
        {(r) => (
          <>
            <Show
              when={r().slots.length > 0}
              fallback={
                <span class="text-xs text-text-secondary" data-testid="event-find-time-none">
                  {i18n.t("calendar.findTimeNone")}
                </span>
              }
            >
              <ul class="flex flex-wrap gap-1.5" aria-label={i18n.t("calendar.findTimeSlots")}>
                <For each={r().slots}>
                  {(slot) => (
                    <li>
                      <button
                        type="button"
                        class="rounded-sm border border-border px-2 py-1 text-xs hover:bg-bg-hover"
                        data-testid="event-find-time-slot"
                        onClick={() =>
                          props.onPick({
                            startLocal: toLocalInput(slot.start),
                            endLocal: toLocalInput(slot.end),
                          })
                        }
                      >
                        {slotLabel(slot.start)}
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <Show when={r().consent?.needed ? r().consent : null}>
              {(consent) => (
                <div
                  class="flex flex-wrap items-center gap-2 text-xs text-text-secondary"
                  data-testid="event-find-time-consent"
                >
                  <span>{i18n.t("calendar.findTimeConsent")}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void allow(consent().scope)}
                    data-testid="event-find-time-allow"
                  >
                    {i18n.t("calendar.findTimeAllow")}
                  </Button>
                </div>
              )}
            </Show>
            <Show when={unknown().length > 0}>
              <span class="text-xs text-text-secondary" data-testid="event-find-time-unknown">
                {i18n.t("calendar.findTimeUnknown", { emails: unknown().join(", ") })}
              </span>
            </Show>
            <Show when={noAccount()}>
              <span class="text-xs text-text-secondary" data-testid="event-find-time-no-account">
                {i18n.t("calendar.findTimeNoAccount")}
              </span>
            </Show>
          </>
        )}
      </Show>
      <Show when={error()}>
        {(msg) => (
          <span class="text-xs text-error" data-testid="event-find-time-error">
            {i18n.t("calendar.findTimeError", { message: msg() })}
          </span>
        )}
      </Show>
    </div>
  )
}
