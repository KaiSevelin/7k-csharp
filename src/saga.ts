/**
 * Sagas, as state machines.
 *
 * This is the one place a provider generates logic rather than shape, and it is generated because the
 * model genuinely states it: `04-process.md` says which message starts an instance, what it keys on,
 * what each step sends, what it awaits, what each outcome does to the state, when it times out, what
 * reverses it, and what the terminals send. None of that is a decision left to an implementer — it is
 * the decision, written down. A hand-written saga is a transcription of it, and transcriptions drift.
 *
 * **The machine is pure.** It holds no clock, opens no connection and sends nothing. Each input returns
 * an ordered list of effects — send this, arm that timer, the instance rejected — and the host performs
 * them. Three things follow, and the third is the one worth having:
 *
 * - It is testable without infrastructure, which is how a saga gets tested at all.
 * - Delivery, retry and deduplication stay outside it, where the model says they live.
 * - It can be driven by the *same* script as the sandbox's own saga engine, and the two decision
 *   sequences compared. `npm run equivalence` does exactly that, which is the only honest way to claim
 *   the generated machine means what the model means.
 *
 * **The effect order is the trace order.** The sandbox announces a terminal, *then* compensates, because
 * that is the causality — it rejected and therefore it unwound. Emitting them the other way round would
 * produce the same sends and a trace that lied about why.
 *
 * **Compensation runs for completed steps only, in reverse.** A step that never succeeded has nothing to
 * reverse, and that asymmetry is the single property a saga test exists to check (`04-process.md` 1.4).
 *
 * **A send the model does not determine is refused.** C# cannot construct a message with a required
 * field missing, and inventing one is what a test-data generator does, not a code generator. The refusal
 * names the field, and adding the assignment to the model fixes it.
 */

import type {
  AssignIr,
  AssignSource,
  Decl,
  FieldIr,
  LinkedModel,
  MessageIr,
  SagaAction,
  SagaIr,
  SendIr,
  StepIr,
  Terminal,
  TypeIr,
} from "@sevenk/core";
import type { Loss } from "@sevenk/generate";
import { csharpType, namespaceOf, pascal, type TypeContext, type TypeProblem } from "./types.js";

export interface Machine {
  readonly lines: readonly string[];
  readonly losses: readonly Loss[];
  readonly problems: readonly TypeProblem[];
}

const indent = (lines: readonly string[]): string[] => lines.map((l) => (l === "" ? "" : `    ${l}`));

const qname = (decl: Decl): string =>
  decl.id.pkg === "" ? decl.id.name : `${decl.id.pkg}.${decl.id.name}`;

const absolute = (decl: Decl, ctx: TypeContext): string =>
  `global::${namespaceOf(decl.id.pkg, ctx.root)}.${pascal(decl.id.name)}`;

const camel = (name: string): string => {
  const p = pascal(name);
  return p.charAt(0).toLowerCase() + p.slice(1);
};

const quote = (text: string): string => JSON.stringify(text);

/* ------------------------------------------------------------------- support */

/**
 * The types every generated machine shares.
 *
 * `SagaEffect` is a closed hierarchy for the same reason a reply union is: a host that switches over it
 * should be told when a new kind appears. Unlike a reply union there is no `Match`, because the set is
 * fixed by this provider rather than by the model — adding one is a deliberate change here, not
 * something a model edit can do behind a host's back.
 */
