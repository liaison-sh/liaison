// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * AST scan for user-visible English that bypasses `t()`.
 *
 * The line-regex lint (scripts/lint-i18n-strings.ts) documents its own gap:
 * multi-line JSX text, string props, ternaries and toast messages all slip
 * past it, and that is exactly how a French org ended up reading "Reply",
 * "Send reply" and "SLA breached". This walks the TypeScript AST instead and
 * flags a string literal when it lands somewhere a person reads it:
 *
 *  - JSX text containing a word;
 *  - a string literal (or template head) that is the value of a JSX
 *    expression container, or a branch of a conditional / `??` / `||` inside
 *    one (`{busy() ? "Saving..." : "Save"}`);
 *  - a user-facing JSX attribute (label, title, placeholder, aria-label,
 *    description, ...) given a literal;
 *  - a `message` / `label` / `title` / `description` / `placeholder` object
 *    property given a literal (toasts, menu items, option lists).
 *
 * Anything inside a call to `t(...)` / `i18n.t(...)` is a key, not copy.
 * Used by the web i18n coverage test only; never shipped.
 */
import ts from "typescript"

export interface HardcodedString {
  file: string
  line: number
  text: string
}

const UI_ATTRS = new Set([
  "label",
  "title",
  "placeholder",
  "aria-label",
  "alt",
  "description",
  "emptyText",
  "emptyLabel",
  "confirmLabel",
  "cancelLabel",
  "tooltip",
  "hint",
  "helperText",
  "subtitle",
  "heading",
  "ariaLabel",
  "emptyState",
  "emptyMessage",
  "eyebrow",
  "ctaLabel",
])

const UI_PROPS = new Set([
  "message",
  "label",
  "title",
  "description",
  "placeholder",
  "confirmLabel",
  "cancelLabel",
  "emptyText",
  "tooltip",
  "hint",
  "subtitle",
  "ariaLabel",
  "emptyState",
  "header",
  "ctaLabel",
  "eyebrow",
])

