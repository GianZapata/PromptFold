# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.3] - Unreleased

### Fixed

- A newly added file keeps its bytes in the Git diff: an empty file stays empty, a missing final newline stays missing, and intentional blank lines stay. Line endings are still normalized to LF. (#12)

## [1.0.2] - 2026-10-19

### Fixed

- Installs on editors based on VS Code 1.107, such as Antigravity.
- New files are included when `git.untrackedChanges` is `separate`, and conflicted files are included as modified.

### Added

- Publishing to Open VSX.

## [1.0.1] - 2026-10-19

### Fixed

- Git changes from the toolbar no longer says there are no repositories when the focused file is outside one. (#1)
- Previewing again in the same format shows the prompt for the current selection. (#2)
- The copy notice counts omitted folders from the current selection, not an earlier one. (#3)
- Changing the output format no longer writes it into the workspace settings. (#4)
- The size warning no longer shows two Cancel buttons on macOS. (#5)
- A generated file you check yourself is marked as included, `*.tsbuildinfo` stays out of bulk selection, and an empty Git selection says which repository had nothing to include. (#6)

## [1.0.0] - 2026-10-19

Initial release of Promptfold, based on Files2Prompt 1.8.0 by Thomas McKanna (MIT).

### Added

- Output formats: XML, Markdown and plain text, with Copy as…, Save as… and Copy as File….
- Git changes from one or several repositories: uncommitted, staged, one commit, or the current branch against a base.
- Token estimate in the status bar, tooltips and details, plus an optional `promptfold.tokenBudget` warning.
- Generated files (lockfiles, `*.min.js`, `*.min.css`, `*.map`) stay out of bulk selection. `promptfold.includeGenerated` brings them back.
- A tree of the selected files at the top of the prompt (`promptfold.includeTree`).
- Optional whitespace compaction for file contents (`promptfold.compactWhitespace`).
- Protection for secrets: a sensitive level that never reaches the prompt, with `promptfold.allowSensitive` as the explicit exception.

### Security

- Sensitive files such as credentials and keys are never included, in files or in diffs.
- Links that point outside the workspace are skipped.

[1.0.3]: https://github.com/GianZapata/PromptFold/releases/tag/v1.0.3
[1.0.2]: https://github.com/GianZapata/PromptFold/releases/tag/v1.0.2
[1.0.1]: https://github.com/GianZapata/PromptFold/releases/tag/v1.0.1
[1.0.0]: https://github.com/GianZapata/PromptFold/releases/tag/v1.0.0
