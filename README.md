# OpenClaw Model Selector Plugin v3

Smart model routing with cost optimization AND multi-agent collaboration support.

## Features

### Core Routing
- **Default**: Gemini Flash for all casual chat and simple tasks
- **Task Detection**: Classifies incoming messages as `simple`, `planning`, `complex`, or `coding`
- **Approval Flow**: Suggests model upgrades, waits for user approval before switching
- **Auto-Return**: Returns to Flash when a Bead is closed (task complete)

### Collaboration Mode (NEW in v3)
When two agents share a collaboration channel, they coordinate model selection to ensure **diverse perspectives**:

- Agent A switches to Opus → Agent B automatically picks Gemini Pro (and vice versa)
- Model announcements are detected via pattern matching
- Ensures Anthropic + Google perspectives on the same problem

### Fallback Chain
When rate limits are hit:
1. Try Sonnet 4.5
2. Try Haiku 4.5
3. Fall back to Gemini Flash

## Configuration

```json
{
  "plugins": {
    "openclaw-model-selector": {
      "enabled": true,
      "defaultModel": "gemini-flash",
      "collaborationChannel": "1468402814106468402",
      "agentId": "steve",
      "models": {
        "simple": ["gemini-flash", "sonnet-4-5", "haiku-4-5"],
        "planning": ["gemini-pro", "opus"],
        "complex": ["opus", "gemini-pro"],
        "coding": ["gpt", "opus", "gemini-pro"]
      },
      "modelComplements": {
        "opus": "gemini-pro",
        "gemini-pro": "opus",
        "gpt": "opus"
      },
      "fallbackChain": ["sonnet-4-5", "haiku-4-5", "gemini-flash"]
    }
  }
}
```

## Model Announcement Format

When switching models in collaboration mode, announce using this format:

```
📢 MODEL: [model] for [task type]
```

Examples:
- `📢 MODEL: opus for complex orchestration`
- `📢 MODEL: gpt for coding task`
- `📢 MODEL: gemini-pro for planning/design work`

The plugin detects these announcements from other agents and picks the complement.

## Task Classification

| Signal Keywords | Category | Primary Models |
|----------------|----------|----------------|
| `write code`, `debug`, `refactor`, ``` | coding | gpt, opus |
| `orchestrate`, `multi-agent`, `architect` | complex | opus, gemini-pro |
| `design`, `plan`, `strategy`, `research` | planning | gemini-pro, opus |
| (everything else) | simple | gemini-flash |

## Approval Triggers

The plugin listens for these phrases to approve a model switch:
- "go ahead", "proceed", "approved", "yes", "lgtm", "ship it"

Override triggers to stay on Flash:
- "stick with flash", "stay on flash", "no switch"

## Changelog

### v3.0.0
- Added collaboration mode with model complement detection
- Added fallback chain for rate limit handling
- Enhanced task classification signals
- Model announcement pattern matching

### v2.0.0
- Added task classification and model suggestions
- Added Bead integration for auto-return

### v1.0.0
- Initial release with basic model routing
