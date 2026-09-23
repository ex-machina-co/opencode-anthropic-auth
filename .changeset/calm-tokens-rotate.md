---
'@ex-machina/opencode-anthropic-auth': patch
---

Prevent rotating OAuth refresh tokens from being replayed across concurrent or delayed requests, and require reconnecting after ambiguous refresh outcomes.
