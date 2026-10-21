import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseWikiSource } from './wiki-kb.mjs';

function intSetting(env, name, fallback, min, max) {
  const value = Number(env[name] || fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} 应为 ${min} 到 ${max} 之间的整数。`);
  return value;
}

// Secrets come from .env; projects, wiki spaces and routing rules from bot.config.json.
export function readConfig(env, fileConfig = null) {
  for (const name of ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'AI_API_KEY']) {
    if (!env[name]?.trim() || /replace_me/.test(env[name])) throw new Error(`请在 .env 中填写 ${name}`);
  }
  const base = new URL((env.AI_BASE_URL || 'https://api.deepseek.com/v1').trim());
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('AI_BASE_URL 必须是 HTTP(S) 地址，不要包含密码、查询参数或 #。');
  }
  if (base.pathname.endsWith('/chat/completions')) throw new Error('AI_BASE_URL 填接口根地址，不要包含 /chat/completions。');
  const file = fileConfig ?? JSON.parse(readFileSync(resolve(env.BOT_CONFIG || 'bot.config.json'), 'utf8'));
  const projects = (file.projects || []).map((p, n) => {
    if (!p?.root) throw new Error(`bot.config.json 的 projects[${n}] 缺少 root`);
    return { name: p.name || `项目${n + 1}`, root: p.root, guides: p.guides || [], extensions: p.extensions, excludes: p.excludes || [] };
  });
  // Documents watched by docWatch (e.g. the 监修 documents) are also searchable, as single-document,
  // priority sources listed first so their priority flag wins over a subtree containing them.
  const watchOrigin = (file.docWatch?.wikiBase || 'https://rcnc3bm8lc5c.feishu.cn/wiki').match(/^https?:\/\/[^/]+/)?.[0] || '';
  const watched = file.docWatch?.enabled ? (file.docWatch.docs || []).map(entry => {
    const value = typeof entry === 'string' ? { url: entry } : entry;
    const token = value.wikiToken || value.wiki_token || (value.url || '').match(/\/wiki\/([A-Za-z0-9]+)/)?.[1];
    return token && { name: value.name || token, token, kind: 'wiki', origin: watchOrigin, scope: 'node', priority: true };
  }).filter(Boolean) : [];
  const wikiSources = [...watched, ...(file.wiki || []).map(parseWikiSource)];
  // When the question or the message it replies to mentions a `when` word, documents whose title or
  // path contains a `prefer` word (and the watched documents) are ranked first.
  const wikiFocus = (file.wikiFocus || [{ when: ['监修', '监修会', '日方', '版权方'], prefer: ['监修'] }])
    .map(rule => ({ when: rule.when || [], prefer: rule.prefer || [], boost: rule.boost || 3 }));
  // Private Q&A memory. scope "all": records help anyone's later questions; "user": only the same person's.
  const privateMemory = { enabled: file.privateMemory?.enabled ?? true, scope: file.privateMemory?.scope === 'user' ? 'user' : 'all' };
  return {
    wikiFocus, privateMemory,
    appId: env.FEISHU_APP_ID.trim(), appSecret: env.FEISHU_APP_SECRET.trim(),
    endpoint: base.href.replace(/\/$/, '') + '/chat/completions',
    apiKey: env.AI_API_KEY.trim(), model: (env.AI_MODEL || 'deepseek-chat').trim(),
    timeout: intSetting(env, 'AI_TIMEOUT_SECONDS', 120, 1, 600) * 1000,
    temperature: Number(env.AI_TEMPERATURE || 0.3),
    system: env.AI_SYSTEM_PROMPT || file.systemPrompt || '你是团队的项目知识助手，熟悉团队知识库和项目代码。回答准确、简洁，用中文。资料不足时明确说明并建议找谁确认，不要编造。',
    historyLimit: intSetting(env, 'FEISHU_HISTORY_LIMIT', 20, 1, 50),
    wikiSyncMinutes: intSetting(env, 'WIKI_SYNC_MINUTES', 60, 0, 10080),
    wikiMaxDocs: intSetting(env, 'WIKI_MAX_DOCS', 3000, 1, 50000),
    dataDir: resolve(env.DATA_DIR || 'data'),
    ackEmoji: env.ACK_EMOJI ?? 'OnIt',
    projects, wikiSources,
    docWatch: file.docWatch?.enabled ? { ...file.docWatch, mapping: resolve(file.docWatch.mapping || 'doc-watch.mapping.json') } : null,
    routing: { rules: file.routing?.rules || [], notifyDocOwners: file.routing?.notifyDocOwners ?? true,
      maxNotify: file.routing?.maxNotify ?? 3 },
  };
}
