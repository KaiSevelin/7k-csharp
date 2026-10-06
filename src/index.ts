/**
 * A C# provider for 7K.
 *
 * Its own repository, because D48 puts implementations outside the language: 7K states what the system
 * must do, and this says whether C# can. It reads the IR through `@sevenk/core` and owns every
 * decision about what the code looks like.
 *
 * **There is more than one good way to write a message in C#**, so the shape is an option rather than a
 * house style — a `record` for most people, a `class` for anyone whose serializer or framework wants
 * one, and either may be chosen per declaration when one message is awkward.
 *
 * **What it will not do is weaken anything.** A `decimal(38,4)` has no exact C# type, so it is refused
 * rather than quietly widened to a `double`; under `--draft` the refusal is emitted as a `#error`, so the
 * gap travels with the code and a partial build cannot be mistaken for a finished one.
 *
 * **It stops at the interface.** The Data layer is described completely enough to generate — types, and
 * a validator for every rule stated about them, including the cross-field invariants a schema language
 * cannot express. A service is not: the model describes its interface and never its internals
 * (`03-topology.md` 2.0), so a service becomes an interface, every constraint the model places on it as
 * a comment, and a `TODO` for the decision the model cannot make. There is no generated body, because
 * there is nothing to generate one from.
 *
 * **A saga is the exception, and it is not one.** `04-process.md` states the whole of a process — what
 * starts it, what each step sends and awaits, what every outcome does, what reverses it — so a saga
 * becomes a state machine rather than an interface. That is still generating what the model says; it is
 * only that a saga says more. The machine is pure, and `npm run equivalence` drives it and the sandbox's
 * own saga engine from one script to check they decide the same things.
 */

import {
  flatFieldsOf,
  type Decl,
  type EnumIr,
  type FieldIr,
  type MessageIr,
  type RecordIr,
  type ValueIr,
} from "@sevenk/core";
import type {
  Artifact,
  Generated,
  Loss,
  OptionSpec,
  Provider,
  Refusal,
  Request,
} from "@sevenk/provider";
import { fieldType, namespaceOf, pascal, type TypeContext, type TypeProblem } from "./types.js";
import { EQUALITY_SUPPORT, comparisonOf, equalityFor, valueEqualityFor } from "./equality.js";
import {
  JSON_SUPPORT,
  JSON_SUPPORT_USINGS,
  JSON_USINGS,
  converterAttribute,
  enumConverter,
  fieldAttributes,
  valueConverter,
} from "./json.js";
import { escapeXml, handlersFor } from "./handlers.js";
import { SAGA_SUPPORT, machineFor } from "./saga.js";
import {
  ANNOTATION_USINGS,
  SUPPORT,
  annotationLosses,
  annotationsFor,
  supportNamespace,
  validatorFor,
  validatorsIn,
} from "./validate.js";

const OPTIONS: readonly OptionSpec[] = [
  {
    name: "namespace",
    describe: "Root namespace. A package's own name is appended: `Acme` gives `Acme.Shop.Orders`.",
    type: "string",
    default: "",
    scope: "entry",
  },
  {
    name: "messageType",
    describe:
      "`record` has required init-only properties. `positional` is a primary constructor, which deconstructs and makes a new field break every construction site — arguably what a versioned contract wants. `class` is for a framework that insists on one.",
    type: "enum",
    of: ["record", "positional", "class"],
    default: "record",
    scope: "declaration",
  },
  {
    name: "valueTypes",
    describe:
      "Whether a 7K value becomes its own wrapper type, keeping it nominal, or an alias for the type it refines.",
    type: "enum",
    of: ["wrapper", "alias"],
    default: "wrapper",
    scope: "declaration",
  },
  {
    name: "nullable",
    describe: "Emit `#nullable enable`, so an optional field is a nullable reference type.",
    type: "boolean",
    default: true,
    scope: "entry",
  },
  {
    name: "serialization",
    describe:
      "Emit the attributes and converters that make a type produce canonical 7K JSON (`01-kernel.md` 7). Without them a nominal value nests, a decimal writes as a number and an enum writes its index.",
    type: "enum",
    of: ["system-text-json", "none"],
    default: "system-text-json",
    scope: "entry",
  },
  {
    name: "validators",
    describe:
      "Emit a `XValidator.Validate` beside each type, checking the constraints and invariants the model states.",
    type: "boolean",
    default: true,
    scope: "declaration",
  },
  {
    name: "asyncSuffix",
    describe:
      "Name a `Task`-returning handler `HandleChargeCardAsync`, which is the .NET convention and what an analyzer will insist on.",
    type: "boolean",
    default: true,
    scope: "entry",
  },
  {
    name: "validatorStyle",
    describe:
      "`methods` is the generated `Validate`, which expresses every rule. `annotations` is DataAnnotations, which ASP.NET model binding applies for free but cannot express a cross-field invariant. `both` keeps the edge convenient and the check complete.",
    type: "enum",
    of: ["methods", "annotations", "both"],
    default: "methods",
    scope: "declaration",
  },
];