export const SAGA_SUPPORT: readonly string[] = [
  "/// <summary>",
  "/// What every generated saga machine offers, so that a host can drive one without knowing which.",
  "/// </summary>",
  "/// <remarks>",
  "/// <para>",
  "/// Starting an instance is not here, because the message that starts one is the saga's own and a",
  "/// typed `Start` is the point. Everything after that is uniform: deliver, time out, give up.",
  "/// </para>",
  "/// </remarks>",
  "public interface ISagaMachine",
  "{",
  "    /// <summary>The instance key, which is not the correlation id.</summary>",
  "    string Key { get; }",
  "",
  "    /// <summary>Where it got to.</summary>",
  "    SagaStatus Status { get; }",
  "",
  "    /// <summary>The reason it ended, where the terminal carried one.</summary>",
  "    string? Reason { get; }",
  "",
  "    /// <summary>Which stage is running.</summary>",
  "    int Stage { get; }",
  "",
  "    /// <summary>The steps that completed, in the order they did.</summary>",
  "    IReadOnlyList<string> Completed { get; }",
  "",
  "    /// <summary>The branches of the current stage that have not joined yet.</summary>",
  "    IReadOnlyList<string> Waiting { get; }",
  "",
  "    /// <summary>Where the instance is, as the model names it.</summary>",
  "    string StateName { get; }",
  "",
  "    /// <summary>Whether a name describes where this instance is.</summary>",
  "    bool IsIn(string name);",
  "",
  "    /// <summary>Delivers a message, if any waiting step awaits it.</summary>",
  "    IReadOnlyList<SagaEffect> Deliver(object message);",
  "",
  "    /// <summary>A step's timer fired, in the stage it was armed in.</summary>",
  "    IReadOnlyList<SagaEffect> Timeout(string step, int stage);",
  "",
  "    /// <summary>The saga's deadline elapsed.</summary>",
  "    IReadOnlyList<SagaEffect> Deadline();",
  "}",
  "",
  "/// <summary>Where a saga instance got to.</summary>",
  "public enum SagaStatus",
  "{",
  "    /// <summary>Still waiting on a step.</summary>",
  "    Running,",
  "    /// <summary>Every step completed.</summary>",
  "    Complete,",
  "    /// <summary>A step's `on` clause rejected it, and the completed steps were reversed.</summary>",
  "    Rejected,",
  "    /// <summary>A deadline elapsed or a step abandoned it, and the completed steps were reversed.</summary>",
  "    Abandoned,",
  "}",
  "",
  "/// <summary>",
  "/// One thing a saga decided. A machine returns these in order and performs none of them.",
  "/// </summary>",
  "/// <remarks>",
  "/// <para>",
  "/// The order is the order a trace records: a terminal is announced before the compensation it causes.",
  "/// A host that reorders them will send the right messages and log the wrong story.",
  "/// </para>",
  "/// </remarks>",
  "public abstract record SagaEffect",
  "{",
  "    private SagaEffect() { }",
  "",
  "    /// <summary>Publish this message, on the route the model's `emits` declares for it.</summary>",
  "    /// <param name=\"Message\">The message, fully built from the instance.</param>",
  "    /// <param name=\"MessageType\">Its qualified 7K name, for a trace.</param>",
  "    /// <param name=\"Why\">What asked for it: `step charge`, `undo of charge`, `on reject`.</param>",
  "    public sealed record Send(object Message, string MessageType, string Why) : SagaEffect;",
  "",
  "    /// <summary>A new instance began.</summary>",
  "    public sealed record Started(string Key) : SagaEffect;",
  "",
  "    /// <summary>An awaited message matched a waiting step.</summary>",
  "    public sealed record Advanced(string Step, string MessageType) : SagaEffect;",
  "",
  "    /// <summary>A step's timeout elapsed before its reply arrived.</summary>",
  "    public sealed record TimedOut(string Step, long AfterMs) : SagaEffect;",
  "",
  "    /// <summary>A completed step is being reversed.</summary>",
  "    public sealed record Compensating(string Step, string MessageType) : SagaEffect;",
  "",
  "    /// <summary>A completed step declared `undo none`, so it stays done.</summary>",
  "    public sealed record Irreversible(string Step) : SagaEffect;",
  "",
  "    /// <summary>The instance reached a terminal. `Step` is absent when a deadline ended it.</summary>",
  "    public sealed record Ended(SagaStatus Status, string? Step, string? Reason) : SagaEffect;",
  "",
  "    /// <summary>",
  "    /// Arm a timer that calls `Timeout(Step, Stage)` after `AfterMs`. `Stage` is what makes a",
  "    /// timer that fires after its step already joined harmless.",
  "    /// </summary>",
  "    public sealed record ArmTimeout(string Step, int Stage, long AfterMs) : SagaEffect;",
  "",
  "    /// <summary>Cancel the timer armed for this step, if it is still pending.</summary>",
  "    public sealed record CancelTimeout(string Step) : SagaEffect;",
  "",
  "    /// <summary>Arm a timer that calls `Deadline()` after `AfterMs`.</summary>",
  "    public sealed record ArmDeadline(long AfterMs) : SagaEffect;",
  "",
  "    /// <summary>Cancel the deadline timer.</summary>",
  "    public sealed record CancelDeadline : SagaEffect;",
  "}",
];

/* --------------------------------------------------------------------- types */

/** Whether a C# type is a value type, which decides how a nullable one is read. */
function isValueType(type: TypeIr, ctx: TypeContext): boolean {
  switch (type.t) {
    case "kernel":
      return type.name !== "string" && type.name !== "bytes";
    case "list":
    case "map":
      return false;
    case "ref": {
      const decl = ctx.model.declFor(type.ref);
      if (decl === undefined) return false;
      if (decl.kind === "enum") return true;
      // A wrapper is a `readonly record struct`; an alias is whatever it refines.
      if (decl.kind === "value") {
        return ctx.valueTypes === "wrapper" ? true : isValueType(decl.base, ctx);
      }
      return false;
    }
    default:
      return false;
  }
}

/** A field's C# type, without the `?` an optional one would carry. */
function bare(type: TypeIr, ctx: TypeContext, at: string): { text: string; problems: readonly TypeProblem[] } {
  return csharpType(type, ctx, at);
}

/**
 * Turns a string into the type a field wants.
 *
 * The instance key is a string — `04-process.md` keys an instance by the *value* of a business key
 * field, and a trace carries it as a string — so putting it back into a `uuid` or a nominal value means
 * converting. Parsing rather than casting, because a key that is not a well-formed `uuid` is a bug
 * worth hearing about at the send and not three services later.
 */
function fromString(type: TypeIr, expr: string, ctx: TypeContext): string | undefined {
  switch (type.t) {
    case "kernel":
      switch (type.name) {
        case "string":
          return expr;
        case "uuid":
          return `Guid.Parse(${expr})`;
        case "int":
          return `long.Parse(${expr}, System.Globalization.CultureInfo.InvariantCulture)`;
        case "decimal":
          return `decimal.Parse(${expr}, System.Globalization.CultureInfo.InvariantCulture)`;
        default:
          return undefined;
      }
    case "ref": {
      const decl = ctx.model.declFor(type.ref);
      if (decl === undefined || decl.kind !== "value") return undefined;
      const inner = fromString(decl.base, expr, ctx);
      if (inner === undefined) return undefined;
      return ctx.valueTypes === "wrapper" ? `new ${absolute(decl, ctx)}(${inner})` : inner;
    }
    default:
      return undefined;
  }
}

/** The reverse: a field's value as the string a key or a trace carries. */
function toStringOf(type: TypeIr, expr: string, ctx: TypeContext): string {
  // Every wrapper generates `ToString()` as `$"{Value}"`, and a kernel scalar has one. Invariant
  // culture matters for a decimal key: `1.5` and `1,5` are not the same instance.
  if (type.t === "kernel" && (type.name === "decimal" || type.name === "float")) {
    return `${expr}.ToString(System.Globalization.CultureInfo.InvariantCulture)`;
  }
  return type.t === "kernel" && type.name === "string" ? expr : `${expr}.ToString()`;
}

