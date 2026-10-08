/**
 * The development host: a generated service running inside a 7K Sandbox scenario, under your debugger.
 *
 * `@sevenk/sandbox`'s `overProcess` makes a child process a live handler, so one service can run for
 * real while everything it talks to stays mocked. This is the C# end of that: a fixed runtime that
 * speaks the protocol, and a generated dispatcher per service that turns a frame into a call on the
 * interface this provider already writes.
 *
 * **Why the dispatcher has to be generated.** Only this provider knows what it called the handler, what
 * order it put the envelope parameters in, and what the outcome cases are — those names are its own
 * convention applied to the model, and they move when `asyncSuffix` or `messageType` does. A reflective
 * host would be re-deriving them and would be wrong the first time an option changed. It is the same
 * argument that put `GeneratedSymbol` in the provider rather than in a tool.
 *
 * **Why the protocol is not generated.** It is `Handler` serialised, and the `Handler` contract belongs
 * to the sandbox. A provider that defined its own frame format would be a second definition of a thing
 * with one meaning, and the first time a second language was adapted the two would drift.
 *
 * **Three independent ways to not have it, which is the point of a default being on.** The option
 * itself turns the generation off. The dispatcher goes in its own `*.DevHost.cs` file, which a project
 * can drop with one `<Compile Remove>` glob. And the code is guarded, so a build without the constant
 * has none of it. They guard against different mistakes — a manifest nobody read, a file somebody
 * wanted gone, a configuration somebody shipped — and the last one is what makes defaulting on safe at
 * all: a dev host in production is a second entry point into every handler with nothing in front of it.
 *
 * The guard is `DEBUG || SEVENK_DEVHOST` rather than `DEBUG` alone. `DEBUG` is what makes it work with
 * no setup, since it is defined in a Debug configuration and not a Release one. The second constant is
 * for the case `DEBUG` cannot serve: wanting a host in a deployed staging build, where defining `DEBUG`
 * to get it would also change every `Debug.Assert` and every `#if DEBUG` somebody else wrote.
 */

/**
 * The fixed half, emitted once beside `Problem`.
 *
 * Deliberately small and deliberately not clever: a transport, a frame, and the one mapping that
 * matters — a thrown exception becomes "it failed" and never a reply the model does not declare.
 */
