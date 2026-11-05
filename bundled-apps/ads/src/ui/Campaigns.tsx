// SPDX-License-Identifier: FSL-1.1-ALv2
import { type Component, createMemo, createResource, createSignal, Show } from "solid-js"
import { app, navigate } from "@liaison/host"
import { CardTable, type CardTableColumn } from "@liaison/app-ui/card-table"
import {
  Badge, Button, Card, ConfirmDialog, cx, EmptyState, MetaIssueNote, Money, PageHeader, SectionLabel, StatusBadge,
} from "./kit"
import { budgetMinorToMajor, type MetaIssue, metaIssueFromError, toolData, toolErrorCode, toolRows } from "./ui-logic"

// ── Types ──────────────────────────────────────────────────────────────────────

interface AccountInfo {
  id: string
  name: string
  currency: string
  account_status: number
}

interface CampaignRow {
  id: string
  name: string
  status: string
  effective_status: string
  objective?: string | null
  daily_budget?: string | null
  lifetime_budget?: string | null
}

interface AdSetRow {
  id: string
  name: string
  status: string
  effective_status: string
  daily_budget?: string | null
  lifetime_budget?: string | null
}

interface AdRow {
  id: string
  name: string
  status: string
  effective_status: string
}

// Google Ads campaign shape from google_campaigns_list. budget_amount is
// ALREADY major units (converted from micros at the tool boundary) — never
// re-scale it here.
interface GoogleCampaignRow {
  id: string
  name: string
  status: string
  advertising_channel_type?: string | null
  budget_amount?: number | null
}
interface GoogleCampaignsResult {
  campaigns?: GoogleCampaignRow[]
  count?: number
  error?: { code?: string; message?: string }
}

// Google status → delivery tone. ENABLED delivers; PAUSED/REMOVED do not.
function googleStatusTone(status: string): "success" | "muted" | "neutral" {
  switch (status) {
    case "ENABLED": return "success"
    case "PAUSED":
    case "REMOVED": return "muted"
    default: return "neutral"
  }
}

// ── CampaignDetailPanel ─────────────────────────────────────────────────────────