const HEADER = [
  "// <auto-generated>",
  "//   Generated from a 7K model. Do not edit: this file is owned by the generator and is replaced",
  "//   wholesale on the next run. Write what the model does not describe beside it, not inside it.",
  "// </auto-generated>",
  "",
  // A record's positional constructor and its compiler-synthesized members have nowhere to carry a
  // doc comment, so a project with `GenerateDocumentationFile` would fail on this file for want of
  // documentation nobody can write. What the model does say is said, above.
  "#pragma warning disable CS1591 // Missing XML comment for publicly visible type or member",
];

/**
 * A constraint as the model writes it: `length 1..200`, `normalize trim, collapseSpace`.
 *
 * The bounds arrive as separate tokens (`["1", "..", "200"]`) and a list of normalizations as separate
 * arguments, which is why the two join differently.
 */
const constraintText = (constraint: { name: string; args: readonly string[] }): string =>
  `${constraint.name} ${constraint.args.includes("..") ? constraint.args.join("") : constraint.args.join(", ")}`.trim();

const summary = (text: string): string[] => [`/// <summary>${escapeXml(text)}</summary>`];

/**
 * What a declaration is, in one line.
 *
 * Worth generating because 7K keeps no prose of its own: there is no comment in the IR to carry across,
 * so the only true thing to say is what the model structurally declares — and a reader hovering over
 * `PlaceOrder` in an editor is better served by "a command, v1.0" than by nothing.
 */
function summaryOf(decl: Decl): string[] {
  switch (decl.kind) {
    case "message": {
      const intent =
        decl.intent === "command"
          ? "A command: it instructs, and may be refused."
          : decl.intent === "event"
            ? "An event: it states something that already happened."
            : decl.intent === "query"
              ? "A query: it asks, changes nothing, and carries no deduplication key."
              : "The model declares no intent for it.";
      const scope =
        decl.visibility.kind === "internal"
          ? ` Internal to \`${decl.visibility.scope === "" ? decl.id.pkg : decl.visibility.scope}\`.`
          : "";
      return summary(
        `The \`${qualified(decl)}\` message${decl.version === undefined ? "" : `, v${decl.version}`}. ${intent}${scope}`,
      );
    }
    case "record":
      return summary(`The \`${qualified(decl)}\` record.`);
    case "envelope":
      return summary(
        `The \`${qualified(decl)}\` envelope, carried by every message in \`${decl.id.pkg}\`.`,
      );
    case "enum":
      return summary(`The \`${qualified(decl)}\` enumeration.`);
    case "value": {
      const rules = decl.constraints.map(constraintText);
      return summary(
        `\`${qualified(decl)}\`, a nominal type of its own rather than the value it refines.` +
          (rules.length === 0 ? "" : ` The model constrains it: ${rules.join("; ")}.`),
      );
    }
    default:
      return [];
  }
}

