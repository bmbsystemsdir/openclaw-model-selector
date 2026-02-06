/**
 * OpenClaw Model Selector Plugin v6
 *
 * Approval-first model routing with Beads integration:
 * - Classify task + suggest best model (wait for approval)
 * - User approves → create bead + switch to approved model
 * - Plan + execute on upgraded model
 * - On bead close: if still on that model, switch back to default
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
import { z } from "zod";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";

// ============================================================================
// Types
// ============================================================================

type TaskCategory = "simple" | "moderate" | "coding" | "complex" | "security-audit";

interface ModelSelectorConfig {
  enabled?: boolean;
  announceSwitch?: boolean;
  workspaceDir?: string;
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
  currentBeadId: string | null; // bead tracking this work
  needsReturnAnnouncement: boolean;
  suggestedModel?: string; // Pending approval
  suggestedCategory?: TaskCategory;
  suggestedFallbacks?: string[];
  suggestedTaskSummary?: string;
  pendingApproval: boolean;
}

interface ModelStateEntry {
  beadId: string;
  model: string;
  category: TaskCategory;
  createdAt: string;
  sessionKey: string;
}

interface ModelStateFile {
  activeEscalations: ModelStateEntry[];
}

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_CONFIG: Required<Omit<ModelSelectorConfig, "enabled" | "workspaceDir">> & { enabled: boolean } = {
  enabled: true,
  announceSwitch: true,
  models: {
    simple: [],
    moderate: ["sonnet", "gemini-flash"],
    coding: ["opus", "sonnet", "gemini-flash"],
    complex: ["opus", "gemini-pro"],
    "security-audit": ["openai-codex/gpt-5.2", "opus"],
  },
};

const MODEL_STATE_FILE = ".beads/model-state.json";

// ============================================================================
// Config Schema
// ============================================================================

const modelSelectorConfigSchema = z.object({
  enabled: z.boolean().optional().default(true),
  announceSwitch: z.boolean().optional().default(true),
  models: z.object({
    simple: z.array(z.string()).optional(),
    moderate: z.array(z.string()).optional(),
    coding: z.array(z.string()).optional(),
    complex: z.array(z.string()).optional(),
    "security-audit": z.array(z.string()).optional(),
  }).optional(),
}).optional().default({});

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

function classifyTask(text: string): TaskCategory {
  const t = text.toLowerCase();
  if (SECURITY_AUDIT_SIGNALS.some((s) => t.includes(s))) return "security-audit";
  if (COMPLEX_SIGNALS.some((s) => t.includes(s))) return "complex";
  if (CODING_SIGNALS.some((s) => t.includes(s))) return "coding";
  if (MODERATE_SIGNALS.some((s) => t.includes(s))) return "moderate";
  return "simple";
}

function getModelList(category: TaskCategory, cfg: ModelSelectorConfig): string[] {
  const models = cfg.models ?? DEFAULT_CONFIG.models;
  const categoryModels = models[category] ?? DEFAULT_CONFIG.models[category];
  return Array.isArray(categoryModels) ? categoryModels : [];
}

function extractTaskSummary(text: string): string {
  // Get first 60 chars or first sentence, whichever is shorter
  const firstSentence = text.split(/[.!?\n]/)[0] || text;
  const summary = firstSentence.slice(0, 60);
  return summary.length < firstSentence.length ? summary + "..." : summary;
}

// ============================================================================
// State Management
// ============================================================================

const sessionStates = new Map<string, SessionState>();

function getState(sessionKey: string): SessionState {
  if (!sessionStates.has(sessionKey)) {
    sessionStates.set(sessionKey, {
      currentModel: null,
      currentBeadId: null,
      needsReturnAnnouncement: false,
      pendingApproval: false,
    });
  }
  return sessionStates.get(sessionKey)!;
}

// ============================================================================
// Model State File Management
// ============================================================================

function getModelStatePath(workspaceDir: string): string {
  return join(workspaceDir, MODEL_STATE_FILE);
}

function loadModelState(workspaceDir: string): ModelStateFile {
  const path = getModelStatePath(workspaceDir);
  try {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, "utf-8"));
    }
  } catch (e) {
    // Ignore parse errors, return empty state
  }
  return { activeEscalations: [] };
}

function saveModelState(workspaceDir: string, state: ModelStateFile): void {
  const path = getModelStatePath(workspaceDir);
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(state, null, 2));
}

function addEscalation(
  workspaceDir: string,
  entry: ModelStateEntry
): void {
  const state = loadModelState(workspaceDir);
  // Remove any existing entry for this bead
  state.activeEscalations = state.activeEscalations.filter(
    (e) => e.beadId !== entry.beadId
  );
  state.activeEscalations.push(entry);
  saveModelState(workspaceDir, state);
}

function removeEscalation(workspaceDir: string, beadId: string): ModelStateEntry | null {
  const state = loadModelState(workspaceDir);
  const entry = state.activeEscalations.find((e) => e.beadId === beadId);
  if (entry) {
    state.activeEscalations = state.activeEscalations.filter(
      (e) => e.beadId !== beadId
    );
    saveModelState(workspaceDir, state);
  }
  return entry || null;
}

function getEscalationByBead(workspaceDir: string, beadId: string): ModelStateEntry | null {
  const state = loadModelState(workspaceDir);
  return state.activeEscalations.find((e) => e.beadId === beadId) || null;
}

// ============================================================================
// Beads Integration
// ============================================================================

function createBead(workspaceDir: string, title: string, category: TaskCategory): string | null {
  try {
    const priorityMap: Record<TaskCategory, number> = {
      "simple": 3,
      "moderate": 2,
      "coding": 1,
      "complex": 0,
      "security-audit": 0,
    };
    const priority = priorityMap[category] ?? 2;
    
    const result = execSync(
      `cd "${workspaceDir}" && bd create "${title}" -p ${priority} --json 2>/dev/null`,
      { encoding: "utf-8" }
    );
    
    const parsed = JSON.parse(result);
    return parsed.id || parsed.ID || null;
  } catch (e) {
    return null;
  }
}

function closeBead(workspaceDir: string, beadId: string): boolean {
  try {
    execSync(`cd "${workspaceDir}" && bd close ${beadId} 2>/dev/null`);
    return true;
  } catch (e) {
    return false;
  }
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
    `2. Ask clarifying questions if needed: "Quick question: ...?"`,
    `3. Suggest the model: "This is ${categoryLabels[category]}, so I suggest ${model}"`,
    `4. Wait for user approval in one shot (they can validate task + model together)`,
    ``,
    "Approval keywords: 'go ahead', 'proceed', 'yes', 'approve', 'do it'",
    "Override keywords: 'stay on', 'keep', 'no switch'",
    "",
    `5. Once approved: switch model, create bead to track work, then plan + execute`,
  ].join("\n");
}

function buildSwitchInjection(
  category: TaskCategory,
  model: string,
  beadId: string,
  fallbacks: string[]
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
    `Tracking bead: ${beadId}`,
    "",
    "INSTRUCTIONS:",
    `1. Call session_status({ model: "${model}" }) to switch`,
    `2. Note: "⚡ ${model} for ${categoryLabels[category]} (tracking: ${beadId})"`,
    `3. Proceed with the task`,
    `4. When complete, run: bd close ${beadId}`,
    `   This will auto-switch back to default if still on ${model}`,
  ].join("\n");
}

function buildReturnToDefaultInjection(beadId: string): string {
  return [
    "MODEL ROUTING (bead closed - returning to default):",
    `Bead ${beadId} closed — switching back to default model.`,
    "",
    "INSTRUCTIONS:",
    `- Call session_status({ model: "default" })`,
    `- Note: "⚡ Back to default model (${beadId} complete)"`,
  ].join("\n");
}

// ============================================================================
// Plugin Definition
// ============================================================================

const plugin = {
  id: "openclaw-model-selector",
  name: "Model Selector",
  description: "Auto-switching model routing with Beads integration",
  kind: "extension",
  configSchema: modelSelectorConfigSchema,

  register(api: OpenClawPluginApi) {
    // Parse config with schema (provides defaults)
    const parsed = modelSelectorConfigSchema.safeParse(api.pluginConfig);
    const rawCfg = parsed.success ? parsed.data : {};
    
    const cfg: ModelSelectorConfig = {
      enabled: rawCfg?.enabled ?? DEFAULT_CONFIG.enabled,
      announceSwitch: rawCfg?.announceSwitch ?? DEFAULT_CONFIG.announceSwitch,
      models: {
        simple: rawCfg?.models?.simple ?? DEFAULT_CONFIG.models.simple,
        moderate: rawCfg?.models?.moderate ?? DEFAULT_CONFIG.models.moderate,
        coding: rawCfg?.models?.coding ?? DEFAULT_CONFIG.models.coding,
        complex: rawCfg?.models?.complex ?? DEFAULT_CONFIG.models.complex,
        "security-audit": rawCfg?.models?.["security-audit"] ?? DEFAULT_CONFIG.models["security-audit"],
      },
    };

    // Get workspace dir from config or env
    const workspaceDir = cfg.workspaceDir || 
      process.env.OPENCLAW_WORKSPACE || 
      process.env.HOME + "/.openclaw/workspace";

    if (cfg.enabled === false) {
      api.logger.info("[model-selector] Disabled via config");
      return;
    }

    api.logger.info(`[model-selector] Registered v6 (Beads integration)`);

    // ========================================================================
    // Hook: before_agent_start
    // ========================================================================
    api.on(
      "before_agent_start",
      async (event: PluginHookBeforeAgentStartEvent, ctx: PluginHookAgentContext) => {
        const sessionKey = ctx.sessionKey ?? "unknown";
        const state = getState(sessionKey);

        // Check if we need to return to default
        if (state.needsReturnAnnouncement && state.currentBeadId) {
          api.logger.info(`[model-selector] Returning to default (bead: ${state.currentBeadId})`);
          const injection = buildReturnToDefaultInjection(state.currentBeadId);
          state.needsReturnAnnouncement = false;
          state.currentBeadId = null;
          state.currentModel = null;
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
          const t = userText.toLowerCase();
          const approves = ["go ahead", "proceed", "yes", "yep", "approve", "ok", "do it", "lgtm"];
          const overrides = ["stay on", "stay with", "keep current", "no switch", "use default"];

          if (approves.some((a) => t.includes(a))) {
            api.logger.info(`[model-selector] Approval for ${state.suggestedModel}`);
            
            // Create bead to track this work
            const taskSummary = state.suggestedTaskSummary || "Task";
            const beadId = createBead(workspaceDir, taskSummary, state.suggestedCategory!);
            
            if (beadId) {
              // Store escalation mapping
              addEscalation(workspaceDir, {
                beadId,
                model: state.suggestedModel,
                category: state.suggestedCategory!,
                createdAt: new Date().toISOString(),
                sessionKey,
              });
              
              state.currentBeadId = beadId;
              api.logger.info(`[model-selector] Created bead ${beadId}`);
            }

            const injection = buildSwitchInjection(
              state.suggestedCategory!,
              state.suggestedModel,
              beadId || "unknown",
              state.suggestedFallbacks || [],
            );
            
            state.currentModel = state.suggestedModel;
            state.pendingApproval = false;
            state.suggestedModel = undefined;
            state.suggestedCategory = undefined;
            state.suggestedFallbacks = undefined;
            state.suggestedTaskSummary = undefined;
            
            return { prependContext: injection };
          }

          if (overrides.some((o) => t.includes(o))) {
            api.logger.info(`[model-selector] Override — staying on current model`);
            state.pendingApproval = false;
            state.suggestedModel = undefined;
            state.suggestedCategory = undefined;
            state.suggestedFallbacks = undefined;
            state.suggestedTaskSummary = undefined;
            return;
          }

          // Still waiting for approval
          return;
        }

        // Classify incoming message
        const category = classifyTask(userText);

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
        state.suggestedTaskSummary = extractTaskSummary(userText);
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
    // Hook: after_tool_call (detect bd close)
    // ========================================================================
    api.on(
      "after_tool_call",
      async (event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext) => {
        const sessionKey = ctx.sessionKey ?? "unknown";
        const state = getState(sessionKey);

        // Check for exec calls that might be bd close
        if (event.toolName === "exec") {
          const args = event.args as { command?: string } | undefined;
          const command = args?.command || "";
          
          // Match: bd close <bead-id>
          const closeMatch = command.match(/\bbd\s+close\s+(\S+)/);
          if (closeMatch) {
            const beadId = closeMatch[1];
            api.logger.info(`[model-selector] Detected bd close ${beadId}`);
            
            // Check if this bead has an associated model escalation
            const escalation = getEscalationByBead(workspaceDir, beadId);
            
            if (escalation) {
              // Remove from active escalations
              removeEscalation(workspaceDir, beadId);
              
              // Check if we're still on that model
              if (state.currentModel === escalation.model) {
                api.logger.info(
                  `[model-selector] Bead ${beadId} closed, current model matches — queuing return to default`
                );
                state.needsReturnAnnouncement = true;
                state.currentBeadId = beadId;
              } else {
                api.logger.info(
                  `[model-selector] Bead ${beadId} closed, but model changed (${state.currentModel} != ${escalation.model}) — no switch`
                );
              }
            }
          }
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
