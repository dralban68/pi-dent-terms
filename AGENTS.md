# pi-dent-terms

A pi extension that manages a workspace's terms file and checks its Markdown against it, through
the `Terms` tool and the after-edit check. pi-dent bundles it through its `pi.extensions`.

This repository follows the dx repo standard.

## Read first

| Document                                  | Holds, and when to read it                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------- |
| `specs/AGENTS.md`                         | The spec list and this repository's spec conventions — read before any spec     |
| pi-dent-agent `docs/pi-extension-repo.md` | The pinned pi release, loading and running — read before touching the toolchain |
| `docs/research/README.md`                 | Experiment findings behind design choices, non-normative                        |

## Commands

```sh
pnpm check        # the done-set: typecheck, lint, fmt:check, test
pnpm test
pnpm typecheck
pnpm lint
pnpm fmt          # rewrites files, Markdown included
pnpm fmt:check
pi -ne -e ./      # run pi with only this extension loaded
```

## Rules

- `index.ts` is wiring only; `lib/terms-file.ts`, `prose.ts`, `match.ts`, `checks.ts`,
  `operations.ts` and `import.ts` are the library and do no I/O; `workspace.ts`, `config.ts`,
  `tool.ts` and `after-edit.ts` are the extension.
- pi-dent-terms owns the names `.pi/pi-dent/terms.yaml`, `terms-ignore`, the check codes, the `Terms`
  tool, the configuration key `terms`, and the diagnostic prefix `pi-dent-terms:`; pi-dent owns
  `pi-dent.conf`, `~/.pi/pi-dent/`, and `PI_DENT_*`.
