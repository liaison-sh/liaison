// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The agreements a project or a deal holds, on its own page. ProjectAgreementsPanel sits in the
// project page's panels (`slots["project:detail:panel"]`) and links each agreement, its company
// and its quote; DealAgreementsCount sits in a task's actions (`slots["project:task:actions"]`)
// and says how many agreements name the deal, or nothing when none does. Both read as the viewer
// (`activity_read`, then each agreement): the kernel shows them only to a reader of agreements,
// and the reads return only the agreements they may see. Drafts are not listed.

import { type Component, createResource, For, Show } from "solid-js"
import { linkedTargets } from "./Detail"
import { call, go, paths } from "./host"
import { tr } from "./i18n"
import { StatusBadge } from "./List"
import type { AgreementDetail } from "./model"

export const RECORD_AGREEMENTS_LIMIT = 10

export interface RecordAgreement {
  id: string
  number: string
  title: string
  status: string
  kind: string | null
  path: string
  /** Where else it leads, the page it sits on left out. */
  links: Array<{ key: string; id: string; path: string }>
}

const LINKED_LABEL: Record<string, string> = {
  company: "Company",
  contact: "Contact",
  deal: "Deal",
  project: "Project",
  quote: "Quote",
}

/** The agreements naming a deal or a project, the newest first; none when the read fails. */
export async function loadRecordAgreements(
  record: { dealId: string } | { projectId: string },
): Promise<{ count: number; rows: RecordAgreement[] }> {
  const params =
    "dealId" in record ? { dealIds: [record.dealId] } : { projectIds: [record.projectId] }
  const listed = await call<{ rows?: Array<{ id?: unknown }> }>("activity_read", {
    ...params,
    limit: RECORD_AGREEMENTS_LIMIT,
  })
  if (!listed.ok || !Array.isArray(listed.data?.rows)) return { count: 0, rows: [] }
  const ids = listed.data.rows.map((r) => r.id).filter((id): id is string => typeof id === "string")
  const self = "dealId" in record ? record.dealId : record.projectId
  const read = await Promise.all(
    ids.map(async (id) => {
      const out = await call<AgreementDetail>("agreement_get", { id })
      if (!out.ok || !out.data?.agreement) return null
      const a = out.data.agreement
      return {
        id: a.id,
        number: a.number,
        title: a.title,
        status: a.status,
        kind: (a as { kind?: string | null }).kind ?? null,
        path: paths.agreement(a.id),
        links: linkedTargets(a).filter(
          (t) => t.id !== self && (t.key === "company" || t.key === "quote"),
        ),
      } satisfies RecordAgreement
    }),
  )
  const rows = read.filter((r): r is RecordAgreement => r !== null)
  return { count: rows.length, rows }
}

function open(e: MouseEvent, path: string) {
  e.preventDefault()
  go(path)
}

export const ProjectAgreementsPanel: Component<{ entityId?: string }> = (props) => {
  const [data] = createResource(
    () => props.entityId || undefined,
    (projectId) => loadRecordAgreements({ projectId }),
  )
  return (
    <Show when={(data()?.count ?? 0) > 0}>
      <section data-testid="project-agreements-panel" class="flex flex-col gap-1 text-[12.5px]">
        <h2 class="text-[12px] font-medium text-text-secondary">{tr("Agreements")}</h2>
        <ul class="flex flex-col">
          <For each={data()?.rows ?? []}>
            {(r) => (
              <li class="flex min-h-11 flex-wrap items-center gap-x-3 py-1 md:min-h-0">
                <a
                  href={r.path}
                  data-testid={`project-agreements-row-${r.id}`}
                  class="flex items-center gap-2 hover:underline"
                  onClick={(e) => open(e, r.path)}
                >
                  <span class="font-mono text-text-tertiary">{r.number}</span>
                  <span class="min-w-0 break-words text-text">{r.title}</span>
                </a>
                <StatusBadge status={r.status} kind={r.kind ?? undefined} />
                <For each={r.links}>
                  {(l) => (
                    <a
                      href={l.path}
                      data-testid={`project-agreements-row-${r.id}-${l.key}`}
                      class="text-text-tertiary underline-offset-2 hover:underline"
                      onClick={(e) => open(e, l.path)}
                    >
                      {tr(LINKED_LABEL[l.key] ?? "Open")}
                    </a>
                  )}
                </For>
              </li>
            )}
          </For>
        </ul>
      </section>
    </Show>
  )
}

export const DealAgreementsCount: Component<{ entityId?: string }> = (props) => {
  const [data] = createResource(
    () => props.entityId || undefined,
    (dealId) => loadRecordAgreements({ dealId }),
  )
  const first = () => data()?.rows[0]
  return (
    <Show when={first()}>
      {(row) => (
        <a
          href={(data()?.count ?? 0) === 1 ? row().path : paths.home()}
          data-testid="deal-agreements-count"
          class="text-[12px] text-text-secondary underline-offset-2 hover:underline"
          onClick={(e) => open(e, (data()?.count ?? 0) === 1 ? row().path : paths.home())}
        >
          {(data()?.count ?? 0) === 1
            ? tr("1 agreement")
            : tr("{{n}} agreements", { n: data()?.count ?? 0 })}
        </a>
      )}
    </Show>
  )
}
