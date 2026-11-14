# measurr

measurr is a small typed semantic layer, published to npm: datasets of measures and dimensions compiled to SQL for Postgres and ClickHouse, or evaluated over rows from an API, with chart shapes and dashboard metrics. The [README](README.md) is the user guide.

## Consumers

Only our own apps install measurr. A breaking change is allowed when it is released as one: title the PR `feat!:`, also for a type-only break, and say in the body what an app must change. The apps are upgraded after the release.

## Before a PR

```sh
bun run lint && bun test && bun run build && bun run verify:package
```

This is what CI runs. The Postgres and ClickHouse tests skip unless their URLs are set, and CI sets them: see [Development](README.md#development) when a change touches a dialect or generated SQL.

## Releasing

The PR title decides the release, and CI rejects a title that is not a conventional commit. Release Please writes the version in `package.json` and `CHANGELOG.md` in its release PR: leave both to it. See [docs/releasing.md](docs/releasing.md).
