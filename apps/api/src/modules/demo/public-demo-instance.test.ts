// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `publicDemoInstance`: the seed's visitor-protecting refusals (replace a demo
// org, give seeded people passwords) hold on every demo-mode box except one
// declared private AND served on a loopback BASE_URL.
import { describe, expect, test } from "bun:test"
import { isLoopbackOrigin, publicDemoInstance } from "./demo-mode"

describe("isLoopbackOrigin", () => {
  test("localhost, 127.0.0.0/8 and ::1 are loopback, with any port", () => {
    for (const url of [
      "http://localhost:3900",
      "http://127.0.0.1:3000",
      "http://127.8.9.10",
      "http://[::1]:3000",
      "http://app.localhost:3000",
    ]) {
      expect(isLoopbackOrigin(url)).toBe(true)
    }
  })
  test("a public hostname, a private LAN address or garbage is not", () => {
    for (const url of [
      "https://demo.example.com",
      "https://localhost.example.com",
      "http://10.0.0.5:3000",
      "http://192.168.1.2",
      "http://127.0.0.1.example.com",
      "not a url",
      "",
    ]) {
      expect(isLoopbackOrigin(url)).toBe(false)
    }
  })
})

describe("publicDemoInstance", () => {
  test("demo mode off is never a public demo instance", () => {
    expect(
      publicDemoInstance({
        demoMode: false,
        declaredPrivate: false,
        baseUrl: "https://demo.example.com",
      }),
    ).toBe(false)
  })
  test("demo mode on is public unless declared private", () => {
    expect(
      publicDemoInstance({
        demoMode: true,
        declaredPrivate: false,
        baseUrl: "http://localhost:3900",
      }),
    ).toBe(true)
  })
  test("declared private on a public hostname is still public", () => {
    expect(
      publicDemoInstance({
        demoMode: true,
        declaredPrivate: true,
        baseUrl: "https://demo.example.com",
      }),
    ).toBe(true)
  })
  test("declared private on a loopback BASE_URL (a tunnelled QA box) is private", () => {
    expect(
      publicDemoInstance({
        demoMode: true,
        declaredPrivate: true,
        baseUrl: "http://localhost:3900",
      }),
    ).toBe(false)
  })
})
