// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Canonical JSON, the wire form of every signed document the shell reads
// (packages/shared/src/app-signing/statement.ts `canonicalJson`): object keys
// sorted by UTF-16 code units, no whitespace, strings escaped exactly as
// JavaScript's JSON.stringify escapes them, integers only. A document is read
// only when its bytes ARE the canonical form of what they parse to, so one
// signed text has exactly one meaning on every client.

import Foundation

enum CanonicalJSON {
    /// The value these bytes hold, only when they are its canonical form.
    static func value(_ bytes: Data) -> Any? {
        guard let text = String(data: bytes, encoding: .utf8),
              let value = try? JSONSerialization.jsonObject(with: bytes, options: [.fragmentsAllowed]),
              let canonical = encode(value),
              canonical == text else {
            return nil
        }
        return value
    }

    /// The canonical text of a parsed value, or nil for one it cannot carry
    /// (a non-integer or unsafe number).
    static func encode(_ value: Any) -> String? {
        if value is NSNull { return "null" }
        if let number = value as? NSNumber {
            if isBool(number) { return number.boolValue ? "true" : "false" }
            guard let int = safeInteger(number) else { return nil }
            return String(int)
        }
        if let string = value as? String { return quote(string) }
        if let array = value as? [Any] {
            var parts: [String] = []
            for item in array {
                guard let part = encode(item) else { return nil }
                parts.append(part)
            }
            return "[" + parts.joined(separator: ",") + "]"
        }
        if let object = value as? [String: Any] {
            let keys = object.keys.sorted { Array($0.utf16).lexicographicallyPrecedes(Array($1.utf16)) }
            var parts: [String] = []
            for key in keys {
                guard let part = encode(object[key] as Any) else { return nil }
                parts.append(quote(key) + ":" + part)
            }
            return "{" + parts.joined(separator: ",") + "}"
        }
        return nil
    }

    static func isBool(_ number: NSNumber) -> Bool {
        CFGetTypeID(number) == CFBooleanGetTypeID()
    }

    /// The integer a JSON number holds, when it is one JavaScript represents
    /// exactly (|n| <= 2^53 - 1).
    static func safeInteger(_ number: NSNumber) -> Int64? {
        if isBool(number) { return nil }
        let double = number.doubleValue
        guard double.isFinite, double == double.rounded(), abs(double) <= 9_007_199_254_740_991 else {
            return nil
        }
        return number.int64Value
    }

    /// A string as JSON.stringify writes it. A Swift String is always valid
    /// Unicode, so there is no lone surrogate to escape.
    static func quote(_ string: String) -> String {
        var out = "\""
        for scalar in string.unicodeScalars {
            switch scalar.value {
            case 0x22: out += "\\\""
            case 0x5C: out += "\\\\"
            case 0x08: out += "\\b"
            case 0x0C: out += "\\f"
            case 0x0A: out += "\\n"
            case 0x0D: out += "\\r"
            case 0x09: out += "\\t"
            case 0x00..<0x20: out += String(format: "\\u%04x", scalar.value)
            default: out.unicodeScalars.append(scalar)
            }
        }
        return out + "\""
    }
}
