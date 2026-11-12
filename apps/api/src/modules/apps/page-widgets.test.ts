// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The platform's page widgets, without a browser: the grant rule, the params,
// the manifest checks, and the Google Picker script run against a fake DOM and
// a fake Google Picker (the real one needs a Google sign-in).
import { describe, expect, it } from "bun:test"
import {
  grantBeyondWidget,
  type PageWidgetDecl,
  widgetErrors,
  widgetParams,
  widgetScript,
} from "~/modules/apps/page-widgets"

const DRIVE_FILE = "https://www.googleapis.com/auth/drive.file"
const DRIVE_READONLY = "https://www.googleapis.com/auth/drive.readonly"
const decl: PageWidgetDecl = {
  kind: "google-picker",
  connection: "drive",
  route: "savePicks",
  tokenScopes: [DRIVE_FILE],
}

describe("the token a widget may carry", () => {
  it("only a grant inside tokenScopes plus sign-in scopes; an unknown grant is refused", () => {
    expect(grantBeyondWidget(decl, [DRIVE_FILE, "openid", "email", "profile"])).toEqual([])
    expect(grantBeyondWidget(decl, [DRIVE_FILE, DRIVE_READONLY])).toEqual([DRIVE_READONLY])
    expect(grantBeyondWidget(decl, "unknown")).toBe("unknown")
  })

  it("needs its params as short strings from the app's own link", () => {
    expect(widgetParams(decl, { apiKey: "k", appId: "1", account: "x" })).toEqual({
      apiKey: "k",
      appId: "1",
    })
    expect(widgetParams(decl, { apiKey: "k" })).toBeNull()
    expect(widgetParams(decl, { apiKey: "k", appId: 1 })).toBeNull()
  })

  it("checks the manifest: an oauth2 connection, one of the page's routes, declared and unrestricted scopes", () => {
    const conn = {
      type: "oauth2",
      scopes: [DRIVE_FILE, DRIVE_READONLY],
      restrictedScopes: [DRIVE_READONLY],
    }
    expect(widgetErrors("picker", decl, { routes: ["savePicks"] }, conn)).toEqual([])
    expect(widgetErrors("picker", decl, { routes: [] }, conn).join()).toContain(
      "not one of the page's routes",
    )
    expect(
      widgetErrors(
        "picker",
        { ...decl, tokenScopes: [DRIVE_READONLY] },
        { routes: ["savePicks"] },
        conn,
      ).join(),
    ).toContain("restricted scope")
    expect(
      widgetErrors(
        "picker",
        { ...decl, tokenScopes: ["other"] },
        { routes: ["savePicks"] },
        conn,
      ).join(),
    ).toContain("not a scope of the connection")
    expect(
      widgetErrors("picker", decl, { routes: ["savePicks"] }, { type: "credentials" }).join(),
    ).toContain("not an oauth2 connection")
  })
})

/** A DOM just big enough for the widget script. */
function fakePage() {
  const nodes: Record<string, any> = {}
  const el = (tag: string): any => {
    const node: any = {
      tag,
      textContent: "",
      hidden: false,
      attrs: {} as Record<string, string>,
      children: [] as any[],
      listeners: {} as Record<string, () => void>,
      append(...c: any[]) {
        node.children.push(...c)
        for (const x of c) if (x?.tag === "script") scripts.push(x)
      },
      setAttribute(k: string, v: string) {
        node.attrs[k] = v
        if (k === "data-testid") nodes[v] = node
      },
      addEventListener(t: string, fn: () => void) {
        node.listeners[t] = fn
      },
    }
    return node
  }
  const scripts: any[] = []
  const root = el("div")
  const document = {
    getElementById: (id: string) => (id === "root" ? root : null),
    createElement: el,
    head: el("head"),
  }
  return { document, nodes, scripts }
}

