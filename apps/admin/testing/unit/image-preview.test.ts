import { describe, expect, it } from "vitest";
import { previewSrc } from "@/lib/image-preview";

describe("previewSrc", () => {
  it("previews an https link as typed", () => {
    expect(previewSrc("  https://cdn.example.com/covers/book.jpg  ")).toBe("https://cdn.example.com/covers/book.jpg");
  });

  it("encodes characters that shouldn't sit raw in an attribute", () => {
    expect(previewSrc('https://cdn.example.com/my cover"<x>.jpg')).toBe(
      "https://cdn.example.com/my%20cover%22%3Cx%3E.jpg"
    );
  });

  it("keeps escapes the link already had, rather than double-encoding them", () => {
    expect(previewSrc("https://cdn.example.com/a%20b%2Fc.jpg?v=1&w=200")).toBe(
      "https://cdn.example.com/a%20b%2Fc.jpg?v=1&w=200"
    );
  });

  it.each(["", "http://cdn.example.com/a.jpg", "javascript:alert(1)", "data:image/png;base64,AAAA", "https://", "//cdn.example.com/a.jpg"])(
    "refuses %j",
    (value) => expect(previewSrc(value)).toBeNull()
  );

  it("refuses a link encodeURI can't encode", () => {
    expect(previewSrc("https://cdn.example.com/\uD800.jpg")).toBeNull();
  });
});
