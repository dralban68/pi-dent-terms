# Terms tool specification

This document specifies the `pi-dent-terms` extension: the `Terms` tool, through which a session
looks entries up, checks its workspace, and runs the operations on its terms file, and the
after-edit check, which checks a document that the host's `edit` or `write` tool changed. The
terms file, matching, checks, and operations are owned by [terms.md](terms.md).

## 1. Package and registration

The package name is `pi-dent-terms`. The `pi` key of its `package.json` holds the package manifest,
whose `extensions` array MUST be exactly `["./index.ts"]`; that module's default export is the
extension factory.

The extension MUST register the tool through the host `registerTool` API when it loads, in every
run mode:

| Field           | Value                                  |
| --------------- | -------------------------------------- |
| `name`          | `"Terms"`                              |
| `label`         | `"Terms"`                              |
| `description`   | The text of Section 1.3                |
| `promptSnippet` | The text of Section 1.3                |
| `parameters`    | The parameter schema of Section 1.1    |
| `executionMode` | `"sequential"`                         |
| `renderShell`   | not set: the host's default tool shell |

`executionMode` `"sequential"` makes the host run a `Terms` call alone, never concurrently with
another tool call. `renderCall` and `renderResult` are not set. Every rejection this
specification gives is a tool error (`isError: true`) whose content is its error text alone,
with no `details`.

### 1.1 Parameter schema

The parameter schema is a JSON object schema with `type: "object"` and
`additionalProperties: false`, with one required field, `action`; every other field is optional
in the schema and admits `null` beside the type in the table, and each action accepts only its
fields below. A field whose value is `null` counts as absent.

| Field               | Type                                                                                                             | Actions                                                           | Contract                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `action`            | `"find" \| "check" \| "add" \| "update" \| "rename" \| "merge" \| "split" \| "deprecate" \| "reown" \| "import"` | all                                                               | The action (Section 3).                                                             |
| `query`             | string? \| null                                                                                                  | `find`                                                            | The text looked up (Section 3.1).                                                   |
| `id`                | string? \| null                                                                                                  | `add`, `update`, `rename`, `merge`, `split`, `deprecate`, `reown` | Required. The entry the operation acts on.                                          |
| `label`             | string? \| null                                                                                                  | `add`, `rename`                                                   | Required. The label.                                                                |
| `meaning`           | string? \| null                                                                                                  | `add`, `update`                                                   | Required for `add`, optional for `update`. The meaning.                             |
| `owner`             | string? \| null                                                                                                  | `find`, `add`, `reown`                                            | Required for `add` and `reown`. The owner path ([terms.md](terms.md), Section 1.2). |
| `group`             | string? \| null                                                                                                  | `find`, `add`                                                     | Required for `add`. The group.                                                      |
| `key`               | `"shared" \| "confusable" \| "local"`? \| null                                                                   | `find`, `add`, `update`                                           | Required for `add`. The key.                                                        |
| `status`            | `"active" \| "deprecated"`? \| null                                                                              | `find`, `update`                                                  | The status; for `update`, `active` only.                                            |
| `reject`            | string[]? \| null                                                                                                | `add`                                                             | The reject phrases.                                                                 |
| `distinguish`       | string[]? \| null                                                                                                | `add`                                                             | The ids to distinguish.                                                             |
| `addReject`         | string[]? \| null                                                                                                | `update`                                                          | Reject phrases to add.                                                              |
| `removeReject`      | string[]? \| null                                                                                                | `update`                                                          | Reject phrases to remove.                                                           |
| `addDistinguish`    | string[]? \| null                                                                                                | `update`                                                          | Distinguish ids to add symmetrically.                                               |
| `removeDistinguish` | string[]? \| null                                                                                                | `update`                                                          | Distinguish ids to remove symmetrically.                                            |
| `forms`             | string[]? \| null                                                                                                | `add`, `rename`                                                   | The irregular forms of the label.                                                   |
| `into`              | string[]? \| null                                                                                                | `merge`, `split`                                                  | Required. The ids merged or split into.                                             |
| `reason`            | `"renamed" \| "out-of-scope"`? \| null                                                                           | `deprecate`                                                       | Required. The reason.                                                               |
| `replacedBy`        | string[]? \| null                                                                                                | `deprecate`                                                       | The replacements.                                                                   |
| `path`              | string? \| null                                                                                                  | `import`                                                          | Required. The workspace path of the document holding the table.                     |
| `changes`           | object[]? \| null                                                                                                | `check`                                                           | The change set ([terms.md](terms.md), Section 5.4).                                 |

