/**
 * The style options, and the two defects they came out of.
 *
 * Three of the things tested here were not options at first — they were wrong. A nominal value nested
 * when it serialised, a record holding a list compared two identical messages as unequal, and a
 * generated type could not be extended although its own header said to extend it. Those are fixed
 * rather than offered, and the tests for them read as facts about the output and not as choices.
 *
 * Whether the canonical encoding is *correct* is not something a string match can establish, so
 * `npm run verify` serialises a sample with the real `System.Text.Json`, compares the bytes, reads it
 * back and compares the value. These tests are about what the generator decides to emit.
 */

import { describe, expect, it } from "vitest";
import { buildWorkspace, type Decl, type LinkedModel } from "@sevenk/core";
import { buildNames, compileRules, type Request } from "@sevenk/generate";
import { csharp } from "../src/index.js";

const MODEL = `
package shop

enum Status {
  Open
  Shipped
}

value Sku      : string { length 1..24 }
value Money    : decimal(18,2) { range 0.. }
value Blob     : bytes
value Currency : string { length 3 }

record Line {
  sku: Sku
  qty: int
}

message PlaceOrder v1.0 @command {
  orderId:  uuid @role(businessKey)
  lines:    [Line] { size 1..50 }
  total:    Money
  currency: Currency
  tags:     map<Currency, Money>
  stamped:  instant
  held:     duration
  blob:     bytes
  note:     string? { length 1..200 }
  status:   Status
  // A bare decimal, which carries its scale on the field rather than on a value type.
  rate:     decimal(9,4) { range 0..1 }
  // A constrained field whose type is a nominal wrapper, which an attribute cannot measure.
  code:     Sku { length 1..10 }

  invariant total == total
}

pipe inbound : queue { delivery at-least-once }

service Desk {
  reacts PlaceOrder from inbound { replies none }
}
`;

const model = (source = MODEL): LinkedModel =>
  buildWorkspace([{ path: "shop.7k", source }]).model;

function request(m: LinkedModel, options: Record<string, unknown> = {}): Request {
  const { names } = buildNames(m, []);
  const compiled = compileRules(m, []);
  const defaults = { namespace: "Acme", ...options };
  return {
    model: m,
    selected: m.decls,
    names,
    layout: "per-declaration",
    options: defaults,
    optionsFor: (decl: Decl) => compiled.resolve(decl, defaults).options,
  };
}

const run = (...args: Parameters<typeof request>) => csharp.generate(request(...args));

const fileNamed = (out: ReturnType<typeof run>, path: string): string =>
  out.artifacts.find((a) => a.path === path)?.content ?? "";

const ORDER = "Acme/Shop/PlaceOrder.cs";
const order = (options: Record<string, unknown> = {}) => fileNamed(run(model(), options), ORDER);

describe("being extensible, which the header already promised", () => {
  it("makes every generated type partial", () => {
    // "Write what the model does not describe beside it, not inside it" — and without `partial` you
    // cannot. Adding a computed property in a sibling file was CS0260.
    const out = run(model());
    expect(order()).toContain("public sealed partial record PlaceOrder");
    expect(fileNamed(out, "Acme/Shop/Sku.cs")).toContain("public readonly partial record struct Sku");
    expect(fileNamed(out, "Acme/Shop/Line.cs")).toContain("public static partial class LineValidator");
  });
});