export const CampaignDetailPanel: Component<{
  id?: string
  campaignRow?: CampaignRow | null
  onChanged?: () => void
  /** Inline (accordion-row) mount: natural height, no full-pane scroll wrapper. */
  inline?: boolean
}> = (props) => {
  // cid resolves from either the kernel detail mount (props.id) or inline seed (props.campaignRow.id)
  const cid = createMemo(() => props.campaignRow?.id ?? props.id ?? null)

  const [acct] = app.createResource(() => app.invokeTool<AccountInfo>("account_info", {}).catch(() => null))
  const [adsets] = createResource(cid, (id) => app.invokeTool<{ data: AdSetRow[] }>("adsets_list", { campaign_id: id }).catch(() => null))
  const [ads] = createResource(cid, (id) => app.invokeTool<{ data: AdRow[] }>("ads_list", { campaign_id: id }).catch(() => null))
  const adsetRows = createMemo(() => toolRows<AdSetRow>(adsets()))
  const adRows = createMemo(() => toolRows<AdRow>(ads()))
  const [insights] = createResource(cid, (id) =>
    app.invokeTool<{ data: unknown[] }>("insights_query", { level: "campaign", date_preset: "last_30d", campaign_id: id }).catch(() => null)
  )

  const [pauseOpen, setPauseOpen] = createSignal(false)
  const [resumeOpen, setResumeOpen] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [note, setNote] = createSignal<{ kind: "ok" | "err"; text: string } | null>(null)

  // Deep-link fallback: when mounted via /detail/ads/campaign/:id with no campaignRow,
  // fetch the row from campaigns_list so StatusBadge/title/Pause-Resume guards work.
  const [fetchedRow] = createResource(
    () => (!props.campaignRow && cid() ? cid() : null),
    (id) =>
      app
        .invokeTool<{ data: CampaignRow[] }>("campaigns_list", {})
        .then((r) => toolRows<CampaignRow>(r).find((c) => c.id === id) ?? null)
        .catch(() => null),
  )
  const campaign = createMemo(() => props.campaignRow ?? fetchedRow() ?? null)
  const isAlreadyPaused = createMemo(() => {
    const es = campaign()?.effective_status ?? ""
    return es.includes("PAUSED") || es === "ARCHIVED" || es === "DELETED"
  })
  const isAlreadyActive = createMemo(() => campaign()?.effective_status === "ACTIVE")

  const run = async (action: () => Promise<unknown>, ok: string) => {
    if (busy()) return
    setBusy(true)
    setNote(null)
    try {
      await action()
      props.onChanged?.()
      setNote({ kind: "ok", text: ok })
    } catch (e) {
      setNote({ kind: "err", text: metaIssueFromError(e).text })
    } finally {
      setBusy(false)
    }
  }

  const doPause = () => {
    const id = cid()
    if (!id) return
    // `pause` is a GATED tool: a gated invocation resolves with a blocked
    // envelope ({ blocked: { reason: "gated", approvalRequestId, ... } }) instead
    // of executing. In that case an approval is pending, so do NOT claim "Paused"
    // and do NOT optimistically flip the row status (skip onChanged/refetch).
    void (async () => {
      if (busy()) return
      setBusy(true)
      setNote(null)
      try {
        const res = await app.invokeTool<{ blocked?: { reason?: string } }>("pause", { object_id: id })
        if (res && typeof res === "object" && "blocked" in res && res.blocked) {
          setNote({ kind: "ok", text: "Pause requested: pending approval" })
        } else {
          props.onChanged?.()
          setNote({ kind: "ok", text: "Paused." })
        }
      } catch (e) {
        setNote({ kind: "err", text: metaIssueFromError(e).text })
      } finally {
        setBusy(false)
      }
    })()
  }
  const doResume = () => {
    const id = cid()
    if (!id) return
    void run(() => app.invokeTool("set_status", { object_id: id, status: "ACTIVE" }), "Resumed.")
  }

  const currency = () => acct()?.currency ?? "USD"

  return (
    <Show
      when={cid()}
      keyed
      fallback={<EmptyState title="No campaign selected">Pick a campaign from the list.</EmptyState>}
    >
      {(id) => (
        <div
          data-testid={`ads-campaign-detail-${id}`}
          class={cx("flex flex-col gap-4 p-4", props.inline ? "" : "min-h-full")}
        >
          <div class="flex items-center gap-2">
            <Show when={campaign()}>
              {(c) => <StatusBadge effectiveStatus={c().effective_status} />}
            </Show>
            <span class="text-[12px] font-medium text-text">{campaign()?.name ?? id}</span>
          </div>

          {/* Quick actions */}
          <div class="flex items-center gap-2">
            <Button
              variant="secondary"
              testid={`ads-pause-${id}`}
              disabled={busy() || isAlreadyPaused()}
              onClick={() => setPauseOpen(true)}
            >
              Pause
            </Button>
            <Button
              variant="ghost"
              testid={`ads-resume-${id}`}
              disabled={busy() || isAlreadyActive()}
              onClick={() => setResumeOpen(true)}
            >
              Resume
            </Button>
            <Show when={note()} keyed>
              {(n) => (
                <span class={cx("text-[11.5px]", n.kind === "ok" ? "text-success" : "text-error")}>
                  {n.text}
                </span>
              )}
            </Show>
          </div>

          <ConfirmDialog
            open={pauseOpen()}
            title={`Pause ${campaign()?.name ?? id}?`}
            body="This stops spend immediately."
            confirmLabel="Pause"
            danger
            busy={busy()}
            onConfirm={() => { setPauseOpen(false); doPause() }}
            onCancel={() => setPauseOpen(false)}
          />
          <ConfirmDialog
            open={resumeOpen()}
            title={`Resume ${campaign()?.name ?? id}?`}
            body="This restarts spend."
            confirmLabel="Resume"
            busy={busy()}
            onConfirm={() => { setResumeOpen(false); doResume() }}
            onCancel={() => setResumeOpen(false)}
          />

          {/* Ad sets */}
          <Card>
            <SectionLabel>Ad Sets</SectionLabel>
            <Show when={adsetRows().length > 0} fallback={<span class="text-[12px] text-text-tertiary">No ad sets.</span>}>
              <CardTable
                rows={adsetRows()}
                rowKey={(s) => s.id}
                columns={
                  [
                    { key: "name", header: "Name", role: "anchor", cell: (s) => s.name },
                    {
                      key: "status",
                      header: "Status",
                      role: "meta",
                      cell: (s) => <StatusBadge effectiveStatus={s.effective_status} />,
                    },
                    {
                      key: "budget",
                      header: "Budget",
                      role: "meta",
                      numeric: true,
                      cell: (s) => (
                        <Money
                          value={budgetMinorToMajor(s.daily_budget ?? s.lifetime_budget ?? null, currency())}
                          currency={currency()}
                        />
                      ),
                    },
                  ] as Array<CardTableColumn<AdSetRow>>
                }
              />
            </Show>
          </Card>

          {/* Insights */}
          <Show when={insights()}>
            {(ins) => (
              <Card>
                <SectionLabel>30-Day Insights</SectionLabel>
                <div class="mt-2 text-[12px] text-text-secondary">
                  {toolRows(ins()).length} data points
                </div>
              </Card>
            )}
          </Show>
        </div>
      )}
    </Show>
  )
}