Each item of `changes` is an object schema with `additionalProperties: false`, the required
fields `path` (string) and `before` (string or `null`), and the optional field `from` (string or
`null`, `null` counting as absent). The schema constrains the types of the table and of these
items, the values of `action`, `key`, and `reason`, and the set of admitted properties, and
nothing else. Each field other than `changes` maps to the operation parameter of the same name ([terms.md](terms.md), Section 6); `merge` passes the one id of `into` as its
`into`.

### 1.2 Validation

Execution-time validation MUST reject the call with the error text of the first failing check,
in this order, before any file is read:

| #   | Check                                                                                                    | Error text                                       |
| --- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 1   | A field other than `action` that the action does not accept is present (first such field in table order) | `<field> is not valid for action <action>`       |
| 2   | A required field of the action is absent (first such field in table order)                               | `action <action> requires <field>`               |
| 3   | A string field is empty after trimming (first such field in table order)                                 | `<field> must be a non-empty string`             |
| 4   | A list field holds an item that is empty after trimming (first such field in table order)                | `<field> must hold non-empty strings`            |
| 5   | `merge`: `into` does not hold exactly one item                                                           | `merge takes exactly one id in into`             |
| 6   | `find`: none of `query`, `status`, `key`, `group`, and `owner` is present                                | `action find requires query or a filter`         |
| 7   | `update`: `status` is `deprecated`                                                                       | `update takes status active only; use deprecate` |
| 8   | `changes`: the change set is not valid ([terms.md](terms.md), Section 5.4)                               | see below                                        |

Trimming removes leading and trailing white space ([terms.md](terms.md), Section 4.1). Every
string, and every item of a list, is used trimmed, except `before`, which is used as given.

For check 8, the items of `changes` are examined in order; for each item, its `path`, then its
`from` when set, then the item as a whole, each against the conditions of
[terms.md](terms.md), Section 5.4, in their order. The first failure gives its text, `<i>` being
the item's position from 0:

| Condition | Error text                                                                                |
| --------- | ----------------------------------------------------------------------------------------- |
| 1         | `changes[<i>].<field> must be .pi/pi-dent/terms.yaml or a workspace path ending with .md` |
| 2         | `changes[<i>].from must be .pi/pi-dent/terms.yaml exactly when path is`                   |
| 3         | `changes[<i>].from needs a before text`                                                   |
| 4         | `changes[<i>].before holds a lone surrogate`                                              |
| 5         | `changes[<i>].path repeats "<path>"`                                                      |
| 6         | `changes[<i>].<field> repeats the base path "<p>"`                                        |

Condition 1 applies to each field examined, condition 2 to `from`; conditions 3 to 6 to the item
as a whole,
condition 6 naming `from` when it is set, else `path`, `<p>` being the base path.

### 1.3 Model-facing texts

The texts of this section are what a model reads to choose and fill a call; each MUST be
registered verbatim, and none cites a specification.

The `description` is

```text
Manage this workspace's thesaurus in .pi/pi-dent/terms.yaml, one preferred label per concept and no synonyms, and check the workspace's Markdown documents against it. find looks entries up by id, label, reject phrase, form, or meaning, optionally filtered by status, key, group, or owner (a filter alone lists every entry it admits), and lists each match with its meaning, status, owner, and related entries; use it to learn what a term means and before writing a domain term you are unsure of. check reports findings for the terms file and for every Markdown document not ignored by git; with changes, each the changed file's path, its text before the change (null when new), and from when moved, it reports only the findings the changes introduced and lists label occurrences on changed lines, to confirm each means its entry; list every file you changed, .pi/pi-dent/terms.yaml included after an operation, and keep each before text the same across checks. add, update, rename, merge, split, deprecate, and reown change the terms file and record the change in each changed entry's history; ids are never removed. update changes an active entry's key, meaning, reject phrases, or symmetric distinguish relations, recording a replaced meaning in history, and with status active returns a deprecated entry to active; give at least one effective change. local entries are used only by their owner. An entire normalised code span matching an active label or form, or its capitalised variant, counts as a use, never an occurrence to rewrite. Owners can be workspace-relative paths with leading ../ for external files. import fills an empty terms file from a Markdown table with the columns Term, Meaning, Owner, and Avoid or distinguish. No action edits a document: the result lists the occurrences to rewrite, with a suggested text where there is one; apply them with your edit tool. To keep one occurrence on purpose, put <!-- terms-ignore P001: reason --> (or P002) on its line or as a standalone comment before it; a standalone comment targets the first nonblank line after its block.
```

