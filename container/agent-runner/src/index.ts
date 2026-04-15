/**
 * NanoClaw-Quorbz Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout.
 * Uses xAI (Grok) via the OpenAI-compatible API — no Anthropic dependencies.
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted. Final marker after loop ends signals completion.
 *
 * Credentials: XAI_API_KEY injected by OneCLI at runtime — never hardcoded.
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { glob } from 'glob';
import OpenAI from 'openai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const XAI_BASE_URL = 'https://api.x.ai/v1';
const DEFAULT_MODEL = 'grok-4-1-fast-reasoning';
const MODEL = process.env.XAI_MODEL ?? DEFAULT_MODEL;
const MAX_TOKENS = parseInt(process.env.XAI_MAX_TOKENS ?? '8192', 10);
const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;
const SCRIPT_TIMEOUT_MS = 30_000;
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface ScriptResult {
  wakeAgent: boolean;
  data?: unknown;
}

type Message = OpenAI.Chat.ChatCompletionMessageParam;

// ---------------------------------------------------------------------------
// Logging and output helpers
// ---------------------------------------------------------------------------

function log(msg: string): void {
  console.error(`[nanoclaw-quorbz] ${msg}`);
}

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// IPC helpers
// ---------------------------------------------------------------------------

function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();
    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) messages.push(data.text);
      } catch { try { fs.unlinkSync(filePath); } catch { /* ignore */ } }
    }
    return messages;
  } catch {
    return [];
  }
}

function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) { resolve(null); return; }
      const msgs = drainIpcInput();
      if (msgs.length > 0) { resolve(msgs.join('\n')); return; }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

// ---------------------------------------------------------------------------
// Built-in tool implementations
// ---------------------------------------------------------------------------

async function toolBash(command: string, timeout?: number): Promise<string> {
  return new Promise((resolve) => {
    execFile('bash', ['-c', command], {
      timeout: timeout ?? 60_000,
      maxBuffer: 10 * 1024 * 1024,
      env: process.env,
    }, (err, stdout, stderr) => {
      const out = [stdout, stderr].filter(Boolean).join('\n').trim();
      if (err && !out) resolve(`Error (exit ${(err as NodeJS.ErrnoException & { code?: number }).code ?? 1}): ${err.message}`);
      else resolve(out || '(no output)');
    });
  });
}

async function toolReadFile(filePath: string, offset?: number, limit?: number): Promise<string> {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const start = Math.max(0, (offset ?? 1) - 1);
    const end = limit ? start + limit : lines.length;
    return lines.slice(start, end).map((l, i) => `${start + i + 1}\t${l}`).join('\n');
  } catch (err) {
    return `Error reading file: ${(err as Error).message}`;
  }
}

async function toolWriteFile(filePath: string, content: string): Promise<string> {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    return `Written: ${filePath}`;
  } catch (err) {
    return `Error writing file: ${(err as Error).message}`;
  }
}

async function toolEditFile(filePath: string, oldStr: string, newStr: string, replaceAll?: boolean): Promise<string> {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    if (!content.includes(oldStr)) return `Error: old_string not found in ${filePath}`;
    const updated = replaceAll ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr);
    fs.writeFileSync(filePath, updated, 'utf-8');
    return `Edited: ${filePath}`;
  } catch (err) {
    return `Error editing file: ${(err as Error).message}`;
  }
}

async function toolGlob(pattern: string, cwd?: string): Promise<string> {
  try {
    const matches = await glob(pattern, { cwd: cwd ?? process.cwd(), dot: true });
    return matches.length === 0 ? '(no matches)' : matches.sort().join('\n');
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
}

async function toolGrep(
  pattern: string,
  searchPath?: string,
  globPattern?: string,
  outputMode?: string,
  contextLines?: number,
): Promise<string> {
  const args = ['-r', '--color=never'];
  if (outputMode === 'files_with_matches') args.push('-l');
  else if (outputMode === 'count') args.push('-c');
  else { args.push('-n'); if (contextLines) args.push(`-C${contextLines}`); }
  if (globPattern) args.push(`--include=${globPattern}`);
  args.push(pattern, searchPath ?? '.');
  return new Promise((resolve) => {
    execFile('grep', args, { maxBuffer: 5 * 1024 * 1024, cwd: process.cwd() }, (err, stdout) => {
      if (err && (err as NodeJS.ErrnoException & { code?: number }).code === 2) resolve(`Error: ${err.message}`);
      else resolve(stdout.trim() || '(no matches)');
    });
  });
}

async function toolWebFetch(url: string): Promise<string> {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'NanoClaw-Quorbz/1.0' },
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    return text.length > 50000 ? text.slice(0, 50000) + '\n...[truncated]' : text;
  } catch (err) {
    return `Error fetching URL: ${(err as Error).message}`;
  }
}

