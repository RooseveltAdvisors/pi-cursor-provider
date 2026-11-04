/**
 * Pi Cursor Provider Extension
 *
 * Routes Pi model requests through the Cursor Agent CLI (`agent`) so that any
 * active Cursor subscription can be used from inside Pi.
 *
 * Authentication is handled by the CLI itself — run `agent login` (or set the
 * CURSOR_API_KEY environment variable) before using this provider.
 *
 * Usage:
 *   pi install npm:@netandreus/pi-cursor-provider
 *   # Then /model cursor/<model-id>, e.g. /model cursor/sonnet-4.5-thinking
 *
 * Configuration env vars:
 *   CURSOR_AGENT_PATH   Path to the Cursor Agent CLI binary (default: "agent")
 *   CURSOR_API_KEY      API key for Cursor (used by the agent subprocess if set)
 *   CURSOR_MODELS_CACHE Path to cached model catalog JSON (default: ~/.pi/agent/cursor-models-cache.json)
 */

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  TextContent,
} from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Model definitions
// ---------------------------------------------------------------------------

interface CursorModelDef {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
}

/**
 * Static fallback list. Used when `agent models` fails or times out, and as
 * an attribute lookup table for models discovered dynamically.
 *
 * Source: `agent models` output (Cursor Agent CLI v2026.10.22-27dcf5f).
 */
