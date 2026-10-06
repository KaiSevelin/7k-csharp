/**
 * Value equality for a record that holds a collection.
 *
 * A `record` is generated for 7K's messages because a message *is* a value: two with the same contents
 * are the same message, and that is what a record's synthesized equality gives you. Except that it does
 * not, for any record holding a list or a map — the compiler compares those fields by reference, so two
 * identical `PlaceOrder`s are unequal, and a `HashSet` of them holds both.
 *
 * That is a silent trap in the single thing a record was chosen for. It is also not fixable by choosing
 * a different collection type: `ImmutableArray<T>` compares its underlying array by reference too, which
 * is worth saying out loud because it is the first thing anybody tries.
 *
 * So the equality is generated, element by element, for exactly the records that need it. A record whose
 * every field is a scalar gets nothing, because the compiler already does the right thing there and a
 * hand-written copy of it would be one more thing to drift.
 */

import type { Decl, FieldIr, TypeIr } from "@sevenk/core";
import { pascal, type TypeContext } from "./types.js";

/** Where the shared comparison helpers live. */
export const EQUALITY_SUPPORT: readonly string[] = [
  "/// <summary>",
  "/// Comparing collections by their contents, which is what a value type needs and what the",
  "/// compiler's own record equality does not do.",
  "/// </summary>",
  "public static class Structural",
  "{",
  "    /// <summary>Two scalars, without assuming either is non-null.</summary>",
  "    public static bool Equal<T>(T? a, T? b) => EqualityComparer<T?>.Default.Equals(a, b);",
  "",
  "    /// <summary>Two sequences, element by element and in order.</summary>",
  "    public static bool Same<T>(IReadOnlyList<T>? a, IReadOnlyList<T>? b)",
  "    {",
  "        if (ReferenceEquals(a, b)) return true;",
  "        if (a is null || b is null || a.Count != b.Count) return false;",
  "        for (var i = 0; i < a.Count; i++)",
  "        {",
  "            if (!EqualityComparer<T>.Default.Equals(a[i], b[i])) return false;",
  "        }",
  "        return true;",
  "    }",
  "",
  "    /// <summary>Two maps, by key and value. Order is not part of a map's identity.</summary>",
  "    public static bool SameMap<TKey, TValue>(",
  "        IReadOnlyDictionary<TKey, TValue>? a,",
  "        IReadOnlyDictionary<TKey, TValue>? b)",
  "        where TKey : notnull",
  "    {",
  "        if (ReferenceEquals(a, b)) return true;",
  "        if (a is null || b is null || a.Count != b.Count) return false;",
  "        foreach (var pair in a)",
  "        {",
  "            if (!b.TryGetValue(pair.Key, out var other)) return false;",
  "            if (!EqualityComparer<TValue>.Default.Equals(pair.Value, other)) return false;",
  "        }",
  "        return true;",
  "    }",
  "",
  "    /// <summary>A sequence's hash, which has to agree with `Same` to be of any use.</summary>",
  "    public static int HashOf<T>(IReadOnlyList<T>? items)",
  "    {",
  "        if (items is null) return 0;",
  "        var hash = new HashCode();",
  "        hash.Add(items.Count);",
  "        foreach (var item in items) hash.Add(item);",
  "        return hash.ToHashCode();",
  "    }",
  "",
  "    /// <summary>A map's hash, combined so that it does not depend on enumeration order.</summary>",
  "    public static int HashOfMap<TKey, TValue>(IReadOnlyDictionary<TKey, TValue>? items)",
  "        where TKey : notnull",
  "    {",
  "        if (items is null) return 0;",
  "        var combined = items.Count;",
  "        foreach (var pair in items)",
  "        {",
  "            combined ^= HashCode.Combine(pair.Key, pair.Value);",
  "        }",
  "        return combined;",
  "    }",
  "}",
];

/**
 * How a field would be compared by the compiler, which is a question about the *C# type*.
 *
 * 7K's `bytes` is a kernel scalar and becomes an `IReadOnlyList<byte>`, so it is a collection here
 * however the model classifies it. Getting that wrong is exactly the bug this module exists to fix,
 * one level further in.
 */
