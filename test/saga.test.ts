/**
 * Sagas, as generated code.
 *
 * These are about the *shape*: the signature, the state class, what each input returns, what is refused.
 * Whether the machine **behaves** like a saga is not something a string match can establish, and it is
 * checked instead by `npm run equivalence`, which drives this machine and the sandbox's own saga engine
 * from one script and compares every decision. Removing the phantom-timer guard, or unwinding forwards,
 * fails there and passes here — which is the division of labour on purpose.
 */

import { describe, expect, it } from "vitest";
import { buildWorkspace, type Decl, type LinkedModel } from "@sevenk/core";
import { buildNames, compileRules, type Request } from "@sevenk/generate";
import { csharp } from "../src/index.js";

const MODEL = `
package pay

envelopes Trace

value Money  : decimal(18,2) { range 0.. }
value Ref    : string { length 1..32 }
value Reason : string { length 1..60 }

envelope Trace {
  correlationId: uuid @role(correlation)
}

message Begin  v1.0 @command { orderId: Ref @role(businessKey); total: Money }
message Take   v1.0 @command { orderId: Ref @role(businessKey); amount: Money }
message Took   v1.0 @event   { orderId: Ref @role(businessKey); authId: uuid }
message Refuse v1.0 @event   { orderId: Ref @role(businessKey) }
message GiveBack v1.0 @command { orderId: Ref @role(businessKey); authId: uuid }
message Post   v1.0 @command { orderId: Ref @role(businessKey) }
message Posted v1.0 @event   { orderId: Ref @role(businessKey) }
message Won    v1.0 @event   { orderId: Ref @role(businessKey) }
message Lost   v1.0 @event   { orderId: Ref @role(businessKey); why: Reason }

pipe work : queue { delivery at-least-once }

service Teller {
  emits Take     to work
  emits GiveBack to work
  emits Post     to work
  emits Won      to work
  emits Lost     to work

  reacts Begin from work { replies none }
}

saga Settle v1.0 {

  start on Begin keyed by orderId {
    total = message.total
  }

  state {
    total:  Money
    authId: uuid
  }

  step take {
    send Take { amount = state.total }

    on Took { authId = message.authId }
    on Refuse      reject "refused"
    on timeout 30s reject "took too long"

    undo with GiveBack { authId = state.authId }
  }

  step post {
    send Post

    on Posted
    on timeout 1m reject "posting timed out"

    undo none
  }

  on deadline 1h abandon

  on complete send Won
  on reject   send Lost { why = terminal.reason }
  on abandon  send Lost { why = terminal.reason }
}
`;

const model = (source = MODEL): LinkedModel =>
  buildWorkspace([{ path: "pay.7k", source }]).model;

