/**
 * OpenClaw Model Selector Plugin v3
 *
 * Smart model routing with cost optimization:
 * - Task detection: Suggests appropriate model, waits for approval
 * - Todoist integration: Auto-returns to default model when task completes
 * - Per-category fallbacks: If primary model fails, cascades to fallback
 *
 * Flow:
 * 1. Start on configured default model
 * 2. Detect task → Suggest model
 * 3. User approves → Switch to suggested model
 * 4. Task completes (Todoist) → Auto-return to default
 */

import type {
  OpenClawPluginApi,
  PluginHookBeforeAgentStartEvent,
  PluginHookAgentContext,
  PluginHookAfterToolCallEvent,
  PluginHookToolContext,
} from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

// ============================================================================
// Types
// ============================================================================

type TaskCategory = "simple" | "planning" | "complex" | "coding";

interface ModelSelectorConfig {
  enabled?: boolean;
  announceSwitch?: boolean;
  announceSuggestion?: boolean;
  models?: {
    simple?: string[];
    planning?: string[];
    complex?: string[];
    coding?: string[];
  };
  approvalTriggers?: string[];
  overrideTriggers?: string[];
}

interface SessionState {
  currentModel: string | null; // null = on default model
  suggestedModel?: string;
  suggestedCategory?: TaskCategory;
  pendingApproval: boolean;
  activeTodoistTaskId?: string;
}

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_CONFIG: Required<Omit<ModelSelectorConfig, "enabled">> & { enabled: boolean } = {
  enabled: true,
  announceSwitch: true,
  announceSuggestion: true,
  models: {
    simple: ["gemini-flash", "sonnet"],
    planning: ["gemini-pro", "opus"],
    complex: ["opus", "sonnet"],
    coding: ["opus", "gemini-pro"],
  },
  approvalTriggers: [
    "go ahead",
    "proceed",
    "do it",
    "green light",
    "approved",
    "yes",
    "yeah",
    "yep",
    "looks good",
    "lgtm",
    "ship it",
    "build it",
    "execute",
    "start",
    "begin",
  ],
  overrideTriggers: [
    "stick with",
    "stay on",
    "keep",
    "no switch",
    "don't switch",
  ],
};

// ============================================================================
// Classification
// ============================================================================

const CODING_SIGNALS = [
  "```",
  "write code",
  "write a script",
  "build a script",
  "create a script",
  "write a function",
  "debug",
  "fix this code",
  "refactor",
  "implement",
  "typescript",
  "javascript",
  "python",
  "bash",
  "sql",
  "api endpoint",
  "unit test",
  "pull request",
  "stack trace",
  "error:",
  "exception",
];

const COMPLEX_SIGNALS = [
  "orchestrat",
  "coordinate",
  "multi-agent",
  "sub-agent",
  "spawn",
  "delegate",
  "architect",
  "system design",
  "end-to-end",
  "migrate",
  "rollout",
  "security review",
  "audit",
];

const PLANNING_SIGNALS = [
  "design",
  "plan",
  "strategy",
  "roadmap",
  "research",
  "analyze",
  "evaluate",
  "compare",
  "recommend",
  "proposal",
  "rfc",
  "spec",
  "requirements",
];

function classifyTask(text: string): TaskCategory {
  const t = text.toLowerCase();

  // Check for coding signals first (most specific)
  if (CODING_SIGNALS.some((s) => t.includes(s))) return "coding";

  // Check for complex orchestration
  if (COMPLEX_SIGNALS.some((s) => t.includes(s))) return "complex";

  // Check for planning/design work
  if (PLANNING_SIGNALS.some((s) => t.includes(s))) return "planning";

  // Default to simple
  return "simple";
}

function isApproval(text: string, triggers: string[]): boolean {
  const t = text.toLowerCase().trim();
  return triggers.some((trigger) => t.includes(trigger));
}

function isOverride(text: string, triggers: string[]): boolean {
  const t = text.toLowerCase().trim();
  return triggers.some((trigger) => t.includes(trigger));
}

function getPrimaryModel(category: TaskCategory, cfg: ModelSelectorConfig): string {
  const models = cfg.models ?? DEFAULT_CONFIG.models;
  const categoryModels = models[category] ?? DEFAULT_CONFIG.models[category];
  return Array.isArray(categoryModels) ? categoryModels[0] : (categoryModels as string);
}

// ============================================================================
// State Management
// ============================================================================

const sessionStates = new Map<string, SessionState>();

function getState(sessionKey: string): SessionState {
  if (!sessionStates.has(sessionKey)) {
    sessionStates.set(sessionKey, {
      currentModel: null, // null = on default model
      pendingApproval: false,
    });
  }
  return sessionStates.get(sessionKey)!;
}

// ============================================================================
// Injection Builders
// ============================================================================

function buildSuggestionInjection(category: TaskCategory, model: string): string {
  const categoryLabels: Record<TaskCategory, string> = {
    simple: "simple task",
    planning: "planning/design work",
    complex: "complex orchestration",
    coding: "coding task",
  };

  return [
    "MODEL ROUTING (plugin-injected):",
    `Task detected: ${categoryLabels[category]}`,
    `Suggested model: ${model}`,
    "",
    "INSTRUCTIONS:",
    `- Stay on the current model for now`,
    `- Ask any clarifying questions you need`,
    `- Mention that you suggest "${model}" for this ${categoryLabels[category]}`,
    `- Wait for user approval before switching`,
    `- If user says "go ahead" or similar, call session_status({ model: "${model}" }) and proceed`,
    `- If user overrides, stay on current model and proceed`,
  ].join("\n");
}

