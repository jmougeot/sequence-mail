#!/usr/bin/env node
// GitHub prospecting: finds companies (organizations) with a public repo that
// depends on a given package, gets the company domain, and can collect developer
// emails from public commits.
//
// A dependency in a manifest (package.json, requirements.txt…) is a strong intent
// signal. Two candidate sources:
//   - github     : Code Search API (searches manifests). Precise but throttled
//                  (~10 req/min, ~1000 results max).
//   - ecosystems : ecosyste.ms API (repos depending on the package, any ecosystem).
//                  Free, deep pagination, repo metadata included.
// Only active *organization* repos are kept (no personal accounts, no forks); the
// org's GitHub profile gives the domain, the key for enrichment and Attio import.
// With --emails, the repo's commits are scanned for @org-domain addresses
// (public data).
//
// Usage:
//   GITHUB_TOKEN=$(gh auth token) node scripts/github-prospect.mjs \
//     --dep "@anthropic-ai/sdk" --min-stars 5 --active-since 2025-01-01 \
//     --source ecosystems --emails --out prospects.csv
//
// Output: CSV with company/domain (+ email/first_name/last_name with --emails),
// columns recognized by the campaign import; the rest become {{variables}}.

const API = "https://api.github.com";
const ECOSYSTEMS_API = "https://repos.ecosyste.ms/api/v1";

// --- Argument parsing ------------------------------------------------------
function parseArgs(argv) {
  const opts = {
    deps: [],
    source: "github",       // github | ecosystems
    manifest: "package.json", // github source: target manifest file
    ecosystem: "npm",       // ecosystems source: npm, pypi, go, cargo, rubygems…
    includeIndirect: false, // ecosystems source: keep transitive dependencies
    minStars: 0,
    maxStars: Infinity,     // star cap: filters out mega-projects/big companies
    orgCreatedAfter: null,  // GitHub org created after this date = young company
    orgMaxRepos: Infinity,  // orgs with too many public repos = large groups
    activeSince: null,      // ISO date: only repos pushed after it
    max: 200,               // max candidate repos scanned per dependency
    emails: false,          // collect emails from public commits
    out: null,              // CSV file (default: stdout)
    includeUsers: false,    // personal accounts (type User) skipped by default
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
      case "--max-stars": opts.maxStars = Number(next()) || Infinity; break;
      case "--org-created-after": opts.orgCreatedAfter = next(); break;
      case "--org-max-repos": opts.orgMaxRepos = Number(next()) || Infinity; break;
      case "--active-since": opts.activeSince = next(); break;
      case "--max": opts.max = Number(next()) || 200; break;
      case "--emails": opts.emails = true; break;
      case "--out": opts.out = next(); break;
      case "--include-users": opts.includeUsers = true; break;
      case "-h": case "--help": opts.help = true; break;
      default: console.error(`Unknown argument: ${a}`); process.exit(1);
    }
  }
  if (!["github", "ecosystems"].includes(opts.source)) {
    console.error(`--source must be github or ecosystems (got: ${opts.source})`);
    process.exit(1);
  }
  return opts;
}

const HELP = `GitHub prospecting by dependency.

  --dep <name>          Dependency to search for (repeatable, or "a,b,c"). Required.
  --source <s>          github (Code Search, default) | ecosystems (ecosyste.ms,
                        no 1000-result cap, faster).
  --manifest <file>     [github] Target manifest (default: package.json).
                        E.g. requirements.txt, pyproject.toml, go.mod, Gemfile.
  --ecosystem <e>       [ecosystems] npm (default), pypi, go, cargo, rubygems…
  --include-indirect    [ecosystems] Also keep transitive dependencies
                        (default: direct only, stronger signal).
  --min-stars <n>       Skip repos with fewer stars (default: 0).
  --max-stars <n>       Skip repos with more stars (filters out mega-projects).
  --org-created-after <date>  GitHub org created after this date (young companies).
  --org-max-repos <n>   Skip orgs with more than n public repos (large groups).
  --active-since <date> Only repos pushed after this date (YYYY-MM-DD).
  --max <n>             Max candidate repos per dependency (default: 200).
  --emails              Collect developer emails (@org domain) from the repo's
                        public commits → email/first_name/last_name columns.
  --include-users       Also include personal accounts (default: organizations only).
  --out <file.csv>      Write the CSV to a file (default: stdout).

Auth: put your token in GITHUB_TOKEN (public_repo scope is enough).`;

