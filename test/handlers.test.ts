/**
 * Services, as interfaces.
 *
 * Two kinds of test, and the second matters more. The first is that the signature is what the model
 * implies — the message, its envelopes, the outcome. The second is that every constraint the model
 * states reaches the reader: delivery, deduplication, filtering, authorization, retry. A handler whose
 * pipe is `at-least-once` and whose generated comment does not say "be idempotent" is a correct
 * signature attached to a bug waiting to happen.
 *
 * What is *not* tested here is that it compiles and can be implemented, because no string match can
 * establish that. `npm run verify` builds the generated interfaces with the real compiler and
 * implements one.
 */

import { describe, expect, it } from "vitest";
import { buildWorkspace, type Decl, type LinkedModel } from "@sevenk/core";
import { buildNames, compileRules, type Request } from "@sevenk/generate";
import { csharp } from "../src/index.js";

const COMMON = `
package flow.common

value Reason : string { length 1..60 }

envelope Trace {
  correlationId: uuid @role(correlation)
  priority:      int  { range 0..9 }
}

envelope Who {
  actor: Reason @role(subject)
}
`;

const DESK = `
package flow.desk

import flow.common

envelopes common.Trace, common.Who

message Submit v1.0 @command {
  ref: uuid @role(businessKey)
}

message Accepted v1.0 @event { ref: uuid @role(businessKey) }
message Refused  v1.0 @event { ref: uuid @role(businessKey) }
message Withdraw v1.0 @command { ref: uuid @role(businessKey) }
message Notify   v1.0 @command { ref: uuid @role(businessKey) }
message Logged   v1.0 @event { ref: uuid @role(businessKey) }
message Echo     v1.0 @event { ref: uuid @role(businessKey) }
message Ping     v1.0 @command { ref: uuid @role(businessKey) }
message Pong     v1.0 @event { ref: uuid @role(businessKey) }

pipe commands : queue {
  delivery    at-least-once
  ordering by ref
}

pipe events : topic {
  delivery at-least-once
}

pipe telemetry : topic {
  delivery at-most-once
  dlq      none
}

service Desk {
  emits Accepted to events
  emits Refused  to events
  emits Notify   to commands
  emits Logged   to events
  emits Echo     to events
  emits Echo     to telemetry
  emits Pong     to events

  reacts Submit from commands {
    once per ref
    requires claim.scope contains "desk.write"
    replies  Accepted | Refused
    issues   Notify
    retry    5 after 1s max 30s
  }

  reacts Withdraw from commands {
    once per none
    replies  none
  }

  reacts Withdraw from commands as sweep {
    where       envelope.priority < 5
    replies     none
    concurrency 1
    retry       0
  }

  reacts Logged from telemetry {
    replies none
  }

  reacts Ping from commands {
    replies Pong
  }
}

@external service Partner {
  emits Submit to commands
}

service Quiet {
  reacts Accepted from events
}
`;

const model = (desk = DESK): LinkedModel =>
  buildWorkspace([
    { path: "common.7k", source: COMMON },
    { path: "desk.7k", source: desk },
  ]).model;

