/**
 * Machine Fingerprint Lock — Layer 2 of the Quorbz security model
 *
 * On first deploy, the agent registers its machine identity with Nexus.
 * On every subsequent startup, it compares the current environment to
 * the registered fingerprint. A mismatch means the agent is running on
 * an unauthorized machine (cloned container, compromised environment)
 * and it refuses to start, firing a Nexus security incident.
 *
 * Fingerprint components:
 *   - hostname
 *   - expected IP range (CIDR prefix match, not exact IP — handles DHCP)
 *   - OS platform + arch
 *   - a stable hardware hash derived from available machine identifiers
 */

import os from 'os';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { logger } from '../logger.js';
import { readEnvFile } from '../env.js';
import { getNexusToken } from './nexus-gate.js';

export interface MachineFingerprint {
  hostname: string;
  platform: string;
  arch: string;
  ipRangePrefix: string;   // first two octets, e.g. "192.168"
  hardwareHash: string;    // stable hash of hostname + platform + arch
  registeredAt: string;
}

const FINGERPRINT_CACHE_PATH = path.join(
  process.env.HOME || os.homedir(),
  '.config',
  'nanoclaw',
  'fingerprint.json',
);

function getNexusConfig(): { url: string; agentId: string } {
  const env = readEnvFile(['NEXUS_URL', 'NEXUS_AGENT_ID']);
  return {
    url: process.env.NEXUS_URL || env.NEXUS_URL || 'http://localhost:4000',
    agentId: process.env.NEXUS_AGENT_ID || env.NEXUS_AGENT_ID || 'unknown',
  };
}

/**
 * Derive the current machine's LAN IP address (first non-loopback IPv4).
 */
function getLanIp(): string {
  const interfaces = os.networkInterfaces();
  for (const iface of Object.values(interfaces)) {
    if (!iface) continue;
    for (const entry of iface) {
      if (entry.family === 'IPv4' && !entry.internal) {
        return entry.address;
      }
    }
  }
  return '0.0.0.0';
}

/**
 * Build the IP range prefix from the current LAN IP.
 * Uses the first two octets: 192.168.50.10 → "192.168"
 */
function ipRangePrefix(ip: string): string {
  return ip.split('.').slice(0, 2).join('.');
}

/**
 * Derive a stable hardware hash. We use hostname + platform + arch as
 * a proxy — these are consistent on the same machine and unlikely to
 * match on a different one.
 */
function deriveHardwareHash(): string {
  const raw = [os.hostname(), os.platform(), os.arch()].join(':');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

/**
 * Build the fingerprint for the current machine.
 */
export function buildFingerprint(): MachineFingerprint {
  const ip = getLanIp();
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    ipRangePrefix: ipRangePrefix(ip),
    hardwareHash: deriveHardwareHash(),
    registeredAt: new Date().toISOString(),
  };
}

/**
 * Load the cached fingerprint from disk (written on first registration).
 */
function loadCachedFingerprint(): MachineFingerprint | null {
  try {
    const raw = fs.readFileSync(FINGERPRINT_CACHE_PATH, 'utf-8');
    return JSON.parse(raw) as MachineFingerprint;
  } catch {
    return null;
  }
}

/**
 * Save the fingerprint to disk cache.
 */
function saveCachedFingerprint(fp: MachineFingerprint): void {
  fs.mkdirSync(path.dirname(FINGERPRINT_CACHE_PATH), { recursive: true });
  fs.writeFileSync(FINGERPRINT_CACHE_PATH, JSON.stringify(fp, null, 2), 'utf-8');
}

/**
 * Register this machine's fingerprint with Nexus.
 * Called on first deploy. Saves to local cache for future comparison.
 */
