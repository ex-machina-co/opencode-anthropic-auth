---
'@ex-machina/opencode-anthropic-auth': patch
---

Explain fast mode credit rejections instead of reporting an unclassified HTTP 429. When Anthropic answers a fast mode request with "Usage credits are required for fast mode.", the error now uses `category=fast-mode-credits`, states that fast mode needs usage credits (extra usage), suggests enabling extra usage or choosing a model without fast mode, includes a safe `overage-disabled` reason when Anthropic provides one, and is marked non-retryable ([#274](https://github.com/ex-machina-co/opencode-anthropic-auth/issues/274)).
