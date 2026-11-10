export interface KeyBody {
  key: string;
  mods: string;
  consumed_mods: string;
  text: string;
  unshifted_codepoint: number;
  composing: boolean;
  action: "press" | "release";
}

const NAMED: Record<string, string> = {
  enter: "enter",
  return: "enter",
  cr: "enter",
  tab: "tab",
  space: "space",
  backspace: "backspace",
  bs: "backspace",
  delete: "delete",
  del: "delete",
  insert: "insert",
  ins: "insert",
  home: "home",
  end: "end",
  pageup: "page_up",
  pgup: "page_up",
  pagedown: "page_down",
  pgdn: "page_down",
  up: "arrow_up",
  down: "arrow_down",
  left: "arrow_left",
  right: "arrow_right",
  escape: "escape",
  esc: "escape",
};

const PUNCT: Record<string, string> = {
  "-": "minus",
  "=": "equal",
  "[": "bracket_left",
  "]": "bracket_right",
  "\\": "backslash",
  ";": "semicolon",
  "'": "quote",
  ",": "comma",
  ".": "period",
  "/": "slash",
  "`": "backquote",
};

const SHIFTED: Record<string, string> = {
  "!": "1",
  "@": "2",
  "#": "3",
  $: "4",
  "%": "5",
  "^": "6",
  "&": "7",
  "*": "8",
  "(": "9",
  ")": "0",
  _: "-",
  "+": "=",
  "{": "[",
  "}": "]",
  "|": "\\",
  ":": ";",
  '"': "'",
  "<": ",",
  ">": ".",
  "?": "/",
  "~": "`",
};

const MOD_ALIASES: Record<string, string> = {
  ctrl: "ctrl",
  control: "ctrl",
  c: "ctrl",
  shift: "shift",
  s: "shift",
  alt: "alt",
  option: "alt",
  opt: "alt",
  meta: "alt",
  m: "alt",
  super: "super",
  cmd: "super",
  win: "super",
};

const MOD_ORDER = ["shift", "ctrl", "alt", "super"];

export function parseKey(spec: string): KeyBody {
  const raw = spec.trim();
  if (!raw) throw new Error("empty key");
  const parts = raw.length > 1 ? splitKeySpec(raw) : [raw];
  const keyPart = parts.pop()!;
  const own = <T>(table: Record<string, T>, k: string): T | undefined => (Object.hasOwn(table, k) ? table[k] : undefined);
  const mods = new Set<string>();
  for (const p of parts) {
    const m = own(MOD_ALIASES, p.toLowerCase());
    if (!m) throw new Error(`unknown modifier "${p}" in key "${spec}"`);
    mods.add(m);
  }

  let key: string;
  let cp = 0;
  let text = "";
  const lower = keyPart.toLowerCase();
  const fn = /^f([1-9]|1[0-9]|2[0-5])$/.exec(lower);
  const named = keyPart.length > 1 ? own(NAMED, lower) : undefined;
  if (named) {
    key = named;
    if (key === "space") {
      cp = 0x20;
      if (mods.size === 0 || (mods.size === 1 && mods.has("shift"))) text = " ";
    }
  } else if (keyPart.length > 1 && fn) {
    key = `f${fn[1]}`;
  } else if ([...keyPart].length === 1) {
    let ch = keyPart;
    const unshifted = own(SHIFTED, ch);
    if (unshifted) {
      ch = unshifted;
      mods.add("shift");
    } else if (/^[A-Z]$/.test(ch) && mods.size === 0) {
      mods.add("shift");
    }
    const base = ch.toLowerCase();
    if (/^[a-z]$/.test(base)) key = `key_${base}`;
    else if (/^[0-9]$/.test(base)) key = `digit_${base}`;
    else if (own(PUNCT, base)) key = PUNCT[base]!;
    else if (base === " ") key = "space";
    else throw new Error(`unsupported key "${keyPart}"; send it as text instead`);
    cp = base.codePointAt(0)!;
    if (!mods.has("ctrl") && !mods.has("alt") && !mods.has("super")) text = keyPart === ch ? (mods.has("shift") ? shiftChar(base) : base) : keyPart;
  } else {
    throw new Error(`unknown key "${keyPart}" in "${spec}"`);
  }

  const modStr = MOD_ORDER.filter((m) => mods.has(m)).join("+");
  return {
    key,
    mods: modStr,
    consumed_mods: text && mods.has("shift") ? "shift" : "",
    text,
    unshifted_codepoint: cp,
    composing: false,
    action: "press",
  };
}

function splitKeySpec(s: string): string[] {
  if (s.endsWith("++")) return [...s.slice(0, -2).split("+").filter(Boolean), "+"];
  return s.split(/[+-](?=.)/).filter((p, i, a) => p !== "" || i === a.length - 1);
}

function shiftChar(base: string): string {
  if (/^[a-z]$/.test(base)) return base.toUpperCase();
  for (const [shifted, plain] of Object.entries(SHIFTED)) if (plain === base) return shifted;
  return base;
}
