import { describe, expect, it } from "vitest";
import { parseRecord } from "../../src/processing/parser.js";

describe("parseRecord", () => {
  it("returns err with ParseError for empty string", () => {
    const result = parseRecord("");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected err");
    expect(result.error.kind).toBe("ParseError");
    expect(result.error.message).toMatch(/empty|whitespace/i);
    expect(result.error).not.toHaveProperty("cause");
  });

  it("returns err with ParseError for whitespace-only input", () => {
    const result = parseRecord("   \n\t  ");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected err");
    expect(result.error.kind).toBe("ParseError");
    expect(result.error.message).toMatch(/empty|whitespace/i);
  });

  it("returns ok with parsed object for valid JSON object string", () => {
    const payload = { droneId: "drone-x", n: 1 };
    const result = parseRecord(JSON.stringify(payload));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value).toEqual(payload);
  });

  it("returns err with invalid JSON message and cause for malformed JSON", () => {
    const result = parseRecord("{ not json");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected err");
    expect(result.error.kind).toBe("ParseError");
    expect(result.error.message).toBe("invalid JSON");
    expect(result.error.cause).toBeDefined();
  });
});
