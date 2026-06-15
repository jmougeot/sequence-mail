#!/usr/bin/env bash

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="Sequence Mail.app"
DESKTOP_DIR="$HOME/Desktop"
APP_PATH="$DESKTOP_DIR/$APP_NAME"
APP_URL="http://localhost:3000"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

ICONSET_DIR="$TMP_DIR/SequenceMail.iconset"
mkdir -p "$ICONSET_DIR"

cat > "$TMP_DIR/make-icon.swift" <<'SWIFT'
import AppKit

let args = CommandLine.arguments
guard args.count == 3, let size = Double(args[1]) else {
    fputs("Usage: make-icon.swift <size> <outputPath>\n", stderr)
    exit(1)
}

let outputPath = args[2]
let canvas = NSSize(width: size, height: size)
let image = NSImage(size: canvas)

image.lockFocus()

let rect = NSRect(origin: .zero, size: canvas)

let gradient = NSGradient(
    colors: [
        NSColor(calibratedRed: 0.06, green: 0.62, blue: 0.98, alpha: 1.0),
        NSColor(calibratedRed: 0.02, green: 0.37, blue: 0.75, alpha: 1.0)
    ]
)
let radius = size * 0.22
let bgPath = NSBezierPath(roundedRect: rect.insetBy(dx: size * 0.04, dy: size * 0.04), xRadius: radius, yRadius: radius)
gradient?.draw(in: bgPath, angle: -45)

let flapTop = size * 0.62
let leftX = size * 0.19
let rightX = size * 0.81
let bottomY = size * 0.30

let envRect = NSRect(x: leftX, y: bottomY, width: rightX - leftX, height: flapTop - bottomY)
let envPath = NSBezierPath(roundedRect: envRect, xRadius: size * 0.04, yRadius: size * 0.04)
NSColor.white.withAlphaComponent(0.98).setFill()
envPath.fill()

let flapPath = NSBezierPath()
flapPath.move(to: NSPoint(x: leftX, y: flapTop))
flapPath.line(to: NSPoint(x: size * 0.50, y: size * 0.43))
flapPath.line(to: NSPoint(x: rightX, y: flapTop))
flapPath.close()
NSColor(calibratedWhite: 0.93, alpha: 1.0).setFill()
flapPath.fill()

let linePath = NSBezierPath()
linePath.move(to: NSPoint(x: leftX, y: bottomY))
linePath.line(to: NSPoint(x: size * 0.50, y: size * 0.43))
linePath.line(to: NSPoint(x: rightX, y: bottomY))
NSColor(calibratedWhite: 0.83, alpha: 1.0).setStroke()
linePath.lineWidth = max(2.0, size * 0.015)
linePath.stroke()

let borderPath = NSBezierPath(roundedRect: envRect, xRadius: size * 0.04, yRadius: size * 0.04)
NSColor(calibratedWhite: 0.80, alpha: 1.0).setStroke()
borderPath.lineWidth = max(2.0, size * 0.012)
borderPath.stroke()

image.unlockFocus()

guard
    let tiffData = image.tiffRepresentation,
    let rep = NSBitmapImageRep(data: tiffData),
    let pngData = rep.representation(using: .png, properties: [:])
else {
    fputs("Failed to render PNG\n", stderr)
    exit(1)
}

do {
    try pngData.write(to: URL(fileURLWithPath: outputPath))
} catch {
    fputs("Failed to write PNG: \(error)\n", stderr)
    exit(1)
}
SWIFT

render_icon() {
  local size="$1"
  local filename="$2"
  swift "$TMP_DIR/make-icon.swift" "$size" "$ICONSET_DIR/$filename"
}

render_icon 16 icon_16x16.png
render_icon 32 icon_16x16@2x.png
render_icon 32 icon_32x32.png
render_icon 64 icon_32x32@2x.png
render_icon 128 icon_128x128.png
render_icon 256 icon_128x128@2x.png
render_icon 256 icon_256x256.png
render_icon 512 icon_256x256@2x.png
render_icon 512 icon_512x512.png
render_icon 1024 icon_512x512@2x.png

iconutil -c icns "$ICONSET_DIR" -o "$TMP_DIR/SequenceMail.icns"

PROJECT_DIR_ESCAPED="$(printf '%s' "$PROJECT_DIR" | sed 's/"/\\\\"/g')"
APP_URL_ESCAPED="$(printf '%s' "$APP_URL" | sed 's/"/\\\\"/g')"

if [[ -d "/Applications/Firefox Developer Edition.app" ]]; then
    OPEN_UI_CMD="open -na '/Applications/Firefox Developer Edition.app' --args --new-window $APP_URL"
elif [[ -d "/Applications/Firefox.app" ]]; then
    OPEN_UI_CMD="open -na '/Applications/Firefox.app' --args --new-window $APP_URL"
elif [[ -d "/Applications/Google Chrome.app" ]]; then
    OPEN_UI_CMD="open -na '/Applications/Google Chrome.app' --args --app=$APP_URL"
elif [[ -d "/Applications/Microsoft Edge.app" ]]; then
    OPEN_UI_CMD="open -na '/Applications/Microsoft Edge.app' --args --app=$APP_URL"
else
    OPEN_UI_CMD="open '$APP_URL'"
fi

OPEN_UI_CMD_ESCAPED="$(printf '%s' "$OPEN_UI_CMD" | sed 's/"/\\\\"/g')"

cat > "$TMP_DIR/launcher.applescript" <<EOF
on run
  set projectDir to "${PROJECT_DIR_ESCAPED}"
    set appUrl to "${APP_URL_ESCAPED}"
    set openUiCmd to "${OPEN_UI_CMD_ESCAPED}"
  set launchCmd to "cd " & quoted form of projectDir & " && nohup npm start >> ./data/launcher.log 2>&1 &"
  do shell script "/bin/zsh -lc " & quoted form of launchCmd

  delay 2
    do shell script "/bin/zsh -lc " & quoted form of openUiCmd
end run
EOF

rm -rf "$APP_PATH"
osacompile -o "$APP_PATH" "$TMP_DIR/launcher.applescript"
cp "$TMP_DIR/SequenceMail.icns" "$APP_PATH/Contents/Resources/applet.icns"

cat <<MSG
App creee avec succes:
  $APP_PATH

Double-clique sur l'app pour lancer Sequence Mail.
MSG
