/** A date and time for a file's name, local: `2026-10-14 15h02` — no `:`, which
 * some systems refuse in a name. */
export function fileDate(date: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}h${two(date.getMinutes())}`;
}
