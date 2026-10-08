/**
 * Does the generated validator mean what the model means?
 *
 * 7K Core's contract runtime is the reference answer. It is what `publish` is checked against, what the
 * sandbox rejects a payload with on receipt, and what Spider's composer calls a body valid by — so a
 * generated validator that disagrees with it is a generated validator that is wrong, whatever its own
 * tests say. `verify/Behaviour.cs` already checks the generated validators against hand-written
 * expectations, which proves they do what their author thought; this proves they do what the *model*
 * says, which is a different claim and the one that matters.
 *
 * The shape is `equivalence.mjs`'s, because the problem is the same shape: drive both from one set of
 * inputs and compare. A payload file names a message and carries a body; Core validates it here, the
 * generated C# validates it in `verify/Validation.cs`, and the two must agree.
 *
 * ### What is compared, and the four narrowings
 *
 * **A pair of (path, rule kind), as a multiset.** Not the prose: Core says "length 2 is below the
 * declared minimum 3" and C# says "length 3..8", which are the same finding in two vocabularies, and
 * insisting they match word for word would be insisting one of them write the other's messages. The
 * kind and the field together are the finding; the sentence around it is a matter of audience.
 *
 * **Not the order.** Two tree walks visit fields in their own order, and nothing in the model says
 * which. Compared sorted.
 *
 * **Not the index.** A generated validator reports `items[].sku`, because the path it knows is the one
 * the model states and a static path has no index in it; Core reports `items[0].sku`, because it is
 * looking at a value. Indices are stripped on the way in. As a multiset this still counts: two bad
 * elements are two findings on both sides.
 *
 * **Not structure, and not type.** "required field is absent", "not a declared field", "expected a
 * uuid" — Core reports these because it validates untyped JSON, and in C# none of them can happen: a
 * missing required property will not compile, an unknown one is the deserialiser's business, and a
 * `Guid` field cannot hold "not-a-uuid". Comparing them would be asking C# to re-check what its type
 * system already settled, one layer earlier and better than a validator could. They are dropped from
 * the Core side, and a payload that *only* breaks them would therefore compare as agreement — which is
 * why the payload files break constraints rather than shapes.
 *
 * Normalisation is not applied on either side. `normalize trim` happens on receipt and before
 * validation, so a payload here carries already-normalised values and the two sides see the same bytes.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWorkspace, qualify, specOfDecl, validate } from "@sevenk/core";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const MODEL = join(root, "verify", "model");
const PAYLOADS = join(root, "verify", "payloads");
const OUT = join(root, ".verify", "validation");

/* ------------------------------------------------------------------- the model */

const sources = readdirSync(MODEL)
  .filter((f) => f.endsWith(".7k"))
  .map((f) => ({ path: f, source: readFileSync(join(MODEL, f), "utf8") }));

const workspace = buildWorkspace(sources);
const errors = workspace.diagnostics.filter((d) => d.severity === "error");
if (errors.length > 0) {
  console.error("validation: the fixture model does not check out:");
  for (const e of errors) console.error(`  ${e.message}`);
  process.exit(2);
}
const model = workspace.model;

/* -------------------------------------------------------------- what to compare */

/**
 * The rule a problem is about, from either side's words.
 *
 * C# names the kind first — `length 3..8`, `multipleOf 5`, `invariant ...` — so its first token is the
 * answer. Core writes prose, so this is a table over it: explicit, ordered, and total, because a
 * sentence this does not recognise must be a loud `?` rather than a quiet match. `length` and `size`
 * are tried before `range` on purpose: their messages end in the same words.
 */
const KINDS = [
  [/^length \d+ (is below|exceeds)/, "length"],
  [/^size \d+ (is below|exceeds)/, "size"],
  [/does not match /, "pattern"],
  [/is not a multiple of /, "multipleOf"],
  [/declared unique/, "unique"],
  [/(is below the declared minimum|exceeds the declared maximum)/, "range"],
  [/^the invariant /, "invariant"],
];

/** Structural and type findings, which C# settles with its type system instead. See the header. */
const NOT_A_CONSTRAINT = [
  /^required field is absent$/,
  /^not a declared field$/,
  /^expected /,
  /^not an? /,
];

const kindOf = (message) => {
  for (const [pattern, kind] of KINDS) if (pattern.test(message)) return kind;
  return `?(${message})`;
};

/** `items[0].sku` and `items[].sku` are the same finding. */
const flatten = (path) => path.replace(/\[\d+\]/g, "[]");

const key = (path, kind) => `${flatten(path) || "(root)"} | ${kind}`;

/* --------------------------------------------------------------- the reference */

const byName = new Map(model.decls.map((d) => [qualify(d.id), d]));

