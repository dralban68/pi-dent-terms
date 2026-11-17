# Terms specification

This document specifies the terms file of a workspace, the matching of its entries in the prose
of the workspace's documents, the checks that report findings, and the operations that change
the terms file. The `pi-dent-terms` package provides them as a library and as a pi extension; the
`Terms` tool and the after-edit check are owned by [terms-tool.md](terms-tool.md).

The library computes every check and every operation as a function of its inputs alone: the
terms file's bytes, the set of documents with their texts, for checks the separately supplied
external owner texts (Section 1.2), for a change check its change set (Section 5.4), and for an
operation its parameters and the date. The same
inputs MUST give the same output, byte for byte. The library MUST NOT read or write files,
read the clock, or run processes; the extension supplies the inputs and writes the output ([terms-tool.md](terms-tool.md), Section 2).

## 1. Workspace

### 1.1 Workspace root

The workspace root of a directory is the top level of the Git working tree that contains it,
the directory `git rev-parse --show-toplevel` prints when run in it. A directory outside every
Git working tree has no workspace root. The workspace of a workspace root is the Git working
tree below it, with its documents and its terms file. A workspace path is a path relative to
the workspace root, its segments joined by `/`, with no empty, `.`, or `..` segment.

### 1.2 Documents

The documents of a workspace are the files that `git ls-files -z --cached --others
--exclude-standard`, run in the workspace root, lists and that meet all of these:

- the path ends with `.md`, compared exactly;
- the path names a regular file, a symbolic link not being one whatever it points to;
- its bytes are valid UTF-8 and contain no U+0000.

A path listed more than once is one document. A document's text is its bytes decoded as UTF-8,
without a leading U+FEFF; a character is a Unicode scalar value. A line ending is a line feed,
a carriage return not followed by a line feed, or a carriage return followed by a line feed
([CommonMark], Section 2.1); lines are numbered from 1. The column of a character is 1 plus the
number of UTF-16 code units before it on its line. Paths are compared and ordered by UTF-16
code units.

An owner path is either a workspace path ending with `.md`, or one or more leading `../`
segments followed by a workspace path ending with `.md`. It is resolved against the workspace
root, not the session's working directory. Owner identity is its path string, without resolving
physical file aliases. An owner path with leading `../` is external; every
other owner path is internal. An external owner is not a workspace document, and its text
never contributes a document use or an occurrence.
The library accepts external owner texts separately, keyed by owner path, decoded as document
texts above. An absent external owner text is unavailable, not an empty text. Section 5.2
defines the check that uses these texts; the extension supplies them per
[terms-tool.md](terms-tool.md), Section 2.

## 2. Terms file

### 2.1 Location and syntax

The terms file of a workspace is `.pi/pi-dent/terms.yaml` under its workspace root; no other path
is the terms file. Its text is its bytes decoded as UTF-8, without a leading U+FEFF, parsed as one
YAML document ([YAML 1.2.2]) with the core schema (Section 10.3 of [YAML 1.2.2]), so that a date
is a string. A text that is not valid UTF-8, that does not parse, that holds other than exactly one
document, or that has a duplicate key in a mapping gives one T001 finding (Section 5.2) and no
settings and no entries.

### 2.2 Root

The root MUST be a mapping; a root that is not gives one T001 finding and no settings and no
entries. A `terms` value that is absent or not a sequence gives one T001 finding and no entries.
A `settings` value that is not a mapping, or a `settings` key whose value does not have its
type, gives one T001 finding and counts as absent.

| Key        | Type               | Contract                   |
| ---------- | ------------------ | -------------------------- |
| `settings` | mapping, optional  | The file-level settings.   |
| `terms`    | sequence, required | The entries (Section 2.3). |

| `settings` key   | Type              | Contract                                                                                           |
| ---------------- | ----------------- | -------------------------------------------------------------------------------------------------- |
| `checkAfterEdit` | boolean, optional | Whether the after-edit check runs in this workspace ([terms-tool.md](terms-tool.md), Section 4.1). |

An unknown key of the root, of `settings`, of an entry, or of a history item follows the
unknown-key rule (pi-dent-agent `specs/config-file.md`, Section 2), the one
diagnostic being one T001 finding that names the object and all its unknown keys.

### 2.3 Entries

An entry is the record of one concept. A string is one line when it holds neither a line feed
nor a carriage return; a non-empty line is a one-line string holding a character other than white
space; a phrase is a one-line string with no leading or trailing white space that holds at least
one word character (Section 4.1). An id is a string matching `^[a-z0-9]+(-[a-z0-9]+)*$`. Two
phrases or ids of one list are the same when they are equal after normalisation (Section 4.1).

| Field         | Type                     | Contract                                                                                                              |
| ------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `id`          | id, required             | The concept's identity. Unique in the file.                                                                           |
| `label`       | phrase, required         | The one preferred term for the concept, in base form.                                                                 |
| `meaning`     | string, required         | What the concept is, one non-empty line.                                                                              |
| `owner`       | string, required         | The owner path (Section 1.2) of the file that defines the concept.                                                    |
| `group`       | string, required         | The heading the entry is listed under, one non-empty line.                                                            |
| `key`         | enum, required           | `shared`: used by two or more documents. `confusable`: by one or more. `local`: used only by its owner (Section 5.2). |
| `status`      | enum, required           | `active` or `deprecated`.                                                                                             |
| `reject`      | phrase[], optional       | Phrases no document uses for the concept. No phrase twice.                                                            |
| `distinguish` | id[], optional           | Ids of neighbouring concepts a reader confuses with this one. No id twice.                                            |
| `forms`       | phrase[], optional       | Inflected forms of `label` that Section 4.1 does not derive. No phrase twice.                                         |
| `replacedBy`  | id[], optional           | Ids of the entries that replace a deprecated entry, its replacements. No id twice.                                    |
| `reason`      | enum, optional           | Why the entry is deprecated: `merged`, `split`, `renamed`, or `out-of-scope`.                                         |
| `history`     | history item[], required | The operations that changed the entry, in the order they did (Section 2.4); at least one item.                        |