/**
 * A field, where the model says something about it beyond its type.
 *
 * Only where there is something: a summary restating the field's own name is noise in an editor, and
 * noise is what teaches people to stop reading generated documentation. The constraints are the part
 * worth surfacing — `length 1..24` where somebody is about to assign to it.
 */
function summaryOfField(field: FieldIr): string[] {
  const rules = field.constraints.map(constraintText);
  // `@role(...)` is its own field on `FieldIr`, not a label: `labels` is what is left after the
  // parser has taken `role`, `derive`, `since` and `deprecated` out of the annotations.
  const role = field.role;
  const parts = [
    ...(role === undefined ? [] : [`\`@role(${role})\`.`]),
    ...(field.optional ? ["Optional: absent is a legal value."] : []),
    ...(rules.length === 0 ? [] : [`${rules.join("; ")}`]),
  ];
  // Joined, not collapsed: `range 0..` legitimately ends in two dots and a tidy-up pass over the
  // whole sentence turned it into `range 0.`, which says something the model does not.
  if (parts.length === 0) return [];
  const sentence = parts.join(" ");
  return summary(sentence.endsWith(".") ? sentence : `${sentence}.`);
}

/** How a message's fields are declared. */
type Shape = "record" | "positional" | "class";

const NEWLINE = String.fromCharCode(10);

const indent = (lines: readonly string[]): string[] => lines.map((l) => (l === "" ? "" : `    ${l}`));

/** What a declaration contributes, before it is grouped into files. */
/** A qualified name, which is what provenance is reported in. */
const qualified = (decl: Decl): string =>
  decl.id.pkg === "" ? decl.id.name : `${decl.id.pkg}.${decl.id.name}`;

interface Emitted {
  readonly decl: Decl;
  readonly pkg: string;
  readonly name: string;
  readonly lines: readonly string[];
  readonly problems: readonly TypeProblem[];
  /** What the model states that the generated code does not express. */
  readonly losses: readonly Loss[];
  readonly needs: Needs;
}

/**
 * Which `using` lines a file turns out to need.
 *
 * Accumulated from what was actually emitted rather than declared up front, because an unused `using`
 * in generated code is the kind of warning that gets a whole directory excluded from analysis.
 */
interface Needs {
  readonly linq: boolean;
  readonly regex: boolean;
  /** Whether anything in the file mentions `Problem`, which lives in the root namespace. */
  readonly problem: boolean;
  /** Whether anything returns a `Task` or takes a `CancellationToken`. */
  readonly async: boolean;
  /** Whether anything mentions `SagaEffect` or `SagaStatus`. */
  readonly saga: boolean;
  /** Whether anything mentions `Structural`. */
  readonly structural: boolean;
  /** Whether anything carries a JSON attribute or converter. */
  readonly json: boolean;
  /** Whether the file *is* the JSON support, which needs more than a generated type does. */
  readonly jsonSupport: boolean;
  /** Whether anything carries a DataAnnotations attribute. */
  readonly annotations: boolean;
}

const NO_NEEDS: Needs = {
  linq: false,
  regex: false,
  problem: false,
  async: false,
  saga: false,
  structural: false,
  json: false,
  jsonSupport: false,
  annotations: false,
};

const both = (a: Needs, b: Needs): Needs => ({
  linq: a.linq || b.linq,
  regex: a.regex || b.regex,
  problem: a.problem || b.problem,
  async: a.async || b.async,
  saga: a.saga || b.saga,
  structural: a.structural || b.structural,
  json: a.json || b.json,
  jsonSupport: a.jsonSupport || b.jsonSupport,
  annotations: a.annotations || b.annotations,
});

function emitEnum(decl: EnumIr, json: boolean, ctx: TypeContext): string[] {
  return [
    ...(json ? enumConverter(decl, ctx) : []),
    ...(json ? [""] : []),
    ...summaryOf(decl),
    ...(json ? converterAttribute(decl) : []),
    `public enum ${pascal(decl.id.name)}`,
    "{",
    ...indent(decl.members.map((m, i) => `${pascal(m.name)}${i < decl.members.length - 1 ? "," : ""}`)),
    "}",
  ];
}

