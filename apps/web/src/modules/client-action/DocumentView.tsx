// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The document a person reads before they act. A generated document comes as its
// frozen blocks, drawn here as plain text; an uploaded file comes as the server's
// pictures of its pages, fetched one by one by POST into a blob as they come into
// view. Nothing parses a PDF in this browser, and no text from the server is ever
// rendered as markup. `onReachedEnd` fires once, when the last part (the last
// page's picture, loaded) is in view.

import {
  type Component,
  createSignal,
  For,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { postPublicFile } from "./public-api"

export interface PageEntry {
  n: number
  sha256: string
  text: string | null
}

export type DocumentContent =
  | { format: "blocks"; blocks: unknown[] }
  | { format: "pages"; pages: PageEntry[] }

/** Calls `cb` when `el` is in view; a browser without the observer counts it as seen. */
export function whenInView(el: Element, cb: () => void, rootMargin = "0px"): () => void {
  if (typeof IntersectionObserver === "undefined") {
    cb()
    return () => {}
  }
  const io = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) cb()
    },
    { rootMargin },
  )
  io.observe(el)
  return () => io.disconnect()
}

/** Whether frozen blocks hold any text a person can read (headings, paragraphs, items, cells). */
export function blocksHaveText(blocks: unknown): boolean {
  const walk = (v: unknown): boolean => {
    if (typeof v === "string") return v.trim() !== ""
    if (Array.isArray(v)) return v.some(walk)
    if (v && typeof v === "object")
      return Object.entries(v).some(([k, x]) => k !== "type" && k !== "fileId" && walk(x))
    return false
  }
  return walk(blocks)
}

function str(v: unknown): string {
  return typeof v === "string" ? v : ""
}

type Block = Record<string, unknown>

