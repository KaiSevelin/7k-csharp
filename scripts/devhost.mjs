/**
 * Does the generated development host actually run, against the sandbox that is supposed to drive it?
 *
 * `npm run verify` proves it compiles. That is not the same claim, and the difference is the whole
 * reason this exists: both halves of the protocol — the frame types and the loop in the generated
 * `SevenKDevHost`, and `overProcess` in `@sevenk/sandbox` — were written to one specification by one
 * author, and until they are introduced to each other all that has been shown is that each half is
 * valid C# and valid TypeScript. The record in this repository argues against trusting that. Four
 * compile errors in generated output were found only by pointing a compiler at it; a correlation test
 * that passed under FIFO delivery turned out to be asserting nothing at all.
 *
 * So this spawns the real thing. `dotnet build`, then `dotnet` as a child process speaking
 * line-framed JSON over stdio, then a real scenario delivering to it through the sandbox's own engine.
 *
 * ### What it is looking for
 *
 * **That the handshake agrees.** The host announces which service it is and `overProcess` checks it
 * against what was asked for, because registering `Desk` and launching the `Ledger` host is a quiet
 * failure in which every delivery is answered by the wrong code.
 *
 * **That a body survives the round trip.** The scenario publishes a payload, the handler reads fields
 * out of it, and the reply it chooses depends on what it read — so a reply arriving proves the body
 * arrived, rather than proving that something answered.
 *
 * **That stdout is the protocol channel and nothing else.** A `Console.WriteLine` in a handler would
 * put a line of prose where a frame belongs. The generated loop redirects `Console.Out` to stderr for
 * exactly that reason, and this checks the redirection by making the implementation print.
 *
 * **That a failure crosses back as a failure.** A thrown exception must reach the engine as a handler
 * failure so the subscription's retry policy applies, and must not carry its message: "the gateway
 * timed out" and "the database deadlocked" are the same observable to everything downstream (D26).
 *
 * Skipped with a notice, not a failure, where there is no .NET SDK.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWorkspace } from "@sevenk/core";
import { buildNames, compileRules } from "@sevenk/generate";
import { overProcess, runScenario } from "@sevenk/sandbox";
import { csharp } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const MODEL = join(root, "verify", "model");
const OUT = join(root, ".verify", "devhost");

const dotnet = spawnSync("dotnet", ["--version"], { encoding: "utf8", shell: true });
if (dotnet.status !== 0) {
  console.log("devhost: no .NET SDK on this machine, so the generated host was not run.");
  process.exit(0);
}

/* ------------------------------------------------------------------- the model */

const sources = readdirSync(MODEL)
  .filter((f) => f.endsWith(".7k"))
  .map((f) => ({ path: f, source: readFileSync(join(MODEL, f), "utf8") }));

const workspace = buildWorkspace(sources);
if (workspace.diagnostics.some((d) => d.severity === "error")) {
  console.error("devhost: the fixture model does not check out.");
  process.exit(2);
}
const model = workspace.model;

/* ------------------------------------------------------------------- the build */

const PROJECT = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <LangVersion>latest</LangVersion>
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
    <!-- The host is guarded by \`#if DEBUG || SEVENK_DEVHOST\`, and a Release build is where that
         guard has to be shown to be reachable on purpose rather than by accident. -->
    <DefineConstants>$(DefineConstants);SEVENK_DEVHOST</DefineConstants>
  </PropertyGroup>
</Project>
`;