export type Comparison = "scalar" | "sequence" | "map";

export function comparisonOf(type: TypeIr, ctx: TypeContext): Comparison {
  if (type.t === "list") return "sequence";
  if (type.t === "map") return "map";
  if (type.t === "kernel") return type.name === "bytes" ? "sequence" : "scalar";
  if (type.t === "ref") {
    const decl = ctx.model.declFor(type.ref);
    // As an alias the field *is* the refined type. As a wrapper it is a struct with its own
    // equality, which `valueEqualityFor` fixes there rather than here.
    if (decl?.kind === "value" && ctx.valueTypes === "alias") return comparisonOf(decl.base, ctx);
  }
  return "scalar";
}

const CALL: Readonly<Record<Comparison, { same: string; hash: string }>> = {
  scalar: { same: "Structural.Equal", hash: "" },
  sequence: { same: "Structural.Same", hash: "Structural.HashOf" },
  map: { same: "Structural.SameMap", hash: "Structural.HashOfMap" },
};

export interface Equality {
  readonly lines: readonly string[];
  /** Whether anything here mentions `Structural`. */
  readonly needed: boolean;
}

/**
 * `Equals` and `GetHashCode` for one record, where it holds anything the compiler would get wrong.
 *
 * Declared on a `sealed` record, so there is no derived type whose equality contract this would have to
 * respect — which is why one method is enough and no `EqualityContract` dance is needed.
 */
export function equalityFor(
  decl: Decl,
  fields: readonly FieldIr[],
  ctx: TypeContext,
): Equality | undefined {
  if (fields.every((f) => comparisonOf(f.type, ctx) === "scalar")) {
    return { lines: [], needed: false };
  }

  const name = pascal(decl.id.name);
  const compare = fields.map((field) => {
    const property = pascal(field.name);
    const call = CALL[comparisonOf(field.type, ctx)];
    return `${call.same}(${property}, other.${property})`;
  });

  const hash = fields.map((field) => {
    const property = pascal(field.name);
    const call = CALL[comparisonOf(field.type, ctx)];
    return call.hash === "" ? `hash.Add(${property});` : `hash.Add(${call.hash}(${property}));`;
  });

  return {
    needed: true,
    lines: [
      "",
      "/// <summary>",
      "/// By contents, including the collections the compiler's own record equality would have",
      "/// compared by reference.",
      "/// </summary>",
      `public bool Equals(${name}? other) =>`,
      ...["other is not null", ...compare.map((c) => `&& ${c}`)].map((l, i) =>
        i === compare.length ? `    ${l};` : `    ${l}`,
      ),
      "",
      "/// <summary>Agrees with the equality above, element by element.</summary>",
      "public override int GetHashCode()",
      "{",
      "    var hash = new HashCode();",
      ...hash.map((h) => `    ${h}`),
      "    return hash.ToHashCode();",
      "}",
    ],
  };
}

/**
 * The same fix, for a nominal value that refines a collection.
 *
 * `value Payload : bytes` becomes a `readonly record struct` wrapping an `IReadOnlyList<byte>`, and a
 * record struct's synthesized equality compares that field by reference exactly as a record class
 * would. So two `Payload`s over equal bytes are unequal, and every record holding one inherits the
 * problem — which is why this is fixed on the wrapper rather than at each use.
 */
export function valueEqualityFor(
  decl: Decl,
  base: TypeIr,
  ctx: TypeContext,
): Equality | undefined {
  const comparison = comparisonOf(base, ctx);
  if (comparison === "scalar") return { lines: [], needed: false };

  const name = pascal(decl.id.name);
  const call = CALL[comparison];

  return {
    needed: true,
    lines: [
      "",
      "/// <summary>",
      "/// By contents. What this refines is a collection, which the compiler's own equality for a",
      "/// record struct would have compared by reference.",
      "/// </summary>",
      `public bool Equals(${name} other) => ${call.same}(Value, other.Value);`,
      "",
      "/// <summary>Agrees with the equality above.</summary>",
      `public override int GetHashCode() => ${call.hash}(Value);`,
    ],
  };
}
