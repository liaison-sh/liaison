// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Findings — the "recent comments across our posts/videos" stream: master/
// detail over social findings. The left pane is a dense list (platform badge +
// author handle + fence-stripped comment text + relative time + a subdued
// "on: <post>" line when the finding carries `metadata.postExcerpt`); the
// right pane is the detail panel, which shows author/platform/time, the full
// comment text, the "under post" context, an "Open at source ↗" permalink
// link, AND the agent's drafted reply (editable) — wiring the real gated
// tools: Approve & post → reply_to_finding, Reject → dismiss_finding, Like →
// like_item. The [Like] action is greyed when the platform/relation is
// unsupported (own-Page FB / own-media IG comments only).
import { type Component, createMemo, createSignal, For, onMount, Show } from "solid-js"
import { app, fetch as hostFetch } from "@liaison/host"
import { createMediaMatch } from "@liaison/app-ui/card-table"
import {
  Badge,
  type BadgeTone,
  Button,
  cx,
  EmptyState,
  inputClass,
  PageHeader,
  SectionLabel,
  stripExternalFence,
} from "./kit"
import { denyPendingApproval, type PendingDenyOutcome, rejectNote } from "./pending-approval"

export type Platform = "facebook" | "instagram" | "youtube"

export interface FindingRow {
  id: string
  platform: Platform
  relation: string
  status: string
  author_handle?: string | null
  content_text?: string | null
  permalink?: string | null
  occurred_at?: string | null
  triage_category?: string | null
  urgency?: number | null
  should_reply?: boolean | null
  /** The agent's drafted reply, awaiting human approval (schema: suggested_reply). */
  suggested_reply?: string | null
  /** True when the source comment changed after the reply was drafted. */
  edited_after_reply?: boolean | null
  /** The agent's request waiting in the approvals inbox, while status is awaiting_approval. */
  approval_request_id?: string | null
  /** What that request does: post the drafted reply, or like the item. */
  pending_action?: "reply" | "like" | null
  /** Carries adapter-supplied context — Facebook/Instagram set `postExcerpt`
   *  (first ~80 chars of the parent post's caption) and `postPermalink` so the
   *  UI can show "under which post" a comment landed. */
  metadata?: Record<string, unknown> | null
}

// ── Pure helpers (unit-tested) ──────────────────────────────────────────────

/** Platform badge label — short, uppercase-first, no platform-specific icon set
 *  exists in icon.tsx (only the app-level SocialAppIcon), so a tinted text
 *  badge carries the platform. */
export function platformLabel(platform: Platform): string {
  switch (platform) {
    case "facebook":
      return "Facebook"
    case "instagram":
      return "Instagram"
    default:
      return "YouTube"
  }
}

/** Author display fallback: Facebook's Graph API withholds commenter identity
 *  for users not connected to the Page (privacy), so `author_handle` is often
 *  null on real comments — "Facebook user" reads as the platform fact it is,
 *  where "unknown" read as a bug. */
export function authorLabel(platform: Platform, handle: string | null | undefined): string {
  return handle && handle.length > 0 ? handle : `${platformLabel(platform)} user`
}

/** `keyword_match` findings are a VIDEO that matched a monitor term — NOT a
 *  comment. Rendering them with the comment "From <author>" chrome reads as a
 *  bug report ("who commented?") when nobody did; a distinct presentation
 *  keeps the list/detail honest about what was actually found. */
export function isVideoMatch(relation: string): boolean {
  return relation === "keyword_match"
}

/** The matched monitor-term ids on a keyword_match finding (adapter-populated
 *  `metadata.matchedTerms`), used by the detail panel's "matched your monitor
 *  terms" explanation. Empty when absent/malformed. */
export function matchedTermsOf(f: Pick<FindingRow, "metadata"> | null | undefined): string[] {
  const v = f?.metadata?.matchedTerms
  return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : []
}

