# Changelog

## 0.1.1

- `handoff`: `--needs-human` now rejects an empty or whitespace-only value with a usage error instead of silently dropping it; bare `--needs-human` with no value is also rejected, and `--help` documents the rule (DEV-34).
- Packaging: `react`/`react-dom` moved to `devDependencies` (the CLI bundles the dashboard via Vite, so consumers no longer install React); added `homepage`, `bugs` and `keywords`; README screenshots now use absolute URLs so they render on npm (DEV-36).

## 0.1.0

- Initial release: label-based turn-taking on GitHub Issues (`status`, `next`, `claim`, `handoff`, `block`, `resolve`, `labels`, `serve`) with the human-in-the-loop dashboard.
