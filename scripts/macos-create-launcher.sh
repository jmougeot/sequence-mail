#!/usr/bin/env bash

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
# Logo : on accepte plusieurs noms/emplacements usuels (premier trouvé gagne) —
# fini le bug « introuvable » dès qu'on renomme le fichier.
ICON_SOURCE=""
for cand in \
  "$PROJECT_DIR/data/logo.png"   "$PROJECT_DIR/data/image.png"   "$PROJECT_DIR/data/icon.png" \
  "$PROJECT_DIR/data/logo.jpg"   "$PROJECT_DIR/data/logo.jpeg" \
  "$PROJECT_DIR/public/logo.png" "$PROJECT_DIR/public/image.png" "$PROJECT_DIR/public/icon.png"; do
  if [[ -f "$cand" ]]; then ICON_SOURCE="$cand"; break; fi
done
if [[ -z "$ICON_SOURCE" ]]; then
  echo "Aucun logo trouvé. Placez un fichier dans data/ nommé logo.png (ou image.png / icon.png)." >&2
  exit 1
fi
echo "Logo utilisé : $ICON_SOURCE"

# macOS icons must be square — pad with transparency if needed
ICON_SQUARE="$TMP_DIR/icon_square.png"
SRC_W=$(sips -g pixelWidth  "$ICON_SOURCE" | awk '/pixelWidth/{print $2}')
SRC_H=$(sips -g pixelHeight "$ICON_SOURCE" | awk '/pixelHeight/{print $2}')
SQ=$(( SRC_W > SRC_H ? SRC_W : SRC_H ))
sips --padToHeightWidth "$SQ" "$SQ" "$ICON_SOURCE" --out "$ICON_SQUARE" >/dev/null

# Arrondi « type Apple » : le logo carré est placé dans un squircle (coins
# arrondis macOS) avec la marge standard de la grille d'icônes (contenu 824 dans
# 1024), fond transparent autour. Rendu via AppKit (aucune dépendance externe).
ICON_ROUNDED="$TMP_DIR/icon_rounded.png"
cat > "$TMP_DIR/round-icon.js" <<'JS'
ObjC.import('AppKit');
function run(argv) {
  var src = argv[0], dst = argv[1];
  var SIZE = 1024, MARGIN = 100, inner = SIZE - 2 * MARGIN, radius = inner * 0.2237;
  var img = $.NSImage.alloc.initWithContentsOfFile(src);
  if (!img || !img.isValid) throw new Error('source invalide: ' + src);
  var ss = img.size;
  var rep = $.NSBitmapImageRep.alloc
    .initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
      $(), SIZE, SIZE, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
  var ctx = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep);
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.setCurrentContext(ctx);
  ctx.setImageInterpolation(3); // haute qualité
  var rect = $.NSMakeRect(MARGIN, MARGIN, inner, inner);
  $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius(rect, radius, radius).addClip;
  img.drawInRectFromRectOperationFraction(rect, $.NSMakeRect(0, 0, ss.width, ss.height), 1, 1.0);
  $.NSGraphicsContext.restoreGraphicsState;
  var png = rep.representationUsingTypeProperties(4, $()); // 4 = PNG
  if (!png.writeToFileAtomically(dst, true)) throw new Error('écriture PNG échouée');
}
JS
if osascript -l JavaScript "$TMP_DIR/round-icon.js" "$ICON_SQUARE" "$ICON_ROUNDED" 2>/dev/null; then
  ICON_SQUARE="$ICON_ROUNDED" # l'iconset et l'icône finale partent de la version arrondie
else
  echo "Avertissement : arrondi indisponible, logo carré conservé." >&2
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

# UI dans une fenêtre Chrome « mode app » (sans onglets ni barre d'adresse) :
# comportement d'application de bureau. Chrome étant scriptable (AppleScript), on
# peut « focaliser la fenêtre si elle est déjà ouverte, sinon l'ouvrir » — ce que
# Firefox ne permet pas. Ici on détecte juste Chrome ; le comportement est dans
# launch.sh.
if [[ -d "/Applications/Google Chrome.app" ]]; then
    CHROME_APP="/Applications/Google Chrome.app"
else
    CHROME_APP=""   # repli : on ouvrira l'URL avec le navigateur par défaut
fi

