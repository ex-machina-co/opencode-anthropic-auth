# Plan: Reusable `main` → `v2/main` Sync

## Goal

Safely forward-port `origin/main` into `origin/v2/main` on a local branch named `v2/sync/main`, following `RELEASING.md`. Use the current checkout, preserve v2 release infrastructure, restore missing release intent when necessary, and leave remote publication entirely behind an explicit user gate.

## Decisions

- `RELEASING.md` remains the authoritative release and conflict-resolution runbook.
- Use the current checkout, not a worktree.
- Require a clean working tree before switching branches.
- Build `v2/sync/main` from the latest `origin/v2/main`.
- Never reset, overwrite, or delete an existing `v2/sync/main` without approval.
- Do not push or open a PR by default.
- After local verification, ask whether to push and open the PR.
- Never merge the PR or publish a package.

## Step Types

- **Verify** → CHECK. Run automated checks (tests, lint, type checks).
  If all checks pass, proceed. If anything fails, STOP and notify the user.
- **Implement** → WRITE. Make code changes — create, edit, or delete files.
- **Propose** → READ-ONLY + USER GATE. Present intended changes in your message text first,
  then ask for approval using the `question` tool with a short prompt (Approve / Reject / Request changes).
  Never put details in the question — the question is just the gate. Do not write anything.
- **Explore** → READ-ONLY. Read files, search the codebase, investigate broadly.
  No writes allowed. Use this to understand the problem space before acting.
- **Review** → READ-ONLY + USER GATE. Present findings and analysis in your message text first,
  then ask for feedback using the `question` tool with a short prompt.
  Never put details in the question — the question is just the gate.
- **Pause** → PAUSE, NO TOOL. A model-switch pause. Emit this exact line of plain text and nothing else:
  "Switch models if desired, then send any message to continue."
  Then end the turn. Do NOT call the `question` tool, and do NOT tell the user to run a command.
  An affirmative continuation resumes execution; a stop, revise-plan, or
  question message is handled without advancing.

### Step 1 - Implement: Refresh the remote branch references

- Run `git fetch origin`.
- Do not switch branches, alter tracked files, or modify remote branches.

### Step 2 - Verify: Confirm synchronization prerequisites

- Confirm `origin/main` and `origin/v2/main` resolve to commits.
- Confirm no merge, rebase, cherry-pick, or revert is already in progress.
- Confirm the current working tree and index are clean.
- Record the current branch so the user knows which checkout will be changed.
- Stop if these prerequisites are not satisfied.

### Step 3 - Pause: Switch model for exploration

### Step 4 - Explore: Analyze the pending forward-port

- Re-read the synchronization section of `RELEASING.md`.
- Enumerate commits and file changes in `origin/v2/main..origin/main`.
- Inspect existing local and remote `v2/sync/main` branches and any open equivalent sync PR.
- Use read-only merge analysis to identify likely conflicts.
- Classify release-owned files using the runbook’s conflict table.
- Determine which incoming changesets remain present and which release intents were already consumed on `main`.
- Identify any changes that require replacement v2 changesets.
- Inspect prior sync commits and PRs when they clarify expected resolutions.

### Step 5 - Review: Discuss complex forward-port findings when needed

Use judgment to determine whether the analysis found complexity, ambiguity, or consequential
tradeoffs that would benefit from user discussion.

If the forward-port is straightforward and no user direction would materially affect the strategy,
mark this review unnecessary and proceed directly to Step 6 without calling the `question` tool.

Otherwise:

- Present the relevant findings, uncertainties, tradeoffs, and available options in the message text.
- Ask the user for feedback using the `question` tool with a short prompt.
- Resolve or record the user’s direction before continuing.
- Carry that direction into the synchronization strategy proposed in Step 6.

### Step 6 - Propose: Present the exact synchronization strategy

Present for approval, incorporating any direction obtained in Step 5:

- The commits and changes being forwarded.
- How an existing `v2/sync/main`, if any, will be handled without destructive reset.
- Expected conflict resolutions, distinguishing release-owned files from source-code conflicts.
- Which original changesets will transfer naturally.
- Which consumed changesets require equivalent replacements.
- Any material uncertainty that requires user direction before merging.

Do not alter the checkout until the proposal is approved.

### Step 7 - Pause: Switch model for implementation

### Step 8 - Implement: Prepare the local `v2/sync/main` merge

- Create and switch to `v2/sync/main` from `origin/v2/main`.
- If the branch already exists, follow only the approved non-destructive handling from Step 6.
- Merge `origin/main`.
- Resolve release-owned conflicts according to `RELEASING.md`:
  - Preserve v2 prerelease state and Changesets base branch.
  - Preserve the v2 publish trigger, concurrency, titles, and `release:next`.
  - Preserve the v2 package version and both release scripts.
  - Retain both changelog histories and v2 installation examples.
  - Reconcile genuine infrastructure improvements manually.
  - Resolve `src/**` on technical merit.
  - Regenerate `bun.lock` from the resolved dependency set rather than hand-editing it.
- Add equivalent replacement changesets for consumed v1 release intent identified in the approved proposal.
- Complete the merge commit on the local branch.
- Do not push or create a PR.

### Step 9 - Verify: Validate the merged tree and release invariants

Run:

```bash
bun install --frozen-lockfile
bun run types
bun run build
bun test
bun run check:package
bun run format:check
bun run lint
```

Also verify:

- The branch is `v2/sync/main`.
- The merge contains the intended `origin/main` commits.
- `.changeset/pre.json` remains in `pre` mode with tag `next`.
- `.changeset/config.json` still targets `v2/main`.
- The package remains on a `2.x.y-next.N` version.
- The v2 publishing workflow and `release:next` guard remain intact.
- Every incoming user-visible change has transferred or replacement release intent.
- No remote branch, PR, tag, release, or package was created.

### Step 10 - Review: Present the verified local synchronization

Report:

- Merge commit and included commit range.
- Conflicts encountered and their resolutions.
- Original and replacement changesets.
- Full verification results.
- Remaining risks or review points.
- The proposed PR title and summary.

Ask the user to choose whether to:

1. Keep the branch local and finish.
2. Push `v2/sync/main` and open a PR.
3. Request further local changes.

### Step 11 - Implement: Optionally submit the synchronization PR

Only if explicitly approved in Step 10:

- Push `v2/sync/main` without force.
- Open a PR targeting `v2/main` titled `chore: sync main into v2/main`.
- Include the verified commit range, conflict decisions, changeset handling, and checks in the PR description.

If the user chooses to keep the branch local, perform no remote mutation. Never merge the PR.

### Step 12 - Verify: Confirm the selected final state

- If kept local, confirm the verified branch remains available locally and no new remote branch or PR was created.
- If submitted, confirm the remote branch and PR target `v2/main`, inspect initial checks, and report their status.
- Confirm no PR was merged and no release or package publication occurred.

## Acceptance Criteria

- `origin/main` is merged into a local `v2/sync/main` based on current `origin/v2/main`.
- V2 release-owned state remains intact.
- Required replacement changesets restore consumed release intent.
- The complete local check suite passes.
- No destructive branch operation occurs without approval.
- No remote action occurs unless separately approved.
- The workflow never merges a PR or publishes a package.
