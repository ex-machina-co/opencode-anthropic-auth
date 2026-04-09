---
"@ex-machina/opencode-anthropic-auth": minor
---

Replace region-based system prompt stripping with anchor-based paragraph removal. Instead of removing everything between the OpenCode identity and the first tail marker (~90 lines of useful behavioral guidance), the plugin now only removes paragraphs containing specific URL anchors (`github.com/anomalyco/opencode`, `opencode.ai/docs`) and the identity line itself. This preserves tone/style, task management, tool usage policy, and other generic instructions that were previously stripped.
