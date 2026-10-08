/**
 * Blocs conditionnels d'un template : {{si variable}}…{{sinon}}…{{fin}}.
 *
 * Le premier texte est gardé quand la variable est remplie pour le contact, le
 * second ({{sinon}}, facultatif) quand elle est vide. Une même étape sert ainsi
 * les contacts qui ont la donnée et ceux qui ne l'ont pas, sans phrase trouée :
 *
 *   {{si competences}}Vous cherchez notamment {{competences}}.{{sinon}}Vous recrutez.{{fin}}
 *
 * Pas d'imbrication : un bloc se ferme au premier {{fin}}. Un template sans
 * bloc est rendu tel quel.
 */
const SECTION = /\{\{\s*si\s+([\p{L}\p{N}_]+)\s*\}\}([\s\S]*?)(?:\{\{\s*sinon\s*\}\}([\s\S]*?))?\{\{\s*fin\s*\}\}/giu;

/** Template dont chaque bloc conditionnel est remplacé par le texte retenu pour ces valeurs. */
export function resolveSections(template: string, vars: Record<string, unknown>): string {
  return template.replace(SECTION, (_, key: string, filled: string, empty?: string) =>
    String(vars[key] ?? "").trim() ? filled : (empty ?? "")
  );
}

/**
 * Template sans ses balises de bloc (les deux textes de chaque bloc sont gardés),
 * et variables qui commandent un bloc.
 */
export function splitSections(template: string): { text: string; conditions: string[] } {
  const conditions: string[] = [];
  const text = template.replace(SECTION, (_, key: string, filled: string, empty?: string) => {
    conditions.push(key);
    return `${filled}\n${empty ?? ""}`;
  });
  return { text, conditions };
}