/**
 * A nominal value as a wrapper.
 *
 * A `readonly record struct` rather than a class: it is one field, it is compared by value, and a
 * reference type would allocate for every post code in the system. The implicit conversion *out* is
 * provided and the conversion *in* is not — taking a `string` where an `EmailAddress` is meant is the
 * mistake the wrapper exists to prevent.
 */
function emitValue(
  decl: ValueIr,
  ctx: TypeContext,
  json: boolean,
  support: string,
): { lines: string[]; structural: boolean } {
  const base = fieldType(
    { name: "value", type: decl.base, optional: false, constraints: [], labels: [], span: decl.span },
    ctx,
    decl.id.name,
  );
  const name = pascal(decl.id.name);
  const equality = valueEqualityFor(decl, decl.base, ctx);
  // C# forbids a user-defined conversion to or from an interface (CS0552), and a `bytes`, a list and
  // a map all become one. The wrapper still works; `.Value` is how you get at what it refines.
  const convertible = comparisonOf(decl.base, ctx) === "scalar";
  return {
    structural: equality?.needed === true,
    lines: [
    ...(json ? [...valueConverter(decl, ctx, support), ""] : []),
    ...summaryOf(decl),
    ...(json ? converterAttribute(decl) : []),
    `public readonly partial record struct ${name}(${base.text} Value)`,
    "{",
    ...indent([
      ...(convertible
        ? [`public static implicit operator ${base.text}(${name} it) => it.Value;`]
        : [
            `// No implicit conversion: C# forbids one to \`${base.text}\`, which is an interface`,
            "// (CS0552). Read `.Value` instead.",
          ]),
      // Interpolation rather than `Value?.ToString() ?? ""`, which does not compile when the refined
      // type is a value type — `?.` cannot be applied to a `long` — and warns when it cannot be null.
      // `$"{Value}"` is correct for every base 7K allows, and yields "" for a null one.
      'public override string ToString() => $"{Value}";',
      ...(equality?.lines ?? []),
    ]),
    "}",
    ],
  };
}

