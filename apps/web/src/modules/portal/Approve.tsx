// SPDX-License-Identifier: FSL-1.1-ALv2
//
// R-05: one shared document and what waits on the people of the company. Only
// the person a request was sent to can decide it; the others see who it waits
// on. Signing and accepting always ask the emailed code; an approval asks it
// only when the server says this session is too old for a click alone.

import { type Component, createResource, createSignal, For, Match, Show, Switch } from "solid-js"
import { DocumentBlocks } from "~/modules/client-action/DocumentView"
import { useI18n } from "~/modules/i18n/i18n-context"
import { day, documentState } from "./format"
import { Loading, NotAvailable, PartFailed, Section } from "./Pages"
import { portalBlob, portalDownload, portalGet, portalPost } from "./portal-api"
import type { PortalAction, PortalDocumentDetail } from "./types"

const inputClass =
  "w-full rounded-md border border-border bg-bg px-3 py-2 text-[14px] text-text focus:outline-none focus:ring-2 focus:ring-accent/40"
const primaryClass =
  "min-h-[44px] rounded-md bg-accent px-4 text-[14px] font-medium text-accent-foreground disabled:opacity-60"
const secondaryClass =
  "min-h-[44px] rounded-md border border-border px-4 text-[14px] text-text disabled:opacity-60"

/** A generated version's frozen blocks, or none (an upload is read from its page pictures). */
function blocksOf(source: unknown): unknown[] {
  const blocks = (source as { body?: { blocks?: unknown } } | null)?.body?.blocks
  return Array.isArray(blocks) ? blocks : []
}

type Step = "choose" | "code" | "decline" | "busy" | "done"

