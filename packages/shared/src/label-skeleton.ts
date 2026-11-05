// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Two labels that read the same to a person get the same skeleton, in the
// spirit of the Unicode confusable skeleton (UTS #39), kept small: compatibility
// forms folded (full-width letters), invisible format characters, accents,
// spaces and punctuation dropped, case ignored, and the Cyrillic, Greek and
// digit look-alikes of Latin letters mapped to the letter. Case is ignored, so
// i, l, 1 and | (which an uppercase I or a lowercase l both resemble) are one
// letter. Used to refuse an outside app a label that imitates a Liaison page
// or a first-party app.

// Look-alikes of Latin letters, by code point, read before case folding so an
// uppercase form maps to what it looks like (Greek capital eta is H, its
// lowercase is n).
const CONFUSABLE_CODES: Array<[number, string]> = [
  // Cyrillic, uppercase.
  [0x0410, "A"],
  [0x0412, "B"],
  [0x0415, "E"],
  [0x041a, "K"],
  [0x041c, "M"],
  [0x041d, "H"],
  [0x041e, "O"],
  [0x0420, "P"],
  [0x0421, "C"],
  [0x0422, "T"],
  [0x0425, "X"],
  [0x0423, "Y"],
  [0x0405, "S"],
  [0x0406, "I"],
  [0x0408, "J"],
  [0x04ae, "Y"],
  [0x04c0, "I"],
  [0x051a, "Q"],
  [0x051c, "W"],
  // Cyrillic, lowercase.
  [0x0430, "a"],
  [0x0432, "b"],
  [0x0435, "e"],
  [0x043a, "k"],
  [0x043c, "m"],
  [0x043d, "h"],
  [0x043e, "o"],
  [0x0440, "p"],
  [0x0441, "c"],
  [0x0442, "t"],
  [0x0443, "y"],
  [0x0445, "x"],
  [0x0455, "s"],
  [0x0456, "i"],
  [0x0458, "j"],
  [0x0501, "d"],
  [0x04bb, "h"],
  [0x04cf, "l"],
  [0x051b, "q"],
  [0x051d, "w"],
  [0x044c, "b"],
  [0x04af, "y"],
  // Greek, uppercase.
  [0x0391, "A"],
  [0x0392, "B"],
  [0x0395, "E"],
  [0x0396, "Z"],
  [0x0397, "H"],
  [0x0399, "I"],
  [0x039a, "K"],
  [0x039c, "M"],
  [0x039d, "N"],
  [0x039f, "O"],
  [0x03a1, "P"],
  [0x03a4, "T"],
  [0x03a5, "Y"],
  [0x03a7, "X"],
  // Greek, lowercase.
  [0x03b1, "a"],
  [0x03b2, "b"],
  [0x03b3, "y"],
  [0x03b5, "e"],
  [0x03b7, "n"],
  [0x03b9, "i"],
  [0x03ba, "k"],
  [0x03bd, "v"],
  [0x03bf, "o"],
  [0x03c1, "p"],
  [0x03c4, "t"],
  [0x03c5, "u"],
  [0x03c7, "x"],
  [0x03c9, "w"],
  // Latin look-alikes.
  [0x0131, "i"],
  [0x0261, "g"],
  [0x0030, "o"],
  [0x0031, "l"],
  [0x007c, "l"],
]

const CONFUSABLES = new Map(
  CONFUSABLE_CODES.map(([code, letter]) => [String.fromCodePoint(code), letter]),
)

/**
 * The skeleton of a label: equal skeletons read the same. Case, spaces,
 * punctuation, accents, invisible characters and look-alike letters aside.
 */
export function labelSkeleton(label: string): string {
  const folded = label
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
  let out = ""
  for (const char of folded) out += CONFUSABLES.get(char) ?? char
  return out
    .toLocaleLowerCase("en")
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .replace(/rn/g, "m")
    .replace(/vv/g, "w")
    .replace(/i/g, "l")
}