function emitRecordLike(
  decl: RecordIr | MessageIr,
  ctx: TypeContext,
  shape: Shape,
  json: boolean,
  support: string,
  annotate: boolean,
): { lines: string[]; problems: TypeProblem[]; structural: boolean; losses: Loss[] } {
  const name = pascal(decl.id.name);
  const problems: TypeProblem[] = [];
  const losses: Loss[] = [];

  // `include` splices rather than nests (`02-contract.md`), so the fields a C# type must carry are the
  // flattened ones. Reading `decl.fields` alone would drop every included field from the generated
  // type — silently, which is the one thing a provider must not do.
  const fields = flatFieldsOf(ctx.model, decl);

  const usable: FieldIr[] = [];
  for (const field of fields) {
    // C# forbids a member with the same name as its enclosing type outright (CS0542), and 7K permits
    // `record Seat { seat: SeatRef }`. Renaming the property would be the easy way out and would move
    // the breakage to the serializer, where the wire name is decided — so it is refused here instead,
    // where somebody can still rename the field in the model.
    if (pascal(field.name) === name) {
      problems.push({
        at: `${decl.id.name}.${field.name}`,
        declared: `a field named \`${field.name}\` on \`${decl.id.name}\``,
        because:
          `C# forbids a member whose name matches its enclosing type, and both become \`${name}\`. ` +
          `Renaming the field in the model is the only fix that keeps the wire name honest.`,
      });
      continue;
    }
    usable.push(field);
  }

  // A record holding a list or a map is compared by reference by the compiler, which silently
  // defeats the one reason a record was chosen. A class has no synthesized equality to fix.
  const equality = shape === "class" ? undefined : equalityFor(decl, usable, ctx);

  // An attribute decorates one property, so every invariant is a rule model binding cannot apply.
  if (annotate) losses.push(...annotationLosses(decl));

  const attributesFor = (field: FieldIr): { lines: string[]; losses: readonly Loss[] } => {
    const annotations = annotate ? annotationsFor(field, ctx) : { lines: [], losses: [] };
    return {
      lines: [...(json ? fieldAttributes(field, ctx, support) : []), ...annotations.lines],
      losses: annotations.losses,
    };
  };

  if (shape === "positional") {
    // A primary constructor's attributes need an explicit `property:` target, because a parameter and
    // the property it becomes are two places an attribute could land and the compiler will not guess.
    const parameters = usable.map((field, i) => {
      const type = fieldType(field, ctx, decl.id.name);
      problems.push(...type.problems);
      const attributes = attributesFor(field);
      losses.push(...attributes.losses);
      const targeted = attributes.lines.map((a) => `[property: ${a.slice(1)}`).join(" ");
      const comma = i < usable.length - 1 ? "," : "";
      return `${targeted === "" ? "" : `${targeted} `}${type.text} ${pascal(field.name)}${comma}`;
    });

    const lines = [
      ...summaryOf(decl),
      // A positional record documents its fields as parameters, which is where a reader looks for
      // them on a primary constructor. Every one of them, because documenting some and not others is
      // CS1573 — and a parameter with nothing to say still has its own name to give.
      ...usable.map((field) => {
        const said = summaryOfField(field);
        const text =
          said.length === 0
            ? `\`${field.name}\`.`
            : escapeXml(said[0]!.replace(/<\/?summary>/g, ""));
        return `/// <param name="${pascal(field.name)}">${text}</param>`;
      }),
      `public sealed partial record ${name}(`,
      ...indent(parameters),
      `)`,
      "{",
      ...indent((equality?.lines ?? []).slice(1)),
      "}",
    ];
    return { lines, problems, structural: equality?.needed === true, losses };
  }

  const properties: string[] = [];
  for (const field of usable) {
    const type = fieldType(field, ctx, decl.id.name);
    problems.push(...type.problems);
    const attributes = attributesFor(field);
    losses.push(...attributes.losses);

    properties.push(...summaryOfField(field));
    properties.push(...attributes.lines);
    // `required` on an optional field would be a contradiction: absent is a legal value for it.
    properties.push(
      field.optional
        ? `public ${type.text} ${pascal(field.name)} { get; init; }`
        : `public required ${type.text} ${pascal(field.name)} { get; init; }`,
    );
  }

  const keyword =
    shape === "record" ? "public sealed partial record" : "public sealed partial class";
  const lines = [
    ...summaryOf(decl),
    `${keyword} ${name}`,
    "{",
    ...indent([...properties, ...(equality?.lines ?? [])]),
    "}",
  ];
  return { lines, problems, structural: equality?.needed === true, losses };
}

