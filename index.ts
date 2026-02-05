/**
 * OpenClaw Model Selector Plugin v4
 *
 * Smart model routing with cost optimization + collaboration support:
 * - Default: Gemini Flash for all conversations
 * - Task detection: Suggests appropriate model, waits for approval
 * - Bead integration: Auto-returns to Flash when bead closes
 * - Collaboration: In designated channel, auto-switch to complement model
 *
 * Flow:
 * 1. Flash (default) - Clarification phase
 * 2. Detect task → Suggest model (stay on Flash)
 * 3. User approves → Switch to suggested model
 * 4. Bead closes → Auto-return to Flash
 *
 * Collaboration Flow (in collaboration channel):
 * 1. Detect other agent's model from recent messages
 * 2. Auto-switch to complementary frontier model (no approval needed)
 * 3. Announce: "📢 MODEL: {model}"
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
  defaultModel?: string;
  models?: {
    simple?: string[];
    planning?: string[];
    complex?: string[];
    coding?: string[];
  };
  approvalTriggers?: string[];
  overrideTriggers?: string[];
  // Collaboration settings
  collaborationChannel?: string;
  collaborationAutoSwitch?: boolean;
  modelComplements?: Record<string, string>;
  agentId?: string;
}

interface SessionState {
  currentModel: string;
  suggestedModel?: string;
  suggestedCategory?: TaskCategory;
  pendingApproval: boolean;
  activeBeadId?: string;
}

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_CONFIG: Required<Omit<ModelSelectorConfig, "enabled" | "collaborationChannel" | "agentId">> & {
  enabled: boolean;
  collaborationChannel?: string;
  agentId?: string;
} = {
  enabled: true,
  announceSwitch: true,
  announceSuggestion: true,
  defaultModel: "gemini-flash",
  models: {
    simple: ["gemini-flash", "sonnet-4-5"],
    planning: ["gemini-pro", "opus"],
    complex: ["opus", "gpt"],
    coding: ["gpt", "gemini-pro"],
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
    "stick with flash",
    "stay on flash",
    "keep flash",
    "use flash",
    "just use flash",
    "flash is fine",
    "no switch",
    "don't switch",
  ],
  collaborationAutoSwitch: false,
  modelComplements: {
    opus: "gemini-pro",
    "gemini-pro": "opus",
    gpt: "opus",
  },
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
  if (CODING_SIGNALS.some((s) => t.includes(s))) return "coding";
  if (COMPLEX_SIGNALS.some((s) => t.includes(s))) return "complex";
  if (PLANNING_SIGNALS.some((s) => t.includes(s))) return "planning";
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
// Collaboration Helpers
// ============================================================================

/**
 * Extract channel ID from session key (e.g., "discord:channel:123456" → "123456")
 */
function extractChannelId(sessionKey: string): string | null {
  const match = sessionKey.match(/channel[:\-](\d+)/i);
  return match ? match[1] : null;
}

/**
 * Detect other agent's model from recent messages.
 * Looks for "📢 MODEL: {model}" or "MODEL: {model}" patterns.
 */
function detectOtherAgentModel(
  messages: Array<{ role?: string; content?: unknown }>,
  myAgentId?: string
): string | null {
  // Look backwards through messages for model announcements from other agents
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;

    const content = typeof msg.content === "string" ? msg.content : "";

    // Skip our own messages if we can identify them
    if (myAgentId && content.toLowerCase().includes(myAgentId.toLowerCase())) {
      continue;
    }

    // Look for model announcement pattern
    const modelMatch = content.match(/(?:📢\s*)?MODEL:\s*(\S+)/i);
    if (modelMatch) {
      return modelMatch[1].toLowerCase();
    }
  }
  return null;
}

/**
 * Get complementary model for collaboration.
 */
function getComplementModel(
  otherModel: string,
  complements: Record<string, string>
): string | null {
  // Normalize model name for lookup
  const normalized = otherModel.toLowerCase();
  for (const [key, value] of Object.entries(complements)) {
    if (normalized.includes(key.toLowerCase())) {
      return value;
    }
  }
  return null;
}

// ============================================================================
// State Management
// ============================================================================

const sessionStates = new Map<string, SessionState>();

function getState(sessionKey: string, defaultModel: string): SessionState {
  if (!sessionStates.has(sessionKey)) {
    sessionStates.set(sessionKey, {
      currentModel: defaultModel,
      pendingApproval: false,
    });
  }
  return sessionStates.get(sessionKey)!;
}

// ============================================================================
// Injection Builders
// ============================================================================

function buildSuggestionInjection(category: TaskCategory, model: string): string {
  // Return empty string - suggestion logic is now internal only, no Discord output
  return "";
}

