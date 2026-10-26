// Build-failure notifications sent by this bot's app (instead of the build machines' webhook bot):
// a red card in the build group that @mentions whoever triggered the build.
// The trigger arrives as TRIDENT's numeric BUILD_USER; trident-users.json maps it to a person
// ({ "3416": { "name": "葛相麟", "openId": "ou_…" } }), maintained by hand and by `/trident <id>`.
// The open_id may also be found by name in the bot's other bindings (doc-watch /bind, /openid).
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
}
async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await rename(`${path}.tmp`, path);
}

const META_LABELS = [['pipeline', '管线'], ['branch', '分支'], ['version', '版本'], ['flow', '流程'], ['packageBuildType', '类型'], ['hotfixChannel', '热更渠道'], ['buildUser', '触发人ID'], ['defines', '宏']];

export function buildFailureCard(payload, analysis, person) {
  const meta = payload?.meta && typeof payload.meta === 'object' ? payload.meta : {};
  const at = person?.openId ? `<at id=${person.openId}></at>` : '<at id=all></at>';
  const job = meta.jobName ? `流水线：${meta.jobName}${meta.buildNumber ? ` #${meta.buildNumber}` : ''}` : '';
  // An unknown trigger is shown as 旅行者; the numeric TRIDENT ID is listed with the build info (触发人ID).
  const trigger = `触发人：${person?.name || '旅行者'}`;
  const lines = [
    `${at} 原因：${String(payload?.reason || '未知原因').slice(0, 500)}`,
    trigger, job,
    ...META_LABELS.filter(([key]) => meta[key]).map(([key, label]) => `${label}：${String(meta[key]).slice(0, 200)}`),
  ].filter(Boolean);
  const content = lines.join('\n') + (analysis ? `\n\n**AI 报错分析**\n${analysis}` : '\n\n（AI 分析暂不可用，请查看打包日志）');
  return {
    config: { wide_screen_mode: true },
    header: { template: 'red', title: { tag: 'plain_text', content: '打包失败' } },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content } }],
  };
}

// Success cards (APK / Patch / HybridCLR) arrive as the build machine's finished webhook card; this adds
// the trigger line and @mention to its first text block. Unknown triggers are 旅行者 without @all.
export function withTrigger(card, person) {
  const copy = JSON.parse(JSON.stringify(card || {}));
  const elements = Array.isArray(copy.elements) ? copy.elements : (copy.elements = []);
  const line = `${person?.openId ? `<at id=${person.openId}></at> ` : ''}触发人：${person?.name || '旅行者'}`;
  const block = elements.find(el => el?.tag === 'div' && el.text?.tag === 'lark_md');
  if (block) block.text.content = `${line}\n${block.text.content || ''}`;
  else elements.unshift({ tag: 'div', text: { tag: 'lark_md', content: line } });
  return copy;
}

