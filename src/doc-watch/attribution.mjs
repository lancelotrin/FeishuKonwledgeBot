// Decides which module owners a change belongs to. Priority:
// learned (confirmed by a person) > cross-module topics > model judgement > keyword rules.
// The mapping file format is the one used by the original Python bot (mapping.json).

const DIGIT_ORDER = ['battle', 'level', 'system', 'num', 'text', 'audio', 'art', 'interact'];

// Numbered options for clarification questions; keeps the original bot's numbering (7 美术, 8 交互).
export function routeOptions(mapping) {
  const routes = mapping.routes || [];
  const ordered = [...DIGIT_ORDER.map(key => routes.find(r => r.key === key)).filter(Boolean),
    ...routes.filter(r => !DIGIT_ORDER.includes(r.key))];
  return ordered.map((route, n) => ({ digit: String(n + 1), key: route.key, name: route.name || route.key }));
}

function keywordRoutes(item, mapping) {
  const whole = `${item.section || ''} ${item.text}`;
  const haystack = whole.toLowerCase();
  let hits = (mapping.routes || [])
    .filter(r => !(r.exclude || []).some(ex => haystack.includes(String(ex).toLowerCase())))
    .filter(r => (r.keywords || []).some(kw => haystack.includes(String(kw).toLowerCase())))
    .map(r => r.key);
  // Character rules apply only when the text is about the character itself (动作/技能/模型…).
  const rules = mapping.character_rules || {};
  if ((rules.content_words || []).some(w => w && whole.includes(w))) {
    if ((rules.monsters || []).some(n => n && whole.includes(n))) hits = [...hits.filter(k => k !== 'battle'), 'level'];
    else if ((rules.playable || []).some(n => n && whole.includes(n))) hits = [...hits.filter(k => k !== 'level'), 'battle'];
  }
  return [...new Set(hits)];
}

// Returns { keys: route keys, people: extra owner names (topics / cc), via: which layer decided }.
export function attribute(item, mapping, learned = {}) {
  const section = item.section || '';
  if (section && learned[section]?.length) return { keys: learned[section], people: [], via: '人工确认' };
  const whole = `${section} ${item.text}`;
  const topic = (mapping.topics || []).find(t => (t.keywords || []).some(k => k && whole.includes(k)));
  if (topic) return { keys: topic.routes || [], people: topic.owners || [], via: `跨系统主题「${topic.name || topic.keywords[0]}」` };
  if (item.modelRoutes) return { keys: item.modelRoutes, people: [], via: '模型判断' };
  return { keys: keywordRoutes(item, mapping), people: [], via: '关键词' };
}

export function ownersFor(keys, mapping) {
  const names = [];
  for (const key of keys) {
    const route = (mapping.routes || []).find(r => r.key === key);
    if (!route) continue;
    names.push(route.owner || key, ...(route.cc || []));
  }
  return names;
}

function parseJsonArray(text) {
  const start = text.indexOf('[');
  if (start < 0) throw new Error('no JSON array');
  // The model sometimes repeats the answer; take the first complete array only.
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) { if (ch === '\\') i++; else if (ch === '"') inString = false; continue; }
    if (ch === '"') inString = true;
    else if (ch === '[') depth++;
    else if (ch === ']' && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error('unterminated JSON array');
}

// Asks the model to label every change with route keys. Returns how many items were labelled;
// throws when the model is unavailable so the caller can degrade to keyword rules.
export async function annotateWithModel(changes, mapping, ask, maxItems = 40) {
  const items = [...changes.added, ...changes.changed, ...changes.removed].slice(0, maxItems);
  if (!items.length) return 0;
  const routes = (mapping.routes || []).map(r => `- ${r.key}（${r.name}）：${(r.keywords || []).slice(0, 12).join('、')}`).join('\n');
  const rules = mapping.character_rules || {};
  const confirmed = (mapping['_已确认规则'] || []).map(x => `- ${x}`).join('\n');
  const system = [
    '你是游戏项目的文档变更分诊员。根据变更所在的标题路径和正文，判断应同步给哪些模块负责人。',
    `可用模块及关键词：\n${routes}`,
    rules.monsters?.length ? `怪物/敌人（其动作、外观一律归 level）：${rules.monsters.join('、')}` : '',
    rules.playable?.length ? `玩家可控角色（其技能、动作归 battle）：${rules.playable.join('、')}` : '',
    confirmed ? `已确认的分工规则（必须遵守）：\n${confirmed}` : '',
    '一条可以命中多个模块；美术交付物额外加 art 并保留所属功能模块；实在判断不了的给空数组。',
    '只输出 JSON 数组，不要解释，格式：[{"i":0,"modules":["battle","art"]}]',
  ].filter(Boolean).join('\n\n');
  const payload = items.map((item, i) => ({ i, section: (item.section || '').slice(-120), text: item.text.slice(0, 160) }));
  const rows = parseJsonArray(await ask([{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(payload) }]));
  const valid = new Set((mapping.routes || []).map(r => r.key));
  let marked = 0;
  for (const row of rows) {
    const item = items[Number(row?.i)];
    if (!item || !Array.isArray(row.modules)) continue;
    item.modelRoutes = row.modules.filter(m => valid.has(m));
    marked++;
  }
  return marked;
}

export async function summarizeWithModel(title, changes, ask) {
  const clip = list => list.slice(0, 12).map(it => ({ section: it.section || '', text: it.text.slice(0, 120) }));
  const data = { doc: title, added: clip(changes.added), changed: clip(changes.changed), removed: clip(changes.removed) };
  const answer = await ask([
    { role: 'system', content: '你是游戏项目的通知助理。用一句话概括下面这组文档变更（40 字以内，中文，不要客套话），点明是哪个功能/角色/交付物发生了什么类型的变动。只输出这句话本身。' },
    { role: 'user', content: JSON.stringify(data) },
  ]);
  return answer.trim().split('\n')[0];
}