const STATIC_MODELS: CursorModelDef[] = [
  // Auto
  {
    id: "auto",
    name: "Auto",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  // GPT
  {
    id: "gpt-5.3-codex-low",
    name: "Codex 5.3 Low",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.3-codex-low-fast",
    name: "Codex 5.3 Low Fast",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.3-codex",
    name: "Codex 5.3",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.3-codex-fast",
    name: "Codex 5.3 Fast",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.3-codex-high",
    name: "Codex 5.3 High",
    reasoning: true,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.3-codex-high-fast",
    name: "Codex 5.3 High Fast",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.3-codex-xhigh",
    name: "Codex 5.3 Extra High",
    reasoning: true,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.3-codex-xhigh-fast",
    name: "Codex 5.3 Extra High Fast",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.2",
    name: "GPT-5.2",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.6-sol-high",
    name: "GPT-5.6 Sol 1M High",
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.6-sol-high-fast",
    name: "GPT-5.6 Sol 1M High Fast",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.6-sol-xhigh",
    name: "GPT-5.6 Sol 1M Extra High",
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.6-sol-xhigh-fast",
    name: "GPT-5.6 Sol 1M Extra High Fast",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.6-luna-high",
    name: "GPT-5.6 Luna 1M High",
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.6-sol-none",
    name: "GPT-5.6 Sol 1M None",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.6-sol-none-fast",
    name: "GPT-5.6 Sol 1M None Fast",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.6-sol-low",
    name: "GPT-5.6 Sol 1M Low",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.6-sol-low-fast",
    name: "GPT-5.6 Sol 1M Low Fast",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.6-sol-medium",
    name: "GPT-5.6 Sol 1M",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.6-sol-medium-fast",
    name: "GPT-5.6 Sol 1M Fast",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.6-sol-max",
    name: "GPT-5.6 Sol 1M Max",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.6-sol-max-fast",
    name: "GPT-5.6 Sol 1M Max Fast",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.5-none",
    name: "GPT-5.5 1M None",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.5-none-fast",
    name: "GPT-5.5 None Fast",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.5-low",
    name: "GPT-5.5 1M Low",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.5-low-fast",
    name: "GPT-5.5 Low Fast",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.5-medium",
    name: "GPT-5.5 1M",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.5-medium-fast",
    name: "GPT-5.5 Fast",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.5-high",
    name: "GPT-5.5 1M High",
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.5-high-fast",
    name: "GPT-5.5 High Fast",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.5-extra-high",
    name: "GPT-5.5 1M Extra High",
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.5-extra-high-fast",
    name: "GPT-5.5 Extra High Fast",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.6-terra-none",
    name: "GPT-5.6 Terra 1M None",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.6-terra-none-fast",
    name: "GPT-5.6 Terra 1M None Fast",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.6-terra-low",
    name: "GPT-5.6 Terra 1M Low",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.6-terra-low-fast",
    name: "GPT-5.6 Terra 1M Low Fast",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.6-terra-medium",
    name: "GPT-5.6 Terra 1M",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.6-terra-medium-fast",
    name: "GPT-5.6 Terra 1M Fast",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.6-terra-high",
    name: "GPT-5.6 Terra 1M High",
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.6-terra-high-fast",
    name: "GPT-5.6 Terra 1M High Fast",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.6-terra-xhigh",
    name: "GPT-5.6 Terra 1M Extra High",
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.6-terra-xhigh-fast",
    name: "GPT-5.6 Terra 1M Extra High Fast",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.6-terra-max",
    name: "GPT-5.6 Terra 1M Max",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.6-terra-max-fast",
    name: "GPT-5.6 Terra 1M Max Fast",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.4-low",
    name: "GPT-5.4 1M Low",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.4-medium",
    name: "GPT-5.4 1M",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.4-medium-fast",
    name: "GPT-5.4 Fast",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.4-high",
    name: "GPT-5.4 1M High",
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.4-high-fast",
    name: "GPT-5.4 High Fast",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.4-xhigh",
    name: "GPT-5.4 1M Extra High",
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.4-xhigh-fast",
    name: "GPT-5.4 Extra High Fast",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.2-low",
    name: "GPT-5.2 Low",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.2-low-fast",
    name: "GPT-5.2 Low Fast",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.2-fast",
    name: "GPT-5.2 Fast",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.2-high",
    name: "GPT-5.2 High",
    reasoning: true,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.2-high-fast",
    name: "GPT-5.2 High Fast",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.2-xhigh",
    name: "GPT-5.2 Extra High",
    reasoning: true,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.2-xhigh-fast",
    name: "GPT-5.2 Extra High Fast",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.6-luna-none",
    name: "GPT-5.6 Luna 1M None",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.6-luna-none-fast",
    name: "GPT-5.6 Luna 1M None Fast",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.6-luna-low",
    name: "GPT-5.6 Luna 1M Low",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.6-luna-low-fast",
    name: "GPT-5.6 Luna 1M Low Fast",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.6-luna-medium",
    name: "GPT-5.6 Luna 1M",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.6-luna-medium-fast",
    name: "GPT-5.6 Luna 1M Fast",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.6-luna-high-fast",
    name: "GPT-5.6 Luna 1M High Fast",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.6-luna-xhigh",
    name: "GPT-5.6 Luna 1M Extra High",
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.6-luna-xhigh-fast",
    name: "GPT-5.6 Luna 1M Extra High Fast",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.6-luna-max",
    name: "GPT-5.6 Luna 1M Max",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.6-luna-max-fast",
    name: "GPT-5.6 Luna 1M Max Fast",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.4-mini-none",
    name: "GPT-5.4 Mini None",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.4-mini-low",
    name: "GPT-5.4 Mini Low",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.4-mini-medium",
    name: "GPT-5.4 Mini",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.4-mini-high",
    name: "GPT-5.4 Mini High",
    reasoning: true,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.4-mini-xhigh",
    name: "GPT-5.4 Mini Extra High",
    reasoning: true,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.4-nano-none",
    name: "GPT-5.4 Nano None",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.4-nano-low",
    name: "GPT-5.4 Nano Low",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.4-nano-medium",
    name: "GPT-5.4 Nano",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.4-nano-high",
    name: "GPT-5.4 Nano High",
    reasoning: true,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.4-nano-xhigh",
    name: "GPT-5.4 Nano Extra High",
    reasoning: true,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.1-low",
    name: "GPT-5.1 Low",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.1",
    name: "GPT-5.1",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5.1-high",
    name: "GPT-5.1 High",
    reasoning: true,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "gpt-5-mini",
    name: "GPT-5 Mini",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  // Composer
  {
    id: "composer-2.5",
    name: "Composer 2.5",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "composer-2.5-fast",
    name: "Composer 2.5 Fast",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  // Claude
  {
    id: "claude-opus-5-thinking-high",
    name: "Claude Opus 5 1M Thinking",
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-5-thinking-high-fast",
    name: "Claude Opus 5 1M Thinking Fast",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-fable-5-thinking-high",
    name: "Claude Fable 5 1M Thinking (NO ZDR)",
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-fable-5-thinking-xhigh",
    name: "Claude Fable 5 1M Extra High Thinking (NO ZDR)",
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-sonnet-5-thinking-high",
    name: "Claude Sonnet 5 1M Thinking",
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-sonnet-5-thinking-xhigh",
    name: "Claude Sonnet 5 1M Extra High Thinking",
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-5-5-low",
    name: "Claude Opus 5.5 1M Low",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-5-5-low-fast",
    name: "Claude Opus 5.5 1M Low Fast",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-5-5-medium",
    name: "Claude Opus 5.5 1M",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-5-5-medium-fast",
    name: "Claude Opus 5.5 1M Fast",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-5-5-high",
    name: "Claude Opus 5.5 1M High",
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-5-5-high-fast",
    name: "Claude Opus 5.5 1M High Fast",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-5-5-xhigh",
    name: "Claude Opus 5.5 1M Extra High",
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-5-5-xhigh-fast",
    name: "Claude Opus 5.5 1M Extra High Fast",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-5-5-max",
    name: "Claude Opus 5.5 1M Max",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-5-5-max-fast",
    name: "Claude Opus 5.5 1M Max Fast",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-5-low",
    name: "Claude Opus 5 1M Low",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-5-low-fast",
    name: "Claude Opus 5 1M Low Fast",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-5-medium",
    name: "Claude Opus 5 1M Medium",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-5-medium-fast",
    name: "Claude Opus 5 1M Medium Fast",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-5-high",
    name: "Claude Opus 5 1M",
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-5-high-fast",
    name: "Claude Opus 5 1M Fast",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-5-thinking-low",
    name: "Claude Opus 5 1M Low Thinking",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-5-thinking-low-fast",
    name: "Claude Opus 5 1M Low Thinking Fast",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-5-thinking-medium",
    name: "Claude Opus 5 1M Medium Thinking",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-5-thinking-medium-fast",
    name: "Claude Opus 5 1M Medium Thinking Fast",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-5-thinking-xhigh",
    name: "Claude Opus 5 1M Extra High Thinking",
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-5-thinking-xhigh-fast",
    name: "Claude Opus 5 1M Extra High Thinking Fast",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-5-thinking-max",
    name: "Claude Opus 5 1M Max Thinking",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-5-thinking-max-fast",
    name: "Claude Opus 5 1M Max Thinking Fast",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-4-8-low",
    name: "Claude Opus 4.8 1M Low",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-4-8-low-fast",
    name: "Claude Opus 4.8 1M Low Fast",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-4-8-medium",
    name: "Claude Opus 4.8 1M Medium",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-4-8-medium-fast",
    name: "Claude Opus 4.8 1M Medium Fast",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-4-8-high",
    name: "Claude Opus 4.8 1M",
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-4-8-high-fast",
    name: "Claude Opus 4.8 1M Fast",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-4-8-xhigh",
    name: "Claude Opus 4.8 1M Extra High",
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-4-8-xhigh-fast",
    name: "Claude Opus 4.8 1M Extra High Fast",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-4-8-max",
    name: "Claude Opus 4.8 1M Max",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-4-8-max-fast",
    name: "Claude Opus 4.8 1M Max Fast",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-4-8-thinking-low",
    name: "Claude Opus 4.8 1M Low Thinking",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-4-8-thinking-low-fast",
    name: "Claude Opus 4.8 1M Low Thinking Fast",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-4-8-thinking-medium",
    name: "Claude Opus 4.8 1M Medium Thinking",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-4-8-thinking-medium-fast",
    name: "Claude Opus 4.8 1M Medium Thinking Fast",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-4-8-thinking-high",
    name: "Claude Opus 4.8 1M Thinking",
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-4-8-thinking-high-fast",
    name: "Claude Opus 4.8 1M Thinking Fast",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-4-8-thinking-xhigh",
    name: "Claude Opus 4.8 1M Extra High Thinking",
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-4-8-thinking-xhigh-fast",
    name: "Claude Opus 4.8 1M Extra High Thinking Fast",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-4-8-thinking-max",
    name: "Claude Opus 4.8 1M Max Thinking",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-4-8-thinking-max-fast",
    name: "Claude Opus 4.8 1M Max Thinking Fast",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-fable-5-1-low",
    name: "Claude Fable 5.1 1M Low (NO ZDR)",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-fable-5-1-medium",
    name: "Claude Fable 5.1 1M Medium (NO ZDR)",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-fable-5-1-high",
    name: "Claude Fable 5.1 1M (NO ZDR)",
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-fable-5-1-xhigh",
    name: "Claude Fable 5.1 1M Extra High (NO ZDR)",
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-fable-5-1-max",
    name: "Claude Fable 5.1 1M Max (NO ZDR)",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-fable-5-1-thinking-low",
    name: "Claude Fable 5.1 1M Low Thinking (NO ZDR)",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-fable-5-1-thinking-medium",
    name: "Claude Fable 5.1 1M Medium Thinking (NO ZDR)",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-fable-5-1-thinking-high",
    name: "Claude Fable 5.1 1M Thinking (NO ZDR)",
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-fable-5-1-thinking-xhigh",
    name: "Claude Fable 5.1 1M Extra High Thinking (NO ZDR)",
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-fable-5-1-thinking-max",
    name: "Claude Fable 5.1 1M Max Thinking (NO ZDR)",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-fable-5-low",
    name: "Claude Fable 5 1M Low (NO ZDR)",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-fable-5-medium",
    name: "Claude Fable 5 1M Medium (NO ZDR)",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-fable-5-high",
    name: "Claude Fable 5 1M (NO ZDR)",
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-fable-5-xhigh",
    name: "Claude Fable 5 1M Extra High (NO ZDR)",
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-fable-5-max",
    name: "Claude Fable 5 1M Max (NO ZDR)",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-fable-5-thinking-low",
    name: "Claude Fable 5 1M Low Thinking (NO ZDR)",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-fable-5-thinking-medium",
    name: "Claude Fable 5 1M Medium Thinking (NO ZDR)",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-fable-5-thinking-max",
    name: "Claude Fable 5 1M Max Thinking (NO ZDR)",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-sonnet-5-5-low",
    name: "Claude Sonnet 5.5 Low",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32000,
  },
  {
    id: "claude-sonnet-5-5-medium",
    name: "Claude Sonnet 5.5 Medium",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32000,
  },
  {
    id: "claude-sonnet-5-5-high",
    name: "Claude Sonnet 5.5 High",
    reasoning: true,
    contextWindow: 200000,
    maxTokens: 32000,
  },
  {
    id: "claude-sonnet-5-5-xhigh",
    name: "Claude Sonnet 5.5 Extra High",
    reasoning: true,
    contextWindow: 200000,
    maxTokens: 32000,
  },
  {
    id: "claude-sonnet-5-5-max",
    name: "Claude Sonnet 5.5 Max",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32000,
  },
  {
    id: "claude-sonnet-5-low",
    name: "Claude Sonnet 5 1M Low",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-sonnet-5-medium",
    name: "Claude Sonnet 5 1M Medium",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-sonnet-5-high",
    name: "Claude Sonnet 5 1M",
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-sonnet-5-xhigh",
    name: "Claude Sonnet 5 1M Extra High",
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-sonnet-5-max",
    name: "Claude Sonnet 5 1M Max",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-sonnet-5-thinking-low",
    name: "Claude Sonnet 5 1M Low Thinking",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-sonnet-5-thinking-medium",
    name: "Claude Sonnet 5 1M Medium Thinking",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-sonnet-5-thinking-max",
    name: "Claude Sonnet 5 1M Max Thinking",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-4.6-sonnet-medium",
    name: "Claude Sonnet 4.6 1M",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-4.6-sonnet-medium-thinking",
    name: "Claude Sonnet 4.6 1M Thinking",
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-4-7-low",
    name: "Claude Opus 4.7 1M Low",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-4-7-low-fast",
    name: "Claude Opus 4.7 1M Low Fast",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-4-7-medium",
    name: "Claude Opus 4.7 1M Medium",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-4-7-medium-fast",
    name: "Claude Opus 4.7 1M Medium Fast",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-4-7-high",
    name: "Claude Opus 4.7 1M High",
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-4-7-high-fast",
    name: "Claude Opus 4.7 1M High Fast",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-4-7-xhigh",
    name: "Claude Opus 4.7 1M",
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-4-7-xhigh-fast",
    name: "Claude Opus 4.7 1M Fast",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-4-7-max",
    name: "Claude Opus 4.7 1M Max",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-4-7-max-fast",
    name: "Claude Opus 4.7 1M Max Fast",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-4-7-thinking-low",
    name: "Claude Opus 4.7 1M Low Thinking",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-4-7-thinking-low-fast",
    name: "Claude Opus 4.7 1M Low Thinking Fast",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-4-7-thinking-medium",
    name: "Claude Opus 4.7 1M Medium Thinking",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-4-7-thinking-medium-fast",
    name: "Claude Opus 4.7 1M Medium Thinking Fast",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-4-7-thinking-high",
    name: "Claude Opus 4.7 1M High Thinking",
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-4-7-thinking-high-fast",
    name: "Claude Opus 4.7 1M High Thinking Fast",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-4-7-thinking-xhigh",
    name: "Claude Opus 4.7 1M Thinking",
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-4-7-thinking-xhigh-fast",
    name: "Claude Opus 4.7 1M Thinking Fast",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-4-7-thinking-max",
    name: "Claude Opus 4.7 1M Max Thinking",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-opus-4-7-thinking-max-fast",
    name: "Claude Opus 4.7 1M Max Thinking Fast",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-4.6-opus-high",
    name: "Claude Opus 4.6 1M",
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-4.6-opus-max",
    name: "Claude Opus 4.6 1M Max",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-4.6-opus-high-thinking",
    name: "Claude Opus 4.6 1M Thinking",
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-4.6-opus-max-thinking",
    name: "Claude Opus 4.6 1M Max Thinking",
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 32000,
  },
  {
    id: "claude-4.5-opus-high",
    name: "Claude Opus 4.5",
    reasoning: true,
    contextWindow: 200000,
    maxTokens: 32000,
  },
  {
    id: "claude-4.5-opus-high-thinking",
    name: "Claude Opus 4.5 Thinking",
    reasoning: true,
    contextWindow: 200000,
    maxTokens: 32000,
  },
  {
    id: "claude-haiku-5-5-low",
    name: "Claude Haiku 5.5 Low No Thinking",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32000,
  },
  {
    id: "claude-haiku-5-5-medium",
    name: "Claude Haiku 5.5 Medium No Thinking",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32000,
  },
  {
    id: "claude-haiku-5-5-high",
    name: "Claude Haiku 5.5 High No Thinking",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32000,
  },
  {
    id: "claude-haiku-5-5-xhigh",
    name: "Claude Haiku 5.5 Extra High No Thinking",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32000,
  },
  {
    id: "claude-haiku-5-5-max",
    name: "Claude Haiku 5.5 Max No Thinking",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32000,
  },
  {
    id: "claude-haiku-5-5-thinking-low",
    name: "Claude Haiku 5.5 Low",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32000,
  },
  {
    id: "claude-haiku-5-5-thinking-medium",
    name: "Claude Haiku 5.5 Medium",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32000,
  },
  {
    id: "claude-haiku-5-5-thinking-high",
    name: "Claude Haiku 5.5 High",
    reasoning: true,
    contextWindow: 200000,
    maxTokens: 32000,
  },
  {
    id: "claude-haiku-5-5-thinking-xhigh",
    name: "Claude Haiku 5.5 Extra High",
    reasoning: true,
    contextWindow: 200000,
    maxTokens: 32000,
  },
  {
    id: "claude-haiku-5-5-thinking-max",
    name: "Claude Haiku 5.5 Max",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32000,
  },
  {
    id: "claude-4.5-sonnet",
    name: "Claude Sonnet 4.5",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32000,
  },
  {
    id: "claude-4.5-sonnet-thinking",
    name: "Claude Sonnet 4.5 Thinking",
    reasoning: true,
    contextWindow: 200000,
    maxTokens: 32000,
  },
  {
    id: "claude-4-sonnet",
    name: "Claude Sonnet 4",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32000,
  },
  {
    id: "claude-4-sonnet-thinking",
    name: "Claude Sonnet 4 Thinking",
    reasoning: true,
    contextWindow: 200000,
    maxTokens: 32000,
  },
  // Other
  {
    id: "cursor-grok-4.5-high",
    name: "Grok 4.5",
    reasoning: true,
    contextWindow: 131072,
    maxTokens: 32768,
  },
  {
    id: "cursor-grok-4.5-high-fast",
    name: "Grok 4.5 Fast",
    reasoning: false,
    contextWindow: 131072,
    maxTokens: 32768,
  },
  {
    id: "cursor-grok-4.6-low",
    name: "Grok 4.6 Low",
    reasoning: false,
    contextWindow: 131072,
    maxTokens: 32768,
  },
  {
    id: "cursor-grok-4.6-low-fast",
    name: "Grok 4.6 Low Fast",
    reasoning: false,
    contextWindow: 131072,
    maxTokens: 32768,
  },
  {
    id: "cursor-grok-4.6-medium",
    name: "Grok 4.6 Medium",
    reasoning: false,
    contextWindow: 131072,
    maxTokens: 32768,
  },
  {
    id: "cursor-grok-4.6-medium-fast",
    name: "Grok 4.6 Medium Fast",
    reasoning: false,
    contextWindow: 131072,
    maxTokens: 32768,
  },
  {
    id: "cursor-grok-4.6-high",
    name: "Grok 4.6",
    reasoning: true,
    contextWindow: 131072,
    maxTokens: 32768,
  },
  {
    id: "cursor-grok-4.6-high-fast",
    name: "Grok 4.6 Fast",
    reasoning: false,
    contextWindow: 131072,
    maxTokens: 32768,
  },
  {
    id: "cursor-grok-4.6-xhigh",
    name: "Grok 4.6 Extra High",
    reasoning: true,
    contextWindow: 131072,
    maxTokens: 32768,
  },
  {
    id: "cursor-grok-4.6-xhigh-fast",
    name: "Grok 4.6 Extra High Fast",
    reasoning: false,
    contextWindow: 131072,
    maxTokens: 32768,
  },
  {
    id: "cursor-grok-4.5-low",
    name: "Grok 4.5 Low",
    reasoning: false,
    contextWindow: 131072,
    maxTokens: 32768,
  },
  {
    id: "cursor-grok-4.5-low-fast",
    name: "Grok 4.5 Low Fast",
    reasoning: false,
    contextWindow: 131072,
    maxTokens: 32768,
  },
  {
    id: "cursor-grok-4.5-medium",
    name: "Grok 4.5 Medium",
    reasoning: false,
    contextWindow: 131072,
    maxTokens: 32768,
  },
  {
    id: "cursor-grok-4.5-medium-fast",
    name: "Grok 4.5 Medium Fast",
    reasoning: false,
    contextWindow: 131072,
    maxTokens: 32768,
  },
  // Gemini
  {
    id: "gemini-3.7-flash-high",
    name: "Gemini 3.7 Flash",
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 65536,
  },
  {
    id: "gemini-4-argon-low",
    name: "Gemini 4 Argon Low",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 65536,
  },
  {
    id: "gemini-4-argon-medium",
    name: "Gemini 4 Argon Medium",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 65536,
  },
  {
    id: "gemini-4-argon-high",
    name: "Gemini 4 Argon High",
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 65536,
  },
  {
    id: "gemini-3.8-flash-low",
    name: "Gemini 3.8 Flash Low",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 65536,
  },
  {
    id: "gemini-3.8-flash-medium",
    name: "Gemini 3.8 Flash Medium",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 65536,
  },
  {
    id: "gemini-3.8-flash-high",
    name: "Gemini 3.8 Flash High",
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 65536,
  },
  {
    id: "gemini-3.7-flash-low",
    name: "Gemini 3.7 Flash Low",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 65536,
  },
  {
    id: "gemini-3.7-flash-medium",
    name: "Gemini 3.7 Flash Medium",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 65536,
  },
  {
    id: "gemini-3.6-flash-minimal",
    name: "Gemini 3.6 Flash Minimal",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 65536,
  },
  {
    id: "gemini-3.6-flash-low",
    name: "Gemini 3.6 Flash Low",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 65536,
  },
  {
    id: "gemini-3.6-flash-medium",
    name: "Gemini 3.6 Flash Medium",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 65536,
  },
  {
    id: "gemini-3.6-flash-high",
    name: "Gemini 3.6 Flash",
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 65536,
  },
  {
    id: "gemini-3.1-pro",
    name: "Gemini 3.1 Pro",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 65536,
  },
  {
    id: "gemini-3-flash",
    name: "Gemini 3 Flash",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 65536,
  },
  {
    id: "gemini-3.5-flash",
    name: "Gemini 3.5 Flash",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 65536,
  },
  // Grok
  {
    id: "grok-4.7-low",
    name: "Grok 4.7 Low",
    reasoning: false,
    contextWindow: 131072,
    maxTokens: 32768,
  },
  {
    id: "grok-4.7-low-fast",
    name: "Grok 4.7 Low Fast",
    reasoning: false,
    contextWindow: 131072,
    maxTokens: 32768,
  },
  {
    id: "grok-4.7-medium",
    name: "Grok 4.7 Medium",
    reasoning: false,
    contextWindow: 131072,
    maxTokens: 32768,
  },
  {
    id: "grok-4.7-medium-fast",
    name: "Grok 4.7 Medium Fast",
    reasoning: false,
    contextWindow: 131072,
    maxTokens: 32768,
  },
  {
    id: "grok-4.7-high",
    name: "Grok 4.7 High",
    reasoning: true,
    contextWindow: 131072,
    maxTokens: 32768,
  },
  {
    id: "grok-4.7-high-fast",
    name: "Grok 4.7 High Fast",
    reasoning: false,
    contextWindow: 131072,
    maxTokens: 32768,
  },
  {
    id: "grok-4.7-xhigh",
    name: "Grok 4.7 Extra High",
    reasoning: true,
    contextWindow: 131072,
    maxTokens: 32768,
  },
  {
    id: "grok-4.7-xhigh-fast",
    name: "Grok 4.7 Extra High Fast",
    reasoning: false,
    contextWindow: 131072,
    maxTokens: 32768,
  },
  // Muse
  {
    id: "muse-wonder-1.0-minimal",
    name: "Muse Wonder Minimal",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "muse-wonder-1.0-low",
    name: "Muse Wonder Low",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "muse-wonder-1.0-medium",
    name: "Muse Wonder Medium",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "muse-wonder-1.0-high",
    name: "Muse Wonder High",
    reasoning: true,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "muse-wonder-1.0-xhigh",
    name: "Muse Wonder Extra High",
    reasoning: true,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "muse-wonder-1.0-max",
    name: "Muse Wonder Max",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "muse-spark-1.3-minimal",
    name: "Muse Spark 1.3 1M Minimal",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "muse-spark-1.3-low",
    name: "Muse Spark 1.3 1M Low",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "muse-spark-1.3-medium",
    name: "Muse Spark 1.3 1M Medium",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "muse-spark-1.3-high",
    name: "Muse Spark 1.3 1M",
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "muse-spark-1.3-xhigh",
    name: "Muse Spark 1.3 1M Extra High",
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  {
    id: "muse-spark-1.3-max",
    name: "Muse Spark 1.3 1M Max",
    reasoning: false,
    contextWindow: 1000000,
    maxTokens: 32768,
  },
  // Kimi
  {
    id: "kimi-k3-low",
    name: "Kimi K3 Low",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "kimi-k3-high",
    name: "Kimi K3 High",
    reasoning: true,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "kimi-k3-max",
    name: "Kimi K3",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "kimi-k2.7-code",
    name: "Kimi K2.7 Code",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  // GLM
  {
    id: "glm-5.2-high",
    name: "GLM 5.2",
    reasoning: true,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "glm-5.2-max",
    name: "GLM 5.2 Max",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  // DeepSeek
  {
    id: "deepseek-v41-flash-1017-none",
    name: "DeepSeek V4.1 Flash 1017 None",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "deepseek-v41-flash-1017-low",
    name: "DeepSeek V4.1 Flash 1017 Low",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "deepseek-v41-flash-1017-medium",
    name: "DeepSeek V4.1 Flash 1017 Medium",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "deepseek-v41-flash-1017-high",
    name: "DeepSeek V4.1 Flash 1017 High",
    reasoning: true,
    contextWindow: 200000,
    maxTokens: 32768,
  },
  {
    id: "deepseek-v41-flash-1017-max",
    name: "DeepSeek V4.1 Flash 1017 Max",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 32768,
  },
];

/** Fast lookup: static model id → definition */
const STATIC_MODELS_MAP = new Map<string, CursorModelDef>(
  STATIC_MODELS.map((m) => [m.id, m]),
);

// ---------------------------------------------------------------------------
// Canonical model ID mapping
// Maps canonical IDs (e.g. claude-sonnet-4-5) to CLI model IDs. When Pi
// provides a reasoning/thinking level, the corresponding variant is used.
// ---------------------------------------------------------------------------

type ReasoningLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

interface ModelVariants {
  default: string;
  minimal?: string;
  low?: string;
  medium?: string;
  high?: string;
  xhigh?: string;
}

const MODEL_MAP: Record<string, ModelVariants> = {
  "gpt-5.2": {
    default: "gpt-5.2",
    high: "gpt-5.2-high",
    xhigh: "gpt-5.2-high",
  },
  "gpt-5.3-codex": {
    default: "gpt-5.3-codex",
    minimal: "gpt-5.3-codex-low",
    low: "gpt-5.3-codex-low",
    high: "gpt-5.3-codex-high",
    xhigh: "gpt-5.3-codex-xhigh",
  },
  "gpt-5.3-codex-fast": {
    default: "gpt-5.3-codex-fast",
    minimal: "gpt-5.3-codex-low-fast",
    low: "gpt-5.3-codex-low-fast",
    high: "gpt-5.3-codex-high-fast",
    xhigh: "gpt-5.3-codex-xhigh-fast",
  },
  "gpt-5.1": {
    default: "gpt-5.1-high",
  },
  "gemini-3-flash-preview": { default: "gemini-3-flash" },
};

const cursorDefaultToCanonical = new Map<string, string>();
const allMappedCursorIds = new Set<string>();
for (const [canonicalId, variants] of Object.entries(MODEL_MAP)) {
  if (variants.default)
    cursorDefaultToCanonical.set(variants.default, canonicalId);
  for (const cursorId of Object.values(variants)) {
    if (cursorId) allMappedCursorIds.add(cursorId);
  }
}

/**
 * Convert a Cursor CLI model ID to its canonical ID.
 * Returns null for variant-only IDs (e.g. thinking); they are not shown as separate models.
 * Returns the id as-is for unmapped models.
 */
function toCanonicalId(cursorId: string): string | null {
  const canonical = cursorDefaultToCanonical.get(cursorId);
  if (canonical) return canonical;
  if (allMappedCursorIds.has(cursorId)) return null;
  return cursorId;
}

/**
 * Resolve a canonical model ID (and optional reasoning level) to the Cursor CLI model ID.
 * Returns the id as-is for unmapped models.
 */
function toCursorId(canonicalId: string, reasoning?: string): string {
  const family = MODEL_MAP[canonicalId];
  if (!family) return canonicalId;
  const level = reasoning as ReasoningLevel | undefined;
  const variant = level && family[level];
  return variant ?? family.default ?? canonicalId;
}

// ---------------------------------------------------------------------------
// Dynamic model discovery via `agent models`
// ---------------------------------------------------------------------------

/** Timeout (ms) for `agent models` discovery call. */
const DISCOVERY_TIMEOUT_MS = 15_000;

/**
 * Infer the `reasoning` flag for a model that is not in the static list.
 * Models whose id ends with -thinking, -high, -xhigh, -max-high, or -max are
 * treated as reasoning/extended-thinking models.
 */
function inferReasoning(id: string): boolean {
  return /(-thinking|-high|-xhigh|-max-high)$/.test(id);
}

/**
 * Parse the text output of `agent models` into a list of model definitions.
 *
 * Expected format (one model per line after the header, before the tip):
 *   <id> - <name>  [(current[, default] | default)]
 *
 * Example lines:
 *   "auto - Auto"
 *   "opus-4.6-thinking - Claude 4.6 Opus (Thinking)  (default)"
 *   "sonnet-4.6 - Claude 4.6 Sonnet  (current)"
 */
function parseAgentModelsOutput(output: string): CursorModelDef[] {
  const results: CursorModelDef[] = [];
  // Match lines like: "model-id - Display Name  (optional flags)"
  const lineRe =
    /^([a-zA-Z0-9][a-zA-Z0-9._-]*)\s+-\s+(.+?)(?:\s+\((?:current|default|current,\s*default)\))?$/;

  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (
      !trimmed ||
      trimmed.startsWith("Available") ||
      trimmed.startsWith("Tip:")
    )
      continue;
    const match = lineRe.exec(trimmed);
    if (!match) continue;

    const id = match[1].trim();
    const rawName = match[2].trim();

    // Use static attributes if available, otherwise infer
    const known = STATIC_MODELS_MAP.get(id);
    results.push({
      id,
      name: rawName,
      reasoning: known?.reasoning ?? inferReasoning(id),
      contextWindow: known?.contextWindow ?? 200000,
      maxTokens: known?.maxTokens ?? 32768,
    });
  }
  return results;
}

/**
 * Run `agent models` and return the parsed model list.
 * Rejects if the CLI exits with an error, produces no usable output, or
 * exceeds the discovery timeout.
 */
function runAgentModels(agentPath: string): Promise<CursorModelDef[]> {
  return new Promise((resolve, reject) => {
    const args = ["models"];
    if (process.env["CURSOR_API_KEY"]) {
      args.unshift("--api-key", process.env["CURSOR_API_KEY"]);
    }

    let stdout = "";
    let stderr = "";
    const child = spawn(agentPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(
        new Error(`agent models timed out after ${DISCOVERY_TIMEOUT_MS}ms`),
      );
    }, DISCOVERY_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(
          new Error(`agent models exited with code ${code}: ${stderr.trim()}`),
        );
        return;
      }
      const models = parseAgentModelsOutput(stdout);
      if (models.length === 0) {
        reject(new Error("agent models returned no models"));
        return;
      }
      resolve(models);
    });
  });
}

// ---------------------------------------------------------------------------
// Prompt serialisation
// Serialises the Pi context into a single text prompt for the CLI.
// The prompt is delivered on stdin (not argv): a single Linux argv cannot
// exceed MAX_ARG_STRLEN (131072), and long Pi sessions hit that during
// auto-compaction summarization. Multi-turn history is a prefixed transcript.
// ---------------------------------------------------------------------------

/**
 * Linux rejects a single argv string longer than MAX_ARG_STRLEN (131072 bytes).
 * Long Pi sessions (especially auto-compaction summarization) exceed that when
 * the full transcript is passed as a CLI prompt argument, producing
 * `spawn E2BIG` and "Auto-compaction failed: Summarization failed: spawn E2BIG".
 * Always deliver the print prompt on stdin instead of argv.
 */
function spawnAgentPrint(
  agentPath: string,
  args: string[],
  prompt: string,
  env: NodeJS.ProcessEnv = process.env,
): ReturnType<typeof spawn> {
  const child = spawn(agentPath, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });
  // Ignore EPIPE when the child exits before draining stdin.
  child.stdin?.on("error", () => {});
  child.stdin?.end(prompt, "utf8");
  return child;
}

/**
 * Convert a content block (text or image) to a plain string for the CLI prompt.
 * Images are serialised as a textual placeholder because the Cursor Agent CLI
 * (v2026.02.13) does not support image attachments in the `--print` prompt.
 * The placeholder preserves the image's MIME type and byte-size so the model
 * can at least acknowledge that an image was intended.
 */
function contentBlockToText(
  block: TextContent | import("@mariozechner/pi-ai").ImageContent,
): string {
  if (block.type === "text") return block.text;
  // ImageContent: { type: "image", data: string (base64), mimeType: string }
  const bytes = Math.round((block.data.length * 3) / 4);
  return `[Image: ${block.mimeType}, ~${bytes} bytes — note: image input is not supported by the Cursor Agent CLI; the visual content cannot be passed through]`;
}

/**
 * Pi 1.x hands providers a TranscriptContext: `context.systemPrompt` is unset
 * and the prompt lives in transcript system messages (`content` plus named
 * `sections`). Older Pi versions set the field directly, so prefer it and
 * replay the system messages only when it is absent. The replay mirrors
 * pi-ai's `getCurrentSystemPrompt`.
 */
type SystemMessageLike = {
  role?: string;
  content?: unknown;
  sections?: Record<string, string | null>;
};

function systemContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is TextContent =>
        typeof block === "object" &&
        block !== null &&
        (block as TextContent).type === "text" &&
        typeof (block as TextContent).text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

export function resolveSystemPrompt(context: Context): string {
  if (context.systemPrompt) return context.systemPrompt;
  const messages = (context.messages ?? []) as readonly SystemMessageLike[];
  const content: string[] = [];
  const sections = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "system") continue;
    const text = systemContentText(message.content);
    if (text.length > 0) content.push(text);
    for (const [name, value] of Object.entries(message.sections ?? {})) {
      if (value === null) sections.delete(name);
      else sections.set(name, value);
    }
  }
  return [content.join("\n\n"), ...sections.values()]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

