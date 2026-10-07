/**
 * The generated C# is handed to the C# compiler.
 *
 * Nothing in this repository did that before, and the cost of not doing it showed up the first time
 * something non-trivial was generated: the development host's dispatcher read almost right and would
 * not compile — a `);` that closed the wrong call, a nested type named one level too shallow, and an
 * extension method called without the `using` that brings it into scope. Three mistakes, none of them
 * visible to a test that asserts on strings, all of them obvious to `dotnet build`.
 *
 * So this is the test that has to exist for a code generator: **does the code it generates build.**
 * Everything else about a generator is an opinion; this is the part that is true or false.
 *
 * **Both configurations.** `Debug` includes the development host, because that is what `#if DEBUG`
 * means and the host is the point of it. `Release` has to build too, and has to build *without* it:
 * the option defaults on, and that is only safe if what you ship does not contain a second entry point
 * into every handler.
 *
 * **Warnings are errors here, and that is deliberate.** This provider's own comments say why: "a
 * generated file that trips an analyzer gets its whole directory excluded from analysis", and then the
 * warning that mattered goes with it. A generator that warns is a generator whose output nobody checks.
 *
 * Needs the .NET SDK. Skipped rather than failed without one, the same way the browser tests skip.
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWorkspace } from "@sevenk/core";
import { buildNames, type Request } from "@sevenk/generate";
import { csharp } from "../src/index.js";

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, ".scratch", "compiles");

/**
 * A model with all three reply shapes in it, because they are three different pieces of generated code.
 *
 * `replies none` returns a bare `Task`, one reply is returned directly, and more than one becomes a
 * closed outcome hierarchy — and it was the single-reply case that did not compile.
 */
const MODEL = `package flow.desk

envelope Trace {
  correlationId: uuid @role(correlation)
  causationId:   uuid @role(causation) @derive(inbound.id)
}

envelopes Trace

value Ref : string { length 1..32 }

enum Size { Small Large }

record Detail {
  ref:  Ref
  size: Size
  tags: [string]
}

message Submit   v1.0 @command { ref: Ref @role(businessKey) detail: Detail }
message Accepted v1.0 @event   { ref: Ref @role(businessKey) }
message Refused  v1.0 @event   { ref: Ref @role(businessKey) reason: string { length 1..40 } }
message Ping     v1.0 @command { ref: Ref @role(businessKey) }
message Pong     v1.0 @event   { ref: Ref @role(businessKey) }
message Withdraw v1.0 @command { ref: Ref @role(businessKey) }
message Logged   v1.0 @event   { ref: Ref @role(businessKey) }

pipe inbound : queue { retention 7d }
pipe events  : topic { retention 7d }

service Caller @external {
  emits Submit   to inbound
  emits Ping     to inbound
  emits Withdraw to inbound
}

service Desk {
  // More than one reply: an outcome union.
  reacts Submit   from inbound { replies Accepted | Refused }
  // One reply: returned directly.
  reacts Ping     from inbound { replies Pong }
  // None: a bare Task.
  reacts Withdraw from inbound { replies none }
  // A second subscription to the same message, which a delivery cannot be told apart from the first.
  // This is what produced two switch labels for one name, which is not legal C#.
  reacts Withdraw from inbound as sweep { replies none }

  emits Accepted to events
  emits Refused  to events
  emits Pong     to events
  // Emitted and never returned, so it reaches the outbound port rather than a handler's return.
  emits Logged   to events
}
`;

const PROJECT = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net9.0</TargetFramework>
    <Nullable>enable</Nullable>
    <LangVersion>latest</LangVersion>
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
    <GenerateDocumentationFile>false</GenerateDocumentationFile>
  </PropertyGroup>
