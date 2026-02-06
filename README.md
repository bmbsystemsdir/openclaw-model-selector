# openclaw-model-selector

Automatic per-turn model selection for OpenClaw.

## What it does
- Classifies the latest user message as **simple**, **moderate**, **complex**, or **coding**.
- When the selected model changes, it injects instructions via `before_agent_start` so the agent:
  1) Announces the switch (optional)
  2) Calls `session_status` to set the **per-session model override** for subsequent turns
- When a Todoist task is completed, automatically returns to the default model

> Note: OpenClaw plugins cannot directly swap the model *mid-turn* (the LLM is already running). This plugin makes the switch take effect immediately for the **next** turn (and any long-running follow-ups), which is where most token savings come from.

## Config (example)
```json
{
  "enabled": true,
  "announceSwitch": true,
  "models": {
    "simple": ["gemini-flash", "sonnet"],
    "moderate": ["sonnet"],
    "complex": ["opus"],
    "coding": ["opus", "gemini-pro"]
  }
}
```

**Note:** The plugin no longer manages a `defaultModel`. It returns to whatever is configured as OpenClaw's default model in the main config.

## Heuristics (default)
- **coding**: mentions code-related terms or includes code fences
- **complex**: mentions orchestration/architecture/build/debug/multi-step
- **planning**: mentions design/plan/strategy/research
- else **simple**

You can add forced keyword lists with:
- `rules.forceComplexKeywords`
- `rules.forceCodingKeywords`

## Todoist Integration

When the agent completes a Todoist task via `complete-tasks` (mcporter tool), the plugin automatically:
1. Detects the completion
2. Resets the model to OpenClaw's default
3. The agent announces the return on the next turn

**Workflow:**
1. User: "Build the AdvancedMD tool"
2. Agent creates Todoist task, model switches to Opus
3. Agent works on the task
4. Agent completes the task → calls `complete-tasks`
5. Plugin detects completion → auto-return to default model

## Install
Add to your `openclaw.json` under `plugins.entries` pointing at the local folder or package name.
