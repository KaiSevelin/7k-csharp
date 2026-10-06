/**
 * Validators.
 *
 * The rules a 7K model states about its data are the part of a model that is complete enough to turn
 * into code without guessing, so these tests are about whether the code says the same thing the model
 * does — and, where it cannot, whether it says *that* instead of quietly saying nothing.
 *
 * The cross-field invariant is the case that earns the feature. `total.currency == lines[].unit.currency`
 * is what JSON Schema records as a loss and what nobody writes by hand, and a generator that skipped it
 * would be generating only the easy half.
 *
 * These check the emitted text. That the emitted text *compiles and behaves* is checked by
 * `npm run verify`, which runs the real C# compiler over the sample models — a thing no amount of string
 * matching can stand in for, and which found five bugs string matching had not.
 */

import { describe, expect, it } from "vitest";
import { buildWorkspace, type Decl, type LinkedModel } from "@sevenk/core";
import { buildNames, compileRules, type Request } from "@sevenk/generate";
import { csharp } from "../src/index.js";

const COMMON = `
package shop.common

enum Status {
  Open
  Shipped
}

value Line    : string { length 1..255 }
value Line60  : Line   { length 1..60 }
value Sku     : string { length 1..24; normalize upper; example "SKU-77" }
value Currency: string { length 3 }
value Code    : string { pattern /^[A-Z]{2}$/ }

// Nothing to check: normalize transforms rather than rejects, and an example is documentation.
value Tag     : string { normalize trim }

record Money {
  amount:   decimal(18,2) { range 0.. }
  currency: Currency
}

// No rules of its own, and none below it either.
record Plain {
  note: string
}

record Named {
  name: Line60
}

record Spread {
  include Named
  extra: string
}
`;

const ORDERS = `
package shop.orders

import shop.common

record OrderLine {
  sku:  common.Sku
  unit: common.Money
}

message PlaceOrder v1.0 @command {
  orderId: uuid @role(businessKey)
  lines:   [OrderLine] { size 1..50 }
  total:   common.Money
  status:  common.Status
  note:    string? { length 1..200 }
  tags:    [string] { unique }
  plain:   common.Plain

  invariant total.currency == lines[].unit.currency
}
`;

const model = (common = COMMON, orders = ORDERS): LinkedModel =>
  buildWorkspace([
    { path: "common.7k", source: common },
    { path: "orders.7k", source: orders },
  ]).model;

function request(
  m: LinkedModel,
  options: Record<string, unknown> = {},
  layout: Request["layout"] = "per-declaration",
  rules: { where: string; [k: string]: unknown }[] = [],
): Request {
  const { names } = buildNames(m, []);
  const compiled = compileRules(m, rules);
  const defaults = { namespace: "Acme", ...options };
  return {
    model: m,
    selected: m.decls,
    names,
    layout,
    options: defaults,
    optionsFor: (decl: Decl) => compiled.resolve(decl, defaults).options,
  };
}

const run = (...args: Parameters<typeof request>) => csharp.generate(request(...args));

const fileNamed = (out: ReturnType<typeof run>, path: string): string =>
  out.artifacts.find((a) => a.path === path)?.content ?? "";

const all = (out: ReturnType<typeof run>): string => out.artifacts.map((a) => a.content).join("\n");

const ORDER = "Acme/Shop/Orders/PlaceOrder.cs";

