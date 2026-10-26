/**
 * A campaign's steps: validation and storage, shared by the dashboard (server.ts) and the service
 * API Azerit drives (service-routes.ts), so a sequence edited in either place obeys the same rules
 * and lands in the same shape.
 *
 * A step is either an email (subject + body) or a LinkedIn action (channel='linkedin',
 * li_action='invite'|'message', body = note/message). branch: only for contacts whose invitation
 * was accepted ('accepted') or not ('not_accepted'); absent = all (see branches.ts).
 * with_previous: goes at the same time as the previous step (one email + one LinkedIn action).
 */
import { db } from "../db.js";
import { BRANCHES, type Branch } from "./branches.js";

export type StepInput = {
  subject?: string;
  subject_b?: string;
  body?: string;
  wait_days?: number;
  channel?: string;
  li_action?: string;
  branch?: string;
  with_previous?: boolean | number;
};

/** A step as stored and served back (GET campaign, service API). */
export type StepRow = {
  step_number: number;
  subject: string;
  subject_b: string | null;
  body: string;
  wait_days: number;
  channel: string;
  li_action: string | null;
  branch: string | null;
  with_previous: number;
};

/** Where the sequence was last written from: the dashboard, or Azerit (service API). */
export type StepsSource = "dashboard" | "azerit";

const isEmail = (s: StepInput) => (s.channel ?? "email") !== "linkedin";
const isMessage = (s: StepInput) => s.channel === "linkedin" && s.li_action === "message";
const isInvite = (s: StepInput) => s.channel === "linkedin" && (s.li_action ?? "invite") === "invite";

/** Validates a sequence; returns an error message, or null if valid. */
export function validateSteps(steps: StepInput[] | undefined): string | null {
  if (!Array.isArray(steps) || !steps.length) return "steps[] est requis";
  // The first email opens the thread, so its subject is required (subjectless follow-ups go out
  // as "Re:"). With branches, the first email of each branch.
  const hasBranches = steps.some((s) => s.branch);
  for (const branch of hasBranches ? BRANCHES : [undefined]) {
    const firstEmail = steps.find((s) => isEmail(s) && (!s.branch || s.branch === branch));
    if (firstEmail && !firstEmail.subject?.trim()) {
      return branch
        ? `Le premier email des contacts dont l'invitation ${branch === "accepted" ? "est acceptée" : "n'est pas acceptée"} doit avoir un objet`
        : "Le premier email de la séquence doit avoir un objet";
    }
  }
  for (const s of steps) {
    if (!isInvite(s) && !s.body?.trim()) return "Chaque étape doit avoir un contenu (la note d'invitation seule est facultative)";
  }
  // Same time as the previous step: one email and one LinkedIn action, in the same path.
  for (let i = 0; i < steps.length; i++) {
    if (!steps[i].with_previous) continue;
    const prev = steps[i - 1];
    if (!prev) return "La première étape ne peut pas partir « en même temps » qu'une étape précédente";
    if (isEmail(prev) === isEmail(steps[i])) return `Étape ${i + 1} : « en même temps » associe un email et une action LinkedIn`;
    if ((prev.branch || null) !== (steps[i].branch || null)) return `Étape ${i + 1} : « en même temps » demande la même branche que l'étape précédente`;
  }
  if (hasBranches) {
    if (steps.some((s) => s.branch && !BRANCHES.includes(s.branch as Branch))) return `branch : valeurs possibles ${BRANCHES.join(", ")}`;
    const invite = steps.findIndex(isInvite);
    const firstBranch = steps.findIndex((s) => s.branch);
    if (invite < 0 || firstBranch < invite) return "Les étapes « si invitation acceptée / non acceptée » viennent après une invitation LinkedIn";
    // The LinkedIn message reveals acceptance: it opens the "accepted" branch, before any "not
    // accepted" step (which has no LinkedIn message).
    const probe = steps.findIndex((s) => s.branch === "accepted");
    const fallback = steps.findIndex((s) => s.branch === "not_accepted");
    if (fallback >= 0 && (probe < 0 || !isMessage(steps[probe]) || probe > fallback)) {
      return "Des étapes « invitation non acceptée » demandent un message LinkedIn en tête du chemin « invitation acceptée » : c'est lui qui détecte l'acceptation";
    }
    if (steps.some((s) => s.branch === "not_accepted" && isMessage(s))) {
      return "Pas de message LinkedIn dans les étapes « si invitation non acceptée »";
    }
  }
  return null;
}

/** Inserts a campaign's steps (email or LinkedIn); the caller deletes the old ones first. */
export function insertSteps(campaignId: number | bigint, steps: StepInput[]): void {
  const insert = db.prepare(
    "INSERT INTO steps (campaign_id, step_number, subject, subject_b, body, wait_days, channel, li_action, branch, with_previous) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  steps.forEach((s, i) => {
    const channel = s.channel === "linkedin" ? "linkedin" : "email";
    const li = channel === "linkedin" ? (s.li_action === "message" ? "message" : "invite") : null;
    const same = i > 0 && !!s.with_previous;
    insert.run(
      campaignId,
      i + 1,
      channel === "linkedin" ? "" : (s.subject ?? ""),
      i === 0 && channel === "email" ? s.subject_b?.trim() || null : null, // A/B test: email step 1 only
      s.body ?? "",
      i === 0 || same ? 0 : (s.wait_days ?? 3),
      channel,
      li,
      BRANCHES.includes(s.branch as Branch) ? s.branch : null,
      same ? 1 : 0
    );
  });
}

/** Replaces a campaign's whole sequence and records who wrote it (and when). */
export function replaceSteps(campaignId: number | bigint, steps: StepInput[], source: StepsSource): void {
  db.prepare("DELETE FROM steps WHERE campaign_id = ?").run(campaignId);
  insertSteps(campaignId, steps);
  db.prepare("UPDATE campaigns SET steps_updated_at = ?, steps_source = ? WHERE id = ?").run(Date.now(), source, campaignId);
}

/** A campaign's steps, in order, as the dashboard and Azerit read them. */
export function campaignStepRows(campaignId: number | bigint): StepRow[] {
  return db
    .prepare(
      "SELECT step_number, subject, subject_b, body, wait_days, channel, li_action, branch, with_previous FROM steps WHERE campaign_id = ? ORDER BY step_number"
    )
    .all(campaignId) as StepRow[];
}
