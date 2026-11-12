// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Google Picker, on the app's own page: the person chooses the Drive files
// and folders Liaison may see (picked mode). Google's script needs the person's
// own access token (`liaisonPage.connectionToken`, for the account the link was
// minted for), the Picker API key and the project number (`liaisonPage.params`).
// What was picked goes to the `savePicks` route.
// (The browser globals are typed locally: the app's tsconfig has no Google types.)

interface PickerDoc {
  id: string
  name?: string
  mimeType?: string
}
interface El {
  textContent: string | null
  hidden: boolean
  id: string
  append(...children: Array<El | string>): void
  addEventListener(type: string, fn: () => void): void
  setAttribute(name: string, value: string): void
}
interface GooglePickerView {
  setIncludeFolders(v: boolean): GooglePickerView
  setSelectFolderEnabled(v: boolean): GooglePickerView
  setParent(v: string): GooglePickerView
  setEnableDrives(v: boolean): GooglePickerView
}
interface GooglePicker {
  ViewId: { DOCS: string }
  Feature: { MULTISELECT_ENABLED: string; SUPPORT_DRIVES: string }
  Action: { PICKED: string; CANCEL: string }
  DocsView: new (id: string) => GooglePickerView
  PickerBuilder: new () => GooglePickerBuilder
}
interface GooglePickerBuilder {
  setDeveloperKey(k: string): GooglePickerBuilder
  setAppId(k: string): GooglePickerBuilder
  setOAuthToken(k: string): GooglePickerBuilder
  setOrigin(o: string): GooglePickerBuilder
  addView(v: GooglePickerView): GooglePickerBuilder
  enableFeature(f: string): GooglePickerBuilder
  setTitle(t: string): GooglePickerBuilder
  setCallback(fn: (data: { action: string; docs?: PickerDoc[] }) => void): GooglePickerBuilder
  build(): { setVisible(v: boolean): void }
}

const page = globalThis as unknown as {
  document: {
    getElementById(id: string): El | null
    createElement(tag: string): El & { src: string; onload: () => void; onerror: () => void }
    head: El
    title: string
  }
  location: { origin: string }
  close(): void
  setTimeout(fn: () => void, ms: number): void
  gapi?: { load(name: string, opts: { callback: () => void }): void }
  google?: { picker: GooglePicker }
  liaisonPage: {
    params: Record<string, unknown>
    connectionToken?: { token: string; identifier: string }
    call(route: string, body?: unknown): Promise<unknown>
  }
}

const doc = page.document
const root = doc.getElementById("root")
const heading = doc.createElement("h1")
const status = doc.createElement("p")
const again = doc.createElement("button")
heading.textContent = "Choose files for Liaison"
status.setAttribute("data-testid", "drive-picker-status")
again.setAttribute("data-testid", "drive-picker-again")
again.textContent = "Choose again"
again.hidden = true
root?.append(heading, status, again)

const say = (text: string) => {
  status.textContent = text
}

const token = page.liaisonPage.connectionToken?.token
const apiKey = page.liaisonPage.params.apiKey
const appId = page.liaisonPage.params.appId

function open(): void {
  const G = page.google?.picker
  if (!G || !token || typeof apiKey !== "string" || typeof appId !== "string") {
    say("The Google Picker could not start. Close this window and try again.")
    return
  }
  const view = () => new G.DocsView(G.ViewId.DOCS).setIncludeFolders(true).setSelectFolderEnabled(true)
  const mine = view().setParent("root")
  const all = view()
  const shared = view().setEnableDrives(true)
  let builder = new G.PickerBuilder()
    .setDeveloperKey(apiKey)
    .setAppId(appId)
    .setOAuthToken(token)
    .addView(mine)
    .addView(all)
    .addView(shared)
    .enableFeature(G.Feature.MULTISELECT_ENABLED)
    .enableFeature(G.Feature.SUPPORT_DRIVES)
    .setTitle(`Choose files for Liaison (${page.liaisonPage.connectionToken?.identifier ?? "Drive"})`)
    .setCallback(picked)
  // On the app's own origin the Picker answers that origin; an opaque origin has none to give.
  if (page.location.origin && page.location.origin !== "null") builder = builder.setOrigin(page.location.origin)
  builder.build().setVisible(true)
}

function picked(data: { action: string; docs?: PickerDoc[] }): void {
  const A = page.google?.picker.Action
  if (!A) return
  if (data.action === A.CANCEL) {
    say("Nothing was picked.")
    again.hidden = false
    return
  }
  if (data.action !== A.PICKED) return
  const add = (data.docs ?? []).map((d) => ({
    id: d.id,
    name: d.name || d.id,
    mimeType: d.mimeType || "application/octet-stream",
  }))
  say("Saving…")
  page.liaisonPage
    .call("savePicks", { add })
    .then(() => {
      say(`Saved: Liaison now sees ${add.length} more item${add.length === 1 ? "" : "s"}. You can close this window.`)
      again.hidden = false
      page.setTimeout(() => {
        try {
          page.close()
        } catch {
          // A window the person opened themselves stays open.
        }
      }, 1500)
    })
    .catch(() => {
      say("The picks were not saved. Try again.")
      again.hidden = false
    })
}

again.addEventListener("click", () => {
  again.hidden = true
  say("")
  open()
})

if (!token) {
  say("This Drive connection has no access right now: reconnect Google Drive in Liaison, then try again.")
} else {
  const loader = doc.createElement("script")
  loader.src = "https://apis.google.com/js/api.js"
  loader.onload = () => page.gapi?.load("picker", { callback: open })
  loader.onerror = () => say("Google's picker could not load. Check your connection and try again.")
  doc.head.append(loader)
}

export {}
