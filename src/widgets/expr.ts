/**
 * The expression language of chat-assistant figures.
 *
 * Figures arrive as Svelte/JSX-flavoured templates whose holes hold small
 * JavaScript expressions: `{132+i*51}`, `` {`M${b.x+54} 106`} ``,
 * `{(100/retention).toFixed(1)}`. Nothing from a document is ever handed to the
 * JavaScript engine. This module parses that subset itself and evaluates it over
 * plain data: numbers, strings, booleans, null, arrays and prototype-free
 * objects. Functions do not exist as values except a fixed list of pure
 * formatting and arithmetic helpers, and the inert setter a `useState`
 * declaration yields. Every evaluation runs against a step budget so a
 * pathological figure fails quickly instead of freezing the preview.
 */

export class WidgetError extends Error {
  /** 1-based line inside the fence, when known. */
  line: number | undefined;
  constructor(message: string, line?: number) {
    super(message);
    this.line = line;
  }
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** What a `useState` setter evaluates to: a marker that does nothing. */
export interface Setter {
  readonly kind: "setter";
  readonly name: string;
}

/** What an arrow function evaluates to; figures are static, so it is inert. */
export interface Handler {
  readonly kind: "handler";
}

export type Value =
  | number
  | string
  | boolean
  | null
  | undefined
  | Value[]
  | { [key: string]: Value }
  | Setter
  | Handler;

export function isSetter(value: Value): value is Setter {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === SETTER_PROTO
  );
}

export function isHandler(value: Value): value is Handler {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === HANDLER_PROTO
  );
}

const SETTER_PROTO = Object.freeze(Object.create(null));
const HANDLER_PROTO = Object.freeze(Object.create(null));

export function makeSetter(name: string): Setter {
  const setter = Object.create(SETTER_PROTO) as { kind: "setter"; name: string };
  setter.kind = "setter";
  setter.name = name;
  return Object.freeze(setter);
}

const HANDLER: Handler = Object.freeze(
  Object.assign(Object.create(HANDLER_PROTO) as object, { kind: "handler" as const }),
);

/** A plain data object, as opposed to a marker or an array. */
function isRecord(value: Value): value is { [key: string]: Value } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === null
  );
}

// Property names that reach an engine prototype in real JavaScript. Data objects
// here have no prototype, but the names are still refused so a figure reads the
// same everywhere and a future change cannot reopen the door.
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

type Token =
  | { t: "num"; v: number; at: number }
  | { t: "str"; v: string; at: number }
  | { t: "tpl"; parts: (string | Expr)[]; at: number }
  | { t: "id"; v: string; at: number }
  | { t: "op"; v: string; at: number }
  | { t: "eof"; at: number };

const OPERATORS = [
  "===",
  "!==",
  "...",
  "=>",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "??",
  "?.",
  "**",
  "+",
  "-",
  "*",
  "/",
  "%",
  "<",
  ">",
  "!",
  "?",
  ":",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  ",",
  ".",
  "=",
];

const MAX_SOURCE = 20_000;

function tokenize(src: string): Token[] {
  if (src.length > MAX_SOURCE) throw new WidgetError("expression is too long");
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end < 0) throw new WidgetError("unterminated comment");
      i = end + 2;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^(?:0[xX][0-9a-fA-F]+|(?:\d[\d_]*)?\.?\d*(?:[eE][+-]?\d+)?)/.exec(src.slice(i));
      const text = m ? m[0] : c;
      const v = Number(text.replace(/_/g, ""));
      if (!Number.isFinite(v)) throw new WidgetError(`bad number ${text}`);
      tokens.push({ t: "num", v, at: i });
      i += text.length;
      continue;
    }
    if (c === '"' || c === "'") {
      const { value, end } = readString(src, i);
      tokens.push({ t: "str", v: value, at: i });
      i = end;
      continue;
    }
    if (c === "`") {
      const { parts, end } = readTemplate(src, i);
      tokens.push({ t: "tpl", parts, at: i });
      i = end;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[\w$]/.test(src[j])) j += 1;
      tokens.push({ t: "id", v: src.slice(i, j), at: i });
      i = j;
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (!op) throw new WidgetError(`unexpected character ${JSON.stringify(c)}`);
    // `?.5` is a ternary with a fraction, not optional chaining.
    if (op === "?." && /[0-9]/.test(src[i + 2] ?? "")) {
      tokens.push({ t: "op", v: "?", at: i });
      i += 1;
      continue;
    }
    tokens.push({ t: "op", v: op, at: i });
    i += op.length;
  }
  tokens.push({ t: "eof", at: src.length });
  return tokens;
}

const ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  b: "\b",
  f: "\f",
  v: "\v",
  "0": "\0",
};

function readEscape(src: string, i: number): { text: string; end: number } {
  const e = src[i + 1];
  if (e === undefined) throw new WidgetError("unterminated string");
  if (e in ESCAPES) return { text: ESCAPES[e], end: i + 2 };
  if (e === "u") {
    const braced = /^\{([0-9a-fA-F]{1,6})\}/.exec(src.slice(i + 2));
    if (braced) {
      const code = parseInt(braced[1], 16);
      if (code > 0x10ffff) throw new WidgetError("bad unicode escape");
      return { text: String.fromCodePoint(code), end: i + 2 + braced[0].length };
    }
    const hex = /^[0-9a-fA-F]{4}/.exec(src.slice(i + 2));
    if (!hex) throw new WidgetError("bad unicode escape");
    return { text: String.fromCharCode(parseInt(hex[0], 16)), end: i + 6 };
  }
  if (e === "x") {
    const hex = /^[0-9a-fA-F]{2}/.exec(src.slice(i + 2));
    if (!hex) throw new WidgetError("bad hex escape");
    return { text: String.fromCharCode(parseInt(hex[0], 16)), end: i + 4 };
  }
  if (e === "\n") return { text: "", end: i + 2 };
  return { text: e, end: i + 2 };
}

function readString(src: string, start: number): { value: string; end: number } {
  const quote = src[start];
  let out = "";
  let i = start + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === quote) return { value: out, end: i + 1 };
    if (c === "\n") break;
    if (c === "\\") {
      const esc = readEscape(src, i);
      out += esc.text;
      i = esc.end;
      continue;
    }
    out += c;
    i += 1;
  }
  throw new WidgetError("unterminated string");
}

function readTemplate(src: string, start: number): { parts: (string | Expr)[]; end: number } {
  const parts: (string | Expr)[] = [];
  let text = "";
  let i = start + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === "`") {
      if (text) parts.push(text);
      return { parts, end: i + 1 };
    }
    if (c === "\\") {
      const esc = readEscape(src, i);
      text += esc.text;
      i = esc.end;
      continue;
    }
    if (c === "$" && src[i + 1] === "{") {
      if (text) parts.push(text);
      text = "";
      const close = findClosingBrace(src, i + 1);
      parts.push(parseExpression(src.slice(i + 2, close)));
      i = close + 1;
      continue;
    }
    text += c;
    i += 1;
  }
  throw new WidgetError("unterminated template literal");
}

/**
 * Index of the `}` matching the `{` at `open`, skipping strings, template
 * literals (and their own `${…}` holes) and comments. Shared with the template
 * parser, which must find where `{expr}` ends without understanding it.
 */
export function findClosingBrace(src: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") {
      i = readString(src, i).end;
      continue;
    }
    if (c === "`") {
      i = skipTemplate(src, i);
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl < 0 ? src.length : nl;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end < 0) break;
      i = end + 2;
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  throw new WidgetError("unbalanced braces");
}

function skipTemplate(src: string, start: number): number {
  let i = start + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "`") return i + 1;
    if (c === "$" && src[i + 1] === "{") {
      i = findClosingBrace(src, i + 1) + 1;
      continue;
    }
    i += 1;
  }
  throw new WidgetError("unterminated template literal");
}

// ---------------------------------------------------------------------------
// Syntax tree
// ---------------------------------------------------------------------------

export type Expr =
  | { k: "lit"; v: Value }
  | { k: "tpl"; parts: (string | Expr)[] }
  | { k: "id"; name: string }
  | { k: "arr"; items: Expr[] }
  | { k: "obj"; props: [string, Expr][] }
  | { k: "member"; obj: Expr; prop: Expr; computed: boolean; optional: boolean }
  | { k: "call"; callee: Expr; args: Expr[]; optional: boolean }
  | { k: "unary"; op: string; arg: Expr }
  | { k: "bin"; op: string; left: Expr; right: Expr }
  | { k: "cond"; test: Expr; then: Expr; else: Expr }
  | { k: "arrow"; params: string[]; body: Expr };

const MAX_NODES = 5_000;

class Parser {
  private tokens: Token[];
  private pos = 0;
  private nodes = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  isOp(v: string): boolean {
    const t = this.peek();
    return t.t === "op" && t.v === v;
  }

  isId(v: string): boolean {
    const t = this.peek();
    return t.t === "id" && t.v === v;
  }

  eatOp(v: string): boolean {
    if (!this.isOp(v)) return false;
    this.pos += 1;
    return true;
  }

