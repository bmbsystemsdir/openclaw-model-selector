# openclaw-model-selector

Smart model routing plugin for OpenClaw. Saves tokens by defaulting to cheap models and only switching to expensive ones when needed — with your approval.

## How It Works

1. **Default: Gemini Flash** — All conversations start here
2. **Task detected** → Suggests appropriate model, asks clarifying questions (stays on Flash)
3. **You approve** → Switches to suggested model and executes
4. **Bead closes** → Auto-returns to Flash

## Installation

### Option 1: Clone from GitHub
```bash
# Clone to your extensions directory
git clone https://github.com/bmbsystemsdir/openclaw-model-selector.git ~/.openclaw/extensions/openclaw-model-selector

# Enable the plugin
openclaw plugins enable openclaw-model-selector
```

### Option 2: Install via OpenClaw CLI
```bash
openclaw plugins install --link https://github.com/bmbsystemsdir/openclaw-model-selector.git
openclaw plugins enable openclaw-model-selector
```

Then restart the gateway:
```bash
openclaw gateway restart
```

## Configuration

Add to your `~/.openclaw/openclaw.json` under `plugins.entries`:

```json
"openclaw-model-selector": {
  "enabled": true,
  "config": {
    "enabled": true,
    "announceSwitch": true,
    "announceSuggestion": true,
    "defaultModel": "gemini-flash",
    "models": {
      "simple": ["gemini-flash", "sonnet-4-5"],
      "planning": ["gemini-pro", "opus"],
      "complex": ["opus", "gpt"],
      "coding": ["gpt", "gemini-pro"]
    }
  }
}
```

### Model Categories

| Category | Use Case | Default Models |
|----------|----------|----------------|
| `simple` | Chat, Q&A, clarifications | flash → sonnet |
| `planning` | Design, research, strategy | pro → opus |
| `complex` | Multi-agent orchestration | opus → gpt |
| `coding` | Code writing, debugging | gpt → pro |

### Approval Triggers

The plugin recognizes these phrases as approval to switch:
- "go ahead", "proceed", "do it", "green light"
- "approved", "yes", "looks good", "lgtm"
- "ship it", "build it", "execute", "start"

### Override Triggers

Stay on Flash even when a switch is suggested:
- "stick with flash", "stay on flash", "use flash"
- "no switch", "don't switch", "flash is fine"

## Beads Integration

When you close a bead (`bd close`), the plugin automatically returns to Flash. This creates a "cost container" — expensive tokens only used while work is active.

## License

MIT