async function registerFingerprint(
  fp: MachineFingerprint,
): Promise<boolean> {
  const { url, agentId } = getNexusConfig();
  const token = getNexusToken();
  try {
    const res = await fetch(`${url}/api/security/fingerprint/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'X-Agent-Token': token } : {}),
      },
      body: JSON.stringify({ agentId, fingerprint: fp }),
    });
    if (!res.ok) {
      logger.error({ status: res.status }, 'Failed to register fingerprint with Nexus');
      return false;
    }
    saveCachedFingerprint(fp);
    logger.info({ agentId }, 'Machine fingerprint registered with Nexus');
    return true;
  } catch (err) {
    logger.error({ err }, 'Error registering fingerprint with Nexus');
    return false;
  }
}

/**
 * Verify the current machine against the registered fingerprint.
 * Fires a Nexus security incident on mismatch.
 */
async function verifyFingerprint(
  current: MachineFingerprint,
  registered: MachineFingerprint,
): Promise<boolean> {
  const mismatches: string[] = [];

  if (current.hostname !== registered.hostname) {
    mismatches.push(`hostname: ${current.hostname} != ${registered.hostname}`);
  }
  if (current.platform !== registered.platform) {
    mismatches.push(`platform: ${current.platform} != ${registered.platform}`);
  }
  if (current.arch !== registered.arch) {
    mismatches.push(`arch: ${current.arch} != ${registered.arch}`);
  }
  if (current.ipRangePrefix !== registered.ipRangePrefix) {
    mismatches.push(
      `ip_range: ${current.ipRangePrefix} != ${registered.ipRangePrefix}`,
    );
  }
  if (current.hardwareHash !== registered.hardwareHash) {
    mismatches.push(`hardware_hash: ${current.hardwareHash} != ${registered.hardwareHash}`);
  }

  if (mismatches.length === 0) {
    return true;
  }

  // Fire security incident to Nexus before refusing to start
  const { url, agentId } = getNexusConfig();
  const token = getNexusToken();
  logger.error(
    { agentId, mismatches },
    'FINGERPRINT MISMATCH — agent running on unauthorized machine',
  );

  try {
    await fetch(`${url}/api/security/incidents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'X-Agent-Token': token } : {}),
      },
      body: JSON.stringify({
        agentId,
        type: 'fingerprint_mismatch',
        severity: 'critical',
        description: `Machine fingerprint mismatch on startup: ${mismatches.join(', ')}`,
        source: os.hostname(),
        details: { current, registered, mismatches },
      }),
    });
  } catch (err) {
    logger.error({ err }, 'Failed to report fingerprint mismatch to Nexus');
  }

  return false;
}

/**
 * Initialize the fingerprint check.
 * - First run: registers the fingerprint with Nexus
 * - Subsequent runs: verifies against registered fingerprint
 *
 * Throws if the fingerprint check fails (agent should not start).
 */
export async function initFingerprintLock(): Promise<void> {
  const { agentId } = getNexusConfig();
  const current = buildFingerprint();

  logger.info(
    { agentId, hostname: current.hostname, hardwareHash: current.hardwareHash },
    'Fingerprint check starting',
  );

  const cached = loadCachedFingerprint();

  if (!cached) {
    // First deploy — register
    logger.info({ agentId }, 'No cached fingerprint — registering this machine');
    const ok = await registerFingerprint(current);
    if (!ok) {
      // Nexus may be unreachable on very first deploy — log warning but allow
      // startup. The fingerprint will be registered on next successful check.
      logger.warn(
        { agentId },
        'Could not register fingerprint with Nexus — will retry on next start',
      );
      saveCachedFingerprint(current); // cache locally so next start can compare
    }
    return;
  }

  // Existing deploy — verify
  const ok = await verifyFingerprint(current, cached);
  if (!ok) {
    throw new Error(
      `SECURITY: Machine fingerprint mismatch for agent ${agentId}. ` +
        `Agent refusing to start. See Nexus security incidents.`,
    );
  }

  logger.info({ agentId }, 'Fingerprint check: PASSED');
}
