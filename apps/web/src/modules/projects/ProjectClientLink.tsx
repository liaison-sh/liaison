// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The project page's link to its client company: one quiet line, opening the company's page.
// A company the reader cannot see is named so, and still opens nothing it would not.

import { type Component, createResource, Show } from "solid-js"
import type { ApiClient } from "~/lib/api-client"
import { openCompanyTab } from "~/modules/contacts/company-visuals"
import { useI18n } from "~/modules/i18n/i18n-context"
import { clientName } from "~/modules/projects/ProjectEditForm"

export const ProjectClientLink: Component<{
  api: Partial<Pick<ApiClient, "get" | "getEnvelope">>
  companyId: string
}> = (props) => {
  const i18n = useI18n()
  const [name] = createResource(
    () => props.companyId,
    (id) => clientName(props.api, id),
  )
  return (
    <div data-testid="project-client" class="flex items-center gap-2 px-6 pb-2 text-[12.5px]">
      <span class="text-text-tertiary">{i18n.t("projects.deals.clientLink")}</span>
      <Show
        when={name()}
        fallback={
          <span class="text-text-tertiary">
            {name.loading ? "" : i18n.t("projects.deals.clientUnavailable")}
          </span>
        }
      >
        {(n) => (
          <button
            type="button"
            data-testid="project-client-link"
            class="text-left text-text underline decoration-border underline-offset-2 hover:decoration-text"
            onClick={() => openCompanyTab(props.companyId, n())}
          >
            {n()}
          </button>
        )}
      </Show>
    </div>
  )
}