/* ------------------------------------------------------------------- reading */

interface Read {
  readonly expr?: string;
  readonly why?: string;
}

/** The field a path names on a declaration, where it names one. */
function fieldAt(decl: Decl | undefined, path: readonly string[], ctx: TypeContext): FieldIr | undefined {
  if (decl === undefined || path.length === 0) return undefined;
  const fields =
    decl.kind === "message" || decl.kind === "record" || decl.kind === "envelope" ? decl.fields : [];
  const field = fields.find((f) => f.name === path[0]);
  if (field === undefined || path.length === 1) return field;
  const next = field.type.t === "ref" ? ctx.model.declFor(field.type.ref) : undefined;
  return fieldAt(next, path.slice(1), ctx);
}

const property = (path: readonly string[]): string => path.map((p) => `.${pascal(p)}`).join("");

/**
 * Unwraps a nullable, loudly.
 *
 * `??  throw` rather than `!` because it works for a `Guid?` and a `Money?` alike, and because a
 * message blaming the model beats a `NullReferenceException` blaming nobody. The checker is supposed to
 * prove state is assigned before it is read (`04-process.md`), so this should never fire — and if it
 * does, the saga is the thing that is wrong.
 */
const required = (expr: string, what: string, saga: string): string =>
  `${expr} ?? throw new InvalidOperationException(${quote(`${saga}: \`${what}\` is unset at this point. The model does not assign it before it is read.`)})`;

/* ------------------------------------------------------------------ the saga */

interface Context {
  readonly saga: SagaIr;
  readonly ctx: TypeContext;
  readonly model: LinkedModel;
  /** How a message it sends declares its fields, which decides how one is constructed. */
  readonly shapeOf: (decl: Decl) => "record" | "positional" | "class";
  readonly stateName: string;
  /** The declaration the instance key comes from, and the field it is read out of. */
  readonly keyField: FieldIr | undefined;
  readonly envelopes: readonly Decl[];
  readonly problems: TypeProblem[];
  readonly losses: Loss[];
}

/** An envelope field, looked up across the records the package declares. */
function envelopeField(c: Context, path: readonly string[]): { decl: Decl; field: FieldIr } | undefined {
  for (const decl of c.envelopes) {
    const field = fieldAt(decl, path, c.ctx);
    if (field !== undefined) return { decl, field };
  }
  return undefined;
}

/**
 * What a `send` block's assignment reads.
 *
 * A send has the instance and nothing else in hand, which is why `message` and `claim` yield nothing
 * here: naming one is a model error, and the sandbox leaves the field unset and says so rather than
 * inventing a reading. This does the same, except that it says so at generation time.
 */
function readForSend(c: Context, source: AssignSource, terminal: Terminal | undefined): Read {
  switch (source.from) {
    case "absent":
      return { why: "it is `absent`, which clears a field rather than filling one" };

    case "literal":
      return {
        expr:
          typeof source.value === "string"
            ? quote(source.value)
            : typeof source.value === "boolean"
              ? String(source.value)
              : String(source.value),
      };

    case "state":
    case "path": {
      const field = c.saga.state.find((f) => f.name === source.path[0]);
      if (field === undefined) {
        return { why: `the saga declares no state field \`${source.path[0] ?? ""}\`` };
      }
      const held = `State${property(source.path)}`;
      return { expr: required(held, source.path.join("."), qname(c.saga)) };
    }

    case "envelope": {
      const found = envelopeField(c, source.path);
      if (found === undefined) {
        return { why: `no envelope of \`${c.saga.id.pkg}\` declares \`${source.path.join(".")}\`` };
      }
      const held = `${camel(found.decl.id.name)}${property(source.path)}`;
      return { expr: found.field.optional ? required(held, source.path.join("."), qname(c.saga)) : held };
    }

    case "terminal": {
      if (terminal === undefined) {
        return { why: "`terminal` is only in hand for a terminal `send`" };
      }
      if (source.path[0] === "state") return { expr: quote(terminal) };
      if (source.path[0] === "reason") {
        return { expr: required("Reason", "terminal.reason", qname(c.saga)) };
      }
      return { why: `\`terminal.${source.path.join(".")}\` is not a thing a terminal carries` };
    }

    default:
      return {
        why: `a \`send\` block cannot read \`${source.from}\`: it has the instance and nothing else`,
      };
  }
}

/** What an `on` action's assignment reads: the message that arrived, its envelope, or a literal. */
function readForAction(c: Context, source: AssignSource, message: MessageIr): Read {
  switch (source.from) {
    case "absent":
      return { expr: "null" };

    case "literal":
      return {
        expr: typeof source.value === "string" ? quote(source.value) : String(source.value),
      };

    case "message": {
      const field = fieldAt(message, source.path, c.ctx);
      if (field === undefined) {
        return { why: `\`${qname(message)}\` declares no \`${source.path.join(".")}\`` };
      }
      return { expr: `message${property(source.path)}` };
    }

    case "envelope": {
      const found = envelopeField(c, source.path);
      if (found === undefined) {
        return { why: `no envelope of \`${c.saga.id.pkg}\` declares \`${source.path.join(".")}\`` };
      }
      return { expr: `${camel(found.decl.id.name)}${property(source.path)}` };
    }

    default:
      // The sandbox reads claims here, and a saga is handed none (D69) — so it reads nothing.
      return {
        why: `an \`on\` action cannot read \`${source.from}\`: a saga presents no identity of its own (D69)`,
      };
  }
}