An absent list is an empty list. The distinguish relation holds between two entries when
either lists the other. The `terms` sequence MUST hold its entries in strictly ascending order of
`id`; an entry whose `id` is not greater than the last string `id` before it gives one T001
finding. Each violation of this section or of Section 2.4 gives one T001 finding. An entry with
a T001 finding whose `<value path>` (Section 5.2) is the entry or lies under it, other than one
for unknown keys, is left out of every other check, of matching, and of the operations' changes;
its `id`, when it is a string, still counts as an existing id.

### 2.4 History items

A history item is a mapping with the keys `date`, a valid calendar date in the complete extended
form `YYYY-MM-DD` of [ISO 8601], `op`, and the operands of one operand set of its `op`, each
required except `replacedBy`:

| `op`        | Operand sets                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `add`       | none                                                                                                                                              |
| `update`    | none; `meaning`: the entry's meaning before the operation, a string; `status`: the entry's status before the operation, `deprecated`; or both     |
| `import`    | `from`: the workspace path of the imported document                                                                                               |
| `rename`    | `from`, `to`: the label before and after, phrases                                                                                                 |
| `merge`     | on the merged entry, `into`: the id it was merged into; on that entry, `from`: the merged id                                                      |
| `split`     | on the split entry, `into`: the list of ids it was split into; on each of those, `from`: the split id                                             |
| `deprecate` | on the deprecated entry, `reason` and, when it has replacements, `replacedBy`: the list of their ids; on a replacement, `from`: the deprecated id |
| `reown`     | `from`, `to`: the owner before and after, owner paths (Section 1.2)                                                                               |

A `merge` or `split` item takes its first set when it holds `into`, a `deprecate` item when it holds
`reason`, an `update` item the set of those of `meaning` and `status` it holds, and otherwise its
second set. An id operand
is a string, a list operand a sequence of strings, and `reason` takes the values of the entry field
`reason`. A key other than `date`, `op`, and the operands of the taken set is unknown. When `op` is
absent or not one of these values, no operand set is taken and the item's keys other than `date` and
`op` are not checked.

### 2.5 Canonical form

Every terms file an operation writes is in canonical form:

1. UTF-8 without a byte-order mark; every line ends with a line feed; no line has trailing
   white space.
2. When the input had a non-empty `settings`, the line `settings:` and each of its keys as
   `<key>: <value>` on its own line indented by 2 spaces, in the order of the table of
   Section 2.2; then `terms:`, or `terms: []` when there is no entry.
3. Each entry as a block sequence item, `  - id: <id>`, then its other present fields, each on
   its own line indented by 4 spaces, in the order of the table of Section 2.3, a list field as
   `<field>:` alone. An empty list and an absent optional field are not written.
4. Each item of a list of strings as `- <item>` on its own line indented by 6 spaces.
5. Each history item as a block mapping: `      - date: <date>`, then `op: <op>`, then each
   operand as `<key>: <value>` in the order of the table of Section 2.4, each on its own line
   indented by 8 spaces; a list operand as `<key>:` alone, then each of its ids as `- <id>` on
   its own line indented by 10 spaces.
6. A string matching `^[A-Za-z0-9]([A-Za-z0-9 ._/-]*[A-Za-z0-9._/])?$` that the core schema
   does not resolve to a null, boolean, integer, or float is written plain; every other string
   is written as ECMAScript `JSON.stringify` writes it ([ECMA-262]), then with each character
   outside the printable set of [YAML 1.2.2], Section 5.1, written `\u` and four lowercase
   hexadecimal digits. When that text holds `\"` and no other `\`, the string is instead
   written single-quoted: `'`, the string with each `'` doubled, then `'`.
7. No other line is written: the input's comments, blank lines, and layout are not kept.

> Note (non-normative): with no flow collection and single quotes where they save escapes, oxfmt
> leaves a written terms file unchanged.

## 3. Prose

### 3.1 Parsing

When line 1 of a document is exactly `---` and a later line is exactly `---`, lines 1 through
the first such later line are front matter: they hold no prose, and the document is parsed as if
they were blank, so that line numbers stay. The document is parsed per [CommonMark] with the
tables extension of [GFM] (Section 4.10) and no other extension; a link destination is taken
as CommonMark gives it, without percent-decoding.

### 3.2 Prose runs

A prose block is a heading, a paragraph, or a table cell, wherever it is nested: list items and
block quotes hold paragraphs. Code blocks, HTML blocks, link reference definitions, front
matter, and the cells of the `Term` and `Avoid or distinguish` columns of a thesaurus table
(Section 6.8) hold no prose block. Each prose block gives one prose run: a sequence of
characters, each with the position (line and column) of its source text, and barriers. Its
inline content contributes, in order:

| Inline content                                     | Contributes                                                                  |
| -------------------------------------------------- | ---------------------------------------------------------------------------- |
| Text                                               | its characters                                                               |
| A backslash escape                                 | the escaped character, at the backslash's position                           |
| An entity or numeric character reference           | the characters it decodes to, at the reference's position                    |
| Emphasis, strong emphasis, the link text of a link | what its content contributes; its delimiters and brackets contribute nothing |
| A soft or hard line break                          | one space                                                                    |
| A code span, raw HTML, an autolink, an image       | one barrier                                                                  |

