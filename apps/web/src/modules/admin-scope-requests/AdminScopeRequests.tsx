// SPDX-License-Identifier: FSL-1.1-ALv2
import { capabilityLabel } from "@liaison/shared"
import { type Component, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"
import { Input } from "~/ui/Input"
import {
  decide,
  pendingRequests,
  type ScopeRequestRow,
  scopeRequestsStore,
} from "./scope-requests-store"

export const ScopeRequestItem: Component<{ row: ScopeRequestRow }> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [submitting, setSubmitting] = createSignal(false)
  const [showDeny, setShowDeny] = createSignal(false)
  const [denyReason, setDenyReason] = createSignal("")
  const [error, setError] = createSignal<string | null>(null)
  const [decided, setDecided] = createSignal<"approved" | "denied" | null>(null)
  const [reasonExpanded, setReasonExpanded] = createSignal(false)

  const run = async (decision: "approve" | "deny") => {
    if (submitting()) return
    setSubmitting(true)
    setError(null)
    const res = await decide(
      api,
      props.row.id,
      decision,
      decision === "deny" ? denyReason().trim() || undefined : undefined,
    )
    setSubmitting(false)
    if (res.ok) {
      setDecided(decision === "approve" ? "approved" : "denied")
    } else if (res.error) {
      setError(res.error)
    }
  }

  return (
    <li
      data-testid={`scope-request-${props.row.id}`}
      class="flex flex-col gap-2 rounded-md border border-border bg-surface px-4 py-3"
    >
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex min-w-0 flex-col gap-0.5">
          <span class="truncate font-medium text-sm text-text" data-testid="scope-request-asker">
            {props.row.requestedByName ?? props.row.requestedBy}
            {/* WHICH agent asked, the same "via <agent>" line an approval card
                carries. The name beside it is the human whose turn it was, and
                on its own it credited the person for something an agent did. */}
            <Show when={props.row.agentName}>
              {(name) => (
                <span class="ml-1.5 text-text-secondary">
                  {i18n.t("kernel.approvalViaAgent", { name: name() })}
                </span>
              )}
            </Show>
            <Show when={props.row.requestedByType === "agent"}>
              <span class="ml-1.5 rounded bg-accent-glow px-1.5 py-0.5 text-[10px] text-accent">
                {i18n.t("kernel.agent")}
              </span>
            </Show>
          </span>
          {/* THE SAME WORDS THE WITHHELD CARD USES, beside the raw scope. The
              row printed "ads:read" and nothing else, so an admin deciding on
              an access request had to know the scope catalog by heart to know
              what they were granting. The admin is entitled to the raw name,
              so it stays: the label is what makes it readable. */}
          <span class="text-text-tertiary text-xs" data-testid="scope-request-scopes">
            <For each={props.row.requestedScopes}>
              {(scope, index) => (
                <>
                  <Show when={index() > 0}>{", "}</Show>
                  <span>{capabilityLabel(scope)}</span>
                  <span class="ml-1 text-text-tertiary/70">({scope})</span>
                </>
              )}
            </For>
          </span>
          {/* THE REASON IS THE DECISION. It was clipped to one line by
              `truncate`, which on a sentence of any length showed the admin the
              first few words of the case for granting. It wraps now, and folds
              behind a "more" control past a few lines rather than pushing the
              queue off screen. */}
          <Show when={props.row.reason}>
            {(reason) => (
              <button
                type="button"
                data-testid="scope-request-reason"
                class={`whitespace-pre-wrap break-words text-left text-text-secondary text-xs italic ${
                  reasonExpanded() ? "" : "line-clamp-3"
                }`}
                onClick={() => setReasonExpanded((v) => !v)}
              >
                {reason()}
              </button>
            )}
          </Show>
        </div>
        <Show
          when={!decided()}
          fallback={<span class="shrink-0 text-text-tertiary text-xs capitalize">{decided()}</span>}
        >
          <div class="flex shrink-0 items-center gap-2">
            <Show
              when={!showDeny()}
              fallback={
                <>
                  <Input
                    data-testid={`scope-request-${props.row.id}-deny-reason`}
                    placeholder={i18n.t("kernel.reasonOptional")}
                    value={denyReason()}
                    onInput={(e) => setDenyReason((e.target as HTMLInputElement).value)}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={submitting()}
                    onClick={() => void run("deny")}
                  >
                    {i18n.t("kernel.deny")}
                  </Button>
                </>
              }
            >
              <Button size="sm" disabled={submitting()} onClick={() => void run("approve")}>
                {submitting() ? i18n.t("kernel.approving") : i18n.t("kernel.approve")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={submitting()}
                onClick={() => setShowDeny(true)}
              >
                {i18n.t("kernel.deny")}
              </Button>
            </Show>
          </div>
        </Show>
      </div>
      <Show when={error()}>
        <span data-testid="scope-request-decide-error" class="text-error text-xs">
          {error()}
        </span>
      </Show>
    </li>
  )
}

const AdminScopeRequests: Component = () => {
  const i18n = useI18n()
  const api = useApi()

  onMount(() => {
    scopeRequestsStore.start(api)
  })
  onCleanup(() => {
    scopeRequestsStore.stop()
  })

  return (
    <div class="flex flex-col gap-4">
      <Show
        when={pendingRequests().length > 0}
        fallback={<p class="text-text-tertiary text-sm">{i18n.t("kernel.noAccessRequests")}</p>}
      >
        <ul class="flex flex-col gap-2">
          <For each={pendingRequests()}>{(row) => <ScopeRequestItem row={row} />}</For>
        </ul>
      </Show>
    </div>
  )
}

export default AdminScopeRequests