function emitDecl(
  decl: Decl,
  ctx: TypeContext,
  shape: Shape,
  hasValidator: (decl: Decl) => boolean,
  json: boolean,
  support: string,
  style: "methods" | "annotations" | "both",
  asyncSuffix: boolean,
  shapeOf: (decl: Decl) => Shape,
): Emitted | undefined {
  const base = { decl, pkg: decl.id.pkg, name: pascal(decl.id.name) };

  /** The type's own lines, then its validator's, which belong in the same file as the type. */
  const withValidator = (
    lines: readonly string[],
    problems: readonly TypeProblem[],
    structural = false,
  ): Emitted => {
    // A type this provider could not express exactly becomes a refusal, so a validator for it would be
    // generated against a type that is not there.
    // `annotations` alone means no generated method: the attributes are the whole of what is emitted,
    // and the losses say what that costs.
    const validation =
      problems.length === 0 && style !== "annotations"
        ? validatorFor(decl, ctx, hasValidator)
        : undefined;
    const jsonNeed = json;
    if (validation === undefined) {
      return {
        ...base,
        lines,
        problems,
        losses: [],
        needs: { ...NO_NEEDS, structural, json: jsonNeed },
      };
    }
    return {
      ...base,
      lines: [...lines, "", ...validation.lines],
      problems,
      losses: validation.losses,
      needs: {
        ...NO_NEEDS,
        linq: validation.needsLinq,
        regex: validation.needsRegex,
        problem: true,
        structural,
        json: jsonNeed,
      },
    };
  };

  switch (decl.kind) {
    case "enum":
      return {
        ...base,
        lines: emitEnum(decl, json, ctx),
        problems: [],
        losses: [],
        needs: { ...NO_NEEDS, json },
      };

    case "value":
      // An alias has no type of its own, so there is nothing to write for it.
      if (ctx.valueTypes === "alias") return undefined;
      const value = emitValue(decl, ctx, json, support);
      return withValidator(value.lines, [], value.structural);

    case "record":
    case "envelope":
    case "message": {
      const annotate = style !== "methods";
      const { lines, problems, structural, losses } = emitRecordLike(
        decl,
        ctx,
        shape,
        json,
        support,
        annotate,
      );
      const emitted = withValidator(lines, problems, structural);
      return emitted === undefined
        ? undefined
        : {
            ...emitted,
            losses: [...emitted.losses, ...losses],
            needs: { ...emitted.needs, annotations: annotate },
          };
    }

    case "saga": {
      const machine = machineFor(decl, ctx, ctx.model, shapeOf);
      if (machine === undefined) return undefined;
      // A saga whose sends the model does not determine is a refusal, so there is nothing to emit for
      // it — `withValidator` would otherwise try to validate a type that was never written.
      return {
        ...base,
        lines: machine.lines,
        problems: machine.problems,
        losses: machine.losses,
        needs: { ...NO_NEEDS, saga: true, linq: true },
      };
    }

    case "service": {
      const handlers = handlersFor(decl, ctx, ctx.model, asyncSuffix);
      return handlers === undefined
        ? undefined
        : {
            ...base,
            lines: handlers.lines,
            problems: [],
            losses: handlers.losses,
            needs: { ...NO_NEEDS, async: handlers.needsAsync },
          };
    }

    default:
      // Pipes, sagas and schedules are the next increment. Emitting nothing for them is not a refusal:
      // the model does not become less true because this provider has not got there yet.
      return undefined;
  }
}

/** The `using` lines a file needs, in the order a C# codebase conventionally sorts them. */
const usingsFor = (needs: Needs, root: string): string[] =>
  // Deduplicated, because the sets overlap: `System.Linq` is wanted both by a validator and by the
  // JSON support, and C# rejects the same directive twice in one namespace.
  [...new Set(usingList(needs, root))];

const usingList = (needs: Needs, root: string): string[] => [
  "using System;",
  "using System.Collections.Generic;",
  ...(needs.linq ? ["using System.Linq;"] : []),
  ...(needs.regex ? ["using System.Text.RegularExpressions;"] : []),
  // Aliased rather than written out, so the generated bodies read `Problem` and still cannot be
  // captured by a namespace that happens to share the root's name.
  ...(needs.async ? ["using System.Threading;", "using System.Threading.Tasks;"] : []),
  ...(needs.problem
    ? [`using Problem = global::${supportNamespace(root)}.Problem;`]
    : []),
  ...(needs.jsonSupport ? JSON_SUPPORT_USINGS : needs.json ? JSON_USINGS : []),
  ...(needs.annotations ? ANNOTATION_USINGS : []),
  ...(needs.structural
    ? [`using Structural = global::${supportNamespace(root)}.Structural;`]
    : []),
  ...(needs.saga
    ? [
        `using SagaEffect = global::${supportNamespace(root)}.SagaEffect;`,
        `using SagaStatus = global::${supportNamespace(root)}.SagaStatus;`,
        `using ISagaMachine = global::${supportNamespace(root)}.ISagaMachine;`,
      ]
    : []),
];