  expectOp(v: string): void {
    if (!this.eatOp(v)) throw new WidgetError(`expected "${v}" ${this.where()}`);
  }

  expectId(): string {
    const t = this.next();
    if (t.t !== "id") throw new WidgetError(`expected a name ${this.where(t)}`);
    return t.v;
  }

  where(t = this.peek()): string {
    if (t.t === "eof") return "at end of expression";
    const shown = t.t === "num" ? String(t.v) : t.t === "op" || t.t === "id" ? t.v : t.t;
    return `near "${shown}"`;
  }

  private node<T extends Expr>(n: T): T {
    this.nodes += 1;
    if (this.nodes > MAX_NODES) throw new WidgetError("expression is too large");
    return n;
  }

  expression(): Expr {
    return this.arrowOrConditional();
  }

  private arrowOrConditional(): Expr {
    const params = this.tryArrowParams();
    if (params) {
      const body = this.isOp("{")
        ? this.fail("arrow functions with a block body")
        : this.expression();
      return this.node({ k: "arrow", params, body });
    }
    return this.conditional();
  }

  private fail(what: string): never {
    throw new WidgetError(`${what} are not supported`);
  }

  /** `x =>` or `(a, b) =>`; restores the position when it is not an arrow. */
  private tryArrowParams(): string[] | null {
    const start = this.pos;
    const t = this.peek();
    if (t.t === "id" && this.tokens[this.pos + 1]?.t === "op") {
      const after = this.tokens[this.pos + 1] as { v: string };
      if (after.v === "=>") {
        this.pos += 2;
        return [t.v];
      }
    }
    if (this.isOp("(")) {
      this.pos += 1;
      const params: string[] = [];
      while (!this.isOp(")")) {
        const p = this.peek();
        if (p.t !== "id") {
          this.pos = start;
          return null;
        }
        params.push(p.v);
        this.pos += 1;
        if (!this.eatOp(",")) break;
      }
      if (this.eatOp(")") && this.eatOp("=>")) return params;
      this.pos = start;
    }
    return null;
  }

  private conditional(): Expr {
    const test = this.binary(0);
    if (!this.eatOp("?")) return test;
    const then = this.expression();
    this.expectOp(":");
    const otherwise = this.expression();
    return this.node({ k: "cond", test, then, else: otherwise });
  }

  private static PRECEDENCE: Record<string, number> = {
    "??": 1,
    "||": 2,
    "&&": 3,
    "==": 4,
    "!=": 4,
    "===": 4,
    "!==": 4,
    "<": 5,
    ">": 5,
    "<=": 5,
    ">=": 5,
    "+": 6,
    "-": 6,
    "*": 7,
    "/": 7,
    "%": 7,
    "**": 8,
  };

  private binary(min: number): Expr {
    let left = this.unary();
    for (;;) {
      const t = this.peek();
      if (t.t !== "op") break;
      const prec = Parser.PRECEDENCE[t.v];
      if (prec === undefined || prec <= min) break;
      this.pos += 1;
      // `**` is right-associative; everything else here is left-associative.
      const right = this.binary(t.v === "**" ? prec - 1 : prec);
      left = this.node({ k: "bin", op: t.v, left, right });
    }
    return left;
  }

  private unary(): Expr {
    const t = this.peek();
    if (t.t === "op" && (t.v === "!" || t.v === "-" || t.v === "+")) {
      this.pos += 1;
      return this.node({ k: "unary", op: t.v, arg: this.unary() });
    }
    if (t.t === "id" && (t.v === "typeof" || t.v === "void" || t.v === "delete" || t.v === "new")) {
      throw new WidgetError(`"${t.v}" is not supported`);
    }
    return this.postfix(this.primary());
  }

  private postfix(expr: Expr): Expr {
    for (;;) {
      if (this.eatOp(".")) {
        expr = this.node({
          k: "member",
          obj: expr,
          prop: { k: "lit", v: this.expectId() },
          computed: false,
          optional: false,
        });
      } else if (this.eatOp("?.")) {
        if (this.eatOp("[")) {
          const prop = this.expression();
          this.expectOp("]");
          expr = this.node({ k: "member", obj: expr, prop, computed: true, optional: true });
        } else if (this.isOp("(")) {
          expr = this.node({ k: "call", callee: expr, args: this.args(), optional: true });
        } else {
          const name = this.expectId();
          expr = this.node({
            k: "member",
            obj: expr,
            prop: { k: "lit", v: name },
            computed: false,
            optional: true,
          });
        }
      } else if (this.eatOp("[")) {
        const prop = this.expression();
        this.expectOp("]");
        expr = this.node({ k: "member", obj: expr, prop, computed: true, optional: false });
      } else if (this.isOp("(")) {
        expr = this.node({ k: "call", callee: expr, args: this.args(), optional: false });
      } else {
        return expr;
      }
    }
  }

