/**
 * Role Boundary Enforcement — Layer 3 of the Quorbz security model
 *
 * Each agent has a capability manifest defining the tools it may invoke
 * and the external domains it may contact. Any attempt to operate outside
 * this manifest is blocked, logged, and escalated as a Nexus security
 * incident.
 *
 * This is the primary defense against prompt injection attacks: even if
 * a malicious input convinces an agent to attempt an out-of-scope action,
 * the role boundary layer blocks execution before any harm is done.
 *
 * Manifest is loaded from AGENT_ROLE_MANIFEST env var (JSON path) or
 * falls back to a default restrictive policy.
 */

import fs from 'fs';
import os from 'os';
import { logger } from '../logger.js';
import { readEnvFile } from '../env.js';
import { getNexusToken } from './nexus-gate.js';

export interface RoleManifest {
  agentId: string;
  allowedTools: string[];        // e.g. ['read_file', 'write_file', 'bash']
  allowedDomains: string[];      // e.g. ['api.x.ai', 'openai.etsy.com']
  allowedAgentContacts: string[]; // agent IDs this agent can message
  maxConcurrentTasks: number;
  allowPremiumModel: boolean;    // whether AI_ENABLE_PREMIUM is permitted
}

// Default policy: minimal permissions, no external domains, no premium
const DEFAULT_MANIFEST: RoleManifest = {
  agentId: 'unknown',
  allowedTools: ['read_file', 'write_file', 'bash'],
  allowedDomains: [],
  allowedAgentContacts: [],
  maxConcurrentTasks: 1,
  allowPremiumModel: false,
};

let loadedManifest: RoleManifest | null = null;

function getNexusConfig(): { url: string; agentId: string } {
  const env = readEnvFile(['NEXUS_URL', 'NEXUS_AGENT_ID']);
  return {
    url: process.env.NEXUS_URL || env.NEXUS_URL || 'http://localhost:4000',
    agentId: process.env.NEXUS_AGENT_ID || env.NEXUS_AGENT_ID || 'unknown',
  };
}

/**
 * Load the role manifest from the path specified in AGENT_ROLE_MANIFEST,
 * or fetch it from Nexus, falling back to the default restrictive policy.
 */
export async function loadRoleManifest(): Promise<RoleManifest> {
  const { url, agentId } = getNexusConfig();
  const env = readEnvFile(['AGENT_ROLE_MANIFEST']);
  const manifestPath = process.env.AGENT_ROLE_MANIFEST || env.AGENT_ROLE_MANIFEST;

  // Try loading from local file first
  if (manifestPath) {
    try {
      const raw = fs.readFileSync(manifestPath, 'utf-8');
      const manifest: RoleManifest = { ...DEFAULT_MANIFEST, ...JSON.parse(raw) as Partial<RoleManifest>, agentId };
      loadedManifest = manifest;
      logger.info({ agentId, manifestPath }, 'Role manifest loaded from file');
      return manifest;
    } catch (err) {
      logger.warn({ err, manifestPath }, 'Failed to load role manifest from file');
    }
  }

  // Try fetching from Nexus
  const token = getNexusToken();
  try {
    const res = await fetch(`${url}/api/agents/${agentId}/manifest`, {
      headers: token ? { 'X-Agent-Token': token } : {},
    });
    if (res.ok) {
      const data = await res.json() as RoleManifest;
      loadedManifest = { ...DEFAULT_MANIFEST, ...data };
      logger.info({ agentId }, 'Role manifest fetched from Nexus');
      return loadedManifest;
    }
  } catch {
    // Fall through to default
  }

  logger.warn(
    { agentId },
    'Could not load role manifest — applying default restrictive policy',
  );
  loadedManifest = { ...DEFAULT_MANIFEST, agentId };
  return loadedManifest;
}

export function getManifest(): RoleManifest {
  return loadedManifest ?? DEFAULT_MANIFEST;
}

/**
 * Report a boundary violation to Nexus and log it.
 */
async function reportViolation(
  violationType: 'tool' | 'domain' | 'agent_contact' | 'premium_model',
  attempted: string,
  context?: string,
): Promise<void> {
  const { url, agentId } = getNexusConfig();
  const token = getNexusToken();
  const description =
    `Role boundary violation: attempted ${violationType} "${attempted}"` +
    (context ? ` (context: ${context})` : '');

  logger.error({ agentId, violationType, attempted }, description);

  try {
    await fetch(`${url}/api/security/incidents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'X-Agent-Token': token } : {}),
      },
      body: JSON.stringify({
        agentId,
        type: 'role_boundary_violation',
        severity: 'high',
        description,
        source: os.hostname(),
        details: { violationType, attempted, context },
      }),
    });
  } catch (err) {
    logger.error({ err }, 'Failed to report boundary violation to Nexus');
  }
}

/**
 * Validate that a tool call is within this agent's permitted capability set.
 * Returns true if allowed, false if blocked (and fires a security incident).
 */
export async function checkToolAllowed(
  toolName: string,
  context?: string,
): Promise<boolean> {
  const manifest = getManifest();
  if (manifest.allowedTools.includes('*')) return true;
  if (manifest.allowedTools.includes(toolName)) return true;

  await reportViolation('tool', toolName, context);
  return false;
}

/**
 * Validate that an outbound HTTP call is to an allowed domain.
 * Call this before any external fetch/HTTP call.
 */
export async function checkDomainAllowed(
  url: string,
  context?: string,
): Promise<boolean> {
  const manifest = getManifest();
  if (manifest.allowedDomains.includes('*')) return true;

  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    await reportViolation('domain', url, 'invalid_url');
    return false;
  }

  const allowed = manifest.allowedDomains.some(
    (d) => hostname === d || hostname.endsWith(`.${d}`),
  );

  if (!allowed) {
    await reportViolation('domain', hostname, context);
    return false;
  }

  return true;
}

/**
 * Validate that an inter-agent contact is permitted.
 */
export async function checkAgentContactAllowed(
  targetAgentId: string,
  context?: string,
): Promise<boolean> {
  const manifest = getManifest();
  if (manifest.allowedAgentContacts.includes('*')) return true;
  if (manifest.allowedAgentContacts.includes(targetAgentId)) return true;

  await reportViolation('agent_contact', targetAgentId, context);
  return false;
}

/**
 * Validate that premium model usage is permitted for this agent.
 */
export async function checkPremiumModelAllowed(): Promise<boolean> {
  const manifest = getManifest();
  if (manifest.allowPremiumModel) return true;

  await reportViolation(
    'premium_model',
    'AI_ENABLE_PREMIUM',
    'premium model requires explicit manifest permission',
  );
  return false;
}
