import * as lark from '@larksuiteoapi/node-sdk';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readConfig } from './src/config.mjs';
import { askAI, createHandler, formatGroupHistory } from './src/core.mjs';
import { createLocalGroupContextStore } from './src/local-group-context.mjs';
import { createProjectReader } from './src/project-knowledge.mjs';
import { createWikiKnowledgeBase } from './src/wiki-kb.mjs';
import { createRouter } from './src/routing.mjs';

async function main() {
  let config;
  try { config = readConfig(process.env); }
  catch (error) {
    console.error(error.code === 'ENOENT' ? '缺少 bot.config.json：请复制 bot.config.example.json 并按需修改。' : error.message);
    process.exitCode = 1;
    return;
  }
  let loadProjectContext;
  try { loadProjectContext = await createProjectReader(config.projects); }
  catch (error) { console.error(error.message); process.exitCode = 1; return; }
  if (process.argv.includes('--check')) {
    console.log(`配置检查通过：${config.projects.length} 个项目目录，${config.wikiSources.length} 个知识库来源，模型 ${config.model}（未连接飞书或 AI）。`);
    return;
  }

  // Never print raw SDK errors: they may include HTTP authorization headers.
  const logger = {
    error: () => console.error('[飞书 SDK] 请求或连接异常，请检查凭证、权限和网络。'),
    warn: () => console.warn('[飞书 SDK] 连接警告，SDK 将按其策略重试。'),
    info: () => {}, debug: () => {}, trace: () => {},
  };
  const options = { appId: config.appId, appSecret: config.appSecret, logger };
  const client = new lark.Client(options);
  const request = (method, url, params, data) => client.request({ method, url, params, data }).catch(error => error?.response?.data || { code: -1 });
  const result = await client.request({ method: 'GET', url: '/open-apis/bot/v3/info' });
  if (result.code !== 0 || !result.bot?.open_id) throw new Error('无法获取机器人信息');
  const botId = result.bot.open_id;

  const wiki = createWikiKnowledgeBase({ request, sources: config.wikiSources, cacheDir: join(config.dataDir, 'wiki'),
    maxDocs: config.wikiMaxDocs, report: message => console.error(message) });
  console.log(`已加载本地知识库缓存 ${await wiki.loadCache()} 篇。`);
  if (process.argv.includes('--sync')) {
    const summary = await wiki.sync();
    console.log(`知识库同步${summary.complete ? '完成' : '部分完成'}：共 ${summary.documents} 篇，本次更新 ${summary.fetched} 篇。`);
    const probe = process.argv[process.argv.indexOf('--sync') + 1];
    if (probe && !probe.startsWith('--')) for (const doc of wiki.search(probe).docs) console.log(`  命中：${doc.path.join(' / ')}`);
    return;
  }
  const syncWiki = async () => {
    const started = Date.now();
    const summary = await wiki.sync();
    console.log(`[知识库] 同步完成：${summary.documents} 篇，更新 ${summary.fetched} 篇，用时 ${Math.round((Date.now() - started) / 1000)} 秒。`);
    return summary;
  };
  if (config.wikiSources.length) {
    syncWiki().catch(() => console.error('[知识库] 首次同步失败，将使用本地缓存。'));
    if (config.wikiSyncMinutes) setInterval(() => syncWiki().catch(() => {}), config.wikiSyncMinutes * 60_000).unref();
  }

  const names = new Map();
  const router = createRouter({ ...config.routing,
    resolveEmails: async emails => {
      const body = await request('POST', '/open-apis/contact/v3/users/batch_get_id', { user_id_type: 'open_id' }, { emails });
      return Object.fromEntries((body.data?.user_list || []).filter(u => u.user_id).map(u => [u.email, u.user_id]));
    },
    lookupName: async openId => {
      if (!names.has(openId)) {
        const body = await request('GET', `/open-apis/contact/v3/users/${openId}`, { user_id_type: 'open_id' });
        names.set(openId, body.data?.user?.name || '');
      }
      return names.get(openId);
    },
  });

  const groupDocuments = createLocalGroupContextStore(join(config.dataDir, 'group-context'));
  const handler = createHandler({
    botId, system: config.system, historyLimit: config.historyLimit, router,
    ask: messages => askAI(config, messages),
    react: item => config.ackEmoji
      ? client.im.messageReaction.create({ path: { message_id: item.id }, data: { reaction_type: { emoji_type: config.ackEmoji } } })
      : Promise.resolve(),
    loadHistory: async (item, limit) => {
      const response = await client.im.message.list({ params: {
        container_id_type: 'chat', container_id: item.chatId,
        sort_type: 'ByCreateTimeDesc', page_size: Math.min(limit + 1, 50), with_sender_name: true,
      } });
      if (response.code !== 0) throw new Error('读取群历史消息失败');
      return formatGroupHistory(response.data?.items, item.id, limit, botId);
    },
    loadGroupContext: item => groupDocuments.read(item.chatId, item.text),
    saveGroupTurn: (item, answer) => groupDocuments.append(item, answer),
    resetGroupContext: item => groupDocuments.reset(item.chatId),
    searchWiki: query => wiki.search(query),
    readLinked: text => wiki.readLinked(text),
    loadProjectContext,
    syncWiki,
    status: () => {
      const { documents, lastSync } = wiki.status;
      return `知识库：${documents} 篇，最近同步 ${lastSync ? lastSync.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '尚未完成'}。\n项目目录：${config.projects.map(p => p.name).join('、') || '无'}。\n模型：${config.model}。`;
    },
    send: async (item, content, index) => {
      const uuid = createHash('sha256').update(`${item.id}:${index}`).digest('hex').slice(0, 32);
      const reply = await client.im.message.reply({
        path: { message_id: item.id },
        data: { msg_type: 'post', content, uuid, reply_in_thread: Boolean(item.threadId) },
      });
      if (reply.code !== 0) throw new Error('发送失败');
    },
    sendDirect: async (openId, content) => {
      const sent = await client.im.message.create({ params: { receive_id_type: 'open_id' },
        data: { receive_id: openId, msg_type: 'post', content } });
      if (sent.code !== 0) throw new Error('私信失败');
    },
    report: message => console.error(message),
  });

  const ws = new lark.WSClient(options);
  ws.start({ eventDispatcher: new lark.EventDispatcher({ logger }).register({
    'im.message.receive_v1': event => { handler.accept(event); },
  }) });
  console.log('飞书凭证验证成功，长连接已启动。私聊或在群内 @机器人 提问；/help 查看指令。');
  console.log('关闭窗口或按 Ctrl+C 停止；请保持电脑联网且不休眠。');
}

main().catch(() => {
  console.error('启动失败：请检查 .env 配置、飞书机器人能力和发布状态，以及网络连接。');
  process.exitCode = 1;
});