function request(m: LinkedModel, options: Record<string, unknown> = {}, layout: Request["layout"] = "per-declaration"): Request {
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

const SAGA = "Acme/Pay/Settle.cs";
const saga = () => fileNamed(run(model()), SAGA);

describe("the state", () => {
  it("starts every field unset, because state is assigned only from a message (D16)", () => {
    const text = saga();
    expect(text).toContain("public sealed partial class SettleState");
    expect(text).toContain("public Money? Total { get; set; }");
    expect(text).toContain("public Guid? AuthId { get; set; }");
  });

  it("fails loudly rather than quietly where the model reads state it never assigned", () => {
    // The checker is supposed to prove this cannot happen. If it does, the saga is what is wrong, and
    // a message saying so beats a NullReferenceException blaming nobody.
    expect(saga()).toContain(
      'State.Total ?? throw new InvalidOperationException("pay.Settle: `total` is unset at this point.',
    );
  });
});

describe("starting", () => {
  const text = () => saga();

  it("takes the start message and the envelopes its package declares", () => {
    expect(text()).toContain(
      "public static Begun Start(global::Acme.Pay.Begin message, global::Acme.Pay.Trace trace)",
    );
  });

  it("keys the instance from the field the model names", () => {
    expect(text()).toContain("var saga = new SettleSaga(message.OrderId.ToString(), trace);");
  });

  it("applies the start block before announcing anything", () => {
    // `saga-started` reports an instance that already holds what the start message gave it.
    const at = text();
    expect(at.indexOf("saga.State.Total = message.Total;")).toBeLessThan(
      at.indexOf("new SagaEffect.Started"),
    );
  });

  it("arms the deadline the model declares", () => {
    expect(text()).toContain("public const long DeadlineMs = 3600000;");
    expect(text()).toContain("effects.Add(new SagaEffect.ArmDeadline(DeadlineMs));");
  });

  it("arms nothing where the model declares no deadline", () => {
    const without = model(MODEL.replace("  on deadline 1h abandon\n", ""));
    const text2 = fileNamed(run(without), SAGA);
    expect(text2).toContain("public const long? DeadlineMs = null;");
    expect(text2).not.toContain("ArmDeadline");
  });

  it("leaves the host to notice a second start on a key it already holds", () => {
    // Only the host has the instance store, so only the host can see a redundant start.
    expect(text()).toContain("is a redundant start");
  });
});

describe("advancing", () => {
  const text = () => saga();

  it("takes one typed method per awaited message", () => {
    const at = text();
    expect(at).toContain("public IReadOnlyList<SagaEffect> Deliver(global::Acme.Pay.Took message)");
    expect(at).toContain("public IReadOnlyList<SagaEffect> Deliver(global::Acme.Pay.Refuse message)");
  });

  it("correlates on the awaited message's own business key", () => {
    expect(text()).toContain("message.OrderId.ToString() == Key");
  });

  it("only considers a step that is in the current stage and has not joined", () => {
    const at = text();
    expect(at).toContain('!doneInStage.Contains("take") && StepsIn(Stage).Contains("take")');
  });

  it("dispatches a message whose type is only known at runtime", () => {
    const at = text();
    expect(at).toContain("public IReadOnlyList<SagaEffect> Deliver(object message) => message switch");
    expect(at).toContain("global::Acme.Pay.Took it => Deliver(it),");
    // An unawaited message is not an error: another instance may be the one that wanted it.
    expect(at).toContain("_ => Array.Empty<SagaEffect>(),");
  });

  it("records what the `on` clause assigns, then marks the step reversible", () => {
    const at = text();
    expect(at).toContain("State.AuthId = message.AuthId;");
    expect(at.indexOf("State.AuthId = message.AuthId;")).toBeLessThan(
      at.indexOf('completed.Add("take");'),
    );
  });

  it("joins a stage only when its last branch completes", () => {
    expect(text()).toContain("if (StepsIn(Stage).All(s => doneInStage.Contains(s)))");
  });

  it("ignores anything delivered after the instance ended", () => {
    expect(text()).toContain("if (Status != SagaStatus.Running) return effects;");
  });
});

describe("giving up", () => {
  const text = () => saga();

  it("guards a timer against the stage it was armed in", () => {
    // A branch that joined while its siblings waited is still in the same stage, and the timer it
    // armed must not fire on it. Without this, a late firing rejects a saga that already moved on.
    expect(text()).toContain("public IReadOnlyList<SagaEffect> Timeout(string step, int stage)");
    expect(text()).toContain("if (stage != Stage || doneInStage.Contains(step)) return effects;");
  });

  it("names the step a timeout and a rejection came from", () => {
    const at = text();
    expect(at).toContain('effects.Add(new SagaEffect.TimedOut("take", 30000));');
    expect(at).toContain('Terminate(effects, SagaStatus.Rejected, "take", "took too long");');
  });

  it("names no step for a deadline, because none ended it", () => {
    // That absence is how a consumer tells a failed step from the clock running out while it waited.
    expect(text()).toContain(
      'Terminate(effects, SagaStatus.Abandoned, null, "deadline elapsed");',
    );
  });

  it("announces the terminal before the compensation it causes", () => {
    const at = text();
    expect(at.indexOf("effects.Add(new SagaEffect.Ended(terminal, step, reason));")).toBeLessThan(
      at.indexOf("if (terminal != SagaStatus.Complete) Unwind(effects);"),
    );
  });

  it("cancels every branch's timer, not just the one that ended it", () => {
    expect(text()).toContain("foreach (var waiting in Waiting) effects.Add(new SagaEffect.CancelTimeout(waiting));");
  });
});

describe("compensating", () => {
  const text = () => saga();

  it("reverses the completed steps, in reverse order", () => {
    // Completion order, not declaration order: for a stage the two differ and only one means anything.
    expect(text()).toContain("for (var i = completed.Count - 1; i >= 0; i--)");
  });

  it("sends the inverse the step declares, with the state only the saga holds", () => {
    const at = text();
    expect(at).toContain('effects.Add(new SagaEffect.Compensating("take", "pay.GiveBack"));');
    expect(at).toContain("AuthId = State.AuthId ??");
  });

  it("says a step cannot be reversed rather than pretending it can", () => {
    expect(text()).toContain('effects.Add(new SagaEffect.Irreversible("post"));');
  });

  it("reverses nothing for a step that never completed", () => {
    // The asymmetry a saga test exists to check: `Unwind` reads `completed`, and only that.
    expect(text()).toContain("switch (completed[i])");
  });
});

describe("the messages it sends", () => {
  const text = () => saga();

  it("fills the business key from the instance key, converting as the field's type needs", () => {
    expect(text()).toContain("OrderId = new global::Acme.Pay.Ref(Key),");
  });

  it("fills a field the `send` block names", () => {
    expect(text()).toContain("Amount = State.Total ??");
  });

  it("fills a field from a state field of the same name", () => {
    // `Post` says nothing, and `orderId` is the key — so nothing is left to say.
    expect(text()).toContain('}, "pay.Post", "step post"');
  });

  it("puts the wrapper back on a terminal reason going into a nominal field", () => {
    // `terminal.reason` is a string and `Lost.why` is a `Reason`.
    expect(text()).toContain("Why = new global::Acme.Pay.Reason(Reason ??");
  });

  it("says what asked for each send, which is what a trace records", () => {
    const at = text();
    expect(at).toContain('"step take"');
    expect(at).toContain('"undo of take"');
    expect(at).toContain('"on reject"');
  });
});

describe("what it refuses", () => {
  it("refuses a send the model does not determine, rather than inventing a value", () => {
    // The sandbox generates one, because it is a test harness and a scenario has to keep moving.
    // C# cannot construct the record at all, and a generated amount is a guess with a model behind it.
    const broken = MODEL.replace("send Take { amount = state.total }", "send Take");
    const out = run(model(broken));
    const refusal = out.refusals.find((r) => r.at.includes("Settle"));
    expect(refusal?.declared).toContain("`send pay.Take` without `amount`");
    expect(refusal?.because).toContain("add the assignment to the model");
    expect(out.artifacts.map((a) => a.path)).not.toContain(SAGA);
  });

  it("carries the gap in the file under `--draft`, so a partial build cannot pass for a finished one", () => {
    const broken = MODEL.replace("send Take { amount = state.total }", "send Take");
    const refusal = run(model(broken)).refusals.find((r) => r.at.includes("Settle"));
    expect(refusal?.draft?.[0]?.content).toContain("#error 7K:");
  });

  it("refuses a saga nothing can key an instance from", () => {
    const broken = MODEL.replace(
      "message Begin  v1.0 @command { orderId: Ref @role(businessKey); total: Money }",
      "message Begin  v1.0 @command { orderId: Ref; total: Money }",
    ).replace("start on Begin keyed by orderId {", "start on Begin {");
    const refusal = run(model(broken)).refusals.find((r) => r.at === "pay.Settle");
    expect(refusal?.because).toContain("Nothing keys an instance");
  });
});

describe("the file around it", () => {
  it("implements the interface a host can drive any saga through", () => {
    expect(saga()).toContain("public sealed partial class SettleSaga : ISagaMachine");
    expect(fileNamed(run(model()), "Acme/Sagas.cs")).toContain("public interface ISagaMachine");
  });

  it("writes the shared saga types once, and not at all without a saga", () => {
    const paths = run(model()).artifacts.map((a) => a.path);
    expect(paths).toContain("Acme/Sagas.cs");

    const noSaga = MODEL.slice(0, MODEL.indexOf("saga Settle"));
    expect(run(model(noSaga)).artifacts.map((a) => a.path)).not.toContain("Acme/Sagas.cs");
  });

  it("names the steps so a host need not spell them", () => {
    const at = saga();
    expect(at).toContain('public const string Take = "take";');
    expect(at).toContain('public const string Post = "post";');
  });

  it("exposes where the instance is in the model's own vocabulary", () => {
    // A terminal matches the status; a step name matches a branch still awaited, so an instance in a
    // `parallel` block is in both of its steps.
    const at = saga();
    expect(at).toContain("public string StateName =>");
    expect(at).toContain("public bool IsIn(string name) =>");
  });

  it("folds the shared types into the one file under `single`", () => {
    const out = run(model(), {}, "single");
    expect(out.artifacts).toHaveLength(1);
    expect(out.artifacts[0]!.content).toContain("public interface ISagaMachine");
    expect(out.artifacts[0]!.content).toContain("public sealed partial class SettleSaga");
  });

  it("claims the saga as its provenance", () => {
    expect(run(model()).artifacts.find((a) => a.path === SAGA)?.from).toEqual(["pay.Settle"]);
  });
});

describe("stages", () => {
  // The same two steps written in one `parallel` block, which is the only difference between a
  // sequential saga and a concurrent one as far as the IR is concerned.
  const PARALLEL = MODEL.replace(
    "  step take {",
    "  parallel {\n  step take {",
  ).replace(
    "    undo none\n  }\n\n  on deadline 1h abandon",
    "    undo none\n  }\n  }\n\n  on deadline 1h abandon",
  );

  it("is a fixture that parses, so the rest of this means something", () => {
    const errors = buildWorkspace([{ path: "pay.7k", source: PARALLEL }]).diagnostics.filter(
      (d) => d.severity === "error",
    );
    expect(errors).toEqual([]);
    expect(PARALLEL).toContain("parallel {");
  });

  it("puts a `parallel` block's branches in one stage, and sends them together", () => {
    const text = fileNamed(run(model(PARALLEL)), SAGA);
    expect(text).toContain('0 => new[] { "take", "post" },');
    // One `case 0:` holding both sends, which is what makes the stage concurrent rather than a
    // sequence written with extra words.
    const at = text.indexOf("case 0:");
    const stage = text.slice(at, text.indexOf("default:", at));
    expect(stage).toContain('"step take"');
    expect(stage).toContain('"step post"');
  });

  it("keeps a bare step as a stage of its own", () => {
    const text = saga();
    expect(text).toContain('0 => new[] { "take" },');
    expect(text).toContain('1 => new[] { "post" },');
  });
});

