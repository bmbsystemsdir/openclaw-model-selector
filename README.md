# OpenClaw Model Selector v4.0.0

Smart model routing with cost optimization and collaboration support.

## Features

- **Task Detection**: Classifies incoming tasks (simple, planning, complex, coding)
- **Suggest → Approve Flow**: Suggests appropriate model, waits for user approval before switching
- **Auto-Return**: Returns to default model (Gemini Flash) when bead closes
- **Collaboration Mode**: In designated channel, auto-switches to complement model for frontier diversity
- **Bulletproof**: All hooks wrapped in try/catch — errors log warnings but never crash gateway

## Installation

```bash
# Clone to your plugins directory
cd ~/.openclaw/plugins
git clone https://github.com/bmbsystemsdir/openclaw-model-selector.git
```

## Configuration

In your `openclaw.json`:

```json
{
  "plugins": {
    "openclaw-model-selector": {
      "enabled": true,
      "defaultModel": "gemini-flash",
      "collaborationChannel": "YOUR_CHANNEL_ID",
      "collaborationAutoSwitch": true,
      "agentId": "your-agent-name",
      "modelComplements": {
        "opus": "gemini-pro",
        "gemini-pro": "opus",
        "gpt": "opus"
      },
      "models": {
        "simple": ["gemini-flash", "sonnet-4-5"],
        "planning": ["gemini-pro", "opus"],
        "complex": ["opus", "gpt"],
        "coding": ["gpt", "gemini-pro"]
      }
    }
  }
}
```

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable the plugin |
| `defaultModel` | string | `"gemini-flash"` | Default model for all conversations |
| `collaborationChannel` | string | — | Channel ID where collaboration mode is active |
| `collaborationAutoSwitch` | boolean | `false` | Auto-switch to complement model in collab channel |
| `agentId` | string | — | This agent's ID (avoids self-detection) |
| `modelComplements` | object | see below | Model → complement mapping |
| `models` | object | see below | Category → model preferences |
| `approvalTriggers` | string[] | see code | Phrases that approve a model switch |
| `overrideTriggers` | string[] | see code | Phrases that reject a suggestion |

### Default Model Complements

```json
{
  "opus": "gemini-pro",
  "gemini-pro": "opus",
  "gpt": "opus"
}
```

## Flows

### Standard Flow (non-collaboration)

1. User sends message
2. Plugin classifies task → suggests model
3. Agent asks clarifying questions (stays on Flash)
4. User approves ("go ahead") → switch happens
5. Task completes, bead closes → auto-return to Flash

### Collaboration Flow

1. In collaboration channel, plugin detects other agent's model announcement
2. Automatically switches to complement model (no approval needed)
3. Announces: "📢 MODEL: {model}"
4. Provides frontier model diversity for complex multi-agent tasks

## Safety

All hooks are wrapped in try/catch. On any error:
- Warning logged: `[model-selector] Error in {hook}: {error}`
- Plugin continues without injection
- Gateway never crashes due to plugin errors

## Changelog

### v4.0.0
- Reverted to clean v2 base
- Added collaboration mode with model complements
- Added try/catch safety wrappers on all hooks
- Simplified codebase (~400 lines vs ~600 in v3.x)

### v3.x (deprecated)
- Over-engineered collaboration features
- Caused gateway crashes due to insufficient error handling

### v2.0.0
- Original working version
- Task detection + approval flow
- Auto-return on bead close
