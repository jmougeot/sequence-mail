/**
 * Instruction of a personalization variable ({{perso}}, {{personnalisation}}…): what it contains,
 * its length, its tone. One per (owner, variable name): the dashboard's own set (owner "") and one
 * set per Azerit account (owner "azerit:u:<id>"), each read where the variable is filled — by the
 * agent (MCP) for the dashboard, by Azerit's Sequence page for its accounts.
 */
import { db } from "../db.js";

export const VARIABLE_NAME = /^[\p{L}\p{N}_]+$/u;

/** All of an owner's instructions, by variable name. */
export function listInstructions(owner: string): Record<string, string> {
  const rows = db
    .prepare("SELECT name, instruction FROM variable_instructions WHERE owner_ref = ? ORDER BY name")
    .all(owner) as Array<{ name: string; instruction: string }>;
  return Object.fromEntries(rows.map((r) => [r.name, r.instruction]));
}

/** Sets one instruction; an empty text removes it. Returns an error message for a bad name. */
export function setInstruction(owner: string, name: string, instruction: string): string | null {
  if (!VARIABLE_NAME.test(name)) return `"${name}" is not a valid variable name`;
  if (instruction.trim()) {
    db.prepare(
      "INSERT INTO variable_instructions (owner_ref, name, instruction) VALUES (?, ?, ?) ON CONFLICT(owner_ref, name) DO UPDATE SET instruction = excluded.instruction"
    ).run(owner, name, instruction.trim());
  } else {
    db.prepare("DELETE FROM variable_instructions WHERE owner_ref = ? AND name = ?").run(owner, name);
  }
  return null;
}
