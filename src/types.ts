/**
 * 7K's kernel types, in C#.
 *
 * The mapping is the first place a provider can lie, so it is the first place to be careful. Every
 * choice here is either exact or a refusal — never "close enough". A `decimal(38,4)` that quietly became
 * a `double` would be a rounding bug with a specification behind it.
 */

import type { Decl, FieldIr, LinkedModel, TypeIr } from "@sevenk/core";

/**
 * The largest `decimal` precision C# can hold.
 *
 * 7K allows `decimal(p, s)` up to `p = 38` (`01-kernel.md`); C#'s `decimal` carries 28–29 significant
 * digits. Anything wider has no exact C# type, and the honest answers are to refuse or to emit something
 * that is not a number. This provider refuses — see `REFUSE_WIDE_DECIMAL`.
 */
export const CSHARP_DECIMAL_DIGITS = 28;

export interface TypeProblem {
  readonly at: string;
  readonly declared: string;
  readonly because: string;
}

/** PascalCase, from whatever the model wrote. */
export const pascal = (name: string): string =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_.-]+/)
    .filter((w) => w !== "")
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join("");

/** A C# namespace from a 7K package: `shop.orders` under `Acme` is `Acme.Shop.Orders`. */
export const namespaceOf = (pkg: string, root: string): string => {
  const parts = pkg.split(".").filter((p) => p !== "").map(pascal);
  return [root, ...parts].filter((p) => p !== "").join(".");
};

/**
 * A declaration's C# name, as written from inside a given package.
 *
 * Cross-package references are prefixed `global::`, which is ugly and necessary. C# resolves a dotted
 * name by matching its first identifier against each enclosing namespace in turn, so from inside
 * `Acme.Acme.Retail.Sales` the name `Acme.Acme.Retail.Common.Money` binds its leading `Acme` to the
 * *inner* `Acme.Acme` and then fails. A generator cannot know what a root namespace will collide with,
 * and `global::` is the only form whose meaning does not depend on where it is written.
 */
export const qualifiedName = (decl: Decl, ctx: TypeContext): string => {
  const name = pascal(decl.id.name);
  return decl.id.pkg === ctx.pkg
    ? name
    : `global::${namespaceOf(decl.id.pkg, ctx.root)}.${name}`;
};

/** What a reference points at, so a type name can be qualified across packages. */
function referenced(model: LinkedModel, type: Extract<TypeIr, { t: "ref" }>): Decl | undefined {
  return model.declFor(type.ref);
}

export interface TypeContext {
  readonly model: LinkedModel;
  readonly root: string;
  /** The package being written, so a same-package reference needs no qualification. */
  readonly pkg: string;
  /** How a nominal value is rendered: its own wrapper, or the base type it refines. */
  readonly valueTypes: "wrapper" | "alias";
}

/**
 * The C# type for a 7K type.
 *
 * Returns the problems alongside, rather than throwing: a run reports every refusal at once, and a type
 * this provider cannot express is a refusal rather than a crash.
 */
export function csharpType(
  type: TypeIr,
  ctx: TypeContext,
  at: string,
): { readonly text: string; readonly problems: readonly TypeProblem[] } {
  switch (type.t) {
    case "kernel":
      return kernel(type, at);

    case "list": {
      const item = csharpType(type.item, ctx, at);
      return { text: `IReadOnlyList<${item.text}>`, problems: item.problems };
    }

    case "map": {
      const key = csharpType(type.key, ctx, at);
      const value = csharpType(type.value, ctx, at);
      return {
        text: `IReadOnlyDictionary<${key.text}, ${value.text}>`,
        problems: [...key.problems, ...value.problems],
      };
    }

    case "ref": {
      const decl = referenced(ctx.model, type);
      if (decl === undefined) {
        // The model would not have checked, so this is defensive rather than expected.
        return {
          text: "object",
          problems: [
            { at, declared: type.ref.text, because: `\`${type.ref.text}\` does not resolve` },
          ],
        };
      }

      // A value is nominal in 7K. As an alias it becomes its base type, which is a real loss of type
      // safety and is why `wrapper` is the default.
      if (decl.kind === "value" && ctx.valueTypes === "alias") {
        return csharpType(decl.base, ctx, at);
      }

      return { text: qualifiedName(decl, ctx), problems: [] };
    }

    default:
      return {
        text: "object",
        problems: [{ at, declared: type.text, because: "this provider does not know that type" }],
      };
  }
}

function kernel(
  type: Extract<TypeIr, { t: "kernel" }>,
  at: string,
): { text: string; problems: TypeProblem[] } {
  switch (type.name) {
    case "bool":
      return { text: "bool", problems: [] };
    // 7K's `int` is signed 64-bit, so `long` and never `int` — the name is a trap worth not falling into.
    case "int":
      return { text: "long", problems: [] };
    case "float":
      return { text: "double", problems: [] };
    case "string":
      return { text: "string", problems: [] };
    case "bytes":
      return { text: "IReadOnlyList<byte>", problems: [] };
    case "uuid":
      return { text: "Guid", problems: [] };
    // An instant is absolute and UTC. `DateTime` has a kind flag people get wrong; `DateTimeOffset` does
    // not.
    case "instant":
      return { text: "DateTimeOffset", problems: [] };
    case "duration":
      return { text: "TimeSpan", problems: [] };
    case "date":
      return { text: "DateOnly", problems: [] };
    default: {
      const precision = type.precision ?? 0;
      if (precision > CSHARP_DECIMAL_DIGITS) {
        return {
          text: "decimal",
          problems: [
            {
              at,
              declared: `decimal(${precision},${type.scale ?? 0})`,
              because:
                `C#'s \`decimal\` holds ${CSHARP_DECIMAL_DIGITS} significant digits, and this needs ` +
                `${precision}. A \`double\` would round money, so there is no honest type for it here.`,
            },
          ],
        };
      }
      return { text: "decimal", problems: [] };
    }
  }
}

/** A field's C# type, with `?` where the model says optional. */
export function fieldType(
  field: FieldIr,
  ctx: TypeContext,
  at: string,
): { readonly text: string; readonly problems: readonly TypeProblem[] } {
  const base = csharpType(field.type, ctx, `${at}.${field.name}`);
  return { text: field.optional ? `${base.text}?` : base.text, problems: base.problems };
}
