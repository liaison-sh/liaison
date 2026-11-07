// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "Apps in the making" on the App store page, for holders of kernel:apps:build:
// the org's live drafts, each opening its builder tab. Drafts are made by the
// agent (apps_build_create), so the empty state says how to start one. Absent
// on a server where organisations may not have their own apps (the branding
// `customApps` flag, LIAISON_CUSTOM_APPS).
import { type Component, createResource, For, onMount, Show } from "solid-js"
import { hasScope } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { customAppsEnabled, ensureBrandingLoaded } from "~/modules/shell/branding-store"
import { type BuilderApi, listDrafts } from "./builder-client"
import { openDraft } from "./builder-store"

const K = "kernel.appBuilder"

export const DraftsSection: Component = () => {
  const i18n = useI18n()
  const api = useApi() as unknown as BuilderApi
  onMount(() => void ensureBrandingLoaded())
  const allowed = () => customAppsEnabled() && hasScope("kernel:apps:build")
  const [drafts] = createResource(allowed, () => listDrafts(api).catch(() => null))

  return (
    <Show when={allowed()}>
      <section data-testid="builder-drafts" class="mt-6">
        <h2 class="mb-1 text-[14px] font-semibold">{i18n.t(`${K}.draftsTitle`)}</h2>
        <p class="mb-3 text-[12.5px] text-text-secondary">{i18n.t(`${K}.draftsIntro`)}</p>
        <Show
          when={(drafts() ?? []).length > 0}
          fallback={
            <Show when={!drafts.loading}>
              <p
                data-testid={drafts() === null ? "builder-drafts-failed" : "builder-drafts-empty"}
                class="rounded-lg border border-border bg-surface px-4 py-3 text-[13px] text-text-secondary"
              >
                {drafts() === null ? i18n.t(`${K}.loadFailed`) : i18n.t(`${K}.draftsEmpty`)}
              </p>
            </Show>
          }
        >
          <ul class="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
            <For each={drafts() ?? []}>
              {(d) => (
                <li>
                  <button
                    type="button"
                    data-testid={`builder-draft-${d.id}`}
                    class="flex w-full items-center gap-3 px-3 py-2.5 text-left"
                    onClick={() => openDraft(d)}
                  >
                    <span class="min-w-0 flex-1">
                      <span class="block truncate text-[13.5px] font-medium">{d.title}</span>
                      <span class="block truncate font-mono text-[11px] text-text-tertiary">
                        {d.publishedAppName ?? d.baseName} · v{d.latestVersion}
                      </span>
                    </span>
                    <span class="shrink-0 text-[11px] text-text-tertiary">
                      {i18n.t(`${K}.status.${d.status}`)}
                    </span>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>
    </Show>
  )
}
