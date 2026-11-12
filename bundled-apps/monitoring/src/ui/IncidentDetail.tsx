// SPDX-License-Identifier: FSL-1.1-ALv2
//
// IncidentDetailPanel — one incident, full record. Reached from the attention
// feed (tab type `monitoring:incident`, URL /monitoring/incident/:id), from a
// dashboard row, or via the kernel's generic detail tab (views.detail →
// props.id). Header: severity + status + title; meta grid; the alert body as
// a mono block; the triage timeline; the Activity section (comments and the
// archived previous episodes, oldest first) with a comment box open in every
// status; ack/resolve actions with an optional resolution note. The route id
// is a UUID or an `INC-<n>` ref; once the row is fetched every call acts on
// its UUID.

import { app } from "@liaison/host"
import { type Component, createMemo, createResource, createSignal, For, Show } from "solid-js"
import type { CommentView } from "../comments"
import {
  activityAuthorLabel,
  commentErrorText,
  formatAge,
  formatStamp,
  isLongText,
  severityMeta,
  statusMeta,
} from "./format"
import { tr } from "./i18n"
import { Badge, Button, Card, cx, EmptyState, inputClass, PageHeader, SectionLabel } from "./kit"
import { loadMemberNames } from "./members"
import { RefTag } from "./ref-tag"
import { onMonitoringChange } from "./source-glyph"
import { isAutoResolved, safeHttpUrl } from "./sources"

export interface IncidentFull {
  id: string
  ref?: string | null
  source: string
  severity: string
  title: string
  body: string | null
  dedupKey: string | null
  url: string | null
  status: string
  count: number
  firstSeenAt: string | null
  lastSeenAt: string | null
  alertTs: string | null
  acknowledgedAt: string | null
  resolvedAt: string | null
  resolvedBy?: string | null
  reopenedAt: string | null
  resolutionNote: string | null
  comments?: CommentView[]
  commentsTruncated?: boolean
}

const Meta: Component<{ label: string; children: unknown }> = (props) => (
  <div class="flex flex-col gap-1">
    <span class="text-[10.5px] font-medium uppercase tracking-wider text-text-tertiary">
      {props.label}
    </span>
    <span class="text-[12.5px] text-text">{props.children as never}</span>
  </div>
)

/** The header line of an Activity entry: who or what on the left, when on the right. */
const EntryHeader: Component<{ label: unknown; at: string | null }> = (props) => (
  <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
    {props.label as never}
    <span class="font-mono text-[11.5px] tabular-nums text-text-tertiary">
      {formatStamp(props.at)}
    </span>
  </div>
)

/** A comment: author, time, text (rendered as a text node, never as HTML). */
const CommentEntry: Component<{ entry: CommentView; names: Map<string, string> | undefined }> = (
  props,
) => (
  <Card
    class="flex min-w-0 flex-col gap-1.5 px-4 py-3"
    testid={`monitoring-activity-comment-${props.entry.id}`}
  >
    <EntryHeader
      label={
        <span class="min-w-0 break-words text-[12px] font-medium text-text">
          {activityAuthorLabel(props.entry.authorId, props.names)}
        </span>
      }
      at={props.entry.createdAt}
    />
    <div class="whitespace-pre-wrap break-words text-[12.5px] text-text-secondary">
      {props.entry.body}
    </div>
  </Card>
)