The space of a line break has no position: no occurrence starts or ends with a space, so no
output reports one. A link destination, a link title, and a link label contribute nothing.
Prose is the characters of the prose runs of the documents.

### 3.3 Suppression comments

A suppression comment is an HTML comment whose text between `<!--` and `-->`, with leading and
trailing white space removed, is `terms-ignore` or starts with `terms-ignore` followed by white
space, and that is either raw HTML inside a prose block or the whole of an HTML block, leading
and trailing white space aside. Its target line is the line on which it starts when it is raw
HTML. Otherwise its target is the first nonblank line after the last line of its HTML block,
where a blank line holds only white space (Section 4.1) after removing the markers of the
comment's enclosing block quotes; it has no target when no such line exists. A valid comment
with no target suppresses nothing and gives no S001 finding.

A suppression comment is valid when that text matches the ECMAScript regular expression
([ECMA-262]) `^terms-ignore[ \t]+(P001|P002):[ \t]+\S` and is one line. A valid suppression
comment suppresses the findings of its code whose occurrence starts on its target line; one
comment suppresses one code on one line. An invalid one suppresses nothing and gives an S001
finding (Section 5.3).

For example, a standalone `<!-- terms-ignore P001: quoted legacy wording -->` on line 1,
blank lines 2 and 3, and prose on line 4 targets line 4. If only blank lines follow the
comment, it has no target. Another nonblank comment or a code-block line is not skipped.

## 4. Matching

### 4.1 Phrases

A word character is a character of Unicode general category L, M, or N ([Unicode], Section
4.5); white space is a character with the Unicode property White_Space ([Unicode], Section 4.6).
A string is normalised by replacing each maximal run of white space with one space and removing
leading and trailing white space. The last word of a phrase is its last maximal run of word
characters.

The plural of a phrase whose last character is a letter (category L) is the phrase with its last
word changed by the first rule that applies, letters compared exactly:

1. The word ends with `s`, `x`, `z`, `ch`, or `sh`: `es` is appended.
2. The word ends with `y` after a letter other than `a`, `e`, `i`, `o`, and `u`: the `y` is
   replaced by `ies`.
3. Otherwise `s` is appended.

A phrase whose last character is not a letter has no plural. The capitalised variant of a string
whose first character is of category Ll is the string with that character replaced by the result
of ECMAScript `String.prototype.toUpperCase` on it ([ECMA-262]); any other string has none. A
possessive needs no variant: an apostrophe is not a word character, so the phrase or its plural
ends before it.

The variants of an entry that passes Section 2 are these normalised strings, each recording the
entry, its kind, and whether it is plural and whether it is capitalised:

| Source                                    | Kind         | Variants                                                    |
| ----------------------------------------- | ------------ | ----------------------------------------------------------- |
| `label` of an active entry                | `label`      | the label, its plural, and the capitalised variant of each  |
| each `forms` phrase of an active entry    | `form`       | the phrase and its capitalised variant                      |
| `label` of a deprecated entry             | `deprecated` | the label, its plural, and the capitalised variant of each  |
| each `forms` phrase of a deprecated entry | `deprecated` | the phrase and its capitalised variant                      |
| each `reject` phrase of an active entry   | `reject`     | the phrase, its plural, and the capitalised variant of each |

The reject phrases of a deprecated entry give no variant.

### 4.2 Occurrences

An occurrence is a place in a prose run where a variant is found. Each prose run is scanned from
its first character. At a position `i`, a variant `v` is found when, from `i`:

- the run's characters spell `v`, a maximal run of white space in the prose run matching one
  space of `v`, with no barrier in between;
- when the first character of `v` is a word character, the character before `i` is not a word
  character, a barrier and the start of the run counting as not one;
- when the last character of `v` is a word character, the character after the spelled text is
  not a word character, a barrier and the end of the run counting as not one.

When at least one variant is found at `i`, the one that comes first in this order gives an
occurrence and the scan continues after the spelled text: the longer spelled text first, in
UTF-16 code units; then kind `label` or `form` before kind `deprecated`; then not capitalised
before capitalised; then not plural before plural; then
kind `label`, `form`, `deprecated`, `reject`; then ascending entry `id`. Otherwise the scan
continues at `i` + 1. An occurrence starts at the position of its first character; its source
text is the document text from the start of its first character's source to the end of its last
character's source.

### 4.3 Uses

A document uses an active entry when it has an occurrence of kind `label` or `form` of that
entry, or a code span whose entire content, as CommonMark decodes it and then normalised per
Section 4.1, equals its normalised label or a normalised `forms` phrase, or the capitalised
variant of either (Section 4.1). A derived plural alone does not count unless listed in `forms`.
Every matching active entry counts
as used; the occurrence tie-break of Section 4.2 does not select between code-span matches.
Code spans are considered wherever inline content is parsed under Section 3.1, including the
thesaurus cells excluded from prose runs, but not in front matter, HTML blocks, code blocks,
or image descriptions. Substring matches do not count: a code span `Terms` uses the label
`Terms`, but a code span `run Terms now` does not use the label `Terms`.
Suppression comments do not change uses.

Code-span uses count only for T005 and T006 (including the `local` rules) in Section 5.2. A
code span remains a barrier under Section 3.2: it gives no occurrence, so no prose finding
and no edit list item. For T006 an available external owner text is parsed
and tested for use by these same rules without becoming a document.

## 5. Checks

### 5.1 Findings

