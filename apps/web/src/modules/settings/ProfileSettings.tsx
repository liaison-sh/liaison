// SPDX-License-Identifier: FSL-1.1-ALv2

import {
  resolveLocale,
  type ShippedLocale,
  type ThemePreference,
  toShippedLocale,
} from "@liaison/shared"
import {
  type Component,
  createEffect,
  createResource,
  createSignal,
  ErrorBoundary,
  on,
  Show,
  Suspense,
} from "solid-js"
import { getTimezones } from "~/lib/timezones"
import { noteDictationAutoClean } from "~/modules/assist/dictation-capabilities"
import DesktopClaudeAccount from "~/modules/desktop/DesktopClaudeAccount"
import { isDesktop } from "~/modules/desktop/desktop-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { shellTier } from "~/modules/shell/shell-tier"
import { getThemeStore } from "~/modules/shell/theme-store"
import { addToast } from "~/modules/shell/toast-store"
import { AvatarImage } from "~/ui/AvatarImage"
import { Button } from "~/ui/Button"
import { Input } from "~/ui/Input"
import { Skeleton } from "~/ui/Skeleton"
import { Switch } from "~/ui/Switch"
import {
  AVATAR_ACCEPT_ATTR,
  AVATAR_ACCEPT_MIME,
  AVATAR_MAX_UPLOAD_BYTES,
  removeAvatar,
  uploadAvatar,
} from "./avatar-service"
import { DesktopServersSection } from "./NativeServersSection"

