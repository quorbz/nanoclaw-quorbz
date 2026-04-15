/**
 * LLM Provider Abstraction — NanoClaw Quorbz Superfork
 *
 * Single abstraction layer over xAI (Grok) and Anthropic (Claude) APIs.
 * All agent container launches route through here — the rest of the
 * codebase never imports an LLM SDK directly.
 *
 * Config (injected via OneCLI vault per agent):
 *   AI_PROVIDER=xai | anthropic           (default: xai)
 *   AI_MODEL=<model-id>                   (default per provider below)
 *   AI_MODEL_PREMIUM=<model-id>           (optional, requires explicit enable)
 *   AI_ENABLE_PREMIUM=true                (must be set to use premium model)
 */

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type LLMProvider = 'xai' | 'anthropic';

export interface LLMConfig {
  provider: LLMProvider;
  model: string;
  apiKeyEnvVar: string;  // which env var holds the key for this provider
}

const DEFAULT_MODELS: Record<LLMProvider, string> = {
  xai:       'grok-4-1-fast-reasoning',
  anthropic: 'claude-sonnet-4-6',
};

const PREMIUM_MODELS: Record<LLMProvider, string> = {
  xai:       'grok-4-1',               // full reasoning, higher cost
  anthropic: 'claude-opus-4-6',        // requires Benjamin approval per policy
};

const API_KEY_ENV_VARS: Record<LLMProvider, string> = {
  xai:       'XAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
};

/**
 * Resolve which LLM config to use for a container launch.
 * Reads AI_PROVIDER, AI_MODEL, AI_ENABLE_PREMIUM from env.
 */
export function resolveLLMConfig(): LLMConfig {
  const envConfig = readEnvFile([
    'AI_PROVIDER',
    'AI_MODEL',
    'AI_MODEL_PREMIUM',
    'AI_ENABLE_PREMIUM',
  ]);

  const rawProvider = (
    process.env.AI_PROVIDER || envConfig.AI_PROVIDER || 'xai'
  ).toLowerCase();

  if (rawProvider !== 'xai' && rawProvider !== 'anthropic') {
    logger.warn(
      { rawProvider },
      `Unknown AI_PROVIDER "${rawProvider}" — falling back to xai`,
    );
  }

  const provider: LLMProvider =
    rawProvider === 'anthropic' ? 'anthropic' : 'xai';

  const premiumEnabled =
    (process.env.AI_ENABLE_PREMIUM || envConfig.AI_ENABLE_PREMIUM) === 'true';

  let model: string;
  if (premiumEnabled) {
    model =
      process.env.AI_MODEL_PREMIUM ||
      envConfig.AI_MODEL_PREMIUM ||
      PREMIUM_MODELS[provider];
    logger.warn(
      { provider, model },
      'PREMIUM model enabled — cost event logged',
    );
  } else {
    model =
      process.env.AI_MODEL ||
      envConfig.AI_MODEL ||
      DEFAULT_MODELS[provider];
  }

  const config: LLMConfig = {
    provider,
    model,
    apiKeyEnvVar: API_KEY_ENV_VARS[provider],
  };

  logger.info({ provider, model }, 'LLM provider resolved');
  return config;
}

/**
 * Build the container env-var args for LLM provider injection.
 * Returns an array of ['-e', 'KEY=VALUE'] pairs ready to splice
 * into a docker/podman run command.
 *
 * The actual API key is injected by OneCLI at the gateway level —
 * this function only sets the model identifier and provider hint
 * so the container knows which provider it's using.
 */
export function buildLLMEnvArgs(config: LLMConfig): string[] {
  const args: string[] = [];

  // Tell the container which provider and model to use
  args.push('-e', `AI_PROVIDER=${config.provider}`);
  args.push('-e', `AI_MODEL=${config.model}`);

  // Legacy compat: xAI containers expect XAI_MODEL env var
  if (config.provider === 'xai') {
    args.push('-e', `XAI_MODEL=${config.model}`);
  }

  return args;
}

/**
 * Return the OneCLI agent identifier suffix for this provider.
 * OneCLI vault uses this to inject the right API key.
 */
export function getLLMAgentVaultKey(
  baseAgent: string,
  config: LLMConfig,
): string {
  // Convention: vault key is "<agent-id>.<provider>"
  // e.g., "agent-elena.xai" or "agent-mila.anthropic"
  return `${baseAgent}.${config.provider}`;
}
