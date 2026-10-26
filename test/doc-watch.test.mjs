import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { flattenBlocks, diffDocs } from '../src/doc-watch/blocks.mjs';
import { summarize } from '../src/doc-watch/summary.mjs';
import { attribute, routeOptions } from '../src/doc-watch/attribution.mjs';
import { createDocWatcher, parseDocSource, asksAboutChanges } from '../src/doc-watch/index.mjs';

const text = (id, content, type = 2, children = []) => ({ block_id: id, block_type: type,
  [type === 2 ? 'text' : `heading${type - 2}`]: { elements: [{ text_run: { content } }] }, children });
const page = children => ({ block_id: 'doc', block_type: 1, children });

const mapping = {
  routes: [
    { key: 'battle', name: '战斗', owner: '殷琦', keywords: ['技能', '普攻'], exclude: ['怪物'] },
    { key: 'level', name: '关卡', owner: '万汩', keywords: ['关卡', '怪物'] },
    { key: 'art', name: '美术', owner: '张琪', keywords: ['icon', '图标'] },
  ],
  topics: [{ name: '战力', keywords: ['战力'], owners: ['张天佑', '殷琦'] }],
  character_rules: { content_words: ['动作'], monsters: ['阿金'], playable: ['路飞'] },
  owners: { 殷琦: { open_id: 'ou_other_app', role: '战斗组长' }, 万汩: {}, 张琪: {}, 张天佑: {}, 韩霄: {}, 宋子由: {} },
  leads: ['张天佑'], arbiter: '韩霄',
};

test('blocks: flattened in order with headings; diff finds added, changed, removed with section paths', () => {
  const v1 = flattenBlocks([page(['h', 'a', 'b']), text('h', '10月20日', 3), text('a', '路飞技能A'), text('b', '旧内容')], 'doc');
  assert.deepEqual(v1.map(b => [b.id, b.level, b.text]), [['h', 1, '10月20日'], ['a', 0, '路飞技能A'], ['b', 0, '旧内容']]);
  const v2 = flattenBlocks([page(['h', 'a', 'c']), text('h', '10月20日', 3), text('a', '路飞技能A改'), text('c', '新增怪物')], 'doc');
  const changes = diffDocs({ blocks: v1 }, { blocks: v2 });
  assert.deepEqual(changes.added.map(x => [x.text, x.section]), [['新增怪物', '10月20日']]);
  assert.deepEqual(changes.changed.map(x => [x.text, x.oldText]), [['路飞技能A改', '路飞技能A']]);
  assert.deepEqual(changes.removed.map(x => x.text), ['旧内容']);
  assert.equal(diffDocs(null, { blocks: v2 }).firstRun, true);
  assert.match(summarize(changes), /▸ 10月20日\n   ＋ 新增怪物\n   ～ 路飞技能A改\n   － 旧内容/);
  assert.match(summarize({ added: [{ text: 'a.png', section: 's' }], changed: [], removed: [] }), /另有 1 个附件/);
});

test('attribution: learned > topics > model > keywords, with exclusions and character rules', () => {
  assert.deepEqual(attribute({ section: 's', text: '技能icon' }, mapping).keys, ['battle', 'art']);
  assert.deepEqual(attribute({ section: 's', text: '怪物技能' }, mapping).keys, ['level']); // battle excluded by 怪物
  assert.deepEqual(attribute({ section: '', text: '阿金待机动作' }, mapping).keys, ['level']);
  assert.deepEqual(attribute({ section: '', text: '路飞普攻动作' }, mapping).keys, ['battle']);
  assert.deepEqual(attribute({ section: 's', text: '技能', modelRoutes: ['art'] }, mapping).keys, ['art']);
  assert.deepEqual(attribute({ section: 's', text: '战力调整' }, mapping).people, ['张天佑', '殷琦']);
  assert.deepEqual(attribute({ section: 's', text: '技能' }, mapping, { s: ['level'] }).keys, ['level']);
  assert.deepEqual(routeOptions(mapping).map(o => `${o.digit}${o.name}`), ['1战斗', '2关卡', '3美术']);
  assert.deepEqual(parseDocSource({ url: 'https://x.feishu.cn/wiki/BE3Fwb3q5ieqUAkcxRhcqDTjnxf' }).token, 'BE3Fwb3q5ieqUAkcxRhcqDTjnxf');
});

