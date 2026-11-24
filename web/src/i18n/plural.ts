/** Picks a word's form for a count, by the language's own rules
 * (`Intl.PluralRules`: in French, 0 and 1 take the singular). */
export type Plural = (
  count: number,
  forms: { one: string; other: string },
) => string;

export function pluralFor(language: string): Plural {
  const rules = new Intl.PluralRules(language);
  return (count, forms) =>
    rules.select(count) === "one" ? forms.one : forms.other;
}
