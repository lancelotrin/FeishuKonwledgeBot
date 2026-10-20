// Searches one or more configured project directories. Git worktrees use `git grep`;
// plain folders fall back to a bounded file walk.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';

const execFileAsync = promisify(execFile);
export const DEFAULT_EXTENSIONS = ['.cs', '.cpp', '.h', '.c', '.py', '.md', '.txt', '.json', '.xml', '.yaml', '.yml',
  '.proto', '.lua', '.bat', '.ps1', '.shader', '.compute', '.cginc', '.asmdef', '.uxml', '.uss', '.js', '.mjs', '.ts', '.go', '.java'];
export const DEFAULT_EXCLUDES = ['.git', '.cursor', '.agents', '.agent-local', '.specstory', 'Library', 'Temp', 'obj', 'bin',
  'node_modules', 'ThirdAssets', 'Plugins', 'Logs', 'Build', 'Builds'];
const STOP_WORDS = new Set(['项目', '这个', '那个', '怎么', '如何', '什么', '请问', '一下', '里面', '可以', '为什么', '有没有', '是不是', '哪里', '在哪']);

export function projectSearchTerms(question) {
  const terms = [];
  const add = value => {
    const term = value.trim();
    if (term.length >= 2 && !STOP_WORDS.has(term) && !terms.includes(term)) terms.push(term);
  };
  for (const word of question.match(/[A-Za-z_][A-Za-z0-9_.:/-]{2,}|[0-9]{3,}/g) || []) add(word);
  for (const run of question.match(/[㐀-鿿]{2,}/gu) || []) {
    if (run.length <= 10) add(run);
    const n = run.length >= 5 ? 3 : 2;
    for (let i = 0; i <= run.length - n; i++) add(run.slice(i, i + n));
  }
  return terms.slice(0, 8);
}

export function rankMatches(output, terms, excludes = DEFAULT_EXCLUDES, limit = 6) {
  const files = new Map();
  const excluded = new Set(excludes.map(x => x.toLowerCase()));
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^(.+?):(\d+):(.*)$/);
    if (!match) continue;
    const [, path, rawLine, content] = match;
    if (path.replaceAll('\\', '/').split('/').some(part => excluded.has(part.toLowerCase()))) continue;
    let entry = files.get(path);
    if (!entry) { entry = { path, lineNumbers: new Set(), hits: new Set(), score: 0 }; files.set(path, entry); }
    entry.lineNumbers.add(Number(rawLine));
    for (const term of terms) {
      if (content.toLocaleLowerCase().includes(term.toLocaleLowerCase())) {
        entry.hits.add(term);
        entry.score += Math.min(term.length, 12);
      }
    }
  }
  for (const entry of files.values()) {
    entry.score += entry.hits.size * 8;
    for (const term of terms) if (entry.path.toLocaleLowerCase().includes(term.toLocaleLowerCase())) entry.score += 10;
    if (/readme|architecture|overview|design|\.md$/i.test(entry.path)) entry.score += 4;
  }
  return [...files.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
}

export function makeSnippets(source, lineNumbers, maxChars = 1600) {
  const lines = source.split(/\r?\n/);
  const ranges = [];
  for (const lineNumber of lineNumbers) {
    const start = Math.max(0, lineNumber - 3);
    const end = Math.min(lines.length - 1, lineNumber + 2);
    const last = ranges.at(-1);
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  }
  let result = '';
  for (const [start, end] of ranges) {
    const part = lines.slice(start, end + 1).map((line, index) => `${start + index + 1}: ${line}`).join('\n');
    const next = `${result}${result ? '\n…\n' : ''}${part}`;
    if (next.length > maxChars) break;
    result = next;
  }
  return result;
}

async function isGitWorktree(root) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'],
      { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 4096 });
    return stdout.trim() === 'true';
  } catch { return false; }
}

async function gitGrep(project, terms) {
  const args = ['-c', 'core.quotePath=false', '-C', project.root, 'grep', '--no-color', '-n', '-I', '-F', '-i', '-m', '3'];
  for (const term of terms) args.push('-e', term);
  args.push('--', ...project.extensions.map(ext => `*${ext}`), ...project.excludes.map(dir => `:(exclude,glob)**/${dir}/**`));
  try {
    return (await execFileAsync('git', args, { encoding: 'utf8', windowsHide: true, timeout: 25000, maxBuffer: 10 * 1024 * 1024 })).stdout;
  } catch (error) {
    if (error.stdout) return error.stdout;
    if (error.code === 1) return ''; // git grep exits 1 when nothing matches
    throw new Error(`检索项目「${project.name}」失败`);
  }
}

async function walkGrep(project, terms, maxFiles = 20000) {
  const lowered = terms.map(x => x.toLocaleLowerCase());
  const excluded = new Set(project.excludes.map(x => x.toLowerCase()));
  const output = [];
  let visited = 0;
  async function walk(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (visited >= maxFiles) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { if (!excluded.has(entry.name.toLowerCase())) await walk(full); continue; }
      if (!project.extensions.includes(extname(entry.name).toLowerCase())) continue;
      visited++;
      try { if ((await stat(full)).size > 1024 * 1024) continue; } catch { continue; }
      let text;
      try { text = await readFile(full, 'utf8'); } catch { continue; }
      const rel = relative(project.root, full).replaceAll('\\', '/');
      let found = 0;
      text.split(/\r?\n/).forEach((line, n) => {
        if (found < 3 && lowered.some(term => line.toLocaleLowerCase().includes(term))) { output.push(`${rel}:${n + 1}:${line}`); found++; }
      });
    }
  }
  await walk(project.root);
  return output.join('\n');
}

export async function createProjectReader(projects, { maxChars = 10000 } = {}) {
  const ready = [];
  for (const project of projects) {
    const root = resolve(project.root);
    try { await stat(root); } catch { throw new Error(`项目目录不存在：${project.name} → ${root}`); }
    ready.push({ ...project, root, git: await isGitWorktree(root),
      extensions: (project.extensions || DEFAULT_EXTENSIONS).map(x => x.toLowerCase()),
      excludes: [...DEFAULT_EXCLUDES, ...(project.excludes || [])] });
  }
  return async function readRelevantProjectContext(question) {
    const terms = projectSearchTerms(question);
    const sections = [];
    const files = [];
    let total = 0;
    const perProject = Math.max(2000, Math.floor(maxChars / ready.length));
    const results = await Promise.all(ready.map(async project => {
      const guides = [];
      for (const guide of project.guides || []) {
        try { guides.push(`《${project.name}》默认文档 ${guide}：\n${Array.from(await readFile(join(project.root, guide), 'utf8')).slice(0, 4000).join('')}`); }
        catch { /* optional guide missing */ }
      }
      if (!terms.length) return { project, guides, candidates: [] };
      const output = project.git ? await gitGrep(project, terms) : await walkGrep(project, terms);
      return { project, guides, candidates: rankMatches(output, terms, project.excludes) };
    }));
    for (const { project, guides, candidates } of results) {
      sections.push(...guides);
      let used = 0;
      for (const candidate of candidates) {
        let source;
        try { source = await readFile(join(project.root, candidate.path), 'utf8'); } catch { continue; }
        const snippet = makeSnippets(source, [...candidate.lineNumbers].sort((a, b) => a - b));
        if (!snippet) continue;
        const section = `项目「${project.name}」文件：${candidate.path}\n${snippet}`;
        if (used + section.length > perProject || total + section.length > maxChars) break;
        sections.push(section); files.push({ project: project.name, path: candidate.path });
        used += section.length; total += section.length;
      }
    }
    return { context: sections.join('\n\n---\n\n'), files };
  };
}