  private args(): Expr[] {
    this.expectOp("(");
    const args: Expr[] = [];
    while (!this.isOp(")")) {
      if (this.isOp("...")) this.fail("spread arguments");
      args.push(this.expression());
      if (!this.eatOp(",")) break;
    }
    this.expectOp(")");
    return args;
  }

  private primary(): Expr {
    const t = this.next();
    switch (t.t) {
      case "num":
        return this.node({ k: "lit", v: t.v });
      case "str":
        return this.node({ k: "lit", v: t.v });
      case "tpl":
        return this.node({ k: "tpl", parts: t.parts });
      case "id":
        if (t.v === "true") return this.node({ k: "lit", v: true });
        if (t.v === "false") return this.node({ k: "lit", v: false });
        if (t.v === "null") return this.node({ k: "lit", v: null });
        if (t.v === "undefined") return this.node({ k: "lit", v: undefined });
        if (FORBIDDEN_KEYS.has(t.v) || t.v === "this" || t.v === "function" || t.v === "class") {
          throw new WidgetError(`"${t.v}" is not supported`);
        }
        return this.node({ k: "id", name: t.v });
      case "op":
        if (t.v === "(") {
          const inner = this.expression();
          this.expectOp(")");
          return inner;
        }
        if (t.v === "[") return this.arrayLiteral();
        if (t.v === "{") return this.objectLiteral();
        break;
      default:
        break;
    }
    this.pos -= 1;
    throw new WidgetError(`unexpected ${this.where()}`);
  }

  private arrayLiteral(): Expr {
    const items: Expr[] = [];
    while (!this.isOp("]")) {
      if (this.isOp("...")) this.fail("spread elements");
      items.push(this.expression());
      if (!this.eatOp(",")) break;
    }
    this.expectOp("]");
    return this.node({ k: "arr", items });
  }

  private objectLiteral(): Expr {
    const props: [string, Expr][] = [];
    while (!this.isOp("}")) {
      if (this.isOp("...")) this.fail("spread properties");
      if (this.isOp("[")) this.fail("computed property names");
      const t = this.next();
      let key: string;
      if (t.t === "id" || t.t === "str") key = t.v;
      else if (t.t === "num") key = String(t.v);
      else throw new WidgetError(`expected a property name ${this.where(t)}`);
      if (FORBIDDEN_KEYS.has(key)) throw new WidgetError(`property "${key}" is not allowed`);
      if (this.eatOp(":")) {
        props.push([key, this.expression()]);
      } else if (t.t === "id") {
        props.push([key, { k: "id", name: key }]);
      } else {
        throw new WidgetError(`expected ":" after "${key}"`);
      }
      if (!this.eatOp(",")) break;
    }
    this.expectOp("}");
    return this.node({ k: "obj", props });
  }
}

/** Parse one complete expression; trailing tokens are an error. */
export function parseExpression(src: string): Expr {
  const parser = new Parser(tokenize(src));
  const expr = parser.expression();
  if (parser.peek().t !== "eof") throw new WidgetError(`unexpected ${parser.where()}`);
  return expr;
}

// ---------------------------------------------------------------------------
// Declarations: `const x = …`, `const [v, setV] = DIL.useState(…)`
// ---------------------------------------------------------------------------

export type Pattern =
  | { k: "name"; name: string }
  | { k: "array"; items: (string | null)[] }
  | { k: "object"; keys: [string, string][] };

export type Declaration =
  | { k: "const"; pattern: Pattern; init: Expr }
  | { k: "state"; value: string; setter: string | null; init: Expr };

const STATE_HOOKS = new Set(["DIL.useState", "React.useState", "useState"]);

function calleeName(expr: Expr): string | null {
  if (expr.k === "id") return expr.name;
  if (expr.k === "member" && !expr.computed && expr.obj.k === "id" && expr.prop.k === "lit") {
    return `${expr.obj.name}.${String(expr.prop.v)}`;
  }
  return null;
}

/** A destructuring pattern as used by `{#each}` and declarations. */
export function parsePattern(src: string): Pattern {
  const parser = new Parser(tokenize(src));
  const pattern = readPattern(parser);
  if (parser.peek().t !== "eof") throw new WidgetError(`unexpected ${parser.where()}`);
  return pattern;
}