/** An archived previous episode: its title, alert detail (collapsed when long), resolution. */
const EpisodeEntry: Component<{ entry: CommentView }> = (props) => (
  <Card
    class="flex min-w-0 flex-col gap-1.5 border-dashed px-4 py-3"
    testid={`monitoring-activity-episode-${props.entry.id}`}
  >
    <EntryHeader
      label={
        <span class="text-[10.5px] font-medium uppercase tracking-wider text-text-tertiary">
          {tr("Previous episode")}
        </span>
      }
      at={props.entry.createdAt}
    />
    <div class="break-words text-[12.5px] text-text">{props.entry.episodeTitle}</div>
    <Show when={props.entry.body}>
      <details open={!isLongText(props.entry.body)} class="min-w-0">
        <summary class="cursor-pointer text-[11.5px] text-text-secondary">
          {tr("Alert detail")}
        </summary>
        <pre class="mt-1.5 max-h-72 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-text-secondary">
          {props.entry.body}
        </pre>
      </details>
    </Show>
    <Show when={props.entry.episodeResolutionNote}>
      <div class="break-words text-[12px] text-text-secondary">
        <span class="text-text-tertiary">{tr("Resolution note")}</span>{" "}
        {props.entry.episodeResolutionNote}
      </div>
    </Show>
    <Show when={props.entry.episodeResolvedAt}>
      <div class="text-[12px] text-text-secondary">
        <span class="text-text-tertiary">{tr("Resolved")}</span>{" "}
        <span class="font-mono text-[11.5px] tabular-nums">
          {formatStamp(props.entry.episodeResolvedAt)}
        </span>
      </div>
    </Show>
  </Card>
)

