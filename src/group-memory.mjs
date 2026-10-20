import { createHash } from 'node:crypto';

export const MEMORY_LIMITS = { entries: 8, characters: 12000, summary: 1200, retrievalThreshold: 12000 };

export function activeGroupContent(content) {
  const reset = content.lastIndexOf('\n## 群上下文已重置');
  return reset < 0 ? content : content.slice(reset);
}

export function parseGroupTurns(content) {
  const active = activeGroupContent(content);
  const turns = [];
  for (const block of active.split(/\n## 问答记录 · /).slice(1)) {
    const match = block.match(/^([^\n]+)\n\n\*\*提问[^\n]*\*\*\n\n([\s\S]*?)\n\n\*\*AI 回答\*\*\n\n([\s\S]*)$/);
    if (!match) continue;
    const [, stamp, question, answer] = match;
    const id = createHash('sha256').update(block).digest('hex');
    turns.push({ id, stamp: stamp.trim(), question: question.trim(), answer: answer.trim() });
  }
  return turns;
}

// Extract whole key sentences locally; no additional AI request is needed.
export function extractKeyPoints(question, answer) {
  const units = `${question}\n${answer}`.split(/\r?\n|(?<=[。！？；])\s*/u).map(x => x.trim()).filter(Boolean);
  const ranked = units.map((text, index) => ({ text, index,
    score: (index === 0 ? 10 : 0) + (/路径|原因|结论|配置|必须|不要|修复|验证|[A-Za-z_]+\.[a-z]{1,6}|[A-Z_]{4,}/.test(text) ? 5 : 0),
  })).sort((a, b) => b.score - a.score || a.index - b.index);
  const kept = [];
  let length = 0;
  for (const unit of ranked) {
    if (length + Array.from(unit.text).length + 1 > MEMORY_LIMITS.summary) continue;
    kept.push(unit); length += Array.from(unit.text).length + 1;
  }
  return kept.sort((a, b) => a.index - b.index).map(x => x.text).join('\n');
}

export function memoryKeywords(text) {
  const found = new Set((text.toLowerCase().match(/[a-z_][a-z0-9_]{1,}/g) || []).filter(x => x.length <= 128));
  for (const run of text.match(/[\u3400-\u9fff]+/gu) || []) {
    for (let i = 0; i < run.length - 1; i++) found.add(run.slice(i, i + 2));
  }
  for (const stop of ['这个', '那个', '什么', '怎么', '一下', '可以', '问题', '回答', '请问', '如何', '是否']) found.delete(stop);
  return found;
}

export function buildGroupIndex(content, previous) {
  const records = Object.create(null);
  const keywords = Object.create(null);
  const order = [];
  for (const turn of parseGroupTurns(content)) {
    const old = previous?.version === 2 ? previous.records?.[turn.id] : null;
    const record = old || { ...turn, summary: extractKeyPoints(turn.question, turn.answer),
      keywords: [...memoryKeywords(`${turn.question}\n${turn.answer}`)] };
    records[turn.id] = record;
    order.push(turn.id);
    for (const term of record.keywords) (keywords[term] ||= []).push(turn.id);
  }
  return { version: 2, sourceHash: createHash('sha256').update(content).digest('hex'), order, records, keywords };
}

export function selectGroupMemories(index, query = '', limits = MEMORY_LIMITS) {
  const queryTerms = memoryKeywords(query);
  const followup = !query.trim() || /^(继续|接着|然后呢|展开|详细说|上面|刚才|之前那个|这个呢)[，。？！?！\s]*$/.test(query.trim());
  const scores = new Map();
  // Look up posting lists instead of scanning/tokenizing every saved answer.
  for (const term of queryTerms) {
    for (const id of Object.hasOwn(index.keywords, term) ? index.keywords[term] : []) {
      scores.set(id, (scores.get(id) || 0) + (/[a-z]/.test(term) ? 4 : 1));
    }
  }
  const positions = new Map(index.order.map((id, position) => [id, position]));
  const ids = followup ? index.order.slice(-2).reverse() : [...scores.keys()]
    .sort((a, b) => scores.get(b) - scores.get(a) || positions.get(b) - positions.get(a));
  const selected = [];
  let length = 0;
  for (const id of ids) {
    const turn = index.records[id];
    let section = `历史问答 · ${turn.stamp}\n提问：${turn.question}\n回答：${turn.answer}`;
    if (Array.from(section).length > limits.characters) section = `历史要点 · ${turn.stamp}\n${turn.summary}`;
    const size = Array.from(section).length + (selected.length ? 2 : 0);
    if (length + size > limits.characters) continue;
    selected.push(section); length += size;
    if (selected.length >= limits.entries) break;
  }
  return selected.join('\n\n');
}

