// SPDX-License-Identifier: FSL-1.1-ALv2
// The Calendar settings page's "Calendars" block (custom block
// `CalendarChoices`, declared in the calendar manifest `settings`): which
// calendars of the connected accounts are imported, and a Retry for an account
// whose import failed. Connecting, sharing and disconnecting an account is the
// page's connections block, right above this one.
import { type Component, createResource, createSignal, For, onMount, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"
import {
  type CalendarConnectionDto,
  canRetryCalendarImport,
  listCalendarConnections,
  retryCalendarImport,
  setCalendarSelected,
} from "./calendar-api"
import { calendarStore, loadCalendarsList } from "./calendar-store"

export const CalendarChoices: Component = () => {
  const api = useApi()
  const i18n = useI18n()
  const [connections, { refetch }] = createResource<CalendarConnectionDto[]>(() =>
    listCalendarConnections(api),
  )
  onMount(() => void loadCalendarsList(api))
  const failed = () => (connections() ?? []).filter((conn) => conn.status === "error")
  const revoked = () => (connections() ?? []).filter((conn) => conn.status === "reauth-required")

  const [retryErrors, setRetryErrors] = createSignal<Record<string, string>>({})

  async function retryImport(accountId: string): Promise<void> {
    setRetryErrors(({ [accountId]: _cleared, ...rest }) => rest)
    try {
      await retryCalendarImport(api, accountId)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setRetryErrors((prev) => ({ ...prev, [accountId]: message }))
      return
    }
    // The import runs as a background job: look again once it had time to finish.
    setTimeout(() => {
      void refetch()
      void loadCalendarsList(api)
    }, 5000)
  }

  const [selectError, setSelectError] = createSignal<string | null>(null)

  async function toggleCalendar(input: HTMLInputElement, calendarId: string): Promise<void> {
    const selected = input.checked
    setSelectError(null)
    try {
      await setCalendarSelected(api, calendarId, selected)
    } catch (err) {
      // The server refused: put the box back where it was and say why.
      input.checked = !selected
      setSelectError(err instanceof Error ? err.message : String(err))
      return
    }
    await loadCalendarsList(api)
  }

  return (
    <div class="flex flex-col gap-4" data-testid="calendar-choices">
      <For each={revoked()}>
        {(conn) => (
          <div
            class="rounded-sm border border-border p-2 text-xs"
            data-testid="calendar-reauth-banner"
          >
            <div class="font-medium">{conn.identifier}</div>
            <div class="text-error">{i18n.t("calendar.reauthRequired")}</div>
          </div>
        )}
      </For>
      <Show when={failed().length > 0}>
        <ul class="flex flex-col gap-2">
          <For each={failed()}>
            {(conn) => (
              <li class="flex items-center justify-between gap-3 rounded-sm border border-border p-2">
                <div class="min-w-0">
                  <div class="text-xs font-medium">{conn.identifier}</div>
                  <div
                    class="text-xs text-error break-words"
                    data-testid="calendar-connection-error"
                  >
                    {conn.lastSyncError ?? i18n.t("calendar.importFailedNoDetail")}
                  </div>
                  <Show when={retryErrors()[conn.id]}>
                    {(message) => (
                      <div
                        class="text-xs text-error break-words"
                        data-testid="calendar-connection-retry-error"
                      >
                        {message()}
                      </div>
                    )}
                  </Show>
                </div>
                <Show when={canRetryCalendarImport(conn)}>
                  <Button
                    size="sm"
                    data-testid="calendar-connection-retry"
                    onClick={() => void retryImport(conn.id)}
                  >
                    {i18n.t("calendar.retryImport")}
                  </Button>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>

      <div>
        {/* Every calendar of the connected accounts, ticked or not: an unticked one must stay
            here to be ticked again. */}
        <h3 class="text-xs font-semibold">{i18n.t("calendar.calendarsToSync")}</h3>
        <ul class="flex flex-col gap-1">
          <For each={calendarStore.calendars}>
            {(cal) => (
              <li class="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={cal.selected}
                  data-testid={`calendar-select-${cal.id}`}
                  onChange={(e) => void toggleCalendar(e.currentTarget, cal.id)}
                />
                <span>{cal.name}</span>
              </li>
            )}
          </For>
        </ul>
        <Show when={selectError()}>
          {(message) => (
            <div class="text-xs text-error break-words" data-testid="calendar-select-error">
              {message()}
            </div>
          )}
        </Show>
      </div>
    </div>
  )
}
