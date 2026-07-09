import { describe, expect, it } from "vitest";
import { clip, htmlToText, RESPONSE_CHAR_LIMIT, sectionKind } from "./format.js";

describe("htmlToText", () => {
  it("converts common block elements", () => {
    expect(htmlToText("<h2>Title</h2><p>Body &amp; more</p><ul><li>one</li><li>two</li></ul>")).toBe(
      "## Title\nBody & more\n\n- one\n- two"
    );
  });

  it("decodes numeric entities", () => {
    expect(htmlToText("A&#65;&#x42;")).toBe("AAB");
  });

  it("collapses excessive blank lines", () => {
    expect(htmlToText("<p>a</p><p></p><p>b</p>")).toBe("a\n\nb");
  });

  it("converts <img> to markdown image syntax instead of dropping it", () => {
    expect(htmlToText('<p>See <img src="https://x/y.png" alt="diagram"> here</p>')).toBe(
      "See ![diagram](https://x/y.png) here"
    );
    expect(htmlToText('<img src="a.png">')).toBe("![](a.png)");
    expect(htmlToText("<img>")).toBe("");
  });
});

describe("clip", () => {
  it("returns short text unchanged", () => {
    expect(clip("hello")).toBe("hello");
  });

  it("truncates long text with a note", () => {
    const long = "x".repeat(RESPONSE_CHAR_LIMIT + 100);
    const result = clip(long, "Custom hint.");
    expect(result.length).toBeLessThan(long.length);
    expect(result).toContain("Custom hint.");
  });
});

describe("sectionKind", () => {
  it("extracts the kind from a namespaced resource type", () => {
    expect(sectionKind("Document::Heading")).toBe("Heading");
    expect(sectionKind("Plain")).toBe("Plain");
    expect(sectionKind(null)).toBe("Unknown");
  });
});
