# openclaw-model-selector

Auto-switching model routing for OpenClaw with fallbacks.

## What it does
- Classifies tasks into categories
- **Auto-switches** to the best model (no approval needed)
- Falls back through model list if primary unavailable
- Returns to default when Todoist task completes

## Categories & Models

| Category | Models (primary → fallbacks) | Triggers |
|----------|------------------------------|----------|
| **simple** | (haiku - default) | No triggers |
| **moderate** | sonnet → gemini-flash | research, analyze, summarize, draft, write |
| **coding** | opus → sonnet → gemini-flash | code fences, implement, debug, refactor |
| **complex** | opus → gemini-pro | orchestrate, architect, system design, build the |
| **audit** | gpt-5.2 → opus | audit, security review, code review, find bugs |

## Model Tiers (2026)

Based on current model capabilities:

| Tier | Models | Best For |
|------|--------|----------|
| **Efficiency** | Haiku, Gemini Flash | High-volume, real-time, cost-sensitive |
| **Performance** | Sonnet, Gemini Pro | Daily driver, enterprise agents, coding |
| **Frontier** | Opus, GPT 5.2 | Deep reasoning, architecture, audits |

## Config

Models are easy to update as new versions release:

```json
{
  "enabled": true,
  "announceSwitch": true,
  "models": {
    "simple": [],
    "moderate": ["sonnet", "gemini-flash"],
    "coding": ["opus", "sonnet", "gemini-flash"],
    "complex": ["opus", "gemini-pro"],
    "audit": ["openai-codex/gpt-5.2", "opus"]
  }
}
```

To swap models, just edit the arrays. First model = primary, rest = fallbacks.

## Todoist Integration

When `complete-tasks` is called (via mcporter), the plugin:
1. Detects task completion
2. Queues return to default model
3. Next turn: injects instructions to call `session_status({ model: "default" })`

## Install

```bash
openclaw plugins install --link /path/to/openclaw-model-selector
```
