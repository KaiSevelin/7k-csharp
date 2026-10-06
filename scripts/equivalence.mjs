/**
 * Does the generated state machine mean what the model means?
 *
 * The sandbox's saga engine is 7K's reference answer: it is what `expect` clauses in a scenario are
 * checked against, and what the specification's prose was written alongside. So the only claim worth
 * making about a generated machine is that it decides the same things — and the only way to make that
 * claim honestly is to drive both from one script and compare.
 *
 * **Both sides get the same model and the same inputs.** A script names the start message and then a
 * list of deliveries and clock advances. The sandbox's `Sagas` class is driven directly through a stub
 * host that owns a virtual clock; the generated C# machine is driven by `verify/Equivalence.cs`. Each
 * emits a decision list, and the two must match line for line.
 *
 * **What is compared is the saga's decisions**, not a whole engine trace: the lifecycle events in order,
 * and every message it chose to send with the fields it chose to fill. Pipes, subscriptions, retry and
 * deduplication are not the saga's business and are not the machine's either.
 *
 * **Two deliberate narrowings**, both of which would otherwise show up as differences that mean nothing:
 *
 * - The stub's `fill` generates nothing. The sandbox invents values for fields a `send` leaves
 *   undetermined, because it is a test harness and a scenario has to keep moving; the generated machine
 *   refuses that case at generation time. Comparing invented values would be comparing two random
 *   number generators.
 * - Values are compared after normalisation, so a canonical `"12.00"` and a C# `12.00m` agree. The byte
 *   encoding is the data layer's business and is tested there; this is about which value was chosen.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWorkspace, qualify } from "@sevenk/core";
import { Sagas } from "@sevenk/sandbox";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const MODEL = join(root, "verify", "model");
const SCRIPTS = join(root, "verify", "scripts");
const OUT = join(root, ".verify", "equivalence");

/* ------------------------------------------------------------------- the model */

const sources = readdirSync(MODEL)
  .filter((f) => f.endsWith(".7k"))
  .map((f) => ({ path: f, source: readFileSync(join(MODEL, f), "utf8") }));

const workspace = buildWorkspace(sources);
const errors = workspace.diagnostics.filter((d) => d.severity === "error");
if (errors.length > 0) {
  console.error("equivalence: the fixture model does not check out:");
  for (const e of errors) console.error(`  ${e.message}`);
  process.exit(2);
}
const model = workspace.model;

/* -------------------------------------------------------------- normalisation */

/**
 * A value in a form both runtimes can agree on.
 *
 * Canonical 7K JSON writes a decimal as a string with its declared scale and a uuid as a string; C#
 * hands back a number and a Guid. Both are right, and neither difference is a decision the saga made.
 */
function normalise(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(normalise);
  if (typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = normalise(value[key]);
    return out;
  }
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    // A decimal and an integer travel as strings in canonical JSON; a uuid and a code do not.
    if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
    return value.toLowerCase();
  }
  return String(value);
}

const line = (parts) => parts.map((p) => (p === undefined || p === null ? "-" : String(p))).join(" | ");

/* ------------------------------------------------------------ the sandbox side */

const sagaNamed = (name) => {
  const found = model.decls.find((d) => d.kind === "saga" && qualify(d.id) === name);
  if (found === undefined) throw new Error(`the fixture declares no saga \`${name}\``);
  return found;
};

/** The service hosting the saga, which is what `observe` is called with. */
const serviceFor = (saga) => {
  const startId = model.resolve(saga.start.message);
  return model.decls.find(
    (d) =>
      d.kind === "service" &&
      !d.external &&
      d.id.pkg === saga.id.pkg &&
      d.reacts.some((r) => {
        const id = model.resolve(r.message);
        return id !== undefined && qualify(id) === qualify(startId);
      }),
  );
};

const messageDecl = (type) =>
  model.decls.find((d) => d.kind === "message" && qualify(d.id) === type);

/**
 * Runs one script through the sandbox's own saga engine.
 *
 * The host is a stub on purpose: a virtual clock I step by hand, a `send` that records rather than
 * routes, and a `fill` that adds nothing. What is left is exactly the saga.
 */
