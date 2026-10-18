#!/usr/bin/env bash
# Creates "Sequence Mail.app" on the Desktop (macOS): starts the local server if
# needed and opens the UI in a Chrome app window.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="Sequence Mail.app"
DESKTOP_DIR="$HOME/Desktop"
APP_PATH="$DESKTOP_DIR/$APP_NAME"
APP_PORT=3000
APP_URL="http://localhost:${APP_PORT}"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

ICONSET_DIR="$TMP_DIR/SequenceMail.iconset"
mkdir -p "$ICONSET_DIR"
# Logo: accept several usual names/locations (first match wins).
ICON_SOURCE=""
for cand in \
  "$PROJECT_DIR/data/logo.png"   "$PROJECT_DIR/data/image.png"   "$PROJECT_DIR/data/icon.png" \
  "$PROJECT_DIR/data/logo.jpg"   "$PROJECT_DIR/data/logo.jpeg" \
  "$PROJECT_DIR/public/logo.png" "$PROJECT_DIR/public/image.png" "$PROJECT_DIR/public/icon.png"; do
  if [[ -f "$cand" ]]; then ICON_SOURCE="$cand"; break; fi
done
if [[ -z "$ICON_SOURCE" ]]; then
  echo "No logo found. Put a file named logo.png (or image.png / icon.png) in data/." >&2
  exit 1
fi
echo "Using logo: $ICON_SOURCE"

# macOS icons must be square — pad with transparency if needed
ICON_SQUARE="$TMP_DIR/icon_square.png"
SRC_W=$(sips -g pixelWidth  "$ICON_SOURCE" | awk '/pixelWidth/{print $2}')
SRC_H=$(sips -g pixelHeight "$ICON_SOURCE" | awk '/pixelHeight/{print $2}')
SQ=$(( SRC_W > SRC_H ? SRC_W : SRC_H ))
sips --padToHeightWidth "$SQ" "$SQ" "$ICON_SOURCE" --out "$ICON_SQUARE" >/dev/null

# Apple-style rounding: the square logo goes into a squircle with the standard
# icon-grid margin (824 content in 1024), transparent around. Rendered with
# AppKit (no external dependency).
ICON_ROUNDED="$TMP_DIR/icon_rounded.png"
cat > "$TMP_DIR/round-icon.js" <<'JS'
ObjC.import('AppKit');
function run(argv) {
  var src = argv[0], dst = argv[1];
  var SIZE = 1024, MARGIN = 100, inner = SIZE - 2 * MARGIN, radius = inner * 0.2237;
  var img = $.NSImage.alloc.initWithContentsOfFile(src);
  if (!img || !img.isValid) throw new Error('invalid source: ' + src);
  var ss = img.size;
  var rep = $.NSBitmapImageRep.alloc
    .initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
      $(), SIZE, SIZE, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
  var ctx = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep);
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.setCurrentContext(ctx);
  ctx.setImageInterpolation(3); // high quality
  var rect = $.NSMakeRect(MARGIN, MARGIN, inner, inner);
  $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius(rect, radius, radius).addClip;
  img.drawInRectFromRectOperationFraction(rect, $.NSMakeRect(0, 0, ss.width, ss.height), 1, 1.0);
  $.NSGraphicsContext.restoreGraphicsState;
  var png = rep.representationUsingTypeProperties(4, $()); // 4 = PNG
  if (!png.writeToFileAtomically(dst, true)) throw new Error('PNG write failed');
}
JS
if osascript -l JavaScript "$TMP_DIR/round-icon.js" "$ICON_SQUARE" "$ICON_ROUNDED" 2>/dev/null; then
  ICON_SQUARE="$ICON_ROUNDED" # iconset and final icon use the rounded version
else
  echo "Warning: rounding unavailable, keeping the square logo." >&2
fi