export function serializeContext(context: Context): string {
  const lines: string[] = [];

  const systemPrompt = resolveSystemPrompt(context);
  if (systemPrompt) {
    lines.push(`[System]\n${systemPrompt}\n`);
  }

  for (const msg of context.messages) {
    if (msg.role === "user") {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : msg.content.map(contentBlockToText).join("\n");
      lines.push(`[User]\n${text}`);
    } else if (msg.role === "assistant") {
      const text = msg.content
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      if (text.trim()) {
        lines.push(`[Assistant]\n${text}`);
      }
    } else if (msg.role === "toolResult") {
      const text = msg.content.map(contentBlockToText).join("\n");
      if (text.trim()) {
        lines.push(`[Tool result: ${msg.toolName}]\n${text}`);
      }
    }
  }

  return lines.join("\n\n");
}

// ---------------------------------------------------------------------------
// NDJSON event types — Cursor CLI stream-json shape
// ---------------------------------------------------------------------------

interface CursorAssistantEvent {
  type: "assistant";
  message: {
    role: "assistant";
    content: Array<{ type: "text"; text: string }>;
  };
  session_id: string;
}

/**
 * A single Cursor CLI tool call (the value keyed by tool name).
 * The key is the tool name in camelCase (e.g. "shellToolCall", "readToolCall").
 * args are present on both started and completed; result only on completed.
 */
