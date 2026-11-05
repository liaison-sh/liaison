// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Rich rendering of a skill create/update inside the approval card, so a
 * reviewer can actually see what they are approving:
 *   - create_skill: the complete skill (name, visibility, description, full body).
 *   - update_skill: a git-style line diff of the body (red removed, green added),
 *     plus before -> after for name / description / required scopes.
 *
 * The proposed values come from the approval payload (the exact tool args). For
 * an update the CURRENT skill is fetched live (GET /agent/skills) so the diff is
 * against what is deployed at decision time. If the current version can't be
 * loaded, the new body renders as all-added with a note, never a blank card.
 */

import { type Component, createMemo, createResource, For, Match, Show, Switch } from "solid-js"
import type { ApiClient } from "~/lib/api-client"
import { type DiffRow, diffStats, lineDiff, withCollapsedContext } from "~/lib/line-diff"
import { useI18n } from "~/modules/i18n/i18n-context"

interface SkillRow {
  id: string
  name: string
  description: string
  body: string
  source: string
  requiredScopes?: string[]
  domain?: string | null
}

interface Props {
  api: ApiClient | undefined
  kind: "create" | "update"
  payload: Record<string, unknown>
}

const asStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)
const asScopes = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : undefined

/** Scrollable, monospace body block used for the full-skill (create) view. */
const BodyBlock: Component<{ text: string; testid: string }> = (props) => (
  <pre
    data-testid={props.testid}
    class="mt-1 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-bg-subtle p-2 font-mono text-[11px] leading-snug text-text-secondary"
  >
    {props.text}
  </pre>
)

const SectionLabel: Component<{ children: string }> = (props) => (
  <div class="text-[11px] uppercase tracking-wide text-text-tertiary">{props.children}</div>
)

/** One before -> after row for a scalar field (name, description). */
const FieldChange: Component<{ label: string; before?: string; after: string }> = (props) => (
  <div class="mt-2" data-testid={`skill-approval-change-${props.label.toLowerCase()}`}>
    <SectionLabel>{props.label}</SectionLabel>
    <div class="mt-0.5 flex flex-wrap items-center gap-1.5 text-text-secondary">
      <Show when={props.before !== undefined && props.before !== props.after}>
        <span class="rounded bg-danger/10 px-1.5 py-0.5 text-danger line-through">
          {props.before}
        </span>
        <span class="text-text-tertiary">→</span>
      </Show>
      <span class="rounded bg-success/10 px-1.5 py-0.5 text-success">{props.after}</span>
    </div>
  </div>
)

/** One rendered diff row: added/removed/context line, or a collapsed gap. */
const DiffRowView: Component<{ row: DiffRow }> = (props) => (
  <Switch>
    <Match when={props.row.type === "gap"}>
      <div class="bg-bg px-2 py-0.5 text-center text-text-tertiary">
        {useI18n().t("kernel.approvalsUi.unchangedLines", {
          count: (props.row as { count: number }).count,
        })}
      </div>
    </Match>
    <Match when={props.row.type === "add"}>
      <div class="flex bg-success/10 text-success">
        <span class="w-4 shrink-0 select-none text-center">+</span>
        <span class="whitespace-pre-wrap break-words">{(props.row as { text: string }).text}</span>
      </div>
    </Match>
    <Match when={props.row.type === "del"}>
      <div class="flex bg-danger/10 text-danger">
        <span class="w-4 shrink-0 select-none text-center">-</span>
        <span class="whitespace-pre-wrap break-words">{(props.row as { text: string }).text}</span>
      </div>
    </Match>
    <Match when={props.row.type === "same"}>
      <div class="flex text-text-tertiary">
        <span class="w-4 shrink-0 select-none text-center"> </span>
        <span class="whitespace-pre-wrap break-words">{(props.row as { text: string }).text}</span>
      </div>
    </Match>
  </Switch>
)

