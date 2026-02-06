/**
 * OpenClaw Model Selector Plugin v5
 *
 * Approval-first model routing with fallbacks:
 * - Classify task + suggest best model (wait for approval)
 * - User approves model suggestion
 * - Switch to approved model, then plan + execute
 * - Falls back through model list if primary unavailable
 * - Returns to default when Todoist task completes
 *
 * Categories:
 * - simple: stays on default (haiku)
 * - moderate: research, writing, analysis, data review → sonnet, gemini-flash
 * - coding: code generation, debugging → opus, sonnet, gemini-flash
 * - complex: orchestration, architecture, major projects → opus, gemini-pro
 * - security-audit: code review, security review, bug hunting → gpt-5.2, opus
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

type TaskCategory = "simple" | "moderate" | "coding" | "complex" | "security-audit";

interface ModelSelectorConfig {
  enabled?: boolean;
  announceSwitch?: boolean;
  models?: {
    simple?: string[];
    moderate?: string[];
    coding?: string[];
    complex?: string[];
    "security-audit"?: string[];
  };
}

interface SessionState {
  currentModel: string | null; // null = on default model
  needsReturnAnnouncement: boolean;
  suggestedModel?: string; // Pending approval
  suggestedCategory?: TaskCategory;
  suggestedFallbacks?: string[];
  pendingApproval: boolean;
}

// ============================================================================
// Defaults (easy to update as models evolve)
// ============================================================================

const DEFAULT_CONFIG: Required<Omit<ModelSelectorConfig, "enabled">> & { enabled: boolean } = {
  enabled: true,
  announceSwitch: true,
  models: {
    // Tier 1: Stay on default (haiku) - simple Q&A, quick tasks
    simple: [],
    // Tier 2: Research, writing, analysis, data review
    moderate: ["sonnet", "gemini-flash"],
    // Tier 3: Code generation, debugging, implementation
    coding: ["opus", "sonnet", "gemini-flash"],
    // Tier 3: Orchestration, architecture, system design, major projects
    complex: ["opus", "gemini-pro"],
    // Tier 3: Security reviews, code audits, thorough bug hunts (GPT 5.2 is "thorough")
    "security-audit": ["openai-codex/gpt-5.2", "opus"],
  },
};

// ============================================================================
// Classification Signals
// ============================================================================

// Security/Code audit signals (check first - most specific)
// Note: "audit my tasks" or "review this data" go to MODERATE, not here
const SECURITY_AUDIT_SIGNALS = [
  "security review",
  "code review",
  "find bugs in",
  "find vulnerabilities",
  "security audit",
  "code audit",
  "penetration test",
  "compliance review",
  "security issue",
  "vulnerability assessment",
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

// Complex/orchestration signals (including major academic projects)
const COMPLEX_SIGNALS = [
  // Technical orchestration
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
  // Major academic projects
  "dissertation",
  "comprehensive exam",
  "systematic theology",
  "research project",
  "capstone",
];

// Moderate signals (research, writing, analysis, data review, academic)
const MODERATE_SIGNALS = [
  // General research/analysis
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
  // Data/task review (audit of data, not security)
  "audit my tasks",
  "review my list",
  "clean up",
  "organize",
  "tidy up",
  "consolidate",
  // Writing
  "draft",
  "write a",
  "document",
  "proposal",
  "email",
  "report",
  "memo",
  "outline",
  // Academic/Seminary
  "essay",
  "paper",
  "thesis",
  "sermon",
  "exegesis",
  "hermeneutic",
  "commentary",
  "bibliography",
  "citation",
  "literature review",
  "study guide",
  "lecture notes",
  "greek",
  "hebrew",
  "theological",
  "doctrine",
  "scripture",
];

function classifyTask(text: string): TaskCategory {
  const t = text.toLowerCase();

  // Check security audit first (most specific, high-stakes)
  if (SECURITY_AUDIT_SIGNALS.some((s) => t.includes(s))) return "security-audit";

  // Check complex orchestration
  if (COMPLEX_SIGNALS.some((s) => t.includes(s))) return "complex";

  // Check coding
  if (CODING_SIGNALS.some((s) => t.includes(s))) return "coding";

  // Check moderate (research, writing, data review)
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
      pendingApproval: false,
    });
  }
  return sessionStates.get(sessionKey)!;
}

// ============================================================================
// Injection Builders
// ============================================================================

function buildSuggestionInjection(category: TaskCategory, model: string, fallbacks: string[]): string {
  const categoryLabels: Record<TaskCategory, string> = {
    simple: "simple task",
    moderate: "research/analysis",
    coding: "coding task",
    complex: "complex orchestration",
    "security-audit": "security/code audit",
  };

  const fallbackNote = fallbacks.length > 0
    ? `Fallbacks if needed: ${fallbacks.join(", ")}`
    : "No fallbacks configured";

  return [
    "MODEL ROUTING (plugin-injected):",
    `Task detected: ${categoryLabels[category]}`,
    `Suggested model: ${model}`,
    fallbackNote,
    "",
    "INSTRUCTIONS (all in one response):",
    `1. Restate your understanding: "I understand you want to..."`,
    `2. Ask clarifying questions if needed: "Quick question: ...?"`,
    `3. Suggest the model: "This is ${categoryLabels[category]}, so I suggest ${model}"`,
    `4. Wait for user approval in one shot (they can validate task + model together)`,
    ``,
    "Approval keywords: 'go ahead', 'proceed', 'yes', 'approve'",
    "Override keywords: 'stay on', 'keep', 'no switch'",
    "",
    `5. Once approved: call session_status({ model: "${model}" }) then plan + execute`,
  ].join("\n");
}

function buildSwitchInjection(category: TaskCategory, model: string, fallbacks: string[]): string {
  const categoryLabels: Record<TaskCategory, string> = {
    simple: "simple task",
    moderate: "research/analysis",
    coding: "coding task",
    complex: "complex orchestration",
    "security-audit": "security/code audit",
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

        // Handle pending approval
        if (state.pendingApproval && state.suggestedModel) {
          // Check for approval or override
          const t = userText.toLowerCase();
          const approves = ["go ahead", "proceed", "yes", "yep", "approve", "ok", "do it", "lgtm"];
          const overrides = ["stay on", "stay with", "keep current", "no switch", "use default"];

          if (approves.some((a) => t.includes(a))) {
            api.logger.info(
              `[model-selector] Approval detected for ${state.suggestedModel}`,
            );
            const injection = buildSwitchInjection(
              state.suggestedCategory!,
              state.suggestedModel,
              state.suggestedFallbacks || [],
            );
            state.currentModel = state.suggestedModel;
            state.pendingApproval = false;
            state.suggestedModel = undefined;
            state.suggestedCategory = undefined;
            state.suggestedFallbacks = undefined;
            return { prependContext: injection };
          }

          if (overrides.some((o) => t.includes(o))) {
            api.logger.info(`[model-selector] Override detected — staying on current model`);
            state.pendingApproval = false;
            state.suggestedModel = undefined;
            state.suggestedCategory = undefined;
            state.suggestedFallbacks = undefined;
            return; // Don't inject anything, just proceed on current model
          }

          // Still waiting for approval, don't process this message as a new task
          return;
        }

        // Classify the incoming message
        const category = classifyTask(userText);

        // If simple, no suggestion needed
        if (category === "simple") {
          return;
        }

        // Get model for this category
        const modelList = getModelList(category, cfg);
        const primaryModel = modelList[0];

        if (!primaryModel) {
          return; // No models configured for this category
        }

        // Don't re-suggest if already on this model
        if (state.currentModel === primaryModel) {
          return;
        }

        api.logger.info(`[model-selector] Suggesting ${primaryModel} for ${category}`);

        state.suggestedModel = primaryModel;
        state.suggestedCategory = category;
        state.suggestedFallbacks = modelList.slice(1);
        state.pendingApproval = true;

        const injection = buildSuggestionInjection(
          category,
          primaryModel,
          state.suggestedFallbacks,
        );
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
