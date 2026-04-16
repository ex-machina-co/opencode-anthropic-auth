# @ex-machina/opencode-anthropic-auth

## 1.7.2

### Patch Changes

- [#106](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/106) [`31b3b99`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/31b3b991be07dbc27734bc8326e3d8fe0d3626ac) Thanks [@eXamadeus](https://github.com/eXamadeus)! - Bump bun to 1.3.12, ensure we use mise in CI, and lock engines for dev

## 1.7.1

### Patch Changes

- [#94](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/94) [`522c18d`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/522c18d7193d2a99d28e2664b0ba2b10faf80a4c) Thanks [@colus001](https://github.com/colus001)! - Fix `Cannot find module '.../dist/auth'` error when opencode loads the plugin as strict ESM.

## 1.7.0

### Minor Changes

- [#91](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/91) [`550c408`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/550c408e22f29ee83fe9c707318e8759510ff0eb) Thanks [@bogdan-manole](https://github.com/bogdan-manole)! - fixing the StructuredOutput issue introduced in v1.5.1

## 1.6.1

### Patch Changes

- [#88](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/88) [`a90185a`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/a90185afc77f8200d3a2187b244610eef7375371) Thanks [@eXamadeus](https://github.com/eXamadeus)! - Remove system block to user message relocation, remove experimental FF, and align system blocks to match Anthropic

- [#87](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/87) [`e3e1be4`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/e3e1be4aace9d34bda53a99d43b9c72afbf6d6a4) Thanks [@eXamadeus](https://github.com/eXamadeus)! - Remove OpenCode identity more accurately

## 1.6.0

### Minor Changes

- [#81](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/81) [`0906d28`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/0906d288b85511abcba358ccdec04ae2929792ae) Thanks [@INONONO66](https://github.com/INONONO66)! - PascalCase tool names after mcp\_ prefix to match Claude Code convention

## 1.5.1

### Patch Changes

- [#76](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/76) [`d92609c`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/d92609c2c8168f9b80616f0269381126a02fe7c8) Thanks [@eXamadeus](https://github.com/eXamadeus)! - Add in `EXPERIMENTAL_KEEP_SYSTEM_PROMPT` which allows users to
  keep the sanitized prompt as a system prompt, instead of changing
  it to a user propmt.

## 1.5.0

### Minor Changes

- [#74](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/74) [`53b62bb`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/53b62bb1fc18fff29fccbfa0ef190d5082cc247d) Thanks [@eXamadeus](https://github.com/eXamadeus)! - Add in Claude billing header with content consistency hashing from decompiled binary

## 1.4.1

### Patch Changes

- [#70](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/70) [`91601b8`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/91601b81616b5013517d316c82beb5c3d6303022) Thanks [@dependabot](https://github.com/apps/dependabot)! - chore(deps-dev): bump @opencode-ai/plugin from 1.3.13 to 1.4.3

- [#71](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/71) [`ce3f9fc`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/ce3f9fc0f96c943c5ec3b906e4285bedababae2e) Thanks [@dependabot](https://github.com/apps/dependabot)! - chore(deps-dev): bump lefthook from 2.1.4 to 2.1.5

- [#69](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/69) [`2d9b5bc`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/2d9b5bce197464504c2957b7943344291e559f4b) Thanks [@dependabot](https://github.com/apps/dependabot)! - chore(deps-dev): bump @biomejs/biome from 2.4.10 to 2.4.11

## 1.4.0

### Minor Changes

- [#63](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/63) [`69f4754`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/69f4754b7b59ed6632e5d0db30f92ccc3d3beb39) Thanks [@eXamadeus](https://github.com/eXamadeus)! - To bypass Anthropic's scans of the system prompts, move all but the identity marker into a user message

### Patch Changes

- [#61](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/61) [`8dca525`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/8dca5253cedbce8bc1d1283368370044ff933321) Thanks [@eXamadeus](https://github.com/eXamadeus)! - Minor change to identity anchor

## 1.3.0

### Minor Changes

- [#59](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/59) [`d520d0c`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/d520d0ceb27bcab25c36a85925b71212d2721f24) Thanks [@eXamadeus](https://github.com/eXamadeus)! - Minimize prompt sanitization reach with anchor-based paragraph removal, preserving behavioral guidance that was previously stripped.

## 1.2.0

### Minor Changes

- [#52](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/52) [`19ea91a`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/19ea91abdfa04506fccf6c24cce1dabccb82f98a) Thanks [@eXamadeus](https://github.com/eXamadeus)! - Add system prompt sanitization for Max subscription compatibility. Moves system prompt handling from the plugin hook into the request body layer, surgically removing the OpenCode identity section and prepending Claude Code identity. Preserves user-configured instructions from config.json.

## 1.1.2

### Patch Changes

- [#49](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/49) [`3ad9267`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/3ad92670bcc77adb45eab51efeab7ffcc7537822) Thanks [@PaoloC68](https://github.com/PaoloC68)! - Surface token refresh error body for easier diagnosis; add prepare script for github installs

## 1.1.1

### Patch Changes

- [#47](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/47) [`c0fbbcf`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/c0fbbcf6cdcf6c2879604e0b8e609cbdf8fddead) Thanks [@eXamadeus](https://github.com/eXamadeus)! - Minor bump to update README in npm with security suggestion

## 1.1.0

### Minor Changes

- [#42](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/42) [`feec332`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/feec3328afd0c9fcc5b708f5d2b11337e6844242) Thanks [@Thesam1798](https://github.com/Thesam1798)! - feat: support ANTHROPIC_BASE_URL env var for custom API endpoint

## 1.0.4

### Patch Changes

- [#39](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/39) [`32240f1`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/32240f1e82e2ec711e9699a4efecb754e192c3af) Thanks [@Thesam1798](https://github.com/Thesam1798)! - ci: harden workflows for fork safety and concurrency

- [#41](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/41) [`386e716`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/386e71681d00c858e0d0fe958a06f3ee3fab10e3) Thanks [@Thesam1798](https://github.com/Thesam1798)! - fix: deduplicate concurrent OAuth token refreshes

## 1.0.3

### Patch Changes

- [#37](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/37) [`97729bc`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/97729bc8140f9931512958bda2de6950a4ce4636) Thanks [@eXamadeus](https://github.com/eXamadeus)! - Update copyright year in LICENSE file

## 1.0.2

### Patch Changes

- [#31](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/31) [`2ff263f`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/2ff263f9d8c43ed009582697a45f4dfbf6de4e0b) Thanks [@eXamadeus](https://github.com/eXamadeus)! - Add in changesets for changeset management and fix type checking

- [#33](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/33) [`4523f1b`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/4523f1beba4f6c2669a04e67a47be8d365d0d30f) Thanks [@eXamadeus](https://github.com/eXamadeus)! - Make sure changeset PRs are run by bot user for CI to trigger

- [#34](https://github.com/ex-machina-co/opencode-anthropic-auth/pull/34) [`9c7a9e2`](https://github.com/ex-machina-co/opencode-anthropic-auth/commit/9c7a9e217a0c6be0f419bf129dad48c033120da5) Thanks [@eXamadeus](https://github.com/eXamadeus)! - Ensure CI is triggered per release
