/**
 * Services, as interfaces and nothing more.
 *
 * **7K describes a service's interface, never its internals** (`03-topology.md` 2.0). So this generates
 * the shape a handler must have, every constraint the model places on it as a comment where somebody
 * will read it, and a `TODO` saying what the model cannot say. It does not generate a body, because
 * there is nothing in the model to generate one from — a generator that invented one would be guessing,
 * and a guess in a file marked "do not edit" is worse than an empty method.
 *
 * **Three things the model declares that deliberately become comments rather than code**, because they
 * belong to the infrastructure a service runs on and not to the service:
 *
 * - *Delivery.* `at-least-once` is a property of the transport. What it asks of the handler is
 *   idempotency (`01-kernel.md` 1.5), and that is a statement about the body — so it is said, loudly,
 *   and not implemented.
 * - *Deduplication.* `once per orderRef` names the key. Holding the keys is the broker's or the
 *   framework's job; the model's contribution is which field to hold them by.
 * - *Retry, concurrency and dead-lettering.* Policy, applied around the handler.
 *
 * **What does become code is the outcome.** `replies SeatsReserved | SeatsRejected` says the handler
 * returns exactly one of two things, and C# has no sum type — so a closed hierarchy is generated for it,
 * with a `Match` that takes one delegate per outcome. Add a reply to the model and every call site stops
 * compiling until somebody decides what the new outcome means, which is the whole reason to generate a
 * type rather than a comment saying "return one of these".
 */

import type { Decl, EmitIr, LinkedModel, Predicate, ReactIr, Ref, ServiceIr } from "@sevenk/core";
import type { Loss } from "@sevenk/provider";
import { namespaceOf, pascal, type TypeContext } from "./types.js";
import { describePredicate } from "./validate.js";

export interface Handlers {
  readonly lines: readonly string[];
  readonly losses: readonly Loss[];
  /** Whether the file needs `System.Threading` and `System.Threading.Tasks`. */
  readonly needsAsync: boolean;
}

const indent = (lines: readonly string[]): string[] => lines.map((l) => (l === "" ? "" : `    ${l}`));

/** A parameter name from a type name: `Trace` becomes `trace`. */
const camel = (name: string): string => {
  const p = pascal(name);
  return p.charAt(0).toLowerCase() + p.slice(1);
};

/** A C# name that cannot be captured by anything, for a type named inside another type's scope. */
const absolute = (decl: Decl, ctx: TypeContext): string =>
  `global::${namespaceOf(decl.id.pkg, ctx.root)}.${pascal(decl.id.name)}`;

const qname = (decl: Decl): string =>
  decl.id.pkg === "" ? decl.id.name : `${decl.id.pkg}.${decl.id.name}`;

/**
 * XML, not text.
 *
 * A doc comment is parsed as XML, so a `<` from a predicate — `amount < 100` is an ordinary 7K
 * comparison — makes the comment malformed and the compiler say so. Escaping is not optional here.
 */
