/**
 * The configuration of pi-dent-terms (specs/terms-tool.md, Section 4.2): the root key `terms` of
 * pi-dent's layered configuration file, read as specs/config-file.md, Sections 1, 2, 3, and 7
 * specify, and the diagnostics of its `terms` value.
 *
 * `resolveConfig` is pure: the parsed layers in, the configuration and its diagnostics out.
 * `loadTermsConfig` adds the reads. A layer whose read or parse fails is dropped silently, as
 * Section 4.2 requires of this extension.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseTree, type Node, type ParseError } from "jsonc-parser";

/** The root key this extension contributes (specs/terms-tool.md, Section 4.2). */
export const CONFIG_ROOT_KEY = "terms";

/** The keys of the `terms` object (specs/terms-tool.md, Section 4.2). */
const TERMS_KEYS: readonly string[] = ["checkAfterEdit"];

/** The environment variables a `${env.NAME}` reference reads. */
export type Environment = Readonly<Record<string, string | undefined>>;

/** One parsed and substituted configuration layer (config-file.md, Sections 2 and 7). */
export interface ConfigLayer {
  /** The layer's file path, named in its diagnostics. */
  readonly path: string;
  /** The layer's root object after substitution. */
  readonly root: Readonly<Record<string, unknown>>;
}

/** The effective configuration of the extension, with its diagnostics. */
export interface TermsConfig {
  /** The user's default for the after-edit check; `undefined` when absent or invalid. */
  readonly checkAfterEdit?: boolean | undefined;
  /** Each message is reported as `pi-dent-terms: <message>`. */
  readonly diagnostics: readonly string[];
}

/** The inputs of `loadTermsConfig`; every field has a production default. */
export interface ConfigDependencies {
  readonly cwd: string;
  readonly homeDir?: string;
  readonly env?: Environment;
  /** The file's text, or `undefined` when it is missing or cannot be read. */
  readonly readFile?: (path: string) => string | undefined;
}

/** The layer file paths: `~/.pi/pi-dent/pi-dent.conf` and `<cwd>/.pi/pi-dent/pi-dent.conf`. */
export function layerPaths(cwd: string, homeDir: string): { global: string; project: string } {
  return {
    global: join(homeDir, ".pi", "pi-dent", "pi-dent.conf"),
    project: join(cwd, ".pi", "pi-dent", "pi-dent.conf"),
  };
}

/** Marks a value that substitution removes from its layer (config-file.md, Section 7). */
const ABSENT = Symbol("absent");

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Sets `key` as an own data property, so that `__proto__` stays a key (config-file.md, Section 2). */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** The value of one `${...}` token, or `undefined` when it is not a valid reference. */
function expansion(token: string, cwd: string, env: Environment): string | undefined {
  if (token === "project.root") return cwd;
  if (!token.startsWith("env.")) return undefined;
  const name = token.slice("env.".length);
  if (!ENV_NAME.test(name)) return undefined;
  return env[name];
}

/** A string with its placeholders expanded, or `ABSENT` when one is invalid (Section 7). */
function substituteString(value: string, cwd: string, env: Environment): string | typeof ABSENT {
  let out = "";
  let index = 0;
  while (index < value.length) {
    if (value.startsWith("$$", index)) {
      out += "$";
      index += 2;
    } else if (value.startsWith("${", index)) {
      const end = value.indexOf("}", index + 2);
      if (end === -1) return ABSENT;
      const replacement = expansion(value.slice(index + 2, end), cwd, env);
      if (replacement === undefined) return ABSENT;
      out += replacement;
      index = end + 1;
    } else {
      out += value.charAt(index);
      index += 1;
    }
  }
  return out;
}

/** A value with its strings substituted; invalid values are removed from their container. */
function substitute(value: unknown, cwd: string, env: Environment): unknown {
  if (typeof value === "string") return substituteString(value, cwd, env);
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const element of value) {
      const replaced = substitute(element, cwd, env);
      if (replaced !== ABSENT) out.push(replaced);
    }
    return out;
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const replaced = substitute(child, cwd, env);
      if (replaced !== ABSENT) setOwn(out, key, replaced);
    }
    return out;
  }
  return value;
}

/**
 * The plain value of a parsed node. Objects get own properties by `setOwn`, not assignment, so a
 * key such as `__proto__` stays a key (config-file.md, Section 2).
 */