export const IncidentDetailPanel: Component<{ entityId?: string; id?: string }> = (props) => {
  const incidentId = () => props.entityId ?? props.id ?? ""
  const [note, setNote] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [commentText, setCommentText] = createSignal("")
  const [commentBusy, setCommentBusy] = createSignal(false)
  const [commentError, setCommentError] = createSignal<string | null>(null)

  // Plain Solid createResource keyed on the incident id (see Dashboard note on
  // why the host resource factory is avoided).
  const [incident, actions] = createResource(
    () => incidentId() || null,
    async (id): Promise<IncidentFull | undefined> => {
      const res = await app.invokeTool<{ data: IncidentFull }>("incidents_get", { incidentId: id })
      return res?.data
    },
  )

  // Follow the incident live (re-fired, acked or resolved elsewhere).
  onMonitoringChange(() => void actions.refetch())

  // Every triage and comment call acts on the fetched row's UUID, so a route
  // opened by ref (/monitoring/incident/INC-142) acts on the incident it shows.
  const currentId = () => incident()?.id ?? incidentId()

  // Comment authors are user ids: load display names when there are any, and
  // again when a refetch brings an author the last load did not cover.
  const authorKey = () =>
    [...new Set((incident()?.comments ?? []).flatMap((c) => (c.authorId ? [c.authorId] : [])))]
      .sort()
      .join(",") || null
  const [names] = createResource(authorKey, loadMemberNames)

  const triage = async (tool: "incidents_ack" | "incidents_resolve") => {
    setBusy(true)
    setError(null)
    try {
      const params: Record<string, unknown> = { incidentId: currentId() }
      if (tool === "incidents_resolve" && note().trim()) params.resolutionNote = note().trim()
      await app.invokeTool(tool, params)
      setNote("")
      actions.refetch()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const addComment = async () => {
    const body = commentText().trim()
    if (!body) return
    setCommentBusy(true)
    setCommentError(null)
    try {
      await app.invokeTool("incidents_comment", { incidentId: currentId(), body })
      setCommentText("")
      actions.refetch()
    } catch (err) {
      setCommentError(commentErrorText(err instanceof Error ? err.message : String(err)))
    } finally {
      setCommentBusy(false)
    }
  }

  const timeline = createMemo(() => {
    const inc = incident()
    if (!inc) return []
    const entries: Array<{ label: string; at: string | null }> = [
      { label: tr("First seen"), at: inc.firstSeenAt },
      { label: tr("Last seen"), at: inc.lastSeenAt },
    ]
    if (inc.reopenedAt) entries.push({ label: tr("Reopened"), at: inc.reopenedAt })
    if (inc.acknowledgedAt) entries.push({ label: tr("Acknowledged"), at: inc.acknowledgedAt })
    if (inc.resolvedAt) {
      entries.push({
        label: isAutoResolved(inc) ? tr("Resolved automatically") : tr("Resolved"),
        at: inc.resolvedAt,
      })
    }
    return entries
  })

  return (
    <div class="flex h-full flex-col overflow-hidden" data-testid="monitoring-incident-detail">
      <Show
        when={incident()}
        fallback={
          <EmptyState title={tr("Incident")} testid="monitoring-incident-loading">
            {incidentId() ? tr("Loading incident…") : tr("No incident id.")}
          </EmptyState>
        }
      >
        {(inc) => {
          const sev = () => severityMeta(inc().severity)
          const st = () => statusMeta(inc().status)
          return (
            <>
              <PageHeader
                title={inc().title}
                testid="monitoring-incident-header"
                actions={
                  <Show when={inc().status !== "resolved"}>
                    <span class="inline-flex items-center gap-2">
                      <Show when={inc().status === "open"}>
                        <Button
                          variant="secondary"
                          testid="monitoring-detail-ack"
                          disabled={busy()}
                          onClick={() => void triage("incidents_ack")}
                        >
                          {tr("Acknowledge")}
                        </Button>
                      </Show>
                      <Button
                        variant="primary"
                        testid="monitoring-detail-resolve"
                        disabled={busy()}
                        onClick={() => void triage("incidents_resolve")}
                      >
                        {tr("Resolve")}
                      </Button>
                    </span>
                  </Show>
                }
              />
              <div class="flex-1 overflow-y-auto">
                <div class="mx-auto flex max-w-3xl flex-col gap-5 px-5 py-5">
                  <div class="flex flex-wrap items-center gap-2">
                    <RefTag value={inc().ref} testid="monitoring-detail-ref" prominent />
                    <Badge tone={sev().tone} dot testid="monitoring-detail-severity">
                      {sev().label}
                    </Badge>
                    <Badge tone={st().tone} testid="monitoring-detail-status">
                      {st().label}
                    </Badge>
                    <Show when={isAutoResolved(inc())}>
                      <Badge tone="success" testid="monitoring-detail-auto-resolved">
                        {tr("Resolved automatically")}
                      </Badge>
                    </Show>
                    <span class="font-mono text-[11.5px] text-text-tertiary">{inc().source}</span>
                  </div>

                  <Show when={error()}>
                    <Card class="border-error-border bg-error-glow px-3.5 py-2.5 text-[12px] text-error">
                      {error()}
                    </Card>
                  </Show>

                  <Card class="px-4 py-3.5">
                    <div class="grid grid-cols-3 gap-x-6 gap-y-4">
                      <Meta label={tr("Fired")}>{`${inc().count}×`}</Meta>
                      <Meta label={tr("Last seen")}>{formatAge(inc().lastSeenAt, Date.now())}</Meta>
                      <Meta label={tr("Alert time")}>{formatStamp(inc().alertTs)}</Meta>
                    </div>
                    {/* Log-signature alerts carry the WHOLE normalized error signature as
                        their dedup key — render it as one truncated full-width line (full
                        value on hover), never a grid cell that balloons the card. */}
                    <Show when={inc().dedupKey}>
                      <div class="mt-4 flex min-w-0 items-baseline gap-3 border-t border-border-subtle pt-3">
                        <span class="shrink-0 text-[10.5px] font-medium uppercase tracking-wider text-text-tertiary">
                          {tr("Dedup key")}
                        </span>
                        <span
                          class="min-w-0 flex-1 truncate font-mono text-[11.5px] text-text-secondary"
                          title={inc().dedupKey ?? undefined}
                        >
                          {inc().dedupKey}
                        </span>
                      </div>
                    </Show>
                  </Card>

                  <Show when={inc().body}>
                    <section class="flex flex-col gap-2">
                      <SectionLabel>{tr("Alert detail")}</SectionLabel>
                      <Card class="max-h-72 overflow-y-auto px-4 py-3">
                        <pre class="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-text-secondary">
                          {inc().body}
                        </pre>
                      </Card>
                    </section>
                  </Show>

                  {/* A link only for http(s); any other value is shown as plain text,
                      never as a clickable href (javascript:, data:, …). */}
                  <Show when={inc().url}>
                    <Show
                      when={safeHttpUrl(inc().url)}
                      fallback={
                        <span
                          class="break-all font-mono text-[11.5px] text-text-tertiary"
                          data-testid="monitoring-detail-source-url-text"
                        >
                          {inc().url}
                        </span>
                      }
                    >
                      {(href) => (
                        <a
                          href={href()}
                          target="_blank"
                          rel="noreferrer noopener"
                          class="text-[12px] text-accent hover:underline"
                          data-testid="monitoring-detail-source-link"
                        >
                          {tr("Open in source system ↗")}
                        </a>
                      )}
                    </Show>
                  </Show>

                  <section class="flex flex-col gap-2">
                    <SectionLabel>{tr("Timeline")}</SectionLabel>
                    <Card class="flex flex-col px-4 py-2">
                      <For each={timeline()}>
                        {(entry) => (
                          <div class="flex items-center justify-between border-b border-border-subtle py-2 last:border-b-0">
                            <span class="text-[12px] text-text-secondary">{entry.label}</span>
                            <span class="font-mono text-[11.5px] tabular-nums text-text-tertiary">
                              {formatStamp(entry.at)}
                            </span>
                          </div>
                        )}
                      </For>
                    </Card>
                  </section>

                  <Show when={inc().resolutionNote}>
                    <section class="flex flex-col gap-2">
                      <SectionLabel>{tr("Resolution note")}</SectionLabel>
                      <Card class="px-4 py-3 text-[12.5px] text-text-secondary">
                        {inc().resolutionNote}
                      </Card>
                    </section>
                  </Show>

                  <section class="flex flex-col gap-2" data-testid="monitoring-activity">
                    <SectionLabel>{tr("Activity")}</SectionLabel>
                    <Show when={inc().commentsTruncated}>
                      <span
                        class="text-[11.5px] text-text-tertiary"
                        data-testid="monitoring-activity-truncated"
                      >
                        {tr("Older activity not shown")}
                      </span>
                    </Show>
                    <Show
                      when={(inc().comments ?? []).length > 0}
                      fallback={
                        <span class="text-[12px] text-text-tertiary">{tr("No activity yet.")}</span>
                      }
                    >
                      <div class="flex flex-col gap-2">
                        <For each={inc().comments ?? []}>
                          {(c) => (
                            <Show
                              when={c.kind === "episode"}
                              fallback={<CommentEntry entry={c} names={names.latest} />}
                            >
                              <EpisodeEntry entry={c} />
                            </Show>
                          )}
                        </For>
                      </div>
                    </Show>

                    <Show when={commentError()}>
                      <Card class="border-error-border bg-error-glow px-3.5 py-2.5 text-[12px] text-error">
                        {commentError()}
                      </Card>
                    </Show>
                    <textarea
                      class={cx(inputClass, "min-h-[64px] w-full resize-y")}
                      placeholder={tr("Add context for the team: vendor ticket, next step…")}
                      value={commentText()}
                      data-testid="monitoring-detail-comment"
                      onInput={(e) => setCommentText(e.currentTarget.value)}
                    />
                    <div class="flex justify-end">
                      <Button
                        variant="secondary"
                        testid="monitoring-detail-comment-submit"
                        disabled={commentBusy() || !commentText().trim()}
                        onClick={() => void addComment()}
                      >
                        {tr("Add comment")}
                      </Button>
                    </div>
                  </section>

                  <Show when={inc().status !== "resolved"}>
                    <section class="flex flex-col gap-2">
                      <SectionLabel>{tr("Resolve with a note")}</SectionLabel>
                      <textarea
                        class={cx(inputClass, "min-h-[64px] resize-y")}
                        placeholder={tr("What fixed it? Future triage reads this.")}
                        value={note()}
                        data-testid="monitoring-detail-note"
                        onInput={(e) => setNote(e.currentTarget.value)}
                      />
                    </section>
                  </Show>
                </div>
              </div>
            </>
          )
        }}
      </Show>
    </div>
  )
}
