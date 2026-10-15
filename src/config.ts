import "dotenv/config";

function int(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  port: int("PORT", 3000),
  baseUrl: process.env.BASE_URL ?? "http://localhost:3000",
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  },
  // Lien personnalisé par prospect, à placer dans l'email via {{link}}. Il pointe
  // vers VISIT_BASE_URL (idéalement un sous-domaine type sequence.example.com qui sert
  // cette app), journalise la visite côté serveur (fiable), puis redirige 302 vers
  // VISIT_DEST_URL (ta page publique). VISIT_BASE_URL doit être PUBLIC.
  visit: {
    enabled: (process.env.VISIT_ENABLED ?? "true") !== "false",
    baseUrl: (process.env.VISIT_BASE_URL || process.env.BASE_URL || "http://localhost:3000").replace(/\/+$/, ""),
    destUrl: (process.env.VISIT_DEST_URL || "https://www.example.com").replace(/\/+$/, ""),
    // Filtrage bot : un clic moins de N secondes après l'envoi est un scanner de
    // sécurité (Safe Links…), pas un humain. 0 désactive le critère temporel.
    botMinDelaySeconds: int("VISIT_BOT_MIN_DELAY_SECONDS", 60),
  },
  attioApiKey: process.env.ATTIO_API_KEY ?? "",
  // Slug d'un attribut texte sur l'objet "people" d'Attio où écrire l'avancement de séquence
  attioStageAttribute: process.env.ATTIO_STAGE_ATTRIBUTE ?? "",
  // Slug de l'attribut "people" servant à filtrer l'import (défaut du formulaire de synchronisation)
  attioImportAttribute: process.env.ATTIO_IMPORT_ATTRIBUTE ?? "",
  deliverability: {
    defaultDailyLimit: int("DEFAULT_DAILY_LIMIT", 40),
    sendWindowStart: int("SEND_WINDOW_START", 9),
    sendWindowEnd: int("SEND_WINDOW_END", 18),
    // Fuseau dans lequel se lisent ces heures et les jours de semaine (défaut : celui du serveur)
    sendWindowTimezone: process.env.SEND_WINDOW_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
    weekdaysOnly: (process.env.WEEKDAYS_ONLY ?? "true") !== "false",
    minGapSeconds: int("MIN_GAP_SECONDS", 90),
    maxGapSeconds: int("MAX_GAP_SECONDS", 420),
    // Warm-up email : on démarre bas et on monte par palier hebdomadaire jusqu'au
    // quota du compte. Indispensable sur un domaine neuf (réputation à construire).
    warmupStart: int("WARMUP_START", 5),
    warmupRamp: int("WARMUP_RAMP", 5),
  },
  // Étapes LinkedIn (invitations/messages via l'extension Chrome). Ces garde-fous
  // sont LE rempart anti-ban : plafonds du jour, journée ouvrée et délais
  // aléatoires. Les baisser est sûr ; les gonfler augmente le risque de
  // restriction du compte. Voir .env.example (préfixe LI_).
  linkedin: {
    invitesPerDay: int("LI_INVITES_PER_DAY", 20),
    messagesPerDay: int("LI_MESSAGES_PER_DAY", 40),
    hourStart: int("LI_HOUR_START", 9),
    hourEnd: int("LI_HOUR_END", 18),
    workdaysOnly: (process.env.LI_WORKDAYS_ONLY ?? "1") !== "0",
    minGapSec: int("LI_MIN_GAP_SEC", 90),
    maxGapSec: int("LI_MAX_GAP_SEC", 240),
    pauseAfterErrorMin: int("LI_PAUSE_AFTER_ERROR_MIN", 60),
    // Report quand un message vise un contact pas encore connecté (invitation non acceptée)
    messageRetryHours: int("LI_MESSAGE_RETRY_HOURS", 12),
    // …pendant au plus N jours après la mise en file : au-delà, invitation ignorée, séquence close.
    messageRetryMaxDays: int("LI_MESSAGE_RETRY_MAX_DAYS", 21),
    // Contrôle de sécurité / captcha LinkedIn : pause longue du compte concerné
    checkpointPauseMin: int("LI_CHECKPOINT_PAUSE_MIN", 24 * 60),
    // Lecture de la messagerie (détection des réponses LinkedIn) : au plus une
    // fois toutes les N minutes par compte, s'il a des contacts à surveiller.
    inboxEveryMin: int("LI_INBOX_EVERY_MIN", 20),
    // Chiffre la session LinkedIn et le proxy des comptes en mode serveur.
    // Obligatoire pour ce mode ; ne jamais le changer sans renvoyer les sessions.
    secretKey: process.env.LI_SECRET_KEY ?? "",
    // Secret partagé avec le service runner (navigateurs serveur), réseau interne.
    runnerSecret: process.env.LI_RUNNER_SECRET ?? "",
    // Propriétaires (ex. « azerit:u:1 ») dont l'extension Chrome exécute elle-même
    // les envois : à l'appairage depuis Azerit, elle reçoit le jeton de son compte
    // et se connecte seule. Les autres extensions ne font que relier LinkedIn.
    extensionOwners: (process.env.LI_EXTENSION_OWNERS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  },
  // Clé de l'API de service (/api/svc) appelée par Azerit sur le réseau interne
  // du VPS. Vide = API désactivée.
  serviceApiKey: process.env.SERVICE_API_KEY ?? "",
};

export function googleRedirectUri(): string {
  return `${config.baseUrl}/auth/google/callback`;
}
