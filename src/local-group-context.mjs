import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { activeGroupContent, buildGroupIndex, selectGroupMemories, MEMORY_LIMITS } from './group-memory.mjs';

function safeName(chatId) { return `${Buffer.from(chatId).toString('base64url')}.md`; }

export function createLocalGroupContextStore(directory = 'data/group-context', { report = console.error, retrievalThreshold = MEMORY_LIMITS.retrievalThreshold } = {}) {
  if (!Number.isInteger(retrievalThreshold) || retrievalThreshold < 0 || retrievalThreshold > MEMORY_LIMITS.characters) {
    throw new Error('历史检索阈值应为 0 到 12000 之间的整数。');
  }
  const root = resolve(directory);
  const fileFor = chatId => join(root, safeName(chatId));
  const indexFor = chatId => fileFor(chatId).replace(/\.md$/, '.memory.json');
  async function readIndex(chatId) {
    try {
      const value = JSON.parse(await readFile(indexFor(chatId), 'utf8'));
      return value?.version === 2 && Array.isArray(value.order) && value.records && value.keywords ? value : null;
    } catch { return null; } // Old summary indexes are rebuilt locally from the Markdown.
  }
  async function saveIndex(chatId, index) {
    const path = indexFor(chatId);
    await writeFile(`${path}.tmp`, JSON.stringify(index, null, 2), 'utf8');
    await rename(`${path}.tmp`, path);
  }
  async function ensureIndex(chatId, content) {
    const previous = await readIndex(chatId);
    const hash = createHash('sha256').update(content).digest('hex');
    if (previous?.sourceHash === hash) return previous;
    const index = buildGroupIndex(content, previous);
    try { await saveIndex(chatId, index); }
    catch { report('关键词索引写入失败，本次仍使用内存中的检索结果。'); }
    return index;
  }
  const queues = new Map();
  async function update(chatId, operation) {
    const current = (queues.get(chatId) || Promise.resolve()).catch(() => {}).then(operation);
    queues.set(chatId, current);
    try { return await current; } finally { if (queues.get(chatId) === current) queues.delete(chatId); }
  }
  return {
    read(chatId, query = '') { return update(chatId, async () => {
      try {
        const content = await readFile(fileFor(chatId), 'utf8');
        const active = activeGroupContent(content);
        if (Array.from(active).length <= retrievalThreshold) return active;
        return selectGroupMemories(await ensureIndex(chatId, content), query);
      } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
    }); },
    append(item, answer) { return update(item.chatId, async () => {
      await mkdir(root, { recursive: true });
      let old = '';
      try { old = await readFile(fileFor(item.chatId), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const stamp = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
      const asker = item.userName ? `（${item.userName}）` : '';
      const entry = `\n## 问答记录 · ${stamp}\n\n**提问${asker}**\n\n${item.text}\n\n**AI 回答**\n\n${answer}\n`;
      const temp = `${fileFor(item.chatId)}.tmp`;
      await writeFile(temp, old + entry, 'utf8');
      await rename(temp, fileFor(item.chatId));
      try {
        const content = old + entry;
        if (Array.from(activeGroupContent(content)).length > retrievalThreshold) await ensureIndex(item.chatId, content);
      } catch { report('关键词索引保存失败，完整问答已保存，下次读取将自动重建。'); }
    }); },
    reset(chatId) { return update(chatId, async () => {
      await mkdir(root, { recursive: true });
      const stamp = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
      let old = '';
      try { old = await readFile(fileFor(chatId), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await writeFile(fileFor(chatId), `${old}\n## 群上下文已重置 · ${stamp}\n`, 'utf8');
    }); },
    pathFor: fileFor,
  };
}