test('attribution: feature planners are added on top of module owners; a feature alone picks its module', () => {
  const withFeatures = { ...mapping, features: [
    { name: 'SR 罗宾 角色设计', route: 'battle', owner: '祝宽圻', keywords: ['罗宾'], exclude: ['罗宾汉'] },
    { name: '月卡', route: 'level', owner: '张洋滔', keywords: ['月卡'] },
  ] };
  const both = attribute({ section: 's', text: '罗宾技能调整' }, withFeatures);
  assert.deepEqual(both.keys, ['battle']);
  assert.deepEqual(both.people, ['祝宽圻']);
  assert.match(both.via, /功能「SR 罗宾 角色设计」/);
  assert.deepEqual(attribute({ section: 's', text: '月卡价格' }, withFeatures).keys, ['level']); // no module keyword
  assert.deepEqual(attribute({ section: 's', text: '技能' }, withFeatures).people, []);
  assert.deepEqual(attribute({ section: 's', text: '罗宾汉技能' }, withFeatures).people, []); // excluded
  // Several features in one change: every planner is notified, no cap.
  const many = { ...mapping, features: ['图鉴', '材料本', '商店', '月卡'].map((k, n) => ({ name: k, route: 'level', owner: `策划${n}`, keywords: [k] })) };
  assert.deepEqual(attribute({ section: 's', text: '图鉴、材料本、商店、月卡 UI 通过监修' }, many).people, ['策划0', '策划1', '策划2', '策划3']);
});

function fakeFeishu() {
  const state = { edit: 1000, blocks: [page(['h', 'a']), text('h', '10月20日', 3), text('a', '路飞技能A')], sent: [], failFor: new Set() };
  const request = async (method, url) => {
    if (url.endsWith('/get_node')) return { code: 0, data: { node: { title: '监修反馈', obj_token: 'doc', obj_edit_time: String(state.edit) } } };
    if (url.endsWith('/blocks')) return { code: 0, data: { items: state.blocks, has_more: false } };
    return { code: 404 };
  };
  const send = async (openId, content) => {
    if (state.failFor.has(openId)) return { code: 230013 };
    state.sent.push({ openId, text: JSON.parse(content).zh_cn.content[0][0].text });
    return { code: 0 };
  };
  return { state, request, send };
}

