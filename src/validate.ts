/**
 * Validators, from the constraints and invariants a model declares.
 *
 * The Data layer is the part of 7K that is described *completely* — a message says exactly what shapes
 * and what rules its contents obey — so it can be generated rather than restated by hand. The Topology
 * layer is not: a service is described by its interface, never its internals (`03-topology.md` 2.0),
 * which is why a handler gets a signature and a comment and never a body.
 *
 * **Invariants are the reason this exists.** A `length` or a `range` is expressible in most schema
 * languages and usually gets checked somewhere anyway. A rule spanning two fields —
 * `total.currency == lines[].unit.currency` — is the one JSON Schema records as a loss, the one nobody
 * writes by hand, and the one that costs somebody an afternoon when it is violated in production.
 *
 * **It will not pretend.** 7K's own checker is authoritative. Where a rule cannot be expressed here, the
 * generated code says so at the place a reader would look for it and the artifact carries a loss — rather
 * than omitting it silently and leaving `Validate` looking complete.
 */

import {
  flatFieldsOf,
  type ConstraintIr,
  type Decl,
  type FieldIr,
  type JsonValue,
  type Operand,
  type Predicate,
  type TypeIr,
} from "@sevenk/core";
import type { Loss } from "@sevenk/generate";
import { comparisonOf } from "./equality.js";
import { pascal, qualifiedName, type TypeContext } from "./types.js";

export interface Validation {
  readonly lines: readonly string[];
  readonly losses: readonly Loss[];
  /** Whether the body needs `System.Linq`, which only a projection or `unique` does. */
  readonly needsLinq: boolean;
  /** Whether the body needs `System.Text.RegularExpressions`. */
  readonly needsRegex: boolean;
}

const indent = (lines: readonly string[]): string[] => lines.map((l) => (l === "" ? "" : `    ${l}`));

const quote = (text: string): string => JSON.stringify(text);

/** A validator's name, beside the type it validates and qualified the same way. */
const validatorName = (decl: Decl, ctx: TypeContext): string => `${qualifiedName(decl, ctx)}Validator`;

/** What a type points at, if it points at a declaration. Lists are looked through. */
function referenced(type: TypeIr, ctx: TypeContext): Decl | undefined {
  if (type.t === "ref") return ctx.model.declFor(type.ref);
  if (type.t === "list") return referenced(type.item, ctx);
  return undefined;
}

/**
 * A declaration's fields, with everything it `include`s spliced in.
 *
 * `include` splices rather than nests, so the fields that count are the flattened ones — and a validator
 * reading only the declared ones would skip the rules on every included field.
 */
/**
 * Through a chain of value wrappers, to the type the rules are actually about.
 *
 * 7K allows a value to refine another value — `value Line60 : Line` — so `Line60`'s `length 1..60` is a
 * rule about the string at the bottom, while in C# `it.Value` is a `Line` struct. Each hop adds a
 * `.Value`, and the type returned is what `.Length` or `<` will be applied to.
 */
function unwrap(type: TypeIr, ctx: TypeContext): { suffix: string; type: TypeIr } {
  let suffix = "";
  let current = type;
  for (let hop = 0; hop < 16; hop++) {
    if (current.t !== "ref" || ctx.valueTypes !== "wrapper") break;
    const target = ctx.model.declFor(current.ref);
    if (target === undefined || target.kind !== "value") break;
    suffix += ".Value";
    current = target.base;
  }
  return { suffix, type: current };
}

/** Every constraint along a chain of value wrappers, nearest first. */
function chainConstraints(type: TypeIr, ctx: TypeContext): ConstraintIr[] {
  const all: ConstraintIr[] = [];
  let current = type;
  for (let hop = 0; hop < 16; hop++) {
    if (current.t !== "ref") break;
    const target = ctx.model.declFor(current.ref);
    if (target === undefined || target.kind !== "value") break;
    all.push(...target.constraints);
    current = target.base;
  }
  return all;
}

const fieldsOf = (decl: Decl, ctx: TypeContext): readonly FieldIr[] =>
  decl.kind === "message" || decl.kind === "record" || decl.kind === "envelope"
    ? flatFieldsOf(ctx.model, decl)
    : [];

const invariantsOf = (decl: Decl): readonly Predicate[] =>
  decl.kind === "message" || decl.kind === "record" || decl.kind === "envelope"
    ? decl.invariants
    : [];

