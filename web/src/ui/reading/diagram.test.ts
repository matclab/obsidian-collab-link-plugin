// @vitest-environment jsdom
import { render } from "pele";
import { describe, expect, test } from "vitest";
import { DIAGRAM_OPTIONS, checkedDiagram } from "./diagram.js";

const svg = (inner: string, attributes = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" class="pele"${attributes}>${inner}</svg>`;

describe("checkedDiagram (ADR-0042, decision 4)", () => {
  test("gives back the diagram Pele draws, as an element", () => {
    const { svg } = render(
      "flowchart LR\n  A[One] --> B{Two}",
      DIAGRAM_OPTIONS,
    );
    const element = checkedDiagram(svg, document);
    expect(element.localName).toBe("svg");
    expect(element.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(element.textContent).toContain("One");
  });

  test("keeps the author's text where it is only text", () => {
    const element = checkedDiagram(
      svg('<path data-id="javascript:alert(1) url(x)" class="url(x)"/>'),
      document,
    );
    expect(element.querySelector("path")).not.toBeNull();
  });

  test.each([
    ["a script", svg("<script>alert(1)</script>")],
    ["a style sheet", svg("<style>*{background:red}</style>")],
    ["foreign content", svg("<foreignObject><div>x</div></foreignObject>")],
    ["a link", svg('<a href="https://example.com"><text>x</text></a>')],
    ["an image", svg('<image href="https://example.com/i.png"/>')],
    [
      "a use of an outside file",
      svg('<use href="https://example.com/s.svg#a"/>'),
    ],
    ["an animation", svg('<animate attributeName="x" to="1"/>')],
    ["an event handler", svg("<rect/>", ' onload="alert(1)"')],
    ["an event handler, upper case", svg('<rect ONCLICK="alert(1)"/>')],
    ["a reference by xlink", svg('<g xlink:href="#a"/>')],
    ["an outside url in a style", svg('<rect style="fill:url(https://x/y)"/>')],
    ["an outside url in a paint", svg('<rect fill="url(//x/y)"/>')],
    ["an outside url in a filter", svg('<g filter="url(https://x/f)"/>')],
    [
      "an image set in a style",
      svg("<g style=\"fill:image-set('https://x/i' 1x)\"/>"),
    ],
    [
      "a url spelled with an escape",
      svg('<g style="fill:u\\72l(https://x/i)"/>'),
    ],
    ["a url after a space", svg('<g style="fill: url (https://x/i)"/>')],
    ["no svg at all", "<div>x</div>"],
    ["two roots", `${svg("")}${svg("")}`],
    ["text around the svg", `x${svg("")}`],
  ])("refuses %s", (_, markup) => {
    expect(() => checkedDiagram(markup, document)).toThrow();
  });
});