</Project>
`;

let ready = false;

/** Generates with the given options and writes the files out, returning the paths. */
const emit = async (where: string, options: Readonly<Record<string, unknown>>): Promise<string[]> => {
  const ws = buildWorkspace([{ path: "m.7k", source: MODEL }]);
  expect(ws.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);

  const out = csharp.generate({
    model: ws.model,
    selected: ws.model.decls,
    names: buildNames(ws.model, []),
    layout: "per-declaration",
    options: { namespace: "Acme", ...options },
    optionsFor: () => ({}),
  } as unknown as Request);

  expect(out.refusals).toEqual([]);
  await rm(where, { recursive: true, force: true });
  await mkdir(where, { recursive: true });
  await writeFile(join(where, "Probe.csproj"), PROJECT, "utf-8");
  for (const artifact of out.artifacts) {
    const at = join(where, artifact.path);
    await mkdir(dirname(at), { recursive: true });
    await writeFile(at, artifact.content, "utf-8");
  }
  return out.artifacts.map((a) => a.path);
};

/** `dotnet build`, with its own output rather than a boolean. */
const build = async (where: string, configuration: "Debug" | "Release"): Promise<string> => {
  try {
    const { stdout } = await run(
      "dotnet",
      ["build", join(where, "Probe.csproj"), "-c", configuration, "--nologo", "-v", "q"],
      { cwd: root, maxBuffer: 1 << 24 },
    );
    return stdout;
  } catch (failure) {
    const said = failure as { stdout?: string; stderr?: string };
    return `${said.stdout ?? ""}${said.stderr ?? ""}`;
  }
};

const problems = (output: string): string[] =>
  [...new Set(output.split(/\r?\n/).filter((l) => /\b(error|warning) [A-Z]+\d+:/.test(l)))];

beforeAll(async () => {
  try {
    await run("dotnet", ["--version"], { cwd: root });
    ready = true;
  } catch {
    return;
  }
  await mkdir(dir, { recursive: true });
}, 180_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("the generated C#", () => {
  it("builds in Debug, where the development host is", async () => {
    if (!ready) return;
    const where = join(dir, "debug");
    const paths = await emit(where, {});
    // The host's fixed half is there, so this is a build that includes it.
    expect(paths).toContain("Acme/DevHost.cs");
    expect(await readFile(join(where, "Acme/Flow/Desk/Desk.cs"), "utf-8")).toContain("DeskDevHost");

    expect(problems(await build(where, "Debug"))).toEqual([]);
  }, 300_000);

  it("builds in Release, where it is compiled out", async () => {
    if (!ready) return;
    const where = join(dir, "release");
    await emit(where, {});
    expect(problems(await build(where, "Release"))).toEqual([]);
  }, 300_000);

  it("builds with the development host turned off", async () => {
    if (!ready) return;
    const where = join(dir, "off");
    const paths = await emit(where, { devHost: false });
    expect(paths).not.toContain("Acme/DevHost.cs");
    expect(await readFile(join(where, "Acme/Flow/Desk/Desk.cs"), "utf-8")).not.toContain("DevHost");

    expect(problems(await build(where, "Debug"))).toEqual([]);
  }, 300_000);

  it("builds without serialization, which turns the host off with it", async () => {
    if (!ready) return;
    // A frame is JSON, so a host that cannot read a body cannot do the one thing it exists for.
    const where = join(dir, "nojson");
    const paths = await emit(where, { serialization: "none" });
    expect(paths).not.toContain("Acme/DevHost.cs");
    expect(paths).not.toContain("Acme/Json.cs");

    expect(problems(await build(where, "Debug"))).toEqual([]);
  }, 300_000);

  it("keeps one case per message, and says which subscription it cannot reach", async () => {
    if (!ready) return;
    const where = join(dir, "twice");
    await emit(where, {});
    const text = await readFile(join(where, "Acme/Flow/Desk/Desk.cs"), "utf-8");

    // Both handlers are generated, because both subscriptions are real and both run in production.
    expect(text).toContain("HandleWithdrawAsync(");
    expect(text).toContain("HandleWithdrawAsSweepAsync(");
    // One case, because a delivery carries the message and not the subscription.
    expect(text.match(/case "flow\.desk\.Withdraw":/g)).toHaveLength(1);

    expect(problems(await build(where, "Debug"))).toEqual([]);
  }, 300_000);

  it("builds with a positional message type and no async suffix", async () => {
    if (!ready) return;
    // Two options that move the names the dispatcher calls, which is the whole reason it is generated
    // rather than written by hand or found by reflection.
    const where = join(dir, "positional");
    await emit(where, { messageType: "positional", asyncSuffix: false });
    expect(await readFile(join(where, "Acme/Flow/Desk/Desk.cs"), "utf-8")).toContain(
      "handler.HandleSubmit(",
    );
    expect(problems(await build(where, "Debug"))).toEqual([]);
  }, 300_000);
});