/* ------------------------------------------------------------------ existence */

/**
 * Whether a constraint becomes a check.
 *
 * `normalize` transforms a value rather than rejecting one and `example` is documentation, so a type
 * whose only constraint is one of those states no rule a validator could hold — and must not be given an
 * empty `Validate` that reads as "checked".
 */
const contributes = (constraint: ConstraintIr, list: boolean): boolean => {
  if (constraint.name === "normalize" || constraint.name === "example") return false;
  if (constraint.name === "unique") return list;
  return true;
};

/** Whether a declaration states a rule of its own, before anything it delegates to. */
function declaresRules(decl: Decl, ctx: TypeContext): boolean {
  if (decl.kind === "value") {
    return (
      ctx.valueTypes === "wrapper" &&
      decl.constraints.some((c) => contributes(c, decl.base.t === "list"))
    );
  }
  if (invariantsOf(decl).length > 0) return true;
  return fieldsOf(decl, ctx).some((f) => f.constraints.some((c) => contributes(c, f.type.t === "list")));
}

/**
 * Which declarations get a validator.
 *
 * Transitive, and so a fixpoint: `Order` needs one because it holds `lines`, which holds `Money`, which
 * constrains `amount`. A plain traversal would recurse forever on a model where two records reference
 * each other, which is legal; adding to a set until it stops growing cannot.
 *
 * Computed over the **whole model** rather than the selection, because a validator that delegates must
 * agree with what a run over a different selection generated — the same reason names are computed whole.
 */
export function validatorsIn(
  decls: readonly Decl[],
  ctxFor: (decl: Decl) => TypeContext,
  wanted: (decl: Decl) => boolean,
): (decl: Decl) => boolean {
  const has = new Set<Decl>(decls.filter((d) => wanted(d) && declaresRules(d, ctxFor(d))));

  for (let growing = true; growing; ) {
    growing = false;
    for (const decl of decls) {
      if (has.has(decl) || !wanted(decl)) continue;
      const ctx = ctxFor(decl);

      // A value is bound by what it refines, so `Line60` needs one as soon as `Line` has one.
      if (decl.kind === "value" && ctx.valueTypes === "wrapper") {
        const base = referenced(decl.base, ctx);
        if (base !== undefined && has.has(base)) {
          has.add(decl);
          growing = true;
        }
        continue;
      }

      const delegates = fieldsOf(decl, ctx).some((f) =>
        // A shape this provider cannot render still produces a comment and a loss, so it counts as
        // something to say — a validator that said nothing about it would be the silent case.
        shapeOf(f.type, ctx).k === "beyond" ||
        reachable(f.type, ctx).some((target) => {
          // Under `alias` a value has no wrapper to hold a validator, so its rules are inlined instead.
          if (target.kind === "value" && ctxFor(target).valueTypes === "alias") {
            return target.constraints.some((c) => contributes(c, false));
          }
          return has.has(target);
        }),
      );
      if (delegates) {
        has.add(decl);
        growing = true;
      }
    }
  }

  return (decl) => has.has(decl);
}

/**
 * How a field's own type is reached, if it is reached at all.
 *
 * Said explicitly because the alternative is looking through a type until something resolves, which
 * quietly turns `[[Money]]` into one `foreach` over a list of lists — code that does not compile, or
 * worse, compiles against the wrong thing. A shape this does not render is reported, not approximated.
 */
type Shape =
  | { readonly k: "none" }
  | { readonly k: "direct"; readonly decl: Decl }
  | { readonly k: "list"; readonly decl: Decl }
  | { readonly k: "map"; readonly key: Decl | undefined; readonly value: Decl | undefined }
  | { readonly k: "beyond"; readonly why: string };

function shapeOf(type: TypeIr, ctx: TypeContext): Shape {
  const at = (t: TypeIr): Decl | undefined =>
    t.t === "ref" ? ctx.model.declFor(t.ref) : undefined;

  if (type.t === "ref") {
    const decl = at(type);
    return decl === undefined ? { k: "none" } : { k: "direct", decl };
  }
  if (type.t === "list") {
    if (type.item.t === "list" || type.item.t === "map") {
      return { k: "beyond", why: "it nests a list inside a list" };
    }
    const decl = at(type.item);
    return decl === undefined ? { k: "none" } : { k: "list", decl };
  }
  if (type.t === "map") {
    if (type.value.t === "list" || type.value.t === "map") {
      return { k: "beyond", why: "it nests a collection inside a map" };
    }
    const key = at(type.key);
    const value = at(type.value);
    return key === undefined && value === undefined ? { k: "none" } : { k: "map", key, value };
  }
  return { k: "none" };
}

