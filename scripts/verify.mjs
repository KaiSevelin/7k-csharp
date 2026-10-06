/**
 * Does the generated C# compile, and does it behave?
 *
 * A generator's unit tests can only check that it emits the string somebody expected. They cannot catch
 * `Value?.ToString()` on a `long`, or `Acme.Shop.Money` binding its leading `Acme` to the wrong
 * namespace, or a validator calling one that was never generated. Only a compiler catches those, and
 * when this was first written it caught five of them.
 *
 * Two stages. Every layout and value mode must compile with warnings as errors — a generated file that
 * warns is a directory somebody excludes from analysis, and then nothing in it is checked again. Then
 * the default shape runs `verify/Behaviour.cs`, which asserts the rules the model states are the rules
 * the code enforces.
 *
 * Skipped with a notice, not a failure, where there is no .NET SDK: a contributor without one should
 * still be able to run the tests.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWorkspace } from "@sevenk/core";
import { buildNames, compileRules } from "@sevenk/generate";
import { csharp } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const MODEL = join(root, "verify", "model");
const OUT = join(root, ".verify");

const dotnet = spawnSync("dotnet", ["--version"], { encoding: "utf8", shell: true });
if (dotnet.status !== 0) {
  console.log("verify: no .NET SDK on this machine, so the generated code was not compiled.");
  console.log("        Install one from https://dotnet.microsoft.com/download to run this.");
  process.exit(0);
}

const sources = readdirSync(MODEL)
  .filter((f) => f.endsWith(".7k"))
  .map((f) => ({ path: f, source: readFileSync(join(MODEL, f), "utf8") }));

const workspace = buildWorkspace(sources);
const errors = workspace.diagnostics.filter((d) => d.severity === "error");
if (errors.length > 0) {
  console.error("verify: the fixture model does not check out:");
  for (const e of errors) console.error(`  ${e.message}`);
  process.exit(2);
}

const model = workspace.model;
const { names } = buildNames(model, []);

/** Emits one combination into its own project and returns where. */
function emit(layout, valueTypes, namespace, extra = {}) {
  const suffix = Object.values(extra).join("-");
  const dir = join(
    OUT,
    `${layout}-${valueTypes}-${namespace === "" ? "bare" : namespace}${suffix === "" ? "" : `-${suffix}`}`,
  );
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const options = { namespace, valueTypes, ...extra };
  const rules = compileRules(model, []);
  const result = csharp.generate({
    model,
    selected: model.decls,
    names,
    layout,
    options,
    optionsFor: (decl) => rules.resolve(decl, options).options,
  });

  if (result.refusals.length > 0) {
    console.error(`verify: ${layout}/${valueTypes} refused, which the fixture should not provoke:`);
    for (const r of result.refusals) console.error(`  ${r.at}: ${r.because}`);
    process.exit(1);
  }

  for (const artifact of result.artifacts) {
    const path = join(dir, artifact.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, artifact.content, "utf8");
  }
  return { dir, files: result.artifacts.length, losses: result.artifacts.flatMap((a) => a.losses) };
}

const PROJECT = (exe) => `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <OutputType>${exe ? "Exe" : "Library"}</OutputType>
    <Nullable>enable</Nullable>
    <!-- A generated file that warns is a file somebody stops reading. -->
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
    <!-- Catches malformed XML in a doc comment, and a generated file that would fail a consumer's
         build for want of documentation nobody can write. -->
    <GenerateDocumentationFile>true</GenerateDocumentationFile>
    <EnableDefaultCompileItems>true</EnableDefaultCompileItems>
  </PropertyGroup>
</Project>
`;

const COMBINATIONS = [
  ["per-declaration", "wrapper", "Acme"],
  ["per-declaration", "wrapper", "Acme", { validatorStyle: "both" }],
  ["per-declaration", "wrapper", "Acme", { validatorStyle: "annotations" }],
  ["per-declaration", "wrapper", "Acme", { serialization: "none" }],
  ["per-declaration", "wrapper", "Acme", { messageType: "positional" }],
  ["per-declaration", "wrapper", "Acme", { messageType: "class" }],
  ["per-declaration", "wrapper", "Acme", { asyncSuffix: false }],
  ["per-declaration", "alias", "Acme"],
  ["per-declaration", "wrapper", ""],
  ["per-package", "wrapper", "Acme"],
  ["per-package", "alias", "Acme"],
  ["single", "wrapper", "Acme"],
  ["single", "alias", "Acme"],
];

let failed = 0;

for (const [layout, valueTypes, namespace, extra] of COMBINATIONS) {
  const { dir, files, losses } = emit(layout, valueTypes, namespace, extra);
  writeFileSync(join(dir, "p.csproj"), PROJECT(false), "utf8");

  const build = spawnSync("dotnet", ["build", "-v", "q", "--nologo"], {
    cwd: dir,
    encoding: "utf8",
    shell: true,
  });
  const label =
    `${layout}/${valueTypes}/${namespace === "" ? "(no root)" : namespace}` +
    (extra === undefined ? "" : ` ${Object.entries(extra).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  if (build.status === 0) {
    const note = losses.length === 0 ? "" : `, ${losses.length} declared losses`;
    console.log(`ok    ${label.padEnd(36)} ${files} files${note}`);
  } else {
    failed++;
    console.log(`FAIL  ${label}`);
    for (const line of `${build.stdout}${build.stderr}`.split("\n")) {
      if (line.includes(": error") || line.includes(": warning")) console.log(`        ${line.trim()}`);
    }
  }
}

// The default shape, run rather than only compiled.
const { dir } = emit("per-declaration", "wrapper", "Acme");
writeFileSync(join(dir, "p.csproj"), PROJECT(true), "utf8");
copyFileSync(join(root, "verify", "Behaviour.cs"), join(dir, "Behaviour.cs"));

const run = spawnSync("dotnet", ["run", "-v", "q", "--nologo"], {
  cwd: dir,
  encoding: "utf8",
  shell: true,
});
console.log("");
console.log(`${run.stdout}${run.stderr}`.trim());
if (run.status !== 0) failed++;

console.log("");
console.log(failed === 0 ? "verify: the generated C# compiles and behaves." : `verify: ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
