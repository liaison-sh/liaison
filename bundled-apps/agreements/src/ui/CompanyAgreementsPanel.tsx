// SPDX-License-Identifier: FSL-1.1-ALv2
//
// CompanyAgreementsPanel — the Agreements section of the kernel's company page
// (`slots.company_detail`). Lists the company's agreements, read with
// `agreements_search({ company_id })` as the viewer: the kernel lists the panel only for a
// reader of agreements, and the read returns only the agreements they may see.

import { app } from "@liaison/host"
import { type Component, createResource, For, Show } from "solid-js"
import { go, paths } from "./host"
import { tr } from "./i18n"
import { StatusBadge } from "./List"
import type { AgreementBrief } from "./model"

export interface CompanyAgreementsPanelProps {
  /** The company id: the slot host mounts every panel with it as `entityId`. */
  entityId?: string
}

export const COMPANY_AGREEMENTS_LIMIT = 20

/** The company's agreements, what needs someone first; none when the read fails. */
export async function loadCompanyAgreements(companyId: string): Promise<AgreementBrief[]> {
  const out = await app
    .invokeTool<{ items?: AgreementBrief[] }>("agreements_search", {
      company_id: companyId,
      limit: COMPANY_AGREEMENTS_LIMIT,
    })
    .catch(() => null)
  return Array.isArray(out?.items) ? out.items : []
}

export const CompanyAgreementsPanel: Component<CompanyAgreementsPanelProps> = (props) => {
  const [rows] = createResource(() => props.entityId || undefined, loadCompanyAgreements)
  return (
    <section data-testid="company-agreements-panel" class="flex flex-col gap-1 text-[12.5px]">
      <Show
        when={(rows()?.length ?? 0) > 0}
        fallback={
          <div data-testid="company-agreements-panel-empty" class="text-text-tertiary">
            {tr("No agreements with this company yet.")}
          </div>
        }
      >
        <ul class="flex flex-col">
          <For each={rows() ?? []}>
            {(r) => (
              <li>
                <a
                  href={paths.agreement(r.id)}
                  data-testid={`company-agreements-row-${r.id}`}
                  class="flex min-h-11 flex-wrap items-center gap-x-2 py-1 hover:bg-surface-hover md:min-h-0"
                  onClick={(e) => {
                    e.preventDefault()
                    go(paths.agreement(r.id))
                  }}
                >
                  <span class="font-mono text-text-tertiary">{r.number}</span>
                  <span class="min-w-0 break-words text-text">{r.title}</span>
                  <StatusBadge status={r.status} kind={r.kind} />
                </a>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  )
}