/* -------------------------------------------------------------------- sends */

/**
 * The expression that builds one message a saga sends.
 *
 * Three sources, in the order the language gives them authority. What the `send` block says wins,
 * because the author said it. Then the `@role(businessKey)` field takes the instance key, which is what
 * makes the eventual reply correlate back. Then any other field takes a state field of the same name.
 *
 * Whatever is left is the interesting case. The sandbox generates a value for it, because it is a test
 * harness and a missing amount would stop the scenario. This cannot: there is no honest value for
 * `ChargeCard.amount`, and C# will not construct the record without one. So it is refused, naming the
 * field — and the fix is one line in the model.
 */
function buildSend(
  c: Context,
  send: SendIr,
  terminal: Terminal | undefined,
  why: string,
): string[] | undefined {
  const decl = c.model.declFor(send.message);
  if (decl === undefined || decl.kind !== "message") return undefined;

  const assigned = new Map<string, string>();

  for (const assign of send.assigns) {
    const target = assign.target[0];
    // A nested target in a `send` is not something the sandbox fills either.
    if (target === undefined || assign.target.length > 1) continue;
    const field = decl.fields.find((f) => f.name === target);
    if (field === undefined) continue;

    const read = readForSend(c, assign.source, terminal);
    if (read.expr === undefined) {
      c.problems.push({
        at: `${c.saga.id.name}.${why}`,
        declared: `\`${target} = …\` on \`${qname(decl)}\``,
        because: `This provider cannot read that: ${read.why ?? "the source is not available here"}.`,
      });
      continue;
    }
    assigned.set(target, coerce(c, field, read.expr, assign.source));
  }

  const missing: string[] = [];
  for (const field of decl.fields) {
    if (assigned.has(field.name)) continue;

    if (field.role === "businessKey") {
      const converted = fromString(field.type, "Key", c.ctx);
      if (converted === undefined) {
        c.problems.push({
          at: `${c.saga.id.name}.${why}`,
          declared: `\`${qname(decl)}.${field.name}\` as the business key`,
          because: `The instance key is a string and this provider cannot turn one into that type.`,
        });
        continue;
      }
      assigned.set(field.name, converted);
      continue;
    }

    // A state field of the same name, which is how `lines` fills itself.
    const held = c.saga.state.find((f) => f.name === field.name);
    if (held !== undefined) {
      assigned.set(field.name, required(`State.${pascal(field.name)}`, field.name, qname(c.saga)));
      continue;
    }

    if (field.optional) continue;
    missing.push(field.name);
  }

  if (missing.length > 0) {
    c.problems.push({
      at: `${c.saga.id.name}.${why}`,
      declared: `\`send ${qname(decl)}\` without ${missing.map((m) => `\`${m}\``).join(", ")}`,
      because:
        `Nothing determines ${missing.length === 1 ? "that field" : "those fields"}: the \`send\` block ` +
        `does not assign ${missing.length === 1 ? "it" : "them"}, ${missing.length === 1 ? "it is" : "they are"} ` +
        `not the business key, and the saga holds no state of that name. C# cannot construct the ` +
        `message without ${missing.length === 1 ? "it" : "them"}, and a generated value would be a guess ` +
        `— add the assignment to the model.`,
    });
    return undefined;
  }

  // A positional record has a primary constructor and no initializer, so every parameter has to be
  // passed in declaration order — including an optional one, which carries no default.
  if (c.shapeOf(decl) === "positional") {
    const args = decl.fields.map(
      (f, i) =>
        `${assigned.get(f.name) ?? "null"}${i < decl.fields.length - 1 ? "," : ""}` +
        ` // ${f.name}`,
    );
    return [
      `new ${absolute(decl, c.ctx)}(`,
      ...indent(args),
      `), ${quote(qname(decl))}, ${quote(why)}`,
    ];
  }

  const fields = decl.fields
    .filter((f) => assigned.has(f.name))
    .map((f) => `${pascal(f.name)} = ${assigned.get(f.name)!},`);

  return [
    `new ${absolute(decl, c.ctx)}`,
    "{",
    ...indent(fields),
    `}, ${quote(qname(decl))}, ${quote(why)}`,
  ];
}

/**
 * Fits a value to the field it is going into.
 *
 * Only where the model's own types make it necessary. `terminal.reason` is a string and
 * `OrderRejected.detail` is a `Line60`, so the wrapper has to be put back on; a `message.chargeId`
 * going into a `uuid` needs nothing. Anything this cannot bridge is left alone and the compiler says
 * so, which is better than a cast that compiles and truncates.
 */
function coerce(c: Context, field: FieldIr, expr: string, source: AssignSource): string {
  const stringish =
    source.from === "terminal" ||
    (source.from === "literal" && typeof source.value === "string");
  if (!stringish) return expr;

  const target = c.ctx.model.declFor(field.type.t === "ref" ? field.type.ref : ({} as never));
  if (field.type.t !== "ref" || target === undefined) return expr;
  return fromString(field.type, expr, c.ctx) ?? expr;
}

/* -------------------------------------------------------------------- stages */

const stagesOf = (saga: SagaIr): number[] => [...new Set(saga.steps.map((s) => s.stage))].sort((a, b) => a - b);

const stepsIn = (saga: SagaIr, stage: number): StepIr[] => saga.steps.filter((s) => s.stage === stage);