# L'applet AppleScript reste minimal : il délègue tout à launch.sh, embarqué dans
# le bundle (testable/débogable seul, sans échappement AppleScript hasardeux).
cat > "$TMP_DIR/launcher.applescript" <<'EOF'
on run
  set launchScript to (POSIX path of (path to me)) & "Contents/Resources/launch.sh"
  do shell script "/bin/zsh -lc " & quoted form of (quoted form of launchScript)
end run
EOF

rm -rf "$APP_PATH"
osacompile -o "$APP_PATH" "$TMP_DIR/launcher.applescript"

# launch.sh : réutilise le serveur s'il tourne déjà, ATTEND qu'il réponde, PUIS
# ouvre le navigateur (fini le « delay 2 » et les serveurs lancés en double).
# Les valeurs du projet sont injectées via %q (sûr) ; le reste n'est pas expansé.
{
  printf '#!/bin/zsh\n'
  printf 'PROJECT_DIR=%q\n' "$PROJECT_DIR"
  printf 'APP_URL=%q\n'     "$APP_URL"
  printf 'APP_PORT=%q\n'    "$APP_PORT"
  printf 'CHROME_APP=%q\n'  "$CHROME_APP"
  cat <<'LAUNCH'
cd "$PROJECT_DIR" || exit 1

# 1) S'assurer que le serveur tourne. Test tolérant à une machine chargée :
#    plusieurs essais avec délai large avant de conclure qu'il est éteint (avec
#    un seul curl --max-time 1, le moindre pic de charge concluait « éteint » à
#    tort). On ne (re)démarre que s'il est RÉELLEMENT éteint — le garde lsof
#    évite de relancer un 2e serveur (EADDRINUSE) sur un clic rapproché.
server_up() { /usr/bin/curl -s -o /dev/null --max-time 2 "$APP_URL"; }
running=""
for i in 1 2 3; do server_up && { running=1; break; }; sleep 0.3; done
if [[ -z "$running" ]] && ! /usr/sbin/lsof -nP -iTCP:"$APP_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  PORT="$APP_PORT" BASE_URL="$APP_URL" nohup npm start >> ./data/launcher.log 2>&1 &
  for i in $(seq 1 60); do server_up && break; sleep 0.5; done
fi

# 2) Afficher l'UI. Avec Chrome : si une fenêtre montre déjà l'app on la
#    focalise ; sinon on en ouvre une en « mode app » (sans onglets ni barre
#    d'adresse). D'où « focus si ouverte, sinon ouvrir », sans jamais de doublon.
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
# Identifiant unique pour que macOS ne confonde pas le cache d'icône avec d'autres apps
/usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string com.prospection.sequencemail" \
  "$APP_PATH/Contents/Info.plist" 2>/dev/null || \
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.prospection.sequencemail" \
  "$APP_PATH/Contents/Info.plist"
# Re-signe avec la nouvelle icône et le nouvel identifiant
codesign --force --sign - "$APP_PATH" >/dev/null 2>&1
touch "$APP_PATH"

# Pose l'icône via l'API officielle NSWorkspace.setIcon:forFile: (JXA) : méthode
# 100 % fiable — écrit une vraie « custom icon » (fork ressource + bit
# kCustomIcon) et rafraîchit l'affichage tout de suite, sans dépendre du cache
# d'icônes de macOS (qlmanage/killall ne suffisaient pas à eux seuls).
osascript -l JavaScript - "$APP_PATH/Contents/Resources/applet.icns" "$APP_PATH" <<'JXA' \
  || echo "Avertissement : pose d'icône via NSWorkspace échouée" >&2
ObjC.import('Cocoa');
function run(argv) {
  var img = $.NSImage.alloc.initWithContentsOfFile(argv[0]);
  if (!img || !img.isValid) throw new Error('image invalide: ' + argv[0]);
  if (!$.NSWorkspace.sharedWorkspace.setIconForFileOptions(img, argv[1], 0))
    throw new Error('setIcon a échoué');
}
JXA

# Rafraîchit Finder et Dock pour un affichage immédiat
qlmanage -r cache >/dev/null 2>&1 || true
killall Finder >/dev/null 2>&1 || true
killall Dock   >/dev/null 2>&1 || true

cat <<MSG
App creee avec succes:
  $APP_PATH

Double-clique sur l'app pour lancer Sequence Mail.
MSG
