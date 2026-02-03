# openclaw-model-selector

Automatic per-turn model selection for OpenClaw.

## What it does
- Classifies the latest user message as **simple**, **moderate**, **complex**, or **coding**.
- When the selected model changes, it injects instructions via `before_agent_start` so the agent:
  1) Announces the switch (optional)
  2) Calls `session_status` to set the **per-session model override** for subsequent turns

> Note: OpenClaw plugins cannot directly swap the model *mid-turn* (the LLM is already running). This plugin makes the switch take effect immediately for the **next** turn (and any long-running follow-ups), which is where most token savings come from.

## Config (example)
```json
{
  "enabled": true,
  "announceSwitch": true,
  "models": {
    "simple": "gemini-flash",
    "moderate": "sonnet-4-5",
    "complex": "opus",
    "coding": "gpt"
  }
}
```

## Heuristics (default)
- **coding**: mentions code-related terms or includes code fences
- **complex**: mentions orchestration/architecture/build/debug/multi-step
- else **simple**

You can add forced keyword lists with:
- `rules.forceComplexKeywords`
- `rules.forceCodingKeywords`

## Install
Add to your `openclaw.json` under `plugins.entries` pointing at the local folder or package name.