interface CursorToolCallPayload {
  args: Record<string, unknown>;
  /** The vendor's own human description of the call, when it sends one. */
  description?: string;
  result?: {
    success?: Record<string, unknown>;
    rejected?: { reason?: string };
    error?: { message?: string };
  };
}

interface CursorToolCallEvent {
  type: "tool_call";
  subtype: "started" | "completed";
  /** The outer object has exactly one key: the tool name (e.g. "shellToolCall"). */
  tool_call: Record<string, CursorToolCallPayload>;
}

interface CursorResultEvent {
  type: "result";
  subtype: string;
  duration_ms: number;
}

type CursorStreamEvent =
  | CursorAssistantEvent
  | CursorToolCallEvent
  | CursorResultEvent
  | { type: string };

function parseLine(line: string): CursorStreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as CursorStreamEvent;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tool name mapping — CLI camelCase key → Pi display name
// ---------------------------------------------------------------------------

const TOOL_NAME_MAP: Record<string, string> = {
  shellToolCall: "Shell",
  readToolCall: "Read",
  editToolCall: "Edit",
  writeToolCall: "Write",
  deleteToolCall: "Delete",
  grepToolCall: "Grep",
  globToolCall: "Glob",
  lsToolCall: "Ls",
  todoToolCall: "Todo",
  updateTodosToolCall: "UpdateTodos",
  findToolCall: "Find",
  webFetchToolCall: "WebFetch",
  webSearchToolCall: "WebSearch",
};