// ── CampaignsTab ───────────────────────────────────────────────────────────────

export const CampaignsTab: Component = () => {
  // A throttled or refused Meta read is not "no connection": keep its reason.
  const [acctIssue, setAcctIssue] = createSignal<MetaIssue | null>(null)
  const [acct, { refetch: refetchAcct }] = app.createResource(() =>
    app
      .invokeTool<AccountInfo>("account_info", {})
      .then((r) => { setAcctIssue(null); return r })
      .catch((e) => {
        setAcctIssue(toolErrorCode(e) === "meta_not_connected" ? null : metaIssueFromError(e))
        return null
      }),
  )
  const [listIssue, setListIssue] = createSignal<MetaIssue | null>(null)
  const [rows, { refetch }] = app.createResource(() =>
    app
      .invokeTool<{ data: CampaignRow[] }>("campaigns_list", {})
      .then((r) => { setListIssue(null); return r })
      .catch((e) => { setListIssue(metaIssueFromError(e)); return null }),
  )
  // Accordion: id of the expanded row, or null (collapsed). Clicking a row
  // toggles its inline detail; only one row is expanded at a time.
  const [expanded, setExpanded] = createSignal<string | null>(null)
  const toggle = (id: string) => setExpanded((cur) => (cur === id ? null : id))

  // Google Ads campaigns. The tool returns the not-connected envelope as DATA
  // (never throws), so a bare .catch here only guards a genuine transport
  // failure; the "not connected" note is driven by the returned error code.
  const [googleAcct] = app.createResource(() =>
    app.invokeTool<{ currency?: string; error?: { code?: string } }>("google_account_info", {}).catch(() => null),
  )
  const [google] = app.createResource(() =>
    app.invokeTool<GoogleCampaignsResult>("google_campaigns_list", {}).catch(() => null),
  )
  const googleNotConnected = createMemo(
    () => google()?.error?.code === "google_not_connected" || googleAcct()?.error?.code === "google_not_connected",
  )
  const googleRows = createMemo<GoogleCampaignRow[]>(() =>
    toolRows<GoogleCampaignRow>(google(), "campaigns"),
  )
  const googleCurrency = createMemo(() => toolData(googleAcct())?.currency ?? "USD")

  const visible = createMemo<CampaignRow[]>(() => toolRows<CampaignRow>(rows()))
  const currency = createMemo(() => toolData(acct())?.currency ?? "USD")

  // noAccount is based on the account_info resource, NOT the campaigns list.
  // This avoids a "Not connected" flash during list load and correctly shows
  // EmptyState for an account with no campaigns instead of the connect prompt.
  // An error envelope answered as data is "no account", exactly like a null
  // read: without this, a workspace with nothing connected skipped the connect
  // prompt and painted an empty campaigns table instead.
  const noAccount = createMemo(
    () => !acctIssue() && (acct.error !== undefined || (!acct.loading && toolData(acct()) === null)),
  )
  const metaIssue = createMemo(() => acctIssue() ?? listIssue())

  return (
    <div class="flex h-full min-h-0 flex-col">
      <PageHeader title="Campaigns" subtitle="Ad campaigns with effective delivery status and budget" />
      <Show when={metaIssue()}>
        {(issue) => (
          <MetaIssueNote
            testid="ads-campaigns-issue"
            class="p-4"
            issue={issue()}
            onRetry={() => {
              void refetchAcct()
              void refetch()
            }}
          />
        )}
      </Show>
      <Show when={noAccount()}>
        <div class="p-4 text-[13px] text-text-secondary">
          No Meta Ads connection. <a href="/settings/apps/ads" class="text-accent underline">Connect in Settings</a>
        </div>
      </Show>
      <div class="min-h-0 flex-1 overflow-y-auto">
        <Show when={!noAccount()}>
          {/* ── Meta Ads ─────────────────────────────────────────────────── */}
          {/* Full-width table; clicking a row expands its detail inline (accordion). */}
          <div class="border-b border-border-subtle px-4 pt-3 pb-1">
            <SectionLabel>Meta Ads</SectionLabel>
          </div>
          <Show
            when={(visible()).length > 0}
            fallback={
              <Show when={!metaIssue()}>
                <EmptyState title="No campaigns yet">Create a campaign in Ads Manager.</EmptyState>
              </Show>
            }
          >
            <div data-testid="ads-campaigns-table">
              <CardTable
                rows={visible()}
                rowKey={(r) => r.id}
                rowTestid={(r) => `ads-campaign-row-${r.id}`}
                onRowClick={(r) => toggle(r.id)}
                // The accordion detail belongs UNDER the campaign it describes.
                // Rendered after the whole table it sat pages away from its own
                // row once the list was more than a screen tall.
                renderDetail={(r) =>
                  expanded() === r.id ? (
                    <div
                      data-testid={`ads-campaign-detail-row-${r.id}`}
                      class="border-t border-border-subtle bg-elevated"
                    >
                      <CampaignDetailPanel inline campaignRow={r} onChanged={() => void refetch()} />
                    </div>
                  ) : null
                }
                columns={
                  [
                    {
                      key: "name",
                      header: "Name",
                      role: "anchor",
                      cell: (r) => <span class="truncate">{r.name}</span>,
                    },
                    {
                      key: "objective",
                      header: "Objective",
                      role: "secondary",
                      cell: (r) => r.objective ?? "-",
                    },
                    {
                      key: "status",
                      header: "Status",
                      role: "meta",
                      cell: (r) => <StatusBadge effectiveStatus={r.effective_status} />,
                    },
                    {
                      key: "budget",
                      header: "Budget",
                      role: "meta",
                      numeric: true,
                      align: "right",
                      cell: (r) => (
                        <Show
                          when={r.daily_budget ?? r.lifetime_budget}
                          fallback={<span class="text-text-tertiary">-</span>}
                        >
                          <Money
                            value={budgetMinorToMajor(r.daily_budget ?? r.lifetime_budget ?? null, currency())}
                            currency={currency()}
                          />
                        </Show>
                      ),
                    },
                    {
                      key: "open",
                      header: "Detail",
                      role: "fold",
                      cell: (r) => (
                        <button
                          type="button"
                          data-testid={`ads-campaign-detail-link-${r.id}`}
                          title="Open in detail tab"
                          aria-label="Open in detail tab"
                          onClick={(e) => {
                            e.stopPropagation()
                            navigate(`/detail/ads/campaign/${encodeURIComponent(r.id)}`)
                          }}
                          class="rounded px-1 py-0.5 text-[11px] text-text-tertiary hover:text-accent hover:bg-surface-hover transition-colors"
                        >
                          Open in detail tab ↗
                        </button>
                      ),
                    },
                  ] as Array<CardTableColumn<CampaignRow>>
                }
              />
            </div>
          </Show>
        </Show>

        {/* ── Google Ads ───────────────────────────────────────────────────── */}
        <div class="mt-2 border-t border-border-subtle px-4 pt-3 pb-1">
          <SectionLabel>Google Ads</SectionLabel>
        </div>
        <Show
          when={!googleNotConnected()}
          fallback={
            <div data-testid="ads-google-not-connected" class="px-4 pb-4 text-[12.5px] text-text-tertiary">
              Google Ads not connected. <a href="/settings/apps/ads" class="text-accent underline">Connect in Settings</a>
            </div>
          }
        >
          <Show
            when={googleRows().length > 0}
            fallback={
              <div class="px-4 pb-4 text-[12.5px] text-text-tertiary">No Google Ads campaigns.</div>
            }
          >
            <div data-testid="ads-google-campaigns-table">
              <CardTable
                rows={googleRows()}
                rowKey={(r) => r.id}
                rowTestid={(r) => `ads-google-campaign-row-${r.id}`}
                columns={
                  [
                    {
                      key: "name",
                      header: "Name",
                      role: "anchor",
                      cell: (r) => <span class="truncate">{r.name}</span>,
                    },
                    {
                      key: "type",
                      header: "Type",
                      role: "secondary",
                      cell: (r) => r.advertising_channel_type ?? "-",
                    },
                    {
                      key: "status",
                      header: "Status",
                      role: "meta",
                      cell: (r) => (
                        <Badge tone={googleStatusTone(r.status)} dot>
                          {r.status}
                        </Badge>
                      ),
                    },
                    {
                      key: "budget",
                      header: "Budget",
                      role: "meta",
                      numeric: true,
                      align: "right",
                      // budget_amount is ALREADY major units from the tool; never rescale.
                      cell: (r) => (
                        <Show
                          when={r.budget_amount != null}
                          fallback={<span class="text-text-tertiary">-</span>}
                        >
                          <Money value={r.budget_amount ?? null} currency={googleCurrency()} />
                        </Show>
                      ),
                    },
                  ] as Array<CardTableColumn<GoogleCampaignRow>>
                }
              />
            </div>
          </Show>
        </Show>
      </div>
    </div>
  )
}
