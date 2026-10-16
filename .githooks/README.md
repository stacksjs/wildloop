# Git hooks

Tracked here rather than in `.git/hooks`, which git does not version. Turn
them on per clone:

```sh
bun run hooks:install    # points core.hooksPath at this directory
bun run hooks:uninstall  # unsets it
```

`git commit --no-verify` skips them for a work-in-progress commit.

Opt-in on purpose: a hook that refuses a commit is something a repository
should offer rather than impose, and more than one person pushes here.

## What `pre-commit` does

- **`bun run gate:stx`**, but only when a `.stx`, a shared `resources/functions`
  module, the gate script, or one of the configs it reads is staged. The gate
  scans the whole `resources/**` tree rather than the staged files, so running
  it on an unrelated commit costs a few seconds for nothing.
- **`pickier lint`** on staged `.js/.ts/.json/.yaml/.yml/.md`.

`.stx` is deliberately absent from that second list. pickier *discovers* `.stx`
— it is in the default extension list — but applies its JS rules only to
`.ts/.tsx/.js/.jsx`, so nothing inside a script block is checked. Measured on
16 Oct 2026: a `.stx` holding an unused variable and a `prefer-const` violation
reported clean, while the same two lines as `.ts` reported three errors. The stx
gate is what covers those files.

## What is not here

**`commit-msg`.** The `git-hooks` block in `package.json` names
`bunx gitlint --edit`, and `gitlint` does not resolve — `No version of
"gitlint" satisfying "latest" found`. A hook that always fails is worse than no
hook, so there is none; conventional commit messages stay a convention
(CLAUDE.md) rather than a gate.

That `git-hooks` block is also **inert**: nothing installs it. `.git/hooks` held
only samples, `core.hooksPath` was unset, and neither `bootstrap` nor any buddy
command writes a hook. It is left in place because it is the Stacks convention
and may be picked up by later tooling — but it has never run, which is worth
knowing before trusting that staged files were linted on the way in.
