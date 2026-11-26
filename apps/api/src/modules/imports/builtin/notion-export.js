// SPDX-License-Identifier: FSL-1.1-ALv2
// Built-in transform: a Notion workspace export ("Markdown & CSV", one zip or a
// zip of zips) into knowledge folders and pages (builtin/registry.ts).
//
// Input, in this order (the registry's file rules):
//   (listing)        every entry name and size, first;
//   *_all.csv, *.csv a database's rows (the "_all" file wins over the view);
//   *.md             one page each (a page over 1 MB is skipped and named by
//                    the engine).
// A page or database is known by the 32-hex id ending its name. Its children
// sit in a folder of the same name, with the id (current exports) or without
// it (older exports).
//
// Emits, for the knowledge kinds:
//   knowledge.collection  every page with children and every database,
//                         parents first;
//   knowledge.document    every page; a page with children is its folder's
//                         page (indexOfCollectionRef); a database is a page
//                         holding a table of its first 200 rows, its row
//                         pages inside its folder.
// In a body, a link to an exported page is [label](notion-ref:<id>), a file of
// the export is ![alt](import-file:<ref>) (an image) or [label](import-file:<ref>),
// named in `attachments`. A link to a page that is not in this export keeps
// its id too: the knowledge import resolves it to a page an earlier import made,
// or names it. What does not come across is named in `losses` ({what, where}):
// web images, embeds, unknown blocks, files missing from the export, rows past
// 200, relation columns (kept as text). Comments and synced blocks are not in a Markdown export at all.
const PARAMS = { access: "private" }

const LISTING = "(listing)"
const MAX_ENTRIES = 20000
const MAX_TABLE_ROWS = 200
const CELL_CHARS = 500
const TITLE_CHARS = 240
const HEX_RE = /^(.*?)\s*([0-9a-f]{32})$/
const ACCESS = { private: "none", view: "viewer", edit: "editor" }

function baseName(path) {
  const i = path.lastIndexOf("/")
  return i < 0 ? path : path.slice(i + 1)
}

function dirName(path) {
  const i = path.lastIndexOf("/")
  return i < 0 ? "" : path.slice(0, i)
}

function joinPath(dir, name) {
  return dir ? dir + "/" + name : name
}

/** "Title <hex>.md" -> {title, hex, ext, all}; null when the name has no id. */
function parseName(path) {
  const base = baseName(path)
  const dot = base.lastIndexOf(".")
  if (dot < 0) return null
  const ext = base.slice(dot + 1).toLowerCase()
  let stem = base.slice(0, dot)
  let all = false
  if (ext === "csv" && stem.endsWith("_all")) {
    all = true
    stem = stem.slice(0, -4)
  }
  const m = HEX_RE.exec(stem)
  if (!m) return null
  return { title: clip(m[1].trim() || "Untitled", TITLE_CHARS), hex: m[2], ext: ext, all: all }
}

function clip(text, n) {
  return text.length > n ? text.slice(0, n) : text
}

/** A relative link target to a path of the export, from the folder `dir`. */
function resolvePath(dir, target) {
  let raw = target.split("#")[0].split("?")[0]
  try {
    raw = decodeURIComponent(raw)
  } catch (_e) {
    // a stray % stays as it is
  }
  const parts = dir ? dir.split("/") : []
  for (const seg of raw.split("/")) {
    if (seg === "" || seg === ".") continue
    if (seg === "..") parts.pop()
    else parts.push(seg)
  }
  return parts.join("/")
}

