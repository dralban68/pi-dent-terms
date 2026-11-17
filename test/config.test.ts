import assert from "node:assert/strict";
import { test } from "node:test";

import { layerPaths, loadTermsConfig, parseLayer, resolveConfig } from "../lib/config.ts";

const HOME = "/home/u";
const CWD = "/repo";
const GLOBAL = "/home/u/.pi/pi-dent/pi-dent.conf";
const PROJECT = "/repo/.pi/pi-dent/pi-dent.conf";

/** The configuration loaded from the given layer texts, keyed by their file paths. */
function load(files: Record<string, string>, env: Record<string, string | undefined> = {}) {
  return loadTermsConfig({ cwd: CWD, homeDir: HOME, env, readFile: (path) => files[path] });
}

test("4.2 config: the layer paths are ~/.pi/pi-dent/pi-dent.conf and <cwd>/.pi/pi-dent/pi-dent.conf", () => {
  assert.deepEqual(layerPaths(CWD, HOME), { global: GLOBAL, project: PROJECT });
});

test("4.2 config: no layer gives no value and no diagnostic", () => {
  const config = load({});
  assert.equal(config.checkAfterEdit, undefined);
  assert.deepEqual(config.diagnostics, []);
});

test("4.2 config: a value read from the project layer", () => {
  const config = load({ [PROJECT]: '{ "terms": { "checkAfterEdit": true } }' });
  assert.equal(config.checkAfterEdit, true);
  assert.deepEqual(config.diagnostics, []);
});

test("3 config: the global layer supplies what the project layer does not declare", () => {
  assert.equal(
    load({ [GLOBAL]: '{ "terms": { "checkAfterEdit": false } }' }).checkAfterEdit,
    false,
  );
  assert.equal(
    load({
      [GLOBAL]: '{ "terms": { "checkAfterEdit": false } }',
      [PROJECT]: '{ "terms": {} }',
    }).checkAfterEdit,
    false,
  );
});

test("3 config: the project layer wins a conflict", () => {
  const config = load({
    [GLOBAL]: '{ "terms": { "checkAfterEdit": true } }',
    [PROJECT]: '{ "terms": { "checkAfterEdit": false } }',
  });
  assert.equal(config.checkAfterEdit, false);
});

test("4.2 config: a terms value that is not an object is one diagnostic, naming the owning layer", () => {
  const config = load({
    [GLOBAL]: '{ "terms": { "checkAfterEdit": true } }',
    [PROJECT]: '{ "terms": 5 }',
  });
  assert.equal(config.checkAfterEdit, undefined);
  assert.deepEqual(config.diagnostics, [`${PROJECT}: terms must be an object`]);
});

test("4.2 config: a null terms value is not an object", () => {
  const config = load({ [GLOBAL]: '{ "terms": null }' });
  assert.deepEqual(config.diagnostics, [`${GLOBAL}: terms must be an object`]);
});

test("4.2 config: a checkAfterEdit that is not a boolean is ignored, with the file of its layer", () => {
  const config = load({
    [GLOBAL]: '{ "terms": { "checkAfterEdit": "yes" } }',
    [PROJECT]: '{ "terms": {} }',
  });
  assert.equal(config.checkAfterEdit, undefined);
  assert.deepEqual(config.diagnostics, [`${GLOBAL}: terms.checkAfterEdit must be true or false`]);
});

test("3 config: a non-boolean project value replaces the global boolean, with no fallback", () => {
  const config = load({
    [GLOBAL]: '{ "terms": { "checkAfterEdit": false } }',
    [PROJECT]: '{ "terms": { "checkAfterEdit": 1 } }',
  });
  assert.equal(config.checkAfterEdit, undefined);
  assert.deepEqual(config.diagnostics, [`${PROJECT}: terms.checkAfterEdit must be true or false`]);
});

test("2 config: unknown keys of terms are one diagnostic, in ascending order", () => {
  const config = load({
    [PROJECT]: '{ "terms": { "checkAfterEdit": true, "zeta": 1, "alpha": {} } }',
  });
  assert.equal(config.checkAfterEdit, true);
  assert.deepEqual(config.diagnostics, [`${PROJECT}: terms has unknown keys alpha, zeta`]);
});

