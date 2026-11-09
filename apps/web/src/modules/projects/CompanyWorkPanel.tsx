// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The Work section of a company's page (`slots.company_detail`, group
 * `work`): the projects whose client is the company and its deals, read as
 * the viewer through `projects:company_work`. A deal's amount shows only with
 * deal access; without it the deal still shows, with "Needs deal access".
 */
import { type Component, createResource, For, Show } from "solid-js"
import type { ApiClient } from "~/lib/api-client"
import { useI18n } from "~/modules/i18n/i18n-context"
import type { DealRead } from "~/modules/projects/deal-api"
import { useApi } from "~/modules/shell/ApiContext"
import { openEntity } from "~/modules/shell/entity-opener"

export interface CompanyWork {
  projects: Array<{ id: string; name: string; key: string | null }>
  deals: DealRead[]
}

/** The company's projects and deals. Throws when the read fails. */
export async function loadCompanyWork(
  api: Pick<ApiClient, "post">,
  companyId: string,
): Promise<CompanyWork> {
  const res = await api.post<unknown>("/apps/run-tool", {
    toolName: "projects:company_work",
    params: { companyId },
  })
  const body = (
    res && typeof res === "object" && "data" in (res as object)
      ? (res as { data: unknown }).data
      : res
  ) as Partial<CompanyWork> & { error?: unknown }
  if (!body || body.error || !Array.isArray(body.projects) || !Array.isArray(body.deals)) {
    throw new Error("company_work_failed")
  }
  return { projects: body.projects, deals: body.deals }
}

export const CompanyWorkPanel: Component<{ entityId?: string }> = (props) => {
  const api = useApi()
  const i18n = useI18n()
  const [work] = createResource(
    () => props.entityId || undefined,
    (id) => loadCompanyWork(api, id),
  )
  const amount = (d: DealRead): string => {
    const v = d.values
    if (!v) return i18n.t("projects.companyWork.needsDealAccess")
    if (v.amountMinor === null || !v.currency) return i18n.t("projects.companyWork.noAmount")
    return i18n.fmtCurrency(v.amountMinor / 100, v.currency)
  }
  const empty = () =>
    !!work.latest && work.latest.projects.length === 0 && work.latest.deals.length === 0
  return (
    <div data-testid="company-work-panel" class="space-y-3 text-[13px]">
      <Show
        when={!work.error}
        fallback={
          <p data-testid="company-work-panel.error" class="py-2 text-text-tertiary">
            {i18n.t("projects.companyWork.error")}
          </p>
        }
      >
        <Show when={empty()}>
          <p data-testid="company-work-panel.empty" class="py-2 text-text-tertiary">
            {i18n.t("projects.companyWork.empty")}
          </p>
        </Show>
        <Show when={(work.latest?.deals.length ?? 0) > 0}>
          <ul class="divide-y divide-border-subtle" data-testid="company-work-panel.deals">
            <For each={work.latest?.deals}>
              {(d) => (
                <li>
                  <button
                    type="button"
                    data-testid={`company-work-panel.deal-${d.task.id}`}
                    class="flex min-h-[44px] w-full items-center gap-3 py-2 text-left hover:bg-surface-hover"
                    onClick={() =>
                      void openEntity(
                        api,
                        "projects",
                        "task",
                        d.task.id,
                        `${d.task.key} ${d.task.title}`,
                      )
                    }
                  >
                    <span class="min-w-0 flex-1 truncate text-text">
                      {d.task.key} {d.task.title}
                    </span>
                    <span class="shrink-0 text-[12px] text-text-tertiary">
                      {d.deal.outcome === "open"
                        ? d.task.stage
                        : i18n.t(`projects.companyWork.${d.deal.outcome}`)}
                    </span>
                    <span
                      class="shrink-0 text-[12px] text-text-secondary"
                      data-testid={`company-work-panel.deal-${d.task.id}.amount`}
                    >
                      {amount(d)}
                    </span>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <Show when={(work.latest?.projects.length ?? 0) > 0}>
          <ul class="divide-y divide-border-subtle" data-testid="company-work-panel.projects">
            <For each={work.latest?.projects}>
              {(p) => (
                <li>
                  <button
                    type="button"
                    data-testid={`company-work-panel.project-${p.id}`}
                    class="flex min-h-[44px] w-full items-center gap-3 py-2 text-left hover:bg-surface-hover"
                    onClick={() => void openEntity(api, "projects", "project", p.id, p.name)}
                  >
                    <span class="min-w-0 flex-1 truncate text-text">{p.name}</span>
                    <Show when={p.key}>
                      <span class="shrink-0 font-mono text-[12px] text-text-tertiary">{p.key}</span>
                    </Show>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>
    </div>
  )
}
