// SPDX-License-Identifier: FSL-1.1-ALv2
// Seeded pseudo-random number generator (xoshiro128**)
export class SeededRng {
  private s: Uint32Array

  constructor(seed: number) {
    // SplitMix32 to initialize state from a single seed
    this.s = new Uint32Array(4)
    let z = seed | 0
    for (let i = 0; i < 4; i++) {
      z = (z + 0x9e3779b9) | 0
      let t = z ^ (z >>> 16)
      t = Math.imul(t, 0x21f0aaad)
      t ^= t >>> 15
      t = Math.imul(t, 0x735a2d97)
      t ^= t >>> 15
      this.s[i] = t >>> 0
    }
  }

  next(): number {
    const s = this.s
    const r = Math.imul(s[1], 5)
    const result = (r << 7) | (r >>> 25)
    const t = s[1] << 9
    s[2] ^= s[0]
    s[3] ^= s[1]
    s[1] ^= s[2]
    s[0] ^= s[3]
    s[2] ^= t
    s[3] = (s[3] << 11) | (s[3] >>> 21)
    return (result >>> 0) / 0x100000000
  }

  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1))
  }

  pick<T>(arr: T[]): T {
    return arr[this.int(0, arr.length - 1)]
  }

  pickN<T>(arr: T[], n: number): T[] {
    const copy = [...arr]
    const result: T[] = []
    for (let i = 0; i < Math.min(n, copy.length); i++) {
      const idx = this.int(0, copy.length - 1)
      result.push(copy[idx])
      copy.splice(idx, 1)
    }
    return result
  }
}