test('watcher: baseline first, notifies owners, debounces, and keeps the baseline when a send fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'watch-'));
  const { state, request, send } = fakeFeishu();
  const watcher = createDocWatcher({ request, send, mapping, dataDir: dir, log: () => {},
    config: { docs: [{ name: '监修', wikiToken: 'BE3Fwb3q5ieqUAkcxRhcqDTjnxf' }], staleMinutes: 10, clarify: { enabled: true, asker: '张天佑' } } });
  assert.match(await watcher.check(), /首次运行，建立基线/);
  assert.equal(state.sent.length, 0);
  assert.match(await watcher.check(), /无变更/);

  // Recent edit: wait for the author to finish.
  state.edit = Math.floor(Date.now() / 1000);
  state.blocks = [page(['h', 'a', 'c']), text('h', '10月20日', 3), text('a', '路飞技能A'), text('c', '技能icon重做')];
  assert.match(await watcher.check(), /刚编辑过/);

  // People bind themselves because mapping open_ids belong to another app.
  assert.match(await watcher.handleDirectMessage({ userId: 'ou_yin', text: '/bind 殷琦' }), /已绑定/);
  assert.match(await watcher.handleDirectMessage({ userId: 'ou_x', text: '/bind 殷琦' }), /已绑定其他账号/);
  await watcher.handleDirectMessage({ userId: 'ou_zq', text: '/bind 张琪' });
  state.edit = 1000 + 1; // edited long ago
  state.failFor.add('ou_zq');
  let report = await watcher.check();
  assert.match(report, /殷琦：OK/);
  assert.match(report, /张琪：ERR 230013/);
  assert.match(report, /基线不推进/);
  assert.match(state.sent[0].text, /\*\*📌 监修反馈\*\*\n殷琦（战斗组长） · 你负责的部分有更新（新增 1）[\s\S]*- ＋ 技能icon重做/);

  state.failFor.clear();
  report = await watcher.check(); // retried because the baseline did not advance
  assert.match(report, /张琪：OK/);
  assert.match(report, /殷琦：SKIP：这批变更已发过/); // already delivered: not sent twice
  assert.match(await watcher.check(), /无变更/);
  const log = (await readFile(join(dir, 'notify-log.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(log.length, 2);
  assert.equal(state.sent.filter(s => s.openId === 'ou_yin').length, 1);
  const changes = await watcher.recentChanges();
  assert.match(changes, /【监修反馈】.*检测到的变更 https:\/\/rcnc3bm8lc5c\.feishu\.cn\/wiki\/BE3Fwb3q5ieqUAkcxRhcqDTjnxf\n▸ 10月20日\n  ＋ 技能icon重做/);
});

test('watcher: a recipient who keeps failing stops blocking the baseline after 6 rounds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'watch-'));
  const { state, request, send } = fakeFeishu();
  const reports = [];
  const watcher = createDocWatcher({ request, send, mapping, dataDir: dir, log: () => {}, report: m => reports.push(m),
    config: { docs: ['https://x.feishu.cn/wiki/BE3Fwb3q5ieqUAkcxRhcqDTjnxf'], staleMinutes: 0, clarify: { enabled: false } } });
  await watcher.check();
  await watcher.handleDirectMessage({ userId: 'ou_yin', text: '/bind 殷琦' });
  await watcher.handleDirectMessage({ userId: 'ou_zq', text: '/bind 张琪' });
  state.failFor.add('ou_zq');
  state.edit++;
  state.blocks = [page(['h', 'a', 'c']), text('h', '10月20日', 3), text('a', '路飞技能A'), text('c', '技能icon重做')];
  for (let round = 1; round < 6; round++) assert.match(await watcher.check(), /下轮只重发给失败的人/);
  assert.match(await watcher.recentChanges(), /【监修反馈】[\s\S]*＋ 技能icon重做/); // pending batches are already answerable
  assert.match(await watcher.check(), /已放弃重试并推进基线/);
  assert.match(await watcher.check(), /无变更/);
  assert.equal(state.sent.filter(s => s.openId === 'ou_yin').length, 1); // never repeated
  assert.match(reports.join('\n'), /张琪 ERR 230013/);
});

test('watcher: an open_id from another app (99992361) is reported but does not hold back the baseline', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'watch-'));
  const { state, request, send: base } = fakeFeishu();
  const send = async (openId, content) => openId === 'ou_other_app' ? { code: 99992361 } : base(openId, content);
  const watcher = createDocWatcher({ request, send, mapping, dataDir: dir, log: () => {},
    config: { docs: ['https://x.feishu.cn/wiki/BE3Fwb3q5ieqUAkcxRhcqDTjnxf'], staleMinutes: 0, clarify: { enabled: false } } });
  await watcher.check();
  state.edit++;
  state.blocks = [page(['h', 'a', 'c']), text('h', '10月20日', 3), text('a', '路飞技能A'), text('c', '技能icon重做')];
  const report = await watcher.check(); // 殷琦 is unbound: the mapping's open_id belongs to another app
  assert.match(report, /殷琦：SKIP：殷琦 的 open_id 属于其他应用/);
  assert.doesNotMatch(report, /基线不推进/);
  assert.match(await watcher.check(), /无变更/);
});

test('change questions: only "what changed" questions about watched documents use the change log', () => {
  assert.equal(asksAboutChanges('监修文档刚改了什么内容最新的', '监修文档刚改了什么内容最新的'), true);
  assert.equal(asksAboutChanges('最近有什么更新', '最近有什么更新\n📌 每周监修会议题', ['每周监修会议题']), true);
  assert.equal(asksAboutChanges('监修视频怎么录', '监修视频怎么录'), false);
  assert.equal(asksAboutChanges('背景图改了什么', '背景图改了什么'), false);
});

test('watcher: each section is condensed into short Chinese lines; model failure falls back to the paragraph list', async () => {
  for (const broken of [false, true]) {
    const dir = await mkdtemp(join(tmpdir(), 'watch-'));
    const { state, request, send } = fakeFeishu();
    const ask = async messages => {
      if (messages[0].content.includes('精炼成简体中文要点')) {
        if (broken) throw new Error('model down');
        const rows = JSON.parse(messages[1].content);
        assert.deepEqual(rows, [{ i: 0, section: '10月20日', changes: ['新增：TA：装備を飾るという意図は理解しました', '新增：技能中文反馈'] }]);
        return '[{"i":0,"lines":["日方认可装饰装备思路，要求背景不突兀","请确认技能反馈"]}]';
      }
      if (messages[0].content.includes('分诊')) return '[{"i":0,"modules":["battle"]},{"i":1,"modules":["battle"]}]';
      return '技能反馈有更新';
    };
    const watcher = createDocWatcher({ request, send, ask, mapping, dataDir: dir, log: () => {},
      config: { docs: ['https://x.feishu.cn/wiki/BE3Fwb3q5ieqUAkcxRhcqDTjnxf'], staleMinutes: 0, clarify: { enabled: false } } });
    await watcher.check();
    await watcher.handleDirectMessage({ userId: 'ou_yin', text: '/bind 殷琦' });
    state.edit++;
    state.blocks = [page(['h', 'a', 'c', 'd']), text('h', '10月20日', 3), text('a', '路飞技能A'),
      text('c', 'TA：装備を飾るという意図は理解しました'), text('d', '技能中文反馈')];
    await watcher.check();
    const message = state.sent.find(s => s.openId === 'ou_yin').text;
    if (broken) {
      assert.match(message, /- ＋ TA：装備を飾る[\s\S]*- ＋ 技能中文反馈/);
      assert.doesNotMatch(message, /AI 精炼/);
    } else {
      assert.match(message, /\*\*▸ 10月20日\*\*\n- ＋ 日方认可装饰装备思路，要求背景不突兀\n- ＋ 请确认技能反馈\n（以上由 AI 精炼/);
      assert.doesNotMatch(message, /装備|技能中文反馈/);
    }
  }
});