describe("constraints", () => {
  const out = () => run(model());

  it("checks a bound on a number, open at the top", () => {
    expect(fileNamed(out(), "Acme/Shop/Common/Money.cs")).toContain(
      'if (it.Amount < 0) problems.Add(new Problem("amount", "range 0.."));',
    );
  });

  it("counts characters for `length` and elements for `size`", () => {
    const text = fileNamed(out(), ORDER);
    expect(text).toContain("it.Lines.Count < 1 || it.Lines.Count > 50");
    expect(text).toContain("NoteValue.Length < 1 || NoteValue.Length > 200");
  });

  it("checks an exact `length` as equality, not as a range", () => {
    expect(fileNamed(out(), "Acme/Shop/Common/Currency.cs")).toContain(
      'if (it.Value.Length != 3) problems.Add(new Problem("", "length 3"));',
    );
  });

  it("checks a `pattern` with a regex, keeping the model's own source in the message", () => {
    const text = fileNamed(out(), "Acme/Shop/Common/Code.cs");
    expect(text).toContain('!Regex.IsMatch(it.Value, "^[A-Z]{2}$")');
    expect(text).toContain('"pattern /^[A-Z]{2}$/"');
  });

  it("checks `unique` by counting what is left after dedup", () => {
    expect(fileNamed(out(), ORDER)).toContain("it.Tags.Distinct().Count() != it.Tags.Count");
  });

  it("guards an optional field, because absent is a legal value for it", () => {
    // Checking a `length` on something the model says may be absent would reject a valid message.
    const text = fileNamed(out(), ORDER);
    expect(text).toContain("if (it.Note is { } NoteValue)");
  });

  it("writes no validator for a type whose only constraint transforms rather than rejects", () => {
    // `normalize trim` narrows nothing. An empty `Validate` would read as "checked".
    expect(fileNamed(out(), "Acme/Shop/Common/Tag.cs")).not.toContain("TagValidator");
  });

  it("reaches through a value that refines another value", () => {
    // `Line60 : Line` holds a `Line` struct, not a string, so `.Length` is two hops down — and `Line`'s
    // own rule still binds, so the validator defers to it as well.
    const text = fileNamed(out(), "Acme/Shop/Common/Line60.cs");
    expect(text).toContain("it.Value.Value.Length < 1 || it.Value.Value.Length > 60");
    expect(text).toContain("problems.AddRange(LineValidator.Validate(it.Value));");
  });

  it("validates the fields an `include` splices in", () => {
    // `include` splices rather than nests, so `Spread` carries `name` and its rules come with it.
    expect(fileNamed(out(), "Acme/Shop/Common/Spread.cs")).toContain(
      'Line60Validator.Validate(it.Name).Select(p => p.Under("name"))',
    );
  });
});

describe("the cross-field invariant", () => {
  it("projects over the list and demands every element agree", () => {
    // The reason this exists. `[]` means "for every element", and `All` is what that is in C#.
    expect(fileNamed(run(model()), ORDER)).toContain(
      "it.Lines.All(e => it.Total.Currency == e.Unit.Currency)",
    );
  });

  it("names the rule in the problem, not the word `invariant` on its own", () => {
    // A caller reading `invariant` learns nothing; reading the two paths learns which fields disagree.
    expect(fileNamed(run(model()), ORDER)).toContain(
      '"invariant total.currency == lines[].unit.currency"',
    );
  });

  it("compares two plain paths directly when neither projects", () => {
    const m = model(COMMON, ORDERS.replace("total.currency == lines[].unit.currency", "total.amount == total.amount"));
    expect(fileNamed(run(m), ORDER)).toContain("if (!(it.Total.Amount == it.Total.Amount))");
  });

  it("writes an enum literal as the enum member C# needs", () => {
    // 7K writes `status == "Shipped"`; `"Shipped"` would not compile against an enum.
    const m = model(COMMON, ORDERS.replace('total.currency == lines[].unit.currency', 'status == "Shipped"'));
    expect(fileNamed(run(m), ORDER)).toContain("it.Status == global::Acme.Shop.Common.Status.Shipped");
  });

  it("says so in the code and records a loss when it cannot express one", () => {
    // Two projections in one comparison have no single meaning — pairwise, or all against all — so
    // guessing would be worse than declining. 7K's own checker still holds the rule either way.
    const m = model(
      COMMON,
      ORDERS.replace(
        "invariant total.currency == lines[].unit.currency",
        "invariant lines[].unit.currency == lines[].sku",
      ),
    );
    const out = run(m);
    const text = fileNamed(out, ORDER);
    expect(text).toContain("// 7K: an invariant on PlaceOrder is not checked here");
    expect(text).toContain("projects over two lists at once");
    expect(text).not.toContain("problems.Add(new Problem(\"\", \"invariant");

    const loss = out.artifacts
      .flatMap((a) => a.losses)
      .find((l) => l.construct === "invariant");
    expect(loss?.at).toBe("PlaceOrder");
    expect(loss?.fidelity).toBe("none");
    expect(loss?.detail).toContain("7K's own checker remains");
  });
});

