#!/usr/bin/env node
// Prospection GitHub : trouve les entreprises (organisations) dont un repo public
// dépend d'un package donné, remonte au domaine de la boîte, et peut récolter des
// emails de devs depuis les commits publics.
//
// Principe : une dépendance dans un manifeste (package.json, requirements.txt…) est
// un signal d'intention fort. Deux sources de candidats :
//   - github     : API Code Search (cherche la chaîne dans les manifestes). Précis
//                  mais bridé (~10 req/min, ~1000 résultats max).
//   - ecosystems : API ecosyste.ms (repos dépendant du package, tous écosystèmes).
//                  Gratuit, paginé sans limite basse, métadonnées repo incluses.
// On ne garde que les repos d'*organisations* actives (pas de comptes perso, pas de
// forks), puis la fiche GitHub de l'org fournit le domaine — clé d'enrichissement
// et d'import Attio. Avec --emails, on scanne les commits du repo pour extraire les
// adresses en @domaine-de-l-org (données publiques).
//
// Usage :
//   GITHUB_TOKEN=$(gh auth token) node scripts/github-prospect.mjs \
//     --dep "@anthropic-ai/sdk" --min-stars 5 --active-since 2025-01-01 \
//     --source ecosystems --emails --out prospects.csv
//
// Sortie : CSV avec company/domain (+ email/first_name/last_name si --emails),
// colonnes reconnues par l'import de campagne ; le reste devient des {{variables}}.

const API = "https://api.github.com";
const ECOSYSTEMS_API = "https://repos.ecosyste.ms/api/v1";

// --- Parsing des arguments -------------------------------------------------
function parseArgs(argv) {
  const opts = {
    deps: [],
    source: "github",       // github | ecosystems
    manifest: "package.json", // source github : fichier de manifeste ciblé
    ecosystem: "npm",       // source ecosystems : npm, pypi, go, cargo, rubygems…
    includeIndirect: false, // source ecosystems : garder les dépendances transitives
    minStars: 0,
    activeSince: null,      // ISO date : ne garder que les repos poussés après
    max: 200,               // nb max de repos candidats parcourus par dépendance
    emails: false,          // récolte d'emails via les commits publics
    out: null,              // fichier CSV (défaut : stdout)
    includeUsers: false,    // par défaut on ignore les comptes perso (type User)
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--dep": opts.deps.push(...next().split(",").map(s => s.trim()).filter(Boolean)); break;
      case "--source": opts.source = next(); break;
      case "--manifest": opts.manifest = next(); break;
      case "--ecosystem": opts.ecosystem = next(); break;
      case "--include-indirect": opts.includeIndirect = true; break;
      case "--min-stars": opts.minStars = Number(next()) || 0; break;
      case "--active-since": opts.activeSince = next(); break;
      case "--max": opts.max = Number(next()) || 200; break;
      case "--emails": opts.emails = true; break;
      case "--out": opts.out = next(); break;
      case "--include-users": opts.includeUsers = true; break;
      case "-h": case "--help": opts.help = true; break;
      default: console.error(`Argument inconnu : ${a}`); process.exit(1);
    }
  }
  if (!["github", "ecosystems"].includes(opts.source)) {
    console.error(`--source doit être github ou ecosystems (reçu : ${opts.source})`);
    process.exit(1);
  }
  return opts;
}

