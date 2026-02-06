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

type TaskCategory = "simple" | "moderate" | "complex" | "coding";

interface ModelSelectorConfig {
  enabled?: boolean;
  announceSwitch?: boolean;
  announceSuggestion?: boolean;
  models?: {
    simple?: string[];      // Tier 1: stay on default (haiku)
    moderate?: string[];    // Tier 2: sonnet, gemini-flash
    complex?: string[];     // Tier 3: opus, gemini-pro, gpt-5.2
    coding?: string[];      // Tier 3: opus, gemini-pro
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
  needsReturnAnnouncement: boolean; // Set when task completes, triggers return injection
}

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_CONFIG: Required<Omit<ModelSelectorConfig, "enabled">> & { enabled: boolean } = {
  enabled: true,
  announceSwitch: true,
  announceSuggestion: true,
  models: {
    // Tier 1: Stay on default (haiku) - no upgrade needed
    simple: [],
    // Tier 2: Mid-weight - research, multi-step, analysis
    moderate: ["sonnet", "gemini-flash"],
    // Tier 3: Heavy - architecture, orchestration, planning
    complex: ["opus", "gemini-pro", "openai-codex/gpt-5.2"],
    // Tier 3: Coding - needs the best reasoning
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

// Tier 3: Coding - needs best reasoning for code generation/debugging
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

// Tier 3: Complex - orchestration, architecture, major builds
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
  "build the",
  "create the",
  "design the system",
  "infrastructure",
];

// Tier 2: Moderate - research, analysis, multi-step but not heavy
const MODERATE_SIGNALS = [
  "research",
  "analyze",
  "evaluate",
  "compare",
  "recommend",
  "summarize",
  "review",
  "investigate",
  "look into",
  "find out",
  "what do you think",
  "help me understand",
  "explain",
  "multi-step",
  "several steps",
];

function classifyTask(text: string): TaskCategory {
  const t = text.toLowerCase();

  // Tier 3: Check for coding signals first (most specific)
  if (CODING_SIGNALS.some((s) => t.includes(s))) return "coding";

  // Tier 3: Check for complex orchestration/architecture
  if (COMPLEX_SIGNALS.some((s) => t.includes(s))) return "complex";

  // Tier 2: Check for moderate work (research, analysis, multi-step)
  if (MODERATE_SIGNALS.some((s) => t.includes(s))) return "moderate";

  // Tier 1: Default to simple (stays on haiku)
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

function getPrimaryModel(category: TaskCategory, cfg: ModelSelectorConfig): string | null {
  const models = cfg.models ?? DEFAULT_CONFIG.models;
  const categoryModels = models[category] ?? DEFAULT_CONFIG.models[category];
  if (Array.isArray(categoryModels) && categoryModels.length > 0) {
    return categoryModels[0];
  }
  return null; // No upgrade needed (e.g., simple stays on default)
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
      needsReturnAnnouncement: false,
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
    moderate: "research/analysis work",
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

        // Check if we need to return to default (after task completion)
        if (state.needsReturnAnnouncement) {
          api.logger.info(`[model-selector] Task completed — returning to default model`);
          const injection = buildReturnToDefaultInjection();
          state.needsReturnAnnouncement = false;
          return { prependContext: injection };
        }

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

        // If simple, no suggestion needed (stays on default)
        if (category === "simple") {
          return;
        }

        // Task detected — get suggested model for this category
        const suggestedModel = getPrimaryModel(category, cfg);

        // If no model configured for this category, or empty list, stay on default
        if (!suggestedModel) {
          return;
        }

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

        // If we're on an upgraded model, queue a return to default
        if (state.currentModel !== null) {
          api.logger.info(`[model-selector] Task completed — queuing return to default model`);
          state.currentModel = null;
          state.needsReturnAnnouncement = true;
          // Next turn will inject return-to-default instructions
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