const BlockView: Component<{ block: Block }> = (props) => {
  const i18n = useI18n()
  const b = () => props.block
  return (
    <Switch>
      <Match when={b().type === "heading"}>
        <h3
          data-testid="doc-heading"
          class={b().level === 1 ? "text-[18px] font-semibold" : "text-[15px] font-semibold"}
        >
          {str(b().text)}
        </h3>
      </Match>
      <Match when={b().type === "paragraph"}>
        <p data-testid="doc-paragraph" class="whitespace-pre-wrap">
          {str(b().text)}
        </p>
      </Match>
      <Match when={b().type === "list"}>
        <ul data-testid="doc-list" class="list-disc space-y-1 pl-5">
          <For each={Array.isArray(b().items) ? (b().items as unknown[]) : [b().line]}>
            {(item) => (
              <li data-testid="doc-list-item" class="whitespace-pre-wrap">
                {str(item)}
              </li>
            )}
          </For>
        </ul>
      </Match>
      <Match when={b().type === "table"}>
        <div class="overflow-x-auto">
          <table class="w-full border-collapse text-[13px]">
            <Show when={Array.isArray(b().columns)}>
              <thead>
                <tr>
                  <For each={b().columns as Block[]}>
                    {(c) => <th class="border-b border-border py-1 text-left">{str(c.header)}</th>}
                  </For>
                </tr>
              </thead>
            </Show>
            <tbody>
              <For each={(Array.isArray(b().rows) ? b().rows : []) as unknown[]}>
                {(r) => (
                  <tr>
                    <For
                      each={
                        (Array.isArray(r)
                          ? r
                          : (((r as Block)?.cells as unknown[]) ?? [])) as unknown[]
                      }
                    >
                      {(cell) => <td class="border-b border-border py-1">{str(cell)}</td>}
                    </For>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Match>
      <Match when={b().type === "image"}>
        <p class="text-text-tertiary">{i18n.t("client-action.page.doc.picture")}</p>
      </Match>
      <Match when={b().type === "spacer"}>
        <div class="h-3" />
      </Match>
      <Match when={b().type === "repeat" && Array.isArray(b().blocks)}>
        <For each={b().blocks as Block[]}>{(inner) => <BlockView block={inner} />}</For>
      </Match>
    </Switch>
  )
}

/** A generated document's frozen blocks, drawn as plain text (the portal reads them too). */
export const DocumentBlocks: Component<{ blocks: unknown[] }> = (props) => (
  <article class="flex flex-col gap-3 rounded-sm border border-border bg-bg px-5 py-6">
    <For each={props.blocks as Block[]}>{(block) => <BlockView block={block} />}</For>
  </article>
)

const PagePicture: Component<{
  token: string
  page: PageEntry
  last: boolean
  onLastLoaded: () => void
}> = (props) => {
  const i18n = useI18n()
  const [src, setSrc] = createSignal<string | null>(null)
  let holder: HTMLDivElement | undefined
  let asked = false
  let url: string | null = null
  onCleanup(() => {
    if (url) URL.revokeObjectURL(url)
  })
  onMount(() => {
    if (!holder) return
    const stop = whenInView(
      holder,
      async () => {
        if (asked) return
        asked = true
        const out = await postPublicFile({ t: props.token, format: "page", n: props.page.n })
        if (out.blob) {
          url = URL.createObjectURL(out.blob)
          setSrc(url)
        }
      },
      "400px",
    )
    onCleanup(stop)
  })
  return (
    <div
      ref={holder}
      data-testid={`doc-page-${props.page.n}`}
      class="w-full overflow-hidden rounded-sm border border-border bg-white"
      style={{ "aspect-ratio": src() ? undefined : "1 / 1.414" }}
    >
      <Show when={src()}>
        {(s) => (
          <img
            src={s()}
            alt={i18n.t("client-action.page.doc.page", { n: props.page.n })}
            class="block h-auto w-full"
            onLoad={() => {
              if (props.last) props.onLastLoaded()
            }}
          />
        )}
      </Show>
    </div>
  )
}

export const DocumentView: Component<{
  token: string
  content: DocumentContent
  onReachedEnd: () => void
}> = (props) => {
  const i18n = useI18n()
  const [asText, setAsText] = createSignal(false)
  const [lastLoaded, setLastLoaded] = createSignal(false)
  const [endInView, setEndInView] = createSignal(false)
  let reported = false
  let end: HTMLDivElement | undefined

  const pages = () => (props.content.format === "pages" ? props.content.pages : [])
  // Nothing to read is never shown as a document read to its end.
  const empty = () =>
    props.content.format === "blocks"
      ? !blocksHaveText(props.content.blocks)
      : props.content.pages.length === 0
  const hasText = () => pages().some((p) => (p.text ?? "").trim() !== "")
  const needsPicture = () => props.content.format === "pages" && pages().length > 0

  // Checked from the two events that can complete it, never from an effect.
  function check() {
    if (reported || asText() || empty()) return
    if (endInView() && (!needsPicture() || lastLoaded())) {
      reported = true
      props.onReachedEnd()
    }
  }
  onMount(() => {
    if (end)
      onCleanup(
        whenInView(end, () => {
          setEndInView(true)
          check()
        }),
      )
  })

  return (
    <Show
      when={!empty()}
      fallback={
        <div data-testid="doc-view" class="flex flex-col gap-3">
          <p
            data-testid="doc-empty"
            role="status"
            class="rounded-sm border border-border bg-bg px-5 py-6 text-[14px] text-text"
          >
            {i18n.t("client-action.page.doc.empty")}
          </p>
        </div>
      }
    >
      <div data-testid="doc-view" class="flex flex-col gap-3">
        <Show when={props.content.format === "pages" && hasText()}>
          <div>
            <button
              type="button"
              data-testid="doc-text-switch"
              class="min-h-[44px] text-[13px] text-accent underline-offset-2 hover:underline"
              onClick={() => {
                setAsText(!asText())
                check()
              }}
            >
              {asText()
                ? i18n.t("client-action.page.doc.asPages")
                : i18n.t("client-action.page.doc.asText")}
            </button>
          </div>
        </Show>
        <Show when={asText()}>
          <div data-testid="doc-text" class="flex flex-col gap-3 text-[14px] leading-6 text-text">
            <p class="text-[12.5px] text-text-secondary">
              {i18n.t("client-action.page.doc.textLabel")}
            </p>
            <For each={pages()}>
              {(p) => (
                <section>
                  <h3 class="text-[12.5px] font-medium text-text-secondary">
                    {i18n.t("client-action.page.doc.page", { n: p.n })}
                  </h3>
                  <p class="whitespace-pre-wrap">{p.text ?? ""}</p>
                </section>
              )}
            </For>
            <p class="text-[12.5px] text-text-secondary">
              {i18n.t("client-action.page.doc.textEnd")}
            </p>
          </div>
        </Show>
        <div
          data-testid="doc-body"
          class="flex flex-col gap-3 text-[14px] leading-6 text-text"
          style={{ display: asText() ? "none" : undefined }}
        >
          <Switch>
            <Match when={props.content.format === "blocks" && props.content}>
              {(c) => <DocumentBlocks blocks={(c() as { blocks: unknown[] }).blocks} />}
            </Match>
            <Match when={props.content.format === "pages"}>
              <For each={pages()}>
                {(p, i) => (
                  <PagePicture
                    token={props.token}
                    page={p}
                    last={i() === pages().length - 1}
                    onLastLoaded={() => {
                      setLastLoaded(true)
                      check()
                    }}
                  />
                )}
              </For>
            </Match>
          </Switch>
          <div
            ref={end}
            data-testid="doc-end"
            class="py-1 text-center text-[12px] text-text-tertiary"
          >
            {i18n.t("client-action.page.doc.end")}
          </div>
        </div>
      </div>
    </Show>
  )
}
