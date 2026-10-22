// Codex CLI backend: runs `codex exec` once per request and returns its final message.
// The chat messages are flattened into one prompt, passed on stdin (no Windows command-line length
// limit). Codex runs read-only in an empty working directory and is told not to run commands: all
// material it needs is already in the prompt.
// Speed: the user's Codex config (MCP servers, plugins) and rule files are skipped unless
// CODEX_USE_USER_CONFIG=true (~6 s per call), and the answer is taken from the --json event stream as
// soon as the turn completes, without waiting several seconds for the process to shut down.
import { spawn } from 'node:child_process';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const DEFAULT_CODEX_PATH = 'C:\\Users\\Administrator\\AppData\\Local\\OpenAI\\Codex\\bin\\6257d9e8f63c0f2b\\codex.exe';

export function messagesToPrompt(messages) {
  const system = messages.filter(m => m.role === 'system').map(m => m.content);
  const turns = messages.filter(m => m.role !== 'system');
  const last = turns.at(-1);
  const earlier = turns.slice(0, -1).map(m => `${m.role === 'assistant' ? '助手' : '用户'}：${m.content}`);
  return [
    '你是飞书机器人的回答引擎。下面已经提供了回答所需的全部资料：不要执行任何命令，不要读取或修改文件，不要联网，直接输出给用户看的最终回答（不要输出思考过程或额外说明）。',
    system.length ? `【要求与资料】\n${system.join('\n\n')}` : '',
    earlier.length ? `【之前的对话】\n${earlier.join('\n')}` : '',
    last ? `【当前消息】\n${last.content}` : '',
  ].filter(Boolean).join('\n\n');
}

export function codexArgs(config, outFile) {
  const args = ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never', '--ephemeral', '--json',
    '-C', config.codexWorkDir, '-o', outFile];
  if (!config.codexUseUserConfig) args.push('--ignore-user-config', '--ignore-rules');
  if (config.codexModel) args.push('-m', config.codexModel);
  if (config.codexReasoning) args.push('-c', `model_reasoning_effort="${config.codexReasoning}"`);
  args.push('-');
  return args;
}

// At most `limit` Codex processes at once; others wait their turn.
function createLimiter(limit) {
  let active = 0;
  const waiting = [];
  return async task => {
    if (active >= limit) await new Promise(resolve => waiting.push(resolve));
    active++;
    try { return await task(); }
    finally { active--; waiting.shift()?.(); }
  };
}
const limiters = new Map();

// Runs one Codex turn. Resolves with the last agent message as soon as `turn.completed` arrives.
function runTurn(config, prompt, outFile, spawnImpl) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawnImpl(config.codexPath, codexArgs(config, outFile), { cwd: config.codexWorkDir, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch { reject(new Error(`无法启动 Codex，请检查 CODEX_PATH（${config.codexPath}）。`)); return; }
    let answer = '';
    let failure = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('Codex 回答超时，请稍后重试或调大 AI_TIMEOUT_SECONDS。')), config.timeout);
    let buffer = '';
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on('data', chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text) answer = event.item.text;
        else if (event.type === 'error' || event.type === 'turn.failed') failure = event.message || event.error?.message || failure;
        else if (event.type === 'turn.completed' && answer) finish(null, answer);
      }
    });
    child.on('error', () => finish(new Error(`无法启动 Codex，请检查 CODEX_PATH（${config.codexPath}）。`)));
    child.on('close', async code => {
      if (settled) return;
      // No streamed answer: fall back to the -o file (older CLI versions), else report the failure.
      let fromFile = '';
      try { fromFile = (await readFile(outFile, 'utf8')).trim(); } catch { /* not written */ }
      if (fromFile) finish(null, fromFile);
      else finish(new Error(`Codex 没有返回回答（退出码 ${code}${failure ? `：${String(failure).slice(0, 200)}` : ''}），请在终端运行 codex 检查登录状态和额度。`));
    });
    child.stdin.on('error', () => {}); // the process may exit before reading everything
    child.stdin.end(prompt, 'utf8');
  });
}

export async function askCodex(config, messages, spawnImpl = spawn) {
  await mkdir(config.codexWorkDir, { recursive: true });
  const key = config.codexConcurrency || 2;
  if (!limiters.has(key)) limiters.set(key, createLimiter(key));
  return limiters.get(key)(async () => {
    const outFile = join(config.codexWorkDir, `answer-${randomUUID()}.txt`);
    try {
      const answer = (await runTurn(config, messagesToPrompt(messages), outFile, spawnImpl)).trim();
      if (!answer) throw new Error('Codex 返回了空回答，请稍后重试。');
      const chars = Array.from(answer);
      return chars.length > 16000 ? chars.slice(0, 16000).join('') + '\n[回答过长，已截断]' : answer;
    } finally {
      // The killed process may still hold the file for a moment; cleanup is best-effort.
      setTimeout(() => unlink(outFile).catch(() => {}), 3000).unref?.();
    }
  });
}
