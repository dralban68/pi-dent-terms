# pi-dent-terms

A pi extension that manages a workspace's terms file — what each domain term means — and checks
the workspace's Markdown against it. pi-dent bundles it through its `pi.extensions`.

## What a session gets

- **`Terms` tool.** `find` looks an entry up by id, label, form, reject phrase, or meaning, with
  filters on status, key, group, and owner. `check` reports the workspace's findings. `add`,
  `update`, `rename`, `merge`, `split`, `deprecate`, `reown`, and `import` change the terms file.
  An operation writes the terms file and returns the document occurrences to edit; it never edits
  a document itself.
- **After-edit check.** When the host's `edit` or `write` tool changes a Markdown document, the
  extension appends that document's prose findings to the tool result, so a session sees its own
  rejected wording at once.

## Install

```sh
pi install npm:pi-dent-terms   # add it to pi's packages
pi -e npm:pi-dent-terms        # or try it for one run
```

Requires Node 26 or later, and a pi that provides the extension API
(`@earendil-works/pi-coding-agent`).

## The terms file

`.pi/pi-dent/terms.yaml` under the workspace root, the top level of the Git working tree. It holds
one entry per concept: its `id`, `label`, `meaning`, the `owner` document that defines it, its
`group`, its `key`, its `status`, and its `history`. Change it through the `Terms` tool: an
operation records the history item and keeps ids and references consistent. A hand edit loses
both.

## Findings

| Code      | What it reports                                                                                                                     |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| T001–T006 | Terms-file problems: syntax, duplicate labels, dangling ids, deprecation reasons, key use, and an owner that does not use its entry |
| P001–P002 | A rejected or deprecated phrase in prose                                                                                            |
| S001      | A `terms-ignore` comment that is not valid                                                                                          |

Silence one finding on one line with `<!-- terms-ignore P001: reason -->`.

## Configuration

`terms.checkAfterEdit` in pi-dent's configuration file sets the after-edit check for the user; a
workspace's `settings.checkAfterEdit` in its terms file overrides it. Without a terms file the
check is off. A bad value or an unknown key is reported as a `pi-dent-terms: <message>` warning
when the session starts.

## Documentation

- `specs/terms.md` — the terms file, matching, checks, and operations.
- `specs/terms-tool.md` — the `Terms` tool and the after-edit check.
- `docs/research/README.md` — the experiments behind the design.
- `AGENTS.md` — how to work on the repository.

## License

MIT, see `LICENSE`.