function buildSwitchInjection(model: string): string {
  // Return empty string - switch logic is now internal only, no Discord output
  return "";
}

function buildCollaborationSwitchInjection(model: string, otherModel: string): string {
  // Return empty string - collaboration logic is now internal only, no Discord output
  return "";
}

// ============================================================================
// Plugin Definition
// ============================================================================

const plugin = {
  id: "openclaw-model-selector",
  name: "Model Selector",
  description: "Smart model routing with collaboration support",
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

    const defaultModel = cfg.defaultModel ?? DEFAULT_CONFIG.defaultModel;
    const approvalTriggers = cfg.approvalTriggers ?? DEFAULT_CONFIG.approvalTriggers;
    const overrideTriggers = cfg.overrideTriggers ?? DEFAULT_CONFIG.overrideTriggers;
    const collaborationChannel = cfg.collaborationChannel;
    const collaborationAutoSwitch = cfg.collaborationAutoSwitch ?? false;
    const modelComplements = cfg.modelComplements ?? DEFAULT_CONFIG.modelComplements;
    const agentId = cfg.agentId;

    api.logger.info(
      `[model-selector] Registered (default: ${defaultModel}, collab: ${collaborationAutoSwitch ? collaborationChannel : "off"})`
    );

    // ========================================================================
    // Hook: before_agent_start
    // ========================================================================
    api.on(
      "before_agent_start",
      async (event: PluginHookBeforeAgentStartEvent, ctx: PluginHookAgentContext) => {
        // SAFETY: Wrap entire hook in try/catch
        try {
          const sessionKey = ctx.sessionKey ?? "unknown";
          const state = getState(sessionKey, defaultModel);

          // Extract messages array
          const msgs = event.messages as Array<{ role?: string; content?: unknown }> | undefined;

          // Extract last user message
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

          // ================================================================
          // Collaboration Mode Check
          // ================================================================
          if (collaborationAutoSwitch && collaborationChannel) {
            const currentChannel = extractChannelId(sessionKey);

            if (currentChannel === collaborationChannel && Array.isArray(msgs)) {
              const otherModel = detectOtherAgentModel(msgs, agentId);

              if (otherModel) {
                const complement = getComplementModel(otherModel, modelComplements);

                if (complement && state.currentModel !== complement) {
                  api.logger.info(
                    `[model-selector] Collaboration: other agent on ${otherModel}, switching to ${complement}`
                  );
                  state.currentModel = complement;
                  return { prependContext: buildCollaborationSwitchInjection(complement, otherModel) };
                }
              }
            }
          }

          // ================================================================
          // Standard Flow (non-collaboration)
          // ================================================================

          // Check for override (user wants to stay on Flash)
          if (state.pendingApproval && isOverride(userText, overrideTriggers)) {
            api.logger.info(`[model-selector] User override — staying on Flash`);
            state.pendingApproval = false;
            state.suggestedModel = undefined;
            state.suggestedCategory = undefined;
            return;
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
            `[model-selector] Task detected: ${category} — suggesting ${suggestedModel}`
          );

          state.suggestedModel = suggestedModel;
          state.suggestedCategory = category;
          state.pendingApproval = true;

          const injection = buildSuggestionInjection(category, suggestedModel);
          return { prependContext: injection };
        } catch (err) {
          // SAFETY: Log and continue on any error
          api.logger.warn(`[model-selector] Error in before_agent_start: ${err}`);
          return; // Continue without injection
        }
      },
      { priority: 50 }
    );

    // ========================================================================
    // Hook: after_tool_call (detect bead close)
    // ========================================================================
    api.on(
      "after_tool_call",
      async (event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext) => {
        // SAFETY: Wrap in try/catch
        try {
          if (event.toolName !== "beads_close") return;

          const sessionKey = ctx.sessionKey ?? "unknown";
          const state = getState(sessionKey, defaultModel);

          if (state.currentModel !== defaultModel) {
            api.logger.info(`[model-selector] Bead closed — will return to ${defaultModel}`);
            state.currentModel = defaultModel;
          }
        } catch (err) {
          api.logger.warn(`[model-selector] Error in after_tool_call: ${err}`);
        }
      },
      { priority: 50 }
    );

    // ========================================================================
    // Hook: session_end (cleanup)
    // ========================================================================
    api.on("session_end", async (_event, ctx) => {
      try {
        if (ctx?.sessionId) {
          sessionStates.delete(ctx.sessionId);
        }
      } catch (err) {
        api.logger.warn(`[model-selector] Error in session_end: ${err}`);
      }
    });
  },
};

export default plugin;