function fromCore(type, body) {
  const decl = byName.get(type);
  if (decl === undefined) throw new Error(`the fixture declares no \`${type}\``);
  const problems = validate(model, specOfDecl(model, decl, [], 0), body);
  return problems
    .filter((p) => !NOT_A_CONSTRAINT.some((pattern) => pattern.test(p.message)))
    .map((p) => key(p.path, kindOf(p.message)))
    .sort();
}

/* ----------------------------------------------------------------------- the C# */

const PROJECT = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net9.0</TargetFramework>
    <Nullable>enable</Nullable>
    <LangVersion>latest</LangVersion>
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
  </PropertyGroup>
</Project>
`;

async function buildCsharp() {
  const { buildNames, compileRules } = await import("@sevenk/generate");
  const { csharp } = await import("../src/index.js");

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const { names } = buildNames(model, []);
  // No development host: it is not what this harness is about, and a second entry point in a project
  // that exists to run one thing is noise.
  const options = { namespace: "Acme", devHost: false };
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
    console.error("validation: generation refused, so there is nothing to compare:");
    for (const r of result.refusals) console.error(`  ${r.at}: ${r.because}`);
    process.exit(1);
  }

  for (const artifact of result.artifacts) {
    const path = join(OUT, artifact.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, artifact.content, "utf8");
  }
  writeFileSync(join(OUT, "p.csproj"), PROJECT, "utf8");
  copyFileSync(join(root, "verify", "Validation.cs"), join(OUT, "Validation.cs"));
  mkdirSync(join(OUT, "payloads"), { recursive: true });
  for (const file of readdirSync(PAYLOADS)) {
    copyFileSync(join(PAYLOADS, file), join(OUT, "payloads", file));
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
  console.error("validation: the C# harness did not run.");
  console.error(`${run.stdout}${run.stderr}`.trim().split("\n").slice(-30).join("\n"));
  process.exit(1);
}

/** The harness writes `## <payload>` then one problem per line, or `!!` where it could not read one. */
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

for (const file of readdirSync(PAYLOADS).sort()) {
  const name = file.replace(/\.json$/, "");
  const { type, body } = JSON.parse(readFileSync(join(PAYLOADS, file), "utf8"));

  const expected = fromCore(type, body);
  const said = fromCsharp.get(name) ?? [];

  const unreadable = said.filter((l) => l.startsWith("!! "));
  const actual = said
    .filter((l) => !l.startsWith("!! "))
    .map((l) => {
      const at = l.indexOf(" | ");
      const path = l.slice(0, at);
      const rule = l.slice(at + 3);
      // The kind is the first word of the rule, as the model states it.
      return key(path, rule.split(" ")[0] ?? rule);
    })
    .sort();

  const same =
    unreadable.length === 0 &&
    expected.length === actual.length &&
    expected.every((e, i) => e === actual[i]);

  const count = expected.length === 0 ? "valid" : `${expected.length} problem${expected.length === 1 ? "" : "s"}`;
  console.log(`${same ? "ok   " : "FAIL "} ${name.padEnd(20)} ${count}`);
  if (same) continue;

  failed++;
  for (const line of unreadable) console.log(`        ${line}`);
  const rows = Math.max(expected.length, actual.length);
  for (let i = 0; i < rows; i++) {
    const e = expected[i] ?? "(nothing)";
    const a = actual[i] ?? "(nothing)";
    console.log(`        ${e === a ? " " : "✗"} core: ${e}`);
    if (e !== a) console.log(`          c#:   ${a}`);
  }
}

/* ------------------------------------------------- every kind, at least once */

// A harness that compared nothing would pass. So it says what it exercised, and fails if the fixture
// stopped covering a constraint kind — which is how `multipleOf` turned out to be missing from it.
const covered = new Set();
for (const file of readdirSync(PAYLOADS)) {
  const { type, body } = JSON.parse(readFileSync(join(PAYLOADS, file), "utf8"));
  for (const one of fromCore(type, body)) covered.add(one.split(" | ")[1]);
}
const wanted = ["length", "size", "range", "multipleOf", "pattern", "unique", "invariant"];
const missing = wanted.filter((k) => !covered.has(k));
const unknown = [...covered].filter((k) => k.startsWith("?("));

console.log("");
console.log(`kinds exercised: ${wanted.filter((k) => covered.has(k)).join(", ")}`);
if (missing.length > 0) console.log(`NOT exercised:   ${missing.join(", ")}`);
for (const one of unknown) console.log(`unrecognised:    ${one}`);

const ok = failed === 0 && missing.length === 0 && unknown.length === 0;
console.log("");
console.log(
  ok
    ? "validation: the generated validators find what Core finds."
    : `validation: ${failed} payload${failed === 1 ? "" : "s"} differ${missing.length + unknown.length > 0 ? ", and the fixture does not cover everything" : ""}.`,
);
process.exit(ok ? 0 : 1);