The `promptSnippet` is

```text
Look up, check, and change the workspace's thesaurus of terms
```

Each property of the parameter schema carries this `description`:

| Field               | `description`                                                                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `action`            | `find: look entries up. check: report findings. add, update, rename, merge, split, deprecate, reown, import: change the terms file.`                                                        |
| `query`             | `For find: text to look for in ids, labels, reject phrases, forms, and meanings, ignoring case; optional when a filter (status, key, group, owner) is given.`                               |
| `id`                | `The entry's id, a lowercase slug such as "rendered-view"; for add, the new id.`                                                                                                            |
| `label`             | `For add and rename: the one preferred term, in base form, lowercase unless a name.`                                                                                                        |
| `meaning`           | `For add (required) or update (optional): one sentence saying what the concept is.`                                                                                                         |
| `owner`             | `For add and reown: the owner path of the Markdown file that defines the term, relative to the workspace root; leading ../ is allowed. For find: list only entries with this owner.`        |
| `group`             | `For add: the group the entry is listed under. For find: list only entries in this group.`                                                                                                  |
| `key`               | `For add (required) or update (optional): shared for use by two or more documents, confusable for one or more, local for use only by the owner. For find: list only entries with this key.` |
| `status`            | `For find: list only active or only deprecated entries. For update: active returns a deprecated entry to active; the other update fields apply as well.`                                    |
| `reject`            | `For add: specific phrases that must not be used for this concept; never ordinary words.`                                                                                                   |
| `distinguish`       | `For add: ids of neighbouring concepts a reader could confuse with this one.`                                                                                                               |
| `addReject`         | `For update: specific reject phrases to add; already-present phrases are refused.`                                                                                                          |
| `removeReject`      | `For update: reject phrases to remove; missing phrases are refused.`                                                                                                                        |
| `addDistinguish`    | `For update: existing ids to distinguish from, on both entries; self and existing relations are refused.`                                                                                   |
| `removeDistinguish` | `For update: ids to stop distinguishing from, on both entries; missing relations are refused.`                                                                                              |
| `forms`             | `For add and rename: irregular inflections of the label only; regular plurals are derived.`                                                                                                 |
| `into`              | `For merge: the one id that absorbs the entry. For split: the two or more ids that replace it; add them first.`                                                                             |
| `reason`            | `For deprecate: renamed (with one replacedBy) or out-of-scope (with none).`                                                                                                                 |
| `replacedBy`        | `For deprecate: the id of the entry that replaces it.`                                                                                                                                      |
| `path`              | `For import: the workspace-relative path of the Markdown thesaurus.`                                                                                                                        |
| `changes`           | `For check: the changed files, each { path, before, from }: before is the text before the change, null for a new file; from is the old path of a moved file.`                               |

## 2. Workspace access

The workspace of a call or an event is that of the workspace root ([terms.md](terms.md),
Section 1.1) of the invoking session's working directory. Each call reads the terms file anew
and, unless its action is `find`, lists and reads the documents anew. A call MUST be rejected,
the first failure reported, with:

| Failure                                                                                 | Error text                                   |
| --------------------------------------------------------------------------------------- | -------------------------------------------- |
| The working directory has no workspace root                                             | `<cwd> is not inside a Git working tree`     |
| Git cannot be run, or a Git command of [terms.md](terms.md), Section 1, fails otherwise | `git failed: <message>`                      |
| The terms file exists and cannot be read                                                | `cannot read .pi/pi-dent/terms.yaml: <code>` |
| `find` or `check`, and there is no terms file                                           | `no terms file at .pi/pi-dent/terms.yaml`    |

