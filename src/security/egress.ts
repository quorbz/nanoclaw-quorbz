/**
 * Egress Whitelist — Layer 4 of the Quorbz security model
 *
 * All outbound HTTP calls made by the NanoClaw process (not inside
 * agent containers) are checked against a per-agent domain allowlist
 * before being executed. Calls to non-whitelisted domains are blocked
 * and logged as security incidents.
 *
 * Container-level egress is enforced via Docker network policy (set at
 * deploy time) — this layer covers the orchestrator process itself.
 *
 * The allowlist is loaded from AGENT_EGRESS_ALLOWLIST env var (comma-
 * separated domains) or fetched from the Nexus manifest.
 */

import os from 'os';
import { logger } from '../logger.js';
import { readEnvFile } from '../env.js';
import { getNexusToken } from './nexus-gate.js';
import { getManifest } from './role-boundary.js';

// Domains that are always permitted regardless of manifest
// (needed for the security layer itself to function)
const SYSTEM_ALWAYS_ALLOWED = [
  'localhost',
  '127.0.0.1',
  '::1',
  // Nexus URL is resolved at runtime and added dynamically
];

let nexusHostname: string | null = null;

function getNexusConfig(): { url: string; agentId: string } {
  const env = readEnvFile(['NEXUS_URL', 'NEXUS_AGENT_ID']);
  return {
    url: process.env.NEXUS_URL || env.NEXUS_URL || 'http://localhost:4000',
    agentId: process.env.NEXUS_AGENT_ID || env.NEXUS_AGENT_ID || 'unknown',
  };
}

/**
 * Initialize the egress module. Call once at startup.
 */
export function initEgress(): void {
  const { url } = getNexusConfig();
  try {
    nexusHostname = new URL(url).hostname;
    logger.info(
      { nexusHostname },
      'Egress: Nexus hostname added to system allowlist',
    );
  } catch {
    logger.warn({ url }, 'Egress: could not parse Nexus URL for allowlist');
  }
}

/**
 * Get the combined allowlist: system defaults + manifest domains +
 * env-var overrides.
 */
function getAllowlist(): string[] {
  const env = readEnvFile(['AGENT_EGRESS_ALLOWLIST']);
  const envDomains = (
    process.env.AGENT_EGRESS_ALLOWLIST ||
    env.AGENT_EGRESS_ALLOWLIST ||
    ''
  )
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean);

  const manifestDomains = getManifest().allowedDomains;

  const list = [
    ...SYSTEM_ALWAYS_ALLOWED,
    ...(nexusHostname ? [nexusHostname] : []),
    ...manifestDomains,
    ...envDomains,
  ];

  return [...new Set(list)];
}

/**
 * Check whether an outbound URL is on the egress allowlist.
 * Reports a security incident to Nexus if blocked.
 *
 * Returns true if the call is permitted.
 */
export async function checkEgress(
  url: string,
  context?: string,
): Promise<boolean> {
  const { url: nexusUrl, agentId } = getNexusConfig();
  const token = getNexusToken();
  const allowlist = getAllowlist();

  // Wildcard — allow all (not recommended, but respects manifest override)
  if (allowlist.includes('*')) return true;

  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    logger.error({ url }, 'Egress: invalid URL blocked');
    return false;
  }

  const allowed = allowlist.some(
    (d) => hostname === d || hostname.endsWith(`.${d}`),
  );

  if (allowed) return true;

  // Block and report
  const description =
    `Egress blocked: attempted connection to "${hostname}"` +
    (context ? ` (context: ${context})` : '');

  logger.error({ agentId, hostname, context }, description);

  try {
    await fetch(`${nexusUrl}/api/security/incidents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'X-Agent-Token': token } : {}),
      },
      body: JSON.stringify({
        agentId,
        type: 'egress_blocked',
        severity: 'medium',
        description,
        source: os.hostname(),
        details: { hostname, url, context, allowlist },
      }),
    });
  } catch (err) {
    logger.error({ err }, 'Egress: failed to report blocked call to Nexus');
  }

  return false;
}

/**
 * Wrapped fetch that enforces the egress whitelist.
 * Use this instead of native fetch anywhere the orchestrator makes
 * external HTTP calls.
 */
export async function safeFetch(
  url: string,
  options?: RequestInit,
  context?: string,
): Promise<Response> {
  const allowed = await checkEgress(url, context);
  if (!allowed) {
    throw new Error(`Egress blocked: ${url} is not on the allowlist`);
  }
  return fetch(url, options);
}