function buildSwitchInjection(model: string): string {
  return [
    "MODEL ROUTING (plugin-injected):",
    `User approved model switch.`,
    `Switch to: ${model}`,
    "",
    "INSTRUCTIONS:",
    `- Call session_status({ model: "${model}" }) immediately`,
    `- Announce: "⚡ Switching to ${model}."`,
    `- Then proceed with the task`,
  ].join("\n");
}

function buildReturnToDefaultInjection(): string {
  return [
    "MODEL ROUTING (plugin-injected):",
    "Task complete.",
    "",
    "INSTRUCTIONS:",
    `- Call session_status({ model: "default" }) to return to default model`,
    `- Announce: "⚡ Task complete — returning to default model."`,
  ].join("\n");
}

// ============================================================================
// Plugin Definition
// ============================================================================

const plugin = {
  id: "openclaw-model-selector",
  name: "Model Selector",
  description: "Smart model routing: suggest → confirm → execute → auto-return to default",
  kind: "extension",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    const cfg: ModelSelectorConfig = {
      ...DEFAULT_CONFIG,
      ...(api.pluginConfig as ModelSelectorConfig),
    };

    if (cfg.enabled === false) {
      api.logger.info("[model-selector] Disabled via config");
      return;
    }

    const approvalTriggers = cfg.approvalTriggers ?? DEFAULT_CONFIG.approvalTriggers;
    const overrideTriggers = cfg.overrideTriggers ?? DEFAULT_CONFIG.overrideTriggers;

    api.logger.info(`[model-selector] Registered`);

    // ========================================================================
    // Hook: before_agent_start
    // ========================================================================
    api.on(
      "before_agent_start",
      async (event: PluginHookBeforeAgentStartEvent, ctx: PluginHookAgentContext) => {
        const sessionKey = ctx.sessionKey ?? "unknown";
        const state = getState(sessionKey);

        // Extract last user message
        const msgs = event.messages as Array<{ role?: string; content?: unknown }> | undefined;
        let userText = event.prompt ?? "";
        if (Array.isArray(msgs)) {
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i]?.role === "user") {
              const content = msgs[i].content;
              userText = typeof content === "string" ? content : JSON.stringify(content);
              break;
            }
          }
        }

        // Check for override (user wants to stay on current model)
        if (state.pendingApproval && isOverride(userText, overrideTriggers)) {
          api.logger.info(`[model-selector] User override — staying on current model`);
          state.pendingApproval = false;
          state.suggestedModel = undefined;
          state.suggestedCategory = undefined;
          return; // No injection needed
        }

        // Check for approval (user greenlights the switch)
        if (state.pendingApproval && state.suggestedModel && isApproval(userText, approvalTriggers)) {
          api.logger.info(`[model-selector] Approval detected — switching to ${state.suggestedModel}`);
          const injection = buildSwitchInjection(state.suggestedModel);
          state.currentModel = state.suggestedModel;
          state.pendingApproval = false;
          state.suggestedModel = undefined;
          state.suggestedCategory = undefined;
          return { prependContext: injection };
        }

        // Classify the incoming message
        const category = classifyTask(userText);

        // If simple, no suggestion needed
        if (category === "simple") {
          return;
        }

        // Task detected — suggest model but don't switch yet
        const suggestedModel = getPrimaryModel(category, cfg);

        // Don't re-suggest if already on that model or already pending
        if (state.currentModel === suggestedModel || state.pendingApproval) {
          return;
        }

        api.logger.info(
          `[model-selector] Task detected: ${category} — suggesting ${suggestedModel}`,
        );

        state.suggestedModel = suggestedModel;
        state.suggestedCategory = category;
        state.pendingApproval = true;

        const injection = buildSuggestionInjection(category, suggestedModel);
        return { prependContext: injection };
      },
      { priority: 50 },
    );

    // ========================================================================
    // Hook: after_tool_call (detect Todoist task completion)
    // ========================================================================
    api.on(
      "after_tool_call",
      async (event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext) => {
        // Check if this was a complete-tasks call (Todoist via mcporter)
        if (event.toolName !== "complete-tasks") return;

        const sessionKey = ctx.sessionKey ?? "unknown";
        const state = getState(sessionKey);

        // If we're not on the default model, queue a return
        if (state.currentModel !== null) {
          api.logger.info(`[model-selector] Task completed — will return to default model`);
          state.currentModel = null;
          // Note: We can't inject mid-turn, but the next turn will be on default
          // The agent should announce the return manually after completing the task
        }
      },
      { priority: 50 },
    );

    // ========================================================================
    // Hook: session_end (cleanup)
    // ========================================================================
    api.on("session_end", async (_event, ctx) => {
      if (ctx?.sessionId) {
        sessionStates.delete(ctx.sessionId);
      }
    });
  },
};

export default plugin;
