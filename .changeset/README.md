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

When changesets are merged to `main`, the [publish workflow](../.github/workflows/publish.yml) automatically:

1. Runs `bun change version` to consume all pending changesets, bump the version, and update the changelog
2. Opens a release PR with the result
3. When that PR is merged, runs `bun change publish` to publish to npm

### Adding changesets on behalf of contributors

We use the [changeset bot](https://github.com/apps/changeset-bot), which comments on every PR indicating whether a changeset is present. If a contributor doesn't add one, the bot's comment includes a direct link to create a changeset file in the browser — pre-filled with the correct filename. Just write the summary, select the bump type, and commit it directly to the PR branch. No local checkout needed.
