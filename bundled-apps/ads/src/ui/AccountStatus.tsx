// SPDX-License-Identifier: FSL-1.1-ALv2
//
// AdsAccountStatus: the "Account status" block of the declarative settings page
// (manifest `settings`). One read-only card per platform arm, each with a REAL
// status read: Meta Ads (`account_info`), Google Ads (`google_account_info`)
// and Merchant Center (`merchant_feed_status`). A failed read is not "not
// connected": a throttled or refused Meta read keeps its reason so the card
// says what actually happened. Connecting and editing credential values happen
// in the page's connections block, above this one.
import { type Component, createMemo, createSignal } from "solid-js"
import { app } from "@liaison/host"
import { Badge, Card, SectionLabel } from "./kit"
import { metaIssueFromError, toolErrorCode } from "./ui-logic"

interface AccountInfo {
  id: string
  name: string
  currency: string
  account_status: number
}

interface NotConnectedEnvelope {
  error?: { code?: string; message?: string }
}

interface GoogleAccountInfo extends NotConnectedEnvelope {
  customer_id?: string
  currency?: string
  time_zone?: string
}

interface MerchantFeedStatus extends NotConnectedEnvelope {
  totals?: unknown
}

type ArmState =
  | { kind: "connected"; detail: string }
  | { kind: "not_connected"; detail: string }
  | { kind: "unavailable"; detail: string }

function armBadge(state: ArmState): { tone: "success" | "neutral" | "warning"; label: string } {
  if (state.kind === "connected") return { tone: "success", label: "Connected" }
  if (state.kind === "not_connected") return { tone: "neutral", label: "Not connected" }
  return { tone: "warning", label: "Unavailable" }
}

const Arm: Component<{ title: string; state: ArmState; testid: string }> = (props) => (
  <Card>
    <SectionLabel>{props.title}</SectionLabel>
    <div class="mt-2 flex items-center gap-3" data-testid={props.testid}>
      <Badge tone={armBadge(props.state).tone}>{armBadge(props.state).label}</Badge>
      <span class="text-[12.5px] text-text-secondary">{props.state.detail}</span>
    </div>
  </Card>
)

export const AdsAccountStatus: Component = () => {
  const [metaFailure, setMetaFailure] = createSignal<unknown>(null)
  const [meta] = app.createResource(() =>
    app
      .invokeTool<AccountInfo>("account_info", {})
      .then((r) => {
        setMetaFailure(null)
        return r
      })
      .catch((e) => {
        setMetaFailure(e ?? new Error(""))
        return null
      }),
  )
  const [google] = app.createResource(() =>
    app.invokeTool<GoogleAccountInfo>("google_account_info", {}).catch(() => null),
  )
  const [merchant] = app.createResource(() =>
    app.invokeTool<MerchantFeedStatus>("merchant_feed_status", {}).catch(() => null),
  )

  const metaState = createMemo<ArmState>(() => {
    const a = meta()
    if (meta.loading) return { kind: "unavailable", detail: "Loading…" }
    if (a?.id) return { kind: "connected", detail: `${a.name} · ${a.currency}` }
    const failure = metaFailure()
    if (failure && toolErrorCode(failure) !== "meta_not_connected") {
      return { kind: "unavailable", detail: metaIssueFromError(failure).text }
    }
    return { kind: "not_connected", detail: "Add the System User token and ad account id in the Meta connection" }
  })

  const googleState = createMemo<ArmState>(() => {
    const g = google()
    if (google.loading) return { kind: "unavailable", detail: "Loading…" }
    if (g?.customer_id) return { kind: "connected", detail: `Customer ${g.customer_id} · ${g.currency ?? "?"}` }
    if (g?.error?.code === "google_not_connected") {
      return { kind: "not_connected", detail: g.error.message ?? "Google account not authorized yet" }
    }
    return { kind: "unavailable", detail: g?.error?.message ?? "Status read failed, try again later" }
  })

  const merchantState = createMemo<ArmState>(() => {
    const m = merchant()
    if (merchant.loading) return { kind: "unavailable", detail: "Loading…" }
    if (m && !m.error) return { kind: "connected", detail: "Feed reachable" }
    if (m?.error?.code === "merchant_not_configured") {
      return { kind: "not_connected", detail: "Optional: add the Merchant Center id in the Google Ads API settings connection" }
    }
    if (m?.error?.code === "google_not_connected") {
      return { kind: "not_connected", detail: "Connect Google Ads first" }
    }
    return { kind: "unavailable", detail: m?.error?.message ?? "Status read failed, try again later" }
  })

  return (
    <div data-testid="ads-account-status" class="flex flex-col gap-3">
      {/* The Meta arm keeps the original ads-settings-status testid (e2e contract). */}
      <Arm title="Meta Ads" state={metaState()} testid="ads-settings-status" />
      <Arm title="Google Ads" state={googleState()} testid="ads-settings-google" />
      <Arm title="Merchant Center" state={merchantState()} testid="ads-settings-merchant" />
    </div>
  )
}
