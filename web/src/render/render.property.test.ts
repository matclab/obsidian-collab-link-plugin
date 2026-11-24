// @vitest-environment jsdom
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, test } from "vitest";
import {
  CALLOUT_FAMILIES,
  CALLOUT_FOLD_ICON,
  calloutIcon,
} from "./callout-icons.js";
import { renderMarkdown } from "./render.js";
import { hostileMarkdown } from "./test-support/hostile-markdown.js";

const ELEMENTS = new Set(
  "p em strong s mark code pre blockquote ul ol li h1 h2 h3 h4 h5 h6 hr br table thead tbody tr th td a img input sup section div span details summary".split(
    " ",
  ),
);
const ATTRIBUTES = new Set(
  "href src alt class id style target rel type aria-disabled tabindex checked data-tex data-source data-callout data-wikilink data-image-source data-attachment referrerpolicy open start title".split(
    " ",
  ),
);
const FORBIDDEN_SCHEMES = new Set<string | undefined>([
  "javascript:",
  "vbscript:",
  "file:",
  "data:",
]);
const EMBEDDED_RASTER = /^data:image\/(png|jpeg|gif|webp);/i;
const BASE = "https://app.example/?doc=d";

/** Whether an image's address may be loaded (ADR-0055 §2, §11), written
 * apart from the module's own check: https, a '/' after the host, no
 * credentials, a public name (a dot, not a number, not a local suffix). */
function loadable(src: string): boolean {
  if (!/^https:\/\/[^/?#\\]+\//i.test(src)) return false;
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return false;
  }
  const host = url.hostname.replace(/\.$/, "");
  return (
    url.href === src &&
    url.username === "" &&
    url.password === "" &&
    host.includes(".") &&
    !host.startsWith("[") &&
    !/^[0-9.]+$/.test(host) &&
    !/(^|\.)(localhost|local|internal|home\.arpa)$/.test(host)
  );
}

/** The callouts' icons, as the browser reads them: the only SVG allowed,
 * each exactly as written (phase 15, decision 6). */
const ICONS = new Set(
  [...CALLOUT_FAMILIES.map(calloutIcon), CALLOUT_FOLD_ICON].map(
    (icon) => new DOMParser().parseFromString(icon, "text/html").body.innerHTML,
  ),
);

/** A link's scheme, as the browser reads it; none for an address it
 * cannot read (`https://e.org%5Cp`), which leads nowhere. */
function protocol(href: string): string | undefined {
  try {
    return new URL(href, BASE).protocol;
  } catch {
    return undefined;
  }
}

/** Why this rendered HTML could run a script or load something an author
 * chose, or undefined if it cannot. */
function hazard(
  html: string,
  granted: (src: string) => boolean,
): string | undefined {
  const body = new DOMParser().parseFromString(html, "text/html").body;
  for (const element of Array.from(body.querySelectorAll("*"))) {
    const name = element.localName;
    const svg = element.closest("svg");
    if (svg) {
      if (!ICONS.has(svg.outerHTML)) return `svg ${svg.outerHTML}`;
      continue;
    }
    if (!ELEMENTS.has(name)) return `element <${name}>`;
    for (const { name: attribute, value } of Array.from(element.attributes)) {
      if (!ATTRIBUTES.has(attribute))
        return `attribute ${attribute} on <${name}>`;
      if (attribute === "data-wikilink" && !/^(note|block)$/.test(value)) {
        return `data-wikilink "${value}"`;
      }
      if (
        attribute === "style" &&
        !/^text-align:(left|right|center)$/.test(value)
      ) {
        return `style "${value}"`;
      }
    }
    if (
      name === "input" &&
      (element.getAttribute("type") !== "checkbox" ||
        element.getAttribute("aria-disabled") !== "true" ||
        element.getAttribute("tabindex") !== "-1")
    ) {
      return "an editable or non-checkbox input";
    }
    const href = element.getAttribute("href");
    if (
      href !== null &&
      FORBIDDEN_SCHEMES.has(protocol(href)) &&
      !EMBEDDED_RASTER.test(href)
    ) {
      return `href ${href}`;
    }
    const src = element.getAttribute("src");
    if (src !== null && !EMBEDDED_RASTER.test(src)) {
      if (name !== "img" || !loadable(src) || !granted(src)) {
        return `src ${src}`;
      }
      if (element.getAttribute("referrerpolicy") !== "no-referrer") {
        return `an image loaded with a referrer: ${src}`;
      }
    }
    // An attached image's slot: an identifier of W-53, or none at all;
    // never a source to load (ADR-0057 §8).
    const attachment = element.getAttribute("data-attachment");
    if (
      attachment !== null &&
      !/^([A-Za-z0-9_-]{21}[AQgw])?$/.test(attachment)
    ) {
      return `data-attachment ${attachment}`;
    }
    const source = element.getAttribute("data-image-source");
    if (source !== null && !loadable(source)) {
      return `data-image-source ${source}`;
    }
  }
  return undefined;
}

describe("renderMarkdown (property)", () => {
  // Found on 2026-11-19 (phase 34h, without relation to it): a highlight
  // (ADR-0044) was missing from the elements the property admits.
  test("a highlight is a harmless element", () => {
    const html = renderMarkdown("==0==", () => false);
    expect(html).toContain("<mark>");
    expect(hazard(html, () => false)).toBeUndefined();
  });

  test("never crashes on arbitrary text", () =>
    hegel.test((tc) => {
      renderMarkdown(tc.draw(gs.text({ maxSize: 200 })));
    }));

  test(
    "renders nothing that runs a script, nor loads what an author chose unless granted",
    () =>
      hegel.test(
        (tc) => {
          const source = hostileMarkdown(tc);
          // Every image granted, none, or some (ADR-0055 §9).
          const grants = tc.draw(gs.sampledFrom(["all", "none", "some"]));
          const granted = (src: string) =>
            grants === "all" || (grants === "some" && src.length % 2 === 0);
          const html = renderMarkdown(source, granted);
          const found = hazard(html, granted);
          if (found) {
            throw new Error(
              `${found}\nsource=${JSON.stringify(source)}\nhtml=${html}`,
            );
          }
        },
        { testCases: 500 },
      ),
    60_000,
  );
});