test("4.2 config: unknown keys are named by the owner of terms, even when they come from the other layer", () => {
  const config = load({
    [GLOBAL]: '{ "terms": { "beta": 1 } }',
    [PROJECT]: '{ "terms": { "checkAfterEdit": true } }',
  });
  assert.equal(config.checkAfterEdit, true);
  assert.deepEqual(config.diagnostics, [`${PROJECT}: terms has unknown keys beta`]);
});

test("2 config: JSONC comments and trailing commas are read", () => {
  const config = load({
    [PROJECT]: '// the user default\n{ /* settings */ "terms": { "checkAfterEdit": true, }, }',
  });
  assert.equal(config.checkAfterEdit, true);
});

test("2 config: a layer that fails to parse is dropped, the other layer still provides", () => {
  const config = load({
    [GLOBAL]: '{ "terms": { "checkAfterEdit": true } }',
    [PROJECT]: "{ broken",
  });
  assert.equal(config.checkAfterEdit, true);
  assert.deepEqual(config.diagnostics, []);
});

test("2 config: a layer whose root is not an object is dropped without a diagnostic", () => {
  assert.equal(parseLayer(PROJECT, "[1, 2]", CWD), undefined);
  const config = load({
    [PROJECT]: "[1, 2]",
    [GLOBAL]: '{ "terms": { "checkAfterEdit": false } }',
  });
  assert.equal(config.checkAfterEdit, false);
  assert.deepEqual(config.diagnostics, []);
});

test("4.2 config: a __proto__ key of terms is an unknown key, named by its diagnostic", () => {
  const config = load({
    [PROJECT]: '{ "terms": { "__proto__": { "checkAfterEdit": true } } }',
  });
  assert.equal(config.checkAfterEdit, undefined);
  assert.deepEqual(config.diagnostics, [`${PROJECT}: terms has unknown keys __proto__`]);
});

test("2 config: unknown root keys belong to pi-dent, so this extension reports none", () => {
  const config = load({ [PROJECT]: '{ "unrelated": 1, "terms": { "checkAfterEdit": true } }' });
  assert.equal(config.checkAfterEdit, true);
  assert.deepEqual(config.diagnostics, []);
});

test("7 config: ${env.NAME} expands; an undefined variable removes the value", () => {
  const set = load(
    { [GLOBAL]: '{ "terms": { "checkAfterEdit": "${env.PI_DENT_TERMS_FLAG}" } }' },
    { PI_DENT_TERMS_FLAG: "true" },
  );
  // The expanded string is not a boolean: the value is ignored with a diagnostic.
  assert.equal(set.checkAfterEdit, undefined);
  assert.deepEqual(set.diagnostics, [`${GLOBAL}: terms.checkAfterEdit must be true or false`]);

  const unset = load({
    [GLOBAL]: '{ "terms": { "checkAfterEdit": "${env.PI_DENT_TERMS_FLAG}" } }',
  });
  assert.equal(unset.checkAfterEdit, undefined);
  assert.deepEqual(unset.diagnostics, []);
});

test("7 config: $$ renders a literal $, and ${project.root} the working directory", () => {
  const escaped = load({ [PROJECT]: '{ "terms": "$${env.X}" }' }, { X: "1" });
  assert.deepEqual(escaped.diagnostics, [`${PROJECT}: terms must be an object`]);

  const root = load({ [PROJECT]: '{ "terms": "${project.root}" }' });
  assert.deepEqual(root.diagnostics, [`${PROJECT}: terms must be an object`]);
});

test("7 config: an invalid reference removes its value and gives no diagnostic from this extension", () => {
  const config = load({ [PROJECT]: '{ "terms": { "checkAfterEdit": "${nope}" } }' });
  assert.equal(config.checkAfterEdit, undefined);
  assert.deepEqual(config.diagnostics, []);
});

test("resolveConfig: the layers as parsed, with no layer at all", () => {
  assert.deepEqual(resolveConfig({}), { diagnostics: [] });
});

test("2 config: a missing home directory and working directory give no value and no throw", () => {
  const config = loadTermsConfig({
    cwd: "/nonexistent-pi-dent-terms-cwd",
    homeDir: "/nonexistent-pi-dent-terms-home",
  });
  assert.equal(config.checkAfterEdit, undefined);
  assert.deepEqual(config.diagnostics, []);
});
