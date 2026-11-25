// SPDX-License-Identifier: FSL-1.1-ALv2
//
// RFC 8785 test vectors: section 3.2.2 (serialization), section 3.2.3
// (sorting), and Appendix B (number serialization, IEEE 754 bit patterns).
import { describe, expect, it } from "bun:test"
import {
  CanonicalJsonError,
  canonicalJson,
  canonicalJsonBytes,
} from "~/modules/signing/canonical-json"

function fromBits(hex: string): number {
  const view = new DataView(new ArrayBuffer(8))
  view.setBigUint64(0, BigInt(`0x${hex}`))
  return view.getFloat64(0)
}

describe("canonical JSON (RFC 8785)", () => {
  it("serializes the section 3.2.2 example exactly", () => {
    const input = JSON.parse(
      '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],' +
        '"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/",' +
        '"literals":[null,true,false]}',
    )
    expect(canonicalJson(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
        '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    )
  })

  it("sorts members by UTF-16 code units as in section 3.2.3", () => {
    const input = {
      "€": "Euro Sign",
      "\r": "Carriage Return",
      דּ: "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "😀": "Emoji: Grinning Face",
      "\u0080": "Control",
      ö: "Latin Small Letter O With Diaeresis",
    }
    // The order the RFC prints: \r, 1, \u0080, ö, €, 😀, דּ
    const order = [...canonicalJson(input).matchAll(/"([^"]*)":"/g)].map((m) =>
      JSON.parse(`"${m[1]}"`),
    )
    expect(order).toEqual(["\r", "1", "\u0080", "ö", "€", "😀", "דּ"])
    expect(
      canonicalJson(input).startsWith('{"\\r":"Carriage Return","1":"One","\u0080":"Control"'),
    ).toBe(true)
  })

  it("serializes the Appendix B numbers", () => {
    const vectors: Array<[string, string]> = [
      ["0000000000000000", "0"],
      ["8000000000000000", "0"],
      ["0000000000000001", "5e-324"],
      ["8000000000000001", "-5e-324"],
      ["7fefffffffffffff", "1.7976931348623157e+308"],
      ["ffefffffffffffff", "-1.7976931348623157e+308"],
      ["4340000000000000", "9007199254740992"],
      ["c340000000000000", "-9007199254740992"],
      ["4430000000000000", "295147905179352830000"],
      ["44b52d02c7e14af5", "9.999999999999997e+22"],
      ["44b52d02c7e14af6", "1e+23"],
      ["44b52d02c7e14af7", "1.0000000000000001e+23"],
      ["444b1ae4d6e2ef4e", "999999999999999700000"],
      ["444b1ae4d6e2ef4f", "999999999999999900000"],
      ["444b1ae4d6e2ef50", "1e+21"],
      ["3eb0c6f7a0b5ed8c", "9.999999999999997e-7"],
      ["3eb0c6f7a0b5ed8d", "0.000001"],
      ["41b3de4355555553", "333333333.3333332"],
      ["41b3de4355555554", "333333333.33333325"],
      ["41b3de4355555555", "333333333.3333333"],
      ["41b3de4355555556", "333333333.3333334"],
      ["41b3de4355555557", "333333333.33333343"],
      ["becbf647612f3696", "-0.0000033333333333333333"],
      ["43143ff3c1cb0959", "1424953923781206.2"],
    ]
    for (const [bits, text] of vectors) {
      expect({ bits, text: canonicalJson(fromBits(bits)) }).toEqual({ bits, text })
    }
  })

  it("refuses NaN and Infinity (Appendix B), lone surrogates and non-JSON values", () => {
    for (const bits of ["7fffffffffffffff", "7ff0000000000000"]) {
      expect(() => canonicalJson(fromBits(bits))).toThrow(CanonicalJsonError)
    }
    expect(() => canonicalJson("\ud800")).toThrow(CanonicalJsonError)
    expect(() => canonicalJson({ "\udc00": 1 })).toThrow(CanonicalJsonError)
    expect(() => canonicalJson({ a: undefined })).toThrow(CanonicalJsonError)
    expect(() => canonicalJson(1n)).toThrow(CanonicalJsonError)
    expect(() => canonicalJson(new Date(0))).toThrow(CanonicalJsonError)
  })

  it("writes no whitespace and encodes UTF-8", () => {
    expect(canonicalJson({ b: [1, { d: 2, c: 3 }], a: "é" })).toBe(
      '{"a":"é","b":[1,{"c":3,"d":2}]}',
    )
    expect([...canonicalJsonBytes("é")]).toEqual([0x22, 0xc3, 0xa9, 0x22])
  })
})