/** Wraps bodies in a namespace and a header. */
function fileOf(
  ns: string,
  bodies: readonly (readonly string[])[],
  nullable: boolean,
  needs: Needs = NO_NEEDS,
  root = "",
): string {
  const usings = usingsFor(needs, root);
  const parts = [
    ...HEADER,
    "",
    ...(nullable ? ["#nullable enable", ""] : []),
    ...usings,
    "",
    `namespace ${ns};`,
    "",
  ];
  bodies.forEach((body, i) => {
    parts.push(...body);
    if (i < bodies.length - 1) parts.push("");
  });
  return `${parts.join("\n")}\n`;
}

export const csharp: Provider = {
  name: "csharp",
  target: "C# 12 / .NET 8",
  layouts: ["per-declaration", "per-package", "single"],
  options: OPTIONS,

  generate(request: Request): Generated {
    const root = String(request.options["namespace"] ?? "");
    const nullable = request.options["nullable"] !== false;
    const json = request.options["serialization"] !== "none";
    const asyncSuffix = request.options["asyncSuffix"] !== false;

    const emitted: Emitted[] = [];
    const refusals: Refusal[] = [];

    const contextFor = (decl: Decl): TypeContext => ({
      model: request.model,
      root,
      pkg: decl.id.pkg,
      valueTypes: request.optionsFor(decl)["valueTypes"] === "alias" ? "alias" : "wrapper",
    });

    // Decided over the whole model, not the selection: a validator that delegates to another has to
    // name one that exists, and that must not depend on which part of the model this run emits.
    /** A declaration's shape, which a saga needs for the messages it constructs. */
    const shapeOf = (decl: Decl): Shape => {
      const chosen = request.optionsFor(decl)["messageType"];
      return chosen === "class" ? "class" : chosen === "positional" ? "positional" : "record";
    };

    const hasValidator = validatorsIn(
      request.model.decls,
      contextFor,
      (decl) => request.optionsFor(decl)["validators"] !== false,
    );

    for (const decl of request.selected) {
      const options = request.optionsFor(decl);
      const ctx = contextFor(decl);
      const shape = shapeOf(decl);

      const style = ((): "methods" | "annotations" | "both" => {
        const chosen = options["validatorStyle"];
        return chosen === "annotations" || chosen === "both" ? chosen : "methods";
      })();

      const one = emitDecl(
        decl,
        ctx,
        shape,
        hasValidator,
        json,
        `global::${supportNamespace(root)}.`,
        style,
        asyncSuffix,
        shapeOf,
      );
      if (one === undefined) continue;

      if (one.problems.length > 0) {
        // A type this provider cannot express exactly. The draft carries the gap in the file, so a
        // forgiving run still cannot be mistaken for a finished one.
        for (const problem of one.problems) {
          refusals.push({
            at: `${decl.id.pkg}.${decl.id.name}`,
            declared: problem.declared,
            because: problem.because,
            draft: [
              {
                path: `${pathFor(decl, request.layout, root)}`,
                content: fileOf(
                  namespaceOf(decl.id.pkg, root),
                  [[`#error 7K: ${problem.at} declares ${problem.declared}. ${problem.because}`]],
                  nullable,
                ),
                losses: [],
                from: [qualified(decl)],
              },
            ],
          });
        }
        continue;
      }

      emitted.push(one);
    }

    return { artifacts: group(emitted, request.layout, root, nullable), refusals };
  },
};

const pathFor = (decl: Decl, layout: Request["layout"], root: string): string => {
  if (layout === "single") return `${root === "" ? "Model" : pascal(root)}.cs`;
  if (layout === "per-package") return `${namespaceOf(decl.id.pkg, root)}.cs`;
  return `${namespaceOf(decl.id.pkg, root).split(".").join("/")}/${pascal(decl.id.name)}.cs`;
};

/**
 * Groups what was emitted into files.
 *
 * `single` is offered because C# genuinely permits it — several namespaces in one file compile — which
 * is not true of every language, and is why a provider declares the layouts it supports rather than the
 * run assuming concatenation works.
 */