`<cwd>` is the working directory; `<message>` is the first line of what Git wrote to its error
output, else the system's error message; `<code>` is the error code the file system reports
(such as `EISDIR`), else its message. A `git rev-parse --show-toplevel` run that exits with a
failure status is the first row; a Git that cannot be started is the second. A terms file whose
path gives `ENOENT` or `ENOTDIR` is absent.

For `check`, the extension MUST separately supply the external owner texts of
[terms.md](terms.md), Section 1.2, for every active entry not left out under that
specification's Section 2.3. Paths are resolved against the workspace root. File type is tested
on the final path component without following a symbolic link there; symbolic links in parent
directories are followed. The extension MUST skip missing,
unreadable, non-regular, non-UTF-8, or U+0000-containing external owner files without an error.

The extension MUST NOT read a file or run Git to derive a change set: `changes` is used as
given. An operation's date is the current calendar date in the local time zone of the process. A
refusal of an operation ([terms.md](terms.md), Section 6.1) is a tool error with the refusal
text. Otherwise the extension MUST write the new terms file text to `.pi/pi-dent/terms.yaml`,
creating `.pi/` and `.pi/pi-dent/` when they are absent. It MUST write the text to a new file in the
directory of the terms file's target and rename that file over the target, so that a failed write
leaves the previous terms file unchanged and removes the new file. It MUST NOT write any other
file, including a `.gitignore` in `.pi/pi-dent/`; a failed write is a tool error
`cannot write .pi/pi-dent/terms.yaml: <code>`. The target is the file a symbolic link at
`.pi/pi-dent/terms.yaml` resolves to, else `.pi/pi-dent/terms.yaml`.

When a call's abort signal fires while a Git command of the call runs, the extension MUST end that
Git process; the call is then rejected as a Git failure (`git failed: <message>`).

## 3. Actions

A result's content is one text block holding its result text. In a result text, `"<x>"` is the
value as ECMAScript `JSON.stringify` writes it ([ECMA-262]), lines are joined by one line feed,
and the words `entries`, `findings`, `documents`, `occurrences`, `candidates`, and `changes` stay
plural
whatever the number. `isError` is unset on every result of this section.

### 3.1 `find`

`<query>` is `query` normalised ([terms.md](terms.md), Section 4.1). The filters are `status`,
`key`, `group`, and `owner`, each when present. An entry matches when each of these that is
present holds:

- `<query>`, in ECMAScript lower case ([ECMA-262]), is a substring of its `id`, its `label`, one
  of its `reject` or `forms` phrases, or its `meaning`, each normalised and in ECMAScript lower
  case;
- its `status` equals `status`, and its `key` equals `key`;
- its `group`, normalised, equals `group` normalised;
- its `owner` equals `owner`.

Entries left out under [terms.md](terms.md), Section 2.3, are not searched. Matching entries are
listed in ascending `id` order; with `query`, those whose normalised lower-case label equals the
lower-case `<query>` come first, then the others, each part in ascending `id` order.

`<search>` is, joined by `, `, each of these whose parameter is present, in this order:
`"<query>"`, `status <status>`, `key <key>`, `group "<group>"`, and `owner <owner>`, the group
normalised. With no match the text is `No entry matches <search>`. Otherwise it is the line
`<n> entries match <search>:`, then for each matching entry the line
`<id> "<label>" · <status> · <key> · <group> · owner <owner>`, followed by these lines, each
present only when its list is not empty or its field is set, indented by two spaces:

1. `meaning: <meaning>`;
2. `reject: ` and the `reject` phrases as `"<p>"`, joined by `, `;
3. `forms: ` and the `forms` phrases, written the same way;
4. `distinguish: ` and each entry in the distinguish relation with it, in ascending `id`
   order, as `<id> "<label>"`, or `<id> (not an entry)` for a listed id that names no entry left
   in under [terms.md](terms.md), Section 2.3, joined by `, `;
5. `replacedBy: ` and each replacement as on line 4, joined by `, `;
6. `reason: <reason>`.

