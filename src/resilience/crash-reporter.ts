/**
 * Crash Reporter — Quorbz Resilience Layer
 *
 * Catches unhandled exceptions and unhandled promise rejections, writes
 * a structured crash report to disk, and attempts to push it to Nexus
 * before the process exits.
 *
 * Crash reports include:
 *   - Error message + stack trace
 *   - Process uptime and memory usage at crash time
 *   - Agent ID and hostname
 *   - Last known task context (if available)
 *
 * Reports are written to ~/.config/nanoclaw/crashes/ as timestamped JSON.
 * Nexus push is best-effort — disk write is the reliable record.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { logger } from '../logger.js';
import { readEnvFile } from '../env.js';
import { getNexusToken } from '../security/nexus-gate.js';

const CRASH_REPORT_DIR = path.join(
  process.env.HOME || os.homedir(),
  '.config',
  'nanoclaw',
  'crashes',
);

// Maximum crash reports to keep on disk (oldest deleted when exceeded)
const MAX_CRASH_REPORTS = 50;

let lastTaskContext: string | null = null;

function getNexusConfig(): { url: string; agentId: string } {
  const env = readEnvFile(['NEXUS_URL', 'NEXUS_AGENT_ID']);
  return {
    url: process.env.NEXUS_URL || env.NEXUS_URL || 'http://localhost:4000',
    agentId: process.env.NEXUS_AGENT_ID || env.NEXUS_AGENT_ID || 'unknown',
  };
}

/**
 * Set the current task context string for crash reports.
 * Call before each significant operation so a crash report
 * includes what the agent was doing when it died.
 */
export function setCrashContext(context: string | null): void {
  lastTaskContext = context;
}

function buildCrashReport(err: unknown): Record<string, unknown> {
  const { agentId } = getNexusConfig();
  const isError = err instanceof Error;

  return {
    agentId,
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    nodeVersion: process.version,
    pid: process.pid,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    timestamp: new Date().toISOString(),
    lastTaskContext,
    error: {
      message: isError ? err.message : String(err),
      stack: isError ? err.stack : undefined,
      name: isError ? err.name : 'UnknownError',
    },
  };
}

function writeCrashToDisk(report: Record<string, unknown>): string | null {
  try {
    fs.mkdirSync(CRASH_REPORT_DIR, { recursive: true });

    // Purge oldest reports if we're at the limit
    const existing = fs
      .readdirSync(CRASH_REPORT_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();
    if (existing.length >= MAX_CRASH_REPORTS) {
      const toDelete = existing.slice(0, existing.length - MAX_CRASH_REPORTS + 1);
      for (const f of toDelete) {
        try {
          fs.unlinkSync(path.join(CRASH_REPORT_DIR, f));
        } catch {
          // Best-effort
        }
      }
    }

    const filename = `crash-${Date.now()}.json`;
    const filepath = path.join(CRASH_REPORT_DIR, filename);
    fs.writeFileSync(filepath, JSON.stringify(report, null, 2), 'utf-8');
    return filepath;
  } catch (writeErr) {
    // Can't use logger here — it may itself be broken
    process.stderr.write(`[crash-reporter] Failed to write crash report: ${writeErr}\n`);
    return null;
  }
}

async function pushCrashToNexus(report: Record<string, unknown>): Promise<void> {
  const { url, agentId } = getNexusConfig();
  const token = getNexusToken();

  try {
    await fetch(`${url}/api/security/incidents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'X-Agent-Token': token } : {}),
      },
      body: JSON.stringify({
        agentId,
        type: 'agent_crash',
        severity: 'critical',
        description: `Agent ${agentId} crashed: ${(report.error as any)?.message ?? 'unknown error'}`,
        source: os.hostname(),
        details: report,
      }),
    });
  } catch {
    // Best-effort — if Nexus is down we still have the disk report
  }
}

/**
 * Handle a crash: write disk report, push to Nexus, log to stderr.
 * Designed to be called from uncaughtException / unhandledRejection handlers.
 * Does NOT call process.exit() — let the caller decide.
 */
async function handleCrash(err: unknown, type: string): Promise<void> {
  const report = buildCrashReport(err);

  // Log before disk/network so something always makes it out
  process.stderr.write(
    `\n[nanoclaw] ${type}: ${(report.error as any)?.message ?? err}\n` +
      `  Stack: ${(report.error as any)?.stack ?? '(none)'}\n` +
      `  Context: ${lastTaskContext ?? '(none)'}\n`,
  );

  const filepath = writeCrashToDisk(report);
  if (filepath) {
    process.stderr.write(`[nanoclaw] Crash report written to: ${filepath}\n`);
  }

  // Push to Nexus with a short timeout — we're dying, don't hang
  await Promise.race([
    pushCrashToNexus(report),
    new Promise<void>((resolve) => setTimeout(resolve, 3000)),
  ]);
}

/**
 * Initialize the crash reporter.
 * Attaches handlers for uncaughtException and unhandledRejection.
 * Call once at process startup, before any async work.
 */
export function initCrashReporter(): void {
  process.on('uncaughtException', async (err) => {
    await handleCrash(err, 'uncaughtException');
    process.exit(1);
  });

  process.on('unhandledRejection', async (reason) => {
    await handleCrash(reason, 'unhandledRejection');
    process.exit(1);
  });

  logger.info({ crashDir: CRASH_REPORT_DIR }, 'Crash reporter initialized');
}

/**
 * Load any crash reports written since the given timestamp.
 * Useful for surfacing recent crashes in the Nexus dashboard.
 */
export function getRecentCrashReports(
  sinceMs = Date.now() - 24 * 60 * 60 * 1000,
): Array<Record<string, unknown>> {
  try {
    const files = fs
      .readdirSync(CRASH_REPORT_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();

    const reports: Array<Record<string, unknown>> = [];
    for (const file of files) {
      const match = file.match(/crash-(\d+)\.json$/);
      if (!match) continue;
      const ts = parseInt(match[1], 10);
      if (ts < sinceMs) continue;
      try {
        const raw = fs.readFileSync(path.join(CRASH_REPORT_DIR, file), 'utf-8');
        reports.push(JSON.parse(raw));
      } catch {
        // Corrupted — skip
      }
    }

    return reports;
  } catch {
    return [];
  }
}