test('watcher: unmatched changes are asked, a numbered reply is learned and forwarded; conflicts escalate', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'watch-'));
  const { state, request, send } = fakeFeishu();
  const watcher = createDocWatcher({ request, send, mapping, dataDir: dir, log: () => {},
    config: { docs: ['https://x.feishu.cn/wiki/BE3Fwb3q5ieqUAkcxRhcqDTjnxf'], staleMinutes: 0, clarify: { enabled: true, asker: '张天佑' } } });
  await watcher.check();
  for (const [name, id] of [['张天佑', 'ou_zty'], ['万汩', 'ou_wg'], ['张琪', 'ou_zq'], ['韩霄', 'ou_hx']]) await watcher.handleDirectMessage({ userId: id, text: `/bind ${name}` });
  state.edit++;
  state.blocks = [page(['h', 'a', 'c']), text('h', '10月20日', 3), text('a', '路飞技能A'), text('c', '海报文案待定')];
  await watcher.check();
  assert.equal(state.sent.length, 1);
  assert.equal(state.sent[0].openId, 'ou_zty');
  assert.match(state.sent[0].text, /看不出该归谁[\s\S]*1 战斗\n2 关卡\n3 美术/);

  assert.equal(await watcher.handleDirectMessage({ userId: 'ou_zty', text: '这个之后再说' }), null); // ordinary text goes to Q&A
  assert.match(await watcher.handleDirectMessage({ userId: 'ou_zty', text: '2,3' }), /记住了：「10月20日」→ 关卡、美术[\s\S]*已补发给：万汩、张琪/);
  assert.deepEqual(state.sent.slice(-2).map(x => x.openId), ['ou_wg', 'ou_zq']);

  // The same section later gets a different answer: not overwritten, escalated to the arbiter.
  state.edit++;
  state.blocks.push(text('d', '再来一条无关键词内容'));
  state.blocks[0].children.push('d');
  await watcher.check(); // learned rule routes it now, so no new question
  assert.ok(!state.sent.slice(-2).some(x => /看不出/.test(x.text)));

  assert.match(await watcher.handleDirectMessage({ userId: 'ou_wg', text: '取消推送' }), /已取消/);
  state.edit++;
  state.blocks.push(text('e', '关卡流程调整'));
  state.blocks[0].children.push('e');
  assert.match(await watcher.check(), /万汩：SKIP：已取消推送/);
  assert.match(await watcher.handleDirectMessage({ userId: 'ou_wg', text: '恢复推送' }), /已恢复/);
});

test('watcher: conflicting clarification answers go to the arbiter', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'watch-'));
  const { state, request, send } = fakeFeishu();
  const watcher = createDocWatcher({ request, send, mapping, dataDir: dir, log: () => {},
    config: { docs: [{ wikiToken: 'BE3Fwb3q5ieqUAkcxRhcqDTjnxf' }], staleMinutes: 0, clarify: { enabled: true, asker: '张天佑' } } });
  await watcher.check();
  for (const [name, id] of [['张天佑', 'ou_zty'], ['韩霄', 'ou_hx']]) await watcher.handleDirectMessage({ userId: id, text: `/bind ${name}` });
  for (const [n, answer, expected] of [[1, '2', /记住了/], [2, '1', /不一致[\s\S]*已转给韩霄/]]) {
    state.edit++;
    state.blocks = [page(['h', `x${n}`]), text('h', '10月20日', 3), text(`x${n}`, `无关键词内容${n}`)];
    // Clear the learned rule's effect for the second round by using a fresh pending question.
    if (n === 2) await import('node:fs/promises').then(fs => fs.writeFile(join(dir, 'pending.json'), JSON.stringify({ '10月20日': { docTitle: 'd', text: 't', link: 'l', askedAt: '2099' } })));
    else await watcher.check();
    assert.match(await watcher.handleDirectMessage({ userId: 'ou_zty', text: answer }), expected);
  }
  assert.ok(state.sent.some(x => x.openId === 'ou_hx' && /需要你定一下/.test(x.text)));
});