describe("what delegates to what", () => {
  it("defers to a nested validator and reports the path relative to the caller", () => {
    // `MoneyValidator` must not know it was reached through `lines[].unit`, so the caller prefixes.
    const text = fileNamed(run(model()), ORDER);
    expect(text).toContain('MoneyValidator.Validate(it.Total).Select(p => p.Under("total"))');
    expect(text).toContain('foreach (var e in it.Lines) problems.AddRange(OrderLineValidator.Validate(e).Select(p => p.Under("lines[]")));');
  });

  it("never names a validator that was not generated", () => {
    // The bug this prevents is a file that does not compile: `Plain` states no rules, so there is no
    // `PlainValidator` to call, and `PlaceOrder` holds a `Plain`.
    const text = all(run(model()));
    expect(text).not.toContain("PlainValidator");

    const defined = new Set([...text.matchAll(/public static partial class (\w+Validator)/g)].map((m) => m[1]));
    const used = new Set([...text.matchAll(/(\w+Validator)\.Validate/g)].map((m) => m[1]));
    expect([...used].filter((u) => !defined.has(u))).toEqual([]);
  });

  it("gives a record a validator purely because something below it has rules", () => {
    // `Named` constrains nothing itself; it holds a `Line60`, which does.
    expect(fileNamed(run(model()), "Acme/Shop/Common/Named.cs")).toContain("NamedValidator");
  });

  it("qualifies a validator in another package the way the type is qualified", () => {
    expect(fileNamed(run(model()), ORDER)).toContain("global::Acme.Shop.Common.MoneyValidator");
  });
});

describe("the options", () => {
  it("writes none at all when they are turned off", () => {
    const text = all(run(model(), { validators: false }));
    expect(text).not.toContain("Validator");
    expect(text).not.toContain("Problem");
  });

  it("drops only the ones a rule turned off, and stops anything calling them", () => {
    // A selective `validators: false` must not leave a caller referring to what it suppressed.
    const out = run(model(), {}, "per-declaration", [
      { where: "any:shop.common.Money", validators: false },
    ]);
    const text = all(out);
    expect(text).not.toContain("public static partial class MoneyValidator");
    expect(text).not.toContain("MoneyValidator.Validate");
    // The rest still stands, including the invariant, which reads `Money`'s fields rather than its rules.
    expect(text).toContain("it.Lines.All(e => it.Total.Currency == e.Unit.Currency)");
  });

  it("inlines a value's rules when it has no wrapper to hold them", () => {
    // As an alias there is no `Line60` type, so its rules have nowhere to live but the use site.
    // Without this, choosing `alias` would silently drop every rule a value states.
    const text = fileNamed(run(model(), { valueTypes: "alias" }), "Acme/Shop/Common/Named.cs");
    expect(text).toContain("public required string Name { get; init; }");
    expect(text).toContain("it.Name.Length < 1 || it.Name.Length > 60");
    // And the rule it inherits from `Line`, which `alias` would otherwise lose too.
    expect(text).toContain("it.Name.Length < 1 || it.Name.Length > 255");
  });
});

