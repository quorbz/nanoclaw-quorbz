import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'ONECLI_URL',
  'TZ',
  'XAI_API_KEY',
  'XAI_MODEL',
  // LLM provider abstraction (Quorbz superfork)
  'AI_PROVIDER',
  'AI_MODEL',
  'AI_MODEL_PREMIUM',
  'AI_ENABLE_PREMIUM',
  'ANTHROPIC_API_KEY',
  // Nexus security layer
  'NEXUS_URL',
  'NEXUS_AGENT_ID',
  // Role boundary + egress
  'AGENT_ROLE_MANIFEST',
  'AGENT_EGRESS_ALLOWLIST',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

// xAI / Grok configuration (legacy — prefer AI_PROVIDER abstraction below)
export const XAI_API_KEY = process.env.XAI_API_KEY || envConfig.XAI_API_KEY;
export const XAI_MODEL =
  process.env.XAI_MODEL || envConfig.XAI_MODEL || 'grok-4-1-fast-reasoning';

// LLM provider abstraction — AI_PROVIDER=xai|anthropic
export const AI_PROVIDER = (
  process.env.AI_PROVIDER || envConfig.AI_PROVIDER || 'xai'
).toLowerCase();
export const AI_MODEL = process.env.AI_MODEL || envConfig.AI_MODEL;
export const AI_MODEL_PREMIUM =
  process.env.AI_MODEL_PREMIUM || envConfig.AI_MODEL_PREMIUM;
export const AI_ENABLE_PREMIUM =
  (process.env.AI_ENABLE_PREMIUM || envConfig.AI_ENABLE_PREMIUM) === 'true';
export const ANTHROPIC_API_KEY =
  process.env.ANTHROPIC_API_KEY || envConfig.ANTHROPIC_API_KEY;

// Nexus security layer
export const NEXUS_URL =
  process.env.NEXUS_URL || envConfig.NEXUS_URL || 'http://localhost:4000';
export const NEXUS_AGENT_ID =
  process.env.NEXUS_AGENT_ID || envConfig.NEXUS_AGENT_ID || 'unknown';

// Role boundary + egress
export const AGENT_ROLE_MANIFEST =
  process.env.AGENT_ROLE_MANIFEST || envConfig.AGENT_ROLE_MANIFEST;
export const AGENT_EGRESS_ALLOWLIST =
  process.env.AGENT_EGRESS_ALLOWLIST || envConfig.AGENT_EGRESS_ALLOWLIST || '';

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-xai-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const ONECLI_URL = process.env.ONECLI_URL || envConfig.ONECLI_URL;
export const MAX_MESSAGES_PER_PROMPT = Math.max(
  1,
  parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`^${escapeRegex(trigger.trim())}\\b`, 'i');
}

export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}

export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [
    process.env.TZ,
    envConfig.TZ,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  ];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();