function nodeValue(node: Node): unknown {
  if (node.type === "object") {
    const out: Record<string, unknown> = {};
    for (const property of node.children ?? []) {
      const [keyNode, valueNode] = property.children ?? [];
      if (keyNode === undefined || valueNode === undefined) continue;
      setOwn(out, String(keyNode.value), nodeValue(valueNode));
    }
    return out;
  }
  if (node.type === "array") return (node.children ?? []).map((child) => nodeValue(child));
  return node.value;
}

/**
 * The layer of a file's text (config-file.md, Sections 2 and 7), or `undefined` when the layer
 * is dropped: its parse fails, or its root is not an object.
 */
export function parseLayer(
  path: string,
  text: string,
  cwd: string,
  env: Environment = {},
): ConfigLayer | undefined {
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || tree === undefined || tree.type !== "object") return undefined;
  const parsed = nodeValue(tree);
  if (!isRecord(parsed)) return undefined;
  const substituted = substitute(parsed, cwd, env);
  if (!isRecord(substituted)) return undefined;
  return { path, root: substituted };
}

/** Whether a path of keys is declared as own properties of a layer's root (config-file.md, 4). */
function declares(root: Readonly<Record<string, unknown>>, path: readonly string[]): boolean {
  let node: unknown = root;
  for (const key of path) {
    if (!isRecord(node) || !Object.hasOwn(node, key)) return false;
    node = node[key];
  }
  return true;
}

/** Deep merge: objects merge key by key, any other value of `override` replaces (Section 3). */
function mergeValues(base: unknown, override: unknown): unknown {
  if (!isRecord(base) || !isRecord(override)) return override;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base)) setOwn(out, key, value);
  for (const [key, value] of Object.entries(override)) {
    setOwn(out, key, Object.hasOwn(base, key) ? mergeValues(base[key], value) : value);
  }
  return out;
}

/**
 * The configuration of the `terms` key from the layers (config-file.md, Sections 3 and 4): the
 * project layer wins, and each diagnostic names the file of the layer that owns its key.
 */
export function resolveConfig(layers: {
  readonly global?: ConfigLayer | undefined;
  readonly project?: ConfigLayer | undefined;
}): TermsConfig {
  // Lowest priority first, so that the merge lets the project layer win.
  const ordered = [layers.global, layers.project].filter(
    (layer): layer is ConfigLayer => layer !== undefined,
  );
  const ownerOf = (path: readonly string[]): string =>
    [...ordered].toReversed().find((layer) => declares(layer.root, path))?.path ?? "";

  let merged: unknown;
  for (const layer of ordered) {
    if (declares(layer.root, [CONFIG_ROOT_KEY])) {
      merged = mergeValues(merged, layer.root[CONFIG_ROOT_KEY]);
    }
  }
  if (merged === undefined) return { diagnostics: [] };
  if (!isRecord(merged)) {
    const file = ownerOf([CONFIG_ROOT_KEY]);
    return { diagnostics: [`${file}: ${CONFIG_ROOT_KEY} must be an object`] };
  }

  const diagnostics: string[] = [];
  let checkAfterEdit: boolean | undefined;
  if (Object.hasOwn(merged, "checkAfterEdit")) {
    const value = merged.checkAfterEdit;
    if (typeof value === "boolean") {
      checkAfterEdit = value;
    } else {
      const file = ownerOf([CONFIG_ROOT_KEY, "checkAfterEdit"]);
      diagnostics.push(`${file}: ${CONFIG_ROOT_KEY}.checkAfterEdit must be true or false`);
    }
  }
  const unknownKeys = Object.keys(merged)
    .filter((key) => !TERMS_KEYS.includes(key))
    .toSorted();
  if (unknownKeys.length > 0) {
    const file = ownerOf([CONFIG_ROOT_KEY]);
    diagnostics.push(`${file}: ${CONFIG_ROOT_KEY} has unknown keys ${unknownKeys.join(", ")}`);
  }
  return { checkAfterEdit, diagnostics };
}

/**
 * The extension's configuration: both layers read, parsed, and resolved. Call it once per
 * extension instance (specs/terms-tool.md, Section 4.2).
 */
export function loadTermsConfig(dependencies: ConfigDependencies): TermsConfig {
  const homeDir = dependencies.homeDir ?? homedir();
  const env = dependencies.env ?? process.env;
  const readFile = dependencies.readFile ?? readText;
  const paths = layerPaths(dependencies.cwd, homeDir);
  const layerOf = (path: string): ConfigLayer | undefined => {
    const text = readFile(path);
    return text === undefined ? undefined : parseLayer(path, text, dependencies.cwd, env);
  };
  return resolveConfig({ global: layerOf(paths.global), project: layerOf(paths.project) });
}

/** The file's text, or `undefined` when it is missing or cannot be read. */
function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}
