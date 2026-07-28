# Contributing to Token Lens

First off, thanks for taking the time to contribute!

## Code of Conduct

This project and everyone participating in it is governed by the [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

## How Can I Contribute?

### Reporting Bugs

Before creating bug reports, please check the [issue tracker](https://github.com/FreePeak/token-lens/issues) to avoid duplicates. When you create a bug report, include as many details as possible:

- **Describe the bug** — clear and concise description
- **To reproduce** — steps to reproduce the behavior
- **Expected behavior** — what you expected to happen
- **Screenshots / logs** — if applicable
- **Environment** — OS, Bun version, Cursor version

Use the [bug report template](https://github.com/FreePeak/token-lens/issues/new?template=bug_report.md).

### Suggesting Features

Open an issue using the [feature request template](https://github.com/FreePeak/token-lens/issues/new?template=feature_request.md). Explain:

- **What** you want to happen
- **Why** — the problem it solves
- **How** it might work (optional)

### Adding a New Tool

Token Lens has a pluggable tool registry. To add support for a new AI coding tool:

1. Create `src/tools/<id>.ts` implementing the `Tool` interface from `src/tools/types.ts`
2. Register it in `src/tools/registry.ts`
3. Add pricing entries to `prices.json` if the tool uses models not yet listed
4. Open a PR

See the `src/tools/cursor.ts` implementation as a reference.

### Improving Pricing Data

`prices.json` lists model cost estimates. If a model is missing or the rates are wrong:

1. Edit `prices.json` directly, or
2. Run `bun run prices:fetch` to pull the latest OpenRouter prices, then `bun run prices:sync` to merge them

### Code Contributions

1. Fork the repo and create your branch from `master`
2. If you're adding code, please make sure it follows the existing style (TypeScript, Bun runtime)
3. Run `make test` to verify existing tests pass
4. Open a [pull request](https://github.com/FreePeak/token-lens/compare)

## Development Setup

```bash
git clone https://github.com/FreePeak/token-lens.git
cd token-lens
bun install
cd dashboard && bun install && cd ..
```

Run the dev server:

```bash
# Terminal 1: API server
bun run serve

# Terminal 2: Dashboard dev (hot reload)
cd dashboard && bun run dev
```

## Style Guide

- TypeScript with strict types
- Bun runtime — no Node.js-specific APIs where Bun alternatives exist
- Single-purpose functions
- No unnecessary abstractions (YAGNI)
- Prefer SQLite for persistence — no ORMs
- Tests go in `tests/` alongside source

## Release Process

Maintained by the project maintainers. Semantic versioning:

- **Patch** (0.0.x) — bug fixes, minor improvements
- **Minor** (0.x.0) — features, new tool support
- **Major** (x.0.0) — breaking changes

## Questions?

Open a [discussion](https://github.com/FreePeak/token-lens/discussions) or ask in issues.
