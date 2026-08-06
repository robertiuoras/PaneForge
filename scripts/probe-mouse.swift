// Post REAL HID-level mouse events, so AppKit treats them exactly like a hand on the
// trackpad. `webContents.sendInputEvent` and CDP's Input domain both inject below AppKit
// and never activate an application, which is the whole thing being measured here.
//
//   swiftc -O -o mouse scripts/probe-mouse.swift
//   ./mouse click <x> <y> [holdMs]
//   ./mouse drag  <x> <y> <dx> <dy> [steps] [durationMs]
//
// Every line it prints is JSON on the ms-epoch clock, mergeable with the app's probe log.
// It refuses to press anything if the cursor did not actually go where it was sent - that
// is what a missing Accessibility grant looks like, and a silent no-op would read as
// "the drag does not activate the app".

import CoreGraphics
import Foundation

func ms() -> Int { Int(Date().timeIntervalSince1970 * 1000) }

func emit(_ label: String, _ extra: String = "") {
    print("{\"t\":\(ms()),\"src\":\"mouse\",\"label\":\"\(label)\"\(extra)}")
    fflush(stdout)
}

let a = Array(CommandLine.arguments.dropFirst())
guard a.count >= 3, let x = Double(a[1]), let y = Double(a[2]) else {
    FileHandle.standardError.write("usage: mouse click <x> <y> [holdMs] | mouse drag <x> <y> <dx> <dy> [steps] [durationMs]\n".data(using: .utf8)!)
    exit(2)
}
let mode = a[0]

let src = CGEventSource(stateID: .hidSystemState)

func post(_ type: CGEventType, _ p: CGPoint) {
    guard let e = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: p, mouseButton: .left)
    else { return }
    e.setIntegerValueField(.mouseEventClickState, value: 1)
    e.post(tap: .cghidEventTap)
}

func cursor() -> CGPoint { CGEvent(source: nil)?.location ?? CGPoint(x: -1, y: -1) }

let origin = cursor()
emit("origin", ",\"x\":\(origin.x),\"y\":\(origin.y)")

// Put the pointer on the target the way a hand arrives there, and PROVE it landed.
post(.mouseMoved, CGPoint(x: x, y: y))
usleep(150_000)
let landed = cursor()
emit("cursor-at", ",\"x\":\(landed.x),\"y\":\(landed.y)")
if abs(landed.x - x) > 2 || abs(landed.y - y) > 2 {
    emit("POST_BLOCKED", ",\"wanted_x\":\(x),\"wanted_y\":\(y)")
    exit(3)
}

if mode == "click" {
    let hold = a.count > 3 ? (UInt32(a[3]) ?? 80) : 80
    emit("mouseDown", ",\"x\":\(x),\"y\":\(y)")
    post(.leftMouseDown, CGPoint(x: x, y: y))
    usleep(hold * 1000)
    emit("mouseUp", ",\"x\":\(x),\"y\":\(y)")
    post(.leftMouseUp, CGPoint(x: x, y: y))
} else if mode == "drag" {
    guard a.count >= 5, let dx = Double(a[3]), let dy = Double(a[4]) else { exit(2) }
    let steps = a.count > 5 ? (Int(a[5]) ?? 30) : 30
    let durMs = a.count > 6 ? (Double(a[6]) ?? 1500) : 1500
    emit("mouseDown", ",\"x\":\(x),\"y\":\(y)")
    post(.leftMouseDown, CGPoint(x: x, y: y))
    usleep(60_000)
    let per = UInt32((durMs / Double(steps)) * 1000)
    for i in 1...steps {
        let f = Double(i) / Double(steps)
        let p = CGPoint(x: x + dx * f, y: y + dy * f)
        post(.leftMouseDragged, p)
        if i == 1 || i % 10 == 0 || i == steps {
            emit("mouseDragged", ",\"i\":\(i),\"x\":\(p.x),\"y\":\(p.y)")
        }
        usleep(per)
    }
    emit("mouseUp", ",\"x\":\(x + dx),\"y\":\(y + dy)")
    post(.leftMouseUp, CGPoint(x: x + dx, y: y + dy))
} else {
    exit(2)
}

emit("done")