When the terms file gives T001 findings, the line `.pi/pi-dent/terms.yaml has <k> T001 findings;
run check` ends the text, with or without a match. `details` is `{ action: "find", ids: [<id>…] }`,
the matching ids in listed order.

### 3.2 `check`

The text is the line `<n> findings · <d> documents · <e> entries`, then the text of each finding
of the check of the workspace ([terms.md](terms.md), Section 5.1), in order, one per line. `<d>`
is the number of documents and `<e>` the number of items of `terms`, `0` when `terms` is not a
sequence. `details` is
`{ action: "check", findings: [{ path, line, column, code, message }…] }` in the same order.

With `changes`, the findings are the introduced findings of the change set ([terms.md](terms.md),
Section 5.4), and the first line is `<n> findings introduced · <c> changes · <d> documents · <e>
entries`, `<c>` being the number of items of `changes`. When there is at least one label
occurrence in changed lines, the finding lines are followed by an empty line, the line
`<u> label occurrences in changed lines; confirm each means its entry:`, `<u>` being their
number, and for each entry with one, in ascending `id` order, the line
`<id> "<label>": <meaning>`, label and meaning as the terms file holds them, then one line per
label occurrence of it, in order, `  <path>:<line>:<column> "<text>"`, indented by two spaces,
`<text>` being its normalised source text. `details` also holds
`occurrences: [{ id, path, line, column, text }…]`, in the same order.

### 3.3 Operations

The actions `add`, `update`, `rename`, `merge`, `split`, `deprecate`, `reown`, and `import` run the
operation of the same name ([terms.md](terms.md), Section 6, including `update` in Section 6.9).
The text is the summary line, then ` · .pi/pi-dent/terms.yaml written`
appended to it, then the edit list block, then, for `import`, the candidate block.

| Action      | Summary line                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `add`       | `Added <id> "<label>"`                                                                                                                        |
| `update`    | `Updated <id>`                                                                                                                                |
| `rename`    | `Renamed <id> "<old label>" → "<label>"`                                                                                                      |
| `merge`     | `Merged <id> into <into>`                                                                                                                     |
| `split`     | `Split <id> into <ids>`                                                                                                                       |
| `deprecate` | `Deprecated <id> (<reason>)`, followed by ` → <ids>` when `replacedBy` holds one or more ids                                                  |
| `reown`     | `Moved the owner of <id> from <old owner> to <owner>`                                                                                         |
| `import`    | `Imported <n> entries from <path>`, followed by `; key local: <ids>` when any ids were assigned `local` per [terms.md](terms.md), Section 6.8 |

`<ids>` is the list joined by `, `; for `import` it is the local ids in ascending order.
The edit list block is the line `No occurrences to edit.`
when the edit list is empty; otherwise the line
`<k> occurrences to edit with your edit tool; no document was changed:`, then one line per
occurrence in edit list order: `<path>:<line>:<column> "<old>" → "<new>"`, or
`<path>:<line>:<column> "<old>" → no suggestion, rewrite by hand` when the item has no suggested
text. The candidate block is absent when there is no reject candidate; otherwise the line
`<k> reject candidates; use update with addReject for specific phrases and drop ordinary words:`, then one
line `<id>: "<item>"` per candidate in order.

For example, an `update` of `rendered-view` with an empty edit list returns:

```text
Updated rendered-view · .pi/pi-dent/terms.yaml written
No occurrences to edit.
```

`details` is `{ action, edits: [{ path, line, column, old, new }…] }`, `new` being `null` for an
item without a suggested text; for `import` it also holds `candidates: [{ id, text }…]` and
`localIds: [<id>…]`, the local ids in ascending order, empty when none qualify.

## 4. After-edit check

### 4.1 Effective setting

The after-edit check is off for a workspace without a terms file. Otherwise it is on when the
terms file's `settings.checkAfterEdit` is `true` and off when it is `false`; when that value is
absent or counts as absent ([terms.md](terms.md), Section 2.2), the configuration value of
Section 4.2 decides, and without one the check is off.

### 4.2 Configuration

This specification contributes the root key `terms` to pi-dent's configuration file
(pi-dent-agent `specs/config-file.md`, Section 2):

