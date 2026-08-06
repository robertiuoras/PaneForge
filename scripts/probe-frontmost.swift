// Long-running frontmost-app sampler. One process, one line per sample, ms epoch clock -
// the same clock the app's probe log uses, so the two merge without alignment.
//
//   swiftc -O -o frontmost scripts/probe-frontmost.swift && ./frontmost 50
//
// A sample is only printed when the frontmost app CHANGES (plus one at the start and one
// per second as a heartbeat), because the interesting fact is the transition and its
// millisecond, not forty repetitions of it.

import AppKit
import Foundation

let intervalMs = CommandLine.arguments.count > 1 ? (Double(CommandLine.arguments[1]) ?? 50) : 50
setvbuf(stdout, nil, _IOLBF, 0)

func ms() -> Int { Int(Date().timeIntervalSince1970 * 1000) }

var last = ""
var lastPrint = 0

func sample() {
    let app = NSWorkspace.shared.frontmostApplication
    let name = app?.localizedName ?? "?"
    let pid = app?.processIdentifier ?? -1
    let key = "\(name)/\(pid)"
    let t = ms()
    if key != last || t - lastPrint >= 1000 {
        let changed = key != last
        print("{\"t\":\(t),\"src\":\"front\",\"app\":\"\(name)\",\"pid\":\(pid),\"changed\":\(changed)}")
        last = key
        lastPrint = t
    }
}

sample()
let timer = Timer(timeInterval: intervalMs / 1000.0, repeats: true) { _ in sample() }
RunLoop.main.add(timer, forMode: .common)
RunLoop.main.run()