render_icon() {
  local size="$1"
  local filename="$2"
  sips -s format png -z "$size" "$size" "$ICON_SQUARE" --out "$ICONSET_DIR/$filename" >/dev/null
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

# UI in a Chrome "app mode" window (no tabs or address bar). Chrome is
# AppleScript-scriptable, so launch.sh can focus an open window instead of
# opening a second one. Here we only detect Chrome.
if [[ -d "/Applications/Google Chrome.app" ]]; then
    CHROME_APP="/Applications/Google Chrome.app"
else
    CHROME_APP=""   # fallback: open the URL in the default browser
fi

# Minimal AppleScript applet: delegates to launch.sh inside the bundle
# (testable on its own, no AppleScript escaping).
cat > "$TMP_DIR/launcher.applescript" <<'EOF'
on run
  set launchScript to (POSIX path of (path to me)) & "Contents/Resources/launch.sh"
  do shell script "/bin/zsh -lc " & quoted form of (quoted form of launchScript)
end run
EOF

rm -rf "$APP_PATH"
osacompile -o "$APP_PATH" "$TMP_DIR/launcher.applescript"

# launch.sh: reuse the running server, WAIT until it answers, THEN open the
# browser (no double start). Project values are injected with %q (safe);
# the rest is not expanded.
{
  printf '#!/bin/zsh\n'
  printf 'PROJECT_DIR=%q\n' "$PROJECT_DIR"
  printf 'APP_URL=%q\n'     "$APP_URL"
  printf 'APP_PORT=%q\n'    "$APP_PORT"
  printf 'CHROME_APP=%q\n'  "$CHROME_APP"
  cat <<'LAUNCH'
cd "$PROJECT_DIR" || exit 1

# 1) Make sure the server runs. Several tries with a generous timeout, so a busy
#    machine isn't mistaken for a stopped server; the lsof guard avoids starting
#    a second one (EADDRINUSE) on a quick double click.
server_up() { /usr/bin/curl -s -o /dev/null --max-time 2 "$APP_URL"; }
running=""
for i in 1 2 3; do server_up && { running=1; break; }; sleep 0.3; done
if [[ -z "$running" ]] && ! /usr/sbin/lsof -nP -iTCP:"$APP_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  PORT="$APP_PORT" BASE_URL="$APP_URL" nohup npm start >> ./data/launcher.log 2>&1 &
  for i in $(seq 1 60); do server_up && break; sleep 0.5; done
fi

# 2) Show the UI. With Chrome: focus a window already showing the app, else
#    open one in app mode. Never a duplicate.
if [[ -n "$CHROME_APP" ]]; then
  focused=$(/usr/bin/osascript - "$APP_URL" <<'OSA'
on run argv
  set target to item 1 of argv
  if application "Google Chrome" is not running then return "notrunning"
  tell application "Google Chrome"
    repeat with w in windows
      set tabList to tabs of w
      repeat with i from 1 to (count of tabList)
        if (URL of (item i of tabList)) starts with target then
          set active tab index of w to i
          set index of w to 1
          activate
          return "focused"
        end if
      end repeat
    end repeat
  end tell
  return "notfound"
end run
OSA
)
  if [[ "$focused" != "focused" ]]; then
    open -na "$CHROME_APP" --args --app="$APP_URL"
  fi
else
  open "$APP_URL"
fi
LAUNCH
} > "$APP_PATH/Contents/Resources/launch.sh"
chmod +x "$APP_PATH/Contents/Resources/launch.sh"

cp "$TMP_DIR/SequenceMail.icns" "$APP_PATH/Contents/Resources/applet.icns"
# Unique bundle id so macOS doesn't mix up the icon cache with other apps
/usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string com.prospection.sequencemail" \
  "$APP_PATH/Contents/Info.plist" 2>/dev/null || \
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.prospection.sequencemail" \
  "$APP_PATH/Contents/Info.plist"
# Re-sign with the new icon and bundle id
codesign --force --sign - "$APP_PATH" >/dev/null 2>&1
touch "$APP_PATH"

# Set the icon with NSWorkspace.setIcon:forFile: (JXA): writes a real custom
# icon and refreshes right away, unlike relying on the icon cache alone.
osascript -l JavaScript - "$APP_PATH/Contents/Resources/applet.icns" "$APP_PATH" <<'JXA' \
  || echo "Warning: setting the icon via NSWorkspace failed" >&2
ObjC.import('Cocoa');
function run(argv) {
  var img = $.NSImage.alloc.initWithContentsOfFile(argv[0]);
  if (!img || !img.isValid) throw new Error('invalid image: ' + argv[0]);
  if (!$.NSWorkspace.sharedWorkspace.setIconForFileOptions(img, argv[1], 0))
    throw new Error('setIcon failed');
}
JXA

# Refresh Finder and Dock so the icon shows immediately
qlmanage -r cache >/dev/null 2>&1 || true
killall Finder >/dev/null 2>&1 || true
killall Dock   >/dev/null 2>&1 || true

cat <<MSG
App created:
  $APP_PATH

Double-click it to launch Sequence Mail.
MSG