describe("value equality, which a record is chosen for", () => {
  it("compares a list by its contents", () => {
    // The compiler compares `IReadOnlyList<T>` by reference, so two identical messages are unequal and
    // a `HashSet` holds both. `ImmutableArray<T>` does not fix it either — its own equality is by
    // reference too — so the comparison is generated.
    const text = order();
    expect(text).toContain("public bool Equals(PlaceOrder? other) =>");
    expect(text).toContain("&& Structural.Same(Lines, other.Lines)");
    expect(text).toContain("&& Structural.SameMap(Tags, other.Tags)");
    expect(text).toContain("hash.Add(Structural.HashOf(Lines));");
  });

  it("treats `bytes` as the collection it becomes, whatever the model calls it", () => {
    // 7K's `bytes` is a kernel scalar and an `IReadOnlyList<byte>` here, so it compares by reference
    // like any other list. Missing that is exactly the bug this exists to fix, one level in.
    expect(order()).toContain("&& Structural.Same(Blob, other.Blob)");
  });

  it("fixes a nominal value over a collection on the wrapper, not at each use", () => {
    // `value Blob : bytes` is a record struct whose synthesized equality compares its field by
    // reference, so every record holding one would inherit the problem.
    const text = fileNamed(run(model()), "Acme/Shop/Blob.cs");
    expect(text).toContain("public bool Equals(Blob other) => Structural.Same(Value, other.Value);");
    expect(text).toContain("public override int GetHashCode() => Structural.HashOf(Value);");
  });

  it("writes nothing for a record whose every field is a scalar", () => {
    // The compiler already does the right thing there, and a hand-written copy of it would be one
    // more thing to drift.
    expect(fileNamed(run(model()), "Acme/Shop/Line.cs")).not.toContain("public bool Equals(Line?");
  });

  it("omits an implicit conversion C# will not accept", () => {
    // CS0552: a user-defined conversion to an interface is forbidden, and `bytes` becomes one.
    const text = fileNamed(run(model()), "Acme/Shop/Blob.cs");
    expect(text).not.toContain("implicit operator IReadOnlyList<byte>");
    expect(text).toContain("No implicit conversion");
  });
});

describe("canonical JSON", () => {
  it("names a field as the contract names it, not as C# cases it", () => {
    // On the type rather than in a host's options, so a payload is canonical whoever serialises it.
    expect(order()).toContain('[JsonPropertyName("orderId")]');
  });

  it("writes a decimal as a string with its declared scale", () => {
    // Never a JSON number: that is a double, and money must not round-trip through one.
    expect(fileNamed(run(model()), "Acme/Shop/Money.cs")).toContain(
      "writer.WriteStringValue(global::Acme.Decimals.Text(value.Value, 2))",
    );
  });

  it("collapses a nominal value rather than nesting it in an object", () => {
    const text = fileNamed(run(model()), "Acme/Shop/Sku.cs");
    expect(text).toContain("public sealed class SkuJsonConverter : JsonConverter<Sku>");
    expect(text).toContain("[JsonConverter(typeof(SkuJsonConverter))]");
    expect(text).toContain("writer.WriteStringValue(value.Value)");
  });

  it("writes an enum member by the name the model declares", () => {
    // `JsonStringEnumConverter` would write the *C#* name, which is this provider's PascalCase of the
    // 7K one — so a model spelling a member otherwise would encode something the contract never says.
    const text = fileNamed(run(model()), "Acme/Shop/Status.cs");
    expect(text).toContain('"Shipped" => Status.Shipped,');
    expect(text).toContain("is not a member of `Status`");
  });

  it("attaches the kernel encodings a serialiser would otherwise get wrong", () => {
    const text = order();
    expect(text).toContain("[global::Acme.SevenKDecimal(4)]");
    expect(text).toContain("[JsonConverter(typeof(global::Acme.BytesConverter))]");
    expect(text).toContain("[JsonConverter(typeof(global::Acme.InstantConverter))]");
    expect(text).toContain("[JsonConverter(typeof(global::Acme.DurationConverter))]");
  });

  it("qualifies the support absolutely, which is not optional with a nested root", () => {
    // From inside `Shop`, a bare `BytesConverter` does not resolve when the root is not an ancestor.
    const bare = fileNamed(run(model(), { namespace: "" }), "Shop/PlaceOrder.cs");
    expect(bare).toContain("typeof(global::SevenK.BytesConverter)");
  });

  it("offers the one rule an attribute cannot carry", () => {
    // An absent optional field has its key omitted, and `null` is never valid input.
    expect(fileNamed(run(model()), "Acme/Json.cs")).toContain(
      "DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,",
    );
  });

  it("emits none of it when asked for none", () => {
    const text = order({ serialization: "none" });
    expect(text).not.toContain("JsonPropertyName");
    expect(run(model(), { serialization: "none" }).artifacts.map((a) => a.path)).not.toContain(
      "Acme/Json.cs",
    );
  });
});