| Key                    | Type              | Contract                                                           |
| ---------------------- | ----------------- | ------------------------------------------------------------------ |
| `terms`                | object, optional  | The settings of this extension.                                    |
| `terms.checkAfterEdit` | boolean, optional | The user's default for the after-edit check, used per Section 4.1. |

The extension MUST read the configuration as
pi-dent-agent `specs/config-file.md`, Sections 1, 2, 3, and 7, specify it, once per
extension instance (one call of the extension factory), at the instance's first
`session_start`; a layer that those sections drop is dropped without a diagnostic from this
extension. A `terms` value that is not an object, or a `checkAfterEdit` value that is not a
boolean, MUST produce one diagnostic and be ignored; unknown keys of `terms` follow the
unknown-key rule (pi-dent-agent `specs/config-file.md`, Section 2). The diagnostics
are
`<file>: terms must be an object`, `<file>: terms.checkAfterEdit must be true or false`, and
`<file>: terms has unknown keys <keys>`, `<keys>` being the unknown keys in ascending order
joined by `, `, and `<file>` the owning layer's file
(pi-dent-agent `specs/config-file.md`, Section 4). Each MUST be reported once per
extension instance, at that `session_start`, through the host `notify` API at level `warning`
as `pi-dent-terms: <message>`. Other diagnostics of config-file.md, Sections 1, 2, and 7 (layer read,
parse, root, substitution) are not reported by this extension.

### 4.3 Checking a written document

The extension MUST handle every `tool_result` event whose tool name is `edit` or `write` and
whose `isError` is false. Its target is the event input's `path` when it is a string, with one
leading `@` removed and `~` or a leading `~/` standing for the user's home directory, resolved
against the invoking session's working directory when relative. The target's directory is resolved
through symbolic links (realpath) before its workspace path is taken. When the after-edit check is
on, read at the event, and the target is a document of the workspace, the extension MUST run the
prose checks of that document ([terms.md](terms.md), Section 5.3) on its current text, with the
findings that valid suppression comments suppress left out. When at least one finding remains,
the handler MUST return the event's content with one text block appended:
`Terms check of <path>: <n> findings`, then the text of each finding, one per line, `<path>`
being the target's workspace path. In every other case, a failure to run Git or read a file
included, the handler MUST leave the result unchanged.

## 5. Normative references

- [ECMA-262] ECMAScript Language Specification, 14th edition (June 2023), Ecma International:
  `String.prototype.toLowerCase` and `JSON.stringify`.

## 6. Specification gaps

- Whether a child session binds `Terms`, and whether the host fires `tool_result` for a child
  session's `edit` and `write`, is the host's and pi-dent's.
- A document changed through any tool other than the host's `edit` and `write`, such as pi-dent's
  `Markdown` `edit`, `Bash`, or `Script`, gets no after-edit check.
- The terms file is written outside the host's file mutation queue; a process that changes it
  between a call's read and its write is overwritten.
- No bound is set on the number of items of `changes` or the length of a `before` text; the line
  pairing of a change takes time proportional to the product of its two line counts.
- No bound is set on the length of a result text; how the host shows or cuts a long one is the
  host's.
- The configuration is read once per extension instance, not once per boot window: a session
  that replaces its predecessor through the host's `new`, `resume`, or `fork` reads it again.
- File checks are not part of the after-edit check, so a use that an edit adds or removes changes
  the T005 and T006 findings only on the next `check`.
- The `old` text of an edit list item is often not unique in its document; the line and column
  locate it, but the host's `edit` needs enough surrounding text to be unique.
- A `git rev-parse --show-toplevel` failure for another reason, such as dubious ownership or a
  corrupt repository, is reported as `<cwd> is not inside a Git working tree`.
- A symbolic link at `.pi/pi-dent/terms.yaml`, at `.pi/`, or at `.pi/pi-dent/` is followed when the terms
  file is written, so the write can land outside the workspace.
- `.pi/pi-dent/` may hold a `.gitignore` written by the pi-dent desktop app (pi-dent-app), meant to
  ignore only that app's index files; whether the terms file is committable depends on it. A
  workspace whose own `.gitignore` ignores `.pi/` leaves the terms file untracked.