const Decide: Component<{
  action: PortalAction
  onDecided: (outcome: "decided" | "declined") => void
}> = (props) => {
  const i18n = useI18n()
  const needsCode = () => props.action.kind !== "approve"
  const [step, setStep] = createSignal<Step>("choose")
  const [code, setCode] = createSignal("")
  const [name, setName] = createSignal("")
  const [reason, setReason] = createSignal("")
  const [sentTo, setSentTo] = createSignal<string | null>(null)
  const [note, setNote] = createSignal<string | null>(null)
  const [outcome, setOutcome] = createSignal<string | null>(null)

  const askCode = async () => {
    setNote(null)
    const out = await portalPost<unknown>(`/actions/${props.action.id}/code`, {})
    const body = out.body as { sent_to?: string } | null
    if (out.status === 202 || out.status === 200) {
      setSentTo(body?.sent_to ?? null)
      setStep("code")
      return
    }
    // A demo box sends no code mail: say so in words.
    if ((out.body?.error as { code?: unknown } | undefined)?.code === "NO_MAIL_ON_DEMO") {
      setNote(i18n.t("portal.approve.codeNotOnDemo"))
      return
    }
    // Asked too soon or paused: say when a code can be asked again.
    const retryAt = (out.body?.error as { retry_at?: unknown } | undefined)?.retry_at
    setNote(
      typeof retryAt === "string" && !Number.isNaN(Date.parse(retryAt))
        ? i18n.t("portal.approve.codeNotSentUntil", {
            time: i18n.fmtDate(new Date(retryAt), { hour: "2-digit", minute: "2-digit" }),
          })
        : i18n.t("portal.approve.codeNotSent"),
    )
  }

  const decide = async (decision: "sign" | "accept" | "approve" | "decline") => {
    setNote(null)
    const before = step()
    setStep("busy")
    const out = await portalPost<{ state?: string }>(`/actions/${props.action.id}/decide`, {
      decision,
      lang: i18n.locale(),
      ...(code() ? { code: code() } : {}),
      ...(decision === "sign" || decision === "accept" ? { typed_name: name().trim() } : {}),
      ...(decision === "decline" && reason().trim() ? { reason: reason().trim() } : {}),
    })
    if (out.status === 200) {
      const state = out.data?.state ?? decision
      setOutcome(state)
      setStep("done")
      props.onDecided(state === "declined" ? "declined" : "decided")
      return
    }
    const err = (out.body?.error ?? {}) as { code?: string }
    if (err.code === "code_required") {
      await askCode()
      return
    }
    setStep(before === "busy" ? "choose" : before)
    setNote(
      err.code === "name_mismatch"
        ? i18n.t("portal.approve.nameMismatch")
        : out.status === 409 || out.status === 410
          ? i18n.t("portal.approve.alreadyDecided")
          : i18n.t("portal.approve.failed"),
    )
  }

  const positive = () =>
    (props.action.kind === "sign"
      ? "sign"
      : props.action.kind === "accept"
        ? "accept"
        : "approve") as "sign" | "accept" | "approve"

  return (
    <div data-testid={`portal-decide-${props.action.id}`} class="flex flex-col gap-3">
      <Show when={props.action.words}>
        {(w) => (
          <p data-testid="portal-consent-words" class="text-[13.5px] text-text-secondary">
            {w()}
          </p>
        )}
      </Show>
      <Switch>
        <Match when={step() === "done"}>
          <p data-testid="portal-decided" role="status" class="text-[14px] text-text">
            {i18n.t(`portal.approve.done.${outcome() === "declined" ? "declined" : "decided"}`)}
          </p>
        </Match>
        <Match when={step() === "choose" || step() === "busy"}>
          <div class="flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="portal-decide-yes"
              class={primaryClass}
              disabled={step() === "busy"}
              onClick={() => (needsCode() ? askCode() : decide("approve"))}
            >
              {i18n.t(`portal.approve.do.${positive()}`)}
            </button>
            <button
              type="button"
              data-testid="portal-decide-decline"
              class={secondaryClass}
              disabled={step() === "busy"}
              onClick={() => setStep("decline")}
            >
              {i18n.t("portal.approve.decline")}
            </button>
          </div>
        </Match>
        <Match when={step() === "code"}>
          <p class="text-[13.5px] text-text-secondary">
            {i18n.t("portal.approve.codeSent", { to: sentTo() ?? "" })}
          </p>
          <label class="flex flex-col gap-1 text-[13px] text-text">
            {i18n.t("portal.approve.code")}
            <input
              data-testid="portal-decide-code"
              inputmode="numeric"
              autocomplete="one-time-code"
              class={inputClass}
              value={code()}
              onInput={(e) => setCode(e.currentTarget.value.trim())}
            />
          </label>
          <Show when={needsCode()}>
            <label class="flex flex-col gap-1 text-[13px] text-text">
              {i18n.t("portal.approve.typedName")}
              <input
                data-testid="portal-decide-name"
                autocomplete="name"
                class={inputClass}
                value={name()}
                onInput={(e) => setName(e.currentTarget.value)}
              />
            </label>
          </Show>
          <button
            type="button"
            data-testid="portal-decide-confirm"
            class={primaryClass}
            disabled={!code() || (needsCode() && !name().trim())}
            onClick={() => decide(positive())}
          >
            {i18n.t(`portal.approve.do.${positive()}`)}
          </button>
        </Match>
        <Match when={step() === "decline"}>
          <label class="flex flex-col gap-1 text-[13px] text-text">
            {i18n.t("portal.approve.reason")}
            <textarea
              data-testid="portal-decline-reason"
              rows={3}
              class={inputClass}
              value={reason()}
              onInput={(e) => setReason(e.currentTarget.value)}
            />
          </label>
          <div class="flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="portal-decline-confirm"
              class={primaryClass}
              onClick={() => decide("decline")}
            >
              {i18n.t("portal.approve.declineConfirm")}
            </button>
            <button type="button" class={secondaryClass} onClick={() => setStep("choose")}>
              {i18n.t("portal.approve.back")}
            </button>
          </div>
        </Match>
      </Switch>
      <Show when={note()}>
        {(n) => (
          <p data-testid="portal-decide-note" role="status" class="text-[13px] text-text">
            {n()}
          </p>
        )}
      </Show>
    </div>
  )
}

const PagePicture: Component<{ docId: string; n: number }> = (props) => {
  const i18n = useI18n()
  const [src] = createResource(
    () => `${props.docId}/${props.n}`,
    () => portalBlob(`/documents/${props.docId}/pages/${props.n}`),
  )
  return (
    <Show when={src()} fallback={<PartFailed part={`page-${props.n}`} />}>
      {(s) => (
        <img
          src={s()}
          alt={i18n.t("portal.documents.page", { n: String(props.n) })}
          class="w-full rounded-md border border-border"
          loading="lazy"
        />
      )}
    </Show>
  )
}

