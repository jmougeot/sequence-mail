/**
 * Détection minimale des bots / scanners sur les visites du lien {{link}}.
 *
 * Les passerelles de sécurité email (Microsoft Defender « Safe Links », Proofpoint,
 * Mimecast, Barracuda…) ouvrent automatiquement les liens dès la livraison, ce qui
 * gonfle artificiellement le nombre de « visites ». On les écarte sur trois signaux
 * robustes et sans dépendance externe : le user-agent, la plage d'IP (datacenter) et
 * le délai envoi→clic (un clic en quelques secondes ne peut pas être humain).
 */

import { config } from "../config.js";

export interface VisitVerdict {
  /** true = visite d'un bot/scanner (à exclure des stats). */
  bot: boolean;
  /** Motif court du classement ("" si humain). */
  reason: string;
}

// User-agents d'outils ou de scanners explicites.
const UA_BOT =
  /(bot|spider|crawl|slurp|preview|proofpoint|urldefense|barracuda|mimecast|messagelabs|symantec|forcepoint|cloudmark|googleimageproxy|appengine|curl|wget|python-|go-http-client|java\/|libwww|okhttp|axios|node-fetch|headless|phantom|puppeteer|selenium|playwright|monitor|uptime|pingdom)/i;

// Un vrai navigateur grand public porte toujours un jeton produit final
// (Chrome/Firefox/Safari+Version/Edg…). Beaucoup de scanners s'arrêtent à
// "(KHTML, like Gecko)" sans jeton : on les considère alors comme non humains.
const REAL_BROWSER =
  /(Chrome|Chromium|CriOS)\/\d|(Firefox|FxiOS)\/\d|Version\/\d[\d.]* (Mobile\/\w+ )?Safari|Edg(A|iOS)?\/\d|OPR\/\d|SamsungBrowser\/\d|YaBrowser\/\d/i;

/**
 * Renvoie le fournisseur cloud si l'IP appartient à une plage de datacenter connue
 * (Azure/AWS/GCP/Google) — typique des scanners — sinon null. IPv4 uniquement ;
 * les IPv6 retombent sur la seule analyse du user-agent.
 */
function cloudProvider(ip: string | null): string | null {
  if (!ip || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return null;
  const [a, b] = ip.split(".").map(Number);
  // Microsoft Azure
  if (a === 20 || a === 52 || a === 135) return "Azure";
  if (a === 4 && b >= 144) return "Azure";
  if (a === 13 && b >= 64 && b <= 107) return "Azure";
  if (a === 40 && b >= 64) return "Azure";
  if (a === 48 && b >= 208 && b <= 223) return "Azure";
  if (a === 51) return "Azure";
  if (a === 65 && b >= 52 && b <= 55) return "Azure";
  if (a === 72 && b >= 144 && b <= 159) return "Azure";
  if (a === 74 && b >= 234 && b <= 249) return "Azure";
  if (a === 104 && b >= 40 && b <= 47) return "Azure";
  if (a === 137 && b >= 116 && b <= 135) return "Azure";
  if (a === 157 && b >= 54 && b <= 60) return "Azure";
  if (a === 172 && b >= 160 && b <= 207) return "Azure";
  if (a === 191 && b >= 232 && b <= 239) return "Azure";
  // AWS
  if (a === 3 || a === 16 || a === 18 || a === 54) return "AWS";
  if (a === 34 && b >= 192) return "AWS";
  if (a === 44 && b >= 192) return "AWS";
  if (a === 50 && b >= 16 && b <= 19) return "AWS";
  if (a === 98 && b >= 80 && b <= 95) return "AWS";
  if (a === 100 && b >= 20 && b <= 27) return "AWS";
  // Google Cloud / Google
  if (a === 34 || a === 35) return "GCP";
  if (a === 104 && b >= 154 && b <= 199) return "GCP";
  if (a === 130 && b === 211) return "GCP";
  if (a === 66 && (b === 102 || b === 249)) return "Google";
  if (a === 64 && b === 233) return "Google";
  if (a === 142 && b === 250) return "Google";
  return null;
}

/**
 * Classe une visite : bot/scanner probable ou humain.
 * @param delaySeconds délai (s) entre l'envoi de l'email et la visite, ou null si
 *   l'heure d'envoi est inconnue (le critère temporel est alors ignoré).
 */
export function classifyVisit(
  userAgent: string | null,
  ip: string | null,
  delaySeconds: number | null = null
): VisitVerdict {
  const ua = (userAgent ?? "").trim();
  if (!ua) return { bot: true, reason: "ua-vide" };
  const m = ua.match(UA_BOT);
  if (m) return { bot: true, reason: `ua-scanner:${m[1].toLowerCase()}` };
  const minDelay = config.visit.botMinDelaySeconds;
  if (minDelay > 0 && delaySeconds != null && delaySeconds >= 0 && delaySeconds < minDelay)
    return { bot: true, reason: `clic-instantane:${delaySeconds}s` };
  if (!REAL_BROWSER.test(ua)) return { bot: true, reason: "ua-sans-navigateur" };
  const provider = cloudProvider(ip);
  if (provider) return { bot: true, reason: `ip-datacenter:${provider}` };
  return { bot: false, reason: "" };
}
