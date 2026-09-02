# Changesets

This directory is used by [changesets](https://github.com/changesets/changesets) to track version bumps and changelog entries.

## For contributors

Before submitting a PR, run:

```
bun change
```

Follow the prompts to select a bump type (patch/minor/major) and write a summary of your changes. Commit the generated `.md` file with your PR.

A good changeset describes:
- **What** the change is
- **Why** the change was made
- **How** a consumer should update their code (if applicable)

Not every PR needs a changeset — changes to docs, CI, or other non-published files can skip this step. The [changeset bot](https://github.com/apps/changeset-bot) will comment on your PR to let you know if one is missing.

## For maintainers

### Releases

When changesets are merged to a release branch, the [publish workflow](../.github/workflows/publish.yml) automatically:

1. Runs `bun change version` to consume all pending changesets, bump the version, and update the changelog
2. Opens a release PR with the result
3. When that PR is merged, publishes to npm

This branch (`v2/main`) stays in changesets prerelease mode under the `next` tag for as long
as v2 ships as a prerelease — `pre.json` in this directory is committed state, not scratch
state. Never delete it as part of ordinary work or conflict resolution. The single exception
is the deliberate promotion to `latest`, where `changeset pre exit` retires it on purpose.
It publishes `2.x.y-next.N` to npm's `next` tag, while `main` publishes the v1 line to `latest`.

**[RELEASING.md](../RELEASING.md) is the authoritative runbook** for both trains, the publish
guard that prevents a v1-shaped prerelease from reaching the `next` tag, and the manual
`main` → `v2/main` sync process.

### Adding changesets on behalf of contributors

We use the [changeset bot](https://github.com/apps/changeset-bot), which comments on every PR indicating whether a changeset is present. If a contributor doesn't add one, the bot's comment includes a direct link to create a changeset file in the browser — pre-filled with the correct filename. Just write the summary, select the bump type, and commit it directly to the PR branch. No local checkout needed.
