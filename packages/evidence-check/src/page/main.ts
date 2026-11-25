// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The checker page's script, bundled inline into check.html. Every string
// from the evidence (names, capacities, file names) reaches the page through
// `textContent` only: nothing is ever parsed as markup.
import {
  checkFile,
  checkPackage,
  type EvidenceData,
  type Hasher,
  OPENSSL_VERIFY_LINE,
  type PackageCheck,
  pickHasher,
} from "../check"
import { format, STRINGS, type StringKey } from "./strings"

type Lang = keyof typeof STRINGS

function el(
  tag: string,
  opts: { testid?: string; cls?: string; text?: string } = {},
  ...kids: Node[]
): HTMLElement {
  const node = document.createElement(tag)
  if (opts.testid) node.setAttribute("data-testid", opts.testid)
  if (opts.cls) node.className = opts.cls
  if (opts.text !== undefined) node.textContent = opts.text
  for (const k of kids) node.appendChild(k)
  return node
}

function readData(): EvidenceData | null {
  const node = document.getElementById("evidence-data")
  if (!node?.textContent) return null
  try {
    const d = JSON.parse(node.textContent) as EvidenceData
    if (d.v !== 1 || typeof d.manifest !== "string" || typeof d.trail !== "string") return null
    return d
  } catch {
    return null
  }
}

function fingerprint(label: string, value: string, testid: string): HTMLElement {
  return el(
    "div",
    { cls: "fp" },
    el("div", { cls: "label", text: label }),
    el("code", { testid, text: value }),
  )
}