function build() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const { names } = buildNames(model, []);
  const options = { namespace: "Acme", devHost: true };
  const rules = compileRules(model, []);
  const result = csharp.generate({
    model,
    selected: model.decls,
    names,
    layout: "per-declaration",
    options,
    optionsFor: (decl) => rules.resolve(decl, options).options,
  });

  if (result.refusals.length > 0) {
    console.error("devhost: generation refused, so there is nothing to run:");
    for (const r of result.refusals) console.error(`  ${r.at}: ${r.because}`);
    process.exit(1);
  }

  for (const artifact of result.artifacts) {
    const path = join(OUT, artifact.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, artifact.content, "utf8");
  }
  writeFileSync(join(OUT, "p.csproj"), PROJECT, "utf8");
  copyFileSync(join(root, "verify", "DevHost.cs"), join(OUT, "DevHost.cs"));

  // In Release, so the `#if` is exercised through `SEVENK_DEVHOST` rather than through `DEBUG`. A
  // guard that only ever compiled one way is a guard nobody has tested.
  const built = spawnSync("dotnet", ["build", "-c", "Release", "-v", "q", "--nologo"], {
    cwd: OUT,
    encoding: "utf8",
    shell: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (built.status !== 0) {
    console.error("devhost: the host does not build.");
    console.error(`${built.stdout}${built.stderr}`.trim().split("\n").slice(-25).join("\n"));
    process.exit(1);
  }
}

build();

/* ---------------------------------------------------------------- the scenarios */

const REF = "11111111-1111-1111-1111-111111111111";

const scenario = (name, body) => `scenarios for verify.flow

scenario ${name} {
  seed 1
${body}
}
`;

/** Builds a workspace around one scenario and runs it with `Desk` live. */
async function withHost(name, body, options = {}) {
  const file = { path: "devhost.scenario.7k", source: scenario(name, body) };
  const ws = buildWorkspace([...sources, file]);
  const broken = ws.diagnostics.filter((d) => d.severity === "error");
  if (broken.length > 0) {
    return { problem: `the scenario does not check out: ${broken[0].message}` };
  }
  const parsed = ws.scenarios.find((s) => s.file === file.path);
  if (parsed === undefined) return { problem: "the scenario file was not parsed" };

  const said = [];
  const handler = await overProcess(
    "dotnet",
    ["run", "-c", "Release", "--no-build", "--project", OUT],
    {
      cwd: OUT,
      // The qualified name, which is what the host announces. Checked rather than assumed, because
      // launching the wrong host is a failure in which everything still answers.
      expect: "verify.flow.Desk",
      startupMs: 120_000,
      log: (line) => said.push(line),
    },
  );

  try {
    const result = await runScenario(ws.model, parsed, parsed.scenarios[0], {
      live: new Map([["verify.flow.Desk", handler]]),
      ...options,
    });
    return { result, said };
  } finally {
    await handler.close();
  }
}

/* -------------------------------------------------------------------- the checks */

let failures = 0;

const say = (what, ok, detail) => {
  console.log(`${ok ? "ok   " : "FAIL "} ${what}`);
  if (!ok) {
    failures++;
    if (detail !== undefined) console.log(`        ${detail}`);
  }
};

const problems = (result) =>
  [
    ...result.errors,
    ...result.assertions.filter((a) => a.status !== "pass").map((a) => `${a.text}: ${a.detail ?? ""}`),
  ].join("; ");

{
  // A real delivery, answered by code in another language and another process.
  const { result, said, problem } = await withHost(
    "Accepts",
    `  at 0s publish Submit as Till
    with claims   { scope: "desk.write" }
    with envelope { priority: 3 }
    { ref: "${REF}", amount: "49.50", currency: "SE" }
  advance 1s
  expect Accepted on events`,
  );
  if (problem !== undefined) {
    say("a scenario reaches a handler written in C#", false, problem);
  } else {
    say("a scenario reaches a handler written in C#", result.status === "pass", problems(result));
    // What the implementation printed went to stderr, which is where the host redirects it — if it
    // had gone to stdout it would have been read as a frame and the run would have failed above.
    say(
      "the child's own output is kept off the protocol channel",
      said.some((line) => line.includes("Submit")),
      said.join(" | ") || "(it printed nothing, so this proves less than it should)",
    );
  }
}

{
  // The other arm, chosen by the handler from the body it was handed. A reply arriving is not the
  // claim; *this* reply arriving is, because nothing but reading the amount could produce it.
  const { result, problem } = await withHost(
    "Refuses",
    `  at 0s publish Submit as Till
    with claims   { scope: "desk.write" }
    with envelope { priority: 3 }
    { ref: "${REF}", amount: "250.00", currency: "SE" }
  advance 1s
  expect Refused on events
  expect Accepted on events count 0`,
  );
  if (problem !== undefined) say("the body survives the round trip", false, problem);
  else say("the body survives the round trip", result.status === "pass", problems(result));
}

{
  // `replies none`, where the answer is silence and an acknowledgement is all that crosses back.
  const { result, problem } = await withHost(
    "Silent",
    `  at 0s publish Withdraw as Till { ref: "${REF}" }
  advance 1s
  expect Desk handled Withdraw count 1`,
  );
  if (problem !== undefined) say("a subscription that replies nothing acknowledges", false, problem);
  else
    say(
      "a subscription that replies nothing acknowledges",
      result.status === "pass",
      problems(result),
    );
}

{
  /**
   * A thrown exception, which must cross the process boundary as a handler failure and nothing more.
   *
   * Two claims in one. The retry policy the model declares applies to code in another language —
   * `retry 5 after 1s max 30s`, so five attempts and then the dead letter — which is only true if a
   * failure is reported as a failure rather than swallowed into an acknowledgement.
   *
   * And D26, read as D26 is written: *"the payment gateway timed out" and "the database deadlocked"
   * are the same observable **from the conversation's point of view**.* So what must not happen is
   * that the cause becomes something another service can see or branch on — a reply, an outcome, a
   * body. It does reach the trace, and that is right: a trace is the person reading the run, not the
   * conversation, and a debugger with no idea why a handler failed is a debugger nobody uses.
   */
  const { result, problem } = await withHost(
    "Fails",
    `  at 0s publish Submit as Till
    with claims   { scope: "desk.write" }
    with envelope { priority: 3 }
    { ref: "${REF}", amount: "1.00", currency: "XX" }
  advance 2m
  expect Submit on commands.dead`,
  );
  if (problem !== undefined) {
    say("a thrown handler reaches the engine as a failure", false, problem);
  } else {
    say("a thrown handler reaches the engine as a failure", result.status === "pass", problems(result));
    const attempts = result.trace.of("delivered").length;
    say(
      "and the retry policy the model declares is applied to it",
      attempts === 6,
      `${attempts} deliveries, where \`retry 5\` means six attempts`,
    );
    // Nothing entered the conversation but a failure: no declared reply was emitted, and the cause
    // reached no message body. That is what D26 governs.
    const published = result.trace.of("published").map((e) => e.message ?? "");
    say(
      "and nothing about why it failed enters the conversation (D26)",
      !published.includes("verify.flow.Accepted") && !published.includes("verify.flow.Refused"),
      published.join(", ") || "(nothing was published)",
    );
    // And it does reach the person reading the run, which is the other half of the same decision.
    const detail = result.trace
      .of("failed")
      .map((e) => e.detail ?? "")
      .join(" ");
    say(
      "while the trace still says why, for whoever is reading it",
      detail.includes("deadlock"),
      detail || "(the trace says nothing, so a failure here is a mystery)",
    );
  }
}

console.log("");
console.log(
  failures === 0
    ? "devhost: the generated C# host runs, and the sandbox drives it."
    : `devhost: ${failures} failed.`,
);
process.exit(failures === 0 ? 0 : 1);
