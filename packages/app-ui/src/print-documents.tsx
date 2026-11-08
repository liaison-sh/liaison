// SPDX-License-Identifier: FSL-1.1-ALv2
//
// PrintDocuments: a reusable "print this record's documents" control any app UI
// can drop on a record. It lists the org's templates for the record type, lets
// the person tick which to print, prints them through the kernel
// (POST /api/documents/print), opens the resulting file(s) and says which
// template fields printed as blanks.
//
// An inline fold panel, never a modal (the agent stays reachable). All kernel
// access goes through the host (`@liaison/host`), never a raw fetch: a
// page-relative fetch lands on the desktop/mobile shell's index.html.
//
// Opening a file follows the rule every app UI learned the hard way: the tab
// is opened synchronously inside the click, then the bytes are fetched with
// the host's bearer-authenticated `fetchBlob`; under the desktop shell the host
// opens the file itself (`openFile`) and the pre-opened tab is closed.
//
// In a frame (no network, no popup) the templates, the print and the file all go
// through the host's typed calls (`app.listDocumentTemplates`, `app.printDocuments`,
// `app.openFile`), bound to the app that bundles this component; the host opens
// the file, no bytes reach the frame.
//
// Bundling rule: explicit props only, no `{...rest}` spread.
import { app, fetchBlob, hostLocale, openFile } from "@liaison/host"
import { type Component, createSignal, For, Show } from "solid-js"
import { Badge, Button } from "./kit"

export interface PrintDocumentsLabels {
  title: string
  needed: string
  print: string
  printMerged: string
  loading: string
  empty: string
  blanks: string
  open: string
  printing: string
  failed: string
}

const EN: PrintDocumentsLabels = {
  title: "Print documents",
  needed: "Needed",
  print: "Print",
  printMerged: "Print as one PDF",
  loading: "Loading templates...",
  empty: "No templates for this kind of record yet — ask your agent to make one",
  blanks: "These fields were empty and print as blanks:",
  open: "Open",
  printing: "Preparing...",
  failed: "Printing failed",
}

const FR: PrintDocumentsLabels = {
  title: "Imprimer les documents",
  needed: "Requis",
  print: "Imprimer",
  printMerged: "Imprimer en un seul PDF",
  loading: "Chargement des modèles...",
  empty:
    "Aucun modèle pour ce type d’enregistrement pour l’instant — demandez à votre agent d’en créer un",
  blanks: "Ces champs étaient vides et s’impriment en blanc :",
  open: "Ouvrir",
  printing: "Préparation...",
  failed: "L’impression a échoué",
}

interface TemplateSummary {
  id: string
  name: string
}

interface PrintedFile {
  templateId: string
  templateName: string
  fileId: string
  filename: string
  blanks: Array<{ field: string; label: string }>
}

interface PrintResult {
  files: PrintedFile[]
  merged: { fileId: string; filename: string } | null
}

export interface PrintDocumentsProps {
  app: string
  entity: string
  recordId: string
  /** Templates the record needs: pre-ticked and badged. */
  neededTemplateIds?: string[]
  /** Copy overrides; English (or French under a French host) by default. */
  labels?: Partial<PrintDocumentsLabels>
  testid?: string
}

/** Pre-open a tab inside the click gesture so a popup blocker lets it through. */
function openPreparingTab(): Window | null {
  // Framed: the host opens the file itself.
  if (app.opensFiles()) return null
  try {
    return window.open("", "_blank")
  } catch {
    return null
  }
}

