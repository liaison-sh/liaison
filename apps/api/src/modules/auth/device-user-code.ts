// SPDX-License-Identifier: FSL-1.1-ALv2

import { randomInt } from "node:crypto"

/** No characters a person can misread (0/O, 1/I/l). */
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
const LENGTH = 8

/** The short code a person types to approve a device (40 bits, uniform). */
export function generateDeviceUserCode(): string {
  return Array.from({ length: LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join("")
}
