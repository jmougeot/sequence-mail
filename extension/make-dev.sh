#!/bin/sh
# Build de développement de l'extension : copie dans ../extension-dev (ignoré par git) où
# l'app Azerit et Sequence Mail servis en local (localhost, 127.0.0.1) sont acceptés : pont
# d'appairage injecté sur ces pages, remise de session autorisée vers elles, requêtes au
# serveur local. L'extension distribuée (ce dossier) ne les connaît pas : une page servie en
# local pourrait sinon obtenir la session LinkedIn de la personne.
# Usage : ./make-dev.sh, puis chrome://extensions → Charger l'extension non empaquetée → extension-dev.
set -e
cd "$(dirname "$0")"
out=../extension-dev
rm -rf "$out" && mkdir "$out"
cp *.js *.json *.html "$out"/
python3 - "$out" <<'PY'
import json, sys
out = sys.argv[1]
local = ["http://localhost/*", "http://127.0.0.1/*"]
m = json.load(open(f"{out}/manifest.json", encoding="utf-8"))
m["name"] += " (dev)"
m["host_permissions"] += local
for cs in m["content_scripts"]:
    if "azerit-bridge.js" in cs["js"]:
        cs["matches"] += local
json.dump(m, open(f"{out}/manifest.json", "w", encoding="utf-8"), indent=2, ensure_ascii=False)
p = f"{out}/background.js"
s = open(p, encoding="utf-8").read()
assert s.count("const DEV_ORIGINS = false;") == 1
open(p, "w", encoding="utf-8").write(s.replace("const DEV_ORIGINS = false;", "const DEV_ORIGINS = true;"))
PY
echo "extension-dev prête : $(cd "$out" && pwd)"
