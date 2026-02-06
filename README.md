# openclaw-model-selector

Automatic per-turn model selection for OpenClaw.

## What it does
- Classifies the latest user message into task tiers
- Suggests appropriate model upgrades, waits for user approval
- Auto-returns to default model when Todoist tasks are completed

## Model Tiers

| Tier | Category | Default Models | Use Case |
|------|----------|----------------|----------|
| 1 | simple | (default/haiku) | Q&A, memory recall, quick tasks |
| 2 | moderate | sonnet, gemini-flash | Research, analysis, multi-step |
| 3 | complex | opus, gemini-pro, gpt-5.2 | Architecture, orchestration, planning |
| 3 | coding | opus, gemini-pro | Code generation, debugging |

## Flow
1. Start on default model (haiku)
2. Detect task category → Suggest appropriate model
3. User approves → Switch via `session_status`
4. Task completes (Todoist `complete-tasks`) → Auto-return to default

> Note: OpenClaw plugins cannot swap the model mid-turn. The switch takes effect on the next turn.

## Config (example)
```json
{
  "enabled": true,
  "announceSwitch": true,
  "models": {
    "simple": [],
    "moderate": ["sonnet", "gemini-flash"],
    "complex": ["opus", "gemini-pro", "openai-codex/gpt-5.2"],
    "coding": ["opus", "gemini-pro"]
  }
}
```

## Classification Signals

**Tier 3 - Coding:** code fences, "write code", "debug", "refactor", "implement", language names, "stack trace", etc.

**Tier 3 - Complex:** "orchestrate", "architect", "system design", "migrate", "build the", "infrastructure", etc.

**Tier 2 - Moderate:** "research", "analyze", "compare", "summarize", "investigate", "explain", "multi-step", etc.

**Tier 1 - Simple:** Everything else (default)

## Approval Triggers
- "go ahead", "proceed", "do it", "approved", "yes", "lgtm", "ship it", etc.

## Override Triggers (stay on current model)
- "stick with", "stay on", "keep", "no switch", "don't switch"

## Todoist Integration

When the agent completes a Todoist task via `complete-tasks` (mcporter tool), the plugin:
1. Detects the completion
2. Queues a return to default model
3. On the next turn, injects instructions to call `session_status({ model: "default" })`

## Install
```bash
openclaw plugins install --link /path/to/openclaw-model-selector
```

Or add to `openclaw.json`:
```json
{
  "plugins": {
    "entries": {
      "openclaw-model-selector": { "enabled": true }
    },
    "load": {
      "paths": ["/path/to/openclaw-model-selector"]
    }
  }
}
```
