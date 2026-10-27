#!/usr/bin/env bash
# Creates "Chrome LinkedIn.app" in ~/Applications (macOS) and puts it in the Dock in place of Google
# Chrome: it opens Chrome with the options the extension's LinkedIn work window needs.
#   --silent-debugger-extension-api        no "started debugging this browser" bar during real
#                                          gestures (it shrinks every window by 56 px)
#   --disable-backgrounding-occluded-windows  a window covered by others stays "visible": LinkedIn
#   --disable-renderer-backgrounding          keeps rendering (messaging, real mouse moves) while the
#   --disable-background-timer-throttling     work window sits behind the other windows
# The options apply to the whole Chrome process (every profile) and only when Chrome starts: if
# Chrome is already open without them, the app offers to quit and relaunch it. Chrome always comes
# back with the previous session's windows and tabs, never a blank page.
# Every profile opened afterwards (profile menu, other account) runs in that same Chrome, with them.
set -euo pipefail

APP_PATH="$HOME/Applications/Chrome LinkedIn.app"
CHROME_APP="/Applications/Google Chrome.app"
[[ -d "$CHROME_APP" ]] || { echo "Google Chrome introuvable dans /Applications" >&2; exit 1; }

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

cat > "$TMP_DIR/launcher.applescript" <<'APPLESCRIPT'
set chromeFlags to "--silent-debugger-extension-api --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling"
if application "Google Chrome" is running then
	-- options du processus Chrome principal (pas de « ps | grep » : la commande se verrait elle-même)
	set withFlags to (do shell script "for p in $(pgrep -x 'Google Chrome'); do ps -o command= -p $p; done | grep -c -e '--disable-backgrounding-occluded-windows' || true") as integer
	if withFlags > 0 then
		tell application "Google Chrome" to activate
		return
	end if
	display dialog "Chrome est ouvert sans les réglages LinkedIn. Le quitter et le relancer avec ? Les onglets ouverts reviennent." buttons {"Annuler", "Relancer"} default button "Relancer" cancel button "Annuler" with title "Chrome LinkedIn"
	tell application "Google Chrome" to quit
	repeat 60 times
		if application "Google Chrome" is not running then exit repeat
		delay 0.5
	end repeat
	if application "Google Chrome" is running then
		display dialog "Chrome ne s'est pas fermé (une fenêtre demande peut-être une confirmation). Ferme-le puis relance Chrome LinkedIn." buttons {"OK"} default button "OK" with title "Chrome LinkedIn"
		return
	end if
	delay 1
end if
-- toujours la session précédente (onglets et fenêtres), jamais une page neuve
do shell script "open -a 'Google Chrome' --args " & chromeFlags & " --restore-last-session"
APPLESCRIPT

mkdir -p "$HOME/Applications"
rm -rf "$APP_PATH"
osacompile -o "$APP_PATH" "$TMP_DIR/launcher.applescript"
# Chrome's own icon
cp "$CHROME_APP/Contents/Resources/app.icns" "$APP_PATH/Contents/Resources/applet.icns"
touch "$APP_PATH"
echo "Créé : $APP_PATH"

# Dock: the Google Chrome icon becomes Chrome LinkedIn (same place), so Chrome is never launched
# from the Dock without the options. Edited on an export (the Dock's settings are cached by macOS,
# a direct file edit could be overwritten), backed up first.
PB=/usr/libexec/PlistBuddy
DOCK="$TMP_DIR/dock.plist"
defaults export com.apple.dock "$DOCK"
APP_URL="file://$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$APP_PATH")/"
found=""
i=0
while url=$("$PB" -c "Print :persistent-apps:$i:tile-data:file-data:_CFURLString" "$DOCK" 2>/dev/null); do
  if [[ "$url" == "file:///Applications/Google%20Chrome.app/" || "$url" == "$APP_URL" ]]; then found=$i; break; fi
  i=$((i + 1))
done
if [[ -z "$found" ]]; then
  echo "Google Chrome n'est pas dans le Dock : glisse « Chrome LinkedIn » depuis ~/Applications si tu veux l'y mettre."
elif [[ "$url" == "$APP_URL" ]]; then
  echo "Dock : Chrome LinkedIn y est déjà."
else
  BACKUP="$HOME/Library/Preferences/com.apple.dock.avant-chrome-linkedin.plist"
  cp "$DOCK" "$BACKUP"
  "$PB" -c "Set :persistent-apps:$found:tile-data:file-data:_CFURLString $APP_URL" "$DOCK"
  "$PB" -c "Set :persistent-apps:$found:tile-data:file-label 'Chrome LinkedIn'" "$DOCK"
  "$PB" -c "Delete :persistent-apps:$found:tile-data:bundle-identifier" "$DOCK" 2>/dev/null || true
  "$PB" -c "Delete :persistent-apps:$found:tile-data:book" "$DOCK" 2>/dev/null || true
  [[ "${DRY_RUN:-}" == 1 ]] && { "$PB" -c "Print :persistent-apps:$found:tile-data" "$DOCK"; exit 0; }
  defaults import com.apple.dock "$DOCK"
  killall Dock
  echo "Dock : Google Chrome remplacé par Chrome LinkedIn."
  echo "Pour revenir en arrière : defaults import com.apple.dock \"$BACKUP\" && killall Dock"
fi
