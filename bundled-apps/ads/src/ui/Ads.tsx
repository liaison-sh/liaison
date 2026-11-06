// SPDX-License-Identifier: FSL-1.1-ALv2
import { type Component, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { app } from "@liaison/host"
import { AdPreviewDrawer, EmptyState, MetaIssueNote, PageHeader } from "./kit"
import { type MetaIssue, metaIssueFromError, toolData, toolRows } from "./ui-logic"

const PLACEMENTS = [
  { value: "DESKTOP_FEED_STANDARD", label: "Desktop Feed" },
  { value: "MOBILE_FEED_STANDARD", label: "Mobile Feed" },
  { value: "INSTAGRAM_STANDARD", label: "Instagram Feed" },
  { value: "INSTAGRAM_STORY", label: "Instagram Story" },
]

interface AdRow {
  id: string
  name: string
  status: string
  effective_status: string
  creative?: { id: string } | null
}

interface CreativeResult {
  creative_id: string | null
  thumbnail_url: string | null
  image_urls: string[]
  video_id: string | null
  headline: string | null
  body: string | null
  reason?: string
}

interface PreviewResult {
  previews?: Array<{ ad_format: string; body: string | null }>
  ad_format?: string
  body?: string | null
}

function extractIframeSrc(body: string | null | undefined): string | null {
  if (!body) return null
  const m = body.match(/src=["']([^"']+)["']/)
  return m?.[1] ?? null
}

const AdTile: Component<{ adId: string; adName: string; onOpen: (adId: string) => void }> = (props) => {
  const [creative] = app.createResource(() =>
    app.invokeTool<CreativeResult>("creative_get", { ad_id: props.adId }).catch(() => null)
  )

  return (
    <button
      type="button"
      data-testid={`ads-ad-thumb-${props.adId}`}
      onClick={() => props.onOpen(props.adId)}
      class="group relative flex aspect-square flex-col overflow-hidden rounded-lg border border-border bg-surface hover:border-accent transition-colors"
      title={props.adName}
    >
      <Show when={creative.loading}>
        <div data-testid={`ads-ad-thumb-skeleton-${props.adId}`} class="flex-1 animate-pulse bg-surface-hover" />
      </Show>
      <Show when={!creative.loading}>
        <Show
          when={toolData(creative())?.thumbnail_url}
          fallback={
            <div class="flex flex-1 items-center justify-center bg-surface text-[11px] text-text-tertiary">
              {toolData(creative())?.reason === "no_creative" ? "No creative" : "-"}
            </div>
          }
        >
          {(src) => (
            <img
              src={src()}
              alt={props.adName}
              class="h-full w-full object-cover"
              loading="lazy"
            />
          )}
        </Show>
      </Show>
      <div class="absolute bottom-0 left-0 right-0 truncate bg-black/50 px-1.5 py-0.5 text-[10px] text-white">
        {props.adName}
      </div>
    </button>
  )
}

export const AdsTab: Component = () => {
  // Bounded paging: ads_list returns ONE page (default limit 50, delivering +
  // paused only) plus an `after` cursor. Draining the whole edge in one
  // sandboxed call times out on real accounts, so we accumulate pages here and
  // expose a "load more" affordance driven by the cursor.
  const [ads, setAds] = createSignal<AdRow[]>([])
  const [cursor, setCursor] = createSignal<string | null>(null)
  const [loading, setLoading] = createSignal(true)
  const [loadingMore, setLoadingMore] = createSignal(false)
  const [errored, setErrored] = createSignal(false)
  const [issue, setIssue] = createSignal<MetaIssue | null>(null)

  const loadPage = async (after: string | null) => {
    try {
      const res = await app.invokeTool<{ data: AdRow[]; after?: string | null }>(
        "ads_list",
        after ? { after } : {},
      )
      const page = toolRows<AdRow>(res)
      setAds((prev) => (after ? [...prev, ...page] : page))
      setCursor(toolData(res)?.after ?? null)
      setErrored(false)
      setIssue(null)
    } catch (e) {
      setErrored(true)
      setIssue(metaIssueFromError(e))
    }
  }

  void loadPage(null).finally(() => setLoading(false))

  const loadMore = () => {
    const after = cursor()
    if (!after || loadingMore()) return
    setLoadingMore(true)
    void loadPage(after).finally(() => setLoadingMore(false))
  }

  const [openAdId, setOpenAdId] = createSignal<string | null>(null)
  app.trackOpenRecord("ad", openAdId)
  const [placement, setPlacement] = createSignal("DESKTOP_FEED_STANDARD")

  const openAd = createMemo(() => {
    const id = openAdId()
    if (!id) return null
    return ads().find((r) => r.id === id) ?? null
  })

  const [previews] = createResource(openAdId, (adId) => {
    if (!adId) return null
    return app.invokeTool<PreviewResult>("ad_preview", {
      ad_id: adId,
      ad_formats: PLACEMENTS.map((p) => p.value),
    }).catch(() => null)
  })

  const iframeSrc = createMemo(() => {
    const pres = toolData(previews())
    if (!pres?.previews) return null
    const entry = pres.previews.find((p) => p.ad_format === placement())
    return extractIframeSrc(entry?.body)
  })

  const [creativeForOpen] = createResource(openAdId, (adId) => {
    if (!adId) return null
    return app.invokeTool<CreativeResult>("creative_get", { ad_id: adId }).catch(() => null)
  })

  const fallbackThumb = createMemo(() => toolData(creativeForOpen())?.thumbnail_url ?? null)
  const adsManagerUrl = createMemo(() => {
    const id = openAdId()
    return id ? `https://www.facebook.com/adsmanager/manage/ads?selectedAdIds=${id}` : null
  })

  return (
    <div class="flex h-full min-h-0 flex-col">
      <PageHeader title="Ads" subtitle="Creative thumbnails, click to preview" />
      <Show when={errored()}>
        <MetaIssueNote
          testid="ads-list-issue"
          class="p-4"
          issue={issue() ?? metaIssueFromError(null)}
          onRetry={() => {
            setLoading(true)
            void loadPage(null).finally(() => setLoading(false))
          }}
        />
      </Show>
      <Show when={!errored() && !loading() && ads().length === 0}>
        <EmptyState title="No ads yet">Create an ad in Ads Manager.</EmptyState>
      </Show>
      <Show when={ads().length > 0}>
        <div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <div
            data-testid="ads-ads-grid"
            class="grid grid-cols-3 gap-3 p-4 md:grid-cols-4 lg:grid-cols-5"
          >
            <For each={ads()}>
              {(ad) => (
                <AdTile adId={ad.id} adName={ad.name} onOpen={(id) => { setOpenAdId(id); setPlacement("DESKTOP_FEED_STANDARD") }} />
              )}
            </For>
          </div>
          <Show when={cursor()}>
            <div class="flex justify-center px-4 pb-4">
              <button
                type="button"
                data-testid="ads-ads-load-more"
                onClick={loadMore}
                disabled={loadingMore()}
                class="rounded-md border border-border bg-surface px-3 py-1.5 text-[12.5px] text-text hover:bg-surface-hover disabled:opacity-50"
              >
                {loadingMore() ? "Loading…" : "Load more"}
              </button>
            </div>
          </Show>
        </div>
      </Show>

      <AdPreviewDrawer
        open={openAdId() !== null}
        title={openAd()?.name ?? "Ad Preview"}
        iframeSrc={iframeSrc()}
        fallbackThumb={fallbackThumb()}
        adsManagerUrl={adsManagerUrl()}
        placement={placement()}
        placements={PLACEMENTS}
        onPlacement={setPlacement}
        onClose={() => setOpenAdId(null)}
        busy={previews.loading}
      />
    </div>
  )
}