export const DEV_HOST_SUPPORT: readonly string[] = [
  "#if DEBUG || SEVENK_DEVHOST",
  "/// <summary>",
  "/// One delivery from a 7K Sandbox scenario.",
  "/// </summary>",
  "/// <remarks>",
  "/// <para>",
  "/// Exactly a handler's parameters and nothing else. A message, its envelope fields flattened as the",
  "/// language flattens them, and an id to answer with. Claims are not here because <c>requires</c> was",
  "/// decided before dispatch, and sending them would invite a handler to decide authorization a second",
  "/// time and differently. The sender and the pipe are not here because the subscription already",
  "/// decided, and a handler that could read either could branch on something the model does not say.",
  "/// </para>",
  "/// </remarks>",
  "public sealed record SevenKDelivery(",
  "    [property: global::System.Text.Json.Serialization.JsonPropertyName(\"id\")] long Id,",
  "    [property: global::System.Text.Json.Serialization.JsonPropertyName(\"type\")] string Type,",
  "    [property: global::System.Text.Json.Serialization.JsonPropertyName(\"version\")] string? Version,",
  "    [property: global::System.Text.Json.Serialization.JsonPropertyName(\"body\")]",
  "    global::System.Text.Json.Nodes.JsonObject Body,",
  "    [property: global::System.Text.Json.Serialization.JsonPropertyName(\"envelope\")]",
  "    global::System.Text.Json.Nodes.JsonObject Envelope)",
  "{",
  "    /// <summary>The message, as the type this provider generated for it.</summary>",
  "    public T Read<T>(global::System.Text.Json.JsonSerializerOptions json) =>",
  "        global::System.Text.Json.JsonSerializer.Deserialize<T>(Body, json)!;",
  "",
  "    /// <summary>",
  "    /// One envelope record, out of the flattened fields.",
  "    /// </summary>",
  "    /// <remarks>",
  "    /// The fields arrive flat rather than grouped by record, so every envelope type is read from the",
  "    /// same object. Unknown members are ignored, which is what makes that work and not a trick: a",
  "    /// package's envelope field names are unique across its records, or the flattening itself would",
  "    /// collide.",
  "    /// </remarks>",
  "    public T ReadEnvelope<T>(global::System.Text.Json.JsonSerializerOptions json) =>",
  "        global::System.Text.Json.JsonSerializer.Deserialize<T>(Envelope, json)!;",
  "}",
  "",
  "/// <summary>One of the subscription's declared replies, on its way back.</summary>",
  "public sealed record SevenKReply(string Reply, global::System.Text.Json.Nodes.JsonNode Body)",
  "{",
  "    /// <summary>",
  "    /// Names the reply as the model's own <c>replies</c> clause writes it.",
  "    /// </summary>",
  "    /// <remarks>",
  "    /// Which is the one spelling guaranteed to resolve, because it resolved once already: when",
  "    /// the model was linked, out of the package the service is in — which is the package the",
  "    /// runtime resolves it in too.",
  "    /// </remarks>",
  "    public static SevenKReply Of<T>(",
  "        string reply,",
  "        T message,",
  "        global::System.Text.Json.JsonSerializerOptions json) =>",
  "        new(reply, global::System.Text.Json.JsonSerializer.SerializeToNode(message, json)!);",
  "}",
  "",
  "/// <summary>A generated dispatcher, so one host can run whichever service it was given.</summary>",
  "public interface ISevenKServiceHost",
  "{",
  "    /// <summary>The service's declared name, which is what the scenario registers it under.</summary>",
  "    string Service { get; }",
  "",
  "    /// <summary>Calls the handler for one delivery. Returns null where the model declares no reply.</summary>",
  "    global::System.Threading.Tasks.Task<SevenKReply?> DispatchAsync(",
  "        SevenKDelivery delivery,",
  "        global::System.Threading.CancellationToken cancellationToken);",
  "}",
  "",
  "/// <summary>",
  "/// Runs a dispatcher against a 7K Sandbox scenario: one frame per line in, one per line out.",
  "/// </summary>",
  "/// <remarks>",
  "/// <para>",
  "/// Standard output is the protocol channel, so the first thing this does is move",
  "/// <c>Console.Out</c> to standard error. Without that a <c>Console.WriteLine</c> anywhere in a",
  "/// handler would corrupt the stream — which is the most ordinary thing a handler does.",
  "/// </para>",
  "/// <para>",
  "/// There is no deadline on a delivery, deliberately. The sandbox's clock is virtual, so no model",
  "/// time passes while you are stopped on a breakpoint; a timeout here would put a wall clock back",
  "/// into a runtime that went to some trouble not to have one.",
  "/// </para>",
  "/// </remarks>",
  "public static class SevenKDevHost",
  "{",
  "    public static async global::System.Threading.Tasks.Task RunAsync(",
  "        ISevenKServiceHost host,",
  "        global::System.Text.Json.JsonSerializerOptions json,",
  "        global::System.Threading.CancellationToken cancellationToken = default)",
  "    {",
  "        var wire = global::System.Console.Out;",
  "        global::System.Console.SetOut(global::System.Console.Error);",
  "",
  "        await Write(wire, new { ready = host.Service }, json).ConfigureAwait(false);",
  "",
  "        string? line;",
  "        while ((line = await global::System.Console.In.ReadLineAsync().ConfigureAwait(false)) is not null)",
  "        {",
  "            if (line.Length == 0) continue;",
  "",
  "            long id = 0;",
  "            object answer;",
  "            try",
  "            {",
  "                var delivery = global::System.Text.Json.JsonSerializer",
  "                    .Deserialize<SevenKDelivery>(line, json)!;",
  "                id = delivery.Id;",
  "                var reply = await host.DispatchAsync(delivery, cancellationToken).ConfigureAwait(false);",
  "                answer = reply is null",
  "                    ? new { id, handled = true, reply = (string?)null, body = (global::System.Text.Json.Nodes.JsonNode?)null }",
  "                    : new { id, handled = true, reply = (string?)reply.Reply, body = (global::System.Text.Json.Nodes.JsonNode?)reply.Body };",
  "            }",
  "            catch (global::System.Exception failure)",
  "            {",
  "                // Only that it failed crosses back. \"The gateway timed out\" and \"the database",
  "                // deadlocked\" are the same observable to everything downstream, and an exception must",
  "                // never arrive as a reply the model does not declare. The sandbox then retries it",
  "                // under the subscription's own policy, exactly as it would an in-process handler.",
  "                answer = new { id, failed = failure.Message };",
  "            }",
  "",
  "            await Write(wire, answer, json).ConfigureAwait(false);",
  "        }",
  "    }",
  "",
  "    private static async global::System.Threading.Tasks.Task Write(",
  "        global::System.IO.TextWriter wire,",
  "        object frame,",
  "        global::System.Text.Json.JsonSerializerOptions json)",
  "    {",
  "        await wire.WriteLineAsync(global::System.Text.Json.JsonSerializer.Serialize(frame, json))",
  "            .ConfigureAwait(false);",
  "        await wire.FlushAsync().ConfigureAwait(false);",
  "    }",
  "}",
  "#endif",
];