/** Convert a CLI tool event key (e.g. "shellToolCall") to a Pi tool name. */
function toPiToolName(cliKey: string): string {
  return TOOL_NAME_MAP[cliKey] ?? cliKey.replace(/ToolCall$/, "");
}

// ---------------------------------------------------------------------------
// Tool marker formatting — human-readable stand-ins for Pi toolcall events
// ---------------------------------------------------------------------------

/**
 * Pick the tool-name key out of a `tool_call` event. The outer object also
 * carries siblings such as `toolCallId`, and the vendor controls their
 * order, so match the `*ToolCall` suffix instead of trusting position.
 */
export function toolKeyOf(
  toolCall: Record<string, unknown>,
): string | undefined {
  const keys = Object.keys(toolCall);
  return keys.find((key) => key.endsWith("ToolCall")) ?? keys[0];
}

/** Argument keys that identify what the tool operates on. */
const PRIMARY_ARG_KEYS = [
  "command",
  "path",
  "pattern",
  "query",
  "url",
  "file_path",
  "filePath",
  "target",
] as const;

/** Args keys the vendor fills with bookkeeping; never worth showing. */
const INTERNAL_ARG_KEYS = new Set([
  "adminCommandDenylist",
  "closeStdin",
  "completedAtMs",
  "conversationId",
  "description",
  "fileOutputThresholdBytes",
  "hardTimeout",
  "hasInputRedirect",
  "hasOutputRedirect",
  "hookAdditionalContexts",
  "isBackground",
  "parsingResult",
  "requestId",
  "simpleCommands",
  "skipApproval",
  "startedAtMs",
  "timeout",
  "timeoutBehavior",
  "toolCallId",
  "workingDirectory",
]);