/** Google's Picker, faked: building it records the options; setVisible answers `answer`. */
function fakeGoogle(answer: { action: string; docs?: unknown[] }) {
  const built: Record<string, unknown> = {}
  class View {
    setIncludeFolders() {
      return this
    }
    setSelectFolderEnabled() {
      return this
    }
    setParent() {
      return this
    }
    setEnableDrives() {
      return this
    }
  }
  class Builder {
    cb: (d: unknown) => void = () => {}
    setDeveloperKey(k: string) {
      built.key = k
      return this
    }
    setAppId(k: string) {
      built.appId = k
      return this
    }
    setOAuthToken(k: string) {
      built.token = k
      return this
    }
    setOrigin(o: string) {
      built.origin = o
      return this
    }
    addView() {
      return this
    }
    enableFeature() {
      return this
    }
    setTitle(t: string) {
      built.title = t
      return this
    }
    setCallback(cb: (d: unknown) => void) {
      this.cb = cb
      return this
    }
    build() {
      return { setVisible: () => this.cb(answer) }
    }
  }
  const picker = {
    ViewId: { DOCS: "docs" },
    Feature: { MULTISELECT_ENABLED: "m", SUPPORT_DRIVES: "s" },
    Action: { PICKED: "picked", CANCEL: "cancel" },
    DocsView: View,
    PickerBuilder: Builder,
  }
  return {
    built,
    google: { picker },
    gapi: { load: (_n: string, o: { callback: () => void }) => o.callback() },
  }
}

async function runWidget(answer: { action: string; docs?: unknown[] }, callFails = false) {
  const page = fakePage()
  const g = fakeGoogle(answer)
  const calls: Array<{ route: string; body: unknown }> = []
  const window: any = {
    location: { origin: "https://acme.liaison.example" },
    google: g.google,
    gapi: g.gapi,
    close() {},
    liaisonPage: {
      params: {},
      call: (route: string, body: unknown) => {
        calls.push({ route, body })
        return callFails ? Promise.reject(new Error("no")) : Promise.resolve({ ok: true })
      },
    },
  }
  const script = widgetScript(decl, {
    token: "ya29.fake",
    identifier: "me@example.com",
    route: "savePicks",
    params: { apiKey: "dev-key", appId: "1234" },
  })
  new Function("window", "document", "setTimeout", script)(window, page.document, () => undefined)
  // The platform script loads Google's script; its onload runs the picker.
  const loader = page.scripts[0]
  expect(loader.src).toBe("https://apis.google.com/js/api.js")
  loader.onload()
  await new Promise((r) => setTimeout(r, 0))
  return {
    built: g.built,
    calls,
    status: page.nodes["page-widget-status"],
    again: page.nodes["page-widget-again"],
  }
}

describe("the Google Picker widget script (fake Google Picker)", () => {
  it("opens with the account's token on the real origin and sends only the picks to the app's route", async () => {
    const r = await runWidget({
      action: "picked",
      docs: [{ id: "f1", name: "Price list", mimeType: "application/pdf" }, { id: "d1" }],
    })
    expect(r.built).toEqual({
      key: "dev-key",
      appId: "1234",
      token: "ya29.fake",
      origin: "https://acme.liaison.example",
      title: "Choose files for Liaison (me@example.com)",
    })
    expect(r.calls).toEqual([
      {
        route: "savePicks",
        body: {
          add: [
            { id: "f1", name: "Price list", mimeType: "application/pdf" },
            { id: "d1", name: "d1", mimeType: "application/octet-stream" },
          ],
        },
      },
    ])
    expect(JSON.stringify(r.calls)).not.toContain("ya29")
    expect(r.status.textContent).toBe(
      "Saved: Liaison now sees 2 more items. You can close this window.",
    )
  })

  it("says so when nothing was picked, and offers to choose again", async () => {
    const r = await runWidget({ action: "cancel" })
    expect(r.calls).toEqual([])
    expect(r.status.textContent).toBe("Nothing was picked.")
    expect(r.again.hidden).toBe(false)
  })

  it("says so when the picks were not saved", async () => {
    const r = await runWidget({ action: "picked", docs: [{ id: "f1" }] }, true)
    expect(r.status.textContent).toBe("The picks were not saved. Try again.")
  })
})
