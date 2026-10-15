/**
 * Branches « invitation acceptée / non acceptée » d'une séquence.
 *
 * C'est la première étape « si acceptée » — forcément un message LinkedIn —
 * qui teste l'acceptation : le message ne part qu'une fois la relation établie.
 * Tant que l'état est inconnu, les étapes « si non acceptée » sont passées et
 * le message est retenté ; parti, l'invitation est acceptée. Sans acceptation
 * à l'échéance (délai de la première étape « si non acceptée », compté depuis
 * l'envoi de l'invitation), le contact bascule sur les étapes « si non
 * acceptée ». Un contact sans profil LinkedIn y va directement.
 */
export type Branch = "accepted" | "not_accepted";

export const BRANCHES: Branch[] = ["accepted", "not_accepted"];

export interface BranchStep {
  step_number: number;
  branch: string | null;
}

/**
 * Prochaine étape à jouer après l'étape `after` (étapes triées par numéro),
 * selon l'état de l'invitation : null = pas encore connu, 1 = acceptée, 0 = non.
 */
export function nextStep<T extends BranchStep>(steps: T[], after: number, accepted: number | null): T | undefined {
  const want: Branch = accepted === 0 ? "not_accepted" : "accepted";
  return steps.find((s) => s.step_number > after && (!s.branch || s.branch === want));
}

/** Première étape « si non acceptée » : son délai est l'échéance d'acceptation. */
export function firstNotAccepted<T extends BranchStep>(steps: T[]): T | undefined {
  return steps.find((s) => s.branch === "not_accepted");
}