A finding is one reported problem: a workspace path, a line, a column, a code, and a message.
Its text is `<path>:<line>:<column> <code> <message>`. In a message, `"<x>"` is the value as
ECMAScript `JSON.stringify` writes it ([ECMA-262]). Findings are ordered by path, then line,
then column, then code, then message, each ascending by UTF-16 code units or numerically. Every
finding has the same weight: there is no severity level.

The file checks are those of Section 5.2; the prose checks of a document are those of Section
5.3 for that document. The check of a workspace gives the findings of the file checks and of the
prose checks of every document, ordered, with every finding a valid suppression comment
suppresses left out.

### 5.2 File checks

A file check finding has the path `.pi/pi-dent/terms.yaml`. `<id>` is the concerned entry's `id`. A
T001 finding concerns the entry its `<value path>` is or lies under, left in or not. Any other
finding concerns the entry `<id>` and every entry its message names. A finding is placed at the
start of a YAML node: for T001, the node its `<value path>` names, or line 1, column 1 for `(file)`
except that a syntax error is placed where the parser reports it; for T002, the label or `forms` item `<p>`;
for T003, the item `<x>`, the item naming the entry itself, the `owner` value, or the
`replacedBy` value of a cycle; for T004, the value of the `reason` or `<field>` its message
names, else the entry; for T005, the `label` value; for T006, the `owner` value.

| Code | Condition                                                                                                                                                                                                            | Message                                                        |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| T001 | A violation of Section 2                                                                                                                                                                                             | `<value path>: <reason>`                                       |
| T002 | The normalised label or a normalised `forms` phrase `<p>` of an active entry equals the normalised label or a normalised `forms` phrase of another entry `<other>` that is deprecated, or active with a smaller `id` | `<id>: "<p>" is also a label or form of <other>`               |
| T002 | The normalised label or a normalised `forms` phrase `<p>` of an active entry equals a normalised `reject` phrase of an active entry `<other>`, itself included                                                       | `<id>: "<p>" is a reject phrase of <other>`                    |
| T003 | An id `<x>` in the entry's `<field>`, `distinguish` or `replacedBy`, is not an existing id                                                                                                                           | `<id>: <field> names <x>, which is not an entry`               |
| T003 | The entry's `distinguish` or `replacedBy` holds its own `id`                                                                                                                                                         | `<id>: <field> names the entry itself`                         |
| T003 | The `owner` of an active entry is internal and is not a document                                                                                                                                                     | `<id>: owner <owner> is not a document`                        |
| T003 | The entry has the smallest `id` of its cycle set, when that set holds two or more entries                                                                                                                            | `<id>: replacedBy cycle through <ids>`                         |
| T004 | A deprecated entry has no `reason`                                                                                                                                                                                   | `<id>: deprecated without a reason`                            |
| T004 | A deprecated entry with `reason` `merged` or `renamed` has other than exactly one replacement                                                                                                                        | `<id>: reason <reason> needs exactly one replacement, has <n>` |
| T004 | A deprecated entry with `reason` `split` has fewer than two replacements                                                                                                                                             | `<id>: reason split needs at least two replacements, has <n>`  |
| T004 | A deprecated entry with `reason` `out-of-scope` has a replacement                                                                                                                                                    | `<id>: reason out-of-scope takes no replacement, has <n>`      |
| T004 | An active entry has `reason` or a replacement                                                                                                                                                                        | `<id>: <field> is set on an active entry`                      |
| T005 | An active entry with `key` `shared` or `confusable` is used by no document                                                                                                                                           | `<id>: "<label>" is used by no document`                       |
| T005 | An active entry with `key` `shared` is used by exactly one document                                                                                                                                                  | `<id>: "<label>" is shared but used only by <path>`            |
| T005 | An active entry with `key` `local` is used by a document `<path>` other than its owner (one finding per such document)                                                                                               | `<id>: "<label>" is local but used by <path>`                  |
| T006 | An active entry's owner text is available from its document or its supplied external owner text, and that text does not use the entry                                                                                | `<id>: owner <owner> does not use "<label>"`                   |

`<value path>` names the concerned value from the root, mapping keys joined by `.` and sequence
positions written `[<i>]` from 0, such as `terms[3].label`; it is `(root)` for the root value
itself, and `(file)` for a failure of Section 2.1. `<reason>` is:

| Violation                                                                                                  | `<value path>`      | `<reason>`                    |
| ---------------------------------------------------------------------------------------------------------- | ------------------- | ----------------------------- |
| The bytes are not valid UTF-8                                                                              | `(file)`            | `not valid UTF-8`             |
| The text does not parse                                                                                    | `(file)`            | the parser's message          |
| The text holds `<n>` YAML documents, `<n>` other than 1                                                    | `(file)`            | `holds <n> YAML documents`    |
| A mapping has a duplicate key                                                                              | `(file)`            | `duplicate key`               |
| A required key `<key>` is absent                                                                           | the object          | `missing <key>`               |
| An object has unknown keys                                                                                 | the object          | `unknown keys <keys>`         |
| A value does not have its type                                                                             | the value           | `must be <type>`              |
| A list holds a phrase or id `<x>` that an earlier item holds (`<x>` is the later item's string as written) | the later item      | `repeats "<x>"`               |
| `history` holds no item                                                                                    | the `history` value | `must hold at least one item` |
| An `id` is not greater than the last string `id` `<p>` before it                                           | the `id` value      | `must come after <p>`         |

`<keys>` are the unknown keys as `"<x>"`, in source order, joined by `, `. `<type>` is, for the
type that Section 2.2, 2.3, or 2.4 gives the value: `a mapping`, `a sequence`, `true or false`,
`a string`, `an id matching ^[a-z0-9]+(-[a-z0-9]+)*$`,
`a phrase (one trimmed line holding a letter, mark, or digit)`, `one non-empty line`,
`a workspace path ending with .md`, `an owner path ending with .md`, `a date YYYY-MM-DD`, or,
for an enumeration, `one of ` and its values in table order joined by `, `.

An external owner gives no T003 owner finding, whether or not its text is available. T006
skips an unavailable external owner. External owner use does not count toward T005's document
counts. A `local` entry used by no document gives no zero-use T005: only T006 applies when its
owner text is available and does not use it (or T003 when its internal owner is not a document).
The `local` constraints give no P findings; use outside the owner is reported only by T005.
For example, a `local` entry with an available owner that does not use it and two nonowner
documents that do use it gives two local T005 findings and one T006. With no uses anywhere it
gives only T006; with only an unavailable external owner and no document uses it gives neither.

> Note (non-normative): a left-out entry's id is an existing id, so a reference to it gives no
> T003 finding.

The cycle set of an entry is the set of entries it reaches by following `replacedBy` ids one or
more times and that reach it back the same way; `<ids>` are their ids in ascending order, joined
by `, `. An entry left out under Section 2.3 gives no finding other than T001.

### 5.3 Prose checks

A prose check finding has the document's path and the start position of its occurrence or
suppression comment. `<text>` is the spelled prose text of the occurrence, normalised.

| Code | Condition                               | Message                                                                         |
| ---- | --------------------------------------- | ------------------------------------------------------------------------------- |
| P001 | An occurrence of kind `reject`          | `"<text>" is rejected: use "<label>" (<id>)`                                    |
| P002 | An occurrence of kind `deprecated`      | `"<text>" is deprecated (<reason>)<replacement>`                                |
| S001 | A suppression comment that is not valid | `terms-ignore needs one code, P001 or P002, a colon, and a reason, on one line` |

In P001, `<label>` and `<id>` are those of the entry whose reject phrase gave the variant. In
P002, `<reason>` is the entry's `reason`, or `none` when it has none, and `<replacement>` is
empty when it has no replacement, else `: use ` followed by `"<label>" (<id>)` for each
replacement in `replacedBy` order, or `<id>` alone for an id that names no entry left in under
Section 2.3, joined by a space, `or`, and a space.

### 5.4 Change checks

A change set describes how the workspace differs from an earlier state of it, its base
workspace, as a list of changes; a change is one item of a change set. The caller supplies it:
the library takes no revision and runs no Git command. Each change has these fields:

| Field    | Type                     | Contract                                                                          |
| -------- | ------------------------ | --------------------------------------------------------------------------------- |
| `path`   | workspace path           | The changed file's path in the workspace.                                         |
| `before` | string or null           | The file's text in the base workspace; null when it has no file at the base path. |
| `from`   | workspace path, optional | The file's path in the base workspace when it was moved; absent means `path`.     |

A change's base path is its `from`, else its `path`. A change set is valid when each of these
conditions holds:

1. Every `path` and `from` is `.pi/pi-dent/terms.yaml` or a workspace path ending with `.md`.
2. A `from` is `.pi/pi-dent/terms.yaml` exactly when its change's `path` is.
3. A change with a `from` has a `before` that is not null.
4. No `before` holds a lone surrogate.
5. No two changes have the same `path`.
6. No two changes have the same base path.

An empty change set is valid. [terms-tool.md](terms-tool.md), Section 1.2, rejects an invalid
one. A file that no change lists is the same in the base workspace as in the workspace, so its
changes introduce nothing.

The base workspace is the workspace with each change undone:

1. Its documents are the workspace's documents without those at a change's `path` or base path,
   plus, for each change whose base path ends with `.md` and whose `before` is not null and holds
   no U+0000, a document at the base path whose text is `before` without a leading U+FEFF.
2. Its terms file is, when a change has the `path` `.pi/pi-dent/terms.yaml`, that change's `before`
   encoded as UTF-8, or none when it is null; otherwise the workspace's terms file.
3. Its external owner texts are the workspace's.

The lines of a text are its parts between line endings (Section 1.2); an empty part after the
last line ending is not a line, and the empty text has none. The base text of a change is its
`before` without a leading U+FEFF, the empty text when `before` is null; its current text is the
text of the document or the terms file at its `path`, decoded as UTF-8 without a leading U+FEFF,
the empty text when there is none or the bytes are not valid UTF-8.

The line pairing of a change is the longest list of pairs `(i, j)` of a line number of its base
text and a line number of its current text, both ascending, whose lines are equal as UTF-16 code
unit sequences; among several such lists, the one whose sequence `i1, j1, i2, j2, …` is
smallest, compared item by item. For example, base lines `x`, `y` and current lines `y`, `x`
give the one pair `(1, 2)`, so current line 1 is a changed line. A changed line is a line of a current text that is in no pair. The
pairs split the line numbers of each text into regions: those before the first pair, those
between two consecutive pairs, and those after the last pair, the last region of each text
also holding every line number past its last line. With no pair, each text has one region holding all its line numbers. A region of the current
text and the region of the base text between the same pairs correspond.

The base lines of a finding of the workspace in the file at a change's `path` are, when its line
is in a pair, the base line of that pair, else the lines of the base region that corresponds to
the region holding its line; its base path is the change's base path. For a finding in any other
file, its base path is its path and its base lines are its line. Findings with the same base
path, base lines, code, and message form a group. The base count of a group is the number of
findings of the check of the base workspace (Section 5.1) at its base path, on one of its base
lines, with its code and message; a base workspace without a terms file gives no findings. The
introduced findings of a change set are, of each group, the findings of the check of the
workspace after the first `<base count>` in finding order, in the order of Section 5.1.

> Note (non-normative): a finding on an edited line is compared with the base findings of the
> lines that edit replaced. A line moved across an unchanged line leaves its region, so its
> findings are introduced, as is a finding whose message names a moved document's path.

The label occurrences in changed lines of a change set are the occurrences of kind `label` or
`form` (a form counting as its entry's label) in a document at a change's `path` that start on a
changed line. Each is the entry's
`id`, `label`, and `meaning`, the document's path, the occurrence's line and column, and its
source text normalised (Section 4.1). They are ordered by `id`, then path, line, and column;
suppression comments do not change them.

## 6. Operations

### 6.1 Common rules

An operation is one of `add`, `update`, `rename`, `merge`, `split`, `deprecate`, `reown`, and `import`.
It takes the terms file's bytes, absent when there is no terms file, the documents,
the date as a calendar date of [ISO 8601], and its parameters, and
gives either a refusal text or the new terms file text, in canonical form (Section 2.5), together with an edit list. An operation MUST
NOT remove an entry, change an `id`, or change any entry other than those its section names. It
MUST append, to each entry it changes, one history item with the given date, the operation's
name as `op`, and the operands of Section 2.4. Every string parameter other than `owner` and
`path`, and every string of a list parameter, is normalised (Section 4.1) before use; `owner`
and `path` are used with leading and trailing white space removed.

An operation MUST refuse, with the text of the first that applies, when:

1. the terms file is absent and the operation is neither `add` nor `import`:
   `no terms file at .pi/pi-dent/terms.yaml`;
2. the terms file gives a T001 finding:
   `.pi/pi-dent/terms.yaml has T001 findings; fix them first: <finding text>`, with the first
   such finding;
3. an id `<x>` of a parameter that the operation's section says names an active entry, taken in
   parameter order and then list order, is no entry's `id`: `no entry <x>`, or names a
   deprecated entry: `<x> is deprecated`; then a refusal of the operation's own section, in the
   order listed there;
4. the new terms file gives a T001, T002, T003, or T004 finding that concerns (Section 5.2) an
   entry the operation changed: `<operation> refused: <finding text>`, with the first such
   finding.

The edit list holds the occurrences that the operation's section names, in the new terms
file's matching, ordered by path, line, and column, without an occurrence of kind `reject` that
a valid P001 suppression comment suppresses or one of kind `deprecated` that a valid P002
suppression comment suppresses. Each item is the occurrence's path, line, column, source text as
`old`, and a suggested text as `new`, or none:

- for an occurrence of kind `reject` of entry `E`, the label of `E`;
- for an occurrence of kind `deprecated` whose entry has exactly one replacement, that
  replacement is an entry, and whose variant did not come from a `forms` phrase, its label;
- for any other occurrence, and for one whose variant came from a `forms` phrase, none.

A suggested label is turned into its plural when the occurrence's variant is plural, none being
suggested when it has no plural, and then into its capitalised variant when the occurrence's
variant is capitalised and the label has one. An operation MUST NOT change a document.

### 6.2 `add`

Parameters: `id`, `label`, `meaning`, `owner`, `group`, `key`, and optionally `reject`,
`distinguish`, and `forms`. Refusal: `<id> is already an entry` when an entry has the `id`.
When the terms file is absent, the input is a terms file without settings and entries. The
operation inserts an active entry with these fields at its place in `id` order. The edit list
holds the occurrences of kind `reject` of the new entry.

### 6.3 `rename`

Parameters: `id`, naming an active entry, `label`, and optionally `forms`. Refusal:
`<id> is already labelled "<label>"` when `label` equals the entry's label after normalisation. The operation
appends the old label, then each old `forms` phrase, to the entry's `reject`, leaving out a
phrase already there, the new label, and each phrase of the new `forms`; removes the new label
and each phrase of the new `forms` from `reject`; sets `label`; and sets `forms` to the
parameter, or removes it when the parameter is absent; phrases are compared normalised. The edit
list holds the occurrences of kind `reject` of the entry whose variant came from a phrase this
operation appended; one whose phrase was an old `forms` phrase has no suggested text. The old label is the entry's
`label` as written, not normalised: the phrase it appends to `reject`, the `from` operand of its
history item, and the old label of the summary are that text.

### 6.4 `merge`

Parameters: `id` and `into`, each naming an active entry. Refusal:
`cannot merge <id> into itself` when they are equal. The operation sets the entry `id` to
`status` `deprecated`, `reason` `merged`, and `replacedBy` `[into]`; appends its `reject`
phrases to the `reject` of `into`, leaving out a phrase already there; and removes `reject` from
`id`. The
history item on `id` has the operand `into`, the one on `into` the operand `from`. The edit list
holds the occurrences of kind `deprecated` of `id` and of kind `reject` of `into` whose variant
came from a phrase this operation moved.

### 6.5 `split`

Parameters: `id`, naming an active entry, and `into`, a list of ids, each naming an active
entry. The operation sets the entry `id` to `status` `deprecated`, `reason` `split`, and
`replacedBy` the list. The history item on `id` has the operand `into`, the one on each listed
entry the operand `from`; a list of fewer than two ids, or one naming `id`, gives the finding of
refusal 4 of Section 6.1. The edit list holds the occurrences of kind `deprecated` of `id`; none
has a suggested text.

### 6.6 `deprecate`

Parameters: `id`, naming an active entry, `reason`, either `renamed` or `out-of-scope`, and
optionally `replacedBy`, a list of ids, each naming an active entry. The operation sets the
entry to `status` `deprecated` with the `reason` and, when given, the `replacedBy`. With exactly
one replacement, it also moves the entry's `reject` phrases to the replacement as `merge` does, and
appends a history item with the operand `from` to the replacement. A replacement count the
reason does not admit gives the finding of refusal 4 of Section 6.1. The edit list holds the
occurrences of kind `deprecated` of `id` and of kind `reject` of the replacement whose variant
came from a phrase this operation moved.

### 6.7 `reown`

Parameters: `id`, naming an active entry, and `owner`. Refusal:
`<id> is already owned by <owner>` when `owner` equals the entry's `owner`. The operation sets
`owner`. The edit list is empty.

### 6.8 `import`

`import` builds the entries of an empty terms file from a thesaurus table of one document.
Parameter: `path`. Refusals, in order:

1. `import needs a terms file without entries; .pi/pi-dent/terms.yaml has <n>` when the terms
   file has at least one entry;
2. `<path> is not a document` when `path` is not a document;
3. `<path> has no thesaurus table` when the document has no thesaurus table;
4. `<path>:<line>: <problem>` for the first row, in document order, that has a problem of this
   list, with the row's line and the first of its problems in list order: `the Term cell is
   empty`, `the label gives no id`, `no heading precedes the table`, `the Owner cell gives no
   owner path`.

A thesaurus table is a table of the document whose header cells, as cell texts, are exactly
`Term`, `Meaning`, `Owner`, and `Avoid or distinguish`, in this order. The cell text of a cell is
its inline content as plain text, normalised: the characters a prose run gets (Section 3.2),
with the content of a code span and the description of an image in place of their barriers and
raw HTML and autolinks contributing nothing. Each body row of every thesaurus table, in
document order, gives one active entry, the entries placed in ascending `id` order:

| Field         | Value                                                                                                                                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `label`       | The Term cell text.                                                                                                                                                                                                                                          |
| `id`          | The label in ECMAScript lower case, each maximal run of characters other than `a`–`z` and `0`–`9` replaced by `-`, leading and trailing `-` removed; when an earlier row gave the same id, `-<n>` appended with the smallest `n` from 2 that gives a new id. |
| `meaning`     | The Meaning cell text.                                                                                                                                                                                                                                       |
| `owner`       | The row's owner path.                                                                                                                                                                                                                                        |
| `group`       | The heading text, as plain text like a cell text, of the last heading before the table.                                                                                                                                                                      |
| `key`         | Derived by the rule below.                                                                                                                                                                                                                                   |
| `distinguish` | The id of each other row whose label equals an item of the row, without repeats, in item order.                                                                                                                                                              |
| `history`     | One item with `op` `import` and the operand `from` set to `path`.                                                                                                                                                                                            |

The operation MUST set an imported entry's `key` to `local` when its owner is a workspace
document and the set of workspace documents that use the entry (Section 4.3), computed in the
proposed file's matching, is exactly that owner. Otherwise it MUST set `key` to `shared`;
an external owner always gives `shared`. The operation also gives the ids assigned `local`,
in ascending `id` order, an empty list when none qualify.

The owner path of a row is the destination of the first link other than an autolink in its Owner cell, else the Owner
cell text, without the part from its first `#`, joined with `/` to the directory of `path`, or
alone when that directory is the workspace root, then with each `.` segment removed and each
`..` segment removed together with the segment before it when that preceding segment is not
`..`; leading `..` segments are retained. The Owner cell gives no owner path when that
destination or text, before the join, is empty, starts with `/`, or holds a `:` before its first
`/` (or has no `/`); or when the resulting path is not an owner path (Section 1.2).
For example, from `specs/thesaurus.md`, `../../other/specs/host.md#rule` gives the external owner
`../other/specs/host.md`, retaining its leading `../`.

The items of a row are the parts of its Avoid or distinguish cell text split at `;`, each
normalised, empty parts left out. Every item that does not give a `distinguish` id is a reject
candidate of the row's entry. The operation keeps the input's `settings`. Its edit list is empty;
it also gives its reject candidates as pairs of entry id and item, in row order and then item
order.

> Note (non-normative): whether an item names a specific phrase or an ordinary word is a
> judgement; the candidates are returned for the agent to add with `update`'s `addReject` or drop.

### 6.9 `update`

Parameters: `id`, naming an active entry, or any entry when `status` is given, and optionally
`status`, `key`, `meaning`, `addReject`, `removeReject`, `addDistinguish`, and
`removeDistinguish`. `status` takes the one value `active`; `key` takes the values of Section 2.3;
`meaning` is a string, normalised (Section 6.1) and compared with the stored meaning as written;
the other parameters are string arrays, empty when absent. Reject operands are phrases and
distinguish operands are ids; they are compared after Section 4.1 normalisation, including
against stored strings.
An unchanged `status`, `key`, or `meaning` is allowed alongside another effective change. Empty arrays do
nothing.

After refusals 1 to 3 of Section 6.1, the operation MUST refuse in this order (lists are
scanned in their input order). In these texts `<field>` is the parameter name, `<other>` is
the distinguish operand, and `"<value>"` and `"<phrase>"` are the normalised operand as
ECMAScript `JSON.stringify` writes it:

1. For each list in parameter order `addReject`, `removeReject`, `addDistinguish`,
   `removeDistinguish`, a repeated normalised value: `<field> repeats "<value>"`.
2. A value in both reject lists, in `addReject` order:
   `update cannot add and remove reject "<phrase>"`; then a value in both distinguish lists,
   in `addDistinguish` order: `update cannot add and remove distinguish <other>`.
3. A `removeReject` phrase absent from the entry's `reject`:
   `<id> does not reject "<phrase>"`; then an `addReject` phrase already present:
   `<id> already rejects "<phrase>"`.
4. For each id in `addDistinguish`, then `removeDistinguish`, an unknown id:
   `no entry <other>`; or the entry's own id:
   `cannot distinguish <id> from itself`. A distinguish target can be active or deprecated.
5. A `removeDistinguish` id not in the distinguish relation with `id`:
   `<id> is not distinguished from <other>`; then an `addDistinguish` id already in that
   relation: `<id> is already distinguished from <other>`. Presence on either side counts.
6. No effective change (all list parameters are empty, and `status`, `key`, and `meaning` are
   each absent or unchanged):
   `update makes no changes to <id>`.

When `status` is given and the entry is deprecated, the operation sets its `status` to `active`
and removes its `reason` and `replacedBy`; phrases an earlier operation moved from its `reject`
are not moved back. The operation sets `key` and `meaning` when given, removes the `removeReject` phrases, and appends
`addReject` phrases in input order. It removes each `removeDistinguish` relation from both entries'
lists and adds each `addDistinguish` relation to both entries' lists, appending in input order. It
preserves the order and spelling of all retained list items. It changes only the entry named by `id`
and entries named by distinguish operands. An entry is changed when its stored `status`, `key`,
`meaning`, `reject`, or `distinguish` changes, before adding history. Each such entry gets exactly
one `update` history item: with the operand `meaning`, the stored meaning before the operation as
written, when its meaning changed, and the operand `status`, `deprecated`, when its status
changed; otherwise with no operands, including an entry changed only by a reciprocal
distinguish edit. Removing a relation stored only on the other entry changes only that other entry;
it does not append history to an unchanged entry named by `id`.

The proposed file is subject to Section 6.1's refusal 4, after the refusals above; failure
writes nothing and gives no edit list. The edit list holds the occurrences of kind `reject`
of `id` whose variant came from a phrase in `addReject`, using the new file's matching.

For example, `update` with `id: rendered-view`, `key: local`, and
`addReject: [rendering-view]` changes the key and appends that reject phrase, records one
history item with `op: update`, and lists matching prose occurrences of
`rendering-view`, not code spans. An update containing only the already-current key is refused.
An `update` of `rendered-view` with a new `meaning` sets it and records one `update` history
item whose `meaning` is the old text.

> Note (non-normative): a changed meaning keeps the label, for a concept that widens or is
> described better. A concept that becomes a different one is a `split` or a `deprecate`.

## 7. Normative references

- [CommonMark] CommonMark Spec, version 0.31.2 (2024-01-28), J. MacFarlane: Section 2.1
  (characters and lines), Section 4 (leaf blocks), Section 5 (container blocks), and Section 6
  (inlines).
- [GFM] GitHub Flavored Markdown Spec, version 0.29-gfm (2019-04-06): Section 4.10 (tables
  extension).
- [YAML 1.2.2] YAML Ain't Markup Language, version 1.2.2 (2021-10-01): the syntax of the terms
  file, Section 5.1 (character set), and Section 10.3 (core schema).
- [Unicode] The Unicode Standard, Version 15.1.0: Section 4.5 (General Category) and Section 4.6
  with Unicode Standard Annex #44 (the White_Space property).
- [ECMA-262] ECMAScript Language Specification, 14th edition (June 2023), Ecma International:
  regular expressions, `String.prototype.toLowerCase`, `String.prototype.toUpperCase`, and
  `JSON.stringify`.
- [ISO 8601] ISO 8601-1:2019, Date and time — Representations for information interchange —
  Part 1: Basic rules: the calendar date, complete representation, extended format.

## 8. Specification gaps

- Whether a `reject` phrase is a specific phrase or an ordinary word, whether a `label` is in
  base form, and whether a `meaning` is one sentence are not checked.
- An `id` removed from the terms file by hand cannot be told from one never used, so its reuse
  is not detected.
- Text in another Unicode normalisation form than the phrase it spells does not match it.
- A hyphen is not a word character: `workspace` is found in `workspace-relative`.
- A label written in upper case throughout, as in a heading set in capitals, is not found; nor is
  a sentence-initial capitalised word attributed to a lowercase label when an active entry's
  label, or a reject phrase, is that capitalised word.
- The plural rules derive wrong plurals for some words; only `forms` adds the right ones.
- A suggested text replaces the whole source text of an occurrence, emphasis delimiters and
  line breaks inside it included.
- A `terms-ignore` comment inside an HTML block holding more than the comment is neither a
  suppression comment nor a finding.
- Which line and column a YAML parser reports for a syntax error, and its message, are not
  specified.
- A change to an external owner file cannot be expressed in a change set: the base workspace
  has the workspace's external owner texts.
- A file copied with `from` while its source stays shares its source's base findings: of each
  group only the findings past the base count are introduced, chosen in finding order, so one of
  the two copies of an old finding is reported; a copy written as a change without `from` gives
  each its own.
- A file moved to a new path while a new file takes its old path cannot be written as a move: the
  base paths repeat. Writing both as changes without `from` expresses it.
- The `reject` phrases of an entry deprecated by `split` or with `reason` `out-of-scope` give no
  variant, so they are no longer reported.
- A plural or capitalised variant of one entry that spells a variant of another entry is not
  reported.
- A file `git ls-files` lists but that cannot be read, or is not UTF-8, is not a document and is
  not reported.
- The version of Git whose `ls-files` and `rev-parse` behaviour Section 1 relies on is not
  specified.
- The names the library exports are not specified.
- An external owner whose file is missing or unreadable gives no finding, so a wrong external
  owner path is not reported.
- An external owner path pointing back into the workspace is not recognised as an alias of
  its workspace document path; a `local` entry's use there gives T005.