const HELP = `Prospection GitHub par dépendance.

  --dep <nom>           Dépendance à chercher (répétable, ou "a,b,c"). Requis.
  --source <s>          github (Code Search, défaut) | ecosystems (ecosyste.ms,
                        pas de limite à 1000 résultats, plus rapide).
  --manifest <fichier>  [github] Manifeste ciblé (défaut: package.json).
                        Ex: requirements.txt, pyproject.toml, go.mod, Gemfile.
  --ecosystem <e>       [ecosystems] npm (défaut), pypi, go, cargo, rubygems…
  --include-indirect    [ecosystems] Garde aussi les dépendances transitives
                        (défaut: directes seules, signal plus fort).
  --min-stars <n>       Ignore les repos sous ce nombre d'étoiles (défaut: 0).
  --active-since <date> Ne garde que les repos poussés après cette date (YYYY-MM-DD).
  --max <n>             Repos candidats max par dépendance (défaut: 200).
  --emails              Récolte des emails de devs (@domaine de l'org) dans les
                        commits publics du repo → colonnes email/first_name/last_name.
  --include-users       Inclut aussi les comptes perso (défaut: organisations seules).
  --out <fichier.csv>   Écrit le CSV dans un fichier (défaut: sortie standard).

Auth : place ton token dans GITHUB_TOKEN (scope public_repo suffit).`;

// --- Client HTTP conscient des rate limits ---------------------------------
const token = process.env.GITHUB_TOKEN;

