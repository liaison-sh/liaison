// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Archiving an agent, and the one thing that stops it.
//
// An agent that still owns skills or routines cannot be archived: those assets
// would be left without an owner. The server answers the archive call with the
// assets that block it, this surface names them, and each one can be handed to
// another agent from here. Once nothing blocks it, the same archive call goes
// through, which is why the button is re-issued rather than replaced.

import { type Component, createMemo, createSignal, For, Show } from "solid-js"
import { ApiError } from "~/lib/api-error"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { listAgentDirectory } from "~/modules/threads/agent-directory"

interface BlockingAsset {
  id: string
  name: string
}

/** What a 409 carries on `error.details`: the assets that still name this
 *  agent as their owner. Anything else on the error is not a blocker list. */
interface ArchiveBlockers {
  routines: BlockingAsset[]
  skills: BlockingAsset[]
}

function assetList(value: unknown): BlockingAsset[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (a): a is BlockingAsset =>
      typeof (a as BlockingAsset)?.id === "string" &&
      typeof (a as BlockingAsset)?.name === "string",
  )
}

/** The blockers a failed archive names, or null when the failure is anything
 *  else (a permission refusal, a network error) and must be reported as one. */
function readBlockers(err: unknown): ArchiveBlockers | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null
  const details = err.details
  if (details?.blocked !== true) return null
  return { routines: assetList(details.routines), skills: assetList(details.skills) }
}

interface AgentArchiveAdminProps {
  agentId: string
}

const AgentArchiveAdmin: Component<AgentArchiveAdminProps> = (props) => {
  const api = useApi()
  const i18n = useI18n()
  const [blocked, setBlocked] = createSignal<ArchiveBlockers | null>(null)
  const [archivedAt, setArchivedAt] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  // Anyone but the agent being archived. An org with a single agent has nobody
  // to hand the work to, so the reassign controls stay inert rather than
  // pretending there is a choice.
  const candidates = createMemo(() => listAgentDirectory().filter((a) => a.id !== props.agentId))
  const [target, setTarget] = createSignal<string | null>(null)
  const chosenTarget = () => target() ?? candidates()[0]?.id ?? null

  const routines = () => blocked()?.routines ?? []
  const skills = () => blocked()?.skills ?? []

  async function archive() {
    if (busy()) return
    setBusy(true)
    setError(null)
    try {
      const res: any = await api.post(`/agents/${props.agentId}/archive`, {})
      const result = res?.data ?? res
      setBlocked(null)
      setArchivedAt(result?.archivedAt ?? new Date().toISOString())
    } catch (err) {
      const blockers = readBlockers(err)
      if (blockers) setBlocked(blockers)
      else setError(i18n.t("kernel.somethingWentWrong"))
    } finally {
      setBusy(false)
    }
  }

  async function reassign(kind: "routines" | "skills", assetId: string) {
    const ownerAgentId = chosenTarget()
    if (!ownerAgentId) return
    setError(null)
    try {
      await api.patch(`/agent/${kind}/${assetId}`, { ownerAgentId })
      const remaining = (() => {
        const current = blocked()
        if (!current) return null
        const next: ArchiveBlockers = {
          routines: current.routines.filter((a) => kind !== "routines" || a.id !== assetId),
          skills: current.skills.filter((a) => kind !== "skills" || a.id !== assetId),
        }
        setBlocked(next)
        return next
      })()
      // Reassigning the last blocker is the whole point of the list, so the
      // archive the 409 refused is retried here rather than asking the admin
      // to press Archive again. A still-blocked retry simply re-renders the
      // list the server sends back.
      if (remaining && remaining.routines.length === 0 && remaining.skills.length === 0) {
        await archive()
      }
    } catch {
      setError(i18n.t("kernel.somethingWentWrong"))
    }
  }

  const assetRow = (kind: "routines" | "skills", asset: BlockingAsset) => (
    <li class="flex items-center justify-between gap-2 px-2 py-1.5">
      <span class="truncate text-[13px] text-text">{asset.name}</span>
      <button
        type="button"
        data-testid={`reassign-${kind === "routines" ? "routine" : "skill"}-${asset.id}`}
        disabled={!chosenTarget()}
        class="shrink-0 rounded-md border border-border-subtle px-2 py-0.5 text-[12px] text-text-secondary disabled:opacity-50"
        onClick={() => void reassign(kind, asset.id)}
      >
        {i18n.t("kernel.agentUi.reassign")}
      </button>
    </li>
  )

  return (
    <div data-testid="agent-archive-admin" class="flex flex-col gap-3 px-4 py-3">
      <div class="flex items-center gap-2">
        <button
          type="button"
          data-testid="agent-archive"
          disabled={busy()}
          class="rounded-md border border-border-subtle px-3 py-1 text-[12px] text-text-secondary disabled:opacity-50"
          onClick={() => void archive()}
        >
          {i18n.t("kernel.common.archive")}
        </button>
        <Show when={candidates().length > 0}>
          <select
            data-testid="agent-archive-reassign-target"
            class="rounded-md border border-border-subtle bg-surface-elevated px-2 py-1 text-[12px] text-text"
            value={chosenTarget() ?? ""}
            onChange={(e) => setTarget(e.currentTarget.value || null)}
          >
            <For each={candidates()}>
              {(agent) => <option value={agent.id}>{agent.name}</option>}
            </For>
          </select>
        </Show>
      </div>

      <Show when={archivedAt()}>
        <p data-testid="agent-archived" class="text-[12px] text-text-tertiary">
          {i18n.t("kernel.agentUi.archived")}
        </p>
      </Show>

      <Show when={blocked()}>
        <div>
          <p data-testid="agent-archive-blocked" class="text-[12px] text-amber-500">
            {i18n.t("kernel.agentArchiveBlocked")}
          </p>
          <Show when={routines().length > 0}>
            <ul class="mt-2 divide-y divide-border-subtle">
              <For each={routines()}>{(asset) => assetRow("routines", asset)}</For>
            </ul>
          </Show>
          <Show when={skills().length > 0}>
            <ul class="mt-2 divide-y divide-border-subtle">
              <For each={skills()}>{(asset) => assetRow("skills", asset)}</For>
            </ul>
          </Show>
        </div>
      </Show>

      <Show when={error()}>{(text) => <p class="text-[12px] text-amber-500">{text()}</p>}</Show>
    </div>
  )
}

export default AgentArchiveAdmin
