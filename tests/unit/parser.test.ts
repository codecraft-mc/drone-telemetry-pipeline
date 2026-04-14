import { describe, expect, it } from "vitest";
import { parseRecord } from "../../src/processing/parser.js";

describe("parseRecord", () => {
  describe("valid JSON", () => {
    it("returns ok with parsed object for valid JSON object string", () => {
      const payload = { droneId: "drone-x", n: 1 };
      const result = parseRecord(JSON.stringify(payload));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.value).toEqual(payload);
    });

    it("parses a JSON array", () => {
      const result = parseRecord("[1,2,3]");
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.value).toEqual([1, 2, 3]);
    });

    it("parses a JSON string literal", () => {
      const result = parseRecord('"hello"');
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.value).toBe("hello");
    });

    it("parses JSON null", () => {
      const result = parseRecord("null");
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.value).toBeNull();
    });

    it("parses JSON with leading/trailing whitespace", () => {
      const result = parseRecord('  { "x": 1 }  ');
      expect(result.ok).toBe(true);
    });
  });

  describe("invalid input", () => {
    it("returns ParseError for empty string (no cause attached)", () => {
      const result = parseRecord("");
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected err");
      expect(result.error.kind).toBe("ParseError");
      expect(result.error.message).toMatch(/empty|whitespace/i);
      expect(result.error).not.toHaveProperty("cause");
    });

    it("returns ParseError for whitespace-only input", () => {
      const result = parseRecord("   \n\t  ");
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected err");
      expect(result.error.kind).toBe("ParseError");
      expect(result.error.message).toMatch(/empty|whitespace/i);
    });

    it("returns err with invalid JSON message and cause for malformed JSON", () => {
      const result = parseRecord("{ not json");
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected err");
      expect(result.error.kind).toBe("ParseError");
      expect(result.error.message).toBe("invalid JSON");
      expect(result.error.cause).toBeDefined();
    });

    it("returns ParseError for truncated JSON", () => {
      const result = parseRecord('{"key": ');
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected err");
      expect(result.error.kind).toBe("ParseError");
      expect(result.error.cause).toBeDefined();
    });
  });
});