export const DocumentPage: Component<{ id: string }> = (props) => {
  const i18n = useI18n()
  const [doc, { refetch }] = createResource(
    () => props.id,
    async (id) => portalGet<PortalDocumentDetail>(`/documents/${id}?lang=${i18n.locale()}`),
  )
  const open = (a: PortalAction) => !a.decidedAt && !a.revokedAt
  // What this person just decided stays said after the action leaves the page, and the
  // document is read again a moment later: its signed state lands once the decision is recorded.
  const [decided, setDecided] = createSignal<"decided" | "declined" | null>(null)
  const onDecided = (outcome: "decided" | "declined") => {
    setDecided(outcome)
    void refetch()
    setTimeout(() => void refetch(), 2000)
  }
  return (
    <Show when={doc()} fallback={<Loading />}>
      {(answer) => (
        <Show
          when={answer().status === 200 && answer().data}
          fallback={answer().status === 404 ? <NotAvailable /> : <PartFailed part="document" />}
        >
          {(d) => (
            <div data-testid="portal-document" class="flex flex-col gap-4">
              <div>
                <h1 class="text-[20px] font-semibold text-text">
                  {d().number} {d().title}
                </h1>
                <p data-testid="portal-document-status" class="text-[13.5px] text-text-secondary">
                  {i18n.t(`portal.documents.status.${documentState(d().status)}`)}
                  {d().signedAt ? ` · ${day(d().signedAt, i18n.locale())}` : ""}
                </p>
              </div>
              <Show when={decided()}>
                {(o) => (
                  <p data-testid="portal-decided-note" role="status" class="text-[14px] text-text">
                    {i18n.t(`portal.approve.done.${o()}`)}
                  </p>
                )}
              </Show>
              <Show when={d().actions} fallback={<PartFailed part="actions" />}>
                {(actions) => (
                  <For each={actions().filter(open)}>
                    {(a) => (
                      <Section
                        title={i18n.t(`portal.approve.title.${a.kind}`)}
                        testid={`portal-action-${a.id}`}
                      >
                        <Show
                          when={a.mine}
                          fallback={
                            <p
                              data-testid="portal-waits-on"
                              class="text-[13.5px] text-text-secondary"
                            >
                              {i18n.t("portal.approve.waitsOn", { name: a.invitedName ?? "" })}
                            </p>
                          }
                        >
                          <Decide action={a} onDecided={onDecided} />
                        </Show>
                        <Show when={a.expiresAt}>
                          <p class="mt-2 text-[12.5px] text-text-tertiary">
                            {i18n.t("portal.approve.until", {
                              date: day(a.expiresAt, i18n.locale()),
                            })}
                          </p>
                        </Show>
                      </Section>
                    )}
                  </For>
                )}
              </Show>
              <Show when={(d().evidence?.length ?? 0) > 0}>
                <Section title={i18n.t("portal.documents.files")} testid="portal-document-files">
                  <For each={d().evidence ?? []}>
                    {(e) => (
                      <div class="flex flex-wrap gap-2">
                        <Show when={e.signedPdfFileId}>
                          {(f) => (
                            <button
                              type="button"
                              class={secondaryClass}
                              data-testid="portal-signed-pdf"
                              onClick={() => portalDownload(`/files/${f()}`, `${d().number}.pdf`)}
                            >
                              {i18n.t("portal.documents.signedPdf")}
                            </button>
                          )}
                        </Show>
                        <Show when={e.copyFileId}>
                          {(f) => (
                            <button
                              type="button"
                              class={secondaryClass}
                              data-testid="portal-your-copy"
                              onClick={() => portalDownload(`/files/${f()}`, `${d().number}.zip`)}
                            >
                              {i18n.t("portal.documents.yourCopy")}
                            </button>
                          )}
                        </Show>
                      </div>
                    )}
                  </For>
                </Section>
              </Show>
              <Show when={d().versions?.[0]}>
                {(v) => (
                  <Section title={i18n.t("portal.documents.read")} testid="portal-document-pages">
                    <Switch
                      fallback={
                        <p
                          data-testid="portal-document-empty"
                          class="text-[13px] text-text-secondary"
                        >
                          {i18n.t("portal.documents.empty")}
                        </p>
                      }
                    >
                      <Match when={blocksOf(v().source).length > 0}>
                        <div
                          data-testid="portal-document-body"
                          class="text-[14px] leading-6 text-text"
                        >
                          <DocumentBlocks blocks={blocksOf(v().source)} />
                        </div>
                      </Match>
                      <Match when={v().pageCount > 0}>
                        <div class="flex flex-col gap-3">
                          <For
                            each={Array.from(
                              { length: Math.min(v().pageCount, 50) },
                              (_, i) => i + 1,
                            )}
                          >
                            {(n) => <PagePicture docId={v().id} n={n} />}
                          </For>
                        </div>
                      </Match>
                    </Switch>
                  </Section>
                )}
              </Show>
            </div>
          )}
        </Show>
      )}
    </Show>
  )
}