/** One `reacts`, as the dispatcher needs it. */
export interface Dispatch {
  /** The message's qualified name, which is what the frame's `type` carries. */
  readonly type: string;
  /** The subscription's name, which defaults to the service's own. */
  readonly subscription: string;
  /** Whether that name is the service's own, i.e. whether this is the unnamed subscription. */
  readonly isDefault: boolean;
  /** The method this provider named for it. */
  readonly method: string;
  /** The arguments, in the order the method takes them, bar the cancellation token. */
  readonly args: readonly string[];
  /**
   * The declared replies, as the `replies` clause spells them, with the outcome case for each.
   *
   * Empty for `replies none`. One for a single reply, which the method returns directly. More than one
   * for an outcome union, where the case carries the message.
   */
  readonly replies: readonly { readonly case: string; readonly reply: string }[];
  /** The outcome type's name, where there is more than one reply. */
  readonly outcome?: string;
}

const indent = (lines: readonly string[], by = "    "): string[] =>
  lines.map((l) => (l === "" ? "" : `${by}${l}`));

/**
 * The dispatcher for one service.
 *
 * A `switch` on the message's qualified name, because that is what the frame carries and what the model
 * calls it. Each case reads its arguments out of the delivery and calls the method — so the mapping from
 * "a message arrived" to "this code runs" is written down once, by the thing that named the method.
 */
/**
 * One case per message, and what that costs.
 *
 * **A service may subscribe to the same message twice** — `reacts Withdraw from commands` beside
 * `reacts Withdraw from commands as sweep` — and this provider writes a method for each, which is
 * right: they are two subscriptions with two filters and two retry policies. But a delivery carries
 * the message and not the subscription, because the sandbox's `Handler` is handed a `Message` and a
 * message does not know which subscription it was matched by. So the dispatcher cannot tell them
 * apart, and two `case` labels for one name is not even legal C#.
 *
 * So it keeps the unnamed subscription, which is the one a reader means by "the handler", and reports
 * each other as a `Loss`. Not a refusal: the rest of the host is useful and a service losing its whole
 * dev host over one extra subscription would be a worse trade. Not silence either — a method that
 * cannot be reached from the thing that exists to reach it is exactly what a loss is for.
 */
export function reachable(dispatches: readonly Dispatch[]): {
  readonly kept: readonly Dispatch[];
  readonly lost: readonly Dispatch[];
} {
  const byType = new Map<string, Dispatch[]>();
  for (const one of dispatches) {
    byType.set(one.type, [...(byType.get(one.type) ?? []), one]);
  }

  const kept: Dispatch[] = [];
  const lost: Dispatch[] = [];
  for (const [, group] of byType) {
    const first = group.find((d) => d.isDefault) ?? group[0]!;
    kept.push(first);
    lost.push(...group.filter((d) => d !== first));
  }
  // Back into the order the interface declares them, so the file reads top to bottom.
  const at = (one: Dispatch): number => dispatches.indexOf(one);
  return { kept: kept.sort((a, b) => at(a) - at(b)), lost: lost.sort((a, b) => at(a) - at(b)) };
}

