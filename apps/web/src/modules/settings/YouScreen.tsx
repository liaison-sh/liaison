// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The You screen (M2-3 T18): the phone tier's settings ROOT.
//
// At phone width the settings tab used to open straight onto the Profile form,
// with every other section reachable only through the navigator sheet. The
// root here is instead a person: who you are signed in as, then the grouped
// lists that read like a phone's own settings app: your agent, then the same
// groups and rows as the desktop settings column (You, AI, Workspace, Apps,
// Connectors).
//
// It owns a large title of its own, the `Work` / `Chats` idiom, and leaves the
// shell's phone top bar alone: the settings sidebar is still the navigator
// sheet's content, and hiding or replacing the bar would take the navigator
// control with it.
//
// Every row comes from `you-screen-model.ts`, which derives the list from the
// REGISTERED settings sections plus the stores, so a section this viewer
// cannot reach never appears here.
import { ChevronRight } from "lucide-solid"
import { type Component, createMemo, createSignal, For, onMount, Show } from "solid-js"
import { getActivityBarEntries } from "~/framework/app-registry"
import * as appLock from "~/lib/app-lock"
import { serverAddressOverride } from "~/lib/env"
import { userFromToken } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { ensureBrandingLoaded, orgName } from "~/modules/shell/branding-store"
import { openTab } from "~/modules/shell/tab-store"
import { addToast } from "~/modules/shell/toast-store"
import { loadAgentDirectory, personalAgentFor } from "~/modules/threads/agent-directory"
import { avatarColors } from "~/ui/avatar-palette"
import { Switch } from "~/ui/Switch"
import NativeServersSection from "./NativeServersSection"
import { pushSettingsSection } from "./phone-settings-nav"
import { buildSettingsNavGroups } from "./settings-nav-groups"
import { visibleSettingsSections } from "./visible-settings-sections"
import { buildYouGroups, profileSection, type YouRow } from "./you-screen-model"

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase() || "?"
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The one line under the name: role, workspace, and the server this is.
 *
 * The token's `roles` claim carries role IDs, not role names, and a row that
 * reads "039492fa-5b93-459f…" tells the viewer nothing while pushing the
 * workspace and the server name off the end of the line. An id is therefore
 * dropped rather than printed: what is left still answers "which workspace,
 * which server", which is the question this line exists for.
 */
/**
 * The server a NATIVE SHELL was pointed at, as a bare hostname.
 *
 * In a browser the app is served by its own API's origin and there is no
 * override: the deployment is the page the viewer already opened, so naming it
 * adds nothing and `window.location.host` only printed a port number
 * ("localhost:18080") under the viewer's own name. Under a shell the address
 * was typed by hand and IS worth saying, but the scheme and the port are
 * plumbing: the hostname is the part a person recognises.
 */
export function friendlyHost(address: string | null): string | null {
  if (!address) return null
  try {
    const host = new URL(address).hostname.trim()
    return host.length > 0 ? host : null
  } catch {
    return null
  }
}

export function identityLine(parts: {
  role?: string | null
  org?: string | null
  host?: string | null
}): string {
  const role = parts.role && !UUID_RE.test(parts.role) ? parts.role : null
  return [role, parts.org, parts.host].filter((p) => !!p && p.length > 0).join(" · ")
}