export const escapeXml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Wraps prose at a width somebody can read in a narrow editor pane. */
function wrap(text: string): string[] {
  const words = escapeXml(text).split(/\s+/).filter((w) => w !== "");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line !== "" && `${line} ${word}`.length > 104) {
      lines.push(line);
      line = word;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

const doc = (tag: "summary" | "remarks", text: string): string[] => [
  `/// <${tag}>`,
  ...wrap(text).map((l) => `/// ${l}`),
  `/// </${tag}>`,
];

/**
 * Several paragraphs in one `<remarks>`.
 *
 * One tag per member, because a member with two `<remarks>` elements is not valid documentation XML and
 * the second one is what a doc tool drops — which would be the delivery note, or the authorization note,
 * silently gone from the only place a reader was going to see it.
 */
const remarks = (paragraphs: readonly string[]): string[] =>
  paragraphs.length === 0
    ? []
    : [
        "/// <remarks>",
        ...paragraphs.flatMap((p) => ["/// <para>", ...wrap(p).map((l) => `/// ${l}`), "/// </para>"]),
        "/// </remarks>",
      ];

/** `v1.0`, `v1.x`, `v1.2..v2.4`, `v1.2+` — as the model writes them. */
function acceptsText(accepts: ReactIr["accepts"]): string {
  if (accepts === undefined) return "every version";
  switch (accepts.k) {
    case "exact":
      return `exactly v${accepts.at.major}.${accepts.at.minor}`;
    case "major":
      return `any minor of v${accepts.major}`;
    case "range":
      return `v${accepts.from.major}.${accepts.from.minor} to v${accepts.to.major}.${accepts.to.minor}`;
    default:
      return `v${accepts.at.major}.${accepts.at.minor} and later`;
  }
}

const seconds = (ms: number): string =>
  ms % 3600000 === 0 && ms >= 3600000
    ? `${ms / 3600000}h`
    : ms % 60000 === 0 && ms >= 60000
      ? `${ms / 60000}m`
      : ms % 1000 === 0
        ? `${ms / 1000}s`
        : `${ms}ms`;

/**
 * Everything the model says about one subscription, as sentences.
 *
 * Long, and meant to be: this is the only place a reader can see the whole contract at once, and the
 * alternative is reading the `.7k` file in another window while writing the handler.
 */
function contract(react: ReactIr, service: ServiceIr, ctx: TypeContext, model: LinkedModel): string[] {
  const paragraphs: string[] = [];
  const say = (text: string): void => {
    paragraphs.push(text);
  };

  const pipe = model.declFor(react.pipe);
  const message = model.declFor(react.message);

  if (pipe !== undefined && pipe.kind === "pipe") {
    say(
      `Arrives on the ${pipe.pipeKind} \`${qname(pipe)}\`, which the model declares ` +
        `\`${pipe.delivery}\`${pipe.durable ? " and durable" : " and not durable"}. ` +
        `Accepts ${acceptsText(react.accepts)}.`,
    );

    // The one thing delivery asks of the body rather than of the transport.
    if (pipe.delivery !== "at-most-once") {
      say(
        `This handler must be idempotent. \`${pipe.delivery}\` means the same message may arrive ` +
          `more than once, and handling it twice must have the same effect as handling it once ` +
          `(\`01-kernel.md\` 1.5). The transport does not provide that; the body does.`,
      );
    } else {
      say(
        `\`at-most-once\` means a message may never arrive at all. Nothing here will tell you that ` +
          `one was lost, so this must not be the only path by which something important happens.`,
      );
    }

    if (pipe.orderingBy !== undefined) {
      say(`Ordered by \`${pipe.orderingBy}\`: messages sharing that value arrive in the order sent.`);
    } else {
      say(`Unordered: two messages may be handled in either order, or at the same time.`);
    }

    if (pipe.dlq === null) {
      say(`\`dlq none\`: a message this handler keeps failing is discarded. Nothing holds it for you.`);
    } else if (pipe.dlq !== undefined) {
      const dead = model.declFor(pipe.dlq);
      if (dead !== undefined) say(`Exhausted retries go to \`${qname(dead)}\`.`);
    } else {
      say(`Exhausted retries go to the implicit \`${qname(pipe)}.dead\`.`);
    }
  }

  // Deduplication: the model names the key, the infrastructure holds it.
  if (react.dedupe === undefined) {
    const key =
      message !== undefined && (message.kind === "message" || message.kind === "record")
        ? message.fields.find((f) => f.role === "businessKey")?.name
        : undefined;
    if (key !== undefined) {
      say(
        `Deduplicated by \`${key}\`, the message's \`@role(businessKey)\`. The infrastructure keeps ` +
          `those keys; this handler does not have to.`,
      );
    }
  } else if ("by" in react.dedupe) {
    say(
      `Deduplicated by \`${react.dedupe.by}\`, which the subscription names with \`once per\`. The ` +
        `infrastructure keeps those keys; this handler does not have to.`,
    );
  } else {
    say(
      `\`once per none\`: the model claims this handler is idempotent by construction, so nothing ` +
        `deduplicates for it. That claim is about the code below.`,
    );
  }

  if (react.where !== undefined) {
    say(
      `Filtered: only messages where \`${describePredicate(react.where)}\` are delivered here. The ` +
        `others go elsewhere or nowhere, and this handler never sees them.`,
    );
  }

  if (react.requires !== undefined) {
    say(
      `Authorized before it arrives: \`${describePredicate(react.requires)}\` has been checked. This ` +
        `handler may assume it and must not re-decide it — a second, different check is how two ` +
        `answers to one question get shipped.`,
    );
  }

  if (react.concurrency !== undefined) {
    say(`At most ${react.concurrency} of these run at a time.`);
  }

  if (react.retry !== undefined) {
    const { retries, delayMs, backoff, maxMs } = react.retry;
    say(
      retries === 0
        ? `No retries: a failure here is final, and goes straight to the dead letter.`
        : `Retried ${retries} times on failure, first after ${seconds(delayMs)}, ${backoff}` +
            `${maxMs === undefined ? "" : ` up to ${seconds(maxMs)}`}. Throwing is how you ask for a ` +
            `retry; returning is how you say it is done.`,
    );
  }

  if (react.issues !== undefined && react.issues.length > 0) {
    const names = react.issues
      .map((ref) => model.declFor(ref))
      .filter((d): d is Decl => d !== undefined)
      .map((d) => `\`${qname(d)}\``);
    say(
      `While handling this, the model says it sends ${names.join(", ")} onward. Nobody awaits those, ` +
        `so they are published through the outbound port rather than returned.`,
    );
  }

  if (react.replies === undefined) {
    // D30: an omitted `replies` is `incomplete`, which 7K's own checker reports.
    say(
      `The model does not say what this replies, so neither does this signature. 7K reports that as ` +
        `\`incomplete\`; until it is declared, nothing can know what this handler owes its caller.`,
    );
  }

  void service;
  void ctx;
  return remarks(paragraphs);
}

/** The method name: the message, and the subscription too where the modeller named one. */
function methodName(react: ReactIr, service: ServiceIr, model: LinkedModel, suffix: string): string {
  const message = model.declFor(react.message);
  const base = pascal(message?.id.name ?? react.message.text);
  // `subscription` defaults to the service's own name; anything else is a name the modeller chose.
  return react.subscription === service.id.name
    ? `Handle${base}${suffix}`
    : `Handle${base}As${pascal(react.subscription)}${suffix}`;
}

const repliesOf = (react: ReactIr, model: LinkedModel): Decl[] =>
  (react.replies ?? [])
    .filter((r): r is Ref => r !== "none")
    .map((ref) => model.declFor(ref))
    .filter((d): d is Decl => d !== undefined);

/**
 * A closed set of outcomes, for a subscription that may reply with more than one thing.
 *
 * Nested in the interface so that it is named where it applies and cannot collide with another
 * service's outcome for the same message.
 *
 * **`Match` is the part that earns this type.** C# has no sum type, and a `switch` over a hierarchy is
 * not exhaustiveness-checked however the hierarchy is closed — the compiler asks for a default case
 * instead of telling you which case you forgot. A method taking one delegate per outcome *is* checked,
 * by ordinary overload resolution: add a reply to the model and every call site stops compiling until
 * somebody decides what the new outcome means. That is the property worth generating a type for.
 *
 * The private constructor still matters: nothing outside can add a fourth case, so `Match` is total and
 * its unreachable branch really is unreachable.
 */
function outcome(name: string, replies: readonly Decl[], ctx: TypeContext): string[] {
  const cases = replies.map((decl) => ({
    case: pascal(decl.id.name),
    parameter: camel(decl.id.name),
    type: absolute(decl, ctx),
    qname: qname(decl),
  }));

  return [
    ...doc(
      "summary",
      `Exactly one of the replies the model declares for this subscription: ` +
        `${cases.map((c) => `\`${c.qname}\``).join(" or ")}.`,
    ),
    `public abstract record ${name}`,
    "{",
    ...indent([
      "// Closed: the cases below reach this constructor, and nothing outside the type can.",
      `private ${name}() { }`,
      ...cases.flatMap((c) => [
        "",
        ...doc("summary", `The handler replied with \`${c.qname}\`.`),
        `public sealed record ${c.case}(${c.type} Message) : ${name};`,
        "",
        ...doc("summary", `Lets a handler \`return\` the message itself rather than naming its case.`),
        `public static implicit operator ${name}(${c.type} message) => new ${c.case}(message);`,
      ]),
      "",
      ...remarks([
        `One delegate per outcome the model declares, so that a reply added to the model breaks every ` +
          `call site until somebody decides what it means. A \`switch\` would compile and silently ` +
          `fall through.`,
      ]),
      ...doc("summary", `Handles every outcome, and will not compile unless it handles every outcome.`),
      `public T Match<T>(`,
      ...indent(
        cases.map((c, i) => `Func<${c.type}, T> ${c.parameter}${i < cases.length - 1 ? "," : ") =>"}`),
      ),
      ...indent([
        "this switch",
        "{",
        ...indent([
          ...cases.map((c) => `${c.case} it => ${c.parameter}(it.Message),`),
          // Unreachable, because the constructor above is private. Still required: the compiler does
          // not reason about a closed hierarchy, which is exactly why `Match` exists.
          `_ => throw new InvalidOperationException("Unreachable: ${name} is closed."),`,
        ]),
        "};",
      ]),
    ]),
    "}",
  ];
}