async function gh(path, { search = false } = {}) {
  const url = path.startsWith("http") ? path : API + path;
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "sequence-mail-prospect",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });

    // 403/429 = rate limit : on attend selon Retry-After ou la fenêtre de reset.
    if (res.status === 403 || res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      const remaining = Number(res.headers.get("x-ratelimit-remaining"));
      let waitMs;
      if (retryAfter) waitMs = retryAfter * 1000;
      else if (remaining === 0 && reset) waitMs = Math.max(0, reset * 1000 - Date.now()) + 1000;
      else waitMs = (attempt + 1) * 5000;
      console.error(`  ⏳ rate limit, pause ${Math.ceil(waitMs / 1000)}s…`);
      await sleep(waitMs);
      continue;
    }
    if (!res.ok) {
      throw new Error(`GitHub ${res.status} ${url} : ${await res.text()}`);
    }
    // La recherche de code est bridée (~10 req/min) : on lisse préventivement.
    if (search) await sleep(6500);
    return res.json();
  }
  throw new Error(`Abandon après plusieurs rate limits : ${url}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- Candidats : { fullName, owner, repo? } (repo = métadonnées si déjà connues)
// Source github : Code Search sur le manifeste. Métadonnées via /repos ensuite.
async function candidatesFromGithub(dep, manifest, max) {
  const perPage = 100;
  const out = new Map(); // fullName -> { owner, repo: null }
  const q = `"${dep}" in:file filename:${manifest}`;
  for (let page = 1; out.size < max && page <= 10; page++) {
    const data = await gh(
      `/search/code?q=${encodeURIComponent(q)}&per_page=${perPage}&page=${page}`,
      { search: true }
    );
    const items = data.items || [];
    for (const it of items) {
      const r = it.repository;
      if (r && !out.has(r.full_name)) out.set(r.full_name, { owner: r.owner.login, repo: null });
    }
    if (items.length < perPage) break;
  }
  return out;
}

// Source ecosystems : repos dépendants du package, métadonnées incluses.
async function candidatesFromEcosystems(dep, ecosystem, max, includeIndirect) {
  const perPage = 50; // per_page=100 déclenche des 500 côté ecosyste.ms sur les gros packages
  const out = new Map();
  // ecosyste.ms exige le @ des scopes npm en littéral ; seul le / doit être encodé.
  const base = `${ECOSYSTEMS_API}/usage/${ecosystem}/${dep.replace(/\//g, "%2F")}/dependencies`;
  for (let page = 1; out.size < max && page <= Math.ceil(max / perPage) + 20; page++) {
    // ecosyste.ms renvoie des 500 intermittents (cache froid) : on réessaie avec backoff.
    let res;
    for (let attempt = 0; ; attempt++) {
      res = await fetch(`${base}?per_page=${perPage}&page=${page}`, {
        headers: { "User-Agent": "sequence-mail-prospect" },
      });
      if (res.status < 500 || attempt >= 2) break;
      const waitMs = (attempt + 1) * 3000;
      console.error(`  ⏳ ecosyste.ms ${res.status} (page ${page}), retry dans ${waitMs / 1000}s…`);
      await sleep(waitMs);
    }
    // La pagination profonde d'ecosyste.ms casse (500) au-delà d'un certain offset
    // sur les gros packages : on garde ce qui a été collecté plutôt que d'échouer.
    if (res.status >= 500) {
      console.error(`  ⚠️ ecosyste.ms indisponible au-delà de la page ${page - 1} — on continue avec ${out.size} repo(s). Pour aller plus loin : --source github.`);
      break;
    }
    if (!res.ok) throw new Error(`ecosyste.ms ${res.status} : ${await res.text()}`);
    const items = await res.json();
    if (!Array.isArray(items) || !items.length) break;
    for (const it of items) {
      const r = it.repository;
      if (!r || !r.owner || out.has(r.full_name)) continue;
      if (!includeIndirect && it.direct === false) continue; // transitif = signal faible
      out.set(r.full_name, {
        owner: r.owner,
        repo: {
          fork: r.fork,
          stargazers_count: r.stargazers_count || 0,
          pushed_at: r.pushed_at || "",
          html_url: r.html_url || `https://github.com/${r.full_name}`,
          language: r.language || "",
          description: r.description || "",
        },
      });
    }
    if (items.length < perPage) break;
  }
  return out;
}

// --- Enrichissement --------------------------------------------------------
function domainFromUrl(u) {
  if (!u) return "";
  try {
    const url = new URL(u.startsWith("http") ? u : `https://${u}`);
    return url.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

async function fetchOrg(login, cache) {
  if (cache.has(login)) return cache.get(login);
  let org = null;
  try {
    org = await gh(`/users/${login}`); // /users renvoie orgs ET comptes perso
  } catch (e) {
    console.error(`  ⚠️ org ${login} : ${e.message}`);
  }
  cache.set(login, org);
  return org;
}

async function fetchRepo(fullName, cache) {
  if (cache.has(fullName)) return cache.get(fullName);
  let repo = null;
  try {
    repo = await gh(`/repos/${fullName}`);
  } catch (e) {
    console.error(`  ⚠️ repo ${fullName} : ${e.message}`);
  }
  cache.set(fullName, repo);
  return repo;
}

// Emails de devs dans les commits publics du repo : on ne retient que les adresses
// sur le domaine de l'org (exclut noreply/bots), et on privilégie la plus fréquente.
const EMAIL_BLOCKLIST = /noreply|no-reply|bot@|actions@|\[bot\]/i;
async function harvestEmails(fullName, domain) {
  if (!domain) return { email: "", first_name: "", last_name: "", other_emails: "" };
  const byEmail = new Map(); // email -> { count, name }
  for (let page = 1; page <= 3; page++) {
    let commits;
    try {
      commits = await gh(`/repos/${fullName}/commits?per_page=100&page=${page}`);
    } catch {
      break; // repo vide (409) ou inaccessible : tant pis pour les emails
    }
    if (!Array.isArray(commits) || !commits.length) break;
    for (const c of commits) {
      const a = c.commit?.author;
      if (!a?.email) continue;
      const email = a.email.toLowerCase();
      if (!email.endsWith(`@${domain}`) || EMAIL_BLOCKLIST.test(email)) continue;
      const cur = byEmail.get(email) || { count: 0, name: a.name || "" };
      cur.count++;
      if (a.name) cur.name = a.name;
      byEmail.set(email, cur);
    }
    if (commits.length < 100) break;
  }
  const ranked = [...byEmail.entries()].sort((a, b) => b[1].count - a[1].count);
  if (!ranked.length) return { email: "", first_name: "", last_name: "", other_emails: "" };
  const [best, { name }] = ranked[0];
  const parts = name.trim().split(/\s+/);
  return {
    email: best,
    first_name: parts[0] || "",
    last_name: parts.slice(1).join(" "),
    other_emails: ranked.slice(1, 5).map(([e]) => e).join(" "),
  };
}

// --- CSV -------------------------------------------------------------------
const BASE_COLS = [
  "company", "domain", "github_org", "org_url", "repo", "stars",
  "last_push", "language", "twitter", "location", "description", "matched_dep",
];
const EMAIL_COLS = ["email", "first_name", "last_name", "other_emails"];
function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// --- Programme principal ---------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help || !opts.deps.length) {
    console.error(HELP);
    process.exit(opts.help ? 0 : 1);
  }
  if (!token) {
    console.error("⚠️ GITHUB_TOKEN absent : l'API anonyme sera vite bloquée. Continue quand même…\n");
  }

  const orgCache = new Map();
  const repoCache = new Map();
  const rows = new Map(); // login -> ligne (dédup par organisation)

  for (const dep of opts.deps) {
    console.error(`🔎 Recherche de « ${dep} » (source: ${opts.source})…`);
    const found = opts.source === "ecosystems"
      ? await candidatesFromEcosystems(dep, opts.ecosystem, opts.max, opts.includeIndirect)
      : await candidatesFromGithub(dep, opts.manifest, opts.max);
    console.error(`  ${found.size} repo(s) candidats, enrichissement…`);

    for (const [fullName, cand] of found) {
      // ecosyste.ms fournit déjà les métadonnées ; sinon un appel /repos par candidat.
      const repo = cand.repo ?? await fetchRepo(fullName, repoCache);
      if (!repo) continue;
      if (repo.fork) continue;                                   // on ignore les forks
      if ((repo.stargazers_count || 0) < opts.minStars) continue;
      if (opts.activeSince && repo.pushed_at && repo.pushed_at < opts.activeSince) continue;

      const org = await fetchOrg(cand.owner, orgCache);
      if (!org) continue;
      if (org.type !== "Organization" && !opts.includeUsers) continue; // startups = orgs

      // Dédup par organisation : on garde le repo le plus étoilé comme représentant.
      const existing = rows.get(cand.owner);
      if (existing && existing._stars >= (repo.stargazers_count || 0)) continue;

      rows.set(cand.owner, {
        _stars: repo.stargazers_count || 0,
        _fullName: fullName,
        company: org.name || org.login,
        domain: domainFromUrl(org.blog) || (org.email ? org.email.split("@")[1] : ""),
        github_org: org.login,
        org_url: org.html_url,
        repo: repo.html_url,
        stars: repo.stargazers_count || 0,
        last_push: (repo.pushed_at || "").slice(0, 10),
        language: repo.language || "",
        twitter: org.twitter_username || "",
        location: org.location || "",
        description: (org.description || repo.description || "").replace(/\s+/g, " ").trim(),
        matched_dep: dep,
      });
    }
  }

  const sorted = [...rows.values()].sort((a, b) => b.stars - a.stars);

  if (opts.emails) {
    console.error(`📧 Récolte d'emails sur ${sorted.length} organisation(s)…`);
    for (const row of sorted) {
      Object.assign(row, await harvestEmails(row._fullName, row.domain));
      if (row.email) console.error(`  ✉️ ${row.company} → ${row.email}`);
    }
  }

  const cols = opts.emails ? [...EMAIL_COLS, ...BASE_COLS] : BASE_COLS;
  const csv = [cols.join(","), ...sorted.map(r => cols.map(c => csvCell(r[c])).join(","))].join("\n") + "\n";

  if (opts.out) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(opts.out, csv);
    console.error(`\n✅ ${sorted.length} organisation(s) → ${opts.out}`);
  } else {
    process.stdout.write(csv);
    console.error(`\n✅ ${sorted.length} organisation(s)`);
  }
}

main().catch(e => { console.error("❌", e.message); process.exit(1); });
