# Contributing to cf-usage-guard

Thanks for considering a contribution! This document covers the basics.

## Development Setup

```bash
git clone https://github.com/tristanwagner/cf-usage-guard.git
cd cf-usage-guard
pnpm install
```

## Commands

```bash
pnpm check-types    # TypeScript type checking
pnpm check          # Biome lint + format check
pnpm check:fix      # Biome auto-fix
pnpm test           # Run tests
pnpm build          # Build dist/
```

## Before Submitting a PR

1. All tests must pass: `pnpm test`
2. Types must check: `pnpm check-types`
3. Lint must pass: `pnpm check`
4. Coverage thresholds must be met (100% statements/lines/functions, 99% branches)
5. Add tests for any new functionality

## Code Style

- Biome handles formatting and linting -- run `pnpm check:fix` before committing
- Use `const` objects with `UPPER_SNAKE` keys for enum-like values (never TS `enum`)
- Arrow functions preferred
- Double quotes (enforced by Biome)
- Tab indentation (enforced by Biome)

## Adding a New Resource Type

1. Add the key to `RESOURCES` in `src/types.ts`
2. Add default thresholds in `src/validation.ts`
3. Add parsing logic in `src/query.ts` (in `parseResources`)
4. Add tests covering the new resource
5. Update the README threshold table

## Adding a New Alert Channel

1. Add the type to `ALERT_CHANNEL_TYPES` in `src/types.ts`
2. Add the channel variant to the `AlertChannel` union type
3. Add dispatch logic in `src/alerts.ts` (in `dispatchAlert`)
4. Add formatting function (e.g., `sendTeams`)
5. Add tests for the new channel
6. Update README with configuration example

## Publishing a Release

Releases are published to npm automatically via GitHub Actions when a version tag is pushed.

1. Update the version in `package.json` and commit:
   ```bash
   npm version <patch|minor|major>
   ```
   This bumps `package.json`, creates a commit, and tags it as `v<version>`.

2. Push the commit and tag:
   ```bash
   git push origin master --follow-tags
   ```

3. The [release workflow](.github/workflows/release.yml) will run type checks, lint, tests, build, and publish to npm with OIDC provenance.

> **Note:** Tags must be prefixed with `v` (e.g. `v0.3.0`). `npm version` does this by default.

## Reporting Issues

Open an issue on GitHub with:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Your Cloudflare Workers environment (Wrangler version, etc.)

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
