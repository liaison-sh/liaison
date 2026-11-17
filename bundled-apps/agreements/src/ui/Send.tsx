// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Prepare and send, in one tab: Prepare runs the checks and freezes the version (nothing is
// sent), then the person names the signers, their order, the words to type and how long the
// link works, and sends. The person's own click sends it: it is decided by their own
// permissions, not by an approval card (cards are for agents). Agents never sign.
import { Button } from "@liaison/app-ui/kit"
import { type Component, createResource, createSignal, For, Show } from "solid-js"
import { call, go, paths } from "./host"
import { tr } from "./i18n"
import { StatusBadge } from "./List"
import { type AgreementDetail, type SignerInput, signersForSend } from "./model"
import { loadSigningState, SigningOff, signingOffText } from "./signing"

const INPUT =
  "w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-[12.5px] text-text outline-none focus:border-accent-border"

interface Frozen {
  version_id: string
  version: number
  sha256: string
  page_count: number | null
}

const PHRASES: Array<{ value: string; label: string }> = [
  { value: "", label: "None" },
  { value: "Lu et approuvé", label: "Lu et approuvé" },
  { value: "Bon pour accord", label: "Bon pour accord" },
  { value: "Read and approved", label: "Read and approved" },
]

export const AgreementSend: Component<{ entityId?: string }> = (props) => {
  const id = () => props.entityId ?? ""
  const [detail] = createResource(id, async (agreementId) => {
    const out = await call<AgreementDetail>("agreement_get", { id: agreementId })
    if (!out.ok) throw new Error(out.message)
    return out.data
  })
  const [signing] = createResource(loadSigningState)
  const [frozen, setFrozen] = createSignal<Frozen | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [signers, setSigners] = createSignal<SignerInput[]>([{ name: "", email: "" }])
  const [order, setOrder] = createSignal<"sequential" | "any">("sequential")
  const [phrase, setPhrase] = createSignal("")
  const [expires, setExpires] = createSignal(14)
  const [message, setMessage] = createSignal("")

  const prepare = async () => {
    setBusy(true)
    setError(null)
    const out = await call<Frozen & { status: string; message?: string }>("agreement_prepare", {
      id: id(),
    })
    setBusy(false)
    if (!out.ok)
      return setError(out.message || tr("It cannot be prepared yet. Nothing was frozen."))
    if (!out.data.version_id)
      return setError(
        tr("It passes every check, but no version was frozen yet. Try again in a minute."),
      )
    setFrozen(out.data)
  }

  const valid = () => signersForSend(signers())
  const send = async () => {
    const f = frozen()
    const list = valid()
    if (!f || !list) return
    setBusy(true)
    setError(null)
    const out = await call<{ status?: string }>("agreement_send", {
      version_id: f.version_id,
      sha256: f.sha256,
      signers: list,
      order: order(),
      expires_in_days: expires(),
      ...(phrase() ? { required_phrase: phrase() } : {}),
      ...(message().trim() ? { message: message().trim() } : {}),
    })
    setBusy(false)
    if (!out.ok) return setError(out.message || tr("It was not sent."))
    go(paths.agreement(id()))
  }

  const setSigner = (i: number, key: keyof SignerInput, value: string) =>
    setSigners(signers().map((s, j) => (j === i ? { ...s, [key]: value } : s)))

  return (
    <div data-testid="agreement-send" class="flex h-full min-h-0 flex-col bg-bg">
      <Show
        when={detail.error ? undefined : detail()}
        fallback={
          <Show when={detail.error}>
            <p data-testid="agreement-send-load-error" class="px-6 py-10 text-[13px] text-text">
              {tr("This agreement cannot be opened")}
            </p>
          </Show>
        }
      >
        {(d) => (
          <>
            <header class="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle px-5 py-3">
              <div class="flex min-w-0 items-center gap-2">
                <span class="font-mono text-[12px] text-text-tertiary">{d().agreement.number}</span>
                <StatusBadge status={d().agreement.status} kind={d().agreement.kind} />
                <span class="truncate text-[13px] font-semibold text-text">
                  {d().agreement.title}
                </span>
              </div>
              <div class="flex items-center gap-2">
                <Button
                  variant="ghost"
                  testid="agreement-send-back"
                  onClick={() => go(paths.editor(id()))}
                >
                  {tr("Back to the editor")}
                </Button>
                <Show
                  when={frozen()}
                  fallback={
                    <Button
                      variant="primary"
                      testid="agreement-send-prepare"
                      disabled={busy() || d().agreement.status !== "draft"}
                      onClick={() => void prepare()}
                    >
                      {tr("Prepare for signature")}
                    </Button>
                  }
                >
                  <Button
                    variant="primary"
                    testid="agreement-send-submit"
                    disabled={busy() || !valid() || signingOffText(signing()) !== null}
                    onClick={() => void send()}
                  >
                    {tr("Send for signature")}
                  </Button>
                </Show>
              </div>
            </header>
            <SigningOff />
            <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4 pb-dock-runway">
              <div class="flex max-w-2xl flex-col gap-5">
                <p class="text-[12.5px] text-text-secondary">
                  {tr(
                    "Simple electronic signature: the signer reads the document, confirms with a code sent by email, and types their name. You keep the proof. Agents never sign.",
                  )}
                </p>
                <Show when={error()}>
                  <p
                    data-testid="agreement-send-error"
                    role="alert"
                    class="text-[12.5px] text-error"
                  >
                    {error()}
                  </p>
                </Show>
                <Show
                  when={frozen()}
                  fallback={
                    <p data-testid="agreement-send-intro" class="text-[12.5px] text-text-secondary">
                      {tr(
                        "Prepare checks the document and freezes this version. Nothing is sent yet.",
                      )}
                    </p>
                  }
                >
                  {(f) => (
                    <>
                      <div
                        data-testid="agreement-send-frozen"
                        class="rounded-md border border-border-subtle bg-surface px-4 py-3 text-[12.5px]"
                      >
                        <p class="text-text">
                          {tr("Version {{n}} is frozen. This is the file every signer reads.", {
                            n: f().version,
                          })}
                        </p>
                        <p class="mt-1 break-all font-mono text-[11.5px] text-text-tertiary">
                          {tr("Fingerprint (SHA-256)")}: {f().sha256}
                        </p>
                      </div>
                      <section>
                        <h2 class="mb-2 text-[12px] font-medium text-text">{tr("Signers")}</h2>
                        <div class="flex flex-col gap-2">
                          <For each={signers()}>
                            {(s, i) => (
                              <div
                                class="flex flex-wrap items-center gap-2"
                                data-testid={`agreement-send-signer-${i()}`}
                              >
                                <span class="w-5 text-[12px] tabular-nums text-text-tertiary">
                                  {i() + 1}
                                </span>
                                <input
                                  class={`${INPUT} max-w-[14rem]`}
                                  data-testid={`agreement-send-signer-name-${i()}`}
                                  placeholder={tr("Name")}
                                  aria-label={tr("Name")}
                                  value={s.name}
                                  onInput={(e) => setSigner(i(), "name", e.currentTarget.value)}
                                />
                                <input
                                  class={`${INPUT} max-w-[16rem]`}
                                  data-testid={`agreement-send-signer-email-${i()}`}
                                  placeholder={tr("Email")}
                                  aria-label={tr("Email")}
                                  type="email"
                                  value={s.email}
                                  onInput={(e) => setSigner(i(), "email", e.currentTarget.value)}
                                />
                                <Show when={signers().length > 1}>
                                  <button
                                    type="button"
                                    class="text-[11.5px] text-text-tertiary hover:text-text"
                                    onClick={() =>
                                      setSigners(signers().filter((_, j) => j !== i()))
                                    }
                                  >
                                    {tr("Remove")}
                                  </button>
                                </Show>
                              </div>
                            )}
                          </For>
                          <Button
                            variant="ghost"
                            class="self-start"
                            testid="agreement-send-add-signer"
                            onClick={() => setSigners([...signers(), { name: "", email: "" }])}
                          >
                            {tr("Add a signer")}
                          </Button>
                        </div>
                      </section>
                      <label class="flex flex-col gap-1">
                        <span class="text-[12px] font-medium text-text">{tr("Signing order")}</span>
                        <select
                          class={INPUT}
                          data-testid="agreement-send-order"
                          value={order()}
                          onChange={(e) =>
                            setOrder(e.currentTarget.value === "any" ? "any" : "sequential")
                          }
                        >
                          <option value="sequential">{tr("In the order above")}</option>
                          <option value="any">{tr("Any order")}</option>
                        </select>
                      </label>
                      <label class="flex flex-col gap-1">
                        <span class="text-[12px] font-medium text-text">
                          {tr("Words to type before signing")}
                        </span>
                        <select
                          class={INPUT}
                          data-testid="agreement-send-phrase"
                          value={phrase()}
                          onChange={(e) => setPhrase(e.currentTarget.value)}
                        >
                          <For each={PHRASES}>
                            {(p) => <option value={p.value}>{tr(p.label)}</option>}
                          </For>
                        </select>
                      </label>
                      <label class="flex flex-col gap-1">
                        <span class="text-[12px] font-medium text-text">
                          {tr("The link works for")}
                        </span>
                        <select
                          class={INPUT}
                          data-testid="agreement-send-expires"
                          value={String(expires())}
                          onChange={(e) => setExpires(Number(e.currentTarget.value))}
                        >
                          <For each={[7, 14, 30]}>
                            {(n) => <option value={String(n)}>{tr("{{n}} days", { n })}</option>}
                          </For>
                        </select>
                      </label>
                      <label class="flex flex-col gap-1">
                        <span class="text-[12px] font-medium text-text">
                          {tr("A note in the mail (optional)")}
                        </span>
                        <input
                          class={INPUT}
                          data-testid="agreement-send-message"
                          maxLength={2000}
                          value={message()}
                          onInput={(e) => setMessage(e.currentTarget.value)}
                        />
                      </label>
                    </>
                  )}
                </Show>
              </div>
            </div>
          </>
        )}
      </Show>
    </div>
  )
}
