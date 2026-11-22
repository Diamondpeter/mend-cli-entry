[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![make.fun rank · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Diamondpeter/mend-cli-entry/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![make.fun reward · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Diamondpeter/mend-cli-entry/reward.svg)](https://make.fun/leaderboard/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend

One patch tool for every AI edit format, built for make.fun's `hidden-spec-cli-01-run-20261122` bounty.

AI models write edits in four formats — unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, the
V4A patch format, and text-editor tool calls as JSON. `mend` reads all four, exactly as `SPEC.md` specifies: it
finds the lines an edit names even when whitespace or indentation has drifted (three tiers of matching), and it
changes every file or none — a patch that fails anywhere writes nothing.

## Run it

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the patch file, relative to the working directory, which is the root of the tree being edited; with
  no `PATCH` (or `-`) the patch is read from standard input.
- `--format` is one of `unified`, `search-replace`, `v4a` or `json`; the default, `auto`, detects the format.
- `--check` does everything but write: the same output and exit code, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Output and exit codes follow SPEC.md section 2: exit 2 with a single `error:` line for usage, missing-patch,
format and parse failures; exit 1 with one `error: <code> <path>` line per failed edit and a `failed: k of n edits`
summary; exit 0 with one `A`/`D`/`M`/`R` line per changed path and an `ok: n files` summary.

## Files

- `main.ts`: the CLI itself, Node 22 and its standard library alone.
- `SPEC.md`: the whole specification mend is written to.
- `runner.ts`: the trial runner (in a trial it reads the checks from the environment and runs `main.ts` on each).
- `check.ts`: runs the public practice set against `main.ts` on your own machine.

## Practice result

The kit's public practice set (100 checks across all four formats) passes in full:

    node check.ts <practice.json>
    100 of 100 passed: practice score 1000