function readPattern(parser: Parser): Pattern {
  if (parser.eatOp("[")) {
    const items: (string | null)[] = [];
    while (!parser.isOp("]")) {
      if (parser.isOp(",")) {
        items.push(null);
        parser.eatOp(",");
        continue;
      }
      items.push(checkedName(parser.expectId()));
      if (!parser.eatOp(",")) break;
    }
    parser.expectOp("]");
    return { k: "array", items };
  }
  if (parser.eatOp("{")) {
    const keys: [string, string][] = [];
    while (!parser.isOp("}")) {
      const key = checkedName(parser.expectId());
      const local = parser.eatOp(":") ? checkedName(parser.expectId()) : key;
      keys.push([key, local]);
      if (!parser.eatOp(",")) break;
    }
    parser.expectOp("}");
    return { k: "object", keys };
  }
  return { k: "name", name: checkedName(parser.expectId()) };
}

function checkedName(name: string): string {
  if (FORBIDDEN_KEYS.has(name)) throw new WidgetError(`name "${name}" is not allowed`);
  return name;
}

/** `const …` / `let …` with one declarator. */
export function parseDeclaration(src: string): Declaration {
  const parser = new Parser(tokenize(src.trim().replace(/;\s*$/, "")));
  if (!parser.isId("const") && !parser.isId("let") && !parser.isId("var")) {
    throw new WidgetError("expected a const declaration");
  }
  parser.expectId();
  const pattern = readPattern(parser);
  parser.expectOp("=");
  const init = parser.expression();
  if (parser.peek().t !== "eof") throw new WidgetError(`unexpected ${parser.where()}`);
  if (init.k === "call") {
    const name = calleeName(init.callee);
    if (name && STATE_HOOKS.has(name)) {
      if (pattern.k !== "array" || pattern.items.length < 1 || !pattern.items[0]) {
        throw new WidgetError("useState must be destructured as [value, setValue]");
      }
      if (init.args.length > 1) throw new WidgetError("useState takes one argument");
      return {
        k: "state",
        value: pattern.items[0],
        setter: pattern.items[1] ?? null,
        init: init.args[0] ?? { k: "lit", v: undefined },
      };
    }
    if (name && /(^|\.)use[A-Z]/.test(name)) {
      throw new WidgetError(`${name} is not supported`);
    }
  }
  return { k: "const", pattern, init };
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export class Scope {
  private vars = new Map<string, Value>();
  private parent: Scope | null;
  readonly budget: Budget;

  constructor(parent: Scope | null, budget?: Budget) {
    this.parent = parent;
    this.budget = budget ?? parent?.budget ?? new Budget();
  }

  child(): Scope {
    return new Scope(this);
  }

  define(name: string, value: Value): void {
    this.vars.set(name, value);
  }

  lookup(name: string): Value {
    if (this.vars.has(name)) return this.vars.get(name);
    if (this.parent) return this.parent.lookup(name);
    throw new WidgetError(`"${name}" is not defined`);
  }
}

export class Budget {
  steps = 0;
  readonly limit: number;
  constructor(limit = 1_000_000) {
    this.limit = limit;
  }
  tick(n = 1): void {
    this.steps += n;
    if (this.steps > this.limit) throw new WidgetError("figure is too expensive to evaluate");
  }
}

const MAX_STRING = 100_000;
const MAX_ARRAY = 10_000;

function str(s: string): string {
  if (s.length > MAX_STRING) throw new WidgetError("text is too long");
  return s;
}

/** JavaScript's string conversion, limited to the values figures can hold. */
export function toText(value: Value): string {
  if (value === null) return "null";
  if (value === undefined) return "";
  if (typeof value === "number") return numberText(value);
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return value.map((v) => (v == null ? "" : toText(v))).join(",");
  throw new WidgetError("an object cannot be shown as text");
}

function numberText(n: number): string {
  return String(n);
}

function toNumber(value: Value): number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === null) return 0;
  if (value === undefined) return NaN;
  if (typeof value === "string") {
    const t = value.trim();
    return t === "" ? 0 : Number(t);
  }
  if (Array.isArray(value))
    return value.length === 0 ? 0 : value.length === 1 ? toNumber(value[0]) : NaN;
  return NaN;
}

export function truthy(value: Value): boolean {
  if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
  if (typeof value === "string") return value.length > 0;
  return value !== null && value !== undefined && value !== false;
}

function primitive(value: Value): number | string | boolean | null | undefined {
  if (value === null || value === undefined) return value;
  if (typeof value === "object") return toText(value);
  return value;
}