interface UserProfile {
  id: string
  name: string
  email: string
  avatarUrl?: string | null
  timezone?: string
  locale?: string
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

const ProfileSettings: Component = () => {
  const api = useApi()
  const { t, locale: activeLocale, setLocale: setUiLocale } = useI18n()

  const [profile] = createResource(async () => {
    return api.get<UserProfile>("/users/me")
  })

  // Current persisted UI language + theme + magic-wand instruction
  // (kernel.user_preferences.{language,theme,magic_wand_instructions}).
  const [prefs] = createResource(async () =>
    api.get<{
      language?: string | null
      orgDefaultLocale?: string | null
      theme?: ThemePreference
      magicWandInstructions?: string | null
      dictationAutoClean?: boolean
    }>("/user/preferences"),
  )

  const themeStore = getThemeStore()

  const [name, setName] = createSignal("")
  const [timezone, setTimezone] = createSignal("")
  const [locale, setLocale] = createSignal("")
  // "" = the user never chose: the org default (then the browser) decides.
  const [language, setLanguage] = createSignal<ShippedLocale | "">(activeLocale())
  const fallbackLocale = (): ShippedLocale =>
    resolveLocale(
      prefs()?.orgDefaultLocale,
      typeof navigator !== "undefined" ? navigator.language : null,
    )
  const [themePref, setThemePref] = createSignal<ThemePreference>(themeStore.preference())
  const [wandInstructions, setWandInstructions] = createSignal("")
  // Last value persisted on the server, so onBlur only saves an actual edit.
  const [savedWandInstructions, setSavedWandInstructions] = createSignal("")
  const [savingWand, setSavingWand] = createSignal(false)
  // On unless the user turned it off (the column defaults to true).
  const [autoClean, setAutoClean] = createSignal(true)
  const [saving, setSaving] = createSignal(false)

  // Avatar state is kept in its own signal (not folded into the profile
  // resource) so replacing the picture does not re-run the form-init effect and
  // clobber unsaved name/timezone/locale edits.
  const [avatarUrl, setAvatarUrl] = createSignal<string | null>(null)
  const [avatarBusy, setAvatarBusy] = createSignal(false)
  let avatarInputRef: HTMLInputElement | undefined

  createEffect(
    on(
      prefs,
      (p) => {
        if (!p) return
        setLanguage(toShippedLocale(p.language) ?? "")
        const tt = p.theme
        if (tt === "light" || tt === "dark" || tt === "system") {
          // Server is source of truth across devices once authenticated.
          themeStore.hydrateFromServer(tt)
          setThemePref(tt)
        }
        const wand = p.magicWandInstructions ?? ""
        setWandInstructions(wand)
        setSavedWandInstructions(wand)
        setAutoClean(p.dictationAutoClean !== false)
      },
      { defer: true },
    ),
  )

  async function handleSaveWand() {
    // Skip the network round-trip + toast when the field was not actually edited
    // (blur fires on every focus-out). Compare trimmed, mirroring the server's
    // blank → null normalization so trailing whitespace alone is not "dirty".
    if (wandInstructions().trim() === savedWandInstructions().trim()) return
    setSavingWand(true)
    try {
      await api.put("/user/preferences/magic-wand", { instructions: wandInstructions() })
      setSavedWandInstructions(wandInstructions())
      addToast({ message: t("kernel.magicWandSaved"), type: "success" })
    } catch {
      addToast({ message: t("kernel.settings.profile.updateFailed"), type: "error" })
    } finally {
      setSavingWand(false)
    }
  }

  async function handleAutoCleanChange(next: boolean) {
    const previous = autoClean()
    setAutoClean(next)
    try {
      // Its own partial endpoint: the full /user/preferences PUT replaces the row.
      await api.put("/user/preferences/dictation", { autoClean: next })
      noteDictationAutoClean(api, next)
      addToast({ message: t("kernel.magicWandSaved"), type: "success" })
    } catch {
      setAutoClean(previous)
      addToast({ message: t("kernel.settings.profile.updateFailed"), type: "error" })
    }
  }

  async function handleThemeChange(next: ThemePreference) {
    const previous = themeStore.preference()
    // Optimistic: apply immediately for instant feedback.
    themeStore.setPreference(next)
    setThemePref(next)
    try {
      // Theme-only partial endpoint — mirrors language flow.
      await api.put("/user/preferences/theme", { theme: next })
    } catch {
      themeStore.setPreference(previous)
      setThemePref(previous)
      addToast({ message: t("kernel.settings.themeUpdateFailed"), type: "error" })
    }
  }

  async function handleLanguageChange(next: ShippedLocale | "") {
    setLanguage(next)
    // Immediate reactive re-render of every mounted tab (no remount).
    setUiLocale(next === "" ? fallbackLocale() : next)
    try {
      // Language-only partial endpoint — the full-replace /user/preferences
      // PUT requires the entire preferences object the toggle doesn't hold.
      // null clears the choice so the org default applies again.
      await api.put("/user/preferences/language", { language: next === "" ? null : next })
    } catch {
      addToast({ message: t("kernel.settings.profile.updateFailed"), type: "error" })
    }
  }

  createEffect(
    on(
      profile,
      (p) => {
        if (!p) return
        // One-shot form initialization from resource — not a reactive derivation
        setName(p.name)
        setTimezone(p.timezone ?? "")
        setLocale(p.locale ?? "")
        setAvatarUrl(p.avatarUrl ?? null)
      },
      { defer: true },
    ),
  )

  async function handleSave(e: Event) {
    e.preventDefault()
    setSaving(true)
    try {
      await api.patch("/users/me", {
        name: name(),
        timezone: timezone() || undefined,
        locale: locale() || undefined,
      })
      addToast({ message: t("kernel.settings.profile.updated"), type: "success" })
    } catch {
      addToast({ message: t("kernel.settings.profile.updateFailed"), type: "error" })
    } finally {
      setSaving(false)
    }
  }

  async function handleAvatarSelected(e: Event) {
    const input = e.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    // Reset so picking the same file again still fires onChange.
    input.value = ""
    if (!file) return
    if (file.size > AVATAR_MAX_UPLOAD_BYTES) {
      addToast({ message: t("kernel.settings.profile.avatarTooLarge"), type: "error" })
      return
    }
    if (file.type && !(AVATAR_ACCEPT_MIME as readonly string[]).includes(file.type)) {
      addToast({ message: t("kernel.settings.profile.avatarUnsupported"), type: "error" })
      return
    }
    setAvatarBusy(true)
    try {
      const updated = await uploadAvatar(api, file)
      setAvatarUrl(updated.avatarUrl ?? null)
      addToast({ message: t("kernel.settings.profile.avatarUpdated"), type: "success" })
    } catch {
      addToast({ message: t("kernel.settings.profile.avatarUploadFailed"), type: "error" })
    } finally {
      setAvatarBusy(false)
    }
  }

  async function handleRemoveAvatar() {
    setAvatarBusy(true)
    try {
      await removeAvatar(api)
      setAvatarUrl(null)
      addToast({ message: t("kernel.settings.profile.avatarRemoved"), type: "success" })
    } catch {
      addToast({ message: t("kernel.settings.profile.avatarUploadFailed"), type: "error" })
    } finally {
      setAvatarBusy(false)
    }
  }

  return (
    <div>
      <h1 class="mb-6 text-lg font-semibold text-text">{t("kernel.settings.profile.title")}</h1>

      {/* The desktop's saved servers and the Claude account its local
          sessions run on, first thing in the account area (no OS has a
          native Account menu). The phone draws its servers
          on the You screen instead, and a browser has neither. */}
      <Show when={shellTier() !== "phone" && isDesktop()}>
        <div class="mb-6 overflow-hidden rounded-lg border border-border-subtle pb-1">
          <DesktopServersSection />
          <DesktopClaudeAccount />
        </div>
      </Show>

      <ErrorBoundary fallback={(err) => <p class="p-4 text-sm text-error">{err.message}</p>}>
        <Suspense
          fallback={
            <div class="flex flex-col gap-4">
              <Skeleton class="h-8 w-full" />
              <Skeleton class="h-8 w-full" />
              <Skeleton class="h-8 w-full" />
            </div>
          }
        >
          <Show when={profile()}>
            <div class="mb-6 flex items-center gap-4">
              <div
                data-testid="profile-avatar-preview"
                class="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full text-lg font-medium text-text-secondary"
                style={{ "background-color": "var(--color-surface-hover)" }}
              >
                <AvatarImage
                  url={avatarUrl()}
                  alt={profile()!.name}
                  class="h-16 w-16 rounded-full object-cover"
                  fallback={<span>{initialsOf(name() || profile()!.name)}</span>}
                />
              </div>
              <div class="flex flex-col gap-2">
                <span class="text-[12.5px] font-medium text-text-secondary">
                  {t("kernel.settings.profile.avatarLabel")}
                </span>
                <input
                  ref={avatarInputRef}
                  type="file"
                  accept={AVATAR_ACCEPT_ATTR}
                  class="hidden"
                  data-testid="profile-avatar-file-input"
                  onChange={(e) => void handleAvatarSelected(e)}
                />
                <div class="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    loading={avatarBusy()}
                    data-testid="profile-avatar-change"
                    onClick={() => avatarInputRef?.click()}
                  >
                    {t("kernel.settings.profile.changePicture")}
                  </Button>
                  <Show when={avatarUrl()}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={avatarBusy()}
                      data-testid="profile-avatar-remove"
                      onClick={() => void handleRemoveAvatar()}
                    >
                      {t("kernel.settings.profile.removePicture")}
                    </Button>
                  </Show>
                </div>
                <p class="text-[12px] text-text-tertiary">
                  {t("kernel.settings.profile.avatarHint")}
                </p>
              </div>
            </div>

            <form onSubmit={handleSave} class="flex flex-col gap-4">
              <Input
                label={t("kernel.settings.profile.displayName")}
                value={name()}
                onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)}
              />
              <div class="flex flex-col gap-1.5">
                <label class="text-[12.5px] font-medium text-text-secondary">
                  {t("kernel.settings.language")}
                </label>
                <select
                  data-testid="settings-language-select"
                  aria-label={t("kernel.settings.language")}
                  value={language()}
                  onChange={(e) =>
                    void handleLanguageChange(e.currentTarget.value as ShippedLocale | "")
                  }
                  class="w-full rounded-sm border border-border bg-bg px-3 py-[9px] text-[13.5px] text-text outline-none transition-colors duration-150 focus:border-accent-muted"
                >
                  <option value="">
                    {t("kernel.settings.languageOrgDefault", {
                      language: t(
                        fallbackLocale() === "fr"
                          ? "kernel.settings.languageFrench"
                          : "kernel.settings.languageEnglish",
                      ),
                    })}
                  </option>
                  <option value="en">{t("kernel.settings.languageEnglish")}</option>
                  <option value="fr">{t("kernel.settings.languageFrench")}</option>
                </select>
                <p class="text-[12px] text-text-tertiary">
                  {t("kernel.settings.languageDescription")}
                </p>
              </div>
              <div class="flex flex-col gap-1.5">
                <label class="text-[12.5px] font-medium text-text-secondary">
                  {t("kernel.settings.theme")}
                </label>
                <select
                  data-testid="settings-theme-select"
                  aria-label={t("kernel.settings.theme")}
                  value={themePref()}
                  onChange={(e) => void handleThemeChange(e.currentTarget.value as ThemePreference)}
                  class="w-full rounded-sm border border-border bg-bg px-3 py-[9px] text-[13.5px] text-text outline-none transition-colors duration-150 focus:border-accent-muted"
                >
                  <option value="system">{t("kernel.settings.themeSystem")}</option>
                  <option value="light">{t("kernel.settings.themeLight")}</option>
                  <option value="dark">{t("kernel.settings.themeDark")}</option>
                </select>
                <p class="text-[12px] text-text-tertiary">
                  {t("kernel.settings.themeDescription")}
                </p>
              </div>
              <div class="flex flex-col gap-1.5">
                <label class="text-[12.5px] font-medium text-text-secondary">
                  {t("kernel.settings.profile.timezone")}
                </label>
                <select
                  aria-label={t("kernel.settings.profile.timezone")}
                  value={timezone()}
                  onChange={(e) => setTimezone(e.currentTarget.value)}
                  class="w-full rounded-sm border border-border bg-bg px-3 py-[9px] text-[13.5px] text-text outline-none transition-colors duration-150 focus:border-accent-muted"
                >
                  <option value="">{t("kernel.settings.profile.selectTimezone")}</option>
                  {getTimezones().map((tz) => (
                    <option value={tz}>{tz}</option>
                  ))}
                </select>
              </div>
              <div class="flex flex-col gap-1.5">
                <label class="text-[12.5px] font-medium text-text-secondary">
                  {t("kernel.settings.profile.locale")}
                </label>
                <select
                  aria-label={t("kernel.settings.profile.locale")}
                  value={locale()}
                  onChange={(e) => setLocale(e.currentTarget.value)}
                  class="w-full rounded-sm border border-border bg-bg px-3 py-[9px] text-[13.5px] text-text outline-none transition-colors duration-150 focus:border-accent-muted"
                >
                  <option value="">{t("kernel.settings.profile.selectLocale")}</option>
                  <option value="en-US">{t("kernel.settings.profile.localeEnUs")}</option>
                  <option value="en-GB">{t("kernel.settings.profile.localeEnGb")}</option>
                  <option value="fr-FR">{t("kernel.settings.profile.localeFr")}</option>
                  <option value="de-DE">{t("kernel.settings.profile.localeDe")}</option>
                  <option value="es-ES">{t("kernel.settings.profile.localeEs")}</option>
                  <option value="pt-BR">{t("kernel.settings.profile.localePtBr")}</option>
                  <option value="ja-JP">{t("kernel.settings.profile.localeJa")}</option>
                  <option value="zh-CN">{t("kernel.settings.profile.localeZhCn")}</option>
                </select>
              </div>
              <div class="pt-2">
                <Button fullWidth type="submit" loading={saving()}>
                  {t("kernel.settings.profile.saveChanges")}
                </Button>
              </div>
            </form>