function renderPackage(
  root: HTMLElement,
  t: (k: StringKey, p?: Record<string, string | number>) => string,
  data: EvidenceData,
  pkg: PackageCheck,
  hasher: Hasher,
) {
  const m = pkg.manifest
  const status = (ok: boolean, text: string, testid: string) =>
    el("p", { testid, cls: ok ? "ok" : "bad", text })

  const seal = el(
    "section",
    { testid: "evidence-seal" },
    el("h2", { text: t("sealTitle") }),
    el("code", { testid: "evidence-seal-value", text: pkg.seal }),
    el("p", { text: t("sealDetail") }),
    status(
      pkg.manifestCanonical && pkg.recomputedSeal === pkg.seal,
      pkg.manifestCanonical ? t("manifestCanonical") : t("manifestNotCanonical"),
      "evidence-manifest-status",
    ),
  )

  const trailText =
    pkg.trail.kind === "sealed"
      ? t("trailSealed")
      : pkg.trail.kind === "mismatch"
        ? t("trailMismatch")
        : pkg.trail.kind === "copy"
          ? t("trailCopy", { org: data.org })
          : t("trailUnreadable")
  const events = el("ul", { testid: "evidence-events" })
  for (const e of pkg.events) {
    const item = el("li", {
      testid: "evidence-event",
      text: t("eventLine", { name: e.name, capacity: e.capacity, time: e.signedAt }),
    })
    if (e.ip || e.userAgent) {
      item.appendChild(
        el("div", { cls: "muted", text: t("device", { ip: e.ip ?? "", ua: e.userAgent ?? "" }) }),
      )
    }
    events.appendChild(item)
  }
  const trail = el(
    "section",
    { testid: "evidence-trail" },
    el("h2", { text: t("events") }),
    el("p", {
      testid: "evidence-trail-status",
      cls: pkg.trail.kind === "sealed" || pkg.trail.kind === "copy" ? "" : "bad",
      text: trailText,
    }),
    events,
  )

  const token = el("section", { testid: "evidence-timestamp" })
  const tk = pkg.token
  if (tk.kind === "absent")
    token.appendChild(el("p", { testid: "evidence-token-status", text: t("tokenAbsent") }))
  else if (tk.kind === "unreadable")
    token.appendChild(status(false, t("tokenUnreadable"), "evidence-token-status"))
  else if (tk.kind === "refused")
    token.appendChild(
      status(false, t("tokenRefused", { status: tk.status }), "evidence-token-status"),
    )
  else {
    token.appendChild(
      status(
        tk.namesSeal,
        tk.namesSeal ? t("tokenNamesSeal") : t("tokenNotSeal"),
        "evidence-token-status",
      ),
    )
    token.appendChild(
      el("p", {
        text: t("tokenTime", {
          time: tk.genTime.toISOString().replace(".000Z", "Z"),
          serial: tk.serialHex,
          policy: tk.policy,
        }),
      }),
    )
  }
  if (tk.kind !== "absent") {
    token.appendChild(
      el("p", { testid: "evidence-signature-not-checked", text: t("signatureNotChecked") }),
    )
    token.appendChild(el("pre", { testid: "evidence-openssl-line", text: OPENSSL_VERIFY_LINE }))
  }

  const result = el("section", { testid: "evidence-result", cls: "result" })
  result.hidden = true
  const input = el("input", { testid: "evidence-file-input" }) as HTMLInputElement
  input.type = "file"
  const drop = el(
    "label",
    { testid: "evidence-drop", cls: "drop" },
    el("span", { text: t("choose") }),
    input,
  )

  const show = async (file: File) => {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const r = await checkFile(bytes, m, hasher)
    result.replaceChildren()
    result.hidden = false
    const ok = r.match !== "other"
    result.className = ok ? "result ok" : "result bad"
    result.appendChild(
      el("h2", { testid: "evidence-verdict", text: ok ? t("match") : t("noMatch") }),
    )
    result.appendChild(
      el("p", {
        testid: "evidence-verdict-detail",
        text:
          r.match === "document"
            ? t("matchDocument", { file: file.name })
            : r.match === "signed_pdf"
              ? t("matchSigned", { file: file.name })
              : t("noMatchDetail", { file: file.name }),
      }),
    )
    if (ok && pkg.problems.length > 0) {
      result.appendChild(
        el("p", { testid: "evidence-package-problem", cls: "bad", text: t("packageProblem") }),
      )
    }
    result.appendChild(fingerprint(t("fileFingerprint"), r.sha256, "evidence-file-fingerprint"))
    result.appendChild(
      fingerprint(t("documentFingerprint"), m.document_sha256, "evidence-document-fingerprint"),
    )
    result.appendChild(
      fingerprint(t("signedFingerprint"), m.signed_pdf_sha256, "evidence-signed-fingerprint"),
    )
  }
  input.addEventListener("change", () => {
    const f = input.files?.[0]
    if (f) void show(f)
  })
  drop.addEventListener("dragover", (ev) => ev.preventDefault())
  drop.addEventListener("drop", (ev) => {
    ev.preventDefault()
    const f = (ev as DragEvent).dataTransfer?.files?.[0]
    if (f) void show(f)
  })

  root.append(
    el("p", {
      testid: "evidence-agreement",
      text: t("agreement", { agreement: m.agreement, version: m.version }),
    }),
    el("p", { text: t("intro") }),
    drop,
    result,
    seal,
    token,
    trail,
    el("p", {
      testid: "evidence-hash-method",
      cls: "muted",
      text: hasher.method === "webcrypto" ? t("hashWebcrypto") : t("hashBuiltin"),
    }),
  )
}

async function main() {
  const root = document.getElementById("app")
  if (!root) return
  const data = readData()
  const lang: Lang = data?.lang === "fr" ? "fr" : "en"
  const t = (k: StringKey, p?: Record<string, string | number>) => format(STRINGS[lang][k], p)
  document.documentElement.lang = lang
  document.title = t("title")
  root.appendChild(el("h1", { text: t("title") }))
  if (!data) {
    root.appendChild(el("p", { testid: "evidence-no-data", cls: "bad", text: t("noData") }))
    return
  }
  const hasher = pickHasher()
  const pkg = await checkPackage(data, hasher)
  if (!pkg) {
    root.appendChild(
      el("p", { testid: "evidence-manifest-status", cls: "bad", text: t("manifestUnreadable") }),
    )
    return
  }
  renderPackage(root, t, data, pkg, hasher)
  root.setAttribute("data-ready", "true")
}

void main()