/** The 32-hex id a link names: a notion.so URL or an exported file. */
function linkedHex(target) {
  const m = /([0-9a-f]{32})(?:\.(?:md|csv))?(?:[?#].*)?$/.exec(
    target.replace(/-/g, "").replace(/%20/g, " "),
  )
  return m ? m[1] : null
}

// ---------------------------------------------------------------------------
// Listing: the tree, from the names alone
// ---------------------------------------------------------------------------

function addListing(st, entries) {
  for (const e of entries) {
    st.count++
    if (st.count > MAX_ENTRIES) {
      throw new Error(
        "The export holds more than " +
          MAX_ENTRIES +
          " files; a Notion import reads at most " +
          MAX_ENTRIES +
          ". Export a part of the workspace (a top page and its children) at a time.",
      )
    }
    let d = dirName(e.path)
    while (d && !st.dirs[d]) {
      st.dirs[d] = 1
      d = dirName(d)
    }
    const n = parseName(e.path)
    if (!n || (n.ext !== "md" && n.ext !== "csv")) continue
    // A folder that holds a page (not only a page's files) makes its page a folder.
    st.dirs[dirName(e.path)] = 2
    const known = st.raw[n.hex]
    if (known && known.k === "d" && n.ext === "csv") {
      if (n.all) known.all = 1
      continue
    }
    if (known) continue
    st.raw[n.hex] = {
      t: n.title,
      d: dirName(e.path),
      k: n.ext === "csv" ? "d" : "p",
      all: n.all ? 1 : 0,
    }
  }
}

/** After the listing: parents, folders, and the collections, parents first. */
function settle(st, ctx) {
  const owner = {}
  for (const hex of Object.keys(st.raw)) {
    const r = st.raw[hex]
    for (const folder of [joinPath(r.d, r.t + " " + hex), joinPath(r.d, r.t)]) {
      if (st.dirs[folder] === 2 && !owner[folder]) owner[folder] = hex
    }
  }
  const folderOf = {}
  for (const folder of Object.keys(owner)) folderOf[owner[folder]] = 1
  const items = {}
  for (const hex of Object.keys(st.raw)) {
    const r = st.raw[hex]
    // Kept small (the state carries it across calls): absent keys are false.
    const it = { t: r.t }
    if (owner[r.d]) it.p = owner[r.d]
    if (r.k === "d" || folderOf[hex]) it.f = 1
    if (r.k === "d") it.k = "d"
    if (r.all) it.all = 1
    items[hex] = it
  }
  st.items = items
  st.raw = null
  st.dirs = null
  st.settled = true
  const depth = (hex) => {
    let n = 0
    let p = items[hex].p
    while (p && items[p] && n < 1000) {
      n++
      p = items[p].p
    }
    return n
  }
  const folders = Object.keys(items)
    .filter((hex) => items[hex].f)
    .map((hex) => ({ hex: hex, depth: depth(hex) }))
    .sort((a, b) => a.depth - b.depth || (a.hex < b.hex ? -1 : 1))
  const shared = PARAMS.access !== "private"
  const out = folders.map((f) => {
    const it = items[f.hex]
    const rec = { externalRef: f.hex, name: it.t, shared: shared }
    if (it.p) rec.parentExternalRef = it.p
    return rec
  })
  return out.length > 0 ? ctx.emitRecords("knowledge.collection", out) : null
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

function documentRecord(st, hex, body, attachments, losses) {
  const it = st.items[hex]
  const rec = {
    externalRef: hex,
    title: it.t,
    body: body,
    collectionRefs: it.p ? [it.p] : [],
    orgAccess: ACCESS[PARAMS.access] || "none",
  }
  if (it.f) rec.indexOfCollectionRef = hex
  if (attachments.length > 0) rec.attachments = attachments
  if (losses.length > 0) rec.losses = losses
  return rec
}

/** The line without its HTML tags, removed until none is left (`<a<b>>` included). */
// A Notion callout's icon: one emoji (a surrogate pair or a symbol, its variation
// selector) and the spaces after it. Those that warn make a WARNING callout.
const CALLOUT_ICON = /^((?:[\uD83C-\uDBFF][\uDC00-\uDFFF]|[\u2600-\u27BF\u2B00-\u2BFF])\uFE0F?)\s*/
const WARNING_ICONS = ["\u26A0", "\u2757", "\u203C", "\u26D4", "\uD83D\uDEA8", "\uD83D\uDED1"]

function stripTags(line) {
  let out = line
  let before
  do {
    before = out
    out = out.replace(/<[^>]*>/g, "")
  } while (out !== before)
  return out.trim()
}

/** One page's Markdown into the knowledge body, its files and its losses. */
async function convertPage(st, ctx, path, text) {
  const n = parseName(path)
  const it = st.items[n.hex]
  const where = it.t
  const dir = dirName(path)
  const losses = []
  const lost = {}
  const loss = (what, once) => {
    if (once) {
      if (lost[what]) return
      lost[what] = 1
    }
    losses.push({ what: what, where: where })
  }
  const attachments = []
  const fileRefs = {}
  let lines = text.replace(/\r\n?/g, "\n").split("\n")
  // The first-line title repeats the page's name.
  if (lines.length > 0 && /^#\s+/.test(lines[0]) && lines[0].replace(/^#\s+/, "").trim() === it.t) {
    lines = lines.slice(1)
  }
  // A database row's properties ("Status: Done") lead the page: a list.
  if (it.p && st.items[it.p] && st.items[it.p].k === "d") {
    let i = 0
    while (i < lines.length && lines[i].trim() === "") i++
    while (
      i < lines.length &&
      /^[^:\n]{1,100}: .*$/.test(lines[i]) &&
      !/^\s*[-*>#|]/.test(lines[i])
    ) {
      const at = lines[i].indexOf(": ")
      lines[i] = "- **" + lines[i].slice(0, at).trim() + ":** " + lines[i].slice(at + 2)
      i++
    }
  }
  const out = []
  let inAside = false
  // A callout's marker line (`> [!NOTE]`), and whether its icon line is still to come.
  let asideMarker = -1
  let asideIcon = false
  // Notion's callout icon starts its first line: the kind it stands for, and the
  // text without it (the callout draws its own icon).
  const calloutText = (text) => {
    if (!asideIcon || !text.trim()) return text
    asideIcon = false
    const icon = CALLOUT_ICON.exec(text)
    if (!icon) return text
    if (WARNING_ICONS.indexOf(icon[1].replace(/\uFE0F/g, "")) >= 0)
      out[asideMarker] = "> [!WARNING]"
    return text.slice(icon[0].length)
  }
  for (const raw of lines) {
    let line = raw
    const t = line.trim()
    if (/^<aside>/i.test(t)) {
      inAside = true
      out.push("> [!NOTE]")
      asideMarker = out.length - 1
      asideIcon = true
      const rest = calloutText(stripTags(t))
      if (rest) out.push("> " + rest)
      continue
    }
    if (/^<\/aside>/i.test(t)) {
      inAside = false
      // An empty callout is no callout.
      if (asideMarker === out.length - 1) out.pop()
      continue
    }
    if (/^<details/i.test(t) || /^<\/details>/i.test(t)) {
      const summary = /<summary>(.*?)<\/summary>/i.exec(t)
      if (summary) out.push("#### " + stripTags(summary[1]))
      continue
    }
    if (/^<summary>/i.test(t)) {
      out.push("#### " + stripTags(t))
      continue
    }
    if (/^<(iframe|embed|video|audio|object)\b/i.test(t)) {
      const src = /src=\x22([^\x22]+)\x22/i.exec(t)
      loss("embed" + (src ? " (" + src[1] + ")" : ""), false)
      if (src) out.push("[" + src[1] + "](" + src[1] + ")")
      continue
    }
    if (/^<(?!br\b)[a-z][a-z0-9]*\b[^>]*>/i.test(t)) {
      const tag = /^<([a-z][a-z0-9]*)/i.exec(t)[1].toLowerCase()
      loss("unknown block <" + tag + ">", true)
      const kept = stripTags(t)
      if (kept) out.push(kept)
      continue
    }
    if (inAside) line = "> " + calloutText(line)
    out.push(line)
  }
  let body = out.join("\n")
  // Files and links, rewritten one by one (an await per file).
  const pieces = []
  const re = /(!?)\[([^\]]*)\]\(([^)\s]+)\)/g
  let last = 0
  let m = re.exec(body)
  while (m !== null) {
    pieces.push(body.slice(last, m.index))
    last = re.lastIndex
    const image = m[1] === "!"
    const label = m[2]
    const target = m[3]
    pieces.push(await rewriteLink(st, ctx, dir, image, label, target, fileRefs, attachments, loss))
    m = re.exec(body)
  }
  pieces.push(body.slice(last))
  body = pieces.join("")
  return documentRecord(st, n.hex, body, attachments, losses)
}

async function rewriteLink(st, ctx, dir, image, label, target, fileRefs, attachments, loss) {
  const web = /^[a-z][a-z0-9+.-]*:/i.test(target)
  if (web) {
    if (image) {
      loss("web image (" + target + ")", false)
      return "[" + (label || "image") + "](" + target + ")"
    }
    if (/notion\.so\//i.test(target)) {
      const hex = linkedHex(target)
      // A page of this export, or of an earlier one: the link pass resolves it
      // once every page is written, and names it when there is no such page.
      if (hex) return "[" + (label || target) + "](notion-ref:" + hex + ")"
      loss("link to a page not in the export (" + (label || target) + ")", false)
      return label
    }
    return "[" + label + "](" + target + ")"
  }
  const path = resolvePath(dir, target)
  const named = parseName(path)
  if (!image && named && (named.ext === "md" || named.ext === "csv")) {
    return "[" + (label || named.title) + "](notion-ref:" + named.hex + ")"
  }
  let ref = fileRefs[path]
  if (ref === undefined) {
    let fileId = null
    try {
      fileId = await ctx.declareFile(path)
    } catch (_e) {
      fileId = null
    }
    if (fileId === null) {
      loss("file missing from the export (" + path + ")", false)
      fileRefs[path] = null
      return label
    }
    ref = String(attachments.length + 1)
    fileRefs[path] = ref
    attachments.push({ fileId: fileId, ref: ref })
  }
  if (ref === null) return label
  return (image ? "!" : "") + "[" + label + "](import-file:" + ref + ")"
}

// ---------------------------------------------------------------------------
// Databases
// ---------------------------------------------------------------------------

function cell(value) {
  return clip(String(value == null ? "" : value), CELL_CHARS)
    .replace(/\r?\n/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
}

/** A relation or rollup value ("Name (Name%20<id>.md)") as its text. */
function relationText(value) {
  return String(value).replace(/\s*\([^)]*[0-9a-f]{32}(?:\.md|\.csv)?\)/g, "")
}

function hasRelation(value) {
  return /\([^)]*[0-9a-f]{32}(?:\.md|\.csv)?\)|notion\.so\//.test(String(value))
}

