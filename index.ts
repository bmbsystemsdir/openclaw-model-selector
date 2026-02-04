/**
 * OpenClaw Model Selector Plugin v3
 *
 * Smart model routing with cost optimization AND agent collaboration:
 * - Default: Gemini Flash for all conversations
 * - Task detection: Suggests appropriate model, waits for approval
 * - Bead integration: Auto-returns to Flash when bead closes
 * - Per-category fallbacks: If primary model fails, cascades to fallback
 * - COLLABORATION MODE: When in designated channel, coordinates with other agents
 *   to ensure model diversity (different perspectives on same problem)
 *
 * Flow:
 * 1. Flash (default) - Clarification phase
 * 2. Detect task → Suggest model (stay on Flash)
 * 3. User approves → Switch to suggested model
 * 4. In collab channel → Check other agent's model, pick complement
 * 5. Announce model choice for coordination
 * 6. Bead closes → Auto-return to Flash
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
  collaborationAutoSwitch?: boolean;
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
  agentId?: string;
  modelComplements?: Record<string, string>;
  fallbackChain?: string[];
}

interface SessionState {
  currentModel: string;
  suggestedModel?: string;
  suggestedCategory?: TaskCategory;
  pendingApproval: boolean;
  activeBeadId?: string;
  lastAnnouncedModel?: string;
  lastCheckedMessageId?: string;
}

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_CONFIG: Required<Omit<ModelSelectorConfig, "enabled">> & { enabled: boolean } = {
  enabled: true,
  announceSwitch: true,
  announceSuggestion: true,
  defaultModel: "gemini-flash",
  collaborationAutoSwitch: true,
  models: {
    simple: ["gemini-flash", "sonnet-4-5", "haiku-4-5"],
    planning: ["gemini-pro", "opus"],
    complex: ["opus", "gemini-pro"],
    coding: ["gpt", "opus", "gemini-pro"],
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
  // Collaboration defaults
  collaborationChannel: "",
  agentId: "",
  modelComplements: {
    "opus": "gemini-pro",
    "gemini-pro": "opus",
    "gpt": "opus",
    "opus-4-5": "gemini-pro",
    "gemini-3-pro": "opus",
  },
  fallbackChain: ["sonnet-4-5", "haiku-4-5", "gemini-flash"],
};

const COLLABORATION_CHANNEL_ID = "1468402814106468402";

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
  "index.ts",
  "plugin",
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
  "collaborate",
  "work together",
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
  "refine",
  "optimize",
];

const RATE_LIMIT_SIGNALS = [
  "quota",
  "insufficient_quota",
  "capacity",
  "rate limit",
  "429",
  "exhausted",
  "resource_exhausted",
  "overloaded",
  "limit reached",
];

function isRateLimitError(error: any): boolean {
  if (!error) return false;
  const errorStr = typeof error === "string" ? error.toLowerCase() : JSON.stringify(error).toLowerCase();
  
  // Check for 429 status code
  if (error.status === 429 || error.statusCode === 429 || error.code === 429 || errorStr.includes("429")) {
    return true;
  }
  
  // Check for fuzzy match strings
  return RATE_LIMIT_SIGNALS.some(signal => errorStr.includes(signal));
}

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

function getComplementModel(model: string, cfg: ModelSelectorConfig): string {
  const complements = cfg.modelComplements ?? DEFAULT_CONFIG.modelComplements;
  // Normalize model name for lookup
  const normalized = model.toLowerCase().replace(/[^a-z0-9]/g, "-");
  
  // Direct lookup
  if (complements[model]) return complements[model];
  if (complements[normalized]) return complements[normalized];
  
  // Try common aliases
  const aliases: Record<string, string> = {
    "opus": "opus",
    "opus-4-5": "opus",
    "claude-opus-4-5": "opus",
    "gemini-pro": "gemini-pro",
    "gemini-3-pro": "gemini-pro",
    "gpt": "gpt",
    "gpt-5-2": "gpt",
  };
  
  const aliasKey = aliases[normalized] || aliases[model];
  if (aliasKey && complements[aliasKey]) {
    return complements[aliasKey];
  }
  
  // Default: if they're on opus-family, we go gemini-pro; otherwise opus
  if (model.includes("opus") || model.includes("claude")) {
    return "gemini-pro";
  }
  return "opus";
}

// ============================================================================
// Collaboration Detection
// ============================================================================

// Pattern to detect model announcements from other agents
// Format: "📢 MODEL: [model]" or "Switching to [model]" or "📢 Model announcement:"
const MODEL_ANNOUNCEMENT_PATTERNS = [
  /📢\s*MODEL:\s*(\S+)/i,
  /📢\s*Model announcement:.*?(\S+)\s+for/i,
  /Switching to\s+(\S+)\s+for/i,
  /switched to\s+(\S+)/i,
  /now on\s+(\S+)/i,
];

function extractAnnouncedModel(text: string): string | null {
  for (const pattern of MODEL_ANNOUNCEMENT_PATTERNS) {
    const match = text.match(pattern);
    if (match && match[1]) {
      return match[1].toLowerCase().replace(/[*_`]/g, "");
    }
  }
  return null;
}

function isInCollaborationChannel(sessionKey: string, cfg: ModelSelectorConfig): boolean {
  if (!cfg.collaborationChannel) return false;
  return sessionKey.includes(cfg.collaborationChannel);
}

function scanForOtherAgentModel(
  messages: Array<{ role?: string; content?: unknown; name?: string }> | undefined,
  ownAgentId: string,
): string | null {
  if (!messages || !Array.isArray(messages)) return null;
  
  // Scan recent messages (last 20) for model announcements from OTHER agents
  const recent = messages.slice(-20);
  
  for (let i = recent.length - 1; i >= 0; i--) {
    const msg = recent[i];
    // Skip our own messages
    if (msg.role === "assistant") continue;
    
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    
    // Look for model announcements
    const announced = extractAnnouncedModel(content);
    if (announced) {
      return announced;
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
    `- Stay on the current model (Flash) for now`,
    `- Ask any clarifying questions you need`,
    `- Mention that you suggest "${model}" for this ${categoryLabels[category]}`,
    `- Wait for user approval before switching`,
    `- If user says "go ahead" or similar, call session_status({ model: "${model}" }) and proceed`,
    `- If user says "stick with flash" or similar, stay on Flash and proceed`,
  ].join("\n");
}

function buildCollabSuggestionInjection(
  category: TaskCategory, 
  model: string, 
  otherAgentModel: string | null,
  isComplement: boolean,
): string {
  const categoryLabels: Record<TaskCategory, string> = {
    simple: "simple task",
    planning: "planning/design work",
    complex: "complex orchestration",
    coding: "coding task",
  };

  const lines = [
    "MODEL ROUTING (plugin-injected, COLLABORATION MODE):",
    `Task detected: ${categoryLabels[category]}`,
  ];
  
  if (otherAgentModel && isComplement) {
    lines.push(`Other agent is on: ${otherAgentModel}`);
    lines.push(`Suggested model (complement): ${model}`);
  } else {
    lines.push(`Suggested model: ${model}`);
  }
  
  lines.push(
    "",
    "INSTRUCTIONS:",
    `- Stay on the current model (Flash) for now`,
    `- Ask any clarifying questions you need`,
    `- Mention that you suggest "${model}" for this ${categoryLabels[category]}`,
  );
  
  if (otherAgentModel && isComplement) {
    lines.push(`- Note: This complements the other agent's ${otherAgentModel} for diverse perspectives`);
  }
  
  lines.push(
    `- Wait for user approval before switching`,
    `- If user says "go ahead" or similar:`,
    `  1. Call session_status({ model: "${model}" })`,
    `  2. Announce: "📢 MODEL: ${model} for ${categoryLabels[category]}"`,
    `- If user says "stick with flash" or similar, stay on Flash and proceed`,
  );

  return lines.join("\n");
}

function buildSwitchInjection(model: string, category?: TaskCategory): string {
  const categoryLabel = category ? ` for ${category}` : "";
  return [
    "MODEL ROUTING (plugin-injected):",
    `User approved model switch.`,
    `Switch to: ${model}`,
    "",
    "INSTRUCTIONS:",
    `- Call session_status({ model: "${model}" }) immediately`,
    `- Announce: "📢 MODEL: ${model}${categoryLabel}"`,
    `- Then proceed with the task`,
  ].join("\n");
}

function buildReturnToFlashInjection(): string {
  return [
    "MODEL ROUTING (plugin-injected):",
    "Bead closed — task complete.",
    "",
    "INSTRUCTIONS:",
    `- Call session_status({ model: "gemini-flash" })`,
    `- Announce: "⚡ Task complete — back on Gemini Flash."`,
  ].join("\n");
}

function buildRateLimitFallbackInjection(fallbackModel: string, failedModel: string): string {
  return [
    "MODEL ROUTING (plugin-injected):",
    `Rate limit or error detected on ${failedModel}.`,
    `Falling back to: ${fallbackModel}`,
    "",
    "INSTRUCTIONS:",
    `- Call session_status({ model: "${fallbackModel}" })`,
    `- Announce: "⚠️ Rate limit on ${failedModel} — falling back to ${fallbackModel}"`,
    `- Continue with the task`,
  ].join("\n");
}

// ============================================================================
// Plugin Definition
// ============================================================================

const plugin = {
  id: "openclaw-model-selector",
  name: "Model Selector",
  description: "Smart model routing with collaboration support: suggest → confirm → coordinate → execute → auto-return",
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
    const fallbackChain = cfg.fallbackChain ?? DEFAULT_CONFIG.fallbackChain;

    api.logger.info(`[model-selector] Registered (default: ${defaultModel}, collab channel: ${cfg.collaborationChannel || "none"})`);

    // ========================================================================
    // Hook: before_agent_start
    // ========================================================================
    api.on(
      "before_agent_start",
      async (event: PluginHookBeforeAgentStartEvent, ctx: PluginHookAgentContext) => {
        const sessionKey = ctx.sessionKey ?? "unknown";
        const state = getState(sessionKey, defaultModel);
        const inCollabMode = isInCollaborationChannel(sessionKey, cfg);

        // Extract last user message
        const msgs = event.messages as Array<{ role?: string; content?: unknown; name?: string }> | undefined;
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

        // Check for override (user wants to stay on Flash)
        if (state.pendingApproval && isOverride(userText, overrideTriggers)) {
          api.logger.info(`[model-selector] User override — staying on Flash`);
          state.pendingApproval = false;
          state.suggestedModel = undefined;
          state.suggestedCategory = undefined;
          return; // No injection needed
        }

        // Check for approval (user greenlights the switch)
        if (state.pendingApproval && state.suggestedModel && isApproval(userText, approvalTriggers)) {
          api.logger.info(`[model-selector] Approval detected — switching to ${state.suggestedModel}`);
          const injection = buildSwitchInjection(state.suggestedModel, state.suggestedCategory);
          state.currentModel = state.suggestedModel;
          state.lastAnnouncedModel = state.suggestedModel;
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

        // Task detected — determine suggested model
        let suggestedModel = getPrimaryModel(category, cfg);
        let otherAgentModel: string | null = null;
        let isComplement = false;

        // COLLABORATION MODE: Check what the other agent is using
        if (inCollabMode) {
          otherAgentModel = scanForOtherAgentModel(msgs, cfg.agentId ?? "");
          
          if (otherAgentModel) {
            // Other agent announced a model — pick the complement
            const complement = getComplementModel(otherAgentModel, cfg);
            if (complement !== suggestedModel) {
              api.logger.info(
                `[model-selector] Collab mode: other agent on ${otherAgentModel}, switching to complement ${complement}`
              );
              suggestedModel = complement;
              isComplement = true;
            }
          }
        }

        // Don't re-suggest if already on that model or already pending
        if (state.currentModel === suggestedModel || state.pendingApproval) {
          return;
        }

        // COLLABORATION AUTO-SWITCH:
        // If in the memory-audit-shared channel and collabAutoSwitch is enabled,
        // switch immediately without waiting for approval.
        if (
          cfg.collaborationAutoSwitch &&
          sessionKey.includes(COLLABORATION_CHANNEL_ID)
        ) {
          api.logger.info(`[model-selector] Collab auto-switch: ${category} → ${suggestedModel}`);
          const injection = buildSwitchInjection(suggestedModel);
          state.currentModel = suggestedModel;
          return { prependContext: injection };
        }

        api.logger.info(
          `[model-selector] Task detected: ${category} — suggesting ${suggestedModel}${inCollabMode ? " (collab mode)" : ""}`,
        );

        state.suggestedModel = suggestedModel;
        state.suggestedCategory = category;
        state.pendingApproval = true;

        // Build appropriate injection based on mode
        const injection = inCollabMode
          ? buildCollabSuggestionInjection(category, suggestedModel, otherAgentModel, isComplement)
          : buildSuggestionInjection(category, suggestedModel);
          
        return { prependContext: injection };
      },
      { priority: 50 },
    );

    // ========================================================================
    // Hook: after_tool_call (detect bead close + error monitoring)
    // ========================================================================
    api.on(
      "after_tool_call",
      async (event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext) => {
        const sessionKey = ctx.sessionKey ?? "unknown";
        const state = getState(sessionKey, defaultModel);

        // ERROR MONITORING: Fallback on rate limit / capacity errors
        if (event.error && isRateLimitError(event.error)) {
          const category = state.suggestedCategory ?? "complex";
          const models = cfg.models?.[category] ?? DEFAULT_CONFIG.models[category];
          
          if (Array.isArray(models) && models.length > 1) {
            const nextIndex = models.indexOf(state.currentModel) + 1;
            if (nextIndex > 0 && nextIndex < models.length) {
              const fallbackModel = models[nextIndex];
              api.logger.warn(`[model-selector] Rate limit detected. Falling back: ${state.currentModel} → ${fallbackModel}`);
              state.currentModel = fallbackModel;
              
              return { 
                prependContext: `MODEL ROUTING (plugin-injected):\nRate limit/capacity error detected for ${event.toolName}.\nAuto-switching to fallback model: ${fallbackModel}.\n\nPlease retry the previous tool call.` 
              };
            }
          }
        }

        // Check if this was a beads_close call
        if (event.toolName !== "beads_close") return;

        // If we're not on the default model, queue a return
        if (state.currentModel !== defaultModel) {
          api.logger.info(`[model-selector] Bead closed — will return to ${defaultModel}`);
          state.currentModel = defaultModel;
          state.lastAnnouncedModel = undefined;
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