// ---------------------------------------------------------------------------
// Built-in tool definitions (OpenAI function-calling format)
// ---------------------------------------------------------------------------

const BUILTIN_TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'Bash',
      description: 'Execute a bash command in the container sandbox and return output. Use for system commands, scripts, git, npm, sqlite3, file operations, etc.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The bash command to execute' },
          timeout: { type: 'number', description: 'Timeout in milliseconds (default: 60000)' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Read',
      description: 'Read a file from the filesystem with line numbers.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the file' },
          offset: { type: 'number', description: 'Line number to start from (1-indexed)' },
          limit: { type: 'number', description: 'Number of lines to read' },
        },
        required: ['file_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Write',
      description: 'Write content to a file. Creates parent directories if needed.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the file' },
          content: { type: 'string', description: 'Content to write' },
        },
        required: ['file_path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Edit',
      description: 'Edit a file by replacing a specific string with another.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the file' },
          old_string: { type: 'string', description: 'Exact string to find and replace' },
          new_string: { type: 'string', description: 'String to replace it with' },
          replace_all: { type: 'boolean', description: 'Replace all occurrences (default: false)' },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Glob',
      description: 'Find files matching a glob pattern.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern (e.g. "**/*.ts")' },
          path: { type: 'string', description: 'Directory to search in (default: cwd)' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Grep',
      description: 'Search file contents using grep.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern to search for' },
          path: { type: 'string', description: 'File or directory to search' },
          glob: { type: 'string', description: 'File glob filter (e.g. "*.ts")' },
          output_mode: {
            type: 'string',
            enum: ['content', 'files_with_matches', 'count'],
            description: 'Output mode (default: content)',
          },
          context: { type: 'number', description: 'Lines of context around matches' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'WebFetch',
      description: 'Fetch content from a URL (HTML, JSON, text). Returns up to 50k characters.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to fetch' },
        },
        required: ['url'],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// MCP client — NanoClaw IPC tools (send_message, schedule_task, etc.)
// ---------------------------------------------------------------------------

async function createMcpClient(mcpServerPath: string, containerInput: ContainerInput): Promise<Client | null> {
  try {
    const transport = new StdioClientTransport({
      command: 'node',
      args: [mcpServerPath],
      env: {
        ...process.env,
        NANOCLAW_CHAT_JID: containerInput.chatJid,
        NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
        NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
      } as Record<string, string>,
    });
    const client = new Client({ name: 'nanoclaw-quorbz', version: '1.0.0' });
    await client.connect(transport);
    log('MCP client connected');
    return client;
  } catch (err) {
    log(`MCP client failed: ${(err as Error).message}`);
    return null;
  }
}

async function getMcpTools(client: Client): Promise<OpenAI.Chat.ChatCompletionTool[]> {
  try {
    const result = await client.listTools();
    return result.tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: `mcp__nanoclaw__${t.name}`,
        description: (t as { description?: string }).description ?? `MCP tool: ${t.name}`,
        parameters: ((t as { inputSchema?: Record<string, unknown> }).inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
      },
    }));
  } catch (err) {
    log(`Failed to list MCP tools: ${(err as Error).message}`);
    return [];
  }
}