describe("the file a validator needs around it", () => {
  it("adds `using` lines only where they are used", () => {
    const out = run(model());
    // `Currency` checks a length and calls nothing, so neither import belongs in its file.
    const currency = fileNamed(out, "Acme/Shop/Common/Currency.cs");
    expect(currency).not.toContain("using System.Linq;");
    expect(currency).not.toContain("using System.Text.RegularExpressions;");
    expect(fileNamed(out, "Acme/Shop/Common/Code.cs")).toContain(
      "using System.Text.RegularExpressions;",
    );
    expect(fileNamed(out, ORDER)).toContain("using System.Linq;");
  });

  it("aliases `Problem` rather than writing the root namespace into every body", () => {
    // Written out, `Acme.Problem` inside `Acme.Shop.Orders` would bind its leading `Acme` to the
    // nearest enclosing match and could fail. `global::` in the alias settles it once.
    expect(fileNamed(run(model()), ORDER)).toContain(
      "using Problem = global::Acme.Problem;",
    );
  });

  it("writes the shared type once, and not at all when nothing validates", () => {
    const out = run(model());
    expect(fileNamed(out, "Acme/Validation.cs")).toContain(
      "public readonly record struct Problem(string Path, string Rule)",
    );
    // Turning validators off removes `Problem`, which is the validators' own. The JSON and equality
    // support stand on their own and are not affected.
    expect(run(model(), { validators: false }).artifacts.map((a) => a.path)).not.toContain(
      "Acme/Validation.cs",
    );
  });

  it("folds it into the one file under `single`, which promised one file", () => {
    const out = run(model(), {}, "single");
    expect(out.artifacts).toHaveLength(1);
    expect(out.artifacts[0]!.content).toContain("namespace Acme");
    expect(out.artifacts[0]!.content).toContain("record struct Problem");
  });

  it("puts it somewhere no package can collide with when there is no root", () => {
    // A 7K package name is lowercase, so `SevenK` is a name a model cannot take.
    const out = run(model(), { namespace: "" });
    expect(out.artifacts.map((a) => a.path)).toContain("SevenK/Validation.cs");
    expect(fileNamed(out, "Shop/Orders/PlaceOrder.cs")).toContain(
      "using Problem = global::SevenK.Problem;",
    );
  });

  it("claims no provenance for it, because no declaration produced it", () => {
    expect(fileNamed(run(model()), "Acme/Validation.cs")).not.toBe("");
    expect(run(model()).artifacts.find((a) => a.path === "Acme/Validation.cs")?.from).toEqual([]);
  });
});

describe("what C# will not accept", () => {
  it("refuses a field whose name collides with its own type, rather than renaming it", () => {
    // C# forbids a member named as its enclosing type (CS0542) and 7K permits `record Seat { seat: … }`.
    // Renaming the property would move the breakage to the serializer, where the wire name is decided.
    const out = run(
      model(`${COMMON}\nrecord Seat {\n  seat: Line\n}\n`),
    );
    const refusal = out.refusals.find((r) => r.at.endsWith("Seat"));
    expect(refusal?.because).toContain("forbids a member whose name matches its enclosing type");
    expect(out.artifacts.map((a) => a.path)).not.toContain("Acme/Shop/Common/Seat.cs");
  });
});

describe("collections", () => {
  // A map's keys carry rules as much as its values do, and 7K allows a collection inside a collection.
  const MAPS = `
package shop.maps

value Code   : string { length 2 }
value Amount : int    { range 0..10 }

record Holder {
  byCode: map<Code, Amount>
  deep:   [[Amount]]
  loose:  map<string, string>
}
`;
  const out = () => csharp.generate(request(buildWorkspace([{ path: "m.7k", source: MAPS }]).model));
  const holder = () => fileNamed(out(), "Acme/Shop/Maps/Holder.cs");

  it("validates a map's keys and its values, at paths that tell them apart", () => {
    const text = holder();
    expect(text).toContain("foreach (var e in it.ByCode)");
    expect(text).toContain('CodeValidator.Validate(e.Key).Select(p => p.Under("byCode[key]"))');
    expect(text).toContain('AmountValidator.Validate(e.Value).Select(p => p.Under("byCode[]"))');
  });

  it("gives a record a validator for a map alone, so the rules in it are not lost", () => {
    // Before maps were reached through, `Holder` got no validator at all and nothing said why.
    expect(holder()).toContain("public static partial class HolderValidator");
  });

  it("says so rather than guessing at a collection inside a collection", () => {
    // One `foreach` over a list of lists would compile against the wrong thing, or not at all.
    const text = holder();
    expect(text).toContain("// 7K: the rules inside `deep` are not checked here");
    expect(text).toContain("nests a list inside a list");

    const loss = out().artifacts.flatMap((a) => a.losses).find((l) => l.at === "Holder.deep");
    expect(loss?.fidelity).toBe("none");
  });

  it("says nothing about a map of kernel types, which carries no rules to lose", () => {
    expect(holder()).not.toContain("it.Loose");
  });
});