export const YouScreen: Component = () => {
  const i18n = useI18n()
  const api = useApi()

  onMount(() => {
    void ensureBrandingLoaded()
    void loadAgentDirectory(api)
  })

  // The row itself only exists once the shell answers "yes, there is a
  // biometric to ask for" -- a plain browser (and a shell with no sensor
  // enrolled) never sees it at all, rather than seeing it disabled.
  const [appLockAvailable, setAppLockAvailable] = createSignal(false)
  const [appLockOn, setAppLockOn] = createSignal(false)
  onMount(() => {
    void appLock.isAvailable().then((available) => {
      setAppLockAvailable(available)
      if (!available) return
      void appLock.getEnabled().then(setAppLockOn)
    })
  })

  async function toggleAppLock(): Promise<void> {
    const next = !appLockOn()
    setAppLockOn(next)
    try {
      await appLock.setEnabled(next)
    } catch {
      setAppLockOn(!next)
      addToast({ message: i18n.t("kernel.youAppLockSaveFailed"), type: "error" })
    }
  }

  const user = () => userFromToken()
  const agentName = () => personalAgentFor(user()?.userId)?.name ?? null

  const groups = createMemo(() =>
    buildYouGroups({
      navGroups: buildSettingsNavGroups(
        visibleSettingsSections().filter((s) => !s.hidden),
        getActivityBarEntries(),
        i18n.t,
      ),
      appLockAvailable: appLockAvailable(),
      t: i18n.t,
    }),
  )

  // appLock is the only switch left on this screen; the notification
  // preferences live on Settings > Notifications, reached by a row.
  function toggleValue(_target: Extract<YouRow["target"], { kind: "toggle" }>): boolean {
    return appLockOn()
  }

  function handleToggle(_target: Extract<YouRow["target"], { kind: "toggle" }>): void {
    void toggleAppLock()
  }

  function openRow(row: YouRow): void {
    const target = row.target
    if (target.kind === "section") {
      pushSettingsSection(target.href)
      return
    }
    if (target.kind === "route") {
      openTab({
        type: "agents:agent",
        entityId: "self",
        label: agentName() ?? i18n.t("kernel.youAgentFallback"),
        routePath: target.path,
      })
    }
  }

  function openProfile(): void {
    const profile = profileSection(visibleSettingsSections())
    if (profile) pushSettingsSection(profile.href)
  }

  // Only a custom server earns a segment, and only by name: see friendlyHost.
  const serverLine = () => {
    const host = friendlyHost(serverAddressOverride())
    return host ? i18n.t("kernel.youServerHost", { host }) : null
  }

  return (
    <div data-testid="you-screen" class="flex h-full min-h-0 flex-col overflow-y-auto pb-8">
      <div class="shrink-0 px-4 pb-2 pt-3">
        <h1
          data-testid="you-title"
          class="font-display text-[32px] font-semibold leading-tight text-text"
        >
          {i18n.t("kernel.youTitle")}
        </h1>
      </div>

      <button
        type="button"
        data-testid="you-profile-row"
        onClick={openProfile}
        class="flex w-full shrink-0 items-center gap-3 px-4 py-3 text-left hover:bg-surface-hover"
      >
        <span
          aria-hidden="true"
          class="flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-full text-[18px] font-semibold"
          style={{
            "background-color": avatarColors(user()?.userId).bg,
            color: avatarColors(user()?.userId).text,
          }}
        >
          {initialsOf(user()?.name ?? "")}
        </span>
        <span class="min-w-0 flex-1">
          <span data-testid="you-profile-name" class="block truncate text-[17px] text-text">
            {user()?.name ?? ""}
          </span>
          <span
            data-testid="you-profile-identity"
            class="block truncate text-[13px] text-text-secondary"
          >
            {identityLine({ role: user()?.roles?.[0], org: orgName(), host: serverLine() })}
          </span>
        </span>
        <ChevronRight size={18} class="shrink-0 text-text-tertiary" />
      </button>

      {/* The phone's saved servers, right under who you are: which server this
          is belongs with the identity, and at the end of the list it sat under
          every admin table where nobody found it (simulator, 2026-09-28).
          Nothing at all outside the mobile shell. */}
      <NativeServersSection />

      <For each={groups()}>
        {(group) => (
          <div
            data-testid={`you-group-${group.id}`}
            class={group.label === "" ? "flex flex-col pt-3" : "flex flex-col"}
          >
            {/* A group may be a single self-describing link (the Agents row),
                in which case a heading above it would only repeat it. */}
            <Show when={group.label !== ""}>
              <h2 class="px-4 pb-1 pt-4 text-[12px] font-semibold uppercase tracking-wide text-text-tertiary">
                {group.label}
              </h2>
            </Show>
            <For each={group.rows}>
              {(row) => (
                <Show
                  when={row.target.kind !== "toggle"}
                  fallback={
                    // The ROW is the 44px tap target, not the little track at
                    // the end of it: a tap anywhere on the line toggles, and
                    // the switch itself keeps its real 24px size. A tap that
                    // landed on the switch is already handled by the switch.
                    // biome-ignore lint/a11y/useKeyWithClickEvents: the switch inside is the keyboard control
                    <div
                      data-testid={`you-row-${row.id}`}
                      onClick={(e) => {
                        if ((e.target as HTMLElement).closest('[role="switch"]')) return
                        if (row.target.kind !== "toggle") return
                        handleToggle(row.target)
                      }}
                      class="flex min-h-11 w-full shrink-0 items-center gap-3 px-4 text-[16px] text-text"
                    >
                      <span class="min-w-0 flex-1 truncate">{row.label}</span>
                      <Switch
                        label={row.label}
                        data-testid={`you-toggle-${row.id}`}
                        checked={row.target.kind === "toggle" ? toggleValue(row.target) : false}
                        onChange={() => {
                          if (row.target.kind !== "toggle") return
                          handleToggle(row.target)
                        }}
                      />
                    </div>
                  }
                >
                  <button
                    type="button"
                    data-testid={`you-row-${row.id}`}
                    onClick={() => openRow(row)}
                    class="flex h-[46px] w-full shrink-0 items-center gap-3 px-4 text-left text-[16px] text-text hover:bg-surface-hover"
                  >
                    <span class="min-w-0 flex-1 truncate">{row.label}</span>
                    <Show when={row.badge}>
                      <span
                        data-testid={`you-row-badge-${row.id}`}
                        class="shrink-0 text-[11px] font-medium uppercase tracking-[0.08em] text-text-tertiary"
                      >
                        {row.badge}
                      </span>
                    </Show>
                    <Show when={row.value}>
                      <span class="shrink-0 text-[14px] text-text-secondary">{row.value}</span>
                    </Show>
                    <ChevronRight size={16} class="shrink-0 text-text-tertiary" />
                  </button>
                </Show>
              )}
            </For>
          </div>
        )}
      </For>
    </div>
  )
}
