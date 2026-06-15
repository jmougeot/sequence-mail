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
  attioApiKey: process.env.ATTIO_API_KEY ?? "",
  // Slug d'un attribut texte sur l'objet "people" d'Attio où écrire l'avancement de séquence
  attioStageAttribute: process.env.ATTIO_STAGE_ATTRIBUTE ?? "",
  // Slug de l'attribut "people" servant à filtrer l'import (défaut du formulaire de synchronisation)
  attioImportAttribute: process.env.ATTIO_IMPORT_ATTRIBUTE ?? "",
  deliverability: {
    defaultDailyLimit: int("DEFAULT_DAILY_LIMIT", 40),
    sendWindowStart: int("SEND_WINDOW_START", 9),
    sendWindowEnd: int("SEND_WINDOW_END", 18),
    weekdaysOnly: (process.env.WEEKDAYS_ONLY ?? "true") !== "false",
    minGapSeconds: int("MIN_GAP_SECONDS", 90),
    maxGapSeconds: int("MAX_GAP_SECONDS", 420),
  },
};

export function googleRedirectUri(): string {
  return `${config.baseUrl}/auth/google/callback`;
}
