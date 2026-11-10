import { describe, expect, it } from "vitest";
import { parseKey } from "../src/rex/keys.js";

function brief(spec: string) {
  const k = parseKey(spec);
  return { key: k.key, mods: k.mods, text: k.text };
}

describe("parseKey", () => {
  it("parses enter aliases", () => {
    for (const s of ["enter", "Enter", "return", "RETURN", "cr"]) expect(brief(s)).toEqual({ key: "enter", mods: "", text: "" });
  });

  it("fills the fixed fields", () => {
    expect(parseKey("enter")).toEqual({ key: "enter", mods: "", consumed_mods: "", text: "", unshifted_codepoint: 0, composing: false, action: "press" });
  });

  it("parses named keys", () => {
    expect(brief("esc").key).toBe("escape");
    expect(brief("escape").key).toBe("escape");
    expect(brief("tab").key).toBe("tab");
    expect(brief("backspace").key).toBe("backspace");
    expect(brief("del").key).toBe("delete");
    expect(brief("home").key).toBe("home");
    expect(brief("pageup").key).toBe("page_up");
    expect(brief("pgdn").key).toBe("page_down");
  });

  it("parses arrows", () => {
    expect(brief("up").key).toBe("arrow_up");
    expect(brief("down").key).toBe("arrow_down");
    expect(brief("left").key).toBe("arrow_left");
    expect(brief("right").key).toBe("arrow_right");
  });

  it("parses function keys", () => {
    expect(brief("f5").key).toBe("f5");
    expect(brief("F12").key).toBe("f12");
    expect(brief("f25").key).toBe("f25");
    expect(() => parseKey("f26")).toThrow(/unknown key/);
    expect(() => parseKey("f0")).toThrow(/unknown key/);
  });

  it("parses shift+tab", () => {
    expect(brief("shift+tab")).toEqual({ key: "tab", mods: "shift", text: "" });
  });

  it("parses ctrl combinations in three spellings", () => {
    for (const s of ["ctrl+c", "ctrl-c", "C-c", "Ctrl+c", "control+c"]) {
      const k = parseKey(s);
      expect(k.key).toBe("key_c");
      expect(k.mods).toBe("ctrl");
      expect(k.text).toBe("");
      expect(k.unshifted_codepoint).toBe(99);
    }
  });

  it("orders modifiers as shift, ctrl, alt, super", () => {
    expect(parseKey("alt+ctrl+shift+x").mods).toBe("shift+ctrl+alt");
    expect(parseKey("cmd+k").mods).toBe("super");
    expect(parseKey("option+x").mods).toBe("alt");
    expect(parseKey("meta+x").mods).toBe("alt");
  });

  it("parses single letters with text", () => {
    const k = parseKey("y");
    expect(k).toMatchObject({ key: "key_y", mods: "", text: "y", consumed_mods: "", unshifted_codepoint: 121 });
  });

  it("treats an uppercase letter as shift plus text", () => {
    expect(parseKey("A")).toMatchObject({ key: "key_a", mods: "shift", text: "A", consumed_mods: "shift", unshifted_codepoint: 97 });
  });

  it("parses digits", () => {
    expect(parseKey("1")).toMatchObject({ key: "digit_1", mods: "", text: "1", unshifted_codepoint: 49 });
  });

  it("parses shifted digits as shift plus the digit key", () => {
    expect(parseKey("!")).toMatchObject({ key: "digit_1", mods: "shift", text: "!", consumed_mods: "shift" });
  });

  it("parses punctuation", () => {
    expect(parseKey("-")).toMatchObject({ key: "minus", mods: "", text: "-" });
    expect(parseKey("/")).toMatchObject({ key: "slash", mods: "", text: "/" });
    expect(parseKey(".")).toMatchObject({ key: "period", text: "." });
  });

  it("parses ? as shift plus slash", () => {
    expect(parseKey("?")).toMatchObject({ key: "slash", mods: "shift", text: "?", consumed_mods: "shift", unshifted_codepoint: 47 });
  });

  it("parses + as shift plus equal", () => {
    expect(parseKey("+")).toMatchObject({ key: "equal", mods: "shift", text: "+" });
  });

  it("parses ctrl++", () => {
    expect(parseKey("ctrl++")).toMatchObject({ key: "equal", mods: "shift+ctrl", text: "" });
  });

  it("parses ctrl+-", () => {
    expect(parseKey("ctrl+-")).toMatchObject({ key: "minus", mods: "ctrl", text: "" });
    expect(parseKey("ctrl--")).toMatchObject({ key: "minus", mods: "ctrl", text: "" });
  });

  it("parses space", () => {
    expect(parseKey("space")).toMatchObject({ key: "space", mods: "", text: " ", unshifted_codepoint: 32 });
    expect(parseKey("ctrl+space")).toMatchObject({ key: "space", mods: "ctrl", text: "", unshifted_codepoint: 32 });
    expect(parseKey("shift+space").text).toBe(" ");
  });

  it("trims surrounding whitespace", () => {
    expect(parseKey("  enter  ").key).toBe("enter");
  });

  it("rejects empty input", () => {
    expect(() => parseKey("")).toThrow("empty key");
    expect(() => parseKey("   ")).toThrow("empty key");
  });

  it("rejects unknown keys", () => {
    expect(() => parseKey("banana")).toThrow(/unknown key "banana"/);
    expect(() => parseKey("ctrl+banana")).toThrow(/unknown key "banana"/);
  });

  it("rejects unknown modifiers", () => {
    expect(() => parseKey("hyper+a")).toThrow(/unknown modifier "hyper"/);
    expect(() => parseKey("ctrl+hyper+a")).toThrow(/unknown modifier "hyper"/);
  });

  it("rejects non-ASCII single characters", () => {
    expect(() => parseKey("é")).toThrow(/unsupported key/);
  });

  it("rejects a trailing separator", () => {
    expect(() => parseKey("ctrl+")).toThrow(/unknown key/);
  });

  it("rejects prototype property names", () => {
    for (const s of ["constructor", "toString", "__proto__", "hasOwnProperty", "toString+a", "constructor+a", "ctrl+constructor", "ctrl+__proto__"]) {
      expect(() => parseKey(s), s).toThrow(/unknown (key|modifier)/);
    }
  });
});