/** `Task`, `Task<X>`, or `Task<TheOutcome>`. */
function returns(replies: readonly Decl[], outcomeName: string, ctx: TypeContext): string {
  if (replies.length === 0) return "Task";
  if (replies.length === 1) return `Task<${absolute(replies[0]!, ctx)}>`;
  return `Task<${outcomeName}>`;
}

/** The envelope parameters, from the package the message belongs to (D50). */
function envelopesFor(message: Decl | undefined, ctx: TypeContext, model: LinkedModel): Decl[] {
  if (message === undefined) return [];
  const refs = model.packages.get(message.id.pkg)?.envelopes ?? [];
  return refs.map((ref) => model.declFor(ref)).filter((d): d is Decl => d !== undefined);
}

/**
 * What a service may publish that it does not return.
 *
 * A reply is returned and routed by whatever hosts the handler; everything else the model says a
 * service emits, it emits itself — so without this there is no way to send `SeatLedgerAdjusted` and the
 * generated interface is unusable. Listing exactly what the model declares is also the point: there is
 * no method for a message the model never said this service sends.
 */
function outbound(
  service: ServiceIr,
  ctx: TypeContext,
  model: LinkedModel,
  suffix: string,
): { lines: string[]; name: string } | undefined {
  const replied = new Set<string>();
  for (const react of service.reacts) for (const decl of repliesOf(react, model)) replied.add(qname(decl));

  const issued = new Set<string>();
  for (const react of service.reacts) {
    for (const ref of react.issues ?? []) {
      const decl = model.declFor(ref);
      if (decl !== undefined) issued.add(qname(decl));
    }
  }

  const sends: { emit: EmitIr; decl: Decl; pipe: Decl | undefined }[] = [];
  for (const emit of service.emits) {
    const decl = model.declFor(emit.message);
    if (decl === undefined) continue;
    // A reply travels back through the same `emits`; the handler returns it rather than publishing it.
    if (replied.has(qname(decl)) && !issued.has(qname(decl))) continue;
    sends.push({ emit, decl, pipe: model.declFor(emit.pipe) });
  }
  if (sends.length === 0) return undefined;

  const perMessage = new Map<string, number>();
  for (const s of sends) perMessage.set(qname(s.decl), (perMessage.get(qname(s.decl)) ?? 0) + 1);

  const name = `I${pascal(service.id.name)}Outbound`;
  const methods = sends.flatMap(({ emit, decl, pipe }) => {
    // Named for the pipe too, but only where the same message goes to more than one.
    const where_ =
      (perMessage.get(qname(decl)) ?? 0) > 1 && pipe !== undefined ? `To${pascal(pipe.id.name)}` : "";
    const where = pipe === undefined ? "a pipe that does not resolve" : `\`${qname(pipe)}\``;
    return [
      ...doc("summary", `Publishes \`${qname(decl)}\` to ${where}.`),
      ...remarks([
        emit.publication === "atomic"
          ? `Atomic: the model says this message appears on the pipe if and only if the work that ` +
            `produced it completed. Publishing it outside that transaction would break the claim.`
          : `\`best-effort\`: the model permits this to be lost even though the work completed. ` +
            `Nothing recovers it, so nothing downstream may treat its absence as meaning the work ` +
            `did not happen.`,
        ...(emit.version === undefined
          ? []
          : [`Pinned to v${emit.version} by the model, not to the message's own version.`]),
      ]),
      `Task Publish${pascal(decl.id.name)}${where_}${suffix}(${absolute(decl, ctx)} message, CancellationToken cancellationToken);`,
      "",
    ];
  });

  return {
    name,
    lines: [
      ...doc("summary", `Everything \`${qname(service)}\` is permitted to publish, and nothing else.`),
      `public partial interface ${name}`,
      "{",
      ...indent(methods.slice(0, -1)),
      "}",
    ],
  };
}

