// SPDX-License-Identifier: FSL-1.1-ALv2

import type { RoutineFlow } from "@liaison/shared"
import { capabilityCategories, type ReasoningLevel } from "@liaison/shared"
import { ChevronDown } from "lucide-solid"
import {
  type Component,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  onMount,
  Show,
} from "solid-js"
import { ApiError } from "~/lib/api-error"
import { categoryChip, scopeIdTitle, scopeLabel } from "~/lib/capability-copy"
import { getModelLabel } from "~/lib/model-groups"
import { formatDateTime } from "~/lib/relative-time"
import { ensureAvailableModels } from "~/modules/agent/credits/credits-store"
import { routineStoppedReason, runStatusLabel } from "~/modules/agent/routine-status-copy"
import { hasScope, userFromToken } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { openTab } from "~/modules/shell/tab-store"
import { conversationDisplayName } from "~/modules/threads/conversation-display"
import { allThreads, getThread, normalizeThread, type Thread } from "~/modules/threads/thread-store"
import { PopupMenu } from "~/ui/PopupMenu"
import Chip from "./Chip"
import { cronPreview } from "./cron-preview"
import FlowList from "./flow/FlowList"
import { loadFlowPeople, loadFlowProject } from "./flow/flow-data"
import { flowProblem } from "./flow/flow-model"
import ModelOptions from "./ModelOptions"
import ReasoningLevelRow from "./ReasoningLevelRow"
import RoutineApproverField, { approverLabelKey } from "./RoutineApproverField"
import RoutineCreate from "./RoutineCreate"
import RoutineRunsOnField, { runsOnLabelKey, runsOnNode } from "./RoutineRunsOnField"
import RoutineScopesField from "./RoutineScopesField"
import RoutineSenderFilterField, { SENDER_FILTER_EVENT } from "./RoutineSenderFilterField"
import RoutineTokenFields, { parseTokenField } from "./RoutineTokenFields"
import { formatRunDuration, runTone, runTriggerLabel } from "./routine-run-copy"
import {
  describeRoutineEvent,
  describeSchedule,
  loadOlderRoutineRuns,
  loadRoutineRuns,
  loadRoutines,
  type RoutineApprover,
  type RoutineEventFilter,
  type RoutineNodePlacement,
  type RoutineRow,
  type RoutineRunsOn,
  routineLabel,
  routinesForAgent,
  routinesStore,
  runRoutineNow,
  setOpenRoutineDetailId,
  updateRoutine,
} from "./routines-store"
import SchedulePicker, { type ScheduleValue } from "./SchedulePicker"

interface Props {
  entityId: string
  /** P4c-T36: read the agent page's per-agent list instead of the flat one,
   *  and take the server's `canWrite` as the edit authority. */
  ownerAgentId?: string
  /** Forwarded to the create surface behind the `new` sentinel. */
  onCreated?: (routine: { id: string; name: string }) => void
  onCancelCreate?: () => void
  /** Opens one run's transcript (the agent page's run pane). Absent, a run
   *  opens the routine's whole output thread, as it always did. */
  onOpenRun?: (runId: string) => void
}

/** A prompt longer than this, or with more lines, starts collapsed. */
function promptIsLong(prompt: string | null | undefined): boolean {
  if (!prompt) return false
  return prompt.length > 320 || prompt.split("\n").length > 4
}

/** A 1:1 DM with an agent: not a channel, and exactly one agent seat. */
function isAgentDm(t: Thread): boolean {
  if (t.discoverable) return false
  const agentSeats = t.participants.filter((p) => p.participantType === "agent")
  return agentSeats.length === 1
}

/** A routine's posts are written under its OWNER's authority, so it can only
 *  post where that person sits. */
function ownerIsSeated(t: Thread, ownerUserId: string | null): boolean {
  if (!ownerUserId) return false
  return t.participants.some((p) => p.participantType === "user" && p.id === ownerUserId)
}

