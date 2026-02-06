# openclaw-model-selector

Approval-first model routing for OpenClaw with fallbacks.

## What it does
1. **Classify** the task and suggest the best model
2. **Wait for approval** (you approve or override)
3. **Switch** to the approved model, then plan + execute on that model
4. **Fall back** through model list if primary unavailable
5. **Return to default** when Todoist task completes

## Why approval first?

Planning + execution should happen on the *right* model, not on haiku (default). If I auto-switch without approval, I analyze on haiku, then switch—you lose planning quality on the better model.

**Flow:**
- Request arrives → I classify it on haiku (quick)
- I suggest a model with reasoning
- **You approve**
- Then I switch to that model
- Then I do planning + execution on that model (the important parts)

## Categories & Models

| Category | Primary | Fallbacks | Triggers |
|----------|---------|-----------|----------|
| **simple** | (haiku) | — | No triggers → stays on default |
| **moderate** | sonnet | gemini-flash | research, analyze, draft, write, data review, academic |
| **coding** | opus | sonnet, gemini-flash | code fences, implement, debug, refactor, script |
| **complex** | opus | gemini-pro | orchestrate, architect, system design, migrate, multi-step |
| **security-audit** | gpt-5.2 | opus | code review, security review, find vulnerabilities, audit code |

## Approval Triggers

**Approve the suggestion:**
- "go ahead", "proceed", "yes", "approve", "do it", "ok"

**Override (stay on default):**
- "stay on", "stay with", "keep", "no switch", "use default"

## Model Tiers (2026)

| Tier | Models | Best For |
|------|--------|----------|
| **Efficiency** | Haiku, Gemini Flash | High-volume, real-time, quick tasks |
| **Performance** | Sonnet, Gemini Pro | Daily driver, general work, coding partners |
| **Frontier** | Opus, GPT 5.2 | Deep reasoning, architecture, security audits |

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
    "security-audit": ["openai-codex/gpt-5.2", "opus"]
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