async function callMcpTool(client: Client, toolName: string, args: Record<string, unknown>): Promise<string> {
  try {
    const result = await client.callTool({ name: toolName, arguments: args });
    const content = result.content;
    if (Array.isArray(content)) {
      return content.map((c: { type?: string; text?: string }) => c.type === 'text' ? c.text : JSON.stringify(c)).join('\n');
    }
    return JSON.stringify(result);
  } catch (err) {
    return `MCP tool error: ${(err as Error).message}`;
  }
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

async function dispatchTool(
  toolName: string,
  args: Record<string, unknown>,
  mcpClient: Client | null,
): Promise<string> {
  switch (toolName) {
    case 'Bash':      return toolBash(args.command as string, args.timeout as number | undefined);
    case 'Read':      return toolReadFile(args.file_path as string, args.offset as number | undefined, args.limit as number | undefined);
    case 'Write':     return toolWriteFile(args.file_path as string, args.content as string);
    case 'Edit':      return toolEditFile(args.file_path as string, args.old_string as string, args.new_string as string, args.replace_all as boolean | undefined);
    case 'Glob':      return toolGlob(args.pattern as string, args.path as string | undefined);
    case 'Grep':      return toolGrep(args.pattern as string, args.path as string | undefined, args.glob as string | undefined, args.output_mode as string | undefined, args.context as number | undefined);
    case 'WebFetch':  return toolWebFetch(args.url as string);
    default:
      if (toolName.startsWith('mcp__nanoclaw__') && mcpClient) {
        return callMcpTool(mcpClient, toolName.replace('mcp__nanoclaw__', ''), args);
      }
      return `Unknown tool: ${toolName}`;
  }
}

// ---------------------------------------------------------------------------
// Agent loop — calls xAI, executes tools, iterates until done
// ---------------------------------------------------------------------------

async function runAgentLoop(
  prompt: string,
  systemPrompt: string,
  xaiClient: OpenAI,
  tools: OpenAI.Chat.ChatCompletionTool[],
  mcpClient: Client | null,
): Promise<string> {
  const messages: Message[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: prompt },
  ];

  const MAX_ITER = 50;

  for (let iter = 0; iter < MAX_ITER; iter++) {
    log(`Agent loop iteration ${iter + 1}`);

    let response: OpenAI.Chat.ChatCompletion;
    try {
      response = await xaiClient.chat.completions.create({
        model: MODEL,
        messages,
        tools: tools.length > 0 ? tools : undefined,
        tool_choice: tools.length > 0 ? 'auto' : undefined,
        max_tokens: MAX_TOKENS,
      });
    } catch (err) {
      const msg = `xAI API error: ${(err as Error).message}`;
      log(msg);
      return msg;
    }

    const choice = response.choices[0];
    if (!choice) return 'No response from model';

    const assistantMsg = choice.message;
    messages.push(assistantMsg as Message);

    // No tool calls — final answer
    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      return assistantMsg.content ?? '';
    }

    // Execute tool calls sequentially
    for (const toolCall of assistantMsg.tool_calls) {
      const toolName = toolCall.function.name;
      let toolArgs: Record<string, unknown> = {};
      try { toolArgs = JSON.parse(toolCall.function.arguments) as Record<string, unknown>; } catch { /* empty */ }

      log(`Tool: ${toolName}`);
      const result = await dispatchTool(toolName, toolArgs, mcpClient);
      log(`Tool ${toolName}: ${result.length} chars`);

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: result,
      } as Message);
    }

    if (shouldClose()) {
      log('Close sentinel during agent loop');
      return assistantMsg.content ?? '(interrupted)';
    }
  }

  return `(agent loop reached max iterations: ${MAX_ITER})`;
}

// ---------------------------------------------------------------------------
// Script execution (scheduled task pre-check)
// ---------------------------------------------------------------------------

async function runScript(script: string): Promise<ScriptResult | null> {
  const scriptPath = '/tmp/task-script.sh';
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });
  return new Promise((resolve) => {
    execFile('bash', [scriptPath], {
      timeout: SCRIPT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env: process.env,
    }, (error, stdout, stderr) => {
      if (stderr) log(`Script stderr: ${stderr.slice(0, 500)}`);
      if (error) { log(`Script error: ${error.message}`); return resolve(null); }
      const lines = stdout.trim().split('\n');
      const lastLine = lines[lines.length - 1];
      if (!lastLine) { log('Script: no output'); return resolve(null); }
      try {
        const result = JSON.parse(lastLine);
        if (typeof result.wakeAgent !== 'boolean') { log('Script: missing wakeAgent'); return resolve(null); }
        resolve(result as ScriptResult);
      } catch { log(`Script: invalid JSON output`); resolve(null); }
    });
  });
}

// ---------------------------------------------------------------------------
// System prompt construction — reads CLAUDE.md files from workspace
// ---------------------------------------------------------------------------

