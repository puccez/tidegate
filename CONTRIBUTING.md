# Contributing

Thanks for your interest in TideGate.

## How this repository works

This repository is the public export of the TideGate core, mirrored from an
internal monorepo that remains the source of truth. Issues and pull requests
are welcome here; accepted changes are imported into the internal repo and
land back in the next export. Your authorship is preserved in the changelog
and release notes (squash-exports do not keep external commit objects).

## Development setup

```bash
bun install
bun run check-types
bun test
```

Every package keeps its tests next to the sources (`*.test.ts`, run with
`bun test`). A change is not done until types check and tests pass in all
four packages.

## Guidelines

- Keep changes small and focused: one concern per PR.
- New behavior comes with tests; changed behavior comes with changed tests.
- Match the surrounding code style (no reformat-only diffs).
- Contract changes (`@tidegate/contracts`) are frozen on the versioned wire
  surface: additive changes only, breaking changes need a new version.

## License of contributions

By submitting a pull request you agree that your contribution is licensed
under the license of the package it touches (Apache-2.0 for contracts/sdk,
FSL-1.1-ALv2 for runtime/auth-server).
