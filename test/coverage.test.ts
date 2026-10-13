/**
 * The coverage declaration, against what this provider actually does.
 *
 * `covers` is read by somebody deciding whether to commit a model to C#, which makes it the most
 * consequential thing here that is not code — and the easiest to let drift, because nothing in a
 * generated file disagrees with a sentence in a declaration. This is what disagrees with it: the
 * whole `verify/model` workspace, which is the deliberately awkward one `npm run verify` compiles
 * and `npm run validation` drives, written to reach the places this provider gives something up.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildWorkspace, type Decl } from "@sevenk/core";
import {
  buildNames,
  compileRules,
  coverageFaults,
  overclaimed,
  withDefaults,
  type Request,
} from "@sevenk/generate";
import { csharp } from "../src/index.js";

const MODEL = join(dirname(fileURLToPath(import.meta.url)), "..", "verify", "model");

/** Every file, as the verify scripts read them — so this is checked against the same model they are. */
const SOURCES = readdirSync(MODEL)
  .filter((f) => f.endsWith(".7k"))
  .map((f) => ({ path: f, source: readFileSync(join(MODEL, f), "utf8") }));

const generated = (options: Record<string, unknown>) => {
  const m = buildWorkspace(SOURCES).model;
  const { names } = buildNames(m, []);
  const compiled = compileRules(m, []);
  const defaults = withDefaults(csharp.options, { namespace: "Verify", ...options });
  const request: Request = {
    model: m,
    selected: m.decls,
    names,
    layout: "per-declaration",
    options: defaults,
    optionsFor: (decl: Decl) => compiled.resolve(decl, defaults).options,
  };
  return csharp.generate(request);
};

describe("what this provider says it can do", () => {
  it("says it in a form a reader can act on", () => {
    expect(coverageFaults(csharp, "csharp")).toEqual([]);
  });

  it("does not claim coverage it then loses", () => {
    expect(overclaimed(csharp, generated({}).artifacts, "csharp")).toEqual([]);
  });

  it("holds under the settings that change what is generated", () => {
    // Three of the entries name an option, so the claim has to survive both sides of each.
    for (const options of [
      { valueTypes: "alias" },
      { validatorStyle: "attributes" },
      { validatorStyle: "both" },
      { validators: false },
      { devHost: true },
    ]) {
      expect(overclaimed(csharp, generated(options).artifacts, "csharp")).toEqual([]);
    }
  });

  it("is checked against a fixture that actually loses things", () => {
    // Otherwise the test above passes by the fixture being easy, which is the way a claim like this
    // rots: green on a model that never reaches the gaps.
    //
    // The exact set rather than a count, because which gaps the fixture reaches is the useful fact
    // and it is also the honest one: these two are the entries the check above can contradict.
    // `invariant`, `field`, `constraint` and `normalize` are declared from reading the generator
    // and stay unverified until a fixture contains an invariant over two lists, a list nested in a
    // list, and a rule on a wrapper under `validatorStyle attributes`. `decimal` never will be —
    // it is refused rather than lost, and a refusal is not a loss. Anything appearing here that
    // this list does not name is a new gap that wants a coverage entry.
    const constructs = new Set(
      [{}, { valueTypes: "alias" }, { validatorStyle: "attributes" }, { devHost: true }].flatMap(
        (options) => generated(options).artifacts.flatMap((a) => a.losses.map((l) => l.construct)),
      ),
    );
    expect([...constructs].sort()).toEqual(["reacts", "value"]);
  });
});