function request(
  m: LinkedModel,
  options: Record<string, unknown> = {},
  layout: Request["layout"] = "per-declaration",
): Request {
  const { names } = buildNames(m, []);
  const compiled = compileRules(m, []);
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

const DESK_FILE = "Acme/Flow/Desk/Desk.cs";
const desk = () => fileNamed(run(model()), DESK_FILE);

/**
 * Doc comments as one line of prose.
 *
 * The generator wraps to a width somebody can read, and where it happens to break a sentence is not
 * something a test should be pinned to — only that the sentence is there.
 */
const prose = (text: string): string =>
  text
    .split(String.fromCharCode(10))
    .map((l) => l.trim().replace(/^\/\/\/ ?/, ""))
    .join(" ")
    .replace(/\s+/g, " ");

describe("the signature", () => {
  it("writes an interface per service, and no implementation of it", () => {
    // The model describes a service's interface and never its internals, so there is nothing here to
    // put a body in. A generated class would be a guess in a file marked "do not edit".
    const text = desk();
    expect(text).toContain("public partial interface IDesk");
    expect(text).not.toContain("public sealed partial class Desk");
    expect(text).not.toContain("NotImplementedException");
  });

  it("takes the message, then its envelopes, then a cancellation token", () => {
    // The envelopes come from the message's own package: a `requires` reads them, so a handler that
    // could not see them could not be given what the model says it was authorized against.
    expect(desk()).toContain(
      [
        "    Task<SubmitOutcome> HandleSubmitAsync(",
        "        global::Acme.Flow.Desk.Submit message,",
        "        global::Acme.Flow.Common.Trace trace,",
        "        global::Acme.Flow.Common.Who who,",
        "        CancellationToken cancellationToken);",
      ].join("\n"),
    );
  });

  it("returns the one reply directly when the model declares one", () => {
    // No union to disambiguate, so no type to generate for it.
    expect(desk()).toContain("Task<global::Acme.Flow.Desk.Pong> HandlePingAsync(");
    expect(desk()).not.toContain("PingOutcome");
  });

  it("returns a bare `Task` when the model declares no reply", () => {
    expect(desk()).toContain("Task HandleWithdrawAsync(");
  });

  it("names a subscription the modeller named, and only then", () => {
    // `subscription` defaults to the service's own name, so the default must not leak into a method
    // called `HandleSubmitAsDesk`.
    const text = desk();
    expect(text).toContain("HandleWithdrawAsSweepAsync(");
    expect(text).not.toContain("HandleSubmitAsDeskAsync");
  });

  it("writes nothing for an `@external` service", () => {
    // Somebody else's code. The model describes it so the system can be reasoned about whole, not so
    // it can be implemented here — and an interface is an invitation to implement.
    expect(run(model()).artifacts.map((a) => a.path)).not.toContain("Acme/Flow/Desk/Partner.cs");
  });

  it("says so when the model does not declare the replies", () => {
    // D30: an omitted `replies` is `incomplete`. The signature cannot invent what it owes its caller.
    const text = fileNamed(run(model()), "Acme/Flow/Desk/Quiet.cs");
    expect(text).toContain("Task HandleAcceptedAsync(");
    expect(prose(text)).toContain("The model does not say what this replies");
    expect(prose(text)).toContain("`incomplete`");
  });
});

describe("the outcome of more than one reply", () => {
  it("closes the hierarchy, so nothing can add a case the model does not declare", () => {
    const text = desk();
    expect(text).toContain("public abstract record SubmitOutcome");
    expect(text).toContain("private SubmitOutcome() { }");
    expect(text).toContain(
      "public sealed record Accepted(global::Acme.Flow.Desk.Accepted Message) : SubmitOutcome;",
    );
  });

  it("lets a handler return the message rather than naming its case", () => {
    expect(desk()).toContain(
      "public static implicit operator SubmitOutcome(global::Acme.Flow.Desk.Accepted message) => new Accepted(message);",
    );
  });

  it("takes one delegate per outcome, which is what makes a new reply break the build", () => {
    // A `switch` is not exhaustiveness-checked over a hierarchy however closed it is — the compiler
    // asks for a default rather than naming the case you forgot. A parameter per outcome is checked.
    const text = desk();
    expect(text).toContain("public T Match<T>(");
    expect(text).toContain("Func<global::Acme.Flow.Desk.Accepted, T> accepted,");
    expect(text).toContain("Func<global::Acme.Flow.Desk.Refused, T> refused) =>");
    expect(text).toContain("Accepted it => accepted(it.Message),");
  });

  it("qualifies the message absolutely, because the case shadows its name", () => {
    // `Accepted` the case is declared inside the scope where `Accepted` the message is resolved.
    expect(desk()).not.toContain("record Accepted(Accepted Message)");
  });
});

describe("what the comments have to carry", () => {
  const text = () => desk();

  it("demands idempotency where delivery implies redelivery", () => {
    // The one thing `at-least-once` asks of the body rather than of the transport (`01-kernel.md` 1.5).
    expect(prose(text())).toContain("This handler must be idempotent.");
    expect(prose(text())).toContain("`at-least-once` means the same message may arrive more than once");
  });

  it("warns that an at-most-once message may simply never arrive", () => {
    expect(prose(text())).toContain("`at-most-once` means a message may never arrive at all");
  });

  it("states the ordering, including when there is none", () => {
    const text2 = text();
    expect(prose(text2)).toContain("Ordered by `ref`");
    expect(prose(text2)).toContain("Unordered: two messages may be handled in either order");
  });

  it("names the deduplication key, and whose job it is", () => {
    const text2 = text();
    expect(prose(text2)).toContain("Deduplicated by `ref`");
    expect(prose(text2)).toContain("The infrastructure keeps those keys; this handler does not have to.");
  });

  it("says when the model claims idempotency instead of asking for deduplication", () => {
    // `once per none` is a claim about the code, not a property of the transport (D65).
    expect(prose(text())).toContain("the model claims this handler is idempotent by construction");
  });

  it("states a filter, and that the filtered-out messages never arrive", () => {
    expect(prose(text())).toContain("only messages where `envelope.priority &lt; 5` are delivered here");
  });

  it("escapes a comparison, because a doc comment is XML", () => {
    // An unescaped `<` makes the comment malformed and the compiler say so.
    expect(text()).not.toContain("priority < 5</para>");
    expect(text()).not.toContain("priority < 5 are delivered");
  });

  it("states the authorization as already decided, and warns against re-deciding it", () => {
    const text2 = text();
    expect(prose(text2)).toContain('`claim.scope contains "desk.write"` has been checked');
    expect(prose(text2)).toContain("must not re-decide it");
  });

  it("states retry and concurrency as policy around the handler", () => {
    const text2 = text();
    expect(prose(text2)).toContain("Retried 5 times on failure, first after 1s, exponential up to 30s");
    expect(prose(text2)).toContain("No retries: a failure here is final");
    expect(prose(text2)).toContain("At most 1 of these run at a time.");
  });

  it("says where an exhausted message goes, including when it goes nowhere", () => {
    const text2 = text();
    expect(prose(text2)).toContain("Exhausted retries go to the implicit `flow.desk.commands.dead`.");
    expect(prose(text2)).toContain("`dlq none`: a message this handler keeps failing is discarded");
  });

  it("mentions what the handler sends onward without anybody awaiting it", () => {
    expect(prose(text())).toContain("the model says it sends `flow.desk.Notify` onward");
  });

  it("leaves a TODO saying what the model cannot say", () => {
    const text2 = text();
    expect(text2).toContain("// TODO: decide what `Submit` does here.");
    expect(text2).toContain("Return one of the 2 declared outcomes; the model does not say which");
    expect(text2).toContain("Anything else this sends goes through `IDeskOutbound`.");
  });

  it("puts every note in one `remarks`, because two is not valid documentation XML", () => {
    // The second element is what a doc tool drops, and it would be the delivery note.
    const text2 = text();
    const opens = [...text2.matchAll(/\/\/\/ <remarks>/g)].length;
    const paras = [...text2.matchAll(/\/\/\/ <para>/g)].length;
    expect(paras).toBeGreaterThan(opens);
    expect(text2).not.toMatch(/<\/remarks>\n\s*\/\/\/ <remarks>/);
  });
});

describe("the outbound port", () => {
  const text = () => desk();

  it("carries what the service emits and does not return", () => {
    // Without it there is no way to send `Logged`, and the generated interface is unusable.
    expect(text()).toContain("public partial interface IDeskOutbound");
    expect(text()).toContain("Task PublishLoggedAsync(");
  });

  it("leaves out a reply, which the handler returns instead", () => {
    const text2 = text();
    expect(text2).not.toContain("Task PublishAcceptedAsync(");
    expect(text2).not.toContain("Task PublishRefusedAsync(");
  });

  it("keeps a message the model says is issued, even though it is emitted", () => {
    // Nobody awaits an `issues`, so it cannot be a return value; it has to be publishable.
    expect(text()).toContain("Task PublishNotifyAsync(");
  });

  it("names the pipe only where the same message goes to more than one", () => {
    const text2 = text();
    expect(text2).toContain("PublishEchoToEventsAsync(");
    expect(text2).toContain("PublishEchoToTelemetryAsync(");
    expect(text2).not.toContain("PublishLoggedToEventsAsync(");
  });

  it("states whether a publication is atomic with the work that caused it", () => {
    expect(prose(text())).toContain(
      "Atomic: the model says this message appears on the pipe if and only if the work that produced it",
    );
  });

  it("writes none for a service the model says emits nothing", () => {
    expect(fileNamed(run(model()), "Acme/Flow/Desk/Quiet.cs")).not.toContain("IQuietOutbound");
  });
});

describe("the file around it", () => {
  it("imports the threading namespaces a handler needs and nothing more", () => {
    const text = desk();
    expect(text).toContain("using System.Threading;");
    expect(text).toContain("using System.Threading.Tasks;");
    // No validator in this file, so neither of those belongs in it.
    expect(text).not.toContain("using Problem =");
    expect(text).not.toContain("using System.Text.RegularExpressions;");
  });

  it("fits in the other layouts too", () => {
    const single = run(model(), {}, "single");
    expect(single.artifacts).toHaveLength(1);
    expect(single.artifacts[0]!.content).toContain("public partial interface IDesk");

    const packaged = run(model(), {}, "per-package");
    expect(fileNamed(packaged, "Acme.Flow.Desk.cs")).toContain("public partial interface IDesk");
  });

  it("claims the service as its provenance", () => {
    expect(run(model()).artifacts.find((a) => a.path === DESK_FILE)?.from).toEqual(["flow.desk.Desk"]);
  });
});

/**
 * The development host.
 *
 * `compiles.test.ts` proves it builds, which is the part that matters most and the part a string
 * assertion cannot reach. What is left for here is the handful of decisions a reader would want to
 * check without reading the generator: what guards it, what it dispatches on, and how it names a reply.
 */
const HOST_FILE = "Acme/Flow/Desk/Desk.DevHost.cs";
const deskHost = () => fileNamed(run(model()), HOST_FILE);

describe("the development host", () => {
  it("is written by default, because its value is being there when you reach for it", () => {
    expect(deskHost()).toContain("public sealed partial class DeskDevHost");
  });

  it("is beside the interface rather than in it", () => {
    // Its own file: a different lifetime from the interface, a `<Compile Remove>` glob that can drop
    // it without anybody defining a constant, and a generator change that shows as a diff in a
    // development file rather than churn in a production one.
    expect(desk()).not.toContain("DevHost");
    expect(deskHost()).toContain("DeskDevHost");
  });

  it("is `partial`, as the interface beside it is", () => {
    // Wiring a handler out of a container is the obvious thing to want to add to a file the generator
    // replaces wholesale.
    expect(deskHost()).toContain("public sealed partial class DeskDevHost");
  });

  it("is guarded, which is what makes defaulting on safe", () => {
    // A dev host in production is a second entry point into every handler with nothing in front of it.
    const text = deskHost();
    expect(text).toContain("#if DEBUG || SEVENK_DEVHOST");
    expect(text).toContain("#endif");
  });

  it("takes a second constant, for the case `DEBUG` cannot serve", () => {
    // Wanting a host in a deployed staging build: defining `DEBUG` to get it would also change every
    // `Debug.Assert` and every `#if DEBUG` somebody else wrote.
    expect(deskHost()).toContain("SEVENK_DEVHOST");
  });

  it("dispatches on the message's qualified name, which is what the frame carries", () => {
    expect(deskHost()).toContain('case "flow.desk.Submit":');
  });

  it("reads the message and its envelopes out of the delivery, in the method's own order", () => {
    const text = deskHost();
    expect(text).toContain("delivery.Read<global::Acme.Flow.Desk.Submit>(json),");
    expect(text).toContain("delivery.ReadEnvelope<global::Acme.Flow.Common.Trace>(json),");
  });

  it("names a reply as the `replies` clause spells it", () => {
    // Which is the one spelling guaranteed to resolve at the other end: it resolved when the model was
    // linked, out of the package the runtime resolves it in.
    expect(deskHost()).toContain('SevenKReply.Of("Accepted"');
  });

  it("returns null where the model declares no reply", () => {
    const text = deskHost();
    const at = text.indexOf('case "flow.desk.Withdraw":');
    expect(at).toBeGreaterThan(0);
    expect(text.slice(at, at + 400)).toContain("return null;");
  });

  it("refuses a message the service does not react to, rather than acknowledging it", () => {
    expect(deskHost()).toContain("does not react to");
  });

  it("leaves the interface's file free of JSON it has no use for", () => {
    // Which folding the two together did not: the dispatcher reads JSON and the interface does not.
    expect(desk()).not.toContain("System.Text.Json");
  });

  it("is not written at all when it is turned off", () => {
    const out = run(model(), { devHost: false });
    expect(out.artifacts.map((a) => a.path)).not.toContain(HOST_FILE);
    expect(fileNamed(out, DESK_FILE)).not.toContain("DevHost");
  });

  it("says where the handler is, naming the interface's file and not its own", () => {
    // The symbol is for a method the *interface* declares, and `group` emits that file first — which
    // is the ordering the lookup depends on, so it is asserted rather than assumed.
    const out = run(model());
    const handler = out.symbols?.find((x) => x.kind === "handler" && x.symbol === "HandleSubmitAsync");
    expect(handler?.path).toBe(DESK_FILE);
  });
});