async function loadFileInto(fileId: string, win: Window | null, name: string): Promise<void> {
  if (await app.openFile(fileId, name)) {
    win?.close()
    return
  }
  let blob: Blob
  try {
    blob = await fetchBlob(`/api/files/${fileId}/inline`)
  } catch (e) {
    win?.close()
    throw e
  }
  const pdf = blob.type === "application/pdf" ? blob : new Blob([blob], { type: "application/pdf" })
  let native: boolean
  try {
    native = await openFile(pdf, name)
  } catch (e) {
    win?.close()
    throw e
  }
  if (native) {
    win?.close()
    return
  }
  const url = URL.createObjectURL(pdf)
  if (win) win.location.href = url
  else window.open(url, "_blank", "noopener")
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export const PrintDocuments: Component<PrintDocumentsProps> = (props) => {
  const t = (): PrintDocumentsLabels => ({
    ...(hostLocale().startsWith("fr") ? FR : EN),
    ...props.labels,
  })
  const id = (suffix: string): string => `${props.testid ?? "print-documents"}-${suffix}`

  const [open, setOpen] = createSignal(false)
  const [templates, setTemplates] = createSignal<TemplateSummary[] | null>(null)
  const [ticked, setTicked] = createSignal<Set<string>>(new Set())
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [result, setResult] = createSignal<PrintResult | null>(null)

  const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

  async function loadTemplates(): Promise<void> {
    setError(null)
    try {
      const rows = await app.listDocumentTemplates<TemplateSummary>(props.entity)
      setTemplates(rows)
      const needed = new Set(props.neededTemplateIds ?? [])
      setTicked(new Set(rows.filter((r) => needed.has(r.id)).map((r) => r.id)))
    } catch (e) {
      setTemplates([])
      setError(message(e))
    }
  }

  function toggle(): void {
    const next = !open()
    setOpen(next)
    if (next && templates() === null) void loadTemplates()
  }

  function tick(templateId: string, on: boolean): void {
    const next = new Set(ticked())
    if (on) next.add(templateId)
    else next.delete(templateId)
    setTicked(next)
  }

  async function print(merge: boolean): Promise<void> {
    const ids = (templates() ?? []).filter((r) => ticked().has(r.id)).map((r) => r.id)
    if (ids.length === 0 || busy()) return
    const win = openPreparingTab()
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const out = await app.printDocuments<PrintResult>({
        entity: props.entity,
        id: props.recordId,
        templateIds: ids,
        ...(merge ? { merge: true } : {}),
      })
      setResult(out)
      const first = merge && out.merged ? out.merged : out.files[0]
      if (first) await loadFileInto(first.fileId, win, first.filename)
      else win?.close()
    } catch (e) {
      win?.close()
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }

  async function openOne(fileId: string, filename: string): Promise<void> {
    const win = openPreparingTab()
    try {
      await loadFileInto(fileId, win, filename)
    } catch (e) {
      setError(message(e))
    }
  }

  const blanks = () =>
    (result()?.files ?? []).flatMap((f) =>
      f.blanks.map((b) => ({ file: f.templateName, label: b.label })),
    )
  const tickedCount = (): number => ticked().size

  return (
    <div data-testid={id("root")} class="rounded-md border border-border bg-surface">
      <button
        type="button"
        data-testid={id("toggle")}
        aria-expanded={open()}
        onClick={toggle}
        class="flex w-full items-center justify-between px-3 py-2 text-left text-[12.5px] font-medium text-text-secondary hover:text-text"
      >
        <span>{t().title}</span>
        <span aria-hidden="true" class="text-text-tertiary">
          {open() ? "−" : "+"}
        </span>
      </button>
      <Show when={open()}>
        <div
          data-testid={id("panel")}
          class="flex flex-col gap-2.5 border-t border-border px-3 py-3"
        >
          <Show when={templates() === null}>
            <p data-testid={id("loading")} class="text-[12px] text-text-tertiary">
              {t().loading}
            </p>
          </Show>
          <Show when={templates() !== null && templates()?.length === 0 && !error()}>
            <p data-testid={id("empty")} class="text-[12px] text-text-tertiary">
              {t().empty}
            </p>
          </Show>
          <Show when={(templates()?.length ?? 0) > 0}>
            <ul class="flex flex-col gap-1.5">
              <For each={templates() ?? []}>
                {(tpl) => (
                  <li data-testid={id(`row-${tpl.id}`)}>
                    <label class="flex items-center gap-2 text-[12.5px] text-text">
                      <input
                        type="checkbox"
                        data-testid={id(`check-${tpl.id}`)}
                        checked={ticked().has(tpl.id)}
                        onChange={(e) => tick(tpl.id, e.currentTarget.checked)}
                      />
                      <span>{tpl.name}</span>
                      <Show when={(props.neededTemplateIds ?? []).includes(tpl.id)}>
                        <Badge tone="accent" testid={id(`needed-${tpl.id}`)}>
                          {t().needed}
                        </Badge>
                      </Show>
                    </label>
                  </li>
                )}
              </For>
            </ul>
            <div class="flex flex-wrap gap-2">
              <Button
                variant="primary"
                testid={id("print")}
                disabled={busy() || tickedCount() === 0}
                onClick={() => void print(false)}
              >
                {busy() ? t().printing : t().print}
              </Button>
              <Show when={tickedCount() >= 2}>
                <Button
                  testid={id("print-merged")}
                  disabled={busy()}
                  onClick={() => void print(true)}
                >
                  {t().printMerged}
                </Button>
              </Show>
            </div>
          </Show>
          <Show when={result() && (result()?.files.length ?? 0) > 1 && !result()?.merged}>
            <ul class="flex flex-col gap-1">
              <For each={result()?.files ?? []}>
                {(f) => (
                  <li class="flex items-center gap-2 text-[12px] text-text-secondary">
                    <span>{f.templateName}</span>
                    <Button
                      variant="ghost"
                      testid={id(`open-${f.fileId}`)}
                      onClick={() => void openOne(f.fileId, f.filename)}
                    >
                      {t().open}
                    </Button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <Show when={blanks().length > 0}>
            <div
              data-testid={id("blanks")}
              class="rounded-md border border-border bg-surface-hover px-2.5 py-2 text-[12px] text-text-secondary"
            >
              {t().blanks}{" "}
              {blanks()
                .map((b) => b.label)
                .join(", ")}
            </div>
          </Show>
          <Show when={error()}>
            <p data-testid={id("error")} role="alert" class="text-[12px] text-error">
              {error()}
            </p>
          </Show>
        </div>
      </Show>
    </div>
  )
}
