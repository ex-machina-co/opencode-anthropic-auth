# Releasing

This is the authoritative maintainer runbook for both release trains. `README.md` and
[`.changeset/README.md`](.changeset/README.md) link here rather than restating any of it.

## Branches and channels

| Branch    | Plugin line | OpenCode | npm dist-tag | Versions        |
|-----------|-------------|----------|--------------|-----------------|
| `main`    | v1          | v1       | `latest`     | `1.x.y`         |
| `v2/main` | v2          | v2       | `next`       | `2.x.y-next.N`  |

Both branches publish the **same** npm package, `@ex-machina/opencode-anthropic-auth`.
There is no separate `-next` package.

`latest` belongs to v1 until we decide v2 is the default. `v2/main` stays in changesets
prerelease mode for as long as v2 ships as a prerelease, so it can never take `latest` by
accident. Leaving that mode is a deliberate, reviewed step — see
[Promotion to `latest`](#promotion-to-latest-deferred).

`v2/main` is a long-lived branch, not a feature branch. It is never merged back into
`main`; changes flow one way, `main` → `v2/main`.

## Installing

v1 (default):

```json
{ "plugin": ["@ex-machina/opencode-anthropic-auth"] }
```

v2 prerelease (opt-in), using OpenCode v2's `plugins` key. Substitute a prerelease that
actually exists — `npm view @ex-machina/opencode-anthropic-auth dist-tags` shows the current
`next`:

```json
{ "plugins": ["@ex-machina/opencode-anthropic-auth@<2.x.y-next.N>"] }
```

Pin the exact version rather than tracking `@next`, which moves on every prerelease publish.

Nothing is published to `next` yet — the first prerelease waits on the v2 port — so there is
no version to substitute until then.

## Releasing v1 from `main`

Unchanged from before the v2 train existed:

1. A PR merges to `main` with a changeset.
2. [`publish.yml`](.github/workflows/publish.yml) on `main` opens or updates the
   `chore: version package` release PR.
3. Merging that release PR runs `bun run release`, publishing to `latest`.

## Releasing v2 from `v2/main`

1. A PR merges to `v2/main` with a changeset.
2. `publish.yml` on `v2/main` opens or updates the `chore(v2): version next package (next)`
   release PR. Because `.changeset/pre.json` is committed, `changeset version` produces a
   `-next.N` version. (The action appends the pre tag to the title and commit message
   itself, which is where the trailing `(next)` comes from.)
3. Merging that release PR runs `bun run release:next`, which publishes to `next`.

The two trains are isolated: different trigger branches, different concurrency groups
(`publish` vs `publish-v2-next`), different release-PR titles, different publish commands.

### How the release PR recomputes

The release branch (`changeset-release/v2/main`) is **reset to the head of `v2/main` on
every run** and re-versioned from scratch. An open release PR is therefore a preview of
"what would ship if I merged right now", not an accumulating stack. Consequences:

- Leaving a release PR open costs nothing. It does not burn `-next.N` counters.
- The `-next.N` counter only advances when a release PR is **merged**, because that is what
  moves `package.json` and `.changeset/pre.json` on `v2/main` itself.
- Force-pushes to the release branch are expected and are not a sign of trouble.

### The publish guard

`bun run release:next` runs [`scripts/validate-next-release.ts`](scripts/validate-next-release.ts)
before `changeset publish`. It aborts unless all of the following hold:

- the package is `@ex-machina/opencode-anthropic-auth`
- `.changeset/pre.json` exists and `mode` is `pre`
- the pre `tag` is `next`
- the version matches `2.x.y-next.N`

This exists because changesets versions from wherever the branch currently sits. Until the
v2 major changeset lands, a v2 release PR resolves to something like `1.8.3-next.0` — a
v1-shaped prerelease on the v2 channel.

**Do not merge a v2 release PR whose version is below `2.0.0-next.0`.** Leave it open. It
costs nothing, and because the release branch is recomputed from scratch on every run
(see above), it will re-resolve to `2.0.0-next.0` as soon as a `major` changeset lands.

If you merge one anyway, it is recoverable but messy:

- The publish job fails on the guard. Nothing reaches npm — that is the guard working.
- `v2/main` is now sitting on a `1.x.y-next.N` version with a `CHANGELOG.md` entry for a
  release that does not exist.
- Every later push to `v2/main` with no pending changesets re-runs publish and **fails
  again**, so the branch stays red until the version reaches 2.x.
- To recover, land the `major` changeset and merge the resulting release PR. The counter
  continues from where the bad merge left it, so the first real prerelease will be
  `2.0.0-next.N+1` rather than `2.0.0-next.0`. Cosmetic, but permanent.

If the v2 line ever moves to major 3, update `EXPECTED_MAJOR` in the guard in the same PR
that lands the major changeset.

## Syncing `main` → `v2/main`

Sync PRs are created by hand. There is no scheduled or automated sync.

```bash
git fetch origin
git switch --create sync/main-to-v2 origin/v2/main
git merge origin/main
# resolve conflicts per the table below
gh pr create --base v2/main --title "chore: sync main into v2/main"
```

Review it like any other PR, then merge it.

### Timing: sync before the v1 release PR merges

A change's changeset file only exists between "the change merged to `main`" and "the v1
release PR consumed it". Sync inside that window and the changeset rides along on its own,
giving v2 the same release note for free.

If you sync after the v1 release PR merged, the changeset is gone — the merge brings the
code and the v1 `CHANGELOG.md`/`package.json` bump, but no release intent for v2. In that
case **add a replacement changeset to the sync PR** describing the same change, so it
appears in the v2 changelog. Do not skip it; a silently missing release note is worse than
a duplicated one.

### Conflict resolution

Conflicts are expected and concentrated in release-owned files. `v2/main` always wins for
anything that defines the v2 release train:

| File | Resolution |
|---|---|
| `.changeset/pre.json` | Keep v2's. Never delete it here — only promotion retires it. |
| `.changeset/config.json` | Keep v2's `"baseBranch": "v2/main"`. |
| `.github/workflows/publish.yml` | Keep v2's trigger, concurrency group, titles, and `release:next`. Take any genuine infrastructure improvement from `main` (action bumps, node version) by hand. |
| `package.json` version | Keep v2's `-next` version. Never take `main`'s `1.x.y`. |
| `package.json` scripts | Keep both `release` and `release:next`. |
| `CHANGELOG.md` | Keep both histories. v1 entries above the v2 entries is fine; the file is append-only prose. |
| `README.md` pin examples | Keep v2's examples. |
| `bun.lock` | Resolve semantically: take the merged dependency set and re-run `bun install`, then commit the result. Never hand-edit. |
| `src/**` | Resolve on the merits, like any code conflict. |

Always run the full check suite locally on the merged tree before opening the sync PR:

```bash
bun install --frozen-lockfile
bun run types && bun run build && bun test && bun run format:check && bun run lint
```

### Worked examples

**#223 — code arrived after its changeset was consumed.** #223 merged to `main`, then
release PR #224 consumed its changeset and shipped v1.8.2. `v2/main` was brought up to that
commit, so the *code* is on the branch but no release intent came with it. The fix was a
replacement patch changeset (`.changeset/quiet-moons-repeat.md`) restating the Claude Code
version bump, so it appears in the v2 changelog.

**#218 — sync before its changeset is consumed.** Merge #218 to `main`, then open the sync
PR *before* merging the resulting v1 release PR. `.changeset/calm-streams-flow.md` comes
across in the merge and needs no replacement. This is the shape every future sync should
aim for.

## Promotion to `latest` (deferred)

Not scheduled. When v2 becomes the default, it happens as its own reviewed change:

1. `bun change pre exit` on `v2/main`. This flips `.changeset/pre.json` to `"mode": "exit"`;
   the next `changeset version` drops the `-next.N` suffix and deletes the file.
2. Retire or rewrite the `release:next` guard — it exists specifically to prevent stable
   publishes and will block this.
3. Version and publish `2.0.0` to `latest`.
4. Decide `main`'s fate: keep it as a maintenance line for `1.x` (published with an
   explicit `--tag`, never `latest`), or freeze it.
5. Update `README.md` and this file.

Until every one of those steps happens deliberately, `latest` stays on v1.

## Rollback

The v2 channel is prerelease, so rollback is cheap:

- **Bad prerelease published.** Publish a fixed `-next.N+1`. Optionally
  `npm deprecate '@ex-machina/opencode-anthropic-auth@2.0.0-next.N' '...'`. Users who
  pinned exactly are unaffected until they move.
- **Never** repair a v2 problem by moving `latest`. `latest` is a v1 pointer.
- **Release train misbehaving.** Stop merging v2 release PRs. Nothing publishes without a
  release-PR merge, so leaving them open is a complete stop.
- **Prerelease mode lost.** If `.changeset/pre.json` is deleted (usually a bad conflict
  resolution), the guard blocks the publish. Restore it with
  `bun change pre enter next` and re-check the version in `package.json`.
