/**
 * Nexus Token Gate — Layer 1 of the Quorbz security model
 *
 * Every agent must hold a valid activation token issued by Nexus to
 * process tasks. Tokens are short-lived (default 15 min) and must be
 * refreshed via the Nexus heartbeat endpoint.
 *
 * States:
 *   active    — valid token, agent processes normally
 *   suspended — token expired or Nexus unreachable; agent waits, no tasks run
 *   revoked   — Nexus explicitly revoked this agent; agent shuts down cleanly
 *
 * Kill switch: POST /api/agents/{id}/revoke on Nexus → all running task
 * loops see REVOKED on next token check and stop immediately.
 */

import { logger } from '../logger.js';
import { readEnvFile } from '../env.js';

export type GateState = 'active' | 'suspended' | 'revoked';

interface TokenResponse {
  token: string;
  expiresAt: number;   // Unix ms
  state: GateState;
}

interface CheckResponse {
  valid: boolean;
  state: GateState;
  reason?: string;
}

// Grace period: retry Nexus connection for this many ms before suspending
const NEXUS_UNREACHABLE_GRACE_MS = 10 * 60 * 1000;  // 10 minutes
// How often to refresh the token (must be < token TTL on Nexus)
const TOKEN_REFRESH_INTERVAL_MS = 12 * 60 * 1000;   // 12 minutes
// Token validity window — if expiry is within this, refresh now
const TOKEN_REFRESH_EARLY_MS = 3 * 60 * 1000;        // 3 minutes

let currentToken: string | null = null;
let tokenExpiresAt: number = 0;
let gateState: GateState = 'suspended';
let nexusFirstUnreachableAt: number | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

function getNexusConfig(): { url: string; agentId: string } {
  const env = readEnvFile(['NEXUS_URL', 'NEXUS_AGENT_ID']);
  const url =
    process.env.NEXUS_URL || env.NEXUS_URL || 'http://localhost:4000';
  const agentId =
    process.env.NEXUS_AGENT_ID || env.NEXUS_AGENT_ID || 'unknown';
  return { url, agentId };
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs = 8000,
): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

/**
 * Request a fresh activation token from Nexus.
 * Returns null if Nexus is unreachable.
 */
async function requestToken(): Promise<TokenResponse | null> {
  const { url, agentId } = getNexusConfig();
  try {
    const res = await fetchWithTimeout(
      `${url}/api/security/activate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId }),
      },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      if (res.status === 403 && (body as any).state === 'revoked') {
        return { token: '', expiresAt: 0, state: 'revoked' };
      }
      logger.warn({ status: res.status, agentId }, 'Nexus token request failed');
      return null;
    }
    return res.json() as Promise<TokenResponse>;
  } catch (err) {
    logger.debug({ err, agentId }, 'Nexus unreachable during token request');
    return null;
  }
}

/**
 * Verify the current token is still valid with Nexus.
 */
async function checkToken(token: string): Promise<CheckResponse> {
  const { url, agentId } = getNexusConfig();
  try {
    const res = await fetchWithTimeout(
      `${url}/api/security/verify`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Agent-Token': token,
        },
        body: JSON.stringify({ agentId }),
      },
    );
    if (!res.ok) {
      return { valid: false, state: 'suspended', reason: `http_${res.status}` };
    }
    return res.json() as Promise<CheckResponse>;
  } catch (err) {
    return { valid: false, state: 'suspended', reason: 'nexus_unreachable' };
  }
}

/**
 * Attempt to get or refresh the activation token.
 * Handles the grace period for Nexus being temporarily unreachable.
 */
async function refreshToken(): Promise<void> {
  const { agentId } = getNexusConfig();

  // If token is still valid and not near expiry, skip
  if (
    currentToken &&
    Date.now() < tokenExpiresAt - TOKEN_REFRESH_EARLY_MS &&
    gateState === 'active'
  ) {
    return;
  }

  const response = await requestToken();

  if (!response) {
    // Nexus unreachable
    if (nexusFirstUnreachableAt === null) {
      nexusFirstUnreachableAt = Date.now();
      logger.warn({ agentId }, 'Nexus unreachable — starting grace period');
    }

    const elapsed = Date.now() - nexusFirstUnreachableAt;
    if (elapsed > NEXUS_UNREACHABLE_GRACE_MS) {
      logger.error(
        { agentId, elapsed },
        'Nexus unreachable beyond grace period — suspending agent',
      );
      gateState = 'suspended';
    } else {
      logger.info(
        { agentId, remainingMs: NEXUS_UNREACHABLE_GRACE_MS - elapsed },
        'Nexus unreachable — within grace period, retrying',
      );
      // Keep previous state during grace period
    }
    return;
  }

  // Nexus is reachable — reset grace period counter
  nexusFirstUnreachableAt = null;

  if (response.state === 'revoked') {
    logger.error({ agentId }, 'Agent token REVOKED by Nexus — shutting down');
    gateState = 'revoked';
    currentToken = null;
    return;
  }

  currentToken = response.token;
  tokenExpiresAt = response.expiresAt;
  gateState = response.state;

  logger.info(
    { agentId, state: gateState, expiresAt: new Date(tokenExpiresAt).toISOString() },
    'Nexus activation token refreshed',
  );
}

/**
 * Initialize the Nexus gate. Blocks until an active token is obtained
 * or the grace period expires. Must be called before the main loop starts.
 */
export async function initNexusGate(): Promise<void> {
  const { agentId } = getNexusConfig();
  logger.info({ agentId }, 'Nexus gate: requesting activation token...');

  // Retry with backoff during startup
  for (let attempt = 1; attempt <= 20; attempt++) {
    await refreshToken();
    if (gateState === 'active') {
      logger.info({ agentId }, 'Nexus gate: ACTIVE');
      break;
    }
    if (gateState === 'revoked') {
      throw new Error(`Agent ${agentId} is REVOKED — cannot start`);
    }
    const delaySec = Math.min(30, attempt * 5);
    logger.info({ agentId, attempt, delaySec }, 'Nexus gate: waiting to retry...');
    await new Promise((r) => setTimeout(r, delaySec * 1000));
  }

  if (gateState !== 'active') {
    throw new Error(
      `Nexus gate: failed to obtain active token after startup retries — agent suspended`,
    );
  }

  // Start background refresh loop
  refreshTimer = setInterval(refreshToken, TOKEN_REFRESH_INTERVAL_MS);
}

/**
 * Check whether the gate is currently active.
 * Call this at the top of every task processing loop iteration.
 */
export function isGateActive(): boolean {
  return gateState === 'active';
}

export function getGateState(): GateState {
  return gateState;
}

/**
 * Gracefully shut down the gate (clean up the refresh timer).
 */
export function shutdownNexusGate(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  logger.info('Nexus gate: shutdown');
}

/**
 * Get the current token for use in outbound Nexus API calls.
 */
export function getNexusToken(): string | null {
  return currentToken;
}