/** Every declaration a field's type could carry rules through, for deciding who needs a validator. */
function reachable(type: TypeIr, ctx: TypeContext): Decl[] {
  const shape = shapeOf(type, ctx);
  switch (shape.k) {
    case "direct":
    case "list":
      return [shape.decl];
    case "map":
      return [shape.key, shape.value].filter((d): d is Decl => d !== undefined);
    default:
      return [];
  }
}

/**
 * Whether a type is counted rather than measured: `size` and `length` read `.Count` on a collection
 * and `.Length` on a string.
 *
 * A question about the C# type, not the 7K one — `bytes` is a kernel scalar in the model and an
 * `IReadOnlyList<byte>` here, so `length 1..64` on one counts elements.
 */
const countable = (type: TypeIr, ctx: TypeContext): boolean =>
  comparisonOf(type, ctx) !== "scalar";

/* ---------------------------------------------------------------- constraints */

/** A constraint's bounds, from the raw tokens the parser kept: `["1", "..", "200"]`. */
function bounds(args: readonly string[]): { low?: string; high?: string; exact?: string } {
  const at = args.indexOf("..");
  if (at < 0) return args[0] === undefined ? {} : { exact: args[0] };
  const low = args.slice(0, at).join("");
  const high = args.slice(at + 1).join("");
  return { ...(low === "" ? {} : { low }), ...(high === "" ? {} : { high }) };
}

/** A regex literal as the parser kept it: `/^[A-Z]{3}$/`. */
const regexBody = (literal: string): string => {
  const close = literal.lastIndexOf("/");
  return literal.startsWith("/") && close > 0 ? literal.slice(1, close) : literal;
};

const guard = (condition: string, at: string, rule: string): string =>
  `if (${condition}) problems.Add(new Problem(${quote(at)}, ${quote(rule)}));`;

const between = (of: string, b: ReturnType<typeof bounds>): string[] => {
  const parts: string[] = [];
  if (b.low !== undefined) parts.push(`${of} < ${b.low}`);
  if (b.high !== undefined) parts.push(`${of} > ${b.high}`);
  return parts;
};

interface Checks {
  readonly lines: readonly string[];
  readonly loss?: Loss;
  readonly needsLinq?: boolean;
  readonly needsRegex?: boolean;
}

/**
 * The checks one constraint becomes, against an expression.
 *
 * `normalize` and `example` produce none, and that is not a gap: normalising transforms a value rather
 * than rejecting one, and an example is documentation. Saying so here is the difference between a
 * constraint this provider chose not to check and one it could not.
 */
function checks(
  constraint: ConstraintIr,
  expr: string,
  at: string,
  where: string,
  list: boolean,
): Checks {
  const b = bounds(constraint.args);
  const rule = (name: string): string =>
    b.exact !== undefined
      ? `${name} ${b.exact}`
      : `${name} ${b.low ?? ""}..${b.high ?? ""}`;

  switch (constraint.name) {
    case "length": {
      // `length` on a list counts elements, exactly as `size` does; on a string it counts characters.
      const of = list ? `${expr}.Count` : `${expr}.Length`;
      if (b.exact !== undefined) return { lines: [guard(`${of} != ${b.exact}`, at, rule("length"))] };
      const parts = between(of, b);
      return { lines: parts.length === 0 ? [] : [guard(parts.join(" || "), at, rule("length"))] };
    }

    case "size": {
      const parts = between(`${expr}.Count`, b);
      return { lines: parts.length === 0 ? [] : [guard(parts.join(" || "), at, rule("size"))] };
    }

    case "range": {
      if (b.exact !== undefined) return { lines: [guard(`${expr} != ${b.exact}`, at, rule("range"))] };
      const parts = between(expr, b);
      return { lines: parts.length === 0 ? [] : [guard(parts.join(" || "), at, rule("range"))] };
    }

    case "multipleOf": {
      const by = constraint.args[0] ?? "1";
      return { lines: [guard(`${expr} % ${by} != 0`, at, `multipleOf ${by}`)] };
    }

    case "pattern": {
      const source = constraint.args[0] ?? "";
      return {
        lines: [
          guard(`!Regex.IsMatch(${expr}, ${quote(regexBody(source))})`, at, `pattern ${source}`),
        ],
        needsRegex: true,
      };
    }

    case "unique":
      return list
        ? {
            lines: [guard(`${expr}.Distinct().Count() != ${expr}.Count`, at, "unique")],
            needsLinq: true,
          }
        : { lines: [] };

    // Transforms the value rather than rejecting one, so there is nothing here to check.
    case "normalize":
      return { lines: [] };

    // Documentation. The model's own checker already verifies it satisfies its own constraints.
    case "example":
      return { lines: [] };

    default:
      return {
        lines: [`// 7K: \`${constraint.name}\` on ${where} is not checked here.`],
        loss: {
          construct: constraint.name,
          at: where,
          fidelity: "none",
          detail:
            `This provider does not express \`${constraint.name}\`, so \`Validate\` does not check it. ` +
            `7K's own checker remains authoritative.`,
        },
      };
  }
}

