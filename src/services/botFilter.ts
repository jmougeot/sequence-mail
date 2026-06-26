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

// Plages d'IP de datacenters / hébergeurs / VPS d'où sortent les scanners et bacs à
// sable de détonation de lien. Groupées par fournisseur pour la lisibilité ; format
// [octet1, octet2Min, octet2Max]. Liste non exhaustive (les signaux user-agent et
// délai couvrent le reste) — un prospect navigue depuis du résidentiel/NAT bureau,
// pas depuis ces plages.
const DATACENTER_RANGES: Record<string, Array<[number, number, number]>> = {
  Azure: [[20, 0, 255], [40, 64, 127], [51, 0, 255], [52, 0, 255], [135, 0, 255], [4, 144, 255], [13, 64, 107], [48, 208, 223], [65, 52, 55], [72, 144, 159], [74, 234, 249], [104, 40, 47], [137, 116, 135], [157, 54, 60], [172, 160, 207], [191, 232, 239]],
  AWS: [[3, 0, 255], [16, 0, 255], [18, 0, 255], [54, 0, 255], [34, 192, 255], [44, 192, 255], [50, 16, 19], [98, 80, 95], [100, 20, 27]],
  GCP: [[35, 0, 255], [34, 0, 255], [104, 154, 199], [130, 211, 211]],
  Google: [[66, 102, 102], [66, 249, 249], [64, 233, 233], [142, 250, 250]],
  DigitalOcean: [[45, 55, 55], [46, 101, 101], [64, 225, 225], [68, 183, 183], [104, 131, 131], [104, 236, 236], [134, 122, 122], [134, 209, 209], [137, 184, 184], [138, 68, 68], [138, 197, 197], [139, 59, 59], [142, 93, 93], [143, 110, 110], [143, 198, 198], [146, 190, 190], [157, 230, 230], [157, 245, 245], [159, 65, 65], [159, 89, 89], [161, 35, 35], [162, 243, 243], [164, 90, 90], [164, 92, 92], [165, 22, 22], [165, 227, 227], [167, 71, 71], [167, 99, 99], [167, 172, 172], [170, 64, 64], [174, 138, 138], [178, 62, 62], [178, 128, 128], [188, 166, 166], [188, 226, 226], [192, 241, 241], [198, 199, 199], [198, 211, 211], [206, 189, 189], [207, 154, 154], [209, 97, 97]],
  Hetzner: [[5, 9, 9], [5, 75, 75], [23, 88, 88], [49, 12, 13], [78, 46, 47], [88, 99, 99], [91, 107, 107], [94, 130, 130], [95, 216, 217], [116, 202, 203], [128, 140, 140], [138, 201, 201], [142, 132, 132], [144, 76, 76], [148, 251, 251], [157, 90, 90], [159, 69, 69], [162, 55, 55], [167, 233, 233], [168, 119, 119], [176, 9, 9], [178, 63, 63], [188, 34, 34], [188, 40, 40], [195, 201, 201], [213, 133, 133], [213, 239, 239]],
  OVH: [[5, 39, 39], [5, 135, 135], [5, 196, 196], [37, 59, 59], [37, 187, 187], [46, 105, 105], [54, 36, 38], [91, 121, 121], [92, 222, 222], [94, 23, 23], [137, 74, 74], [141, 94, 95], [145, 239, 239], [147, 135, 135], [149, 56, 56], [149, 202, 202], [151, 80, 80], [152, 228, 228], [158, 69, 69], [167, 114, 114], [178, 32, 33], [188, 165, 165], [198, 27, 27], [213, 32, 32], [213, 186, 186], [217, 182, 182]],
  Linode: [[23, 92, 92], [23, 239, 239], [45, 33, 33], [45, 56, 56], [45, 79, 79], [50, 116, 116], [66, 175, 175], [69, 164, 164], [96, 126, 126], [97, 107, 107], [139, 144, 144], [139, 162, 162], [170, 187, 187], [172, 104, 105], [173, 255, 255], [176, 58, 58], [178, 79, 79], [192, 46, 46], [192, 155, 155], [198, 58, 58]],
  Vultr: [[45, 32, 32], [45, 63, 63], [45, 76, 77], [63, 209, 209], [64, 176, 176], [65, 20, 20], [66, 42, 42], [70, 34, 34], [95, 179, 179], [104, 207, 207], [108, 61, 61], [136, 244, 244], [137, 220, 220], [139, 180, 180], [140, 82, 82], [141, 164, 164], [144, 202, 202], [149, 28, 28], [155, 138, 138], [158, 247, 247], [192, 248, 248], [198, 13, 13], [199, 247, 247], [207, 148, 148], [207, 246, 246], [208, 167, 167], [209, 222, 222], [216, 128, 128], [217, 69, 69]],
  Scaleway: [[62, 210, 210], [151, 115, 115], [163, 172, 172], [195, 154, 154], [212, 47, 47], [212, 83, 83], [212, 129, 129]],
  Oracle: [[129, 146, 146], [129, 213, 213], [130, 61, 61], [132, 145, 145], [132, 226, 226], [138, 1, 1], [140, 238, 238], [141, 144, 145], [143, 47, 47], [144, 21, 21], [144, 24, 24], [146, 56, 56], [147, 154, 154], [150, 136, 136], [150, 230, 230], [152, 67, 67], [152, 69, 70], [155, 248, 248], [158, 101, 101], [158, 178, 180], [168, 138, 138], [192, 18, 18], [193, 122, 123]],
};

// Index par premier octet (l'ordre d'insertion départage les plages qui se
// chevauchent : ex. 34.192+ → AWS avant le 34.x générique → GCP).
const DC_BY_OCTET = new Map<number, Array<[number, number, string]>>();
for (const [provider, ranges] of Object.entries(DATACENTER_RANGES))
  for (const [a, lo, hi] of ranges) {
    if (!DC_BY_OCTET.has(a)) DC_BY_OCTET.set(a, []);
    DC_BY_OCTET.get(a)!.push([lo, hi, provider]);
  }

/**
 * Renvoie le fournisseur datacenter si l'IP appartient à une plage connue (cloud,
 * VPS, VPN) — typique des scanners — sinon null. IPv4 uniquement ; les IPv6
 * retombent sur la seule analyse du user-agent.
 */
function cloudProvider(ip: string | null): string | null {
  if (!ip || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return null;
  const [a, b] = ip.split(".").map(Number);
  for (const [lo, hi, provider] of DC_BY_OCTET.get(a) ?? [])
    if (b >= lo && b <= hi) return provider;
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