function looseEqual(a: Value, b: Value): boolean {
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === "object" || typeof b === "object") return a === b;
  if (typeof a === typeof b) return a === b;
  return toNumber(a) === toNumber(b);
}

function binary(op: string, a: Value, b: Value): Value {
  switch (op) {
    case "+": {
      const pa = primitive(a);
      const pb = primitive(b);
      if (typeof pa === "string" || typeof pb === "string") {
        return str(toText(pa) + toText(pb));
      }
      return toNumber(pa) + toNumber(pb);
    }
    case "-":
      return toNumber(a) - toNumber(b);
    case "*":
      return toNumber(a) * toNumber(b);
    case "/":
      return toNumber(a) / toNumber(b);
    case "%":
      return toNumber(a) % toNumber(b);
    case "**":
      return toNumber(a) ** toNumber(b);
    case "===":
      return a === b;
    case "!==":
      return a !== b;
    case "==":
      return looseEqual(a, b);
    case "!=":
      return !looseEqual(a, b);
    case "<":
    case ">":
    case "<=":
    case ">=": {
      const pa = primitive(a);
      const pb = primitive(b);
      const both = typeof pa === "string" && typeof pb === "string";
      const x = both ? pa : toNumber(pa);
      const y = both ? pb : toNumber(pb);
      if (op === "<") return x < y;
      if (op === ">") return x > y;
      if (op === "<=") return x <= y;
      return x >= y;
    }
    default:
      throw new WidgetError(`operator ${op} is not supported`);
  }
}

const LOCALE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

function checkLocale(value: Value): string {
  if (value === undefined) return "en-US";
  if (typeof value !== "string" || !LOCALE.test(value)) {
    throw new WidgetError('toLocaleString needs a literal locale such as "en-US"');
  }
  try {
    return Intl.getCanonicalLocales(value)[0] ?? "en-US";
  } catch {
    throw new WidgetError(`unknown locale ${value}`);
  }
}

/** Safe options for `toLocaleString`: digit counts only. */
function localeOptions(value: Value): Intl.NumberFormatOptions {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new WidgetError("toLocaleString options must be an object");
  const out: Intl.NumberFormatOptions = {};
  for (const [key, raw] of Object.entries(value)) {
    if (key === "minimumFractionDigits" || key === "maximumFractionDigits") {
      const n = toNumber(raw);
      if (!Number.isInteger(n) || n < 0 || n > 20) throw new WidgetError(`bad ${key}`);
      out[key] = n;
    } else {
      throw new WidgetError(`toLocaleString option "${key}" is not supported`);
    }
  }
  return out;
}

function callMath(name: string, args: Value[]): Value {
  const nums = args.map(toNumber);
  switch (name) {
    case "round":
      return Math.round(nums[0]);
    case "floor":
      return Math.floor(nums[0]);
    case "ceil":
      return Math.ceil(nums[0]);
    case "abs":
      return Math.abs(nums[0]);
    case "trunc":
      return Math.trunc(nums[0]);
    case "sign":
      return Math.sign(nums[0]);
    case "sqrt":
      return Math.sqrt(nums[0]);
    case "min":
      return Math.min(...nums);
    case "max":
      return Math.max(...nums);
    case "pow":
      return nums[0] ** nums[1];
    case "sin":
      return Math.sin(nums[0]);
    case "cos":
      return Math.cos(nums[0]);
    case "atan2":
      return Math.atan2(nums[0], nums[1]);
    default:
      throw new WidgetError(`Math.${name} is not supported`);
  }
}

const MATH_CONSTANTS: Record<string, number> = { PI: Math.PI, E: Math.E };

