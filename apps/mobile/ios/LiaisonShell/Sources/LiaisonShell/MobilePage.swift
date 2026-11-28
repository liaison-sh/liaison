// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE PHONE'S MAIN PAGE, MADE FROM A SERVED BUILD THE WAY THE BUILD MAKES IT
// FROM THE BUNDLED ONE.
//
// The web build a server ships under `/native/` is apps/web's native build as
// Vite wrote it. The copy compiled into this app is that build after
// apps/mobile/scripts/build-mobile.ts ran on it: the mobile boot bundle
// (`liaison-mobile-boot.js`, which publishes the native bridge and the server
// address) runs first, the viewport is pinned, and the page is put under the
// phone's Content Security Policy (every inline script moved to a file, the
// import map dropped, the CSP meta first in <head>).
//
// So a served build gets the same three steps here, ported from
// apps/mobile/scripts/boot-injection.ts (a fixture test pins the two against
// each other, apps/mobile/shell-page-parity.test.ts), and the boot bundle and
// Capacitor's own files come from THIS app's bundle. The served page itself is
// Liaison-signed code and calls the native plugins as the bundled page does;
// what it can never do is add one. The served index.html is checked against its
// signed hash BEFORE these steps; the result must pass `check` (the shape the
// policy relies on) and is re-derived and compared on every launch.

import CryptoKit
import Foundation

public enum MobilePage {
    /// The boot bundle's file name (boot-injection.ts `BOOT_SCRIPT_NAME`).
    public static let bootScriptName = "liaison-mobile-boot.js"

    /// Files a served build takes from the app's bundled `public/` folder,
    /// those of them the bundle has. A statement listing any of these names
    /// (in any case or Unicode form) is refused, whether the bundle has it or
    /// not: these are the binary's own.
    public static let overlayNames = [bootScriptName, "cordova.js", "cordova_plugins.js"]

    /// boot-injection.ts `MOBILE_CSP`, pinned by the parity test.
    public static let mobileCsp = [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https:",
        "font-src 'self' data:",
        "media-src 'self' data: blob:",
        "worker-src 'self' blob:",
        "base-uri 'self'",
        "form-action 'self'",
        "connect-src 'self' https: wss: http://localhost:* ws://localhost:*",
        "frame-src 'self' blob: data:",
        "object-src 'none'",
    ].joined(separator: "; ")

    public struct Page: Equatable {
        public let html: String
        /// Inline scripts moved out of the page: file name -> content.
        public let files: [String: String]
    }

    public enum PageError: Error { case noHead, noViewport, shape }

    /// makeMobilePage: applyMobileCsp(pinViewportScale(injectBootScript(html))),
    /// as build-mobile.ts runs them, then checkMobilePage.
    public static func make(_ html: String) throws -> Page {
        let page = try applyMobileCsp(pinViewportScale(injectBootScript(html)))
        try check(page.html)
        return page
    }

    static let bootTag = "<script src=\"/\(bootScriptName)\"></script>"
    static var cspTag: String { "<meta http-equiv=\"Content-Security-Policy\" content=\"\(mobileCsp)\">" }
    static let wellFormedComment = regex("<!--(?!>|->)(?:(?!--)[\\s\\S])*-->")
    static let leadingDoctype = regex("^\\s*<!doctype[^>]*>")
    static let beforeHead = regex("^\\s*(?:<!doctype[^>]*>\\s*)?(?:<html(?=[\\s>])[^>]*>\\s*)?$")

    /// boot-injection.ts `checkMobilePage`: with comments removed, exactly one
    /// <head>, nothing before it but the doctype, <html> and white space, the
    /// CSP meta and then the boot script first in it, the boot script nowhere else.
    static func check(_ html: String) throws {
        // Well-formed comments only, one pass; any other "<!" (a bogus comment such as
        // "<!<!---->", an unclosed "<!--") or "--!>" is refused: boot-injection.ts `withoutComments`.
        let bare = wellFormedComment.stringByReplacingMatches(
            in: html, range: NSRange(location: 0, length: (html as NSString).length), withTemplate: ""
        )
        let rest = leadingDoctype.stringByReplacingMatches(
            in: bare, range: NSRange(location: 0, length: (bare as NSString).length), withTemplate: ""
        )
        guard !rest.contains("<!"), !rest.contains("--!>") else { throw PageError.shape }
        let ns = bare as NSString
        let heads = headTag.matches(in: bare, range: NSRange(location: 0, length: ns.length))
        guard heads.count == 1, let head = heads.first else { throw PageError.shape }
        guard matches(beforeHead, ns.substring(to: head.range.location)) else { throw PageError.shape }
        guard ns.substring(from: head.range.location + head.range.length).hasPrefix(cspTag + bootTag) else {
            throw PageError.shape
        }
        guard bare.components(separatedBy: bootTag).count == 2 else { throw PageError.shape }
    }