describe("validatorStyle", () => {
  it("defaults to the method, which expresses every rule", () => {
    const text = order();
    expect(text).toContain("public static partial class PlaceOrderValidator");
    expect(text).not.toContain("[StringLength");
  });

  it("emits DataAnnotations where asked, which model binding applies for free", () => {
    const text = order({ validatorStyle: "annotations" });
    expect(text).toContain("[Required]");
    expect(text).toContain("using System.ComponentModel.DataAnnotations;");
    // The attributes are the whole of what is emitted in this mode.
    expect(text).not.toContain("public static partial class PlaceOrderValidator");
  });

  it("records a loss per invariant, because an attribute decorates one property", () => {
    const losses = run(model(), { validatorStyle: "annotations" })
      .artifacts.flatMap((a) => a.losses)
      .filter((l) => l.construct === "invariant");
    expect(losses.length).toBeGreaterThan(0);
    expect(losses[0]?.detail).toContain("relates more than one");
    expect(losses[0]?.detail).toContain("`both`");
  });

  it("keeps both where asked, so the edge is convenient and the check is complete", () => {
    const text = order({ validatorStyle: "both" });
    expect(text).toContain("[Required]");
    expect(text).toContain("public static partial class PlaceOrderValidator");
  });

  it("says nothing it cannot measure, and records that too", () => {
    // An attribute reads the property, and a wrapper struct is not the string it would measure.
    const text = order({ validatorStyle: "annotations" });
    expect(text).not.toContain("[StringLength(24");
    const loss = run(model(), { validatorStyle: "annotations" })
      .artifacts.flatMap((a) => a.losses)
      .find((l) => l.construct === "constraint");
    expect(loss?.detail).toContain("model binding does not");
  });
});

describe("asyncSuffix", () => {
  it("follows the .NET convention for a Task-returning method", () => {
    expect(fileNamed(run(model()), "Acme/Shop/Desk.cs")).toContain("HandlePlaceOrderAsync(");
  });

  it("drops it where a codebase would rather not have it", () => {
    const text = fileNamed(run(model(), { asyncSuffix: false }), "Acme/Shop/Desk.cs");
    expect(text).toContain("HandlePlaceOrder(");
    expect(text).not.toContain("HandlePlaceOrderAsync(");
  });
});

describe("messageType", () => {
  it("defaults to required init-only properties", () => {
    expect(order()).toContain("public required Money Total { get; init; }");
  });

  it("writes a primary constructor where asked, with the attributes targeted at the property", () => {
    // A parameter and the property it becomes are two places an attribute could land, and the
    // compiler will not guess.
    const text = order({ messageType: "positional" });
    expect(text).toContain("public sealed partial record PlaceOrder(");
    expect(text).toContain('[property: JsonPropertyName("orderId")] Guid OrderId,');
  });

  it("documents every parameter, because documenting some is an error", () => {
    // CS1573 fires as soon as one parameter has a `<param>` tag and another does not.
    const text = order({ messageType: "positional" });
    expect(text).toContain('<param name="OrderId">');
    expect(text).toContain('<param name="Total">');
  });

  it("constructs one positionally where a saga sends it", () => {
    // An object initializer does not work on a primary constructor, so the saga has to know the shape
    // of the messages it sends — not just of the ones it is generated beside.
    const SAGA = `${MODEL}
message Charge v1.0 @command { orderId: uuid @role(businessKey); total: Money }
message Charged v1.0 @event { orderId: uuid @role(businessKey) }
message Done v1.0 @event { orderId: uuid @role(businessKey) }

saga Flow v1.0 {
  start on PlaceOrder keyed by orderId { total = message.total }
  state { total: Money }
  step pay {
    send Charge
    on Charged
    on timeout 30s reject "slow"
  }
  on complete send Done
}
`.replace("service Desk {\n  reacts PlaceOrder from inbound { replies none }\n}",
      "service Desk {\n  emits Charge to inbound\n  emits Done to inbound\n  reacts PlaceOrder from inbound { replies none }\n  reacts Charged from inbound { replies none }\n}");

    const text = fileNamed(run(model(SAGA), { messageType: "positional" }), "Acme/Shop/Flow.cs");
    expect(text).toContain("new global::Acme.Shop.Charge(");
    expect(text).toContain("// orderId");
    expect(text).not.toContain("new global::Acme.Shop.Charge\n");
  });

  it("writes a class where a framework insists on one", () => {
    const text = order({ messageType: "class" });
    expect(text).toContain("public sealed partial class PlaceOrder");
    // A class has no synthesized equality, so there is nothing to correct.
    expect(text).not.toContain("public bool Equals(PlaceOrder?");
  });
});