/** The body of `EnterStage`, which both `Begin` and a joining step reach. */
function enterStage(c: Context): string[] {
  const lines: string[] = [
    "// A stage with no steps is the end of the saga: every stage before it joined.",
    "var steps = StepsIn(Stage);",
    "if (steps.Count == 0)",
    "{",
    ...indent(["Terminate(effects, SagaStatus.Complete, null, null);", "return;"]),
    "}",
    "",
    "doneInStage.Clear();",
    "",
    "// Every branch is sent before any reply can arrive, which is what makes a stage concurrent",
    "// rather than a sequence written with extra words.",
    "switch (Stage)",
    "{",
  ];

  for (const stage of stagesOf(c.saga)) {
    const sends: string[] = [];
    for (const step of stepsIn(c.saga, stage)) {
      if (step.send === undefined) continue;
      const built = buildSend(c, step.send, undefined, `step ${step.name}`);
      if (built === undefined) continue;
      sends.push(`effects.Add(new SagaEffect.Send(`, ...indent(built), "));");
    }
    lines.push(`    case ${stage}:`);
    lines.push(...indent(indent(sends.length === 0 ? ["break;"] : [...sends, "break;"])));
  }

  lines.push(
    "    default:",
    "        break;",
    "}",
    "",
    "// Timers after sends, so that a stage's timeouts all start from the same instant.",
    "foreach (var step in steps)",
    "{",
    ...indent([
      "var after = TimeoutOf(step);",
      "if (after is { } ms) effects.Add(new SagaEffect.ArmTimeout(step, Stage, ms));",
    ]),
    "}",
  );

  return lines;
}

/** `continue`, `reject` or `abandon`, as the sandbox applies them. */
function applyAction(
  c: Context,
  step: StepIr,
  action: SagaAction,
  message: MessageIr | undefined,
): string[] {
  const lines: string[] = [`effects.Add(new SagaEffect.CancelTimeout(${quote(step.name)}));`];

  switch (action.a) {
    case "continue": {
      if (message !== undefined) {
        for (const assign of action.assigns) {
          const target = assign.target;
          const head = target[0];
          if (head === undefined) continue;
          const field = c.saga.state.find((f) => f.name === head);
          if (field === undefined) {
            c.problems.push({
              at: `${c.saga.id.name}.${step.name}`,
              declared: `\`${target.join(".")} = …\``,
              because: `The saga declares no state field \`${head}\`.`,
            });
            continue;
          }
          const read = readForAction(c, assign.source, message);
          if (read.expr === undefined) {
            c.problems.push({
              at: `${c.saga.id.name}.${step.name}`,
              declared: `\`${target.join(".")} = …\``,
              because: `This provider cannot read that: ${read.why ?? "the source is not available"}.`,
            });
            continue;
          }
          lines.push(`State${property(target)} = ${read.expr};`);
        }
      }
      lines.push(
        "",
        "// The step succeeded, so it becomes reversible.",
        `completed.Add(${quote(step.name)});`,
        `doneInStage.Add(${quote(step.name)});`,
        "",
        "// A stage joins when its last branch completes; until then the siblings keep waiting.",
        "if (StepsIn(Stage).All(s => doneInStage.Contains(s)))",
        "{",
        ...indent(["Stage++;", "EnterStage(effects);"]),
        "}",
      );
      return lines;
    }

    case "reject":
      lines.push(
        `Terminate(effects, SagaStatus.Rejected, ${quote(step.name)}, ${action.reason === undefined ? "null" : quote(action.reason)});`,
      );
      return lines;

    default:
      // `abandon` takes no reason in the grammar, so the step that abandoned is the reason.
      lines.push(
        `Terminate(effects, SagaStatus.Abandoned, ${quote(step.name)}, ${quote(`abandoned in ${step.name}`)});`,
      );
      return lines;
  }
}

/* -------------------------------------------------------------------- output */

const doc = (text: string): string[] => [`/// <summary>${text}</summary>`];

/** The declared `state` block, as a class whose every field starts unset (D16). */
function stateClass(c: Context, name: string): string[] {
  const properties = c.saga.state.flatMap((field) => {
    const type = bare(field.type, c.ctx, `${c.saga.id.name}.${field.name}`);
    c.problems.push(...type.problems);
    const rules = field.constraints.map((k) => `${k.name} ${k.args.join(" ")}`.trim());
    return [
      ...doc(
        `\`${field.name}\`, unset until a step assigns it.` +
          (rules.length === 0 ? "" : ` The model constrains it: ${rules.join("; ")}.`),
      ),
      `public ${type.text}? ${pascal(field.name)} { get; set; }`,
    ];
  });

  return [
    ...doc(
      `What \`${qname(c.saga)}\` remembers. Every field starts unset: a saga's state is assigned only ` +
        `from a message it received (D16), never computed.`,
    ),
    `public sealed partial class ${name}`,
    "{",
    ...indent(properties),
    "}",
  ];
}

