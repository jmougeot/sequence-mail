/**
 * Instruction of a personalization variable ({{perso}}, {{projet}}…): what it contains, its length,
 * its tone. One per variable name, shared by every campaign and every place that edits it — the
 * dashboard's Variables panel and Azerit's Sequence page show and write the same text.
 */
import { db } from "../db.js";

export const VARIABLE_NAME = /^[\p{L}\p{N}_]+$/u;

/** All instructions, by variable name. */
export function listInstructions(): Record<string, string> {
  const rows = db.prepare("SELECT name, instruction FROM variable_instructions ORDER BY name").all() as Array<{
    name: string;
    instruction: string;
  }>;
  return Object.fromEntries(rows.map((r) => [r.name, r.instruction]));
}

/** Sets one instruction; an empty text removes it. Returns an error message for a bad name. */
export function setInstruction(name: string, instruction: string): string | null {
  if (!VARIABLE_NAME.test(name)) return `"${name}" is not a valid variable name`;
  if (instruction.trim()) {
    db.prepare(
      "INSERT INTO variable_instructions (name, instruction) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET instruction = excluded.instruction"
    ).run(name, instruction.trim());
  } else {
    db.prepare("DELETE FROM variable_instructions WHERE name = ?").run(name);
  }
  return null;
}