function buildSystemPrompt(containerInput: ContainerInput): string {
  const lines: string[] = [];

  // Agent identity and memory — from group CLAUDE.md
  const groupClaudeMd = '/workspace/group/CLAUDE.md';
  if (fs.existsSync(groupClaudeMd)) {
    lines.push(fs.readFileSync(groupClaudeMd, 'utf-8'));
    lines.push('');
  }

  // Shared Quorbz context — from global CLAUDE.md (skip for main channel)
  if (!containerInput.isMain) {
    const globalClaudeMd = '/workspace/global/CLAUDE.md';
    if (fs.existsSync(globalClaudeMd)) {
      lines.push('--- Quorbz Global Context ---');
      lines.push(fs.readFileSync(globalClaudeMd, 'utf-8'));
      lines.push('');
    }
  }

  lines.push(`Model: ${MODEL}`);
  lines.push(`Working directory: /workspace/group`);
  lines.push(`Group folder: ${containerInput.groupFolder}`);
  if (containerInput.assistantName) lines.push(`Name: ${containerInput.assistantName}`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Startup health check — verifies memory files exist before processing
// ---------------------------------------------------------------------------

function runHealthCheck(groupFolder: string): string[] {
  const warnings: string[] = [];
  const memoryFiles = ['CLAUDE.md', 'LEARNINGS.md', 'ERRORS.md', 'CURRENT_TASK.md', 'session-summary.md', 'self-reflection-loop.md'];
  for (const file of memoryFiles) {
    const filePath = path.join('/workspace/group', file);
    if (!fs.existsSync(filePath)) {
      warnings.push(`Missing memory file: ${file}`);
    }
  }
  if (warnings.length > 0) {
    log(`Health check warnings for ${groupFolder}: ${warnings.join(', ')}`);
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData) as ContainerInput;
    log(`Input received for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({ status: 'error', result: null, error: `Failed to parse input: ${(err as Error).message}` });
    process.exit(1);
  }

  // Validate API key
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    writeOutput({ status: 'error', result: null, error: 'XAI_API_KEY not set — check OneCLI vault configuration' });
    process.exit(1);
  }

  // Startup health check
  const healthWarnings = runHealthCheck(containerInput.groupFolder);
  if (healthWarnings.length > 0) {
    log(`HEALTH WARNING: ${healthWarnings.join('; ')}`);
    // Continue running — health warnings are non-fatal, but will be reported via agent response
  }

  const xaiClient = new OpenAI({ apiKey, baseURL: XAI_BASE_URL });

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  const mcpClient = await createMcpClient(mcpServerPath, containerInput);
  const mcpTools = mcpClient ? await getMcpTools(mcpClient) : [];
  const allTools = [...BUILTIN_TOOLS, ...mcpTools];
  log(`Tools: ${allTools.map((t) => t.function.name).join(', ')}`);

  // Build initial prompt
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK — automated, not from a user]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) prompt += '\n' + pending.join('\n');

  // Script phase (scheduled tasks only)
  if (containerInput.script && containerInput.isScheduledTask) {
    log('Running task script...');
    const scriptResult = await runScript(containerInput.script);
    if (!scriptResult || !scriptResult.wakeAgent) {
      log(`Script skip: ${scriptResult ? 'wakeAgent=false' : 'error'}`);
      writeOutput({ status: 'success', result: null });
      return;
    }
    prompt = `[SCHEDULED TASK]\n\nScript output:\n${JSON.stringify(scriptResult.data, null, 2)}\n\nInstructions:\n${containerInput.prompt}`;
  }

  // Health warning injection — if files are missing, tell the agent to report it
  if (healthWarnings.length > 0) {
    prompt = `[SYSTEM HEALTH WARNING — report to Benjamin via Telegram before doing anything else]\nMissing memory files: ${healthWarnings.join(', ')}\n\n${prompt}`;
  }

  const systemPrompt = buildSystemPrompt(containerInput);
  const sessionId = `xai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Main query-and-wait loop
  let currentPrompt = prompt;
  try {
    while (true) {
      log(`Running agent loop (session: ${sessionId})...`);
      const result = await runAgentLoop(currentPrompt, systemPrompt, xaiClient, allTools, mcpClient);
      log(`Loop complete: ${result.length} chars`);

      writeOutput({ status: 'success', result, newSessionId: sessionId });
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Waiting for next IPC message...');
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel — exiting');
        break;
      }

      log(`Follow-up message received (${nextMessage.length} chars)`);
      currentPrompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = (err as Error).message;
    log(`Agent error: ${errorMessage}`);
    writeOutput({ status: 'error', result: null, newSessionId: sessionId, error: errorMessage });
    process.exit(1);
  } finally {
    if (mcpClient) { try { await mcpClient.close(); } catch { /* ignore */ } }
  }
}

main();