/** The finding's "on: <post>" context line, when the adapter supplied one. */
export function postExcerptOf(f: Pick<FindingRow, "metadata"> | null | undefined): string | null {
  const v = f?.metadata?.postExcerpt
  return typeof v === "string" && v.length > 0 ? v : null
}

/** Compact relative/short time for a list row (falls back to the raw date). */
export function shortTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return ""
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ""
  const deltaMs = now.getTime() - t
  const min = Math.floor(deltaMs / 60_000)
  if (min < 1) return "now"
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d`
  return new Date(t).toISOString().slice(0, 10)
}

/** Like is supported only for own-Page FB comments and own-media IG comments. */
export function likeDisabled(platform: Platform, relation: string): boolean {
  if (relation !== "comment_on_our_content") return true
  return !(platform === "facebook" || platform === "instagram")
}

/** Map a finding lifecycle status to a badge tone + label. */
export function findingStatusTone(status: string): { tone: BadgeTone; label: string } {
  switch (status) {
    case "awaiting_approval":
      return { tone: "warning", label: "Awaiting approval" }
    case "handled":
      return { tone: "success", label: "Handled" }
    case "dismissed":
      return { tone: "neutral", label: "Dismissed" }
    case "drafted":
      return { tone: "accent", label: "Drafted" }
    case "triaged":
      return { tone: "accent", label: "Triaged" }
    default:
      return { tone: "accent", label: "New" }
  }
}

/** Default selection = first row, or null when empty (shows empty state). */
export function resolveSelectedId(explicit: string | null, rows: FindingRow[]): string | null {
  if (explicit && rows.some((r) => r.id === explicit)) return explicit
  return rows[0]?.id ?? null
}

/**
 * Whether the reply composer + approve/reject surface should show for a finding.
 * ANY finding that isn't already handled/dismissed/failed is repliable — a
 * human must be able to comment directly without waiting for agent triage to
 * flag it (the send still goes through the gated reply_to_finding tool, which
 * posts a comment reply — or a top-level video comment for keyword_match).
 * The agent's draft (suggested_reply), when present, still seeds the composer.
 */
export function canReply(
  f: Pick<FindingRow, "status" | "suggested_reply" | "should_reply"> | null | undefined,
): boolean {
  if (!f) return false
  return !(f.status === "handled" || f.status === "dismissed" || f.status === "failed")
}

/** Whether a gated action parked for approval instead of running: the REST
 *  envelope then carries `blocked`. A person holding the tool's own scope runs
 *  it at once; only an org two-approver policy parks their click. */
export function isParked(res: unknown): boolean {
  return Boolean(res !== null && typeof res === "object" && (res as { blocked?: unknown }).blocked)
}

/**
 * What a gated action's result tells the person who clicked it: done, or parked
 * for approval. Saying "submitted for approval" for a reply that was already
 * posted read as if every click landed in the approvals list.
 */
export function gatedResultNote(res: unknown, done: string, parked: string): string {
  return isParked(res) ? parked : done
}

// ── Detail body (mounted per finding) ────────────────────────────────────────
// Receives a finding id (and an optional list-row seed for instant render). It
// fetches the full record via findings_get — the list row omits suggested_reply
// — surfaces the agent's drafted reply in an EDITABLE composer, and wires the
// real gated tools. The kernel/Findings remounts this when the id changes, so
// the composer seeds from the draft on mount (the seed-in-loader idiom).
const FindingDetailBody: Component<{
  findingId: string
  seed: FindingRow | null
  onChanged?: () => void
}> = (props) => {
  const [full, setFull] = createSignal<FindingRow | null>(props.seed)
  const [reply, setReply] = createSignal(props.seed?.suggested_reply ?? "")
  const [busy, setBusy] = createSignal(false)
  const [note, setNote] = createSignal<{ kind: "ok" | "err"; text: string } | null>(null)

  const refresh = async () => {
    try {
      // findings_get's envelope is `{ finding: row | null }` (reads.ts) — NOT the
      // row directly.
      const res = await app.invokeTool<{ finding: FindingRow | null }>("findings_get", {
        finding_id: props.findingId,
      })
      const rec = res?.finding ?? null
      if (rec) setFull(rec)
      return rec
    } catch {
      return null
    }
  }

  onMount(async () => {
    const rec = await refresh()
    // Seed the composer from the agent's draft — only if the human hasn't typed.
    if (rec?.suggested_reply && !reply().trim()) setReply(rec.suggested_reply)
  })

  const meta = createMemo(() => findingStatusTone(full()?.status ?? "new"))
  const likeOff = createMemo(() => {
    const cur = full()
    return cur ? likeDisabled(cur.platform, cur.relation) : true
  })
  const showReply = createMemo(() => canReply(full()))

  const run = async (action: () => Promise<unknown>, ok: string | ((res: unknown) => string)) => {
    if (busy()) return
    setBusy(true)
    setNote(null)
    try {
      const res = await action()
      await refresh()
      setNote({ kind: "ok", text: typeof ok === "function" ? ok(res) : ok })
      props.onChanged?.()
    } catch (e) {
      setNote({ kind: "err", text: e instanceof Error ? e.message : "Action failed" })
    } finally {
      setBusy(false)
    }
  }

  // The agent's request on this finding, as the finding was last read.
  const pendingApproval = () => {
    const cur = full()
    return cur?.status === "awaiting_approval" && cur.approval_request_id
      ? { id: cur.approval_request_id, action: cur.pending_action ?? null }
      : null
  }

  const approve = () => {
    const text = reply().trim()
    if (!text) return
    const pending = pendingApproval()
    void run(
      async () => {
        const res = await app.invokeTool("reply_to_finding", { finding_id: props.findingId, reply_text: text })
        // Posted directly: the agent's drafted reply is superseded, so it can't be approved later.
        if (pending?.action === "reply" && !isParked(res)) {
          await denyPendingApproval(hostFetch, pending.id, "Replied directly from the finding.").catch(() => null)
        }
        return res
      },
      (res) => gatedResultNote(res, "Reply posted.", "Reply submitted for approval."),
    )
  }
  const reject = () => {
    const pending = pendingApproval()
    let outcome: PendingDenyOutcome | null = null
    void run(
      async () => {
        if (pending) outcome = await denyPendingApproval(hostFetch, pending.id, "Rejected from the finding.")
        return app.invokeTool("dismiss_finding", { finding_id: props.findingId })
      },
      () => rejectNote(outcome),
    )
  }
  const like = () => {
    if (likeOff()) return
    void run(
      () => app.invokeTool("like_item", { finding_id: props.findingId }),
      (res) => gatedResultNote(res, "Liked.", "Like submitted for approval."),
    )
  }

  const isVideo = createMemo(() => isVideoMatch(full()?.relation ?? ""))

  return (
    <div data-testid="social-finding-detail" class="flex flex-col gap-3 p-4">
      <div class="flex items-center gap-2">
        <Badge tone={meta().tone} testid="social-finding-status">
          {meta().label}
        </Badge>
        <Badge tone="neutral">{platformLabel(full()?.platform ?? "facebook")}</Badge>
        <Show when={isVideo()}>
          <Badge tone="accent" testid="social-finding-video-badge">Video match</Badge>
        </Show>
        <span class="text-[11px] text-text-tertiary">{shortTime(full()?.occurred_at)}</span>
      </div>
      <Show
        when={isVideo()}
        fallback={
          <SectionLabel>From {authorLabel(full()?.platform ?? "facebook", full()?.author_handle)}</SectionLabel>
        }
      >
        <SectionLabel>{authorLabel(full()?.platform ?? "youtube", full()?.author_handle)}'s video</SectionLabel>
      </Show>
      <p class="text-[13px] text-text">{stripExternalFence(full()?.content_text) || "(no text)"}</p>
      <Show when={isVideo() && matchedTermsOf(full()).length > 0}>
        <p data-testid="social-finding-matched-terms" class="text-[11.5px] text-text-tertiary">
          Matched your monitor terms.
        </p>
      </Show>
      <Show when={postExcerptOf(full())} keyed>
        {(excerpt) => (
          <p data-testid="social-finding-post-context" class="text-[11.5px] text-text-tertiary">
            on: {excerpt}
          </p>
        )}
      </Show>
      <Show when={full()?.permalink} keyed>
        {(url) => (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            data-testid="social-finding-open-source"
            class="text-[11.5px] text-accent"
          >
            Open at source ↗
          </a>
        )}
      </Show>

      <Show when={showReply()}>
        <div class="flex flex-col gap-2 border-t border-border-subtle pt-3">
          <SectionLabel>{full()?.suggested_reply ? "Drafted reply" : "Reply"}</SectionLabel>
          <textarea
            data-testid="social-reply-text"
            class={cx(inputClass, "min-h-[76px] resize-y leading-snug")}
            placeholder="Write a reply…"
            value={reply()}
            onInput={(e) => setReply(e.currentTarget.value)}
            disabled={busy()}
          />
          <Show when={full()?.edited_after_reply}>
            <span class="text-[11px] text-warning">
              The original comment was edited after this reply was drafted: re-check before posting.
            </span>
          </Show>
          <div data-testid="social-approval-surface" class="flex items-center gap-2">
            <Button
              variant="primary"
              testid="social-approve"
              disabled={busy() || !reply().trim()}
              onClick={approve}
            >
              Approve &amp; post
            </Button>
            <Button variant="secondary" testid="social-reject" disabled={busy()} onClick={reject}>
              Reject
            </Button>
          </div>
        </div>
      </Show>

      <div class={cx("flex items-center gap-2", showReply() ? "" : "border-t border-border-subtle pt-3")}>
        <Button
          variant="ghost"
          testid="social-like"
          disabled={busy() || likeOff()}
          title={likeOff() ? "Like not supported for this item" : "Like"}
          onClick={like}
        >
          Like
        </Button>
      </div>

      <Show when={note()} keyed>
        {(n) => (
          <span
            data-testid="social-action-note"
            class={cx("text-[11.5px]", n.kind === "ok" ? "text-success" : "text-error")}
          >
            {n.text}
          </span>
        )}
      </Show>
    </div>
  )
}

// ── Detail panel (manifest `detail.finding` view + Findings child) ────────────
// Resolves the finding id from either the kernel detail mount (entityId) or the
// in-list selection (finding row), then remounts the body per id so it always
// reflects the selected finding.
export const FindingDetailPanel: Component<{
  finding?: FindingRow | null
  entityId?: string
  onChanged?: () => void
}> = (props) => {
  const id = createMemo(() => props.finding?.id ?? props.entityId ?? null)
  return (
    <Show
      when={id()}
      keyed
      fallback={<EmptyState title="No finding selected">Pick a finding from the list.</EmptyState>}
    >
      {(fid) => (
        <FindingDetailBody
          findingId={fid}
          seed={props.finding && props.finding.id === fid ? props.finding : null}
          onChanged={props.onChanged}
        />
      )}
    </Show>
  )
}

// ── Master/detail surface ─────────────────────────────────────────────────────
async function loadFindings(): Promise<FindingRow[]> {
  try {
    const res = await app.invokeTool<{ findings?: FindingRow[] }>("findings_list", {})
    return res?.findings ?? []
  } catch {
    return []
  }
}

/**
 * Phone width (spec-responsive.md). Findings is a master/detail split, and a
 * fixed 320 px list beside a detail pane leaves the detail 70 px at 390 px. On
 * a phone the two panes take turns: the list owns the viewport until a finding
 * is picked, the detail owns it afterwards. From md up both are visible, the
 * list at its own width, exactly as before.
 */
export function splitPaneClasses(hasSelection: boolean): { list: string; detail: string } {
  return hasSelection
    ? { list: "hidden md:flex md:w-80", detail: "flex" }
    : { list: "flex md:w-80", detail: "hidden md:flex" }
}

export const Findings: Component = () => {
  const [rows, { refetch }] = app.createResource(loadFindings)
  const [selected, setSelected] = createSignal<string | null>(null)
  const visible = createMemo<FindingRow[]>(() => rows() ?? [])
  const selectedId = createMemo(() => resolveSelectedId(selected(), visible()))
  const selectedRow = createMemo(() => visible().find((r) => r.id === selectedId()) ?? null)
  // The RAW pick drives the phone panes: selectedId() resolves to the first
  // row on its own, which would hand the phone to the detail before the
  // operator has chosen anything.
  const panes = createMemo(() => splitPaneClasses(selected() !== null))
  // What the agent is told is open: both panes from md up, on a phone only a pick.
  const bothPanes = createMediaMatch("(min-width: 768px)")
  app.trackOpenRecord("finding", () => (bothPanes() ? selectedId() : selected()))

  return (
    <div class="flex h-full min-h-0 flex-col">
      <PageHeader title="Findings" subtitle="Brand-relevant comments, mentions and keyword hits" />
      <div class="flex min-h-0 flex-1">
        <div
          class={cx(
            "w-full shrink-0 flex-col overflow-y-auto border-r border-border-subtle",
            panes().list,
          )}
          data-testid="social-findings-list"
        >
          <Show when={visible().length > 0} fallback={<EmptyState title="No findings yet">Connect an account to start monitoring.</EmptyState>}>
            <For each={visible()}>
              {(r) => {
                const meta = findingStatusTone(r.status)
                const excerpt = postExcerptOf(r)
                const isVideo = isVideoMatch(r.relation)
                return (
                  <button
                    type="button"
                    data-testid={`social-finding-row-${r.id}`}
                    onClick={() => setSelected(r.id)}
                    class={cx(
                      "flex w-full flex-col gap-1 border-b border-border-subtle px-3 py-2 text-left",
                      selectedId() === r.id ? "bg-surface-hover" : "hover:bg-surface-hover",
                    )}
                  >
                    <span class="flex items-center gap-2">
                      <Badge tone="neutral" class="shrink-0">{platformLabel(r.platform)}</Badge>
                      <Show when={isVideo}>
                        <Badge tone="accent" class="shrink-0">Video match</Badge>
                      </Show>
                      <span class="truncate text-[12.5px] text-text">
                        {isVideo ? (stripExternalFence(r.content_text) || "(untitled video)") : authorLabel(r.platform, r.author_handle)}
                      </span>
                      <span class="ml-auto shrink-0 text-[10.5px] text-text-tertiary">{shortTime(r.occurred_at)}</span>
                    </span>
                    <span class="flex items-center justify-between gap-2">
                      <span class="truncate text-[11.5px] text-text-tertiary">
                        {isVideo
                          ? `by ${authorLabel(r.platform, r.author_handle)}`
                          : stripExternalFence(r.content_text)}
                      </span>
                      <Badge tone={meta.tone} class="shrink-0">{meta.label}</Badge>
                    </span>
                    <Show when={excerpt} keyed>
                      {(e) => <span class="truncate text-[10.5px] text-text-tertiary">on: {e}</span>}
                    </Show>
                  </button>
                )
              }}
            </For>
          </Show>
        </div>
        <div class={cx("min-w-0 flex-1 flex-col overflow-y-auto", panes().detail)}>
          {/* Phone only: the detail took the viewport from the list, so it
              carries the way back. */}
          <Show when={selected() !== null}>
            <button
              type="button"
              data-testid="social-findings-back"
              class="min-h-11 self-start px-3 text-[12.5px] text-text-secondary md:hidden"
              onClick={() => setSelected(null)}
            >
              Back to findings
            </button>
          </Show>
          <FindingDetailPanel finding={selectedRow()} onChanged={() => void refetch()} />
        </div>
      </div>
    </div>
  )
}
