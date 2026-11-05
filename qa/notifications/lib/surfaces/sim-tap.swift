// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Taps the iOS Simulator's screen at a FRACTION of the device screen, with a
// CoreGraphics synthetic click (an osascript System Events click hangs:
// validation spike T0). The window is found through the window server, which
// needs no Accessibility grant; the click itself needs the calling terminal to
// be allowed to post events (it already is on the Minimac).
//
// usage: swift sim-tap.swift <fx> <fy>   (fractions of the device screenshot)
//        swift sim-tap.swift type <text>   (into the focused field, US key
//        codes, unshifted characters only; the Simulator's hardware keyboard
//        must be connected, its default)
import AppKit
import CoreGraphics

let args = CommandLine.arguments

if args.count == 3, args[1] == "type" {
  // The Simulator maps host key CODES (a unicode keystroke types "a" for every
  // character), so each character goes through the US layout's key code.
  let plain: [Character: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11,
    "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21,
    "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29, "o": 31, "u": 32,
    "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, ";": 41, ",": 43, "/": 44, "n": 45, "m": 46,
    ".": 47, " ": 49,
  ]
  if let sim = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.iphonesimulator").first {
    sim.activate()
  }
  usleep(400_000)
  // UNSHIFTED CHARACTERS ONLY: a synthetic Shift (key or flag) does not reach
  // the simulated keyboard, so ":" came out ";" (2026-10-07). Tap the
  // on-screen key for "@" and the like, or bind the server with the
  // `liaison://connect?server=` link (`simctl openurl`).
  for ch in args[2] {
    guard let code = plain[ch] else {
      FileHandle.standardError.write("no unshifted key for \(ch)\n".data(using: .utf8)!)
      exit(2)
    }
    for down in [true, false] {
      CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)?.post(tap: .cghidEventTap)
      usleep(20_000)
    }
  }
  print("typed \(args[2].count) characters")
  exit(0)
}
guard args.count == 3, let fx = Double(args[1]), let fy = Double(args[2]) else {
  FileHandle.standardError.write("usage: sim-tap.swift <fx> <fy>\n".data(using: .utf8)!)
  exit(2)
}
if let sim = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.iphonesimulator").first {
  sim.activate()
}
usleep(400_000)
let infos = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
guard let win = infos.first(where: { ($0[kCGWindowOwnerName as String] as? String) == "Simulator" && ($0[kCGWindowLayer as String] as? Int) == 0 }),
  let b = win[kCGWindowBounds as String] as? [String: Double],
  let x = b["X"], let y = b["Y"], let w = b["Width"], let h = b["Height"]
else {
  FileHandle.standardError.write("no Simulator window on screen\n".data(using: .utf8)!)
  exit(1)
}
// The device screen fills the window under its title bar (no bezel shown).
let title = 28.0
let p = CGPoint(x: x + fx * w, y: y + title + fy * (h - title))
for type in [CGEventType.leftMouseDown, .leftMouseUp] {
  CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
  usleep(60_000)
}
print("tapped \(Int(p.x)),\(Int(p.y))")