const RoutineDetail: Component<Props> = (props) => {
  // The "new" sentinel renders the create surface (a tab, never a modal).
  if (props.entityId === "new") {
    return (
      <RoutineCreate
        ownerAgentId={props.ownerAgentId}
        onCreated={props.onCreated}
        onCancel={props.onCancelCreate}
      />
    )
  }

  const api = useApi()
  void ensureAvailableModels(api)
  const i18n = useI18n()
  /** Who may read a raw scope name on this surface: the agents admin, nobody
   *  else. Everyone else reads capability categories. */
  const scopeAdmin = () => hasScope("kernel:agents:admin")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [editing, setEditing] = createSignal(false)
  /** The pane's two tabs: what the routine did (Runs, first) and how it is set
   *  up (Settings). Editing is a Settings act, so it brings that tab forward. */
  const [paneTabPicked, setPaneTab] = createSignal<"flow" | "runs" | "settings" | null>(null)
  /** A flow routine opens on its Flow tab (first); a prompt routine on Runs. */
  const paneTab = () => paneTabPicked() ?? (routine()?.flow ? "flow" : "runs")
  /** A long prompt reads as a few lines until the reader asks for all of it. */
  const [promptExpanded, setPromptExpanded] = createSignal(false)
  const [loadingOlder, setLoadingOlder] = createSignal(false)
  const [editDescription, setEditDescription] = createSignal("")
  const [editPrompt, setEditPrompt] = createSignal("")
  const [editSchedule, setEditSchedule] = createSignal<ScheduleValue | null>(null)
  const [editAgentModelId, setEditAgentModelId] = createSignal<string | null>(null)
  const [editAgentReasoningLevel, setEditAgentReasoningLevel] = createSignal<ReasoningLevel>("off")
  const [editPostsTo, setEditPostsTo] = createSignal<string | null>(null)
  const [editTokenBudget, setEditTokenBudget] = createSignal("")
  const [editHardTokenLimit, setEditHardTokenLimit] = createSignal("")
  const [editRunsOn, setEditRunsOn] = createSignal<RoutineRunsOn>("cloud")
  const [editPlacement, setEditPlacement] = createSignal<RoutineNodePlacement>({
    folder: null,
    repo: null,
    model: null,
  })
  const [editEventFilter, setEditEventFilter] = createSignal<RoutineEventFilter | null>(null)
  const [editApprover, setEditApprover] = createSignal<RoutineApprover>("default")
  const [editScopes, setEditScopes] = createSignal<string[]>([])
  const [destinationError, setDestinationError] = createSignal<string | null>(null)
  const [saving, setSaving] = createSignal(false)

  const scoped = () => props.ownerAgentId

  onMount(() => {
    setOpenRoutineDetailId(props.entityId)
    const owner = scoped()
    if (routinesForAgent(owner).length === 0) {
      void loadRoutines(api as any, owner ? { ownerAgentId: owner } : undefined)
    }
    void loadRoutineRuns(api as any, props.entityId)
  })

  const routine = createMemo(() => routinesForAgent(scoped()).find((r) => r.id === props.entityId))

  // ── Flow (0303) ──
  /** A non-project trigger in words, as the Settings tab says it. */
  const triggerWords = (row: RoutineRow) =>
    row.kind === "event"
      ? i18n.t("kernel.agentForms.runsWhen", { event: describeRoutineEvent(row.event ?? "") })
      : describeSchedule(row, { withTimezone: true, i18n: { t: i18n.t, locale: i18n.locale() } })
  const flowProjectId = () => {
    const id = routine()?.eventFilter?.projectId
    return routine()?.flow && typeof id === "string" ? id : null
  }
  const [flowProject] = createResource(flowProjectId, (id) => loadFlowProject(api, id))
  const [flowPeople] = createResource(
    () => (routine()?.flow ? props.entityId : null),
    () => loadFlowPeople(api),
  )
  const [flowDraft, setFlowDraft] = createSignal<RoutineFlow | null>(null)
  const [filterDraft, setFilterDraft] = createSignal<RoutineEventFilter | null>(null)
  const [flowSaving, setFlowSaving] = createSignal(false)
  const [flowError, setFlowError] = createSignal<string | null>(null)
  const [openRunId, setOpenRunId] = createSignal<string | null>(null)
  function startFlowEdit() {
    const r = routine()
    if (!r?.flow) return
    // A plain copy: the row is a store proxy, which structuredClone refuses.
    setFlowDraft(JSON.parse(JSON.stringify(r.flow)) as RoutineFlow)
    setFilterDraft(r.eventFilter ? { ...r.eventFilter } : null)
    setFlowError(null)
  }
  const flowDraftProblem = () => {
    const d = flowDraft()
    return d ? flowProblem(i18n.t, d, routine()?.event ?? null, filterDraft()) : null
  }
  async function saveFlow() {
    const r = routine()
    const flow = flowDraft()
    if (!r || !flow || flowDraftProblem()) return
    setFlowSaving(true)
    setFlowError(null)
    try {
      const filter = filterDraft()
      const filterChanged = JSON.stringify(filter ?? null) !== JSON.stringify(r.eventFilter ?? null)
      await updateRoutine(api, r.id, {
        flow,
        ...(filterChanged ? { eventFilter: filter } : {}),
      })
      setFlowDraft(null)
      setFilterDraft(null)
    } catch (err) {
      setFlowError(err instanceof Error ? err.message : i18n.t("kernel.routineFlow.saveFailed"))
    } finally {
      setFlowSaving(false)
    }
  }

  const runs = createMemo(() => routinesStore.runs[props.entityId] ?? [])
  // A run the socket just reported carries no summary (the server reads it
  // from the thread): the history reads itself again once, for that run.
  let refetchedFor: string | null = null
  createEffect(() => {
    const newest = runs()[0]
    if (!newest || newest.summary !== undefined || refetchedFor === newest.id) return
    refetchedFor = newest.id
    void loadRoutineRuns(api as any, props.entityId)
  })
  /** The routine runs as this viewer: its node placement is theirs to choose (m7). */
  const isOwner = (r: RoutineRow) => r.ownerUserId === userFromToken()?.userId
  /** A placement to send with the edit: a node routine, its owner, and a changed value. */
  const placementChanged = (r: RoutineRow) => {
    const p = editPlacement()
    return (
      runsOnNode(editRunsOn()) &&
      isOwner(r) &&
      (p.folder !== (r.folder ?? null) ||
        p.repo !== (r.repo ?? null) ||
        p.model !== (r.model ?? null))
    )
  }

  // THE DESTINATION IS READ BY ID, NOT FROM THE SIDEBAR LIST. The thread store
  // holds only what the sidebar loaded (its 50 most recent threads, once that
  // load has finished), so a fresh session opened on an agent's Routines tab
  // read "Destination unavailable" until the list arrived, and for good when
  // the destination was older than the list's window. A destination the store
  // does not know is fetched on its own; "unavailable" is now the server's
  // answer (gone, or not readable), never the store's ignorance. The fetched
  // row is kept here, not added to the store, so it does not join the sidebar.
  type FetchedDestination =
    | { status: "loading" }
    | { status: "found"; thread: Thread }
    | { status: "missing" }
  const [fetchedDestinations, setFetchedDestinations] = createSignal<
    Record<string, FetchedDestination>
  >({})

  function fetchDestination(id: string) {
    setFetchedDestinations((m) => ({ ...m, [id]: { status: "loading" } }))
    api
      .get<any>(`/threads/${id}`)
      .then((res: any) => {
        const data = res?.data ?? res
        const found: FetchedDestination =
          data?.id === id
            ? { status: "found", thread: normalizeThread(data) }
            : { status: "missing" }
        setFetchedDestinations((m) => ({ ...m, [id]: found }))
      })
      .catch(() => {
        setFetchedDestinations((m) => ({ ...m, [id]: { status: "missing" } }))
      })
  }

  createEffect(() => {
    // The routine's saved destination is always read once: the listing row
    // does not say what KIND of thread it is, and the routine's own output
    // thread is a destination whoever is seated in it (below).
    const saved = routine()?.reportThreadId
    if (saved && !fetchedDestinations()[saved]) fetchDestination(saved)
    const picked = editPostsTo()
    if (picked && !getThread(picked) && !fetchedDestinations()[picked]) fetchDestination(picked)
  })

  /** The destination thread: the store's copy, else the one fetched by id. */
  function destinationThread(id: string): Thread | undefined {
    const known = getThread(id)
    if (known) return known
    const fetched = fetchedDestinations()[id]
    return fetched?.status === "found" ? fetched.thread : undefined
  }

  /** Still asking the server about a destination the store does not hold. */
  function destinationLoading(id: string): boolean {
    return (
      !getThread(id) &&
      fetchedDestinations()[id]?.status !== "found" &&
      fetchedDestinations()[id]?.status !== "missing"
    )
  }

  /** Every thread a destination can be: the store's, plus a fetched one. */
  const candidateThreads = createMemo(() => {
    const threads = allThreads()
    const extra = Object.values(fetchedDestinations()).flatMap((f) =>
      f.status === "found" && !getThread(f.thread.id) ? [f.thread] : [],
    )
    return extra.length > 0 ? [...threads, ...extra] : threads
  })

  // WHERE THE ROUTINE POSTS ITS RUNS (`reportThreadId`): a conversation the
  // user can see AND the routine's owner sits in (its posts are written under
  // the owner's authority), never a routine's own run thread, which is the
  // "only its own run thread" choice. The server refuses anything else, so
  // offering it here would only produce a 400 on save.
  const destinationOptions = createMemo(() =>
    candidateThreads()
      .filter(
        (t) => ownerIsSeated(t, routine()?.ownerUserId ?? null) && (t.type as string) !== "routine",
      )
      .map((t) => ({
        id: t.id,
        label: conversationDisplayName(t, ""),
        handle: t.handle ?? "",
        isChannel: t.discoverable,
        isAgentDm: isAgentDm(t),
      })),
  )

  // The destination the routine ALREADY has, when it is not one this picker
  // would offer: the owner agent lost its seat, the thread stopped being
  // visible here, or an admin set it from somewhere else. The picker used to
  // fall through to "No destination" while the signal still held the real id,
  // so the screen and the value disagreed: the owner read "No destination",
  // saved an unrelated edit, and detached a destination they never touched.
  // Keeping it as a marked option says what is actually configured and lets
  // them leave it alone or change it on purpose.
  const currentDestinationOption = createMemo(() => {
    const id = editPostsTo()
    if (!id || destinationOptions().some((o) => o.id === id)) return null
    const thread = destinationThread(id)
    const name = thread ? conversationDisplayName(thread, "") : null
    return {
      id,
      label: name
        ? i18n.t("kernel.agentForms.destinationNamedUnavailable", { name })
        : destinationLoading(id)
          ? i18n.t("kernel.loading")
          : i18n.t("kernel.agentForms.destinationUnavailable"),
      handle: thread?.handle ?? "",
      isChannel: false,
      isAgentDm: false,
      isCurrentUnavailable: true,
    }
  })

  /** What the picker renders: the seated threads, plus the current destination
   *  when it is not among them. */
  const editDestinationOptions = createMemo(() => {
    const current = currentDestinationOption()
    return current ? [current, ...destinationOptions()] : destinationOptions()
  })

  const [destinationOpen, setDestinationOpen] = createSignal(false)

  type DestinationOption = ReturnType<typeof editDestinationOptions>[number]

  /** A handle is stored with its leading "@"; a row supplies its own sigil. */
  function bareHandle(handle: string): string {
    return handle.replace(/^[@#]/, "")
  }

  /**
   * THE ROW'S FIRST LINE. Two rooms with the same members render the same
   * display name ("App, Support" twice over), and the picker offered both
   * under that one word with nothing to choose between them. A channel is
   * named by its handle, which is unique; everything else keeps the display
   * name and is told apart by the second line.
   */
  function destinationTitle(option: DestinationOption): string {
    const handle = bareHandle(option.handle ?? "")
    return option.isChannel && handle.length > 0 ? `#${handle}` : option.label
  }

  /** THE ROW'S SECOND LINE: what this destination IS. A channel says its name,
   *  everything else says its kind and, when it has one, its handle. */
  function destinationKind(option: DestinationOption): string | undefined {
    if ("isCurrentUnavailable" in option) return undefined
    const handle = bareHandle(option.handle ?? "")
    if (option.isChannel) return handle.length > 0 ? option.label : undefined
    const kind = option.isAgentDm
      ? i18n.t("kernel.agentForms.destinationKindDm")
      : i18n.t("kernel.agentForms.destinationKindRoom")
    return handle.length > 0 ? `${kind}, @${handle}` : kind
  }

  const selectedDestination = createMemo(() =>
    editDestinationOptions().find((o) => o.id === editPostsTo()),
  )

  /** What the READ view says the routine posts into: the thread's own name, or
   *  the kernel "No destination" string when it has none. */
  const destinationLabel = createMemo(() => {
    const id = routine()?.reportThreadId
    if (!id) return i18n.t("kernel.routineNoDestination")
    const thread = destinationThread(id)
    if (!thread) {
      return destinationLoading(id)
        ? i18n.t("kernel.loading")
        : i18n.t("kernel.routineDestinationUnavailable")
    }
    const name = conversationDisplayName(thread, "")
    return thread.discoverable ? `#${name}` : name
  })

  // A SWITCHED-OFF ROUTINE HAS NO NEXT RUN. The cron string still parses when
  // `enabled` is false, so the pane projected three future run times for a
  // routine the scheduler will never fire. Off says so instead.
  const nextFires = createMemo(() => {
    const r = routine()
    if (!r?.enabled || r.kind !== "recurring" || !r.cron) return []
    return cronPreview(r.cron, r.timezone ?? "UTC", 3)
  })

  function startEdit() {
    const r = routine()
    if (!r) return
    setEditDescription(r.description)
    setEditPrompt(r.prompt)
    setEditSchedule(
      r.kind === "recurring"
        ? { kind: "recurring", cron: r.cron ?? "", timezone: r.timezone ?? "UTC" }
        : r.kind === "event"
          ? { kind: "event", event: r.event ?? "" }
          : { kind: "scheduled", runAt: r.runAt ?? "" },
    )
    setEditAgentModelId(r.agentModelId ?? null)
    setEditAgentReasoningLevel(r.agentReasoningLevel ?? "off")
    setEditTokenBudget(r.tokenBudget ? String(r.tokenBudget) : "")
    setEditHardTokenLimit(r.hardTokenLimit ? String(r.hardTokenLimit) : "")
    setEditRunsOn(r.runsOn ?? "cloud")
    setEditPlacement({ folder: r.folder ?? null, repo: r.repo ?? null, model: r.model ?? null })
    setEditEventFilter(r.eventFilter ?? null)
    setEditApprover(r.approver ?? "default")
    setEditScopes([...(r.scopes ?? [])])
    // A routine with NO destination opens on the empty choice, never on a
    // candidate the editor picked for it: preselecting the first option turned
    // an unrelated Save into a silent binding to a room nobody chose. Null
    // stays null until someone selects something (inventory 20).
    setEditPostsTo(r.reportThreadId ?? null)
    setError(null)
    setDestinationError(null)
    setEditing(true)
    setPaneTab("settings")
  }

  async function saveEdit() {
    const r = routine()
    const sched = editSchedule()
    if (!r || !sched) return
    setError(null)
    setDestinationError(null)
    const budget = parseTokenField(editTokenBudget())
    const limit = parseTokenField(editHardTokenLimit())
    if (budget === "invalid" || limit === "invalid") {
      setError(i18n.t("kernel.agentForms.tokenNumberInvalid"))
      return
    }
    // D20: the scopes are sent only when the owner changed them, and then as the exact list.
    const stored = r.scopes ?? []
    const nextScopes = editScopes()
    const scopesChanged =
      nextScopes.length !== stored.length || nextScopes.some((s, i) => s !== stored[i])
    setSaving(true)
    try {
      await updateRoutine(api as any, r.id, {
        ...(scopesChanged ? { scopes: nextScopes } : {}),
        description: editDescription(),
        prompt: editPrompt(),
        kind: sched.kind,
        agentModelId: editAgentModelId(),
        agentReasoningLevel: editAgentModelId() ? editAgentReasoningLevel() : null,
        // Null clears: an emptied field removes the budget / the limit.
        tokenBudget: budget,
        hardTokenLimit: limit,
        runsOn: editRunsOn(),
        // L26, m7: a node routine's folder (or repo) and model travel with the edit, the
        // owner's only (they are on the owner's own computer).
        ...(placementChanged(r) ? { nodePlacement: editPlacement() } : {}),
        approver: editApprover(),
        // The one "where it posts" field: null keeps the runs in its own thread.
        reportThreadId: editPostsTo(),
        // Each kind sends ONLY its own columns: an event routine carries no
        // cron, no timezone and no runAt, which is what the check constraint
        // and the request schema both require.
        ...(sched.kind === "recurring"
          ? { cron: sched.cron, timezone: sched.timezone }
          : sched.kind === "scheduled"
            ? { runAt: sched.runAt }
            : {
                event: sched.event,
                // A new-mail routine sends its sender filter (null clears it).
                ...(sched.event === SENDER_FILTER_EVENT ? { eventFilter: editEventFilter() } : {}),
              }),
      })
      setEditing(false)
    } catch (err) {
      // A destination the owner agent cannot post in is refused with 400, and
      // belongs next to the control that caused it rather than in the banner.
      if (err instanceof ApiError && err.status === 400) {
        setDestinationError(err.message)
        return
      }
      setError(err instanceof Error ? err.message : i18n.t("kernel.agents.saveFailed"))
    } finally {
      setSaving(false)
    }
  }

  async function onRunNow() {
    const r = routine()
    if (!r) return
    setError(null)
    // Walk D20: a routine the worker would drop is refused here, in words
    // (the server refuses it too, for the agent and MCP paths).
    const blocked = !r.enabled
      ? "kernel.agentForms.runNowOff"
      : r.status === "paused_user"
        ? "kernel.agentForms.runNowPaused"
        : r.status === "paused_app_disabled"
          ? "kernel.agentForms.runNowAppOff"
          : r.status === "completed"
            ? "kernel.agentForms.runNowCompleted"
            : null
    if (blocked) {
      setError(i18n.t(blocked))
      return
    }
    setBusy(true)
    try {
      await runRoutineNow(api as any, r.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : i18n.t("kernel.agentForms.runFailed"))
    } finally {
      setBusy(false)
    }
  }

  function openOutputThread() {
    const r = routine()
    if (!r?.outputThreadId) return
    openTab({ type: "kernel:thread", entityId: r.outputThreadId, label: routineLabel(r) })
  }

  async function onLoadOlder() {
    setLoadingOlder(true)
    try {
      await loadOlderRoutineRuns(api as any, props.entityId)
    } catch (err) {
      setError(err instanceof Error ? err.message : i18n.t("kernel.agentForms.olderRunsFailed"))
    } finally {
      setLoadingOlder(false)
    }
  }

  /** A run opens its own transcript where the page has a run pane, else the log. */
  function openRun(runId: string) {
    if (props.onOpenRun) props.onOpenRun(runId)
    else openOutputThread()
  }

  return (
    <div data-testid="routine-detail" class="flex h-full flex-col">
      <Show
        when={routine()}
        fallback={
          <div class="px-6 py-8 text-text-tertiary">
            {i18n.t("kernel.agentForms.routineNotFound")}
          </div>
        }
      >
        {(r) => (
          <>
            <Show when={r().status !== "active" && r().status !== "completed"}>
              <div
                data-testid="routine-paused-banner"
                class="border-b border-border-subtle bg-surface-hover px-4 py-2 text-[12px] text-amber-500"
              >
                {routineStoppedReason(i18n.t, r().status, r().lastRunError)}
                {/* D20: a scope pause says how to fix it, in the reader's language. */}
                <Show when={r().status === "paused_scope_mismatch"}>
                  <p data-testid="routine-scope-fix-hint" class="mt-1 text-text-secondary">
                    {i18n.t("kernel.agentForms.scopeFixHint")}
                  </p>
                </Show>
              </div>
            </Show>
            <Show when={r().status === "completed"}>
              <div
                data-testid="routine-completed-banner"
                class="border-b border-border-subtle bg-surface-hover px-4 py-2 text-[12px] text-text-tertiary"
              >
                {i18n.t("kernel.agentForms.completedBanner")}
              </div>
            </Show>

            <div class="flex items-start justify-between border-b border-border-subtle px-6 py-4">
              <div class="min-w-0">
                <h1 data-testid="routine-detail-title" class="text-[16px] font-medium text-text">
                  {routineLabel(r())}
                </h1>
                <p class="mt-1 text-[13px] text-text-tertiary">{r().description}</p>
              </div>
              <div class="flex shrink-0 items-center gap-2">
                {/* Run now sits with the routine's own actions, apart from the
                  run rows, so a press on it is never a press on a run. */}
                <Show when={r().status !== "completed"}>
                  <button
                    type="button"
                    data-testid="routine-run-now"
                    onClick={() => void onRunNow()}
                    disabled={busy()}
                    class="shrink-0 rounded-md bg-accent px-3 py-1 text-[12px] text-accent-foreground transition-colors disabled:opacity-50"
                  >
                    {busy()
                      ? i18n.t("kernel.agentForms.queuing")
                      : i18n.t("kernel.agentForms.runNow")}
                  </button>
                </Show>
                {/* Edit is a WRITE. On an agent's list the server answered who
                  may make it, per row, under A15. */}
                <Show
                  when={
                    !editing() &&
                    r().status !== "completed" &&
                    (scoped() ? r().canWrite === true : true)
                  }
                >
                  <button
                    type="button"
                    data-testid="routine-edit"
                    onClick={startEdit}
                    class="shrink-0 rounded-md border border-border-subtle px-3 py-1 text-[12px] text-text-secondary transition-colors hover:bg-surface-hover"
                  >
                    {i18n.t("kernel.agentForms.edit")}
                  </button>
                </Show>
              </div>
            </div>
            <Show when={error()}>
              <p data-testid="routine-run-now-error" class="px-6 pt-2 text-[12px] text-amber-500">
                {error()}
              </p>
            </Show>

            {/* RUNS FIRST, SETTINGS SECOND. What the routine did is what a reader
                comes for; how it is set up is one click away. */}
            <div
              role="tablist"
              aria-label={routineLabel(r())}
              class="flex gap-4 border-b border-border-subtle px-6"
            >
              <For
                each={
                  (r().flow ? ["flow", "runs", "settings"] : ["runs", "settings"]) as Array<
                    "flow" | "runs" | "settings"
                  >
                }
              >
                {(id) => (
                  <button
                    type="button"
                    role="tab"
                    data-testid={`routine-tab-${id}`}
                    aria-selected={paneTab() === id}
                    onClick={() => setPaneTab(id)}
                    class="-mb-px border-b-2 py-2 text-[13px] transition-colors"
                    classList={{
                      "border-accent text-text": paneTab() === id,
                      "border-transparent text-text-tertiary hover:text-text-secondary":
                        paneTab() !== id,
                    }}
                  >
                    {i18n.t(
                      id === "flow"
                        ? "kernel.routineFlow.tabFlow"
                        : id === "runs"
                          ? "kernel.agentForms.tabRuns"
                          : "kernel.agentForms.tabSettings",
                    )}
                  </button>
                )}
              </For>
            </div>

            <Show when={r().flow}>
              {(flow) => (
                <div
                  role="tabpanel"
                  data-testid="routine-flow-panel"
                  hidden={paneTab() !== "flow"}
                  class="min-h-0 flex-1 overflow-auto px-4 py-3 pb-dock-runway [--dock-pad-base:0px] sm:px-6"
                >
                  <Show
                    when={flowDraft()}
                    fallback={
                      <>
                        <Show
                          when={
                            r().status !== "completed" && (scoped() ? r().canWrite === true : true)
                          }
                        >
                          <div class="mb-2 flex justify-end">
                            <button
                              type="button"
                              data-testid="routine-flow-edit"
                              onClick={startFlowEdit}
                              class="rounded-md border border-border-subtle px-3 py-1 text-[12px] text-text-secondary transition-colors hover:bg-surface-hover"
                            >
                              {i18n.t("kernel.routineFlow.editFlow")}
                            </button>
                          </div>
                        </Show>
                        <FlowList
                          flow={flow()}
                          event={r().event}
                          eventFilter={r().eventFilter ?? null}
                          project={flowProject() ?? null}
                          people={flowPeople() ?? []}
                          mode="view"
                          triggerFallback={triggerWords(r())}
                        />
                      </>
                    }
                  >
                    {(draft) => (
                      <div class="flex min-w-0 flex-col gap-3">
                        <FlowList
                          flow={draft()}
                          event={r().event}
                          eventFilter={filterDraft()}
                          project={flowProject() ?? null}
                          people={flowPeople() ?? []}
                          mode="edit"
                          onChange={setFlowDraft}
                          onFilterChange={setFilterDraft}
                          triggerFallback={triggerWords(r())}
                        />
                        <Show when={flowDraftProblem() ?? flowError()}>
                          {(msg) => (
                            <p
                              data-testid="routine-flow-problem"
                              class="text-[12px] text-amber-500"
                            >
                              {msg()}
                            </p>
                          )}
                        </Show>
                        <div class="flex flex-wrap justify-end gap-2">
                          <button
                            type="button"
                            data-testid="routine-flow-cancel"
                            onClick={() => {
                              setFlowDraft(null)
                              setFilterDraft(null)
                            }}
                            class="rounded-md border border-border-subtle px-3 py-1 text-[12px] text-text-secondary hover:bg-surface-hover"
                          >
                            {i18n.t("kernel.routineFlow.cancel")}
                          </button>
                          <button
                            type="button"
                            data-testid="routine-flow-save"
                            disabled={flowSaving() || !!flowDraftProblem()}
                            onClick={() => void saveFlow()}
                            class="rounded-md bg-accent px-3 py-1 text-[12px] text-white disabled:opacity-50"
                          >
                            {i18n.t("kernel.routineFlow.save")}
                          </button>
                        </div>
                      </div>
                    )}
                  </Show>
                </div>
              )}
            </Show>

            <div
              role="tabpanel"
              data-testid="routine-runs-panel"
              hidden={paneTab() !== "runs"}
              class="min-h-0 flex-1 overflow-auto px-6 py-3"
            >
              <ul data-testid="routine-run-history" class="flex flex-col">
                <For
                  each={runs()}
                  fallback={
                    <li class="py-2 text-[12px] text-text-tertiary">
                      {i18n.t("kernel.agentForms.noRuns")}
                    </li>
                  }
                >
                  {(run) => (
                    <li class="border-b border-border-subtle last:border-b-0">
                      <button
                        type="button"
                        data-testid={`run-history-row-${run.id}`}
                        aria-expanded={run.steps ? openRunId() === run.id : undefined}
                        onClick={() =>
                          run.steps && r().flow
                            ? setOpenRunId(openRunId() === run.id ? null : run.id)
                            : openRun(run.id)
                        }
                        class="flex w-full flex-col gap-0.5 rounded px-2 py-2 text-left transition-colors hover:bg-surface-hover"
                      >
                        <span class="flex w-full items-center gap-2 text-[12px]">
                          <span class="text-text">
                            {formatDateTime(run.startedAt ?? run.ranAt, i18n.locale())}
                          </span>
                          <Show when={runTriggerLabel(i18n.t, run, r().kind)}>
                            {(label) => (
                              <Chip
                                data-testid={`run-trigger-${run.id}`}
                                title={run.triggerLabel ?? undefined}
                              >
                                {label()}
                              </Chip>
                            )}
                          </Show>
                          <span class="ml-auto flex items-center gap-2">
                            <Show when={formatRunDuration(run.durationMs, i18n.locale())}>
                              {(d) => (
                                <span
                                  data-testid={`run-duration-${run.id}`}
                                  class="text-[11px] text-text-tertiary"
                                >
                                  {d()}
                                </span>
                              )}
                            </Show>
                            <Chip
                              tone={runTone(run.status)}
                              data-testid={`run-status-${run.status}`}
                            >
                              {runStatusLabel(i18n.t, run.status)}
                            </Chip>
                          </span>
                        </span>
                        <Show when={run.summary}>
                          <span
                            data-testid={`run-summary-${run.id}`}
                            class="truncate text-[12px] text-text-secondary"
                          >
                            {run.summary}
                          </span>
                        </Show>
                      </button>
                      {/* A flow run lays its step states over the routine's flow. */}
                      <Show when={openRunId() === run.id && r().flow}>
                        {(flow) => (
                          <div data-testid={`run-flow-${run.id}`} class="px-2 pb-2">
                            <FlowList
                              flow={flow()}
                              event={r().event}
                              eventFilter={r().eventFilter ?? null}
                              project={flowProject() ?? null}
                              people={flowPeople() ?? []}
                              mode="run"
                              runSteps={run.steps ?? []}
                              testid={`run-flow-list-${run.id}`}
                              triggerFallback={triggerWords(r())}
                            />
                            <Show when={run.hasTranscript}>
                              <button
                                type="button"
                                data-testid={`run-open-transcript-${run.id}`}
                                onClick={() => openRun(run.id)}
                                class="mt-2 rounded px-2 py-1 text-[12px] text-text-secondary hover:bg-surface-hover"
                              >
                                {i18n.t("kernel.routineFlow.openTranscript")}
                              </button>
                            </Show>
                          </div>
                        )}
                      </Show>
                      {/* The run's own reason, under the run it belongs to: a
                          tick that skipped names the scopes it was short. */}
                      <Show when={run.errorMessage}>
                        <p
                          data-testid={`run-reason-${run.id}`}
                          class="px-2 pb-2 text-[11px] text-amber-500"
                        >
                          {run.errorMessage}
                        </p>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
              <Show when={routinesStore.runsHasMore[props.entityId]}>
                <button
                  type="button"
                  data-testid="routine-runs-older"
                  disabled={loadingOlder()}
                  onClick={() => void onLoadOlder()}
                  class="mt-3 rounded-md border border-border-subtle px-3 py-1 text-[12px] text-text-secondary transition-colors hover:bg-surface-hover disabled:opacity-50"
                >
                  {i18n.t("kernel.agentForms.olderRuns")}
                </button>
              </Show>
            </div>

            <div
              role="tabpanel"
              data-testid="routine-settings-panel"
              hidden={paneTab() !== "settings"}
              class="min-h-0 flex-1 overflow-auto pb-dock-runway [--dock-pad-base:0px]"
            >
              <Show
                when={editing()}
                fallback={
                  <>
                    <div class="border-b border-border-subtle px-6 py-4">
                      <h2 class="text-[12px] uppercase tracking-wide text-text-tertiary">
                        {r().kind === "event"
                          ? i18n.t("kernel.agentForms.trigger")
                          : i18n.t("kernel.agentForms.schedule")}
                      </h2>
                      <p data-testid="routine-schedule-text" class="mt-1 text-[13px] text-text">
                        {r().kind === "event"
                          ? i18n.t("kernel.agentForms.runsWhen", {
                              event: describeRoutineEvent(r().event ?? ""),
                            })
                          : describeSchedule(r(), {
                              withTimezone: true,
                              i18n: { t: i18n.t, locale: i18n.locale() },
                            })}
                      </p>
                      <Show when={r().kind === "event" && r().eventFilter}>
                        {(f) => (
                          <p
                            data-testid="routine-sender-filter-text"
                            class="mt-1 text-[12px] text-text-secondary"
                          >
                            {i18n.t("kernel.agentForms.senderFilterSummary", {
                              groups: f().fromGroupIds?.length ?? 0,
                              contacts: f().fromContactIds?.length ?? 0,
                            })}
                          </p>
                        )}
                      </Show>
                      <Show
                        when={nextFires().length > 0}
                        fallback={
                          <Show when={r().enabled === false}>
                            <p
                              data-testid="routine-schedule-off"
                              class="mt-2 text-[12px] text-text-tertiary"
                            >
                              {r().kind === "event"
                                ? i18n.t("kernel.agents.eventOff")
                                : i18n.t("kernel.agents.scheduleOff")}
                            </p>
                          </Show>
                        }
                      >
                        <ul
                          data-testid="routine-next-fires"
                          class="mt-2 text-[12px] text-text-tertiary"
                        >
                          <For each={nextFires()}>{(t) => <li>{t.toLocaleString()}</li>}</For>
                        </ul>
                      </Show>
                    </div>

                    <div class="border-b border-border-subtle px-6 py-4">
                      <h2 class="text-[12px] uppercase tracking-wide text-text-tertiary">
                        {i18n.t("kernel.agentForms.prompt")}
                      </h2>
                      <blockquote
                        data-testid="routine-prompt"
                        class="mt-1 whitespace-pre-wrap border-l-2 border-border-subtle pl-3 text-[13px] text-text"
                        classList={{ "line-clamp-4": !promptExpanded() }}
                      >
                        {r().prompt}
                      </blockquote>
                      <Show when={promptIsLong(r().prompt)}>
                        <button
                          type="button"
                          data-testid="routine-prompt-toggle"
                          onClick={() => setPromptExpanded((v) => !v)}
                          class="mt-1 text-[12px] text-accent hover:underline"
                        >
                          {promptExpanded()
                            ? i18n.t("kernel.common.showLess")
                            : i18n.t("kernel.agentForms.showAll")}
                        </button>
                      </Show>
                    </div>

                    {/* Inventory 20: the destination is part of the read view
                      whatever its value. Rendering the row only when one is set
                      left a routine with none looking like a routine whose
                      destination nobody had thought about. */}
                    {/* Where it posts its runs: a conversation, or only its own
                      run thread (the run log, read on the Runs tab). */}
                    <div class="border-b border-border-subtle px-6 py-4">
                      <h2 class="text-[12px] uppercase tracking-wide text-text-tertiary">
                        {i18n.t("kernel.agentForms.postTo")}
                      </h2>
                      <p data-testid="routine-destination-text" class="mt-1 text-[13px] text-text">
                        {destinationLabel()}
                      </p>
                    </div>

                    <div class="border-b border-border-subtle px-6 py-4">
                      <h2 class="text-[12px] uppercase tracking-wide text-text-tertiary">
                        {i18n.t("kernel.agentForms.agentModel")}
                      </h2>
                      <p data-testid="routine-model-text" class="mt-1 text-[13px] text-text">
                        {r().agentModelId
                          ? getModelLabel(r().agentModelId)
                          : i18n.t("kernel.agentForms.threadDefault")}
                        <Show when={r().agentModelId && r().agentReasoningLevel !== "off"}>
                          {" "}
                          · {i18n.t("kernel.agentForms.reasoning")}: {r().agentReasoningLevel}
                        </Show>
                      </p>
                    </div>

                    <div class="border-b border-border-subtle px-6 py-4">
                      <h2 class="text-[12px] uppercase tracking-wide text-text-tertiary">
                        {i18n.t("kernel.agentForms.tokenLimitsTitle")}
                      </h2>
                      <p data-testid="routine-token-limits-text" class="mt-1 text-[13px] text-text">
                        {r().tokenBudget || r().hardTokenLimit
                          ? [
                              r().tokenBudget
                                ? i18n.t("kernel.agentForms.tokenBudgetValue", {
                                    n: String(r().tokenBudget),
                                  })
                                : null,
                              r().hardTokenLimit
                                ? i18n.t("kernel.agentForms.hardTokenLimitValue", {
                                    n: String(r().hardTokenLimit),
                                  })
                                : null,
                            ]
                              .filter(Boolean)
                              .join(" · ")
                          : i18n.t("kernel.agentForms.tokenLimitsNone")}
                      </p>
                    </div>

                    <div class="border-b border-border-subtle px-6 py-4">
                      <h2 class="text-[12px] uppercase tracking-wide text-text-tertiary">
                        {i18n.t("kernel.agentForms.runsOn")}
                      </h2>
                      <p data-testid="routine-runs-on-text" class="mt-1 text-[13px] text-text">
                        {i18n.t(runsOnLabelKey(r().runsOn))}
                      </p>
                      <Show when={runsOnNode(r().runsOn) && (r().folder || r().repo || r().model)}>
                        <p
                          data-testid="routine-node-placement-text"
                          class="mt-1 text-[12.5px] text-text-secondary"
                        >
                          {[
                            r().folder
                              ? `${i18n.t("kernel.agentForms.nodeFolder")}: ${r().folder}`
                              : null,
                            r().repo
                              ? `${i18n.t("kernel.agentForms.nodeRepo")}: ${r().repo}`
                              : null,
                            r().model
                              ? `${i18n.t("kernel.agentForms.nodeModel")}: ${r().model}`
                              : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                      </Show>
                    </div>

                    <div class="border-b border-border-subtle px-6 py-4">
                      <h2 class="text-[12px] uppercase tracking-wide text-text-tertiary">
                        {i18n.t("kernel.agentForms.approver")}
                      </h2>
                      <p data-testid="routine-approver-text" class="mt-1 text-[13px] text-text">
                        {i18n.t(approverLabelKey(r().approver))}
                      </p>
                    </div>
                  </>
                }
              >
                {/* Edit form */}
                <div
                  data-testid="routine-edit-form"
                  class="border-b border-border-subtle px-6 py-4"
                >
                  <label class="flex flex-col gap-1.5 text-[12px] text-text-tertiary">
                    {i18n.t("kernel.agents.fieldDescription")}
                    <input
                      data-testid="routine-edit-description"
                      type="text"
                      class="rounded-md border border-border-subtle bg-surface-elevated px-2.5 py-1.5 text-[13px] text-text outline-none transition-colors focus:border-accent"
                      value={editDescription()}
                      onInput={(e) => setEditDescription(e.currentTarget.value)}
                    />
                  </label>
                  <div class="mt-3 flex flex-col gap-1.5">
                    <span class="text-[12px] text-text-tertiary">
                      {r().kind === "event"
                        ? i18n.t("kernel.agentForms.trigger")
                        : i18n.t("kernel.agentForms.schedule")}
                    </span>
                    <SchedulePicker
                      kind={r().kind}
                      value={{
                        cron: r().cron ?? undefined,
                        timezone: r().timezone ?? undefined,
                        runAt: r().runAt ?? undefined,
                        event: r().event ?? undefined,
                      }}
                      onChange={setEditSchedule}
                    />
                  </div>
                  <Show
                    when={(() => {
                      const sched = editSchedule()
                      return sched?.kind === "event" && sched.event === SENDER_FILTER_EVENT
                    })()}
                  >
                    <div class="mt-3">
                      <RoutineSenderFilterField
                        value={editEventFilter()}
                        onChange={setEditEventFilter}
                        testIdPrefix="routine-edit"
                      />
                    </div>
                  </Show>
                  {/* THE SHARED MENU, NOT A NATIVE SELECT. A `<select>` draws its
                    open list outside the document, so the choices could be
                    neither styled nor captured, and an option is one line of
                    text: two rooms with the same members were two rows reading
                    "App, Support". */}
                  <div class="mt-3 flex flex-col gap-1.5 text-[12px] text-text-tertiary">
                    <span>{i18n.t("kernel.agentForms.postTo")}</span>
                    <PopupMenu open={destinationOpen()} onOpenChange={setDestinationOpen}>
                      <PopupMenu.Trigger
                        data-testid="routine-output-thread"
                        aria-label={i18n.t("kernel.agentForms.postTo")}
                        class="flex w-full items-center justify-between gap-2 rounded-md border border-border-subtle bg-surface-elevated px-2.5 py-1.5 text-left transition-colors hover:border-accent"
                      >
                        <span
                          data-testid="routine-output-thread-value"
                          data-value={editPostsTo() ?? ""}
                          data-current-destination={
                            selectedDestination() &&
                            "isCurrentUnavailable" in selectedDestination()!
                              ? "true"
                              : undefined
                          }
                          class="flex min-w-0 flex-col"
                        >
                          <span class="truncate text-[13px] text-text">
                            {selectedDestination()
                              ? destinationTitle(selectedDestination()!)
                              : i18n.t("kernel.routineNoDestination")}
                          </span>
                          <Show
                            when={selectedDestination() && destinationKind(selectedDestination()!)}
                          >
                            {(kind) => <span class="truncate text-[11px]">{kind()}</span>}
                          </Show>
                        </span>
                        <ChevronDown size={14} class="shrink-0" />
                      </PopupMenu.Trigger>
                      <PopupMenu.Content
                        data-testid="routine-output-thread-menu"
                        class="max-h-[280px] w-[280px] overflow-y-auto"
                      >
                        <PopupMenu.Group>
                          <PopupMenu.Label>{i18n.t("kernel.agentForms.postTo")}</PopupMenu.Label>
                          <PopupMenu.Item
                            data-testid="routine-output-option-none"
                            onSelect={() => setEditPostsTo(null)}
                          >
                            {i18n.t("kernel.routineNoDestination")}
                          </PopupMenu.Item>
                          <For each={editDestinationOptions()}>
                            {(option) => (
                              <PopupMenu.Item
                                data-testid={`routine-output-option-${option.id}`}
                                data-current-destination={
                                  "isCurrentUnavailable" in option ? "true" : undefined
                                }
                                textValue={destinationTitle(option)}
                                onSelect={() => setEditPostsTo(option.id)}
                              >
                                <span class="flex min-w-0 flex-col">
                                  <span class="truncate text-[13px] text-text">
                                    {destinationTitle(option)}
                                  </span>
                                  <Show when={destinationKind(option)}>
                                    {(kind) => (
                                      <span class="truncate text-[11px] text-text-tertiary">
                                        {kind()}
                                      </span>
                                    )}
                                  </Show>
                                </span>
                              </PopupMenu.Item>
                            )}
                          </For>
                        </PopupMenu.Group>
                      </PopupMenu.Content>
                    </PopupMenu>
                    <Show when={destinationError()}>
                      {(text) => (
                        <span data-testid="routine-output-thread-error" class="text-amber-500">
                          {text()}
                        </span>
                      )}
                    </Show>
                  </div>
                  <label class="mt-3 flex flex-col gap-1.5 text-[12px] text-text-tertiary">
                    {i18n.t("kernel.agentForms.prompt")}
                    <textarea
                      data-testid="routine-edit-prompt"
                      rows={4}
                      class="rounded-md border border-border-subtle bg-surface-elevated px-2.5 py-1.5 text-[13px] text-text outline-none transition-colors focus:border-accent"
                      value={editPrompt()}
                      onInput={(e) => setEditPrompt(e.currentTarget.value)}
                    />
                  </label>

                  <div class="mt-3">
                    <RoutineScopesField value={editScopes()} onChange={setEditScopes} />
                  </div>

                  <div class="mt-3 flex flex-col gap-1.5">
                    <span class="text-[12px] text-text-tertiary">
                      {i18n.t("kernel.agentForms.agentModel")}
                    </span>
                    <select
                      data-testid="routine-edit-model-select"
                      class="rounded-md border border-border-subtle bg-surface-elevated px-2.5 py-1.5 text-[13px] text-text outline-none transition-colors focus:border-accent"
                      value={editAgentModelId() ?? ""}
                      onChange={(e) => setEditAgentModelId(e.currentTarget.value || null)}
                    >
                      <ModelOptions current={editAgentModelId()} />
                    </select>
                    <Show when={editAgentModelId()}>
                      <ReasoningLevelRow
                        modelId={editAgentModelId()}
                        level={editAgentReasoningLevel()}
                        onSelect={setEditAgentReasoningLevel}
                      />
                    </Show>
                  </div>

                  <div class="mt-3">
                    <RoutineRunsOnField
                      value={editRunsOn()}
                      onChange={setEditRunsOn}
                      testId="routine-edit-runs-on"
                      placement={editPlacement()}
                      onPlacementChange={setEditPlacement}
                      placementOwnerOnly={!isOwner(r())}
                    />
                  </div>

                  <div class="mt-3">
                    <RoutineApproverField
                      value={editApprover()}
                      onChange={setEditApprover}
                      testId="routine-edit-approver"
                    />
                  </div>

                  <div class="mt-3">
                    <RoutineTokenFields
                      budget={editTokenBudget()}
                      limit={editHardTokenLimit()}
                      onBudget={setEditTokenBudget}
                      onLimit={setEditHardTokenLimit}
                      testIdPrefix="routine-edit"
                    />
                  </div>

                  <div class="mt-4 flex items-center justify-end gap-2">
                    <button
                      type="button"
                      data-testid="routine-edit-cancel"
                      onClick={() => setEditing(false)}
                      class="rounded-md border border-border-subtle px-3 py-1.5 text-[12px] text-text-tertiary transition-colors hover:bg-surface-hover"
                    >
                      {i18n.t("kernel.agents.cancel")}
                    </button>
                    <button
                      type="button"
                      data-testid="routine-edit-save"
                      onClick={() => void saveEdit()}
                      disabled={saving()}
                      class="rounded-md bg-accent px-3 py-1.5 text-[12px] text-accent-foreground transition-colors disabled:opacity-50"
                    >
                      {saving()
                        ? i18n.t("kernel.agentForms.savingEllipsis")
                        : i18n.t("kernel.agents.save")}
                    </button>
                  </div>
                </div>
              </Show>

              <Show when={(r().scopes ?? []).length > 0}>
                <div class="border-b border-border-subtle px-6 py-4">
                  <h2 class="text-[12px] uppercase tracking-wide text-text-tertiary">
                    {i18n.t("kernel.agentForms.allowedScopes")}
                  </h2>
                  {/* A SCOPE NAME IS NEVER SHOWN (A14, charter agent.md): the
                    capability CATEGORIES stand in by their app or role NAME,
                    and a `kernel:agents:admin` viewer reads one phrase per
                    grant, with the identifier only in the chip's title. */}
                  <div class="mt-2 flex flex-wrap gap-2">
                    <Show
                      when={scopeAdmin()}
                      fallback={
                        <For each={capabilityCategories(r().scopes ?? [])}>
                          {(category) => (
                            <Chip
                              data-testid={`routine-capability-${category}`}
                              title={categoryChip(category, i18n.t).title}
                            >
                              {categoryChip(category, i18n.t).label}
                            </Chip>
                          )}
                        </For>
                      }
                    >
                      <For each={r().scopes}>
                        {(s) => (
                          <Chip data-testid={`routine-scope-${s}`} title={scopeIdTitle(s, i18n.t)}>
                            {scopeLabel(s, i18n.t)}
                          </Chip>
                        )}
                      </For>
                    </Show>
                  </div>
                </div>
              </Show>
            </div>
          </>
        )}
      </Show>
    </div>
  )
}

export default RoutineDetail
