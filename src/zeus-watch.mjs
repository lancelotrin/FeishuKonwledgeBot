// Zeus hotfix reminders: the Zeus system posts "Zeus热更系统提醒" cards into the build group through a
// webhook bot. Feishu does not push other bots' messages to this app as events, so the group is polled;
// each new reminder gets a reply that @mentions everyone. The card body is not readable through the API
// (it comes back as "请升级至最新版本客户端"), so the reply quotes the original card instead of copying it.
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

// The card title decides: the same webhook bot also posts build failure/success cards, so the sender alone
// is not enough. senderId only narrows the match further when set.
export function isZeusReminder(message, { senderId = '', title = 'Zeus热更系统提醒' } = {}) {
  if (message?.sender?.sender_type !== 'app' || message.deleted || !title) return false;
  if (senderId && message.sender.id !== senderId) return false;
  let card = {};
  try { card = JSON.parse(message.body?.content || '{}'); } catch { return false; }
  return String(card.title || '').includes(title);
}

export function createZeusWatcher({ request, reply, resolveChat, stateFile, senderId = '', title = 'Zeus热更系统提醒',
  text = '请留意上面的 Zeus 热更系统提醒，及时登录 Zeus 热更后台发布正式版本。', intervalMs = 30_000, report = () => {}, log = () => {} }) {
  let running = null;

  async function checkNow() {
    const chat = await resolveChat();
    if (!chat) return 0;
    const body = await request('GET', '/open-apis/im/v1/messages',
      { container_id_type: 'chat', container_id: chat, sort_type: 'ByCreateTimeDesc', page_size: 20 });
    if (body?.code !== 0) { report(`[Zeus 提醒] 读取群消息失败（错误码 ${body?.code}）。`); return 0; }
    const items = body.data?.items || [];
    const state = await readJson(stateFile, null);
    const newest = Math.max(0, ...items.map(m => Number(m.create_time) || 0));
    // First run: only remember where we are, so old reminders are not re-announced.
    if (!state?.lastSeen || state.chat !== chat) { await writeJson(stateFile, { chat, lastSeen: newest || Date.now() }); return 0; }
    const fresh = items.filter(m => Number(m.create_time) > state.lastSeen && isZeusReminder(m, { senderId, title }))
      .sort((a, b) => Number(a.create_time) - Number(b.create_time));
    let lastSeen = Math.max(state.lastSeen, newest);
    let sent = 0;
    for (const message of fresh) {
      const code = await reply(message.message_id, text).catch(() => -1);
      if (code === 0) { sent++; log(`[Zeus 提醒] 已在群里 @所有人（${new Date(Number(message.create_time)).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} 的提醒）`); }
      else {
        report(`[Zeus 提醒] @所有人 失败（错误码 ${code}），下一轮重试；若一直失败请检查群设置是否允许机器人 @所有人。`);
        lastSeen = Number(message.create_time) - 1; // retry this one (and later ones) next round
        break;
      }
    }
    await writeJson(stateFile, { chat, lastSeen });
    return sent;
  }

  return {
    check() {
      running ||= checkNow().catch(error => { report(`[Zeus 提醒] 检查失败：${error.message}`); return 0; }).finally(() => { running = null; });
      return running;
    },
    start() {
      this.check();
      const timer = setInterval(() => this.check(), intervalMs);
      timer.unref?.();
      return () => clearInterval(timer);
    },
  };
}