test('admin batch binding: @mentions in a group bind other people, aliases fix display-name mismatches', async () => {
  const { createHandler } = await import('../src/core.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'watch-'));
  const { request, send } = fakeFeishu();
  const watcher = createDocWatcher({ request, send, mapping, dataDir: dir, log: () => {},
    config: { docs: [], admins: ['葛相麟'], clarify: { asker: '张天佑' }, digest: { to: ['严梦楠'] } } });
  const replies = [];
  const h = createHandler({ botId: 'bot', system: 's', ask: async () => 'QA', handleDirect: item => watcher.handleDirectMessage(item),
    send: async (_, content) => replies.push(JSON.parse(content).zh_cn.content[0][0].text) });
  const groupMessage = (id, sender, text, mentions) => ({
    sender: { sender_type: 'user', sender_id: { open_id: sender } },
    message: { message_id: id, chat_id: 'g', chat_type: 'group', message_type: 'text', content: JSON.stringify({ text }),
      mentions: [{ key: '@_user_0', name: 'Bot', id: { open_id: 'bot' } }, ...mentions] },
  });
  const people = [['殷琦', 'ou_yq'], ['宋自由', 'ou_szy'], ['路人', 'ou_lr']].map(([name, id], n) => ({ key: `@_user_${n + 1}`, name, id: { open_id: id } }));

  h.accept(groupMessage('1', 'ou_gxl', '@_user_0 /bind @_user_1', people)); await h.drain();
  assert.match(replies.at(-1), /只有管理员/);
  h.accept({ sender: { sender_type: 'user', sender_id: { open_id: 'ou_gxl' } }, message: { message_id: '2', chat_id: 'p', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: '/bind 葛相麟' }) } });
  await h.drain();
  assert.match(replies.at(-1), /已绑定/);
  h.accept(groupMessage('3', 'ou_gxl', '@_user_0 /bind @_user_1 宋子由 @_user_2 @_user_3', people)); await h.drain();
  assert.match(replies.at(-1), /✅ 已绑定 2 人：殷琦、宋子由 → 宋自由\n⚠️ 未绑定：路人（不在人员名单里/);
  assert.match(replies.at(-1), /还没绑定：.*严梦楠/);
  const bindings = JSON.parse(await readFile(join(dir, 'bindings.json'), 'utf8'));
  assert.deepEqual(bindings, { 葛相麟: 'ou_gxl', 殷琦: 'ou_yq', 宋子由: 'ou_szy' });
});

test('admin batch binding matches roster names inside decorated display names', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'watch-'));
  const { request, send } = fakeFeishu();
  const roster = { ...mapping, owners: { ...mapping.owners, 苏敬袁: {}, 王宏钢: {}, 张海鹏: {}, 朱辉: {} } };
  const watcher = createDocWatcher({ request, send, mapping: roster, dataDir: dir, log: () => {}, config: { docs: [], admins: ['葛相麟'] } });
  await watcher.handleDirectMessage({ userId: 'ou_gxl', text: '/bind 葛相麟' });
  const mentions = [['阿飞（苏敬袁）', 'ou_1'], ['王宏钢（Coke）', 'ou_2'], ['张海鹏', 'ou_3'], ['朱辉（阿辉）', 'ou_4']].map(([name, openId]) => ({ name, openId }));
  const reply = await watcher.handleDirectMessage({ userId: 'ou_gxl', mentions, text: `/bind ${mentions.map(m => `@${m.name}`).join(' ')}` });
  assert.match(reply, /已绑定 4 人：苏敬袁、王宏钢、张海鹏、朱辉/);
  const bindings = JSON.parse(await readFile(join(dir, 'bindings.json'), 'utf8'));
  assert.deepEqual([bindings.苏敬袁, bindings.王宏钢, bindings.张海鹏, bindings.朱辉], ['ou_1', 'ou_2', 'ou_3', 'ou_4']);
});