    static func regex(_ pattern: String) -> NSRegularExpression {
        // swiftlint:disable:next force_try
        try! NSRegularExpression(pattern: pattern, options: [.caseInsensitive])
    }

    static let headTag = regex("<head(?=[\\s>/])[^>]*>")
    static let viewportMeta = regex("<meta\\s+name=[\"']viewport[\"']\\s+content=[\"']([^\"']*)[\"'][^>]*>")
    static let scriptTag = regex("<script\\b([^>]*)>([\\s\\S]*?)</script\\s*>")
    static let srcAttr = regex("\\bsrc\\s*=")
    static let typeAttr = regex("\\btype\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'>]+))")
    static let moduleType = regex("\\btype\\s*=\\s*[\"']?module")
    static let noModule = regex("\\bnomodule\\b")

    enum ScriptKind { case run, importMap, data }

    /// boot-injection.ts `scriptKind`.
    static func scriptKind(_ attrs: String) -> ScriptKind {
        let ns = attrs as NSString
        guard let m = typeAttr.firstMatch(in: attrs, range: NSRange(location: 0, length: ns.length)) else { return .run }
        var type = ""
        for group in 1...3 where m.range(at: group).location != NSNotFound {
            type = ns.substring(with: m.range(at: group))
            break
        }
        // JavaScript's trim() and toLowerCase() on what an HTML attribute holds.
        type = type.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if type.isEmpty || type == "text/javascript" || type == "module" { return .run }
        if type == "importmap" { return .importMap }
        return .data
    }
    static let cspMeta = regex("<meta\\s+http-equiv=[\"']Content-Security-Policy[\"'][^>]*>")
    static let sizeOrScalable = regex("^(maximum-scale|user-scalable)\\s*=")

    static func matches(_ re: NSRegularExpression, _ text: String) -> Bool {
        re.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }

    /// Inserts `insert` right after the first <head ...> tag.
    static func afterHead(_ html: String, _ insert: String) throws -> String {
        let ns = html as NSString
        guard let head = headTag.firstMatch(in: html, range: NSRange(location: 0, length: ns.length)) else {
            throw PageError.noHead
        }
        let at = head.range.location + head.range.length
        return ns.substring(to: at) + insert + ns.substring(from: at)
    }

    static func injectBootScript(_ html: String) throws -> String {
        if html.contains(bootTag) { return html }
        return try afterHead(html, bootTag)
    }

    static func pinViewportScale(_ html: String) throws -> String {
        let ns = html as NSString
        guard let meta = viewportMeta.firstMatch(in: html, range: NSRange(location: 0, length: ns.length)) else {
            throw PageError.noViewport
        }
        let whole = ns.substring(with: meta.range)
        let content = ns.substring(with: meta.range(at: 1))
        var parts = content.components(separatedBy: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && !matches(sizeOrScalable, $0) }
        parts.append("maximum-scale=1")
        let pinned = replaceFirst(in: whole, of: content, with: parts.joined(separator: ", "))
        return replaceFirst(in: html, of: whole, with: pinned)
    }

    /// JavaScript's `string.replace(search, replacement)` for a plain string search.
    static func replaceFirst(in text: String, of search: String, with replacement: String) -> String {
        if search.isEmpty { return replacement + text }
        guard let range = text.range(of: search) else { return text }
        return text.replacingCharacters(in: range, with: replacement)
    }

    static func applyMobileCsp(_ html: String) throws -> Page {
        var files: [String: String] = [:]
        let ns = html as NSString
        var out = ""
        var cursor = 0
        for match in scriptTag.matches(in: html, range: NSRange(location: 0, length: ns.length)) {
            out += ns.substring(with: NSRange(location: cursor, length: match.range.location - cursor))
            cursor = match.range.location + match.range.length
            let tag = ns.substring(with: match.range)
            let attrs = ns.substring(with: match.range(at: 1))
            let body = ns.substring(with: match.range(at: 2))
            if matches(srcAttr, attrs) {
                out += tag
                continue
            }
            switch scriptKind(attrs) {
            case .importMap: continue
            case .data:
                // A data block (JSON, a template) stays as it is: never run.
                out += tag
                continue
            case .run: break
            }
            let digest = SHA256.hash(data: Data(body.utf8)).map { String(format: "%02x", $0) }.joined()
            let name = "liaison-inline-\(digest.prefix(12)).js"
            files[name] = body
            let type = matches(moduleType, attrs) ? " type=\"module\"" : ""
            let nomodule = matches(noModule, attrs) ? " nomodule" : ""
            out += "<script\(type)\(nomodule) src=\"/\(name)\"></script>"
        }
        out += ns.substring(from: cursor)
        let withoutCsp = cspMeta.stringByReplacingMatches(
            in: out, range: NSRange(location: 0, length: (out as NSString).length), withTemplate: ""
        )
        return Page(html: try afterHead(withoutCsp, cspTag), files: files)
    }
}
