/**
 * OpenClaw Model Selector Plugin v4
 *
 * Auto-switching model routing with fallbacks:
 * - Classifies tasks into categories
 * - Auto-switches to best model (no approval needed)
 * - Falls back through model list if primary unavailable
 * - Returns to default when Todoist task completes
 *
 * Categories:
 * - simple: stays on default (haiku)
 * - moderate: research, writing, analysis → sonnet, gemini-flash
 * - coding: code tasks → opus, sonnet, gemini-flash
 * - complex: orchestration, architecture → opus, gemini-pro
 * - audit: security/code review → gpt-5.2, opus
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

type TaskCategory = "simple" | "moderate" | "coding" | "complex" | "audit";

interface ModelSelectorConfig {
  enabled?: boolean;
  announceSwitch?: boolean;
  models?: {
    simple?: string[];
    moderate?: string[];
    coding?: string[];
    complex?: string[];
    audit?: string[];
  };
}

interface SessionState {
  currentModel: string | null; // null = on default model
  needsReturnAnnouncement: boolean;
}

// ============================================================================
// Defaults (easy to update as models evolve)
// ============================================================================

const DEFAULT_CONFIG: Required<Omit<ModelSelectorConfig, "enabled">> & { enabled: boolean } = {
  enabled: true,
  announceSwitch: true,
  models: {
    // Tier 1: Stay on default (haiku)
    simple: [],
    // Tier 2: Research, writing, analysis
    moderate: ["sonnet", "gemini-flash"],
    // Tier 3: Coding tasks (Opus for deep reasoning, fallback to faster models)
    coding: ["opus", "sonnet", "gemini-flash"],
    // Tier 3: Orchestration, architecture, system design
    complex: ["opus", "gemini-pro"],
    // Tier 3: Security audits, code review (GPT 5.2 is "thorough")
    audit: ["openai-codex/gpt-5.2", "opus"],
  },
};

// ============================================================================
// Classification Signals
// ============================================================================

// Audit signals (check first - most specific)
const AUDIT_SIGNALS = [
  "audit",
  "security review",
  "code review",
  "find bugs",
  "vulnerability",
  "penetration",
  "compliance",
  "thorough review",
];

// Coding signals
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
  "function",
  "class",
  "module",
];

// Complex/orchestration signals
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
  "infrastructure",
  "build the",
  "create the system",
  "design the",
  "multi-step workflow",
  "complex workflow",
];

// Moderate signals (research, writing, analysis)
const MODERATE_SIGNALS = [
  "research",
  "analyze",
  "evaluate",
  "compare",
  "summarize",
  "investigate",
  "look into",
  "find out about",
  "what do you think",
  "help me understand",
  "explain in detail",
  "draft",
  "write a",
  "document",
  "proposal",
  "email",
  "report",
  "memo",
  "outline",
];

function classifyTask(text: string): TaskCategory {
  const t = text.toLowerCase();

  // Check audit first (most specific, high-stakes)
  if (AUDIT_SIGNALS.some((s) => t.includes(s))) return "audit";

  // Check complex orchestration
  if (COMPLEX_SIGNALS.some((s) => t.includes(s))) return "complex";

  // Check coding
  if (CODING_SIGNALS.some((s) => t.includes(s))) return "coding";

  // Check moderate (research, writing)
  if (MODERATE_SIGNALS.some((s) => t.includes(s))) return "moderate";

  // Default to simple (stays on haiku)
  return "simple";
}

function getPrimaryModel(category: TaskCategory, cfg: ModelSelectorConfig): string | null {
  const models = cfg.models ?? DEFAULT_CONFIG.models;
  const categoryModels = models[category] ?? DEFAULT_CONFIG.models[category];
  if (Array.isArray(categoryModels) && categoryModels.length > 0) {
    return categoryModels[0];
  }
  return null;
}

function getModelList(category: TaskCategory, cfg: ModelSelectorConfig): string[] {
  const models = cfg.models ?? DEFAULT_CONFIG.models;
  const categoryModels = models[category] ?? DEFAULT_CONFIG.models[category];
  return Array.isArray(categoryModels) ? categoryModels : [];
}

// ============================================================================
// State Management
// ============================================================================

const sessionStates = new Map<string, SessionState>();

function getState(sessionKey: string): SessionState {
  if (!sessionStates.has(sessionKey)) {
    sessionStates.set(sessionKey, {
      currentModel: null,
      needsReturnAnnouncement: false,
    });
  }
  return sessionStates.get(sessionKey)!;
}

// ============================================================================
// Injection Builders
// ============================================================================

function buildSwitchInjection(category: TaskCategory, model: string, fallbacks: string[]): string {
  const categoryLabels: Record<TaskCategory, string> = {
    simple: "simple task",
    moderate: "research/analysis",
    coding: "coding task",
    complex: "complex orchestration",
    audit: "audit/review",
  };

  const fallbackNote = fallbacks.length > 0
    ? `Fallbacks if needed: ${fallbacks.join(", ")}`
    : "No fallbacks configured";

  return [
    "MODEL ROUTING (auto-switch):",
    `Task: ${categoryLabels[category]}`,
    `Switching to: ${model}`,
    fallbackNote,
    "",
    "INSTRUCTIONS:",
    `- Call session_status({ model: "${model}" }) immediately`,
    `- Briefly note: "⚡ ${model} for ${categoryLabels[category]}"`,
    `- Then proceed with the task`,
  ].join("\n");
}

function buildReturnToDefaultInjection(): string {
  return [
    "MODEL ROUTING (auto-return):",
    "Task complete — returning to default model.",
    "",
    "INSTRUCTIONS:",
    `- Call session_status({ model: "default" })`,
    `- Note: "⚡ Back to default model"`,
  ].join("\n");
}

// ============================================================================
// Plugin Definition
// ============================================================================

const plugin = {
  id: "openclaw-model-selector",
  name: "Model Selector",
  description: "Auto-switching model routing with fallbacks per task category",
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

    api.logger.info(`[model-selector] Registered (auto-switch mode)`);

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
          api.logger.info(`[model-selector] Returning to default model`);
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

        // Classify the incoming message
        const category = classifyTask(userText);

        // If simple, no switch needed
        if (category === "simple") {
          return;
        }

        // Get model for this category
        const modelList = getModelList(category, cfg);
        const primaryModel = modelList[0];

        if (!primaryModel) {
          return; // No models configured for this category
        }

        // Don't re-switch if already on this model
        if (state.currentModel === primaryModel) {
          return;
        }

        api.logger.info(`[model-selector] Auto-switching to ${primaryModel} for ${category}`);

        state.currentModel = primaryModel;
        const fallbacks = modelList.slice(1);
        const injection = buildSwitchInjection(category, primaryModel, fallbacks);
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
          api.logger.info(`[model-selector] Task completed — queuing return to default`);
          state.currentModel = null;
          state.needsReturnAnnouncement = true;
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