function callMethod(target: Value, name: string, args: Value[], budget: Budget): Value {
  if (typeof target === "number") {
    switch (name) {
      case "toFixed": {
        const digits = args[0] === undefined ? 0 : toNumber(args[0]);
        if (!Number.isInteger(digits) || digits < 0 || digits > 20) {
          throw new WidgetError("toFixed takes 0 to 20 digits");
        }
        return target.toFixed(digits);
      }
      case "toLocaleString":
        return target.toLocaleString(checkLocale(args[0]), localeOptions(args[1]));
      case "toString":
        return numberText(target);
      default:
        break;
    }
  }
  if (typeof target === "string") {
    switch (name) {
      case "toUpperCase":
        return target.toUpperCase();
      case "toLowerCase":
        return target.toLowerCase();
      case "trim":
        return target.trim();
      case "toString":
        return target;
      case "padStart":
      case "padEnd": {
        const width = toNumber(args[0]);
        if (!Number.isInteger(width) || width < 0 || width > 1000)
          throw new WidgetError(`bad ${name} width`);
        const fill = args[1] === undefined ? " " : toText(args[1]);
        return name === "padStart" ? target.padStart(width, fill) : target.padEnd(width, fill);
      }
      default:
        break;
    }
  }
  if (Array.isArray(target)) {
    switch (name) {
      case "join":
        budget.tick(target.length);
        return str(
          target
            .map((v) => (v == null ? "" : toText(v)))
            .join(args[0] === undefined ? "," : toText(args[0])),
        );
      case "slice": {
        const from = args[0] === undefined ? 0 : toNumber(args[0]);
        const to = args[1] === undefined ? undefined : toNumber(args[1]);
        budget.tick(target.length);
        return target.slice(from, to);
      }
      case "includes":
        budget.tick(target.length);
        return target.some((v) => v === args[0]);
      case "indexOf":
        budget.tick(target.length);
        return target.indexOf(args[0]);
      default:
        break;
    }
  }
  throw new WidgetError(`.${name}() is not supported`);
}

function readMember(target: Value, key: Value, optional: boolean): Value {
  if (target === null || target === undefined) {
    if (optional) return undefined;
    throw new WidgetError(
      `cannot read "${toText(key)}" of ${target === null ? "null" : "undefined"}`,
    );
  }
  if (typeof key !== "string" && typeof key !== "number") {
    throw new WidgetError("property names must be text or numbers");
  }
  const name = String(key);
  if (FORBIDDEN_KEYS.has(name)) throw new WidgetError(`property "${name}" is not allowed`);
  if (Array.isArray(target) || typeof target === "string") {
    if (name === "length") return target.length;
    const index = Number(name);
    if (Number.isInteger(index) && index >= 0) return target[index];
    return undefined;
  }
  if (isRecord(target)) {
    return Object.prototype.hasOwnProperty.call(target, name) ? target[name] : undefined;
  }
  if (typeof target === "number" || typeof target === "boolean") return undefined;
  throw new WidgetError(`cannot read "${name}" here`);
}

/** Evaluate `expr` in `scope`. Only data comes back; nothing is executed. */
export function evaluate(expr: Expr, scope: Scope): Value {
  const budget = scope.budget;
  budget.tick();
  switch (expr.k) {
    case "lit":
      return expr.v;
    case "tpl":
      return str(
        expr.parts.map((p) => (typeof p === "string" ? p : toText(evaluate(p, scope)))).join(""),
      );
    case "id":
      if (
        expr.name === "Math" ||
        expr.name === "Number" ||
        expr.name === "String" ||
        expr.name === "Boolean"
      ) {
        throw new WidgetError(`${expr.name} can only be called`);
      }
      return scope.lookup(expr.name);
    case "arr": {
      if (expr.items.length > MAX_ARRAY) throw new WidgetError("list is too long");
      return expr.items.map((item) => evaluate(item, scope));
    }
    case "obj": {
      const out = Object.create(null) as { [key: string]: Value };
      for (const [key, value] of expr.props) out[key] = evaluate(value, scope);
      return out;
    }
    case "member": {
      if (expr.obj.k === "id" && expr.obj.name === "Math" && !expr.computed) {
        const name = String((expr.prop as { v: Value }).v);
        if (name in MATH_CONSTANTS) return MATH_CONSTANTS[name];
        throw new WidgetError(`Math.${name} can only be called`);
      }
      const target = evaluate(expr.obj, scope);
      const key = expr.computed ? evaluate(expr.prop, scope) : (expr.prop as { v: Value }).v;
      return readMember(target, key, expr.optional);
    }
    case "call":
      return evaluateCall(expr, scope);
    case "unary": {
      const v = evaluate(expr.arg, scope);
      if (expr.op === "!") return !truthy(v);
      if (expr.op === "-") return -toNumber(v);
      return toNumber(v);
    }
    case "bin": {
      if (expr.op === "&&") {
        const l = evaluate(expr.left, scope);
        return truthy(l) ? evaluate(expr.right, scope) : l;
      }
      if (expr.op === "||") {
        const l = evaluate(expr.left, scope);
        return truthy(l) ? l : evaluate(expr.right, scope);
      }
      if (expr.op === "??") {
        const l = evaluate(expr.left, scope);
        return l === null || l === undefined ? evaluate(expr.right, scope) : l;
      }
      return binary(expr.op, evaluate(expr.left, scope), evaluate(expr.right, scope));
    }
    case "cond":
      return truthy(evaluate(expr.test, scope))
        ? evaluate(expr.then, scope)
        : evaluate(expr.else, scope);
    case "arrow":
      checkHandler(expr, scope);
      return HANDLER;
  }
}