/** Everything a saga becomes. */
export function machineFor(
  decl: Decl,
  ctx: TypeContext,
  model: LinkedModel,
  shapeOf: (decl: Decl) => "record" | "positional" | "class",
): Machine | undefined {
  if (decl.kind !== "saga") return undefined;
  const saga = decl;
  if (saga.start === undefined) return undefined;

  const startDecl = model.declFor(saga.start.message);
  if (startDecl === undefined || startDecl.kind !== "message") return undefined;

  const keyName = saga.start.keyedBy ?? startDecl.fields.find((f) => f.role === "businessKey")?.name;
  const keyField = keyName === undefined ? undefined : fieldAt(startDecl, keyName.split("."), ctx);

  const envelopes = (model.packages.get(saga.id.pkg)?.envelopes ?? [])
    .map((ref) => model.declFor(ref))
    .filter((d): d is Decl => d !== undefined);

  const name = pascal(saga.id.name);
  const stateName = `${name}State`;

  const c: Context = {
    saga,
    ctx,
    model,
    shapeOf,
    stateName,
    keyField,
    envelopes,
    problems: [],
    losses: [],
  };

  if (keyField === undefined || keyName === undefined) {
    c.problems.push({
      at: saga.id.name,
      declared: `\`start on ${qname(startDecl)}\``,
      because:
        `Nothing keys an instance: \`${qname(startDecl)}\` has no \`@role(businessKey)\` field and the ` +
        `saga declares no \`keyed by\`.`,
    });
    return { lines: [], losses: c.losses, problems: c.problems };
  }

  const envelopeParameters = envelopes.map((e) => `${absolute(e, ctx)} ${camel(e.id.name)}`);
  const envelopeFields = envelopes.map(
    (e) => `public ${absolute(e, ctx)} ${pascal(e.id.name)} { get; }`,
  );

  // Every message any step awaits, with the step and action that handles it.
  const awaited = saga.steps.flatMap((step) =>
    step.awaits.flatMap((a) => {
      const message = model.declFor(a.message);
      return message === undefined || message.kind !== "message"
        ? []
        : [{ step, await: a, message }];
    }),
  );

  const byMessage = new Map<string, { step: StepIr; await: (typeof awaited)[number]["await"]; message: MessageIr }[]>();
  for (const one of awaited) {
    const key = qname(one.message);
    byMessage.set(key, [...(byMessage.get(key) ?? []), one]);
  }

  const deliverMethods = [...byMessage].flatMap(([qualified, handlers]) => {
    const message = handlers[0]!.message;
    const branches = handlers.flatMap(({ step, await: a, message: m }) => {
      const keyPath = a.keyedBy ?? m.fields.find((f) => f.role === "businessKey")?.name;
      const field = keyPath === undefined ? undefined : fieldAt(m, keyPath.split("."), ctx);
      if (field === undefined || keyPath === undefined) {
        c.problems.push({
          at: `${saga.id.name}.${step.name}`,
          declared: `\`on ${qname(m)}\``,
          because:
            `Nothing correlates it: \`${qname(m)}\` has no \`@role(businessKey)\` field and the ` +
            `\`on\` clause declares no \`keyed by\`.`,
        });
        return [];
      }
      const read = toStringOf(field.type, `message${property(keyPath.split("."))}`, ctx);
      return [
        `if (!doneInStage.Contains(${quote(step.name)}) && StepsIn(Stage).Contains(${quote(step.name)})`,
        `    && ${read} == Key)`,
        "{",
        ...indent([
          `effects.Add(new SagaEffect.Advanced(${quote(step.name)}, ${quote(qualified)}));`,
          ...applyAction(c, step, a.action, m),
          "return effects;",
        ]),
        "}",
        "",
      ];
    });

    return [
      ...doc(
        `Delivers \`${qualified}\`. Returns no effects when no waiting step awaits it, which is not an ` +
          `error — another instance or another service may be the one that wanted it.`,
      ),
      `public IReadOnlyList<SagaEffect> Deliver(${absolute(message, ctx)} message)`,
      "{",
      ...indent([
        "var effects = new List<SagaEffect>();",
        "if (Status != SagaStatus.Running) return effects;",
        "",
        ...branches,
        "return effects;",
      ]),
      "}",
      "",
    ];
  });

  const timeoutSteps = saga.steps.filter((s) => s.timeout !== undefined);

  const lines = [
    ...stateClass(c, stateName),
    "",
    ...doc(`\`${qname(saga)}\`, as a state machine.`),
    "/// <remarks>",
    "/// <para>",
    `/// Generated from the saga the model declares. It holds no clock and sends nothing: every input`,
    `/// returns the effects the saga decided, in the order a trace records them, and the host performs`,
    `/// them. That is what makes it testable without infrastructure, and what keeps delivery and retry`,
    `/// outside it where the model says they live.`,
    "/// </para>",
    "/// <para>",
    `/// A host owns the instances. Look one up by \`Key\` before starting: a second \`${qname(startDecl)}\``,
    `/// with a key already held is a redundant start, which is what makes starting idempotent on an`,
    `/// at-least-once pipe (\`04-process.md\` 1.1) — and only the host can see that.`,
    "/// </para>",
    "/// </remarks>",
    `public sealed partial class ${name}Saga : ISagaMachine`,
    "{",
    ...indent([
      ...doc(`The saga's qualified name, as a trace carries it.`),
      `public const string Name = ${quote(qname(saga))};`,
      "",
      ...(saga.version === undefined
        ? []
        : [...doc("The declared version."), `public const string Version = ${quote(saga.version)};`, ""]),
      ...(saga.deadlineMs === undefined
        ? [...doc("The saga declares no deadline, so only its steps' timeouts bound it."), "public const long? DeadlineMs = null;", ""]
        : [...doc("How long the whole instance may take before it is abandoned."), `public const long DeadlineMs = ${saga.deadlineMs};`, ""]),

      ...doc("The step names the model declares, in order, so a host need not spell them."),
      "public static class Steps",
      "{",
      ...indent(
        saga.steps.map(
          (s) => `/// <summary>Stage ${s.stage}.</summary>\n    public const string ${pascal(s.name)} = ${quote(s.name)};`,
        ),
      ),
      "}",
      "",
      "private readonly List<string> completed = new();",
      "private readonly HashSet<string> doneInStage = new();",
      "",
      ...doc("The instance key, which is not the correlation id (`04-process.md` 1.1)."),
      "public string Key { get; }",
      "",
      ...doc("What the instance remembers."),
      `public ${stateName} State { get; } = new();`,
      "",
      ...doc("Where it got to."),
      "public SagaStatus Status { get; private set; } = SagaStatus.Running;",
      "",
      ...doc("The reason it ended, where the terminal carried one."),
      "public string? Reason { get; private set; }",
      "",
      ...doc("Which stage is running. Steps written in one `parallel` block share a stage."),
      "public int Stage { get; private set; }",
      "",
      ...doc("The steps that completed, in the order they did, which is the order compensation reverses."),
      "public IReadOnlyList<string> Completed => completed;",
      "",
      ...envelopeFields.flatMap((f) => [
        ...doc("The envelope the start message carried, which every message this saga sends also carries."),
        f,
        "",
      ]),

      `private ${name}Saga(string key${envelopeParameters.length === 0 ? "" : `, ${envelopeParameters.join(", ")}`})`,
      "{",
      ...indent([
        "Key = key;",
        ...envelopes.map((e) => `${pascal(e.id.name)} = ${camel(e.id.name)};`),
      ]),
      "}",
      "",

      ...doc("A new instance and the effects of starting it."),
      `public sealed record Begun(${name}Saga Saga, IReadOnlyList<SagaEffect> Effects);`,
      "",
      ...doc(
        `Begins an instance from \`${qname(startDecl)}\`, keyed by \`${keyName}\`.`,
      ),
      `public static Begun Start(${absolute(startDecl, ctx)} message${envelopeParameters.length === 0 ? "" : `, ${envelopeParameters.join(", ")}`})`,
      "{",
      ...indent([
        `var saga = new ${name}Saga(${toStringOf(keyField.type, `message${property(keyName.split("."))}`, ctx)}${envelopes.length === 0 ? "" : `, ${envelopes.map((e) => camel(e.id.name)).join(", ")}`});`,
        "var effects = new List<SagaEffect>();",
        "",
        "// The start block's assignments, before anything is announced: `saga-started` reports an",
        "// instance that already holds what the start message gave it.",
        ...saga.start.assigns.flatMap((assign) => {
          const head = assign.target[0];
          if (head === undefined) return [];
          const field = saga.state.find((f) => f.name === head);
          if (field === undefined) {
            c.problems.push({
              at: `${saga.id.name}.start`,
              declared: `\`${assign.target.join(".")} = …\``,
              because: `The saga declares no state field \`${head}\`.`,
            });
            return [];
          }
          const read = readForAction(c, assign.source, startDecl);
          if (read.expr === undefined) {
            c.problems.push({
              at: `${saga.id.name}.start`,
              declared: `\`${assign.target.join(".")} = …\``,
              because: `This provider cannot read that: ${read.why ?? "the source is not available"}.`,
            });
            return [];
          }
          return [`saga.State${property(assign.target)} = ${read.expr};`];
        }),
        "",
        "effects.Add(new SagaEffect.Started(saga.Key));",
        ...(saga.deadlineMs === undefined
          ? []
          : ["effects.Add(new SagaEffect.ArmDeadline(DeadlineMs));"]),
        "saga.EnterStage(effects);",
        "return new Begun(saga, effects);",
      ]),
      "}",
      "",

      ...deliverMethods,

      ...doc(
        "Delivers a message whose type is only known at runtime, which is the shape a host usually has.",
      ),
      "public IReadOnlyList<SagaEffect> Deliver(object message) => message switch",
      "{",
      ...indent([
        ...[...byMessage].map(([, handlers]) => {
          const m = handlers[0]!.message;
          return `${absolute(m, ctx)} it => Deliver(it),`;
        }),
        "_ => Array.Empty<SagaEffect>(),",
      ]),
      "};",
      "",

      ...doc(
        "A step's timer fired. `stage` is the stage it was armed in, which is what makes a timer that " +
          "fires after its step already joined harmless (`04-process.md` 2.1).",
      ),
      "public IReadOnlyList<SagaEffect> Timeout(string step, int stage)",
      "{",
      ...indent([
        "var effects = new List<SagaEffect>();",
        "if (Status != SagaStatus.Running) return effects;",
        "// The guard is the stage *and* the branch: a branch that joined while its siblings waited is",
        "// still in the same stage, and the timer it armed must not fire on it.",
        "if (stage != Stage || doneInStage.Contains(step)) return effects;",
        "",
        "switch (step)",
        "{",
        ...indent(
          timeoutSteps.flatMap((step) => [
            `case ${quote(step.name)}:`,
            ...indent([
              `effects.Add(new SagaEffect.TimedOut(${quote(step.name)}, ${step.timeout!.afterMs}));`,
              ...applyAction(c, step, step.timeout!.action, undefined),
              "break;",
            ]),
          ]),
        ),
        ...indent(["default:", "    break;"]),
        "}",
        "return effects;",
      ]),
      "}",
      "",

      ...doc("The saga's deadline elapsed, which abandons the instance wherever it had got to."),
      "public IReadOnlyList<SagaEffect> Deadline()",
      "{",
      ...indent([
        "var effects = new List<SagaEffect>();",
        "if (Status != SagaStatus.Running) return effects;",
        "// No step ended it, so no step is named: that absence is how a consumer tells a failed step",
        "// from the clock running out while it waited.",
        'Terminate(effects, SagaStatus.Abandoned, null, "deadline elapsed");',
        "return effects;",
      ]),
      "}",
      "",

      ...doc(
        "Where the instance is, as the model names it: the branches still being awaited, or the " +
          "terminal it reached.",
      ),
      "public string StateName =>",
      ...indent([
        "Status != SagaStatus.Running",
        `    ? Status.ToString().ToLowerInvariant()`,
        "    : Waiting.Count == 0",
        '        ? "running"',
        '        : string.Join(" + ", Waiting);',
      ]),
      "",
      ...doc("The branches of the current stage that have not joined yet."),
      "public IReadOnlyList<string> Waiting =>",
      "    StepsIn(Stage).Where(s => !doneInStage.Contains(s)).ToArray();",
      "",
      ...doc(
        "Whether a name describes where this instance is. A terminal matches the status; a step name " +
          "matches a branch still awaited, so an instance in a `parallel` block is in both of its steps.",
      ),
      "public bool IsIn(string name) =>",
      ...indent([
        "Status != SagaStatus.Running",
        "    ? string.Equals(Status.ToString(), name, StringComparison.OrdinalIgnoreCase)",
        "    : StepsIn(Stage).Any(s =>",
        "        !doneInStage.Contains(s) && string.Equals(s, name, StringComparison.OrdinalIgnoreCase));",
      ]),
      "",

      "private static IReadOnlyList<string> StepsIn(int stage) => stage switch",
      "{",
      ...indent([
        ...stagesOf(saga).map(
          (stage) =>
            `${stage} => new[] { ${stepsIn(saga, stage).map((s) => quote(s.name)).join(", ")} },`,
        ),
        "_ => Array.Empty<string>(),",
      ]),
      "};",
      "",
      "private static long? TimeoutOf(string step) => step switch",
      "{",
      ...indent([
        ...timeoutSteps.map((s) => `${quote(s.name)} => ${s.timeout!.afterMs},`),
        "_ => null,",
      ]),
      "};",
      "",

      "private void EnterStage(List<SagaEffect> effects)",
      "{",
      ...indent(enterStage(c)),
      "}",
      "",

      "/// <summary>",
      "/// Ends the instance: announce the terminal, unwind the completed steps, then send the terminal",
      "/// message. In that order, because that is the causality — it rejected and *therefore* it",
      "/// compensated.",
      "/// </summary>",
      "private void Terminate(List<SagaEffect> effects, SagaStatus terminal, string? step, string? reason)",
      "{",
      ...indent([
        "if (Status != SagaStatus.Running) return;",
        "",
        "// Every branch's timer, not one: terminating mid-stage ends its siblings too.",
        "foreach (var waiting in Waiting) effects.Add(new SagaEffect.CancelTimeout(waiting));",
        "effects.Add(new SagaEffect.CancelDeadline());",
        "",
        "Status = terminal;",
        "if (reason is not null) Reason = reason;",
        "effects.Add(new SagaEffect.Ended(terminal, step, reason));",
        "",
        "if (terminal != SagaStatus.Complete) Unwind(effects);",
        "",
        "Terminal(effects, terminal);",
      ]),
      "}",
      "",

      "/// <summary>",
      "/// Reverses the completed steps, in reverse order and only those that completed. A step that",
      "/// never succeeded has nothing to reverse (`04-process.md` 1.4).",
      "/// </summary>",
      "private void Unwind(List<SagaEffect> effects)",
      "{",
      ...indent([
        "for (var i = completed.Count - 1; i >= 0; i--)",
        "{",
        ...indent([
          "switch (completed[i])",
          "{",
          ...indent(
            saga.steps.flatMap((step) => {
              if (step.undo === undefined) return [];
              if (step.undo === null) {
                return [
                  `case ${quote(step.name)}:`,
                  ...indent([
                    "// `undo none`: the model says this step cannot be reversed, so it stays done.",
                    `effects.Add(new SagaEffect.Irreversible(${quote(step.name)}));`,
                    "break;",
                  ]),
                ];
              }
              const undoDecl = model.declFor(step.undo.message);
              if (undoDecl === undefined || undoDecl.kind !== "message") return [];
              const built = buildSend(c, step.undo, undefined, `undo of ${step.name}`);
              if (built === undefined) return [];
              return [
                `case ${quote(step.name)}:`,
                ...indent([
                  `effects.Add(new SagaEffect.Compensating(${quote(step.name)}, ${quote(qname(undoDecl))}));`,
                  "effects.Add(new SagaEffect.Send(",
                  ...indent(built),
                  "));",
                  "break;",
                ]),
              ];
            }),
          ),
          ...indent([
            "default:",
            "    // An absent `undo` is `uncompensated`, which the checker reports. Nothing to send.",
            "    break;",
          ]),
          "}",
        ]),
        "}",
      ]),
      "}",
      "",

      "/// <summary>The message the reached terminal sends, where the model declares one.</summary>",
      "private void Terminal(List<SagaEffect> effects, SagaStatus terminal)",
      "{",
      ...indent([
        "switch (terminal)",
        "{",
        ...indent(
          (["complete", "reject", "abandon"] as const).flatMap((terminal) => {
            const found = saga.terminals.find((t) => t.on === terminal);
            const status =
              terminal === "complete" ? "Complete" : terminal === "reject" ? "Rejected" : "Abandoned";
            if (found === undefined) return [];
            const built = buildSend(c, found.send, terminal, `on ${terminal}`);
            if (built === undefined) return [];
            return [
              `case SagaStatus.${status}:`,
              ...indent([
                "effects.Add(new SagaEffect.Send(",
                ...indent(built),
                "));",
                "break;",
              ]),
            ];
          }),
        ),
        ...indent(["default:", "    break;"]),
        "}",
      ]),
      "}",
    ]),
    "}",
  ];

  return { lines, losses: c.losses, problems: c.problems };
}