/** The pending database's page: a table of its first rows, with its losses. */
function flushDatabase(st) {
  const db = st.db
  st.db = null
  if (!db) return null
  const it = st.items[db.hex]
  const losses = []
  const cols = db.cols
  const rowPages = {}
  for (const hex of Object.keys(st.items)) {
    const r = st.items[hex]
    if (r.p === db.hex && r.k !== "d" && !rowPages[r.t]) rowPages[r.t] = hex
  }
  for (const c of cols) {
    if (db.rel[c]) losses.push({ what: "relation column kept as text (" + c + ")", where: it.t })
  }
  if (db.more > 0) {
    losses.push({
      what: db.more + " rows past the first " + MAX_TABLE_ROWS + " are not in the table",
      where: it.t,
    })
  }
  const lines = []
  if (cols.length > 0) {
    lines.push("| " + cols.map(cell).join(" | ") + " |")
    lines.push("|" + cols.map(() => " --- ").join("|") + "|")
    for (const row of db.rows) {
      const cells = cols.map((c, i) => {
        const v = db.rel[c] ? relationText(row[c]) : row[c]
        const text = cell(v)
        const page = i === 0 ? rowPages[String(v == null ? "" : v).trim()] : null
        return page ? "[" + text + "](notion-ref:" + page + ")" : text
      })
      lines.push("| " + cells.join(" | ") + " |")
    }
  }
  return documentRecord(st, db.hex, lines.join("\n"), [], losses)
}

