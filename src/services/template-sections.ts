/**
 * Conditional template blocks: {{if variable}}…{{else}}…{{end}}, or the French form
 * {{si variable}}…{{sinon}}…{{fin}} (both accepted).
 *
 * The first text is kept when the variable is filled for the contact, the second ({{else}},
 * optional) when it is empty. So one step serves contacts with and without the data, with no broken
 * sentence:
 *
 *   {{if competences}}Vous cherchez notamment {{competences}}.{{else}}Vous recrutez.{{end}}
 *
 * No nesting: a block closes at the first {{end}}. A template without blocks is rendered as is.
 */
const SECTION =
  /\{\{\s*(?:if|si)\s+([\p{L}\p{N}_]+)\s*\}\}([\s\S]*?)(?:\{\{\s*(?:else|sinon)\s*\}\}([\s\S]*?))?\{\{\s*(?:end|fin)\s*\}\}/giu;

/** Block opening still unclosed once complete blocks are resolved. */
export const UNCLOSED_SECTION = /\{\{\s*(?:if|si)\s/iu;

/** Template with each conditional block replaced by the text chosen for these values. */
export function resolveSections(template: string, vars: Record<string, unknown>): string {
  return template.replace(SECTION, (_, key: string, filled: string, empty?: string) =>
    String(vars[key] ?? "").trim() ? filled : (empty ?? "")
  );
}

/**
 * Template without its block tags (both texts of each block kept), and the variables that drive a
 * block.
 */
export function splitSections(template: string): { text: string; conditions: string[] } {
  const conditions: string[] = [];
  const text = template.replace(SECTION, (_, key: string, filled: string, empty?: string) => {
    conditions.push(key);
    return `${filled}\n${empty ?? ""}`;
  });
  return { text, conditions };
}
