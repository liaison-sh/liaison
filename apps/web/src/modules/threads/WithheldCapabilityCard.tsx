// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The withheld-capability card.
//
// An agent answering in a room where not everyone holds the scopes it would
// need leaves those capabilities out and says so, to the requester only. The
// server has already narrowed the withheld set to category labels, so this
// component renders labels and the five fixed strings and decides nothing
// about visibility.
//
// The copy names nothing and promises nothing. The card is private to the
// requester, so a scope name, a tool name, a member name or a data value in it
// would be exactly the disclosure the card exists to avoid, and the labels are
// the categories the server already reduced the set to. Share anyway re-runs
// the turn with write tools disabled, so a disclosed answer can be thinner
// than the one that was withheld, and nothing here may claim otherwise.
//
// Two actions. "Continue in a DM" always is: the same question, asked where
// the floor is the requester's own, in the requester's 1:1 with this agent,
// opened on demand because a requester who has never spoken to it alone has no
// thread to fall back on. "Share anyway" re-runs the turn, so it appears only
// when every withheld item could actually be disclosed. A non-disclosable
// scope, or a scope-taint refusal, cannot be lifted by re-running at all: the
// action is hidden and the body says so. There is no "ask for this scope"
// action, because the server transports no scope name to ask for.

import { type Component, createSignal, For, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"

interface WithheldApi {
  post: (path: string, body?: unknown) => Promise<unknown>
}

/** One capability the turn left out, as the server already reduced it: a
 *  category label, plus why it cannot be shared here when it cannot. */
export interface WithheldItem {
  label: string
  /** An admin marked the scope non-disclosable: re-running would refuse. */
  nonDisclosable?: boolean
  /** The turn read scope-tainted context: a re-run is refused the same way,
   *  so Share anyway is not on offer for it either. */
  scopeTainted?: boolean
}

/** True when no item in the set could be disclosed by re-running the turn. */
export function isLiftable(items: WithheldItem[]): boolean {
  return items.length > 0 && items.every((i) => !i.nonDisclosable && !i.scopeTainted)
}

interface WithheldCapabilityCardProps {
  api: WithheldApi
  threadId: string
  messageId: string
  agentId: string | null
  items: WithheldItem[]
  /** Called with the id of the requester's DM with this agent once the card
   *  has opened or reused it, so the surface can put it on screen. */
  onContinueInDm?: (threadId: string) => void
}

function unwrapId(res: unknown): string | null {
  const body = (res as { data?: unknown })?.data ?? res
  const id = (body as { id?: unknown })?.id
  return typeof id === "string" ? id : null
}

function disclosedIds(res: unknown): string[] {
  const body = (res as { data?: unknown })?.data ?? res
  const ids = (body as { messageIds?: unknown })?.messageIds
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []
}

export const WithheldCapabilityCard: Component<WithheldCapabilityCardProps> = (props) => {
  const i18n = useI18n()
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<string | null>(null)
  const [disclosed, setDisclosed] = createSignal<string[] | null>(null)
  const liftable = () => isLiftable(props.items)
  const title = () => i18n.t("kernel.withheldCapabilitiesTitle")
  const body = () => {
    const text = i18n.t("kernel.withheldCapabilitiesBody")
    return liftable() ? text : `${text} ${i18n.t("kernel.withheldNotShareableHere")}`
  }
  async function run(action: () => Promise<unknown>, failed: (err: unknown) => string) {
    if (busy()) return
    setBusy(true)
    setFailure(null)
    try {
      await action()
    } catch (err) {
      setFailure(failed(err))
    } finally {
      setBusy(false)
    }
  }

  const shareAnyway = () =>
    void run(
      async () => {
        const res = await props.api.post(
          `/threads/${props.threadId}/messages/${props.messageId}/share-anyway`,
          {},
        )
        setDisclosed(disclosedIds(res))
      },
      // The server refuses a scope-taint rerun with a 409: it would read the
      // same tainted context and refuse the same way, which is what the fifth
      // string says.
      (err) =>
        (err as { status?: number })?.status === 409
          ? i18n.t("kernel.withheldNotShareableHere")
          : i18n.t("kernel.somethingWentWrong"),
    )

  // The DM is opened through the route rather than looked up locally: the
  // route answers the existing chat when there is one and creates it when
  // there is not, so the button works on the first press either way.
  // A card whose message names no agent has nowhere to continue: the route
  // would be asked to open a DM with nobody and answer 404, so the action is
  // off rather than offered and then refused.
  const canContinueInDm = () => typeof props.agentId === "string" && props.agentId.length > 0

  const continueInDm = () => {
    if (!canContinueInDm()) return
    void run(
      async () => {
        const res = await props.api.post("/threads/dm", { agentId: props.agentId })
        const id = unwrapId(res)
        if (!id) throw new Error("no thread")
        props.onContinueInDm?.(id)
      },
      // 404 is the one failure the requester can act on: the agent was archived
      // or is no longer theirs to talk to, so there is no DM to open and no
      // point retrying. Everything else is the generic failure.
      (err) =>
        (err as { status?: number })?.status === 404
          ? i18n.t("kernel.withheldDmUnavailable")
          : i18n.t("kernel.somethingWentWrong"),
    )
  }

  return (
    <Show when={props.items.length > 0}>
      <div
        data-testid="withheld-card"
        class="mt-1 rounded-lg border border-border-subtle bg-surface px-3 py-2.5"
      >
        <p data-testid="withheld-card-title" class="text-[13px] font-medium text-text">
          {title()}
        </p>
        <p data-testid="withheld-card-body" class="mt-1 text-[12px] text-text-secondary">
          {body()}
        </p>
        {/* EACH CHIP NAMES THE CAPABILITY. It used to render the label bare,
            and the label was always the generic one, so the whole card said
            "a capability" and the reader learned nothing from it. */}
        <ul data-testid="withheld-card-items" class="mt-1.5 flex flex-wrap gap-1.5">
          <For each={props.items}>
            {(item) => (
              <li
                data-testid="withheld-card-item"
                class="rounded bg-bg-subtle px-1.5 py-0.5 text-[11px] text-text-tertiary"
              >
                {i18n.t("kernel.withheldItemLabel", { label: item.label })}
              </li>
            )}
          </For>
        </ul>
        <div class="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="withheld-card-continue-in-dm"
            disabled={busy() || !canContinueInDm()}
            class="rounded-md bg-accent px-2.5 py-0.5 text-[12px] text-accent-foreground disabled:opacity-50"
            onClick={continueInDm}
          >
            {i18n.t("kernel.withheldContinueInDm")}
          </button>
          <Show when={liftable() && !disclosed()}>
            <button
              type="button"
              data-testid="withheld-card-share-anyway"
              disabled={busy()}
              class="rounded-md border border-border-subtle px-2.5 py-0.5 text-[12px] text-text-secondary disabled:opacity-50"
              onClick={shareAnyway}
            >
              {i18n.t("kernel.withheldShareAnyway")}
            </button>
          </Show>
        </div>
        <Show when={disclosed()}>
          {(ids) => (
            <p
              data-testid="withheld-card-disclosed"
              data-message-ids={ids().join(" ")}
              class="mt-1.5 text-[11px] text-text-tertiary"
            />
          )}
        </Show>
        <Show when={failure()}>
          {(text) => (
            <p data-testid="withheld-card-failure" class="mt-1.5 text-[11px] text-amber-500">
              {text()}
            </p>
          )}
        </Show>
      </div>
    </Show>
  )
}