/** Does this literal read as words a person sees (not a key, id, class, url)? */
export function looksLikeCopy(raw: string): boolean {
  const s = raw.trim()
  if (s.length < 2) return false
  if (!/[A-Za-z]{2,}/.test(s)) return false
  // Single token: an identifier, key, path, url, css class or enum value.
  // A trailing ellipsis ("Saving...") is copy punctuation, not a member access.
  if (!/\s/.test(s)) {
    if (/^[A-Z][a-z]+(\.\.\.|…)$/.test(s)) return true
    if (/[./:_#@=[\](){}<>|\\]/.test(s)) return false
    if (/^[a-z0-9-]+$/.test(s)) return false // kebab/lower tokens: ids, classes, enum values
    if (/^[A-Z][a-z0-9]*[A-Z]/.test(s)) return false // PascalCase with an internal cap
    if (/^[a-z]+[A-Z]/.test(s)) return false // camelCase
    if (/^[A-Z0-9_]+$/.test(s)) return false // ALLCAPS constants, acronyms
  } else {
    // Tailwind-ish class lists: lowercase utility tokens, at least one of
    // them unmistakably a class (a variant, an arbitrary value, a fraction or
    // a utility prefix).
    const tokens = s.split(/\s+/)
    if (
      tokens.every((tok) => /^[a-z0-9!:/[\]().%#_-]+$/.test(tok)) &&
      tokens.some(
        (tok) =>
          /[:[/]/.test(tok) ||
          /^(flex|block|hidden|grid|inline|absolute|relative|sticky|truncate|text-|bg-|border|rounded|p[xytrbl]?-|m[xytrbl]?-|w-|h-|gap-|font-|shrink|grow|items-|justify-)/.test(
            tok,
          ),
      )
    )
      return false
  }
  return true
}

function isTranslateCall(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false
  const callee = node.expression
  if (ts.isIdentifier(callee))
    return callee.text === "t" || callee.text === "tr" || callee.text === "tNow"
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text === "t"
  return false
}

function insideTranslate(node: ts.Node): boolean {
  for (let p = node.parent; p; p = p.parent) {
    if (isTranslateCall(p)) return true
    if (ts.isSourceFile(p)) return false
  }
  return false
}

/** Walk up through conditional / logical wrappers to where the value lands. */
function landingSite(node: ts.Node): ts.Node | undefined {
  let cur: ts.Node = node
  for (;;) {
    const p = cur.parent
    if (!p) return undefined
    if (ts.isParenthesizedExpression(p)) {
      cur = p
      continue
    }
    if (ts.isConditionalExpression(p) && p.condition !== cur) {
      cur = p
      continue
    }
    // Either side of a `??` / `||` lands where the whole expression does
    // (`{LABEL[x] ?? t("...")}` renders the table read when it is set).
    if (
      ts.isBinaryExpression(p) &&
      (p.right === cur || p.left === cur) &&
      (p.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        p.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      cur = p
      continue
    }
    return p
  }
}

function attrName(attr: ts.JsxAttribute): string {
  return attr.name.getText()
}

function literalLandsOnScreen(
  node: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateExpression,
): boolean {
  const site = landingSite(node)
  if (!site) return false
  if (ts.isJsxExpression(site)) {
    const holder = site.parent
    if (holder && ts.isJsxAttribute(holder)) return UI_ATTRS.has(attrName(holder))
    return true // a child expression: rendered text
  }
  if (ts.isJsxAttribute(site)) return UI_ATTRS.has(attrName(site))
  if (ts.isPropertyAssignment(site) && site.initializer) {
    const name = site.name.getText().replace(/^["']|["']$/g, "")
    return UI_PROPS.has(name)
  }
  // Values a label helper hands back (`return "Status"`, `() => x ?? "Inbox"`)
  // and messages given to a UI setter (`setError("...")`, `toast("...")`).
  // Returns carry ids and enum values too, so only a sentence-shaped or
  // Capitalised literal counts there.
  const text = textOf(node)
  if (ts.isReturnStatement(site) || (ts.isArrowFunction(site) && site.body !== undefined)) {
    return readsAsSentence(text)
  }
  if (ts.isCallExpression(site) && site.arguments.some((a) => a === landingChild(node, site))) {
    const callee = site.expression.getText()
    return (
      /(^|\.)(set[A-Z]\w*(Error|Message|Status|Notice|Hint|Label)|toast|addToast|alert|confirm|notify)$/.test(
        callee,
      ) && readsAsSentence(text)
    )
  }
  return false
}

/** Capitalised word or several words: "Status", "No inboxes available". */
function readsAsSentence(text: string): boolean {
  const s = text.trim()
  return /^[A-Z][a-z]/.test(s) || /^[a-z]+(\s+[A-Za-z]+)+/.test(s)
}

/** The direct child of `site` on the path up from `node`. */
function landingChild(node: ts.Node, site: ts.Node): ts.Node {
  let cur = node
  while (cur.parent && cur.parent !== site) cur = cur.parent
  return cur
}

function textOf(
  node: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateExpression,
): string {
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(" ")
  }
  return node.text
}

export type HardcodedNode =
  | ts.JsxText
  | ts.StringLiteral
  | ts.NoSubstitutionTemplateLiteral
  | ts.TemplateExpression

/** The AST nodes carrying hardcoded copy (the codemod and the scan share it). */
export function findHardcodedNodes(sf: ts.SourceFile): HardcodedNode[] {
  const out: HardcodedNode[] = []
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return
    if (isTranslateCall(node)) return
    if (ts.isJsxText(node)) {
      // JSX text is always rendered, so even a lone lowercase word ("updated",
      // "from") is copy; only entities and punctuation are not.
      if (/[A-Za-z]{2,}/.test(node.text.replace(/&[a-z]+;/g, ""))) out.push(node)
    } else if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateExpression(node)
    ) {
      if (looksLikeCopy(textOf(node)) && literalLandsOnScreen(node) && !insideTranslate(node))
        out.push(node)
      if (ts.isTemplateExpression(node)) ts.forEachChild(node, visit)
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

export function copyText(node: HardcodedNode): string {
  return (ts.isJsxText(node) ? node.text : textOf(node)).trim().replace(/\s+/g, " ")
}

export function scanHardcodedStrings(file: string, content: string): HardcodedString[] {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, kind)
  return findHardcodedNodes(sf).map((node) => ({
    file,
    line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
    text: copyText(node),
  }))
}

export interface ScopedHardcodedString extends HardcodedString {
  /** False for a module-level literal (a label table read elsewhere). */
  inFunction: boolean
}

/** `scanHardcodedStrings`, plus whether each literal sits inside a function. */
export function scanHardcodedStringsScoped(file: string, content: string): ScopedHardcodedString[] {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, kind)
  return findHardcodedNodes(sf).map((node) => {
    let inFunction = false
    for (let p = node.parent; p; p = p.parent) {
      if (ts.isFunctionLike(p)) {
        inFunction = true
        break
      }
    }
    return {
      file,
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      text: copyText(node),
      inFunction,
    }
  })
}

/** The literal first arguments of every `<callee>("...")` call in a file. */
export function literalCallArguments(file: string, content: string, callee: string): string[] {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, kind)
  const out: string[] = []
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === callee
    ) {
      const arg = node.arguments[0]
      if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
        out.push(arg.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/**
 * A module-level COPY TABLE read straight onto the screen, past the translator.
 *
 * The scans above only see literals, so a label table declared once at module
 * level (`const TYPE_LABEL = { quote: "New quote" }`) passes them, and a render
 * site that forgets to wrap its read (`{TYPE_LABEL[type()]}` instead of
 * `{tr(TYPE_LABEL[type()])}`) printed "+ New quote" to a French reader. This
 * flags a read of such a table (or of a module-level copy constant) that lands
 * on screen, or is returned from a function, without passing through a
 * translate call.
 */
export function untranslatedTableReads(file: string, content: string): HardcodedString[] {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, kind)
  const tables = new Set<string>()
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue
      let init: ts.Expression = decl.initializer
      while (ts.isAsExpression(init) || ts.isSatisfiesExpression(init)) init = init.expression
      if (ts.isStringLiteral(init) && looksLikeCopy(init.text) && /^[A-Z]/.test(init.text)) {
        tables.add(decl.name.text)
      } else if (ts.isObjectLiteralExpression(init)) {
        const values = init.properties.filter(ts.isPropertyAssignment).map((p) => p.initializer)
        if (
          values.length > 0 &&
          values.every((v) => ts.isStringLiteral(v)) &&
          values.some((v) => looksLikeCopy((v as ts.StringLiteral).text))
        )
          tables.add(decl.name.text)
      }
    }
  }
  if (tables.size === 0) return []
  const out: HardcodedString[] = []
  const visit = (node: ts.Node) => {
    if (isTranslateCall(node)) return
    const read =
      (ts.isElementAccessExpression(node) || ts.isPropertyAccessExpression(node)) &&
      ts.isIdentifier(node.expression) &&
      tables.has(node.expression.text)
        ? node
        : ts.isIdentifier(node) &&
            tables.has(node.text) &&
            !ts.isPropertyAccessExpression(node.parent) &&
            !ts.isElementAccessExpression(node.parent) &&
            !ts.isVariableDeclaration(node.parent)
          ? node
          : null
    if (read) {
      const site = landingSite(read)
      const onScreen =
        !!site &&
        (ts.isJsxExpression(site) ||
          ts.isReturnStatement(site) ||
          (ts.isArrowFunction(site) && site.body === landingChild(read, site)) ||
          (ts.isJsxAttribute(site) && UI_ATTRS.has(attrName(site))) ||
          (ts.isPropertyAssignment(site) &&
            UI_PROPS.has(site.name.getText().replace(/^["']|["']$/g, ""))))
      const holder = site && ts.isJsxExpression(site) ? site.parent : undefined
      const inCopyAttr = !holder || !ts.isJsxAttribute(holder) || UI_ATTRS.has(attrName(holder))
      if (onScreen && inCopyAttr && !insideTranslate(read)) {
        out.push({
          file,
          line: sf.getLineAndCharacterOfPosition(read.getStart(sf)).line + 1,
          text: read.getText(sf),
        })
      }
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}
