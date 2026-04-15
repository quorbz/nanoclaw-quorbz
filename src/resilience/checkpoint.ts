/**
 * Task Checkpointing — Quorbz Resilience Layer
 *
 * Writes task state to PostgreSQL (via Nexus) before each significant step
 * so that on crash or restart we can resume rather than restart from zero.
 *
 * Checkpoint lifecycle:
 *   start    → task accepted, about to process
 *   running  → container launched, actively working
 *   done     → completed successfully
 *   failed   → errored out (retryable)
 *   dead     → exceeded max retries, needs human review
 *
 * On startup, any task in 'start' or 'running' state is considered
 * interrupted and gets re-queued automatically.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { logger } from '../logger.js';
import { readEnvFile } from '../env.js';
import { getNexusToken } from '../security/nexus-gate.js';

export type CheckpointStatus = 'start' | 'running' | 'done' | 'failed' | 'dead';

export interface TaskCheckpoint {
  taskId: string;
  agentId: string;
  groupFolder: string;
  status: CheckpointStatus;
  prompt: string;
  sessionId?: string;
  attempt: number;
  maxAttempts: number;
  startedAt: string;
  updatedAt: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

// Local disk cache for when Nexus is unreachable
const CHECKPOINT_CACHE_DIR = path.join(
  process.env.HOME || os.homedir(),
  '.config',
  'nanoclaw',
  'checkpoints',
);

const MAX_ATTEMPTS_DEFAULT = 3;

function getNexusConfig(): { url: string; agentId: string } {
  const env = readEnvFile(['NEXUS_URL', 'NEXUS_AGENT_ID']);
  return {
    url: process.env.NEXUS_URL || env.NEXUS_URL || 'http://localhost:4000',
    agentId: process.env.NEXUS_AGENT_ID || env.NEXUS_AGENT_ID || 'unknown',
  };
}

function checkpointCachePath(taskId: string): string {
  return path.join(CHECKPOINT_CACHE_DIR, `${taskId}.json`);
}

function saveCheckpointToDisk(cp: TaskCheckpoint): void {
  try {
    fs.mkdirSync(CHECKPOINT_CACHE_DIR, { recursive: true });
    fs.writeFileSync(
      checkpointCachePath(cp.taskId),
      JSON.stringify(cp, null, 2),
      'utf-8',
    );
  } catch (err) {
    logger.error({ err, taskId: cp.taskId }, 'Checkpoint: failed to write disk cache');
  }
}

function deleteCheckpointFromDisk(taskId: string): void {
  try {
    fs.unlinkSync(checkpointCachePath(taskId));
  } catch {
    // Already gone — fine
  }
}

/**
 * Write a checkpoint to Nexus and local disk cache.
 * Local disk write happens first so we never lose state even if Nexus is down.
 */
export async function writeCheckpoint(
  checkpoint: Omit<TaskCheckpoint, 'updatedAt'>,
): Promise<void> {
  const cp: TaskCheckpoint = {
    ...checkpoint,
    updatedAt: new Date().toISOString(),
  };

  // Always save to disk first — fast, local, survives network outage
  saveCheckpointToDisk(cp);

  const { url } = getNexusConfig();
  const token = getNexusToken();

  try {
    await fetch(`${url}/api/tasks/checkpoint`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'X-Agent-Token': token } : {}),
      },
      body: JSON.stringify(cp),
    });

    // Nexus acknowledged — disk cache no longer needed for this checkpoint
    // (keep it on terminal states for audit trail)
    if (cp.status === 'done') {
      deleteCheckpointFromDisk(cp.taskId);
    }

    logger.debug(
      { taskId: cp.taskId, status: cp.status },
      'Checkpoint written to Nexus',
    );
  } catch {
    logger.warn(
      { taskId: cp.taskId, status: cp.status },
      'Checkpoint: Nexus unreachable, disk cache retained for recovery',
    );
  }
}

/**
 * Mark a task as started (checkpoint: 'start').
 * Call immediately when a task is accepted before any processing.
 */
export async function checkpointStart(
  taskId: string,
  prompt: string,
  groupFolder: string,
  sessionId?: string,
): Promise<void> {
  const { agentId } = getNexusConfig();
  await writeCheckpoint({
    taskId,
    agentId,
    groupFolder,
    status: 'start',
    prompt,
    sessionId,
    attempt: 1,
    maxAttempts: MAX_ATTEMPTS_DEFAULT,
    startedAt: new Date().toISOString(),
  });
}

/**
 * Mark a task as actively running (container launched).
 */
export async function checkpointRunning(
  taskId: string,
  prompt: string,
  groupFolder: string,
  sessionId?: string,
  attempt = 1,
): Promise<void> {
  const { agentId } = getNexusConfig();
  await writeCheckpoint({
    taskId,
    agentId,
    groupFolder,
    status: 'running',
    prompt,
    sessionId,
    attempt,
    maxAttempts: MAX_ATTEMPTS_DEFAULT,
    startedAt: new Date().toISOString(),
  });
}

/**
 * Mark a task as successfully completed.
 */
export async function checkpointDone(
  taskId: string,
  prompt: string,
  groupFolder: string,
  sessionId?: string,
  attempt = 1,
): Promise<void> {
  const { agentId } = getNexusConfig();
  await writeCheckpoint({
    taskId,
    agentId,
    groupFolder,
    status: 'done',
    prompt,
    sessionId,
    attempt,
    maxAttempts: MAX_ATTEMPTS_DEFAULT,
    startedAt: new Date().toISOString(),
  });
}

/**
 * Mark a task as failed (retryable). Increments attempt counter.
 */
export async function checkpointFailed(
  taskId: string,
  prompt: string,
  groupFolder: string,
  error: string,
  attempt = 1,
  sessionId?: string,
): Promise<void> {
  const { agentId } = getNexusConfig();
  const isDead = attempt >= MAX_ATTEMPTS_DEFAULT;

  await writeCheckpoint({
    taskId,
    agentId,
    groupFolder,
    status: isDead ? 'dead' : 'failed',
    prompt,
    sessionId,
    attempt,
    maxAttempts: MAX_ATTEMPTS_DEFAULT,
    startedAt: new Date().toISOString(),
    error,
  });

  if (isDead) {
    logger.error(
      { taskId, attempt, maxAttempts: MAX_ATTEMPTS_DEFAULT, error },
      'Checkpoint: task exceeded max attempts — marked dead',
    );
  }
}

/**
 * Load all interrupted checkpoints from local disk cache.
 * Call on startup to find tasks that need to be re-queued.
 */
export function loadInterruptedCheckpoints(): TaskCheckpoint[] {
  try {
    fs.mkdirSync(CHECKPOINT_CACHE_DIR, { recursive: true });
    const files = fs.readdirSync(CHECKPOINT_CACHE_DIR).filter((f) => f.endsWith('.json'));
    const checkpoints: TaskCheckpoint[] = [];

    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(CHECKPOINT_CACHE_DIR, file), 'utf-8');
        const cp = JSON.parse(raw) as TaskCheckpoint;
        // Only recover tasks that were interrupted mid-flight
        if (cp.status === 'start' || cp.status === 'running') {
          checkpoints.push(cp);
        }
      } catch {
        // Corrupted checkpoint file — ignore
      }
    }

    if (checkpoints.length > 0) {
      logger.info(
        { count: checkpoints.length },
        'Checkpoint: found interrupted tasks for recovery',
      );
    }

    return checkpoints;
  } catch (err) {
    logger.warn({ err }, 'Checkpoint: could not read cache dir');
    return [];
  }
}