// --- Rate-limit-aware HTTP client --------------------------------------------
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

    // 403/429 = rate limit: wait for Retry-After or the reset window.
    if (res.status === 403 || res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      const remaining = Number(res.headers.get("x-ratelimit-remaining"));
      let waitMs;
      if (retryAfter) waitMs = retryAfter * 1000;
      else if (remaining === 0 && reset) waitMs = Math.max(0, reset * 1000 - Date.now()) + 1000;
      else waitMs = (attempt + 1) * 5000;
      console.error(`  ⏳ rate limit, waiting ${Math.ceil(waitMs / 1000)}s…`);
      await sleep(waitMs);
      continue;
    }
    if (!res.ok) {
      throw new Error(`GitHub ${res.status} ${url} : ${await res.text()}`);
    }
    // Code search is throttled (~10 req/min): pace requests up front.
    if (search) await sleep(6500);
    return res.json();
  }
  throw new Error(`Giving up after repeated rate limits: ${url}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- Candidates: { fullName, owner, repo? } (repo = metadata when already known)
// github source: Code Search on the manifest; metadata from /repos afterwards.
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

// ecosystems source: repos depending on the package, metadata included.
async function candidatesFromEcosystems(dep, ecosystem, max, includeIndirect) {
  const perPage = 50; // per_page=100 triggers 500s on ecosyste.ms for big packages
  const out = new Map();
  // ecosyste.ms wants the npm scope @ literal; only / is encoded.
  const base = `${ECOSYSTEMS_API}/usage/${ecosystem}/${dep.replace(/\//g, "%2F")}/dependencies`;
  for (let page = 1; out.size < max && page <= Math.ceil(max / perPage) + 20; page++) {
    // ecosyste.ms returns intermittent 500s (cold cache): retry with backoff.
    let res;
    for (let attempt = 0; ; attempt++) {
      res = await fetch(`${base}?per_page=${perPage}&page=${page}`, {
        headers: { "User-Agent": "sequence-mail-prospect" },
      });
      if (res.status < 500 || attempt >= 2) break;
      const waitMs = (attempt + 1) * 3000;
      console.error(`  ⏳ ecosyste.ms ${res.status} (page ${page}), retrying in ${waitMs / 1000}s…`);
      await sleep(waitMs);
    }
    // Deep pagination breaks (500) past some offset on big packages: keep what
    // was collected instead of failing.
    if (res.status >= 500) {
      console.error(`  ⚠️ ecosyste.ms unavailable past page ${page - 1}; continuing with ${out.size} repo(s). For more: --source github.`);
      break;
    }
    if (!res.ok) throw new Error(`ecosyste.ms ${res.status} : ${await res.text()}`);
    const items = await res.json();
    if (!Array.isArray(items) || !items.length) break;
    for (const it of items) {
      const r = it.repository;
      if (!r || !r.owner || out.has(r.full_name)) continue;
      if (!includeIndirect && it.direct === false) continue; // transitive = weak signal
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

// --- Enrichment --------------------------------------------------------------
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
    org = await gh(`/users/${login}`); // /users returns orgs AND personal accounts
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

// Developer emails from the repo's public commits: only addresses on the org
// domain (no noreply/bots), most frequent first.
const EMAIL_BLOCKLIST = /noreply|no-reply|bot@|actions@|\[bot\]/i;
async function harvestEmails(fullName, domain) {
  if (!domain) return { email: "", first_name: "", last_name: "", other_emails: "" };
  const byEmail = new Map(); // email -> { count, name }
  for (let page = 1; page <= 3; page++) {
    let commits;
    try {
      commits = await gh(`/repos/${fullName}/commits?per_page=100&page=${page}`);
    } catch {
      break; // empty (409) or inaccessible repo: no emails
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

// --- Main -------------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help || !opts.deps.length) {
    console.error(HELP);
    process.exit(opts.help ? 0 : 1);
  }
  if (!token) {
    console.error("⚠️ GITHUB_TOKEN missing: the anonymous API gets blocked quickly. Continuing anyway…\n");
  }

  const orgCache = new Map();
  const repoCache = new Map();
  const rows = new Map(); // login -> row (dedup by organization)

  for (const dep of opts.deps) {
    console.error(`🔎 Searching "${dep}" (source: ${opts.source})…`);
    const found = opts.source === "ecosystems"
      ? await candidatesFromEcosystems(dep, opts.ecosystem, opts.max, opts.includeIndirect)
      : await candidatesFromGithub(dep, opts.manifest, opts.max);
    console.error(`  ${found.size} candidate repo(s), enriching…`);

    for (const [fullName, cand] of found) {
      // ecosyste.ms already provides metadata; otherwise one /repos call per candidate.
      const repo = cand.repo ?? await fetchRepo(fullName, repoCache);
      if (!repo) continue;
      if (repo.fork) continue;                                   // skip forks
      const stars = repo.stargazers_count || 0;
      if (stars < opts.minStars || stars > opts.maxStars) continue;
      if (opts.activeSince && repo.pushed_at && repo.pushed_at < opts.activeSince) continue;

      const org = await fetchOrg(cand.owner, orgCache);
      if (!org) continue;
      if (org.type !== "Organization" && !opts.includeUsers) continue; // startups = orgs
      if (opts.orgCreatedAfter && org.created_at && org.created_at < opts.orgCreatedAfter) continue;
      if ((org.public_repos || 0) > opts.orgMaxRepos) continue;   // large groups

      // Dedup by organization: keep the most-starred repo as representative.
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
    console.error(`📧 Collecting emails for ${sorted.length} organization(s)…`);
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
    console.error(`\n✅ ${sorted.length} organization(s) → ${opts.out}`);
  } else {
    process.stdout.write(csv);
    console.error(`\n✅ ${sorted.length} organization(s)`);
  }
}

main().catch(e => { console.error("❌", e.message); process.exit(1); });
