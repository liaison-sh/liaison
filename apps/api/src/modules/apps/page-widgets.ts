// SPDX-License-Identifier: FSL-1.1-ALv2
//
// PAGE WIDGETS: provider screens the PLATFORM renders on an app's page.
//
// Some provider widgets run in the person's browser and need a credential there:
// Google's Picker wants the person's OAuth access token. An app page's own script
// must never hold one (app code, sandboxed on the server, reads no secret; in a
// browser it could post the token anywhere). So a page that needs such a widget
// declares it (`pages.<name>.widget`) and ships no script: the platform serves a
// page of its own, with ITS script and the provider's only, and the app's route
// receives what the person chose, never the token.
//
// The credential is narrowed by the platform, not by the app:
// - the account is the one the app's link names (`params.account`), the
//   person's own, or the organization's when they hold the connection's admin
//   scope (app-pages.ts);
// - the account's recorded grant (`grantedOAuthScopes`, written by the platform
//   at connect) must be inside the widget's `tokenScopes` plus the provider's
//   identity scopes: a broader grant (a Drive connected with `drive.readonly`)
//   never reaches a browser, and an unknown grant is refused;
// - `tokenScopes` must be scopes the connection declares and none of its
//   restricted ones (manifest check, app-surface.ts);
// - the page is served only on the org's own origin, never on an app frame host
//   (an origin the app's own code also runs on);
// - each issuance is written to the audit log with the person and the account;
// - the install screen discloses it (a page that puts a credential in the
//   person's browser).
//
// The set of widget kinds is closed: one entry per provider widget, its hosts,
// the params the app's link must bind, and its script.

import type { AppPageHosts } from "~/modules/apps/app-surface"

export type PageWidgetKind = "google-picker"

export interface PageWidgetDecl {
  kind: PageWidgetKind
  /** The oauth2 connection whose account the widget runs with. */
  connection: string
  /** The page route that receives what the person chose. */
  route: string
  /** The OAuth scopes the account's grant may hold (beyond identity scopes). */
  tokenScopes: string[]
}

/** What the platform's script receives (in its own closure, never `liaisonPage`). */
export interface PageWidgetConfig {
  token: string
  identifier: string
  route: string
  params: Record<string, string>
}

interface WidgetKindDef {
  /** Scopes a grant may carry on top of `tokenScopes` (sign-in identity only). */
  identityScopes: readonly string[]
  /** Link params (bound by the app's code) the widget needs, all strings. */
  params: readonly string[]
  hosts: AppPageHosts
  /** The page script: a function body run with `cfg` (PageWidgetConfig) and `page` (liaisonPage). */
  script: string
}

// Google's Picker: the person picks Drive files and folders; the route receives
// `{ add: [{ id, name, mimeType }] }`.
const GOOGLE_PICKER_SCRIPT = `
var doc=document,root=doc.getElementById("root");
var h=doc.createElement("h1"),st=doc.createElement("p"),again=doc.createElement("button");
h.textContent="Choose files for Liaison";
st.setAttribute("data-testid","page-widget-status");
again.setAttribute("data-testid","page-widget-again");
again.textContent="Choose again";again.hidden=true;
root.append(h,st,again);
function say(t){st.textContent=t}
function open(){
  var G=window.google&&window.google.picker;
  if(!G){say("The Google Picker could not start. Close this window and try again.");return}
  function view(){return new G.DocsView(G.ViewId.DOCS).setIncludeFolders(true).setSelectFolderEnabled(true)}
  new G.PickerBuilder()
    .setDeveloperKey(cfg.params.apiKey).setAppId(cfg.params.appId).setOAuthToken(cfg.token)
    .setOrigin(window.location.origin)
    .addView(view().setParent("root")).addView(view()).addView(view().setEnableDrives(true))
    .enableFeature(G.Feature.MULTISELECT_ENABLED).enableFeature(G.Feature.SUPPORT_DRIVES)
    .setTitle("Choose files for Liaison ("+cfg.identifier+")")
    .setCallback(picked).build().setVisible(true);
}
function picked(data){
  var A=window.google.picker.Action;
  if(data.action===A.CANCEL){say("Nothing was picked.");again.hidden=false;return}
  if(data.action!==A.PICKED)return;
  var add=(data.docs||[]).map(function(d){return{id:String(d.id),name:String(d.name||d.id),mimeType:String(d.mimeType||"application/octet-stream")}});
  say("Saving\\u2026");
  page.call(cfg.route,{add:add}).then(function(){
    say("Saved: Liaison now sees "+add.length+" more item"+(add.length===1?"":"s")+". You can close this window.");
    again.hidden=false;
    setTimeout(function(){try{window.close()}catch(e){}},1500);
  },function(){say("The picks were not saved. Try again.");again.hidden=false});
}
again.addEventListener("click",function(){again.hidden=true;say("");open()});
var s=doc.createElement("script");
s.src="https://apis.google.com/js/api.js";
s.onload=function(){window.gapi.load("picker",{callback:open})};
s.onerror=function(){say("Google's picker could not load. Check your connection and try again.")};
doc.head.append(s);
`

