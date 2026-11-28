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
// Capacitor's own files come from THIS app's bundle: the JavaScript that talks
// to the native plugins is always the one compiled into the binary, never a
// server's. The served index.html is checked against its signed hash BEFORE
// these steps; the result is re-derived and compared on every launch.

import CryptoKit
import Foundation

public enum MobilePage {
    /// The boot bundle's file name (boot-injection.ts `BOOT_SCRIPT_NAME`).
    public static let bootScriptName = "liaison-mobile-boot.js"

    /// Files a served build takes from the app's bundled `public/` folder,
    /// those of them the bundle has. A statement listing one of these names is
    /// refused: these are the binary's own.
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

    public enum PageError: Error { case noHead, noViewport }

    /// applyMobileCsp(pinViewportScale(injectBootScript(html))), as build-mobile.ts runs them.
    public static func make(_ html: String) throws -> Page {
        try applyMobileCsp(pinViewportScale(injectBootScript(html)))
    }

    static func regex(_ pattern: String) -> NSRegularExpression {
        // swiftlint:disable:next force_try
        try! NSRegularExpression(pattern: pattern, options: [.caseInsensitive])
    }

    static let headTag = regex("<head[^>]*>")
    static let viewportMeta = regex("<meta\\s+name=[\"']viewport[\"']\\s+content=[\"']([^\"']*)[\"'][^>]*>")
    static let scriptTag = regex("<script\\b([^>]*)>([\\s\\S]*?)</script\\s*>")
    static let srcAttr = regex("\\bsrc\\s*=")
    static let importMapType = regex("\\btype\\s*=\\s*[\"']?importmap")
    static let moduleType = regex("\\btype\\s*=\\s*[\"']?module")
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
        let tag = "<script src=\"/\(bootScriptName)\"></script>"
        if html.contains(tag) { return html }
        return try afterHead(html, tag)
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
            if matches(importMapType, attrs) { continue }
            let digest = SHA256.hash(data: Data(body.utf8)).map { String(format: "%02x", $0) }.joined()
            let name = "liaison-inline-\(digest.prefix(12)).js"
            files[name] = body
            let type = matches(moduleType, attrs) ? " type=\"module\"" : ""
            out += "<script\(type) src=\"/\(name)\"></script>"
        }
        out += ns.substring(from: cursor)
        let withoutCsp = cspMeta.stringByReplacingMatches(
            in: out, range: NSRange(location: 0, length: (out as NSString).length), withTemplate: ""
        )
        let meta = "<meta http-equiv=\"Content-Security-Policy\" content=\"\(mobileCsp)\">"
        return Page(html: try afterHead(withoutCsp, meta), files: files)
    }
}