function sanitizeInline(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function stripAnsi(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI SGR escapes are exactly what this strips
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

/**
 * One human-readable line for a tool call that just started: the exact
 * primary argument (command, path, pattern …) when the payload has one,
 * else the vendor's own description, else the non-bookkeeping args. The
 * raw args dump it replaces carried toolCallId/requestId noise and broke
 * across embedded newlines.
 */
export function formatToolStart(
  name: string,
  payload: CursorToolCallPayload,
): string {
  const args = payload.args ?? {};
  for (const key of PRIMARY_ARG_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      return `⏳ [${name}] ${truncate(sanitizeInline(value), 120)}`;
    }
  }
  for (const candidate of [payload.description, args.description]) {
    if (typeof candidate === "string" && candidate.trim()) {
      return `⏳ [${name}] ${truncate(sanitizeInline(candidate), 120)}`;
    }
  }
  const visible = Object.fromEntries(
    Object.entries(args).filter(
      ([key, value]) =>
        !INTERNAL_ARG_KEYS.has(key) &&
        (typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean"),
    ),
  );
  const fallback = JSON.stringify(visible) ?? "{}";
  return `⏳ [${name}] ${truncate(sanitizeInline(fallback), 120)}`;
}

/**
 * One human-readable marker for a finished tool call: the vendor's verdict
 * plus its short output (stdout/content), or undefined when the payload
 * carries nothing to report. Completed calls used to be dropped entirely,
 * so a turn showed call traces and no results.
 */
export function formatToolResult(
  name: string,
  result: CursorToolCallPayload["result"],
): string | undefined {
  if (!result) return undefined;
  if (result.success) {
    const success = result.success;
    const parts = [`✓ [${name}]`];
    if (typeof success.exitCode === "number") {
      parts.push(`exit ${success.exitCode}`);
    }
    if (typeof success.executionTime === "number") {
      parts.push(`${success.executionTime}ms`);
    }
    const head =
      parts.length > 1 ? `${parts[0]} ${parts.slice(1).join(" · ")}` : parts[0];
    for (const key of ["stdout", "content", "output", "text", "result"]) {
      const value = success[key];
      if (typeof value === "string" && value.trim()) {
        const body = truncate(stripAnsi(value).replace(/\s+$/, ""), 400);
        return `${head}\n${body}`;
      }
    }
    return head;
  }
  if (result.rejected) {
    const reason = sanitizeInline(result.rejected.reason ?? "");
    return `✗ [${name}] blocked${reason ? `: ${truncate(reason, 120)}` : ""}`;
  }
  if (result.error) {
    const message = sanitizeInline(result.error.message ?? "");
    return `✗ [${name}]${message ? ` ${truncate(message, 160)}` : " failed"}`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// streamSimple — the custom backend for the cursor provider
// ---------------------------------------------------------------------------

function streamCursorCli(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const startTime = Date.now();
    let firstTokenTime: number | undefined;

    const output: AssistantMessage & { duration?: number; ttft?: number } = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    const setTiming = () => {
      output.duration = Date.now() - startTime;
      output.ttft =
        firstTokenTime != null ? firstTokenTime - startTime : undefined;
    };

    try {
      const agentPath =
        process.env["CURSOR_AGENT_PATH"] ??
        process.env["AGENT_PATH"] ??
        "agent";

      const workspacePath = process.cwd();
      const prompt = serializeContext(context);
      const reasoningLevel = (options as { reasoning?: string })?.reasoning;
      const cliModelId = toCursorId(model.id, reasoningLevel);

      // Prompt stays off argv — see spawnAgentPrint / Linux MAX_ARG_STRLEN.
      const args = [
        "--print",
        "--output-format",
        "stream-json",
        "--model",
        cliModelId,
        "--trust",
        "--workspace",
        workspacePath,
      ];

      if (process.env["CURSOR_API_KEY"]) {
        args.unshift("--api-key", process.env["CURSOR_API_KEY"]);
      }

      stream.push({ type: "start", partial: output });

      const child = spawnAgentPrint(agentPath, args, prompt);

      const onAbort = () => {
        child.kill("SIGTERM");
      };
      options?.signal?.addEventListener("abort", onAbort, { once: true });

      const stderrChunks: string[] = [];
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk.toString());
      });

      let textBlockOpen = false;
      let accumulatedText = "";

      const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });

      rl.on("line", (line: string) => {
        const event = parseLine(line);
        if (!event) return;

        if (event.type === "assistant") {
          const ae = event as CursorAssistantEvent;
          for (const block of ae.message.content) {
            if (block.type !== "text") continue;
            if (!block.text.trim()) continue;

            if (firstTokenTime === undefined) firstTokenTime = Date.now();
            if (!textBlockOpen) {
              output.content.push({ type: "text", text: "" });
              const idx = output.content.length - 1;
              stream.push({
                type: "text_start",
                contentIndex: idx,
                partial: output,
              });
              textBlockOpen = true;
            }

            const idx = output.content.length - 1;
            const textBlock = output.content[idx] as TextContent;
            textBlock.text += block.text;
            accumulatedText += block.text;
            stream.push({
              type: "text_delta",
              contentIndex: idx,
              delta: block.text,
              partial: output,
            });
          }
          return;
        }

        // Tool calls are rendered as informational text, not as Pi toolcall_*
        // events, to prevent Pi's agentic loop from re-invoking streamSimple:
        // the Cursor CLI runs its own tool loop inside this one Pi turn.
        if (event.type === "tool_call") {
          const tce = event as CursorToolCallEvent;
          const cliKey = toolKeyOf(tce.tool_call);
          if (!cliKey) return;
          const payload = tce.tool_call[cliKey];
          const toolName = toPiToolName(cliKey);
          const marker =
            tce.subtype === "started"
              ? formatToolStart(toolName, payload)
              : tce.subtype === "completed"
                ? formatToolResult(toolName, payload.result)
                : undefined;
          if (!marker) return;
          const text = `\n${marker}\n`;

          if (!textBlockOpen) {
            output.content.push({ type: "text", text: "" });
            const idx = output.content.length - 1;
            stream.push({
              type: "text_start",
              contentIndex: idx,
              partial: output,
            });
            textBlockOpen = true;
          }
          const idx = output.content.length - 1;
          const textBlock = output.content[idx] as TextContent;
          textBlock.text += text;
          accumulatedText += text;
          stream.push({
            type: "text_delta",
            contentIndex: idx,
            delta: text,
            partial: output,
          });
        }
      });

      await new Promise<void>((resolve) => {
        child.on("close", (code) => {
          options?.signal?.removeEventListener("abort", onAbort);

          if (textBlockOpen) {
            const idx = output.content.length - 1;
            stream.push({
              type: "text_end",
              contentIndex: idx,
              content: accumulatedText,
              partial: output,
            });
            textBlockOpen = false;
          }

          if (options?.signal?.aborted) {
            output.stopReason = "aborted";
            setTiming();
            stream.push({ type: "error", reason: "aborted", error: output });
            stream.end();
            resolve();
            return;
          }

          if (code !== 0 && !accumulatedText) {
            const stderr = stderrChunks.join("").trim();
            output.stopReason = "error";
            output.errorMessage =
              stderr || `Cursor CLI exited with code ${code}`;
            setTiming();
            stream.push({ type: "error", reason: "error", error: output });
            stream.end();
            resolve();
            return;
          }

          setTiming();
          stream.push({ type: "done", reason: "stop", message: output });
          stream.end();
          resolve();
        });

        child.on("error", (err) => {
          options?.signal?.removeEventListener("abort", onAbort);
          output.stopReason = "error";
          output.errorMessage = err.message;
          setTiming();
          stream.push({ type: "error", reason: "error", error: output });
          stream.end();
          resolve();
        });
      });
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage =
        error instanceof Error ? error.message : String(error);
      setTiming();
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

/**
 * Spawn `agent login` in an interactive child process so the user can
 * authenticate with Cursor from within a Pi session.
 * Returns a promise that resolves when login completes (exit 0) and rejects
 * on non-zero exit or spawn error.
 */
function runAgentLogin(agentPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args: string[] = ["login"];
    // Suppress browser-open so login is purely CLI-driven (prints URL/code)
    const env = { ...process.env, NO_OPEN_BROWSER: "1" };

    const child = spawn(agentPath, args, {
      stdio: "inherit",
      env,
    });

    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`agent login exited with code ${code}`));
    });
  });
}

