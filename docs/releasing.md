# Releasing measurr

Use a pull request with a conventional title. While the package is `0.x`, `fix:` and `perf:` release a patch, and `feat:`, `feat!:` or a `BREAKING CHANGE:` footer release a minor (`bump-minor-pre-major`). Title a breaking change `feat!:` also when only the types break: the version is the same as for `feat:`, and the release notes get a breaking-changes section that tells an app what to change. `chore:`, `ci:`, `docs:`, `refactor:` and `test:` do not release. Squash merging uses the PR title; do not manually edit versions or changelogs.

CI checks the PR title, lint/types, tests (including the Postgres integration test), build and installed npm artifact. Release Please uses the `RELEASE_PLEASE_TOKEN` secret, so the release PR's checks start by themselves each time it is opened or updated. Wait for those checks before merging; manual CI dispatches do not satisfy PR protection. Without the secret the workflow falls back to the built-in repository token, and the release PR's checks then wait until a maintainer selects **Approve workflows to run** on it. GitHub documents this token behavior in [Triggering a workflow](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow).

## Publish

1. Merge a passing development PR. Release Please opens or updates a release PR containing the next version and changelog.
2. Review its release notes and any breaking-change migration instructions.
3. Merge the passing release PR when ready. The workflow creates the version tag and GitHub release, checks out that tag, validates the package, and publishes the exact verified tarball with provenance.

Publication uses npm trusted publishing. Its package configuration is GitHub Actions, owner `HansKristoffer`, repository `measurr`, workflow `release.yml`, no environment, and permission to publish. Node 24 supplies a compatible npm CLI. Do not add `NPM_TOKEN` or `NODE_AUTH_TOKEN` to this workflow.

## Recover a failed publication

Fix the failure, then run the Release workflow manually with the existing tag:

```sh
gh workflow run release.yml --repo HansKristoffer/measurr -f tag=vX.Y.Z
```

The workflow checks that the tag exists as a GitHub release and agrees with the package version. Existing npm versions are skipped; registry errors fail rather than being mistaken for an unpublished version. npm versions are immutable: a broken published package needs a new fix PR and release. A source change cannot repair an old tag's build; cut a new release for that.
