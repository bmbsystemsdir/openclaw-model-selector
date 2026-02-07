/**
 * OpenClaw Model Selector Plugin v8
 *
 * Hybrid classification: keyword matching + Gemini LLM fallback.
 * Approval-first model routing with announce-and-switch completion:
 * - Classify task + suggest best model (wait for approval)
 * - User approves → switch to approved model
 * - Agent completes task → announces switch-back and switches (opt-out override)
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
} from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

// ============================================================================
// LLM Classification Fallback
// ============================================================================

const CLASSIFICATION_PROMPT = `Classify this user message into exactly one category. Reply with ONLY the category name, nothing else.

Categories:
- simple: casual chat, quick questions, acknowledgments, greetings
- moderate: research, analysis, writing, summarization, explanation requests
- coding: programming, scripts, debugging, technical implementation
- complex: system design, architecture, multi-step projects, orchestration
- security-audit: security review, vulnerability assessment, code audit

Message: "{MESSAGE}"

Category:`;

async function classifyWithLLM(text: string, logger: { info: (msg: string) => void }): Promise<TaskCategory | null> {
  // Use dedicated key for classification, fall back to general key
  const apiKey = process.env.GEMINI_CLASSIFICATION_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    logger.info("[model-selector] No GEMINI_CLASSIFICATION_KEY or GEMINI_API_KEY for LLM fallback");
    return null;
  }

  try {
    const prompt = CLASSIFICATION_PROMPT.replace("{MESSAGE}", text.slice(0, 500));
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 10, temperature: 0 },
        }),
      }
    );

    if (!response.ok) {
      logger.info(`[model-selector] LLM fallback failed: ${response.status}`);
      return null;
    }

    const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const result = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim().toLowerCase();
    
    const validCategories: TaskCategory[] = ["simple", "moderate", "coding", "complex", "security-audit"];
    if (result && validCategories.includes(result as TaskCategory)) {
      logger.info(`[model-selector] LLM classified as: ${result}`);
      return result as TaskCategory;
    }
    
    logger.info(`[model-selector] LLM returned invalid category: ${result}`);
    return null;
  } catch (e) {
    logger.info(`[model-selector] LLM fallback error: ${e}`);
    return null;
  }
}

// ============================================================================
// Types
// ============================================================================

type TaskCategory = "simple" | "moderate" | "coding" | "complex" | "security-audit";

interface ModelSelectorConfig {
  enabled?: boolean;
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
  suggestedModel?: string;
  suggestedCategory?: TaskCategory;
  suggestedFallbacks?: string[];
  pendingApproval: boolean;
}

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_CONFIG: Required<Omit<ModelSelectorConfig, "enabled">> & { enabled: boolean } = {
  enabled: true,
  models: {
    simple: [],
    moderate: ["sonnet", "gemini-flash"],
    coding: ["opus", "sonnet", "gemini-flash"],
    complex: ["opus", "gemini-pro"],
    "security-audit": ["openai-codex/gpt-5.2", "opus"],
  },
};

// ============================================================================
// Classification Signals
// ============================================================================

const SECURITY_AUDIT_SIGNALS = [
  "security review", "code review", "find bugs in", "find vulnerabilities",
  "security audit", "code audit", "penetration test", "compliance review",
  "security issue", "vulnerability assessment",
];

const CODING_SIGNALS = [
  "```", "write code", "write a script", "build a script", "create a script",
  "write a function", "debug", "fix this code", "refactor", "implement",
  "typescript", "javascript", "python", "bash", "sql", "api endpoint",
  "unit test", "pull request", "stack trace", "error:", "exception",
  "function", "class", "module",
  // Expanded patterns
  "code me", "code this", "code a", "build me", "build a", "create a",
  "make me a", "program", "script to", "automate", "cli tool", "bot",
  "webhook", "integration", "parse", "generate code",
];

const COMPLEX_SIGNALS = [
  "orchestrat", "coordinate", "multi-agent", "sub-agent", "spawn", "delegate",
  "architect", "system design", "end-to-end", "migrate", "rollout",
  "infrastructure", "build the", "create the system", "design the",
  "multi-step workflow", "complex workflow", "dissertation",
  "comprehensive exam", "systematic theology", "research project", "capstone",
];

const MODERATE_SIGNALS = [
  "research", "analyze", "evaluate", "compare", "summarize", "investigate",
  "look into", "find out about", "what do you think", "help me understand",
  "explain in detail", "audit my tasks", "review my list", "clean up",
  "organize", "tidy up", "consolidate", "draft", "write a", "document",
  "proposal", "email", "report", "memo", "outline", "essay", "paper",
  "thesis", "sermon", "exegesis", "hermeneutic", "commentary", "bibliography",
  "citation", "literature review", "study guide", "lecture notes", "greek",
  "hebrew", "theological", "doctrine", "scripture",
];

function classifyTaskKeywords(text: string): TaskCategory | null {
  const t = text.toLowerCase();
  if (SECURITY_AUDIT_SIGNALS.some((s) => t.includes(s))) return "security-audit";
  if (COMPLEX_SIGNALS.some((s) => t.includes(s))) return "complex";
  if (CODING_SIGNALS.some((s) => t.includes(s))) return "coding";
  if (MODERATE_SIGNALS.some((s) => t.includes(s))) return "moderate";
  return null;
}

async function classifyTask(
  text: string,
  logger: { info: (msg: string) => void }
): Promise<TaskCategory> {
  // Fast path: keyword matching
  const keywordResult = classifyTaskKeywords(text);
  if (keywordResult) {
    logger.info(`[model-selector] Keyword match: ${keywordResult}`);
    return keywordResult;
  }

  // Skip LLM for short messages (likely simple)
  if (text.length < 50) {
    return "simple";
  }

  // Fallback: LLM classification for ambiguous messages
  logger.info("[model-selector] No keyword match, trying LLM fallback...");
  const llmResult = await classifyWithLLM(text, logger);
  if (llmResult) {
    return llmResult;
  }

  return "simple";
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
      pendingApproval: false,
    });
  }
  return sessionStates.get(sessionKey)!;
}

// ============================================================================
// Injection Builders
// ============================================================================

function buildSuggestionInjection(
  category: TaskCategory,
  model: string,
  fallbacks: string[]
): string {
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
    `2. Ask clarifying questions if needed`,
    `3. Suggest the model: "This is ${categoryLabels[category]}, so I suggest ${model}"`,
    `4. Wait for user approval`,
    "",
    "Approval keywords: 'go ahead', 'proceed', 'yes', 'approve', 'do it'",
    "Override keywords: 'stay on', 'keep', 'no switch'",
  ].join("\n");
}

function buildSwitchInjection(
  category: TaskCategory,
  model: string
): string {
  const categoryLabels: Record<TaskCategory, string> = {
    simple: "simple task",
    moderate: "research/analysis",
    coding: "coding task",
    complex: "complex orchestration",
    "security-audit": "security/code audit",
  };

  return [
    "MODEL ROUTING (approved - switching):",
    `Task: ${categoryLabels[category]}`,
    `Switching to: ${model}`,
    "",
    "INSTRUCTIONS:",
    `1. Call session_status({ model: "${model}" }) to switch`,
    `2. Note: "⚡ Switching to ${model} for ${categoryLabels[category]}"`,
    `3. Proceed with the task`,
    `4. When complete: announce "Done. Switching back to haiku." then call session_status({ model: "default" })`,
    `   - User can say "no" / "not done" / "keep going" to stay on ${model}`,
    `   - Silence = proceed with switch-back`,
  ].join("\n");
}

// ============================================================================
// Plugin Definition
// ============================================================================

const plugin = {
  id: "openclaw-model-selector",
  name: "Model Selector",
  description: "Hybrid classification with announce-and-switch completion",
  kind: "extension",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    const workspaceDir = process.env.OPENCLAW_WORKSPACE || 
      process.env.HOME + "/.openclaw/workspace";
    
    // Load config
    const configPath = join(workspaceDir, "config/model-selector.json");
    let rawCfg: ModelSelectorConfig = {};
    
    try {
      if (existsSync(configPath)) {
        rawCfg = JSON.parse(readFileSync(configPath, "utf-8"));
        api.logger.info(`[model-selector] Loaded config from ${configPath}`);
      }
    } catch (e) {
      api.logger.warn(`[model-selector] Failed to load config: ${e}`);
    }
    
    const cfg: ModelSelectorConfig = {
      enabled: rawCfg?.enabled ?? DEFAULT_CONFIG.enabled,
      models: {
        simple: rawCfg?.models?.simple ?? DEFAULT_CONFIG.models.simple,
        moderate: rawCfg?.models?.moderate ?? DEFAULT_CONFIG.models.moderate,
        coding: rawCfg?.models?.coding ?? DEFAULT_CONFIG.models.coding,
        complex: rawCfg?.models?.complex ?? DEFAULT_CONFIG.models.complex,
        "security-audit": rawCfg?.models?.["security-audit"] ?? DEFAULT_CONFIG.models["security-audit"],
      },
    };

    if (cfg.enabled === false) {
      api.logger.info("[model-selector] Disabled via config");
      return;
    }

    api.logger.info(`[model-selector] Registered v8 (Hybrid + announce-and-switch)`);

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

        // Handle pending approval
        if (state.pendingApproval && state.suggestedModel) {
          const t = userText.toLowerCase();
          const approves = ["go ahead", "proceed", "yes", "yep", "approve", "ok", "do it", "lgtm"];
          const overrides = ["stay on", "stay with", "keep current", "no switch", "use default"];

          if (approves.some((a) => t.includes(a))) {
            api.logger.info(`[model-selector] Approval for ${state.suggestedModel}`);
            
            const injection = buildSwitchInjection(
              state.suggestedCategory!,
              state.suggestedModel
            );
            
            state.currentModel = state.suggestedModel;
            state.pendingApproval = false;
            state.suggestedModel = undefined;
            state.suggestedCategory = undefined;
            state.suggestedFallbacks = undefined;
            
            return { prependContext: injection };
          }

          if (overrides.some((o) => t.includes(o))) {
            api.logger.info(`[model-selector] Override — staying on current model`);
            state.pendingApproval = false;
            state.suggestedModel = undefined;
            state.suggestedCategory = undefined;
            state.suggestedFallbacks = undefined;
            return;
          }

          // Still waiting for approval - don't re-suggest
          return;
        }

        // Classify incoming message
        const category = await classifyTask(userText, api.logger);

        if (category === "simple") {
          return;
        }

        const modelList = getModelList(category, cfg);
        const primaryModel = modelList[0];

        if (!primaryModel) {
          return;
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
          state.suggestedFallbacks
        );
        return { prependContext: injection };
      },
      { priority: 50 }
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