/**
 * Run `agent status` and return the trimmed output (e.g. "✓ Logged in as …").
 */
function runAgentStatus(agentPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    const child = spawn(agentPath, ["status"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    child.stdout?.on("data", (c: Buffer) => {
      out += c.toString();
    });
    child.stderr?.on("data", (c: Buffer) => {
      out += c.toString();
    });
    child.on("error", (err) => reject(err));
    child.on("close", () => resolve(out.trim()));
  });
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

/**
 * Build a ProviderModelConfig array from a list of CursorModelDef entries.
 * Uses canonical IDs where a mapping exists and omits variant-only entries.
 */
function toProviderModels(defs: CursorModelDef[]) {
  const seen = new Set<string>();
  return defs.flatMap((m) => {
    const canonicalId = toCanonicalId(m.id);
    if (canonicalId === null) return []; // variant-only; hide
    const id = canonicalId !== m.id ? canonicalId : m.id;
    if (seen.has(id)) return [];
    seen.add(id);
    return [
      {
        id,
        name: `${m.name} (Cursor)`,
        reasoning: m.reasoning,
        input: ["text"] as ("text" | "image")[],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
      },
    ];
  });
}

// ---------------------------------------------------------------------------
// Model catalog cache (non-blocking startup)
// ---------------------------------------------------------------------------

/**
 * Cursor's `agent models` commonly takes ~2–3s. Awaiting it inside the
 * extension factory blocks Pi startup for every session. Instead we register
 * immediately from a disk cache (falling back to STATIC_MODELS) and refresh
 * the catalog from `session_start` when the cache is stale.
 *
 * Override path with CURSOR_MODELS_CACHE. Default TTL is 24h.
 */
const CACHE_PATH =
  process.env["CURSOR_MODELS_CACHE"] ??
  join(homedir(), ".pi", "agent", "cursor-models-cache.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface ModelsCache {
  at: number;
  models: CursorModelDef[];
}

function loadModelsCache(): CursorModelDef[] | null {
  try {
    const parsed = JSON.parse(readFileSync(CACHE_PATH, "utf-8")) as ModelsCache;
    if (Array.isArray(parsed?.models) && parsed.models.length > 0)
      return parsed.models;
  } catch {
    // no cache yet
  }
  return null;
}

function saveModelsCache(models: CursorModelDef[]): void {
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    const tmpPath = `${CACHE_PATH}.${process.pid}.tmp`;
    writeFileSync(
      tmpPath,
      JSON.stringify({ at: Date.now(), models } satisfies ModelsCache),
    );
    renameSync(tmpPath, CACHE_PATH);
  } catch {
    // cache write is best-effort
  }
}