export function createCicdNotifier({ request, sendCard, chatName = '', chatId = '', stateFile, usersFile, nameSources = [], report = () => {} }) {
  let cachedChat = chatId;

  async function resolveChat() {
    if (cachedChat) return cachedChat;
    const saved = (await readJson(stateFile, {})).chatId;
    if (saved) return (cachedChat = saved);
    if (!chatName) return '';
    // Looking the group up by name needs im:chat:readonly; without it, use `/打包群` in the group.
    let pageToken = '';
    do {
      const body = await request('GET', '/open-apis/im/v1/chats', { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) });
      if (body?.code !== 0) { report(`[CICD 通知] 按群名查找「${chatName}」失败（错误码 ${body?.code}）：请在该群 @机器人 发送 /打包群，或开通 im:chat:readonly。`); return ''; }
      const hit = (body.data?.items || []).find(chat => chat.name === chatName);
      if (hit) { await writeJson(stateFile, { chatId: hit.chat_id, name: chatName }); return (cachedChat = hit.chat_id); }
      pageToken = body.data?.has_more ? body.data.page_token : '';
    } while (pageToken);
    report(`[CICD 通知] 机器人所在的群里没有「${chatName}」：请把航海士 Nami 拉进该群。`);
    return '';
  }

  async function resolvePerson(buildUser) {
    if (!buildUser) return null;
    const users = await readJson(usersFile, {});
    const entry = users[String(buildUser)] || {};
    if (entry.openId) return { name: entry.name || '', openId: entry.openId };
    if (!entry.name) return { name: '', openId: '' };
    for (const source of nameSources) {
      const openId = await source(entry.name).catch(() => '');
      if (openId) return { name: entry.name, openId };
    }
    // Last resort: the build group's own member list (people who never talked to the bot are found here too).
    const member = (await groupMembers().catch(() => [])).find(m => m.name === entry.name);
    return { name: entry.name, openId: member?.member_id || '' };
  }

  let membersCache = { at: 0, chat: '', items: [] };
  async function groupMembers() {
    const chat = await resolveChat();
    if (!chat) return [];
    if (membersCache.chat === chat && Date.now() - membersCache.at < 10 * 60_000) return membersCache.items;
    const items = [];
    let pageToken = '';
    do {
      const body = await request('GET', `/open-apis/im/v1/chats/${chat}/members`,
        { member_id_type: 'open_id', page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) });
      if (body?.code !== 0) return [];
      items.push(...(body.data?.items || []));
      pageToken = body.data?.has_more ? body.data.page_token : '';
    } while (pageToken);
    membersCache = { at: Date.now(), chat, items };
    return items;
  }

  return {
    resolveChat,
    resolvePerson,

    // Sends the failure card; returns true only when Feishu accepted it.
    async notify(payload, analysis) {
      const chat = await resolveChat();
      if (!chat) return false;
      const person = await resolvePerson(payload?.meta?.buildUser).catch(() => null);
      const card = buildFailureCard(payload, analysis, person);
      const code = await sendCard(chat, card).catch(() => -1);
      if (code !== 0) report(`[CICD 通知] 发送失败卡片失败（错误码 ${code}），打包机将改用 webhook 发送。`);
      return code === 0;
    },

    // Success notifications: { webhook: <the build machine's webhook payload>, meta: { buildUser, … } }.
    async notifyCard(body) {
      const card = body?.webhook?.card || body?.card;
      if (!card || typeof card !== 'object') return false;
      const chat = await resolveChat();
      if (!chat) return false;
      const person = await resolvePerson(body?.meta?.buildUser).catch(() => null);
      const code = await sendCard(chat, withTrigger(card, person)).catch(() => -1);
      if (code !== 0) report(`[CICD 通知] 发送打包结果卡片失败（错误码 ${code}），打包机将改用 webhook 发送。`);
      return code === 0;
    },

    // `/打包群` in a group: use that group for build-failure cards. `/trident <id>` in any chat: bind the sender.
    async handleCommand(item) {
      const text = item.text.trim();
      if (text === '/打包群') {
        if (item.chatType !== 'group') return '请在要接收打包失败通知的群里 @我 发送 /打包群。';
        await writeJson(stateFile, { chatId: item.chatId, setBy: item.userName || item.userId, at: new Date().toISOString() });
        cachedChat = item.chatId;
        return '✅ 已设置：之后的打包失败通知会由我发到这个群，并 @ 触发打包的人。';
      }
      const bind = text.match(/^\/trident\s+(\d+)$/i);
      if (bind) {
        const users = await readJson(usersFile, {});
        const id = bind[1];
        const old = users[id] || {};
        if (old.openId && old.openId !== item.userId) return `TRIDENT ID ${id} 已绑定其他人（${old.name || '未知'}），如需更改请联系维护者修改 trident-users.json。`;
        users[id] = { ...old, name: old.name || item.userName || '', openId: item.userId };
        await writeJson(usersFile, users);
        return `✅ 已绑定 TRIDENT ID ${id}${users[id].name ? `（${users[id].name}）` : ''}：之后你触发的打包失败时，我会在打包群里 @ 你。`;
      }
      return null;
    },
  };
}
