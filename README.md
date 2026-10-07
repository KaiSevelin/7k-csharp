# 7k-csharp

A [7K](https://github.com/KaiSevelin/7k) provider that generates **C# 12 / .NET 8** from a 7K model:
message types, validators, handler interfaces and saga state machines.

7K describes loosely coupled, message-driven systems — what a service accepts, what it emits, what a
pipe guarantees. This turns the parts of that description C# can carry into code you compile against.

## What it generates

| From the model | In C# |
| --- | --- |
| `message`, `record` | a `record` (or positional record, or class) with `System.Text.Json` attributes |
| `value` | a readonly struct wrapper, with conversions and structural equality |
| `enum` | an `enum` plus a converter that reads the member name as written |
| field and value constraints | a `Validate` method returning every violation, not the first |
| `invariant` | a cross-field check, including across lists: `it.Lines.All(e => it.Total.Currency == e.Unit.Currency)` |
| `service` | an interface, one method per subscription, the contract in `<remarks>` |
| `saga` | a state machine returning effects, with no I/O of its own |

`decimal(p,s)` serialises as a **string** at exactly the declared scale, because money must not
round-trip through a double. `bytes` is base64url unpadded, `instant` is RFC 3339 UTC, `uuid` is
lowercase hyphenated — the canonical JSON of `01-kernel.md` §7, not whatever the serializer defaults to.

## Options

Set per entry in a manifest, and overridable per declaration by a rule.

| Option | Values | Default |
| --- | --- | --- |
| `namespace` | string | `""` |
| `messageType` | `record` \| `positional` \| `class` | `record` |
| `valueTypes` | `wrapper` \| `alias` | `wrapper` |
| `nullable` | boolean | `true` |
| `serialization` | `system-text-json` \| `none` | `system-text-json` |
| `validators` | boolean | `true` |
| `validatorStyle` | `methods` \| `annotations` \| `both` | `methods` |
| `asyncSuffix` | boolean | `true` |
| `devHost` | boolean | `true` |

### The development host

`devHost` writes a dispatcher beside each service interface: hand it your implementation and the service
runs for real inside a [7K Sandbox](https://github.com/KaiSevelin/7k-sandbox) scenario, under your
debugger, while everything it talks to stays mocked.

```csharp
await SevenKDevHost.RunAsync(new DeskDevHost(new Desk(), Json.Options), Json.Options);
```

```ts
const desk = await overProcess("dotnet", ["run", "--project", "./src/Desk"], { expect: "Desk" });
await runScenario(model, file, scenario, { live: new Map([["Desk", desk]]) });
```

The sandbox's clock is virtual, so no model time passes while the engine waits for a reply: stopping on
a breakpoint for five minutes does not trip a step's `timeout 30s`. Against a real broker the visibility
timeout expires and the message is redelivered while you are still reading a local.

**It defaults on, and is `#if DEBUG`.** The value of a dev host is being there when you reach for it
rather than being something you remember to switch on — which is only safe if it is absent from what you
ship, because a dev host in production is a second entry point into every handler with nothing in front
of it. A Release build contains none of it. It is also off without `serialization`, since a frame is JSON
and a host that cannot read a body cannot do the one thing it exists for.

**The dispatcher is generated, not reflective.** Only this provider knows what it called the handler,
what order it put the envelope parameters in, and what the outcome cases are — those names are its own
convention applied to the model, and they move when `asyncSuffix` or `messageType` does. The protocol is
not generated: it belongs to the sandbox, because it is that runtime's `Handler` contract serialised.

**One case per message**, because a delivery carries the message and not the subscription. A service that
subscribes to the same message twice gets both handlers and a `Loss` naming the one a scenario cannot
reach — it is still generated and still runs in production.

## It refuses rather than weakens

D48: an implementation **may fail, never weaken**. Where C# cannot express what the model states, this
reports a refusal naming the declaration — it does not emit something quieter and warn. A `record Seat`
with a field named `seat` is refused rather than renamed, because renaming would move the breakage to
the serializer, where the wire name is decided.

Where an artifact is *descriptive* rather than executable it may declare a **loss** instead, which says
this file describes less than the model. Executable artifacts may not.

## Verification

Unit tests prove the generator does what its authors think. They cannot prove the output is valid C#,
so the output is handed to the real compiler — twice, at two different costs. `npm test` builds one model
in a few seconds, across the options that change the names the generated code calls itself by.
`npm run verify` builds thirteen layout and option combinations and then runs behavioural checks against
them:

```
npm test           # 175 tests, including a `dotnet build` of what it generates
npm run verify     # dotnet build, warnings-as-errors, then runs behavioural checks
npm run equivalence # the generated saga vs. 7K's reference engine, 11 scripts
```

`npm run verify` builds [verify/](verify/) with `GenerateDocumentationFile` and warnings as errors, then
executes assertions about round-tripping, equality and validation. Most real bugs in this provider were
found by that step and by nothing else — exhaustiveness, cross-namespace resolution, `ImmutableArray`
not giving structural equality.

`npm run equivalence` drives the generated machine and the 7K sandbox's own saga engine from one script
and compares their decisions. The sandbox is the reference answer, so agreeing with it is the only claim
about a generated machine worth making.

## What it depends on

The 7K **language** (`@sevenk/core`, for the IR) and the **provider contract**
(`@sevenk/provider`, which is types and contains no code). Deliberately *not* `@sevenk/generate`, the
host that runs providers — because there is more than one host, and a provider is not supposed to be
able to tell which one called it. `test/coupling.test.ts` holds that line, and also pins that nothing in
`src/` can reach a filesystem, a network or a subprocess: a provider returns text, and the caller
decides what becomes of it.

## Status

Not yet installable on its own: `package.json` resolves `@sevenk/core` and `@sevenk/provider` through
`file:../7K/packages/...`, so it currently expects a checkout of
[7K](https://github.com/KaiSevelin/7k) beside this one.

Apache-2.0.