function group(
  emitted: readonly Emitted[],
  layout: Request["layout"],
  root: string,
  nullable: boolean,
): Artifact[] {
  /**
   * The support file, when anything generated refers to `Problem`.
   *
   * Its own file in the layouts that are already many files, and folded into the one file under
   * `single` — a layout that promised one file and delivered two would be a layout nobody could
   * script against.
   */
  const supportFile = (name: string, body: readonly string[]): Artifact => ({
    path: `${supportNamespace(root)}/${name}.cs`,
    content: fileOf(supportNamespace(root), [body], nullable),
    losses: [],
    from: [],
  });

  const support: Artifact[] = [
    ...(emitted.some((o) => o.needs.problem) ? [supportFile("Validation", SUPPORT)] : []),
    ...(emitted.some((o) => o.needs.saga) ? [supportFile("Sagas", SAGA_SUPPORT)] : []),
    ...(emitted.some((o) => o.needs.structural)
      ? [supportFile("Equality", EQUALITY_SUPPORT)]
      : []),
    ...(emitted.some((o) => o.needs.json)
      ? [
          {
            path: `${supportNamespace(root)}/Json.cs`,
            content: fileOf(supportNamespace(root), [JSON_SUPPORT], nullable, {
              ...NO_NEEDS,
              jsonSupport: true,
            }),
            losses: [],
            from: [],
          },
        ]
      : []),
  ];

  if (layout === "per-declaration") {
    const files = emitted.map((one) => ({
      path: pathFor(one.decl, layout, root),
      content: fileOf(namespaceOf(one.pkg, root), [one.lines], nullable, one.needs, root),
      losses: one.losses,
      from: [qualified(one.decl)],
    }));
    return [...files, ...support];
  }

  const byNamespace = new Map<string, Emitted[]>();
  for (const one of emitted) {
    const ns = namespaceOf(one.pkg, root);
    byNamespace.set(ns, [...(byNamespace.get(ns) ?? []), one]);
  }

  if (layout === "per-package") {
    const files = [...byNamespace]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([ns, ones]) => ({
        path: `${ns}.cs`,
        content: fileOf(
          ns,
          ones.map((o) => o.lines),
          nullable,
          ones.reduce<Needs>((acc, o) => both(acc, o.needs), NO_NEEDS),
          root,
        ),
        losses: ones.flatMap((o) => o.losses),
        from: ones.map((o) => qualified(o.decl)),
      }));
    return [...files, ...support];
  }

  // One file, several file-scoped namespaces — which C# does not allow, so these are block-scoped.
  const parts: string[] = [...HEADER, "", ...(nullable ? ["#nullable enable", ""] : [])];
  // One file, so the support bodies are lifted into block namespaces below and their own `using`
  // lines go with the rest. `jsonSupport` is the superset, which is why it stands for both.
  const merged = emitted.reduce<Needs>((acc, o) => both(acc, o.needs), NO_NEEDS);
  parts.push(
    ...usingsFor({ ...merged, jsonSupport: merged.json }, root),
    "",
  );
  for (const one of support) {
    // Already wrapped in a file of its own, so the body is lifted back out for the block namespace.
    const body = one.content.split(NEWLINE);
    const from = body.findIndex((l) => l.startsWith("namespace "));
    parts.push(
      `namespace ${supportNamespace(root)}`,
      "{",
      ...indent(body.slice(from + 1).filter((l, i, all) => !(l === "" && (i === 0 || i === all.length - 1)))),
      "}",
      "",
    );
  }
  for (const [ns, ones] of [...byNamespace].sort((a, b) => a[0].localeCompare(b[0]))) {
    parts.push(`namespace ${ns}`, "{");
    ones.forEach((one, i) => {
      parts.push(...indent(one.lines));
      if (i < ones.length - 1) parts.push("");
    });
    parts.push("}", "");
  }

  return [
    {
      path: `${root === "" ? "Model" : pascal(root)}.cs`,
      content: `${parts.join("\n").trimEnd()}\n`,
      losses: emitted.flatMap((o) => o.losses),
      from: emitted.map((o) => qualified(o.decl)),
    },
  ];
}

export default csharp;
