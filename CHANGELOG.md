# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.0.0]: https://github.com/GianZapata/PromptFold/releases/tag/v1.0.0