            <div class="mt-6 flex flex-col gap-1.5 border-t border-border pt-6">
              <label
                for="magic-wand-instructions"
                class="text-[12.5px] font-medium text-text-secondary"
              >
                {t("kernel.magicWandLabel")}
              </label>
              <textarea
                id="magic-wand-instructions"
                data-testid="settings-magic-wand-instructions"
                rows={3}
                maxlength={2000}
                aria-busy={savingWand() || undefined}
                value={wandInstructions()}
                onInput={(e) => setWandInstructions(e.currentTarget.value)}
                // Mirrors the language/theme fields above: persist on blur via the
                // dedicated /magic-wand partial endpoint — no extra Save button.
                onBlur={() => void handleSaveWand()}
                placeholder={t("kernel.magicWandPlaceholder")}
                class="w-full resize-y rounded-sm border border-border bg-bg px-3 py-[9px] text-[13.5px] text-text outline-none transition-colors duration-150 focus:border-accent-muted"
              />
              <p class="text-[12px] text-text-tertiary">{t("kernel.magicWandHint")}</p>
              <div class="mt-3 flex min-h-11 items-center justify-between gap-4">
                <div class="flex min-w-0 flex-col gap-0.5">
                  <span class="text-[12.5px] font-medium text-text-secondary">
                    {t("kernel.dictation.autoCleanLabel")}
                  </span>
                  <span class="text-[12px] text-text-tertiary">
                    {t("kernel.dictation.autoCleanHint")}
                  </span>
                </div>
                <Switch
                  data-testid="settings-dictation-auto-clean"
                  checked={autoClean()}
                  onChange={(next) => void handleAutoCleanChange(next)}
                  label={t("kernel.dictation.autoCleanLabel")}
                />
              </div>
            </div>
          </Show>
        </Suspense>
      </ErrorBoundary>
    </div>
  )
}

export default ProfileSettings