const SkillApprovalView: Component<Props> = (props) => {
  const i18n = useI18n()
  const newName = () => asStr(props.payload.name)
  const newDescription = () => asStr(props.payload.description)
  const newBody = () => asStr(props.payload.body)
  const newScopes = () => asScopes(props.payload.requiredScopes)
  const visibility = () =>
    asStr(props.payload.visibility) === "org"
      ? i18n.t("kernel.approvalsUi.orgShared")
      : i18n.t("kernel.approvalsUi.personal")
  const newDomain = () => asStr(props.payload.domain)
  const skillId = () => asStr(props.payload.id)

  // Current skill (update only) — fetched so the diff is against the deployed body.
  const [current] = createResource(
    () => (props.kind === "update" && props.api ? (skillId() ?? null) : null),
    async (id): Promise<SkillRow | null> => {
      const api = props.api
      if (!api) return null
      const rows = (await api.get<SkillRow[]>("/agent/skills")) ?? []
      return rows.find((s) => s.id === id) ?? null
    },
  )

  // Never read the resource value while it is pending: an unguarded read
  // suspends the nearest ancestor Suspense boundary (the app root), which
  // flashes the entire window every time a skill approval card mounts.
  const deployed = () => (current.state === "ready" ? current() : undefined)

  const diff = createMemo(() => lineDiff(deployed()?.body ?? "", newBody() ?? ""))
  const stats = createMemo(() => diffStats(diff()))
  const rows = createMemo<DiffRow[]>(() => withCollapsedContext(diff()))

  const scopesChanged = () => {
    const next = newScopes()
    if (next === undefined) return false
    const prev = deployed()?.requiredScopes ?? []
    return JSON.stringify([...prev].sort()) !== JSON.stringify([...next].sort())
  }

  // A proposal that matches the deployed skill exactly (agent sent a no-op
  // update, or the same change was already applied). Rendering a wall of
  // "unchanged lines" with +0 -0 reads as a broken diff; say it outright.
  const isNoOpUpdate = () => {
    if (props.kind !== "update" || current.loading || !deployed()) return false
    const bodySame = newBody() === undefined || newBody() === deployed()?.body
    const nameSame = newName() === undefined || newName() === deployed()?.name
    const descSame = newDescription() === undefined || newDescription() === deployed()?.description
    return bodySame && nameSame && descSame && !scopesChanged()
  }

  return (
    <div class="mt-2" data-testid={`skill-approval-${props.kind}`}>
      <Switch>
        {/* ---- CREATE: the complete skill ---- */}
        <Match when={props.kind === "create"}>
          <div class="flex items-center gap-2">
            <span class="font-medium text-text" data-testid="skill-approval-name">
              {newName() ?? i18n.t("kernel.approvalsUi.unnamedSkill")}
            </span>
            <span class="rounded bg-bg-subtle px-2 py-0.5 text-[11px] text-text-secondary">
              {visibility()}
            </span>
          </div>
          <Show when={newDescription()}>
            <p class="mt-0.5 text-text-secondary">{newDescription()}</p>
          </Show>
          <Show when={newDomain()}>
            <div class="mt-1 text-[11px] text-text-tertiary" data-testid="skill-approval-domain">
              {i18n.t("kernel.approvalsUi.domain2")} {newDomain()}
            </div>
          </Show>
          <Show when={newScopes()?.length}>
            <div class="mt-1 text-[11px] text-text-tertiary">
              {i18n.t("kernel.approvalsUi.requiredScopes")} {(newScopes() ?? []).join(", ")}
            </div>
          </Show>
          <Show when={newBody() !== undefined}>
            <div class="mt-2">
              <SectionLabel>{i18n.t("kernel.approvalsUi.skillBody")}</SectionLabel>
              <BodyBlock text={newBody() ?? ""} testid="skill-approval-body" />
            </div>
          </Show>
        </Match>

        {/* ---- UPDATE: field changes + body diff ---- */}
        <Match when={props.kind === "update"}>
          <div class="flex items-center gap-2">
            <span class="font-medium text-text" data-testid="skill-approval-name">
              {deployed()?.name ?? newName() ?? skillId() ?? "skill"}
            </span>
          </div>

          <Show when={newName() !== undefined && newName() !== deployed()?.name}>
            <FieldChange
              label={i18n.t("kernel.common.name")}
              before={deployed()?.name}
              after={newName() ?? ""}
            />
          </Show>
          <Show
            when={newDescription() !== undefined && newDescription() !== deployed()?.description}
          >
            <FieldChange
              label={i18n.t("kernel.common.description")}
              before={deployed()?.description}
              after={newDescription() ?? ""}
            />
          </Show>
          <Show when={scopesChanged()}>
            <FieldChange
              label={i18n.t("kernel.approvalsUi.scopes")}
              before={(deployed()?.requiredScopes ?? []).join(", ") || "(none)"}
              after={(newScopes() ?? []).join(", ") || "(none)"}
            />
          </Show>
          <Show
            when={newDomain() !== undefined && newDomain() !== (deployed()?.domain ?? undefined)}
          >
            <FieldChange
              label={i18n.t("kernel.approvalsUi.domain")}
              before={deployed()?.domain ?? "(none)"}
              after={newDomain() ?? ""}
            />
          </Show>

          <Show when={isNoOpUpdate()}>
            <div
              class="mt-2 rounded border border-border bg-bg-subtle px-2 py-1.5 text-[12px] text-text-secondary"
              data-testid="skill-approval-noop"
            >
              {i18n.t("kernel.approvalsUi.thisProposalIsIdenticalToThe")}
            </div>
          </Show>

          <Show when={newBody() !== undefined && !isNoOpUpdate()}>
            <div class="mt-2">
              <div class="flex items-center gap-2">
                <SectionLabel>{i18n.t("kernel.approvalsUi.bodyChanges")}</SectionLabel>
                <Show
                  when={!current.loading}
                  fallback={
                    <span class="text-[11px] text-text-tertiary">
                      {i18n.t("kernel.approvalsUi.loadingCurrentVersion")}
                    </span>
                  }
                >
                  <span class="text-[11px] text-success" data-testid="skill-approval-added">
                    +{stats().added}
                  </span>
                  <span class="text-[11px] text-danger" data-testid="skill-approval-removed">
                    -{stats().removed}
                  </span>
                  <Show when={deployed() === null && !current.error}>
                    <span class="text-[11px] text-text-tertiary">
                      {i18n.t("kernel.approvalsUi.currentVersionUnavailableShowingNewContent")}
                    </span>
                  </Show>
                </Show>
              </div>
              <Show when={!current.loading}>
                <div
                  data-testid="skill-approval-diff"
                  class="mt-1 max-h-96 overflow-auto rounded border border-border bg-bg-subtle font-mono text-[11px] leading-snug"
                >
                  <For each={rows()}>{(row) => <DiffRowView row={row} />}</For>
                </div>
              </Show>
            </div>
          </Show>
        </Match>
      </Switch>
    </div>
  )
}

export default SkillApprovalView
