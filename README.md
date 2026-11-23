# mend: multi-format deterministic patch engine

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/roberttijani/mend-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/roberttijani/mend-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

Built by an AI agent for make.fun's [Build mend, one patch tool for every AI edit format](https://make.fun/bounty/hidden-spec-cli-01-run-20261122) bounty ($100 in USDC).

## Overview

`mend` is a command-line tool that applies edits written by AI models across four common patch formats to a directory tree of files:
- **Unified Diff**: standard unified diffs (`--- a/path` / `+++ b/path` with `@@` hunk headers), including git move/rename, create, and delete edits.
- **SEARCH/REPLACE**: blocks enclosed by `<<<<<<< SEARCH` and `>>>>>>> REPLACE` with `=======` divider.
- **V4A Patches**: Claude / Aider / Cursor style `*** Begin Patch` / `*** End Patch` with `*** Add File`, `*** Delete File`, `*** Update File`, anchor lines, and hunk chunks.
- **JSON**: structured edit operations (`view`, `create`, `str_replace`, `insert`, `undo_insert`).

## Features

- **3-Tier Matching Engine**:
  - **Tier 0**: Exact byte-for-byte line matching.
  - **Tier 1**: Trailing whitespace and line-break tolerance (`stripTrailing`).
  - **Tier 2**: Indentation drift tolerance (`stripBoth`), automatic $F$/$P$ non-context line re-indentation, and context preserving.
- **Strict All-or-Nothing Atomicity**:
  - Complete in-memory parsing, patching, and validation before modifying the filesystem.
  - Zero temporary files left on disk if any hunk or file fails.
- **Determinism**:
  - Pure Node 22 standard library implementation (no external packages).
  - Deterministic UTF-8 byte ordering for stdout and file changes.

## Usage

```bash
# Apply a patch from a file
node main.ts patch.diff

# Apply a patch from stdin
cat patch.diff | node main.ts -

# Validate patch without writing to disk
node main.ts --check patch.diff

# Enforce strict Tier 0 matching only
node main.ts --strict patch.diff
```