function cacheIsFresh(): boolean {
  try {
    const parsed = JSON.parse(readFileSync(CACHE_PATH, "utf-8")) as ModelsCache;
    return (
      typeof parsed?.at === "number" && Date.now() - parsed.at < CACHE_TTL_MS
    );
  } catch {
    return false;
  }
}

/** Refresh cache from `agent models`. Safe to call without awaiting at session start. */
async function refreshModelsCache(
  agentPath: string,
): Promise<CursorModelDef[] | null> {
  try {
    const defs = await runAgentModels(agentPath);
    saveModelsCache(defs);
    return defs;
  } catch {
    return null;
  }
}

function registerCursorProvider(
  pi: ExtensionAPI,
  modelDefs: CursorModelDef[],
): void {
  pi.registerProvider("cursor", {
    baseUrl: "cli://cursor-agent",
    apiKey: "CURSOR_API_KEY",
    api: "cursor-cli" as Api,
    models: toProviderModels(modelDefs),
    streamSimple: streamCursorCli,
  });
}

export default function (pi: ExtensionAPI) {
  const agentPath =
    process.env["CURSOR_AGENT_PATH"] ?? process.env["AGENT_PATH"] ?? "agent";

  // Non-blocking startup: register from cache (or static list) immediately.
  // Background discovery is deferred to session_start so factory-only
  // invocations (e.g. --list-models) do not spawn `agent models`.
  registerCursorProvider(pi, loadModelsCache() ?? STATIC_MODELS);

  pi.on("session_start", () => {
    if (!cacheIsFresh()) {
      void (async () => {
        const defs = await refreshModelsCache(agentPath);
        if (defs) registerCursorProvider(pi, defs);
      })();
    }
  });

  // ---------------------------------------------------------------------------
  // Slash commands for Cursor auth management
  // ---------------------------------------------------------------------------

  pi.registerCommand("cursor-models-refresh", {
    description: "Refresh cached Cursor model catalog (run `agent models`)",
    handler: async (_args, ctx) => {
      const defs = await refreshModelsCache(agentPath);
      if (defs) {
        registerCursorProvider(pi, defs);
        ctx.ui.notify(
          `Cursor model catalog refreshed (${defs.length} models).`,
          "info",
        );
      } else {
        ctx.ui.notify(
          "Failed to refresh Cursor model catalog (agent models error); keeping cached list.",
          "error",
        );
      }
    },
  });

  pi.registerCommand("cursor-login", {
    description: "Log in to Cursor (runs `agent login`)",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        "Starting Cursor login (NO_OPEN_BROWSER=1 — copy the URL from the output)…",
        "info",
      );
      try {
        await runAgentLogin(agentPath);
        ctx.ui.notify("Cursor login successful.", "info");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Cursor login failed: ${msg}`, "error");
      }
    },
  });

  pi.registerCommand("cursor-status", {
    description: "Show Cursor authentication status (runs `agent status`)",
    handler: async (_args, ctx) => {
      try {
        const status = await runAgentStatus(agentPath);
        ctx.ui.notify(status || "No output from `agent status`.", "info");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Could not get Cursor status: ${msg}`, "error");
      }
    },
  });

  pi.registerCommand("cursor-logout", {
    description: "Log out of Cursor (runs `agent logout`)",
    handler: async (_args, ctx) => {
      try {
        await new Promise<void>((resolve, reject) => {
          const child = spawn(agentPath, ["logout"], {
            stdio: "inherit",
            env: process.env,
          });
          child.on("error", reject);
          child.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`agent logout exited with code ${code}`));
          });
        });
        ctx.ui.notify("Logged out of Cursor.", "info");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Cursor logout failed: ${msg}`, "error");
      }
    },
  });
}
