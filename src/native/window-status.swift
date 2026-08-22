import CoreGraphics
import Foundation

let excludedPID = CommandLine.arguments.count > 1
    ? Int(CommandLine.arguments[1]) ?? -1
    : -1
let ignoredOwners: Set<String> = [
    "Dock",
    "Window Server",
    "WindowManager"
]
let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
let windows = (CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]]) ?? []

for window in windows {
    let layer = window[kCGWindowLayer as String] as? Int ?? -1
    let alpha = window[kCGWindowAlpha as String] as? Double ?? 0
    let ownerPID = window[kCGWindowOwnerPID as String] as? Int ?? -1
    let ownerName = window[kCGWindowOwnerName as String] as? String ?? ""
    guard
        layer == 0,
        alpha > 0.01,
        ownerPID != excludedPID,
        !ignoredOwners.contains(ownerName),
        let boundsDictionary = window[kCGWindowBounds as String] as? NSDictionary,
        let bounds = CGRect(dictionaryRepresentation: boundsDictionary)
    else { continue }

    // Ignore tiny system utility surfaces that cannot be covered by the
    // centered Jarvis avatar. Normal app and document windows are larger.
    if bounds.width >= 100 && bounds.height >= 80 {
        print("occupied")
        exit(0)
    }
}

print("clear")