const KINDS: Record<PageWidgetKind, WidgetKindDef> = {
  "google-picker": {
    identityScopes: [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
    ],
    params: ["apiKey", "appId"],
    hosts: {
      script: ["apis.google.com", "www.gstatic.com"],
      frame: [
        "docs.google.com",
        "drive.google.com",
        "accounts.google.com",
        "content.googleapis.com",
      ],
      connect: ["apis.google.com", "content.googleapis.com", "www.googleapis.com"],
      image: [
        "*.googleusercontent.com",
        "ssl.gstatic.com",
        "www.gstatic.com",
        "drive-thirdparty.googleusercontent.com",
      ],
      style: ["www.gstatic.com", "fonts.googleapis.com"],
    },
    script: GOOGLE_PICKER_SCRIPT,
  },
}

export const PAGE_WIDGET_KINDS = Object.keys(KINDS) as PageWidgetKind[]

export function widgetKind(kind: PageWidgetKind): WidgetKindDef {
  return KINDS[kind]
}

/**
 * The grant scopes outside what the widget may carry, or "unknown" when the
 * account has no recorded grant. Empty: the account's token may go to the page.
 */
export function grantBeyondWidget(
  decl: PageWidgetDecl,
  grant: readonly string[] | "unknown",
): string[] | "unknown" {
  if (grant === "unknown") return "unknown"
  const allowed = new Set([...decl.tokenScopes, ...KINDS[decl.kind].identityScopes])
  return grant.filter((s) => !allowed.has(s))
}

/** The widget's params from the link, or null when one is missing or not a string. */
export function widgetParams(
  decl: PageWidgetDecl,
  params: Record<string, unknown>,
): Record<string, string> | null {
  const out: Record<string, string> = {}
  for (const name of KINDS[decl.kind].params) {
    const v = params[name]
    if (typeof v !== "string" || v.length === 0 || v.length > 512) return null
    out[name] = v
  }
  return out
}

/** The inline script that runs the widget; `cfg` lives only in its closure. */
export function widgetScript(decl: PageWidgetDecl, cfg: PageWidgetConfig): string {
  const json = JSON.stringify(cfg).replace(/</g, "\\u003c")
  // The script sits in the document's head: it runs once the body (and its
  // root element) exists.
  return (
    `(function(cfg,page){function run(){${KINDS[decl.kind].script}}` +
    `if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",run);else run();` +
    `})(${json},window.liaisonPage)`
  )
}

/** Manifest checks of a page's widget against its connection (app-surface.ts). */
export function widgetErrors(
  pageName: string,
  widget: PageWidgetDecl,
  page: { routes?: string[] },
  connection: { type?: string; scopes?: string[]; restrictedScopes?: string[] } | undefined,
): string[] {
  const at = `pages.${pageName}.widget`
  const errors: string[] = []
  if (!KINDS[widget.kind]) errors.push(`${at}.kind: unknown widget "${widget.kind}"`)
  if (connection?.type !== "oauth2") {
    errors.push(`${at}.connection: "${widget.connection}" is not an oauth2 connection`)
    return errors
  }
  if (!(page.routes ?? []).includes(widget.route)) {
    errors.push(`${at}.route: "${widget.route}" is not one of the page's routes`)
  }
  const declared = new Set(connection.scopes ?? [])
  const restricted = new Set(connection.restrictedScopes ?? [])
  for (const scope of widget.tokenScopes) {
    if (!declared.has(scope))
      errors.push(`${at}.tokenScopes: "${scope}" is not a scope of the connection`)
    if (restricted.has(scope))
      errors.push(`${at}.tokenScopes: "${scope}" is a restricted scope and never reaches a page`)
  }
  return errors
}