/* ----------------------------------------------------------------- invariants */

/** The type a path arrives at, walking fields and looking through `[]`. */
function typeAt(from: Decl, path: readonly string[], ctx: TypeContext): TypeIr | undefined {
  let type: TypeIr | undefined;
  let holder: Decl | undefined = from;

  for (const segment of path) {
    let next: TypeIr | undefined;
    if (segment === "[]") {
      if (type === undefined || type.t !== "list") return undefined;
      next = type.item;
    } else {
      if (holder === undefined) return undefined;
      const field: FieldIr | undefined = fieldsOf(holder, ctx).find((f) => f.name === segment);
      if (field === undefined) return undefined;
      next = field.type;
    }
    type = next;
    holder = next.t === "ref" ? ctx.model.declFor(next.ref) : undefined;
  }
  return type;
}

/**
 * A literal, in the type the other side of the comparison has.
 *
 * An enum is the case that matters: 7K writes `status == "shipped"` as a string, and C# needs
 * `OrderStatus.Shipped` or it will not compile.
 */
function literalFor(value: JsonValue, against: TypeIr | undefined, ctx: TypeContext): string {
  const decl = against === undefined ? undefined : referenced(against, ctx);
  if (decl?.kind === "enum" && typeof value === "string") {
    const member = decl.members.find((m) => m.name === value);
    if (member !== undefined) return `${qualifiedName(decl, ctx)}.${pascal(member.name)}`;
  }
  if (typeof value === "string") return quote(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  return quote(JSON.stringify(value));
}

const OPS: Readonly<Record<string, string>> = {
  "==": "==",
  "!=": "!=",
  "<": "<",
  "<=": "<=",
  ">": ">",
  ">=": ">=",
};

const property = (segments: readonly string[]): string =>
  segments.map((s) => `.${pascal(s)}`).join("");

interface Condition {
  readonly text?: string;
  readonly why?: string;
  readonly needsLinq?: boolean;
}

/**
 * One invariant as a C# condition.
 *
 * Deliberately a subset: comparisons between paths and literals, combined with and/or/not, with a list
 * projection on at most one side. Two projections in one comparison have no single agreed meaning —
 * pairwise, or every element against every element — and guessing would be worse than saying so.
 */
function condition(predicate: Predicate, decl: Decl, ctx: TypeContext): Condition {
  switch (predicate.p) {
    case "and":
    case "or": {
      const parts = predicate.operands.map((p) => condition(p, decl, ctx));
      const failed = parts.find((p) => p.text === undefined);
      if (failed !== undefined) return { ...(failed.why === undefined ? {} : { why: failed.why }) };
      const joiner = predicate.p === "and" ? " && " : " || ";
      return {
        text: `(${parts.map((p) => p.text).join(joiner)})`,
        needsLinq: parts.some((p) => p.needsLinq === true),
      };
    }

    case "not": {
      const inner = condition(predicate.operand, decl, ctx);
      return inner.text === undefined ? inner : { ...inner, text: `!(${inner.text})` };
    }

    case "cmp": {
      const op = OPS[predicate.op];
      if (op === undefined) {
        // `in` and `contains` are real operators this does not render yet, and saying which one is
        // missing is more use to a reader than "unsupported".
        return { why: `the operator \`${predicate.op}\` is not expressed here` };
      }

      // `message.` and a bare path both read the declaration being validated; an envelope does not
      // travel with the body, so a rule about one cannot be checked against the body alone.
      const pathed = (operand: typeof predicate.left) =>
        operand.k === "field" || operand.k === "message" ? operand.path : undefined;

      const leftPath = pathed(predicate.left);
      const rightPath = pathed(predicate.right);
      const projected = (path: readonly string[] | undefined): boolean =>
        path !== undefined && path.includes("[]");

      if (predicate.left.k === "envelope" || predicate.right.k === "envelope") {
        return { why: "it reads the envelope, which does not travel with the body" };
      }
      if (
        (leftPath === undefined && predicate.left.k !== "literal") ||
        (rightPath === undefined && predicate.right.k !== "literal")
      ) {
        return { why: "it reads something outside the message" };
      }
      if (projected(leftPath) && projected(rightPath)) {
        return { why: "it projects over two lists at once, which has no single meaning" };
      }

      const typeOf = (path: readonly string[] | undefined): TypeIr | undefined =>
        path === undefined ? undefined : typeAt(decl, path, ctx);

      for (const [path, side] of [
        [leftPath, "left"],
        [rightPath, "right"],
      ] as const) {
        if (path !== undefined && typeOf(path) === undefined) {
          return { why: `the ${side} path \`${path.join(".")}\` does not resolve to a field` };
        }
      }

      const render = (
        operand: typeof predicate.left,
        path: readonly string[] | undefined,
        otherType: TypeIr | undefined,
      ): string =>
        operand.k === "literal"
          ? literalFor(operand.value, otherType, ctx)
          : `it${property((path ?? []).filter((s) => s !== "[]"))}`;

      if (!projected(leftPath) && !projected(rightPath)) {
        return {
          text: `${render(predicate.left, leftPath, typeOf(rightPath))} ${op} ${render(predicate.right, rightPath, typeOf(leftPath))}`,
        };
      }

      // Every element must satisfy it, which is what `[]` means in an invariant.
      const list = projected(leftPath) ? leftPath! : rightPath!;
      const at = list.indexOf("[]");
      const element = `e${property(list.slice(at + 1))}`;
      const otherOperand = projected(leftPath) ? predicate.right : predicate.left;
      const otherPath = projected(leftPath) ? rightPath : leftPath;
      const other = render(otherOperand, otherPath, typeAt(decl, list, ctx));

      const [a, b] = projected(leftPath) ? [element, other] : [other, element];
      return {
        text: `it${property(list.slice(0, at))}.All(e => ${a} ${op} ${b})`,
        needsLinq: true,
      };
    }

    default:
      // `unknown` — the model kept the text it could not parse, and 7K itself reports that. Repeating
      // the diagnostic here would be noise; emitting a check derived from it would be a guess.
      return { why: "7K could not parse it" };
  }
}

/**
 * An invariant as the model would have written it.
 *
 * A problem reading `invariant` tells a caller nothing it can act on; one reading
 * `total.currency == lines[].unit.currency` names the two fields that disagree. Reconstructed from the
 * operands rather than taken from the source, because the IR keeps spans and not text.
 */
export function describePredicate(predicate: Predicate): string {
  switch (predicate.p) {
    case "and":
    case "or":
      return predicate.operands.map(describePredicate).join(predicate.p === "and" ? " and " : " or ");
    case "not":
      return `not ${describePredicate(predicate.operand)}`;
    case "cmp": {
      const side = (operand: Operand): string => {
        switch (operand.k) {
          case "literal":
            return JSON.stringify(operand.value);
          case "list":
            return `[${operand.values.map((v) => JSON.stringify(v)).join(", ")}]`;
          case "claim":
            return `claim.${operand.name}`;
          case "envelope":
            return `envelope.${operand.path.join(".")}`;
          default:
            // `message.x` and a bare `x` read the same thing, and the model's own spelling is the
            // shorter one.
            return operand.path.join(".").replace(/\.\[\]/g, "[]");
        }
      };
      return `${side(predicate.left)} ${predicate.op} ${side(predicate.right)}`;
    }
    default:
      return predicate.text;
  }
}

/* -------------------------------------------------------------------- the whole */

/**
 * The validator for one declaration, or nothing when the model states no rules about it.
 *
 * A type with no constraints and no invariants gets no `Validate` at all, rather than one that always
 * returns an empty list: an empty validator reads as "this has been checked" when it means "there was
 * nothing to check", and the two deserve to look different.
 */
export function validatorFor(
  decl: Decl,
  ctx: TypeContext,
  has: (decl: Decl) => boolean,
): Validation | undefined {
  if (!has(decl)) return undefined;

  const body: string[] = [];
  const losses: Loss[] = [];
  let needsLinq = false;
  let needsRegex = false;

  const take = (c: Checks): string[] => {
    if (c.loss !== undefined) losses.push(c.loss);
    needsLinq = needsLinq || c.needsLinq === true;
    needsRegex = needsRegex || c.needsRegex === true;
    return [...c.lines];
  };

  // A value refines one thing, so its rules are checked against that one thing.
  if (decl.kind === "value") {
    if (ctx.valueTypes === "alias") return undefined; // No type of its own; inlined at each use instead.

    // `value Line60 : Line` holds a `Line`, not a string, so the rules reach through it.
    const inner = unwrap(decl.base, ctx);
    for (const constraint of decl.constraints) {
      body.push(
        ...take(
          checks(constraint, `it.Value${inner.suffix}`, "", decl.id.name, countable(inner.type, ctx)),
        ),
      );
    }

    // What it refines keeps its own rules: a `Line60` is a `Line`, so it is one of those too.
    const base = referenced(decl.base, ctx);
    if (base !== undefined && has(base)) {
      // `AddRange` is `List<T>`'s own, not Linq's: the problems arrive already relative to this value,
      // so there is nothing to re-point and no import to add.
      body.push(`problems.AddRange(${validatorName(base, ctx)}.Validate(it.Value));`);
    }
  }

  for (const field of fieldsOf(decl, ctx)) {
    const name = pascal(field.name);
    const at = field.name;
    const where = `${decl.id.name}.${field.name}`;
    // An optional field is pattern-matched out of its nullable form first, so the checks below read a
    // value that is known to be present.
    const held = field.optional ? `${name}Value` : `it.${name}`;
    const shape = shapeOf(field.type, ctx);
    const counted = countable(field.type, ctx);

    // `PostCode` is a struct wrapping a string, so a constraint on the field reads through `.Value` —
    // and through every hop, since a value may refine another value. A constraint on the collection
    // itself still reads the collection.
    const wrapped = shape.k === "direct" && shape.decl.kind === "value" && ctx.valueTypes === "wrapper";
    const scalar = wrapped ? `${held}${unwrap(field.type, ctx).suffix}` : held;

    const here: string[] = [];
    for (const constraint of field.constraints) {
      here.push(...take(checks(constraint, counted ? held : scalar, at, where, counted)));
    }

    /** Defers to another type's validator, where that type got one. */
    const defer = (expr: string, path: string, target: Decl | undefined): void => {
      if (target === undefined || !has(target)) return;
      // Only where that type actually got a validator: naming one that was never generated would be a
      // file that does not compile, which is worse than a check that is not made.
      here.push(
        `problems.AddRange(${validatorName(target, ctx)}.Validate(${expr}).Select(p => p.Under(${quote(path)})));`,
      );
      needsLinq = true;
    };

    const aliased =
      shape.k !== "none" &&
      shape.k !== "beyond" &&
      ctx.valueTypes === "alias" &&
      reachable(field.type, ctx).some((d) => d.kind === "value");

    // A field's declared type brings its own rules with it.
    if (aliased) {
      // As an alias there is no wrapper to hold a validator, so the value's rules are inlined at every
      // use — the whole chain of them, since `Line60 : Line` is bound by both. Without this, choosing
      // `alias` would silently drop them.
      const chain = shape.k === "direct" ? chainConstraints(field.type, ctx) : [];
      for (const constraint of chain) {
        // As an alias the field *is* the refined type, so what it is counted by follows from that.
        here.push(...take(checks(constraint, held, at, where, countable(field.type, ctx))));
      }
      if (shape.k !== "direct") {
        // Inside a collection there is no element to hang an alias's rules on without a lambda per
        // constraint, and a loss said out loud beats a check quietly skipped.
        here.push(`// 7K: the rules on this collection's elements are not checked — see \`valueTypes\`.`);
        losses.push({
          construct: "value",
          at: where,
          fidelity: "none",
          detail:
            `Its element type is emitted as an alias, so there is no per-element validator. Set ` +
            `\`valueTypes\` to \`wrapper\` for this declaration to check them.`,
        });
      }
    } else if (shape.k === "direct") {
      defer(held, at, shape.decl);
    } else if (shape.k === "list") {
      if (has(shape.decl)) {
        here.push(
          `foreach (var e in ${held}) problems.AddRange(${validatorName(shape.decl, ctx)}.Validate(e).Select(p => p.Under(${quote(`${at}[]`)})));`,
        );
        needsLinq = true;
      }
    } else if (shape.k === "map") {
      // A map's keys carry rules as much as its values do: `map<Code, Amount>` constrains both.
      const checksKey = shape.key !== undefined && has(shape.key);
      const checksValue = shape.value !== undefined && has(shape.value);
      if (checksKey || checksValue) {
        const inner: string[] = [];
        if (checksKey) {
          inner.push(
            `problems.AddRange(${validatorName(shape.key!, ctx)}.Validate(e.Key).Select(p => p.Under(${quote(`${at}[key]`)})));`,
          );
        }
        if (checksValue) {
          inner.push(
            `problems.AddRange(${validatorName(shape.value!, ctx)}.Validate(e.Value).Select(p => p.Under(${quote(`${at}[]`)})));`,
          );
        }
        here.push(`foreach (var e in ${held})`, "{", ...indent(inner), "}");
        needsLinq = true;
      }
    } else if (shape.k === "beyond") {
      here.push(`// 7K: the rules inside \`${field.name}\` are not checked here — ${shape.why}.`);
      losses.push({
        construct: "field",
        at: where,
        fidelity: "none",
        detail: `Not expressed here because ${shape.why}. 7K's own checker remains authoritative for it.`,
      });
    }

    if (here.length === 0) continue;

    if (field.optional) {
      // Absent is a legal value for an optional field, so its rules apply only when it is present.
      body.push(`if (it.${name} is { } ${name}Value)`, "{", ...indent(here), "}");
    } else {
      body.push(...here);
    }
  }

  for (const invariant of invariantsOf(decl)) {
    const { text, why, needsLinq: linq } = condition(invariant, decl, ctx);
    if (text === undefined) {
      body.push(
        `// 7K: an invariant on ${decl.id.name} is not checked here — ${why ?? "it is unsupported"}.`,
      );
      losses.push({
        construct: "invariant",
        at: decl.id.name,
        fidelity: "none",
        detail:
          `Not expressed here because ${why ?? "it is unsupported"}. 7K's own checker remains ` +
          `authoritative for it.`,
      });
      continue;
    }
    needsLinq = needsLinq || linq === true;
    body.push(guard(`!(${text})`, "", `invariant ${describePredicate(invariant)}`));
  }

  if (body.length === 0) return undefined;

  const name = pascal(decl.id.name);
  return {
    lines: [
      `/// <summary>Every rule the 7K model states about <see cref="${name}"/>.</summary>`,
      `public static partial class ${name}Validator`,
      "{",
      ...indent([
        "/// <summary>The rules this value breaks, empty when it breaks none.</summary>",
        `public static IReadOnlyList<Problem> Validate(${name} it)`,
        "{",
        ...indent(["var problems = new List<Problem>();", ...body, "return problems;"]),
        "}",
      ]),
      "}",
    ],
    losses,
    needsLinq,
    needsRegex,
  };
}

/**
 * The one hand-written type the generated validators share.
 *
 * `Problem` rather than a string so that a path is a path: a service answering an API call needs to say
 * *which* field is wrong, and `problem.Path` is that answer without anybody parsing a message. The
 * string form is still one `ToString()` away.
 *
 * `Under` is what makes a nested validator composable — each one reports paths relative to the value it
 * was handed, and the caller prefixes them. Without it, `MoneyValidator` would have to know it was
 * reached through `lines[].unit`, which is the one thing it must not know.
 */
export const SUPPORT: readonly string[] = [
  "/// <summary>A rule the model states that a value does not satisfy.</summary>",
  "/// <param name=\"Path\">The field, relative to the value that was validated; empty for the value itself.</param>",
  "/// <param name=\"Rule\">The rule, as the 7K model states it.</param>",
  "public readonly record struct Problem(string Path, string Rule)",
  "{",
  "    /// <summary>The same problem, seen from a value that holds this one.</summary>",
  "    public Problem Under(string prefix) =>",
  "        new(prefix.Length == 0 ? Path : Path.Length == 0 ? prefix : $\"{prefix}.{Path}\", Rule);",
  "",
  "    public override string ToString() => Path.Length == 0 ? Rule : $\"{Path}: {Rule}\";",
  "}",
];

/**
 * Where `Problem` lives.
 *
 * The root namespace, so it sits above every package rather than inside an arbitrary one. A run with no
 * root has nowhere above to put it, and `SevenK` is a name no 7K package can collide with — a package
 * name is lowercase (`10-grammar.md`).
 */
export const supportNamespace = (root: string): string => (root === "" ? "SevenK" : root);


/* ------------------------------------------------------------- annotations */

/**
 * DataAnnotations, for the constraints that fit into one.
 *
 * Worth generating because ASP.NET's model binding applies them with nothing wired up: a payload that
 * breaks `length 1..24` is rejected at the edge rather than three frames into a handler. Worth being
 * careful about because they are **not** the whole contract — an attribute decorates one property, and
 * `total.currency == lines[].unit.currency` is about two. So `annotations` on its own records a loss
 * per invariant, and `both` is the combination that keeps the edge convenient and the check complete.
 */
export function annotationsFor(
  field: FieldIr,
  ctx: TypeContext,
): { lines: string[]; losses: Loss[] } {
  const lines: string[] = [];
  const losses: Loss[] = [];
  const at = field.name;

  // An attribute reads the property, and a wrapper struct is not the string the attribute would
  // measure. Nothing useful can be said about one, and saying it wrongly is worse than not saying it.
  const target = referenced(field.type, ctx);
  const wrapped = target?.kind === "value" && ctx.valueTypes === "wrapper";

  if (!field.optional) lines.push("[Required]");

  for (const constraint of field.constraints) {
    if (wrapped) continue;
    const b = bounds(constraint.args);
    switch (constraint.name) {
      case "length":
      case "size":
        if (b.exact !== undefined) lines.push(`[StringLength(${b.exact}, MinimumLength = ${b.exact})]`);
        else if (b.high !== undefined) {
          lines.push(`[StringLength(${b.high}${b.low === undefined ? "" : `, MinimumLength = ${b.low}`})]`);
        } else if (b.low !== undefined) lines.push(`[MinLength(${b.low})]`);
        break;
      case "range":
        if (b.low !== undefined && b.high !== undefined) {
          lines.push(`[Range(typeof(decimal), "${b.low}", "${b.high}")]`);
        } else if (b.low !== undefined) {
          lines.push(`[Range(typeof(decimal), "${b.low}", "79228162514264337593543950335")]`);
        }
        break;
      case "pattern":
        lines.push(`[RegularExpression(${quote(regexBody(constraint.args[0] ?? ""))})]`);
        break;
      default:
        break;
    }
  }

  if (wrapped && field.constraints.length > 0) {
    losses.push({
      construct: "constraint",
      at,
      fidelity: "none",
      detail:
        `An attribute measures the property, and this one holds a nominal wrapper rather than the ` +
        `value it refines. The generated validator checks it; model binding does not.`,
    });
  }

  return { lines, losses };
}

/** The invariants an attribute cannot carry, as losses. */
export function annotationLosses(decl: Decl): Loss[] {
  return invariantsOf(decl).map((invariant) => ({
    construct: "invariant",
    at: decl.id.name,
    fidelity: "none",
    detail:
      `An attribute decorates one property and \`${describePredicate(invariant)}\` relates more than ` +
      `one, so model binding cannot check it. Set \`validatorStyle\` to \`both\` to keep the method ` +
      `that does.`,
  }));
}

/** What the annotations need in scope. */
export const ANNOTATION_USINGS: readonly string[] = [
  "using System.ComponentModel.DataAnnotations;",
];