/**
 * An inline handler is accepted only in the shape assistants emit for a bound
 * control, `v => setX(v)` or `() => setX(expr)`, so an arrow can never be a way
 * to smuggle in a computation the evaluator would otherwise refuse.
 */
function checkHandler(expr: Extract<Expr, { k: "arrow" }>, scope: Scope): void {
  const body = expr.body;
  if (body.k === "call" && body.callee.k === "id") {
    const params = new Set(expr.params);
    if (!params.has(body.callee.name)) {
      try {
        if (isSetter(scope.lookup(body.callee.name))) return;
      } catch {
        /* reported below */
      }
    }
  }
  throw new WidgetError("event handlers may only call a state setter");
}

function evaluateCall(expr: Extract<Expr, { k: "call" }>, scope: Scope): Value {
  const callee = expr.callee;
  const args = () => expr.args.map((a) => evaluate(a, scope));
  if (callee.k === "id") {
    switch (callee.name) {
      case "Number":
        return expr.args.length === 0 ? 0 : toNumber(evaluate(expr.args[0], scope));
      case "String":
        return expr.args.length === 0 ? "" : toText(evaluate(expr.args[0], scope));
      case "Boolean":
        return expr.args.length === 0 ? false : truthy(evaluate(expr.args[0], scope));
      case "parseInt": {
        const n = parseInt(toText(evaluate(expr.args[0], scope)), 10);
        return n;
      }
      case "parseFloat":
        return parseFloat(toText(evaluate(expr.args[0], scope)));
      case "isNaN":
        return Number.isNaN(toNumber(evaluate(expr.args[0], scope)));
      default: {
        const target = scope.lookup(callee.name);
        if (isSetter(target)) throw new WidgetError("state cannot change in a static figure");
        throw new WidgetError(`${callee.name}() is not supported`);
      }
    }
  }
  if (callee.k === "member" && !callee.computed) {
    const name = String((callee.prop as { v: Value }).v);
    if (callee.obj.k === "id" && callee.obj.name === "Math") return callMath(name, args());
    if (callee.obj.k === "id" && callee.obj.name === "Number") {
      const [v] = args();
      if (name === "isFinite") return typeof v === "number" && Number.isFinite(v);
      if (name === "isInteger") return typeof v === "number" && Number.isInteger(v);
      throw new WidgetError(`Number.${name} is not supported`);
    }
    if (callee.obj.k === "id" && callee.obj.name === "Array" && name === "from") {
      return arrayFrom(args(), scope.budget);
    }
    const target = evaluate(callee.obj, scope);
    if ((target === null || target === undefined) && (callee.optional || expr.optional))
      return undefined;
    return callMethod(target, name, args(), scope.budget);
  }
  throw new WidgetError("this call is not supported");
}

/** `Array.from({length: n})`, the one way assistants build a numeric range. */
function arrayFrom(args: Value[], budget: Budget): Value {
  const [source] = args;
  if (args.length !== 1) throw new WidgetError("Array.from takes one argument here");
  if (isRecord(source) && Object.keys(source).length === 1 && "length" in source) {
    const n = toNumber(source.length);
    if (!Number.isInteger(n) || n < 0 || n > MAX_ARRAY)
      throw new WidgetError("bad Array.from length");
    budget.tick(n);
    return new Array<Value>(n).fill(undefined);
  }
  if (Array.isArray(source)) return source.slice();
  throw new WidgetError("Array.from is supported only for {length: n}");
}

/** Bind a destructuring pattern; used by declarations and `{#each … as …}`. */
export function bindPattern(pattern: Pattern, value: Value, scope: Scope): void {
  switch (pattern.k) {
    case "name":
      scope.define(pattern.name, value);
      return;
    case "array":
      pattern.items.forEach((name, i) => {
        if (name) scope.define(name, Array.isArray(value) ? value[i] : readMember(value, i, true));
      });
      return;
    case "object":
      for (const [key, local] of pattern.keys) scope.define(local, readMember(value, key, true));
      return;
  }
}

/** Run one declaration: a constant, or a `useState` that yields its initial value. */
export function declare(decl: Declaration, scope: Scope): void {
  if (decl.k === "state") {
    scope.define(decl.value, evaluate(decl.init, scope));
    if (decl.setter) scope.define(decl.setter, makeSetter(decl.setter));
    return;
  }
  bindPattern(decl.pattern, evaluate(decl.init, scope), scope);
}