function addRows(st, path, records) {
  const n = parseName(path)
  const it = n ? st.items[n.hex] : null
  if (!it || it.k !== "d") return
  if (!n.all && it.all) return // the "_all" file of this database is read instead
  if (st.db && st.db.hex !== n.hex) return
  if (!st.db) {
    st.db = { hex: n.hex, cols: [], rows: [], more: 0, rel: {} }
    if (records.length > 0) st.db.cols = Object.keys(records[0])
  }
  const db = st.db
  for (const r of records) {
    for (const c of db.cols) if (!db.rel[c] && hasRelation(r[c])) db.rel[c] = 1
    if (db.rows.length < MAX_TABLE_ROWS) {
      const row = {}
      for (const c of db.cols) row[c] = clip(String(r[c] == null ? "" : r[c]), CELL_CHARS)
      db.rows.push(row)
    } else db.more++
  }
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

async function transform(batch, ctx) {
  const st = batch.state || { count: 0, dirs: {}, raw: {}, settled: false, db: null, done: {} }
  if (batch.file === LISTING) {
    for (const r of batch.records) addListing(st, r.entries)
    return { state: st }
  }
  if (!st.settled) await settle(st, ctx)
  const name = parseName(batch.file)
  if (!name) return { state: st }
  const docs = []
  if (name.ext === "csv") {
    // A new database file ends the one before it.
    if (st.db && st.db.hex !== name.hex) {
      const prev = flushDatabase(st)
      if (prev) docs.push(prev)
    }
    if (!st.done[name.hex]) addRows(st, batch.file, batch.records)
  } else if (name.ext === "md" && st.items[name.hex] && st.items[name.hex].k !== "d") {
    if (st.db) {
      const prev = flushDatabase(st)
      if (prev) docs.push(prev)
    }
    for (const r of batch.records) {
      if (typeof r.text === "string") docs.push(await convertPage(st, ctx, batch.file, r.text))
    }
  }
  for (const d of docs) if (st.items[d.externalRef].k === "d") st.done[d.externalRef] = 1
  if (docs.length > 0) await ctx.emitRecords("knowledge.document", docs)
  return { state: st }
}

async function finish(batch, ctx) {
  const st = batch.state || { count: 0, dirs: {}, raw: {}, settled: false, db: null, done: {} }
  if (!st.settled) await settle(st, ctx)
  const docs = []
  const last = flushDatabase(st)
  if (last) docs.push(last)
  // A database whose CSV is missing from the export still gets its page.
  for (const hex of Object.keys(st.items)) {
    const it = st.items[hex]
    if (it.k === "d" && !st.done[hex] && !docs.some((d) => d.externalRef === hex)) {
      docs.push(
        documentRecord(
          st,
          hex,
          "",
          [],
          [{ what: "the database's rows are not in the export", where: it.t }],
        ),
      )
    }
  }
  if (docs.length > 0) await ctx.emitRecords("knowledge.document", docs)
  return {}
}
