# pi-dent-terms specifications

Write and review specs per the `dx:writing-specs` skill, which defines the requirement keywords and
the conformance rule. This file holds only this repository's differences from it.

## Specs

| Spec            | Subject                                                                |
| --------------- | ---------------------------------------------------------------------- |
| `terms.md`      | The terms file, prose, matching, checks, and operations (the resource) |
| `terms-tool.md` | The `Terms` tool and the after-edit check (the extension surface)      |

## Differences

- A resource spec is `<subject>.md`; the tool spec over it is `<subject>-tool.md`, which links the
  resource spec as its owning contract.
- pi-dent's specifications (pi-dent-agent `specs/`) may be cited, never linked, as owning contracts for what pi-dent
  provides. Configuration is a root key contributed to pi-dent's `config-file.md`, Section 2, whose
  unknown-key rule is the one policy; the terms file is workspace data, not configuration.
- A length or a column counted in characters counts UTF-16 code units; a duration shown in whole
  seconds is rounded down.
- The term registry is the `Terms` tool, storing `.pi/pi-dent/terms.yaml`.