export function dispatcherFor(
  service: string,
  iface: string,
  support: string,
  all: readonly Dispatch[],
): string[] {
  const dispatches = reachable(all).kept;
  if (dispatches.length === 0) return [];

  const prefix = `global::${support}.`;

  /**
   * The call, ending however the context needs it to.
   *
   * Parameterised because the same call is a statement in one case and an argument in another: nested
   * inside `SevenKReply.Of(` its closing paren needs a comma after it, not a semicolon. Hard-coding
   * the semicolon produced a file that read almost right and would not compile, which is the kind of
   * mistake a generator makes once per shape.
   */
  const callLines = (one: Dispatch, end: string): string[] => [
    `await handler.${one.method}(`,
    ...indent([...one.args.map((a) => `${a},`), `cancellationToken)${end}`]),
  ];

  const body: string[] = [
    `switch (delivery.Type)`,
    "{",
    ...indent(
      dispatches.flatMap((one) => {
        if (one.replies.length === 0) {
          // `replies none`: the model says there is nothing to answer with, and silence is the answer.
          return [
            `case "${one.type}":`,
            ...indent(callLines(one, ";")),
            ...indent(["return null;"]),
            "",
          ];
        }

        if (one.replies.length === 1) {
          const only = one.replies[0]!;
          return [
            `case "${one.type}":`,
            ...indent([
              `return ${prefix}SevenKReply.Of(`,
              ...indent([`"${only.reply}",`, ...callLines(one, ","), "json);"]),
            ]),
            "",
          ];
        }

        const call = callLines(one, ";");
        return [
          `case "${one.type}":`,
          "{",
          ...indent([
            `var outcome = ${call[0]!}`,
            ...call.slice(1),
            "",
            "// One arm per declared reply. A missing one is CS8509, because the compiler cannot see",
            "// that the hierarchy is closed by its private constructor — which is also why the",
            "// unreachable arm is here rather than left out: generated code that warns gets its whole",
            "// directory excluded from analysis, and then the warning that mattered goes with it.",
            "return outcome switch",
            "{",
            ...indent(
              one.replies.map(
                (r) =>
                  `${iface}.${one.outcome ?? ""}.${r.case} x => ` +
                  `${prefix}SevenKReply.Of("${r.reply}", x.Message, json),`,
              ),
            ),
            ...indent([
              `_ => throw new global::System.InvalidOperationException(`,
              `    "Unreachable: ${one.outcome ?? "the outcome"} is closed."),`,
            ]),
            "};",
          ]),
          "}",
          "",
        ];
      }),
    ),
    ...indent([
      "default:",
      ...indent([
        "// The sandbox routed this here, so it is a fault in the host rather than in the model — and",
        "// it must not be quietly acknowledged, which an ignored delivery would be.",
        `throw new global::System.InvalidOperationException(`,
        `    $"\`${service}\` does not react to \`{delivery.Type}\`");`,
      ]),
    ]),
    "}",
  ];

  return [
    "#if DEBUG || SEVENK_DEVHOST",
    "/// <summary>",
    `/// Runs <see cref="${iface}"/> inside a 7K Sandbox scenario.`,
    "/// </summary>",
    "/// <remarks>",
    "/// <para>",
    "/// Hand it your implementation and run it: the scenario registers it under",
    `/// <c>${service}</c> and delivers to it as it would to any live handler.`,
    "/// </para>",
    "/// <code>",
    `/// await SevenKDevHost.RunAsync(new ${service}DevHost(new ${service}(), Json.Options), Json.Options);`,
    "/// </code>",
    "/// <para>",
    "/// Your implementation is constructed by you, which is the point: whatever it publishes through its",
    `/// outbound port is yours to provide. Note that those publications do not reach the scenario — a`,
    "/// live handler answers with one reply and cannot send besides it, which is a limit of the sandbox's",
    "/// handler contract rather than of this host.",
    "/// </para>",
    "/// </remarks>",
    // `partial`, like the interface beside it: wiring a handler out of a container is the obvious
    // thing somebody will want to add, and this is a file the generator replaces wholesale.
    `public sealed partial class ${service}DevHost : ${prefix}ISevenKServiceHost`,
    "{",
    ...indent([
      `private readonly ${iface} handler;`,
      "private readonly global::System.Text.Json.JsonSerializerOptions json;",
      "",
      `public ${service}DevHost(${iface} handler, global::System.Text.Json.JsonSerializerOptions json)`,
      "{",
      ...indent(["this.handler = handler;", "this.json = json;"]),
      "}",
      "",
      `public string Service => "${service}";`,
      "",
      `public async global::System.Threading.Tasks.Task<${prefix}SevenKReply?> DispatchAsync(`,
      ...indent([
        `${prefix}SevenKDelivery delivery,`,
        "global::System.Threading.CancellationToken cancellationToken)",
      ]),
      "{",
      ...indent(body),
      "}",
    ]),
    "}",
    "#endif",
  ];
}
