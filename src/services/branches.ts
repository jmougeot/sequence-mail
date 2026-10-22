/**
 * "Invitation accepted / not accepted" branches of a sequence.
 * The first "if accepted" step — necessarily a LinkedIn message — tests acceptance: the message
 * only goes out once connected. While the state is unknown, "if not accepted" steps are skipped and
 * the message is retried; once it is sent, the invitation is accepted. Without acceptance by the
 * deadline (delay of the first "if not accepted" step, counted from the invitation), the contact
 * switches to the "if not accepted" steps. A contact without a LinkedIn profile goes there
 * directly.
 */
export type Branch = "accepted" | "not_accepted";

export const BRANCHES: Branch[] = ["accepted", "not_accepted"];

export interface BranchStep {
  step_number: number;
  branch: string | null;
}

/**
 * Next step to play after step `after` (steps sorted by number), given the invitation state: null =
 * unknown yet, 1 = accepted, 0 = not.
 */
export function nextStep<T extends BranchStep>(steps: T[], after: number, accepted: number | null): T | undefined {
  const want: Branch = accepted === 0 ? "not_accepted" : "accepted";
  return steps.find((s) => s.step_number > after && (!s.branch || s.branch === want));
}

/**
 * First "if accepted" step when it is a LinkedIn message: queued right after the invite, its own
 * delay ignored, it goes as soon as the invite is accepted (see ACCEPT_CHECK_MS in outreach.ts).
 */
export function firstAccepted<T extends BranchStep & { channel: string | null }>(steps: T[]): T | undefined {
  const s = steps.find((x) => x.branch === "accepted");
  return s?.channel === "linkedin" ? s : undefined;
}

/** First "if not accepted" step: its delay is the acceptance deadline. */
export function firstNotAccepted<T extends BranchStep>(steps: T[]): T | undefined {
  return steps.find((s) => s.branch === "not_accepted");
}

/**
 * Step this contact can't receive (email without address, LinkedIn without profile): it will be
 * skipped.
 */
export function unreachable(
  step: { channel: string | null },
  contact: { email: string | null; linkedin: string | null }
): boolean {
  return step.channel === "linkedin" ? !contact.linkedin : !contact.email;
}
