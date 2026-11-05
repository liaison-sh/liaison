// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE FILES CHANGED DRAWER (P2-T09; S8). A right column beside the session
// (full width below the md breakpoint): each file the session changed with its
// +/- counts; picking one shows its diff. Paths are already relative
// (filesChanged). A file whose change was cut at 64 KB says so.

import { X } from "lucide-solid"
import { createMemo, createSignal, For, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import type { FileChange } from "./files-changed"

export interface FilesDrawerProps {
  open: boolean
  files: readonly FileChange[]
  onClose: () => void
}

export default function FilesDrawer(props: FilesDrawerProps) {
  const t = useI18n().t
  const [picked, setPicked] = createSignal<string | null>(null)
  const current = createMemo(
    () => props.files.find((f) => f.path === picked()) ?? props.files[0] ?? null,
  )
  return (
    <Show when={props.open}>
      <aside
        data-testid="files-drawer"
        class="fixed inset-0 z-30 flex flex-col bg-bg md:static md:z-auto md:w-[380px] md:shrink-0 md:border-l md:border-border"
      >
        <header class="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <h2 class="flex-1 text-[13.5px] font-semibold text-text">
            <span class="tabular-nums">
              {t("kernel.nodeSessions.files.title", { count: props.files.length })}
            </span>
          </h2>
          <button
            type="button"
            aria-label={t("kernel.close")}
            class="rounded-md p-1 text-text-tertiary hover:bg-surface-hover"
            onClick={() => props.onClose()}
          >
            <X class="h-4 w-4" />
          </button>
        </header>
        <Show
          when={props.files.length > 0}
          fallback={
            <p class="px-3 py-4 text-[12.5px] text-text-tertiary">
              {t("kernel.nodeSessions.files.empty")}
            </p>
          }
        >
          <ul class="flex flex-col border-b border-border py-1">
            <For each={props.files}>
              {(f) => (
                <li>
                  <button
                    type="button"
                    data-testid="file-row"
                    aria-pressed={current()?.path === f.path}
                    class="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left text-[12.5px] hover:bg-surface-hover"
                    classList={{ "bg-surface-active": current()?.path === f.path }}
                    onClick={() => setPicked(f.path)}
                  >
                    <span class="min-w-0 flex-1 truncate text-text">{f.path}</span>
                    <span class="shrink-0 tabular-nums text-success">+{f.added}</span>
                    <Show when={f.removed > 0}>
                      <span class="shrink-0 tabular-nums text-error">−{f.removed}</span>
                    </Show>
                  </button>
                </li>
              )}
            </For>
          </ul>
          <Show when={current()}>
            {(f) => (
              <div class="min-h-0 flex-1 overflow-auto">
                <Show when={f().cut}>
                  <p class="px-3 pt-2 text-[12px] text-text-tertiary">
                    {t("kernel.nodeSessions.files.cut")}
                  </p>
                </Show>
                <div data-testid="file-diff" class="font-mono text-[12px] leading-[1.5]">
                  <For each={f().hunks}>
                    {(hunk) => (
                      <div class="border-b border-border-subtle py-1">
                        <For each={hunk}>
                          {(line) => (
                            <div
                              class="whitespace-pre px-3"
                              classList={{
                                "bg-success-glow text-success": line.type === "add",
                                "bg-error-glow text-error": line.type === "del",
                                "text-text-secondary": line.type === "same",
                              }}
                            >
                              {line.type === "add" ? "+ " : line.type === "del" ? "- " : "  "}
                              {line.text}
                            </div>
                          )}
                        </For>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            )}
          </Show>
        </Show>
      </aside>
    </Show>
  )
}
