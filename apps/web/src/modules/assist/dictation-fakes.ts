// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Test doubles for the browser's capture boundary (getUserMedia, MediaRecorder,
// AudioContext). Installed per test and removed after; nothing past the
// boundary is faked.
import { vi } from "vitest"

// Only what these fakes put in place is taken back: a suite's own global
// stubs (fetch, matchMedia) stay, unlike with vi.unstubAllGlobals.
const replaced = new Map<string, PropertyDescriptor | undefined>()

/** Put a global in place for the test (undefined removes it), remembered for removeMic. */
export function setGlobal(name: string, value: unknown): void {
  if (!replaced.has(name)) replaced.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
}

export class FakeMediaRecorder extends EventTarget {
  static instances: FakeMediaRecorder[] = []
  static isTypeSupported(type: string): boolean {
    return type === "audio/webm;codecs=opus" || type === "audio/webm"
  }
  state: "inactive" | "recording" = "inactive"
  readonly mimeType: string
  constructor(
    readonly stream: MediaStream,
    options?: { mimeType?: string },
  ) {
    super()
    this.mimeType = options?.mimeType ?? "audio/webm"
    FakeMediaRecorder.instances.push(this)
  }
  start(): void {
    this.state = "recording"
  }
  stop(): void {
    if (this.state === "inactive") return
    this.state = "inactive"
    const index = FakeMediaRecorder.instances.indexOf(this)
    // Like the real one: the data, then stop, after the call returns.
    queueMicrotask(() => {
      const data = new Blob([`segment-${index}`], { type: this.mimeType })
      this.dispatchEvent(Object.assign(new Event("dataavailable"), { data }))
      this.dispatchEvent(new Event("stop"))
    })
  }
}

export interface FakeMic {
  track: { stop: ReturnType<typeof vi.fn> }
  getUserMedia: ReturnType<typeof vi.fn>
  /** Resolve a getUserMedia held with `hold: true`. */
  grant: () => void
}

export function installMic(
  opts: {
    deny?: string
    hold?: boolean
    /** What enumerateDevices lists (default: one microphone). */
    devices?: MediaDeviceKind[]
  } = {},
): FakeMic {
  const track = { stop: vi.fn() }
  const stream = { getTracks: () => [track] }
  let grant: () => void = () => {}
  const getUserMedia = vi.fn(
    () =>
      new Promise((resolve, reject) => {
        if (opts.deny) reject(new DOMException("denied", opts.deny))
        else if (opts.hold) grant = () => resolve(stream)
        else resolve(stream)
      }),
  )
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia,
      enumerateDevices: async () =>
        (opts.devices ?? ["audioinput"]).map((kind) => ({ kind, deviceId: "", label: "" })),
    },
  })
  FakeMediaRecorder.instances = []
  setGlobal("MediaRecorder", FakeMediaRecorder)
  return {
    track,
    getUserMedia,
    grant: () => grant(),
  }
}

/**
 * A Web Audio graph whose analyser reads a constant sample value (128 is
 * silence; the frame's RMS is |value - 128| / 128). A function is asked again
 * on every read, so a test can script silence, noise and speech over time.
 */
export function installAudioContext(
  level: number | (() => number) = 200,
  opts: { state?: AudioContextState } = {},
): {
  closed: () => boolean
} {
  let closed = false
  class FakeAudioContext {
    state = opts.state ?? "running"
    resume() {
      return Promise.resolve()
    }
    createAnalyser() {
      return {
        fftSize: 32,
        getByteTimeDomainData: (arr: Uint8Array) =>
          arr.fill(typeof level === "function" ? level() : level),
      }
    }
    createMediaStreamSource() {
      return { connect: () => {} }
    }
    close() {
      closed = true
      return Promise.resolve()
    }
  }
  setGlobal("AudioContext", FakeAudioContext)
  return { closed: () => closed }
}

export function removeMic(): void {
  Reflect.deleteProperty(navigator, "mediaDevices")
  for (const [name, original] of replaced) {
    if (original) Object.defineProperty(globalThis, name, original)
    else Reflect.deleteProperty(globalThis, name)
  }
  replaced.clear()
}
