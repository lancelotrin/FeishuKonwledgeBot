// Document change monitor: on a schedule, diffs watched docx documents block by block, works out
// which module owners each change belongs to, and messages them privately.
// Invariant: the baseline snapshot only advances after every real send succeeded, so failed
// notifications are retried next round instead of being lost. Recipients who already received a batch
// are remembered (deliveries.json) and never get the same batch twice; after MAX_ATTEMPTS failed rounds
// the baseline advances anyway so one unreachable person cannot block everyone else.
// Every delivered batch is appended to changes-log.jsonl, which answers "what changed recently".
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { flattenBlocks, diffDocs, countChanges } from './blocks.mjs';
import { headline, summarize } from './summary.mjs';
import { attribute, ownersFor, routeOptions, annotateWithModel, summarizeWithModel, condenseWithModel } from './attribution.mjs';
import { createPostContent } from '../core.mjs';

const CANCEL = /^(取消推送|退订|别发了|不要发了|不想收|停止推送|关闭推送|取消)[。！!\s]*$/;
const RESUME = /^(恢复推送|继续推送|重新订阅|订阅)[。！!\s]*$/;
const sleep = ms => new Promise(done => setTimeout(done, ms));
const MAX_ATTEMPTS = 6;
const KIND_MARK = { added: '＋', changed: '～', removed: '－' };
const today = (now = new Date()) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
const stamp = (now = new Date()) => `${today(now)} ${now.toTimeString().slice(0, 8)}`;

// A question about recent edits ("改了什么 / 最新 / 更新") that concerns the watched documents
// (mentions 监修 or a watched document's name, in the question or the message it replies to).
export function asksAboutChanges(text, context, docNames = []) {
  if (!/改了|改动|修改|更新|变更|变化|最新|新增|刚刚|最近|删了|动了/.test(text)) return false;
  return /监修/.test(context) || docNames.some(name => name && context.includes(name));
}

export function parseDocSource(entry) {
  const value = typeof entry === 'string' ? { url: entry } : { ...entry };
  const token = value.wikiToken || value.wiki_token || (value.url || '').match(/\/wiki\/([A-Za-z0-9]+)/)?.[1];
  if (!token) throw new Error(`docWatch.docs 中无法识别的文档：${JSON.stringify(entry)}`);
  return { name: value.name || token, token };
}