function runSandbox(script) {
  const decisions = [];
  let now = 0;
  let nextTimer = 0;
  const timers = new Map();

  const host = {
    model,
    inScope: () => true,
    now: () => now,
    record(event) {
      const full = { ...event, run: "equivalence", seq: decisions.length };
      switch (event.kind) {
        case "saga-started":
          decisions.push(line(["started", event.sagaKey]));
          break;
        case "saga-advanced":
          decisions.push(line(["advanced", event.step, event.message]));
          break;
        case "saga-timeout":
          decisions.push(line(["timedout", event.step]));
          break;
        case "saga-compensating":
          decisions.push(line(["compensating", event.step, event.message]));
          break;
        case "saga-irreversible":
          decisions.push(line(["irreversible", event.step]));
          break;
        case "saga-completed":
          decisions.push(line(["ended", "complete", event.step, event.detail]));
          break;
        case "saga-rejected":
          decisions.push(line(["ended", "rejected", event.step, event.detail]));
          break;
        case "saga-abandoned":
          decisions.push(line(["ended", "abandoned", event.step, event.detail]));
          break;
        default:
          break;
      }
      return full;
    },
    timer(at, run) {
      const handle = { id: nextTimer++, at, run };
      timers.set(handle.id, handle);
      return handle;
    },
    cancel(handle) {
      // A script may declare that this host cannot cancel — a delayed queue message or a cloud
      // scheduler cannot be recalled — so that the late firing has to be made harmless by the guard.
      if (script.uncancellableTimers === true) return;
      if (handle !== undefined) timers.delete(handle.id);
    },
    send(_from, message, body) {
      decisions.push(line(["send", qualify(message.id), JSON.stringify(normalise(body))]));
      return `env-${decisions.length}`;
    },
    // Generates nothing: see the header. What the saga decided is what is compared.
    fill: (_message, written) => ({ body: { ...written }, generated: [] }),
    note: () => {},
  };

  const sagas = new Sagas(host);
  const saga = sagaNamed(script.saga);
  const service = serviceFor(saga);
  if (service === undefined) throw new Error("the fixture saga has no hosting service");

  /** Runs every timer due at or before `until`, in time then arming order, as a clock would. */
  const advanceTo = (until) => {
    for (;;) {
      const due = [...timers.values()]
        .filter((t) => t.at <= until)
        .sort((a, b) => a.at - b.at || a.id - b.id);
      if (due.length === 0) break;
      const next = due[0];
      timers.delete(next.id);
      now = next.at;
      next.run();
    }
    now = until;
  };

  const deliver = (type, body) => {
    const decl = messageDecl(type);
    if (decl === undefined) throw new Error(`the fixture declares no \`${type}\``);
    sagas.observe(service, {
      envelope: { type, id: `in-${decisions.length}`, fields: {} },
      body,
      claims: {},
    });
  };

  deliver(script.start.type, script.start.body);
  for (const input of script.inputs) {
    if (input.deliver !== undefined) deliver(input.deliver, input.body);
    else if (input.advance !== undefined) advanceTo(now + input.advance);
  }

  return decisions;
}

/* ------------------------------------------------------------------ the C# side */

const dotnet = spawnSync("dotnet", ["--version"], { encoding: "utf8", shell: true });
if (dotnet.status !== 0) {
  console.log("equivalence: no .NET SDK on this machine, so the generated machine was not run.");
  process.exit(0);
}

const PROJECT = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <OutputType>Exe</OutputType>
    <Nullable>enable</Nullable>
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
  </PropertyGroup>
</Project>
`;

/** Emits the generated C# for the fixture, plus the harness that drives it. */
async function buildCsharp() {
  const { buildNames, compileRules } = await import("@sevenk/generate");
  const { csharp } = await import("../src/index.js");

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const { names } = buildNames(model, []);
  const options = { namespace: "Acme" };
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
    console.error("equivalence: generation refused, so there is nothing to compare:");
    for (const r of result.refusals) console.error(`  ${r.at}: ${r.because}`);
    process.exit(1);
  }

  for (const artifact of result.artifacts) {
    const path = join(OUT, artifact.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, artifact.content, "utf8");
  }
  writeFileSync(join(OUT, "p.csproj"), PROJECT, "utf8");
  copyFileSync(join(root, "verify", "Equivalence.cs"), join(OUT, "Equivalence.cs"));
  mkdirSync(join(OUT, "scripts"), { recursive: true });
  for (const file of readdirSync(SCRIPTS)) {
    copyFileSync(join(SCRIPTS, file), join(OUT, "scripts", file));
  }
}

await buildCsharp();

const run = spawnSync("dotnet", ["run", "-v", "q", "--nologo"], {
  cwd: OUT,
  encoding: "utf8",
  shell: true,
  maxBuffer: 32 * 1024 * 1024,
});
if (run.status !== 0) {
  console.error("equivalence: the C# harness did not run.");
  console.error(`${run.stdout}${run.stderr}`.trim().split("\n").slice(-30).join("\n"));
  process.exit(1);
}

/** The harness writes `## <script>` then one decision per line. */
const fromCsharp = new Map();
let current;
for (const raw of run.stdout.split("\n")) {
  const text = raw.trimEnd();
  if (text.startsWith("## ")) {
    current = text.slice(3);
    fromCsharp.set(current, []);
  } else if (text !== "" && current !== undefined) {
    fromCsharp.get(current).push(text);
  }
}

/* -------------------------------------------------------------------- compare */

let failed = 0;

for (const file of readdirSync(SCRIPTS).sort()) {
  const name = file.replace(/\.json$/, "");
  const script = JSON.parse(readFileSync(join(SCRIPTS, file), "utf8"));

  const expected = runSandbox(script);
  const actual = (fromCsharp.get(name) ?? []).map((l) =>
    // The C# side writes its message bodies as JSON too; normalise both the same way.
    l.startsWith("send | ")
      ? (() => {
          const at = l.indexOf(" | ", 7);
          const type = l.slice(7, at);
          const body = JSON.parse(l.slice(at + 3));
          return line(["send", type, JSON.stringify(normalise(body))]);
        })()
      : l,
  );

  const same =
    expected.length === actual.length && expected.every((e, i) => e === actual[i]);

  console.log(`${same ? "ok   " : "FAIL "} ${name.padEnd(16)} ${expected.length} decisions`);
  if (same) continue;

  failed++;
  const rows = Math.max(expected.length, actual.length);
  for (let i = 0; i < rows; i++) {
    const e = expected[i] ?? "(nothing)";
    const a = actual[i] ?? "(nothing)";
    console.log(`        ${e === a ? " " : "✗"} sandbox: ${e}`);
    if (e !== a) console.log(`          c#:      ${a}`);
  }
}

console.log("");
console.log(
  failed === 0
    ? "equivalence: the generated machine decides what the sandbox decides."
    : `equivalence: ${failed} script${failed === 1 ? "" : "s"} differ.`,
);
process.exit(failed === 0 ? 0 : 1);
