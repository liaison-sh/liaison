// SPDX-License-Identifier: FSL-1.1-ALv2

import { type Component, createResource, createSignal, Show, Suspense } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"
import { Button } from "~/ui/Button"
import { LiaisonTeamSection } from "./LiaisonTeamSection"

interface VersionCheckBody {
  running: string
  channel?: "release" | "nightly"
  latest?: string
  latestUrl?: string
  updateAvailable: boolean
  securityUpdate?: boolean
  stale?: boolean
  enabled: boolean
}

interface HealthzBody {
  status: string
  version: string
  migrationHead: string
  schemaBaseline: string
  dependencies: Record<string, string>
}

/** A build of a branch, `main-<sha>`, reads "main · <sha>"; a release tag or
 *  any other label reads verbatim. */
export function runningVersionLabel(running: string): string {
  const branchBuild = /^main-([0-9a-f]{7,40})$/.exec(running)
  return branchBuild ? `main · ${branchBuild[1]}` : running
}

const SystemSettings: Component = () => {
  const i18n = useI18n()
  const api = useApi()

  const [versionCheck, { refetch: refetchVersion }] = createResource(async () => {
    return api.get<VersionCheckBody>("/admin/version-check")
  })

  const [healthz] = createResource(async () => {
    // Public /healthz is liveness only; the dependency detail is an admin route.
    return api.get<HealthzBody>("/admin/system-health")
  })

  const [saving, setSaving] = createSignal(false)
  async function toggleUpdateChecks(next: boolean) {
    setSaving(true)
    try {
      await api.patch("/org", { updateChecksEnabled: next })
      addToast({
        message: next
          ? i18n.t("kernel.settingsUi.updateChecksEnabled")
          : i18n.t("kernel.settingsUi.updateChecksDisabled"),
        type: "success",
      })
      await refetchVersion()
    } catch (err) {
      addToast({ message: `Failed: ${err}`, type: "error" })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div class="flex flex-col gap-6 p-6" data-testid="settings-system">
      <h2 class="text-xl font-semibold">{i18n.t("kernel.settingsUi.system")}</h2>

      {/* Version row */}
      <Suspense fallback={<div>{i18n.t("kernel.settingsUi.loadingVersion")}</div>}>
        <Show when={versionCheck()}>
          {(v) => (
            <section class="flex flex-col gap-2 rounded border p-4" data-testid="system-version">
              <Show when={v().channel}>
                {(channel) => (
                  <div class="flex items-baseline gap-2">
                    <span class="text-sm text-muted-foreground">
                      {i18n.t("kernel.settingsUi.channel")}
                    </span>
                    <span class="text-sm" data-testid="system-version-channel">
                      {channel() === "nightly"
                        ? i18n.t("kernel.settingsUi.channelNightly")
                        : i18n.t("kernel.settingsUi.channelRelease")}
                    </span>
                  </div>
                )}
              </Show>
              <div class="flex items-baseline gap-2">
                <span class="text-sm text-muted-foreground">
                  {i18n.t("kernel.settingsUi.running")}
                </span>
                <code class="text-sm" data-testid="system-version-running">
                  {runningVersionLabel(v().running)}
                </code>
              </div>
              <Show when={v().enabled && v().latest}>
                <div class="flex items-baseline gap-2">
                  <span class="text-sm text-muted-foreground">
                    {i18n.t("kernel.settingsUi.latest")}
                  </span>
                  <code class="text-sm" data-testid="system-version-latest">
                    {v().latest}
                  </code>
                  <Show when={v().stale}>
                    <span class="text-xs text-amber-600" data-testid="version-stale">
                      {i18n.t("kernel.settingsUi.stale")}
                    </span>
                  </Show>
                </div>
                <Show when={v().updateAvailable}>
                  <div
                    class="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900"
                    data-testid="update-banner"
                  >
                    {v().securityUpdate
                      ? i18n.t("kernel.settingsUi.securityUpdateAvailable")
                      : i18n.t("kernel.settingsUi.updateAvailable")}{" "}
                    <code>{v().latest}</code>
                    <Show when={v().latestUrl}>
                      {" "}
                      <a
                        href={v().latestUrl!}
                        target="_blank"
                        rel="noopener noreferrer"
                        class="underline"
                      >
                        {i18n.t("kernel.settingsUi.releaseNotes")}
                      </a>
                    </Show>
                  </div>
                </Show>
              </Show>
            </section>
          )}
        </Show>
      </Suspense>

      {/* Dependency pills */}
      <Suspense fallback={<div>{i18n.t("kernel.settingsUi.loadingHealth")}</div>}>
        <Show when={healthz()}>
          {(h) => (
            <section
              class="flex flex-col gap-2 rounded border p-4"
              data-testid="system-dependencies"
            >
              <h3 class="text-sm font-medium">{i18n.t("kernel.settingsUi.dependencies")}</h3>
              <div class="flex flex-wrap gap-2">
                {Object.entries(h().dependencies).map(([name, status]) => (
                  <span
                    class={`rounded-full px-2 py-1 text-xs ${
                      status === "ok"
                        ? "bg-emerald-100 text-emerald-900"
                        : "bg-rose-100 text-rose-900"
                    }`}
                    data-testid={`health-pill-${name}`}
                  >
                    {name}: {status}
                  </span>
                ))}
              </div>
              <div class="text-xs text-muted-foreground">
                {i18n.t("kernel.settingsUi.migrationHead")}{" "}
                <code data-testid="system-migration-head">{h().migrationHead}</code>{" "}
                {i18n.t("kernel.settingsUi.schemaBaseline")} <code>{h().schemaBaseline}</code>
              </div>
            </section>
          )}
        </Show>
      </Suspense>

      {/* Update-check opt-out */}
      <Suspense>
        <Show when={versionCheck()}>
          {(v) => (
            <section class="flex flex-col gap-2 rounded border p-4" data-testid="system-opt-out">
              <h3 class="text-sm font-medium">{i18n.t("kernel.settingsUi.updateChecks")}</h3>
              <p class="text-xs text-muted-foreground">
                {i18n.t("kernel.settingsUi.periodicallyCheckGithubForNewerLiaison")}
              </p>
              <Button
                fullWidth
                variant={v().enabled ? "outline" : "primary"}
                disabled={saving()}
                onClick={() => toggleUpdateChecks(!v().enabled)}
                data-testid="toggle-update-checks"
              >
                {v().enabled
                  ? i18n.t("kernel.settingsUi.disableUpdateChecks")
                  : i18n.t("kernel.settingsUi.enableUpdateChecks")}
              </Button>
            </section>
          )}
        </Show>
      </Suspense>

      <LiaisonTeamSection />
    </div>
  )
}

export default SystemSettings