export function createDocWatcher({ request: rawRequest, send, ask = null, mapping, config, dataDir, report = console.error, log = console.log }) {
  const root = resolve(dataDir);
  const docs = (config.docs || []).map(parseDocSource);
  const wikiBase = (config.wikiBase || 'https://rcnc3bm8lc5c.feishu.cn/wiki').replace(/\/$/, '');
  const staleMs = (config.staleMinutes ?? 10) * 60_000;
  const asker = config.clarify?.asker || '';
  // Admins may bind other people by @mentioning them; default to the clarification maintainer.
  const admins = config.admins || [asker].filter(Boolean);
  const clarifyEnabled = config.clarify?.enabled ?? true;
  const options = routeOptions(mapping);
  let running = null;

  async function load(name, fallback) {
    try { return JSON.parse(await readFile(join(root, name), 'utf8')); }
    catch { return fallback; }
  }
  async function save(name, value) {
    const path = join(root, name);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2), 'utf8');
    await rename(`${path}.tmp`, path);
  }

  async function request(method, url, params, data) {
    for (let attempt = 0; ; attempt++) {
      const body = await rawRequest(method, url, params, data);
      if (![99991400, 429].includes(body?.code) || attempt >= 4) return body;
      await sleep(1000 * 2 ** attempt); // Feishu rate limit
    }
  }
  function ok(body, what) {
    if (body?.code !== 0) throw new Error(`${what}失败（飞书错误码 ${body?.code ?? '未知'}）`);
    return body.data || {};
  }

  // ---------------------------------------------------------------- people
  // mapping.owners may carry open_ids issued to another app; `/bind 姓名` from a private chat
  // records the open_id this bot sees, and that binding wins.
  async function people() {
    const bindings = await load('bindings.json', {});
    const result = {};
    for (const [name, info] of Object.entries(mapping.owners || {})) {
      result[name] = { role: info?.role || '', openId: bindings[name] || info?.openId || info?.open_id || '' };
    }
    for (const [name, openId] of Object.entries(bindings)) result[name] ||= { role: '', openId };
    return result;
  }
  async function nameOf(openId) {
    return Object.entries(await people()).find(([, p]) => p.openId === openId)?.[0] || '';
  }
  async function sendTo(name, markdown) {
    const person = (await people())[name];
    if (!person?.openId) return `SKIP：${name} 没有 open_id（请让对方私聊机器人发送 /bind ${name}）`;
    const result = await send(person.openId, createPostContent(markdown));
    if (result.code === 0) return 'OK';
    // An open_id issued to another app never starts working by retrying: like a missing open_id it is a
    // configuration gap (the person must /bind), so it is reported but does not hold back the baseline.
    if (result.code === 99992361) return `SKIP：${name} 的 open_id 属于其他应用（请让对方私聊机器人发送 /bind ${name}）`;
    const hint = result.code === 230013 ? '（对方不在应用可用范围内）' : '';
    return `ERR ${result.code}${hint}`;
  }

  // ---------------------------------------------------------------- fetch / snapshot
  async function fetchDoc(source, node) {
    const blocks = [];
    let pageToken = '';
    do {
      const data = ok(await request('GET', `/open-apis/docx/v1/documents/${node.obj_token}/blocks`,
        { page_size: 500, document_revision_id: -1, ...(pageToken ? { page_token: pageToken } : {}) }), '读取文档块');
      blocks.push(...(data.items || []));
      pageToken = data.has_more ? data.page_token : '';
    } while (pageToken);
    return { token: source.token, title: node.title || source.name, editTime: String(node.obj_edit_time || ''),
      fetchedAt: stamp(), blocks: flattenBlocks(blocks, node.obj_token) };
  }
  const snapshotName = token => join('snapshots', `${token}.json`);

  // ---------------------------------------------------------------- dispatch
  function messageFor(doc, name, role, subset, extra) {
    const condensed = extra.condensed || {};
    const refined = ['added', 'changed', 'removed'].some(kind => subset[kind].some(item => condensed[item.section || '（无标题）']));
    const body = summarize(subset, condensed).split('\n').map(line => line.startsWith('▸') ? `**${line}**`
      : line.startsWith('   ') ? `- ${line.trim()}` : line).join('\n');
    return [
      `**📌 ${doc.title}**`,
      `${role ? `${name}（${role}）` : name} · ${extra.subtitle || '你负责的部分有更新'}（${headline(subset)}）`,
      extra.degraded ? '⚠️ 智能归类暂时不可用，本条按关键词规则分发，可能有偏差；如需纠正直接回复。' : '',
      extra.sentence || '',
      '',
      body,
      refined ? '（以上由 AI 精炼，日文已译为中文，原文见文档）' : '',
      '',
      `🔗 ${wikiBase}/${doc.token}`,
    ].filter((line, n, all) => line || (n > 0 && all[n - 1])).join('\n');
  }

  async function dispatch(doc, changes, { dryRun, degraded, sentence, condensed, delivered = new Set() }) {
    const learned = await load('learned.json', {});
    const directory = await people();
    const unsubscribed = await load('unsubscribed.json', {});
    const buckets = new Map();
    const unmatched = [];
    for (const kind of ['added', 'changed', 'removed']) {
      for (const item of changes[kind]) {
        const { keys, people: extra } = attribute(item, mapping, learned);
        const names = [...new Set([...ownersFor(keys, mapping), ...extra])];
        if (!names.length) { unmatched.push(item); if (clarifyEnabled) continue; names.push(...(mapping.leads || [])); }
        for (const name of names) {
          if (!buckets.has(name)) buckets.set(name, { added: [], changed: [], removed: [], lead: !keys.length });
          buckets.get(name)[kind].push(item);
        }
      }
    }
    const results = {};
    for (const [name, subset] of buckets) {
      if (delivered.has(name)) { results[name] = 'SKIP：这批变更已发过'; continue; }
      if (unsubscribed[name]) { results[name] = 'SKIP：已取消推送'; continue; }
      const markdown = messageFor(doc, name, directory[name]?.role, subset,
        { degraded, sentence, condensed, subtitle: subset.lead ? '未匹配到具体模块，已同步组长' : '' });
      if (dryRun) { results[name] = `DRY-RUN\n${markdown}`; continue; }
      results[name] = await sendTo(name, markdown);
      if (results[name] === 'OK') {
        await mkdir(root, { recursive: true });
        await appendFile(join(root, 'notify-log.jsonl'), JSON.stringify({ time: stamp(), doc: doc.title, token: doc.token,
          owner: name, count: countChanges(subset) }) + '\n', 'utf8');
      }
    }
    return { results, unmatched };
  }

  // ---------------------------------------------------------------- clarify / escalate
  async function askUnmatched(doc, unmatched) {
    if (!clarifyEnabled || !asker || !unmatched.length) return 0;
    const pending = await load('pending.json', {});
    let asked = 0;
    for (const item of unmatched) {
      const section = item.section || '';
      if (pending[section] || asked >= 3) continue;
      const list = options.map(o => `${o.digit} ${o.name}`).join('\n');
      const text = `❓ **有条变更我看不出该归谁，帮我确认一下**\n\n📄 ${doc.title}\n📎 ${section || '（无标题）'}\n内容：${item.text.slice(0, 120)}\n\n回复数字（可多个，如「1,7」）：\n${list}\n\n回复后会记住这条标题的归属，下次不再问。`;
      if (await sendTo(asker, text) !== 'OK') continue;
      pending[section] = { docTitle: doc.title, text: item.text.slice(0, 300), link: `${wikiBase}/${doc.token}`, askedAt: stamp() };
      asked++;
    }
    await save('pending.json', pending);
    return asked;
  }

  async function escalate(reason, detail) {
    const arbiter = mapping.arbiter;
    if (!arbiter) return false;
    const sent = await sendTo(arbiter, `⚖️ **需要你定一下（${reason}）**\n\n${detail}\n\n—— 回我一句怎么处理就行，我按你的决定改规则。`);
    await mkdir(root, { recursive: true });
    await appendFile(join(root, 'escalations.jsonl'), JSON.stringify({ time: stamp(), reason, detail, sent }) + '\n', 'utf8');
    return sent === 'OK';
  }

  async function answerClarify(text, sender) {
    const pending = await load('pending.json', {});
    const sections = Object.keys(pending);
    if (!sections.length) return null;
    const keys = [...new Set((text.match(/\d+/g) || []).map(d => options.find(o => o.digit === d)?.key).filter(Boolean))];
    if (!keys.length || /[^\d\s,，、]/.test(text)) return null; // not a numbered answer
    const section = sections.sort((a, b) => pending[b].askedAt.localeCompare(pending[a].askedAt))[0];
    const learned = await load('learned.json', {});
    const label = list => options.filter(o => list.includes(o.key)).map(o => o.name).join('、');
    if (learned[section] && learned[section].sort().join() !== [...keys].sort().join()) {
      await escalate('同一标题被要求归到不同模块',
        `标题：${section}\n原来归「${label(learned[section])}」，${sender || '有人'}要求改成「${label(keys)}」。`);
      return `⚠️ 这条和之前的记录不一致：\n原来：「${section}」→ ${label(learned[section])}\n这次：「${section}」→ ${label(keys)}\n\n已转给${mapping.arbiter || '决策人'}确认，在此之前仍按原规则分发。`;
    }
    learned[section] = keys;
    await save('learned.json', learned);
    const info = pending[section];
    delete pending[section];
    await save('pending.json', pending);
    const forwarded = [];
    for (const name of new Set(ownersFor(keys, mapping))) {
      const body = `**📌 ${info.docTitle}**\n▸ ${section || '（无标题）'}\n${info.text.slice(0, 200)}\n\n（这条之前无法自动归类，已按 ${label(keys)} 补发）\n🔗 ${info.link}`;
      if (await sendTo(name, body) === 'OK') forwarded.push(name);
    }
    return `✅ 记住了：「${section || '（无标题）'}」→ ${label(keys)}\n以后这个标题下的变更会自动归到这些模块。${forwarded.length ? `\n已补发给：${forwarded.join('、')}` : ''}`;
  }

  // Admin batch binding: "/bind @殷琦 @万汩" or "/bind 宋子由 @宋自由" (name from the config, then the person).
  async function bindMentioned(item, text, known) {
    const sender = await nameOf(item.userId);
    if (!admins.includes(sender)) {
      return `只有管理员（${admins.join('、') || '未配置'}）可以替别人绑定。管理员需先私聊机器人发送 /bind 自己的姓名。`;
    }
    const bindings = await load('bindings.json', {});
    const done = [];
    const failed = [];
    const tokens = text.replace(/^\/bind/, '').trim().split(/\s+/);
    tokens.forEach((token, n) => {
      if (!token.startsWith('@')) return;
      const person = item.mentions.find(m => `@${m.name}` === token);
      if (!person) { failed.push(`${token}（没识别到这个 @）`); return; }
      const alias = n > 0 && !tokens[n - 1].startsWith('@') ? tokens[n - 1] : '';
      // Display names often decorate the real name, e.g. 「阿飞（苏敬袁）」「王宏钢（Coke）」: fall back to the
      // longest roster name contained in the display name.
      const contained = [...known].filter(k => person.name.includes(k)).sort((a, b) => b.length - a.length)[0];
      const name = alias || (known.has(person.name) ? person.name : contained || person.name);
      if (!known.has(name)) { failed.push(`${name}（不在人员名单里，可写成「名单里的姓名 @此人」）`); return; }
      bindings[name] = person.openId;
      done.push(alias && alias !== person.name ? `${name} → ${person.name}` : name);
    });
    if (done.length) await save('bindings.json', bindings);
    const missing = [...known].filter(name => !bindings[name]);
    return [done.length ? `✅ 已绑定 ${done.length} 人：${done.join('、')}` : '没有绑定任何人。',
      failed.length ? `⚠️ 未绑定：${failed.join('；')}` : '',
      missing.length ? `还没绑定：${missing.join('、')}` : '名单里的人已全部绑定。'].filter(Boolean).join('\n');
  }

  async function alertDegraded(reason, dryRun) {
    const health = await load('health.json', {});
    if (dryRun || health.lastNotice === today() || !asker) return;
    if (await sendTo(asker, `⚠️ **文档通知机器人告警**\n\n智能归类不可用：${reason}\n\n已自动切换到关键词规则分发——通知照常发，但归类可能不准。恢复后会自动切回。`) === 'OK') {
      await save('health.json', { lastNotice: today(), reason, at: stamp() });
    }
  }

  // ---------------------------------------------------------------- one round
  async function checkNow({ dryRun = false, force = false } = {}) {
    const summary = [];
    for (const source of docs) {
      try {
        const node = ok(await request('GET', '/open-apis/wiki/v2/spaces/get_node', { token: source.token }), '读取文档节点').node;
        const editedAgo = Date.now() - Number(node.obj_edit_time || 0) * 1000;
        const old = await load(snapshotName(source.token), null);
        if (old && old.editTime === String(node.obj_edit_time)) { summary.push(`${node.title}：无变更`); continue; }
        // Debounce: someone edited within the last few minutes and may still be typing.
        if (!force && old && editedAgo < staleMs) { summary.push(`${node.title}：${Math.round(editedAgo / 60_000)} 分钟前刚编辑过，下轮再看`); continue; }
        const doc = await fetchDoc(source, node);
        const changes = diffDocs(old, doc);
        if (changes.firstRun) {
          if (!dryRun) await save(snapshotName(source.token), doc);
          summary.push(`${doc.title}：首次运行，建立基线（${doc.blocks.length} 块），不通知`);
          continue;
        }
        const total = countChanges(changes);
        if (!total) {
          if (!dryRun) await save(snapshotName(source.token), doc);
          summary.push(`${doc.title}：编辑时间变了但正文无变化`);
          continue;
        }
        let degraded = false;
        let sentence = '';
        if (ask && config.useModel !== false) {
          try {
            await annotateWithModel(changes, mapping, ask);
            sentence = await summarizeWithModel(doc.title, changes, ask).catch(() => '');
          } catch (error) {
            degraded = true;
            await alertDegraded(error.message, dryRun);
          }
        }
        // Condensing (and translating) is best-effort: if the model fails, the paragraph list is sent as before.
        const condensed = ask && config.condense !== false ? await condenseWithModel(changes, ask).catch(() => ({})) : {};
        // Same batch as a previous failed round: skip the people who already received it.
        const signature = createHash('sha1').update(JSON.stringify(['added', 'changed', 'removed']
          .map(kind => changes[kind].map(item => `${item.id}:${item.text}`)))).digest('hex');
        const deliveries = await load('deliveries.json', {});
        const state = deliveries[source.token]?.signature === signature
          ? deliveries[source.token] : { signature, sent: [], attempts: 0 };
        const { results, unmatched } = await dispatch(doc, changes,
          { dryRun, degraded, sentence, condensed, delivered: new Set(state.sent) });
        const failed = Object.values(results).some(r => r.startsWith('ERR'));
        let gaveUp = false;
        if (!dryRun) {
          state.sent = [...new Set([...state.sent, ...Object.keys(results).filter(name => results[name] === 'OK')])];
          state.attempts++;
          gaveUp = failed && state.attempts >= MAX_ATTEMPTS;
          const record = { time: state.pending?.time || stamp(), doc: doc.title, token: doc.token, condensed,
            items: ['added', 'changed', 'removed'].flatMap(kind => changes[kind]
              .filter(item => !item.level).slice(0, 80).map(item => ({ kind, section: item.section || '', text: item.text.slice(0, 300) }))) };
          // SKIP (no open_id / unsubscribed) is a configuration gap and must not block the baseline;
          // real send failures keep the old baseline (up to MAX_ATTEMPTS rounds) so they are retried.
          if (!failed || gaveUp) {
            await save(snapshotName(source.token), doc);
            delete deliveries[source.token];
            await appendFile(join(root, 'changes-log.jsonl'), JSON.stringify(record) + '\n', 'utf8');
            await askUnmatched(doc, unmatched);
            if (gaveUp) report(`[文档监测] 《${doc.title}》连续 ${MAX_ATTEMPTS} 轮有人发送失败，已放弃重试：${Object.entries(results).filter(([, r]) => r.startsWith('ERR')).map(([n, r]) => `${n} ${r}`).join('；')}`);
          } else deliveries[source.token] = { ...state, pending: record }; // still visible to "what changed" questions
          await save('deliveries.json', deliveries);
        }
        const lines = Object.entries(results).map(([name, r]) => `  → ${name}：${dryRun ? r.replace(/^DRY-RUN\n/, '\n') : r}`);
        const note = !failed ? '' : gaveUp ? `，连续 ${MAX_ATTEMPTS} 轮有人发送失败，已放弃重试并推进基线` : '，有发送失败，基线不推进，下轮只重发给失败的人';
        summary.push(`${doc.title}：${total} 处变更${degraded ? '（模型不可用，按关键词分发）' : ''}${note}\n${lines.join('\n')}`);
      } catch (error) {
        summary.push(`${source.name}：检查失败 ${error.message}`);
      }
    }
    return summary.join('\n');
  }

  async function digest({ dryRun = false } = {}) {
    const to = config.digest?.to || [];
    if (!to.length) return '';
    let rows = [];
    try { rows = (await readFile(join(root, 'notify-log.jsonl'), 'utf8')).split('\n').filter(Boolean).map(x => JSON.parse(x)); }
    catch { /* nothing sent yet */ }
    rows = rows.filter(r => r.time.startsWith(today()));
    const byDoc = new Map();
    for (const row of rows) {
      if (!byDoc.has(row.doc)) byDoc.set(row.doc, new Map());
      byDoc.get(row.doc).set(row.owner, (byDoc.get(row.doc).get(row.owner) || 0) + row.count);
    }
    const lines = [...byDoc].map(([doc, owners]) => `**${doc}**\n${[...owners].map(([o, n]) => `- ${o}：${n} 处`).join('\n')}`);
    const text = `📊 **文档变更日报 · ${today()}**\n\n${lines.length ? lines.join('\n\n') : '今天没有文档变更通知。'}`;
    if (!dryRun) for (const name of to) await sendTo(name, text);
    return text;
  }

  // Recent delivered change batches, newest first, as prompt text for "what changed" questions.
  async function recentChanges({ days = 7, maxChars = 6000 } = {}) {
    let rows = [];
    try { rows = (await readFile(join(root, 'changes-log.jsonl'), 'utf8')).split('\n').filter(Boolean).map(x => JSON.parse(x)); }
    catch { /* no delivered batch yet */ }
    // Batches detected but still being retried for some recipients are real changes too.
    rows.push(...Object.values(await load('deliveries.json', {})).map(state => state.pending).filter(Boolean));
    rows.sort((a, b) => a.time.localeCompare(b.time));
    const since = stamp(new Date(Date.now() - days * 86400_000));
    const parts = [];
    let used = 0;
    for (const row of rows.filter(r => r.time >= since).reverse()) {
      const sections = new Map();
      for (const item of row.items || []) {
        if (!sections.has(item.section)) sections.set(item.section, []);
        sections.get(item.section).push(`${KIND_MARK[item.kind] || ''} ${item.text}`);
      }
      const body = [...sections].map(([section, lines]) => {
        const points = row.condensed?.[section || '（无标题）'];
        return `▸ ${section || '（无标题）'}\n${(points?.length ? [].concat(points) : lines.slice(0, 6)).map(x => `  ${x}`).join('\n')}`;
      }).join('\n');
      const part = `【${row.doc}】${row.time} 检测到的变更 ${wikiBase}/${row.token}\n${body}`;
      if (used + part.length > maxChars) break;
      parts.push(part); used += part.length;
    }
    return parts.join('\n\n');
  }

  const api = {
    docs,
    recentChanges,
    // Single-flight: a slow round never overlaps the next scheduled one.
    check(options = {}) {
      running ||= checkNow(options).finally(() => { running = null; });
      return running;
    },
    digest,

    // Private-chat commands for this module. Returns a reply, or null to let the Q&A bot answer.
    async handleDirectMessage(item) {
      const text = item.text.trim();
      const known = new Set([...Object.keys(mapping.owners || {}), ...(mapping.routes || []).flatMap(r => [r.owner, ...(r.cc || [])]),
        ...(mapping.leads || []), mapping.arbiter, asker, ...(config.digest?.to || []), ...admins].filter(Boolean));
      if (text.startsWith('/bind') && item.mentions?.length) return bindMentioned(item, text, known);
      const bind = text.match(/^\/bind\s+(\S+)$/);
      if (bind) {
        const name = bind[1];
        if (!known.has(name)) return `「${name}」不在文档通知的人员名单里，请检查姓名。`;
        const bindings = await load('bindings.json', {});
        if (bindings[name] && bindings[name] !== item.userId) return `「${name}」已绑定其他账号；如需更换请联系维护者${asker ? ` ${asker}` : ''}。`;
        bindings[name] = item.userId;
        await save('bindings.json', bindings);
        return `✅ 已绑定：之后「${name}」负责模块的文档变更会私聊发给你。`;
      }
      const name = await nameOf(item.userId);
      if (name && CANCEL.test(text)) {
        await save('unsubscribed.json', { ...(await load('unsubscribed.json', {})), [name]: stamp() });
        return '已取消文档更新推送，之后不会再收到通知。想恢复时发「恢复推送」。';
      }
      if (name && RESUME.test(text)) {
        const list = await load('unsubscribed.json', {});
        delete list[name];
        await save('unsubscribed.json', list);
        return '已恢复文档更新推送。';
      }
      if (name || item.userId === (await people())[asker]?.openId) return answerClarify(text, name);
      return null;
    },

    // Runs a check at every configured minute mark (default :00 and :30) and the digest once a day.
    start() {
      const minutes = config.checkMinutes || [0, 30];
      const [digestHour, digestMinute] = String(config.digest?.time || '21:00').split(':').map(Number);
      let lastSlot = '';
      let lastDigest = '';
      const tick = async () => {
        const now = new Date();
        const slot = `${today(now)} ${now.getHours()}:${now.getMinutes()}`;
        if (minutes.includes(now.getMinutes()) && slot !== lastSlot) {
          lastSlot = slot;
          try { log(`[文档监测 ${stamp(now)}]\n${await api.check()}`); }
          catch (error) { report(`[文档监测] 本轮失败：${error.message}`); }
        }
        if (config.digest?.to?.length && now.getHours() === digestHour && now.getMinutes() === digestMinute && lastDigest !== today(now)) {
          lastDigest = today(now);
          await api.digest().catch(() => report('[文档监测] 日报发送失败。'));
        }
      };
      // Check once right away so the baseline exists before the first scheduled slot.
      api.check().then(result => log(`[文档监测 ${stamp()}] 启动检查
${result}`)).catch(error => report(`[文档监测] 启动检查失败：${error.message}`));
      const timer = setInterval(tick, 20_000);
      timer.unref?.();
      return () => clearInterval(timer);
    },
  };
  return api;
}
