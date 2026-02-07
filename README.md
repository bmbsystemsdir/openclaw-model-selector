# openclaw-model-selector

Hybrid task classification with approval-first model routing for OpenClaw.

## What it does

1. **Classify** incoming message (keyword matching + Gemini LLM fallback)
2. **Suggest** the best model for the task
3. **Wait for approval** (you approve or override)
4. **Switch** to the approved model, then execute
5. **Announce and switch back** when task complete (opt-out override)

## Why approval first?

Planning + execution should happen on the *right* model, not on haiku (default). If I auto-switch without approval, I analyze on haiku, then switch—you lose planning quality on the better model.

**Flow:**
- Request arrives → classify (keyword match or LLM fallback)
- Suggest a model with reasoning
- **You approve** ("go ahead", "yes", "do it")
- Switch to that model
- Execute on that model
- When done: announce "Switching back to haiku" → switch (you can say "no" to stay)

## Classification

**Fast path:** Keyword matching (instant, free)
- Coding: `code me`, `implement`, `debug`, `write a script`, etc.
- Complex: `architect`, `system design`, `build the`, etc.
- Moderate: `research`, `analyze`, `draft`, `summarize`, etc.
- Security: `security review`, `code audit`, `find vulnerabilities`, etc.

**Fallback:** Gemini 2.0 Flash LLM classification
- Triggers for messages >50 chars without keyword match
- ~100 tokens, ~$0.0001/call

## Categories & Models

| Category | Primary | Fallbacks | Triggers |
|----------|---------|-----------|----------|
| **simple** | (default) | — | No triggers → stays on default |
| **moderate** | sonnet | gemini-flash | research, analyze, draft, write, academic |
| **coding** | opus | sonnet, gemini-flash | code, implement, debug, script |
| **complex** | opus | gemini-pro | orchestrate, architect, system design |
| **security-audit** | gpt-5.2 | opus | code review, security review, audit |

## Approval Keywords

**Approve:** `go ahead`, `proceed`, `yes`, `approve`, `do it`, `ok`, `lgtm`

**Override (stay on default):** `stay on`, `keep`, `no switch`

**Stay on upgraded model (after task):** `no`, `not done`, `keep going`

## Config

Place in `config/model-selector.json` in your workspace:

```json
{
  "enabled": true,
  "models": {
    "simple": [],
    "moderate": ["sonnet", "gemini-flash"],
    "coding": ["opus", "sonnet", "gemini-flash"],
    "complex": ["opus", "gemini-pro"],
    "security-audit": ["openai-codex/gpt-5.2", "opus"]
  }
}
```

First model = primary, rest = fallbacks.

## Requirements

- `GEMINI_API_KEY` env var for LLM fallback classification (optional but recommended)

## Install

```bash
openclaw plugins install /path/to/openclaw-model-selector
```
