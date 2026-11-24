/** The file picker of « Image » (ADR-0057 §8): opened in the user's
 * gesture — a browser refuses it later —, the formats the page shows
 * offered first; resolves with what was chosen, nothing if cancelled. */
const ACCEPTED =
  "image/png,image/jpeg,image/gif,image/webp,image/avif,image/svg+xml,.svg";

export function chooseImages(document: Document): Promise<File[]> {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ACCEPTED;
  input.multiple = true;
  return new Promise((resolve) => {
    input.addEventListener("change", () =>
      resolve(Array.from(input.files ?? [])),
    );
    input.addEventListener("cancel", () => resolve([]));
    input.click();
  });
}