/**
 * The interfaces for one service, or nothing where there is nothing to state.
 *
 * An `@external` service is somebody else's code — the model describes it so that the system can be
 * reasoned about whole, not so that it can be implemented here. Generating an interface for one would
 * invite somebody to implement it, which is the opposite of what `@external` says.
 */
export function handlersFor(
  decl: Decl,
  ctx: TypeContext,
  model: LinkedModel,
  asyncSuffix: boolean,
): Handlers | undefined {
  if (decl.kind !== "service" || decl.external) return undefined;
  if (decl.reacts.length === 0 && decl.emits.length === 0) return undefined;

  const losses: Loss[] = [];
  const name = `I${pascal(decl.id.name)}`;
  const members: string[] = [];
  // The .NET convention for a `Task`-returning method, which plenty of codebases enforce with an
  // analyzer — and a generated file that trips one gets its whole directory excluded from analysis.
  const suffix = asyncSuffix ? "Async" : "";
  const port = outbound(decl, ctx, model, suffix);

  for (const react of decl.reacts) {
    const message = model.declFor(react.message);
    if (message === undefined) continue;

    const method = methodName(react, decl, model, suffix);
    const replies = repliesOf(react, model);
    // The outcome is named for the handler, minus the convention noise around it.
    const outcomeName = `${method.replace(/^Handle/, "").replace(/Async$/, "")}Outcome`;

    if (replies.length > 1) members.push(...outcome(outcomeName, replies, ctx), "");

    const envelopes = envelopesFor(message, ctx, model);
    const parameters = [
      `${absolute(message, ctx)} message`,
      ...envelopes.map((e) => `${absolute(e, ctx)} ${camel(e.id.name)}`),
      "CancellationToken cancellationToken",
    ];

    members.push(
      ...doc(
        "summary",
        `Handles \`${qname(message)}\`${react.subscription === decl.id.name ? "" : ` as \`${react.subscription}\``}.`,
      ),
      ...contract(react, decl, ctx, model),
      // What the model cannot state, said where somebody implementing this will see it.
      `// TODO: decide what \`${message.id.name}\` does here.`,
      replies.length === 0
        ? `//       The model declares no reply, so finishing without throwing is the whole outcome.`
        : replies.length === 1
          ? `//       Return the \`${qname(replies[0]!)}\` the model declares as the outcome.`
          : `//       Return one of the ${replies.length} declared outcomes; the model does not say which, and cannot.`,
      ...(port === undefined
        ? []
        : [`//       Anything else this sends goes through \`${port.name}\`.`]),
      `${returns(replies, outcomeName, ctx)} ${method}(`,
      ...indent(parameters.map((p, i) => `${p}${i < parameters.length - 1 ? "," : ");"}`)),
      "",
    );
  }

  const lines: string[] = [];

  if (members.length > 0) {
    lines.push(
      ...doc(
        "summary",
        `What \`${qname(decl)}\` must handle. The model states the contract; the body is yours.`,
      ),
      ...doc(
        "remarks",
        `Generated from a 7K model, which describes a service's interface and never its internals ` +
          `(\`03-topology.md\` 2.0). Delivery, deduplication, retry and authorization are declared ` +
          `above each method and provided by whatever hosts it — they are not implemented here, and ` +
          `the comments say which of them still ask something of your code.`,
      ),
      `public partial interface ${name}`,
      "{",
      ...indent(members.slice(0, -1)),
      "}",
    );
  }

  if (port !== undefined) {
    if (lines.length > 0) lines.push("");
    lines.push(...port.lines);
  }

  if (lines.length === 0) return undefined;
  return { lines, losses, needsAsync: true };
}

export type { Predicate };
