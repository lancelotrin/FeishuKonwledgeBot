import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig } from '../src/config.mjs';
import { parseMessage, createHandler, createPostContent, askAI } from '../src/core.mjs';
import { createWikiKnowledgeBase, parseWikiSource, parseDocLinks, focusBoost, excerpt } from '../src/wiki-kb.mjs';
import { createRouter } from '../src/routing.mjs';
import { createPrivateMemory } from '../src/private-memory.mjs';
import { createProjectReader } from '../src/project-knowledge.mjs';
import { tokenize, createBm25Index, chunkText } from '../src/text-search.mjs';

const env = { FEISHU_APP_ID: 'cli_test', FEISHU_APP_SECRET: 's', AI_API_KEY: 'k' };
const groupEvent = (id, text, extra = {}) => ({
  sender: { sender_type: 'user', sender_id: { open_id: 'asker' }, sender_name: '小王' },
  message: { message_id: id, chat_id: 'chat', chat_type: 'group', message_type: 'text', content: JSON.stringify({ text }),
    mentions: [{ key: '@_user_1', name: 'Bot', id: { open_id: 'bot' } }], ...extra },
});

test('config defaults to DeepSeek and reads projects, wiki and routing from the config file', () => {
  const config = readConfig(env, {
    wiki: ['https://x.feishu.cn/wiki/AzlmwaQjzitSa9kqzSec537Cnwd'],
    projects: [{ name: 'OP', root: 'D:\\p' }], routing: { rules: [{ name: 'r' }] },
  });
  assert.equal(config.endpoint, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(config.model, 'deepseek-chat');
  assert.deepEqual(config.wikiSources[0], { url: 'https://x.feishu.cn/wiki/AzlmwaQjzitSa9kqzSec537Cnwd', origin: 'https://x.feishu.cn', kind: 'wiki', token: 'AzlmwaQjzitSa9kqzSec537Cnwd', scope: 'space' });
  assert.equal(config.projects[0].name, 'OP');
  assert.throws(() => readConfig({ ...env, AI_API_KEY: '' }, {}), /AI_API_KEY/);
  assert.throws(() => readConfig(env, { projects: [{}] }), /root/);
  assert.throws(() => parseWikiSource('not a url'), /无法识别/);
});

test('messages: group needs a mention, post messages are flattened, other mentions keep names', () => {
  assert.equal(parseMessage(groupEvent('1', 'hi', { mentions: [] }), 'bot'), null);
  const item = parseMessage(groupEvent('2', '@_user_1 问下 @_user_2 打包', {
    mentions: [{ key: '@_user_1', name: 'Bot', id: { open_id: 'bot' } }, { key: '@_user_2', name: '张三', id: { open_id: 'z' } }],
  }), 'bot');
  assert.equal(item.text, '问下 @张三 打包');
  const post = parseMessage(groupEvent('3', '', { message_type: 'post', content: JSON.stringify({
    title: '标题', content: [[{ tag: 'at', user_id: 'bot', user_name: 'Bot' }, { tag: 'text', text: ' 看下 ' }, { tag: 'a', text: '文档', href: 'https://x.feishu.cn/wiki/AAAAAAAAAAAA' }]],
  }) }), 'bot');
  assert.match(post.text, /标题\n.*看下 文档 https:\/\/x\.feishu\.cn\/wiki\/AAAAAAAAAAAA/);
  assert.deepEqual(parseDocLinks(post.text).map(x => x.token), ['AAAAAAAAAAAA']);
});

test('search: identifiers and Chinese bigrams are tokenized, BM25 ranks the relevant chunk first', () => {
  assert.ok(tokenize('BattleManager 打包失败').includes('battle'));
  assert.ok(tokenize('打包失败').includes('打包'));
  const index = createBm25Index([{ text: '新人入职 账号申请 流程' }, { text: 'Jenkins 打包失败 排查：检查 AssetBundle 日志' }]);
  assert.match(index.search('打包失败怎么办')[0].text, /Jenkins/);
  assert.ok(chunkText('a'.repeat(3000)).length >= 3);
});

function fakeFeishu(documents) {
  const calls = [];
  const request = async (method, url, params = {}) => {
    calls.push(url);
    if (url.endsWith('/get_node')) return { code: 0, data: { node: { space_id: 'S', node_token: params.token, title: '首页', has_child: true, obj_token: 'home', obj_type: 'docx' } } };
    if (url === '/open-apis/wiki/v2/spaces/S/nodes') {
      const parent = params.parent_node_token || '';
      return { code: 0, data: { items: documents.filter(d => d.parent === parent).map(d => ({
        node_token: `n_${d.token}`, obj_token: d.token, obj_type: 'docx', title: d.title, owner: d.owner,
        obj_edit_time: d.edit, has_child: documents.some(x => x.parent === `n_${d.token}`) })), has_more: false } };
    }
    const doc = documents.find(d => url === `/open-apis/docx/v1/documents/${d.token}/raw_content`);
    return doc ? { code: 0, data: { content: doc.text } } : { code: 404 };
  };
  return { request, calls };
}

test('wiki: syncs the whole tree, caches by edit time, searches with owners and drops deleted docs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kb-'));
  const documents = [
    { token: 'home', parent: '', title: '首页', text: '欢迎', edit: '1', owner: 'ou_home' },
    { token: 'build', parent: '', title: '打包指南', text: 'Jenkins 打包失败时先看 command.log 中的第一个 error。', edit: '1', owner: 'ou_build' },
    { token: 'child', parent: 'n_build', title: 'iOS 签名', text: '证书过期会导致签名失败', edit: '1', owner: 'ou_ios' },
  ];
  const { request, calls } = fakeFeishu(documents);
  const kb = createWikiKnowledgeBase({ request, sources: [parseWikiSource('https://x.feishu.cn/wiki/AzlmwaQjzitSa9kqzSec537Cnwd')], cacheDir: dir, report: () => {} });
  assert.deepEqual(await kb.sync(), { documents: 3, fetched: 3, complete: true });
  const hit = kb.search('打包失败怎么查');
  assert.equal(hit.docs[0].owner, 'ou_build');
  assert.match(hit.context, /https:\/\/x\.feishu\.cn\/wiki\/n_build/);
  assert.deepEqual(kb.search('签名').docs[0].path, ['打包指南', 'iOS 签名']);

  calls.length = 0;
  documents.pop();
  assert.deepEqual(await kb.sync(), { documents: 2, fetched: 0, complete: true }); // unchanged docs are not refetched
  assert.ok(!calls.some(url => url.includes('raw_content')));
  assert.equal((await readdir(dir)).length, 2);

  const reloaded = createWikiKnowledgeBase({ request, sources: [], cacheDir: dir });
  assert.equal(await reloaded.loadCache(), 2);
  assert.equal(reloaded.search('Jenkins').docs[0].title, '打包指南');
});

test('wiki: without space membership, sync falls back to the linked node subtree', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kb-'));
  const documents = [{ token: 'guide', parent: 'home', title: '入职指南', text: '账号申请找 IT', edit: '1', owner: 'o' }];
  const { request: base } = fakeFeishu(documents);
  const request = async (method, url, params = {}) => url.endsWith('/nodes') && !params.parent_node_token ? { code: 131006 } : base(method, url, params);
  const home = { space_id: 'S', node_token: 'home', title: '首页', has_child: true, obj_token: 'home', obj_type: 'docx' };
  const wrapped = async (method, url, params) => url.endsWith('/get_node') ? { code: 0, data: { node: home } } : request(method, url, params);
  const reports = [];
  const kb = createWikiKnowledgeBase({ request: wrapped, sources: [parseWikiSource('https://x.feishu.cn/wiki/homehomehome')], cacheDir: dir, report: m => reports.push(m) });
  const result = await kb.sync();
  assert.equal(result.complete, false);
  assert.equal(kb.search('账号申请').docs[0].title, '入职指南');
  assert.match(reports.join('\n'), /还不是.*空间成员/);
});

test('wiki: rate-limited document reads (99991400) are retried instead of failing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kb-'));
  const { request: base } = fakeFeishu([{ token: 'spec', parent: '', title: '角色技能命名规范', text: '技能 ID 规则', edit: '1', owner: 'o' }]);
  let limited = 1;
  const request = async (method, url, params) => url.includes('raw_content') && limited-- > 0 ? { code: 99991400 } : base(method, url, params);
  const reports = [];
  const kb = createWikiKnowledgeBase({ request, sources: [parseWikiSource('https://x.feishu.cn/wiki/AzlmwaQjzitSa9kqzSec537Cnwd')], cacheDir: dir, report: m => reports.push(m), minInterval: 0 });
  assert.deepEqual(await kb.sync(), { documents: 1, fetched: 1, complete: true });
  assert.deepEqual(reports, []);
  assert.equal(kb.search('技能命名').docs[0].title, '角色技能命名规范');
});

test('wiki cache: failed downloads are retried next sync, docx links reuse the cache by revision', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kb-'));
  const documents = [{ token: 'spec', parent: '', title: '命名规范', text: '技能 ID 规则', edit: '7', owner: 'o' }];
  const { request: base } = fakeFeishu(documents);
  let down = true;
  let revision = 3;
  const calls = [];
  const request = async (method, url, params) => {
    calls.push(url);
    if (url === '/open-apis/docx/v1/documents/DirectDocToken01') return { code: 0, data: { document: { revision_id: revision } } };
    if (url === '/open-apis/docx/v1/documents/DirectDocToken01/raw_content') return { code: 0, data: { content: `直连文档 v${revision}` } };
    if (url.includes('spec/raw_content') && down) return { code: 500 };
    return base(method, url, params);
  };
  const sources = [parseWikiSource('https://x.feishu.cn/wiki/AzlmwaQjzitSa9kqzSec537Cnwd'), parseWikiSource({ url: 'https://x.feishu.cn/docx/DirectDocToken01', name: '直连' })];
  const kb = createWikiKnowledgeBase({ request, sources, cacheDir: dir, report: () => {}, minInterval: 0 });
  await kb.sync();
  assert.equal((await readdir(dir)).length, 1); // the failed document is not written to disk
  down = false;
  calls.length = 0;
  assert.equal((await kb.sync()).fetched, 1); // only the previously failed document is downloaded
  assert.ok(calls.includes('/open-apis/docx/v1/documents/spec/raw_content'));
  assert.ok(!calls.includes('/open-apis/docx/v1/documents/DirectDocToken01/raw_content'));
  calls.length = 0;
  assert.equal((await kb.sync()).fetched, 0); // nothing changed: everything comes from the cache
  assert.equal(await kb.readLinked('看下 https://x.feishu.cn/docx/DirectDocToken01'), '《直连》 https://x.feishu.cn/docx/DirectDocToken01\n直连文档 v3');
  assert.ok(!calls.some(url => url.includes('raw_content')));
  revision = 4;
  assert.equal((await kb.sync()).fetched, 1); // a new revision is downloaded again
  assert.match(kb.search('直连文档').context, /v4/);
});

test('wiki cache: an old empty copy left by an earlier failed download is refetched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kb-'));
  await writeFile(join(dir, 'spec.json'), JSON.stringify({ objToken: 'spec', objType: 'docx', title: '命名规范', path: ['命名规范'], url: '', owner: '', editTime: '7', text: '' }));
  const { request } = fakeFeishu([{ token: 'spec', parent: '', title: '命名规范', text: '技能 ID 规则', edit: '7', owner: 'o' }]);
  const kb = createWikiKnowledgeBase({ request, sources: [parseWikiSource('https://x.feishu.cn/wiki/AzlmwaQjzitSa9kqzSec537Cnwd')], cacheDir: dir, report: () => {}, minInterval: 0 });
  await kb.loadCache();
  assert.equal((await kb.sync()).fetched, 1);
  assert.equal(kb.search('技能').docs[0].title, '命名规范');
});

test('config: watched 监修 documents become priority single-document knowledge sources, listed first', () => {
  const config = readConfig(env, { wiki: ['https://x.feishu.cn/wiki/EqQ2wqb6BirAbYkVlnccroiTnoc'],
    docWatch: { enabled: true, wikiBase: 'https://x.feishu.cn/wiki', docs: [{ name: '每周监修会议题', wikiToken: 'P2UcwFP7YidAeCkq2nEcyhJznuf' }] } });
  assert.deepEqual(config.wikiSources[0], { name: '每周监修会议题', token: 'P2UcwFP7YidAeCkq2nEcyhJznuf', kind: 'wiki', origin: 'https://x.feishu.cn', scope: 'node', priority: true });
  assert.equal(config.wikiSources[1].token, 'EqQ2wqb6BirAbYkVlnccroiTnoc');
  assert.deepEqual(config.wikiFocus[0].prefer, ['监修']);
});

test('wiki: node scope syncs one document; 监修 conversations rank 监修 documents first', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kb-'));
  const documents = [
    { token: 'ui', parent: '', title: 'UI 背景图规范', text: '装备页面背景图 使用 RawImage 背景图 背景图', edit: '1', owner: 'a' },
    { token: 'meet', parent: '', title: '每周监修会议题', text: '议题一：关于装备页面的背景图，日方希望物品摆放自然', edit: '1', owner: 'b' },
  ];
  const { request: base } = fakeFeishu(documents);
  const request = async (method, url, params = {}) => url.endsWith('/get_node')
    ? { code: 0, data: { node: { space_id: 'S', node_token: params.token, title: params.token === 'meetnode01' ? '每周监修会议题' : '首页', has_child: false, obj_token: params.token === 'meetnode01' ? 'meet' : 'home', obj_type: 'docx', obj_edit_time: '1' } } }
    : base(method, url, params);
  const sources = [{ name: '监修', token: 'meetnode01', kind: 'wiki', origin: 'https://x.feishu.cn', scope: 'node', priority: true },
    parseWikiSource('https://x.feishu.cn/wiki/AzlmwaQjzitSa9kqzSec537Cnwd')];
  const kb = createWikiKnowledgeBase({ request, sources, cacheDir: dir, report: () => {}, minInterval: 0 });
  await kb.sync();
  const rules = [{ when: ['监修'], prefer: ['监修'], boost: 3 }];
  assert.equal(kb.search('装备页面背景图').docs[0].title, 'UI 背景图规范'); // plain question: best text match wins
  const q = '装备页面背景图 详细说明\n📌 每周监修会议题';
  assert.equal(kb.search(q, 6, { boost: focusBoost(rules, q) }).docs[0].title, '每周监修会议题');
  assert.equal(kb.search(q).docs.find(d => d.title === '每周监修会议题').priority, true);
});

test('excerpt: long linked documents keep the passages relevant to the question', () => {
  const text = ['开头 无关内容'.repeat(80), '议题一：关于装备页面的背景图 日方反馈', '结尾 其他议题'.repeat(80)].join('\n');
  const result = excerpt(text, '装备页面背景图', 900);
  assert.match(result, /议题一：关于装备页面的背景图/);
  assert.ok(result.length <= 900);
  assert.equal(excerpt('短文', '任意', 900), '短文');
});

test('handler: a reply uses the quoted message for retrieval, linked docs and the prompt', async () => {
  const prompts = [];
  let searched = '';
  let linkedArgs = [];
  const h = createHandler({ botId: 'bot', system: 'S',
    loadQuoted: async item => { assert.equal(item.parentId, 'notice'); return '📌 每周监修会议题\n议题一：关于装备页面的背景图\n🔗 https://x.feishu.cn/wiki/P2UcwFP7YidAeCkq2nEcyhJznuf'; },
    searchWiki: query => { searched = query; return { context: '', docs: [] }; },
    readLinked: async (text, query) => { linkedArgs = [text, query]; return '《每周监修会议题》 议题一正文'; },
    ask: async messages => { prompts.push(messages.map(m => m.content).join('\n')); return 'ok'; }, send: async () => {} });
  h.accept({ sender: { sender_type: 'user', sender_id: { open_id: 'u' } }, message: { message_id: 'm', chat_id: 'c', chat_type: 'p2p',
    message_type: 'text', parent_id: 'notice', content: JSON.stringify({ text: '关于装备页面背景图详细说明一下' }) } });
  await h.drain();
  assert.match(searched, /每周监修会议题/);
  assert.match(linkedArgs[0], /P2UcwFP7YidAeCkq2nEcyhJznuf/);
  assert.match(prompts[0], /用户是在回复下面这条消息[\s\S]*议题一：关于装备页面的背景图/);
  assert.match(prompts[0], /《每周监修会议题》 议题一正文/);
});

test('private memory: turns are condensed into keyword records and found by later related questions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mem-'));
  const ask = async () => '{"title":"装备页背景图怎么换","keywords":["装备页面","背景图","SetImageTexture"],"points":["背景图用 UIManager.SetImageTexture 换图","资源名来自配置表"]}';
  const memory = createPrivateMemory({ dir, ask });
  await memory.save({ userId: 'u1', text: '装备页面背景图怎么换？' }, '很长的回答……');
  const found = await memory.read({ userId: 'u2', text: '背景图换图用什么接口' }, '背景图换图用什么接口');
  assert.match(found, /装备页背景图怎么换[\s\S]*SetImageTexture[\s\S]*关键词：装备页面、背景图/);
  assert.doesNotMatch(found, /很长的回答/); // the condensed record is stored, not the full answer
  assert.equal(await memory.read({ userId: 'u2', text: '抽卡概率' }, '抽卡概率'), ''); // unrelated: nothing injected
  assert.equal(await memory.read({ userId: 'u2', text: '继续' }, '继续'), '');

  const own = createPrivateMemory({ dir: await mkdtemp(join(tmpdir(), 'mem-')), ask: async () => { throw new Error('down'); }, scope: 'user' });
  await own.save({ userId: 'u1', text: '打包失败怎么查' }, '先看 command.log 里的第一个 error。');
  assert.match(await own.read({ userId: 'u1', text: '打包失败' }, '打包失败'), /command\.log/); // local fallback when the model is down
  assert.equal(await own.read({ userId: 'u2', text: '打包失败' }, '打包失败'), ''); // scope "user": other people cannot see it
});

test('handler: private answers are saved to memory and memory is offered to later questions', async () => {
  const saved = [];
  const prompts = [];
  const h = createHandler({ botId: 'bot', system: 'S', send: async () => {},
    loadMemory: async () => '- 背景图用 SetImageTexture 换图',
    saveMemory: async (item, answer) => saved.push([item.text, answer]),
    ask: async messages => { prompts.push(messages.map(m => m.content).join('\n')); return '答案'; } });
  h.accept({ sender: { sender_type: 'user', sender_id: { open_id: 'u' } }, message: { message_id: 'p1', chat_id: 'c', chat_type: 'p2p',
    message_type: 'text', content: JSON.stringify({ text: '背景图怎么换' }) } });
  await h.drain();
  assert.deepEqual(saved, [['背景图怎么换', '答案']]);
  assert.match(prompts[0], /以往私聊中整理过的相关问答要点[\s\S]*SetImageTexture/);
});

test('routing: rule and doc-owner candidates, model picks with a trailing line, asker excluded', async () => {
  const router = createRouter({ rules: [
    { name: '打包', keywords: ['打包'], users: [{ name: '张三', openId: 'ou_z' }, { name: '本人', openId: 'asker' }] },
    { name: '战斗', paths: ['Client/Battle'], users: [{ email: 'l@x.com' }], dm: true },
  ], resolveEmails: async emails => ({ [emails[0]]: 'ou_l' }), lookupName: async () => '文档主人' });
  const candidates = await router.candidates({ question: '打包报错', askerId: 'asker',
    files: [{ project: 'OP', path: 'Client/Battle/Skill.cs' }], docs: [{ title: '打包指南', path: ['打包指南'], owner: 'ou_doc' }] });
  assert.deepEqual(candidates.map(c => [c.id, c.openId, c.source, c.dm]), [['P1', 'ou_z', 'rule', false], ['P2', 'ou_l', 'rule', true], ['P3', 'ou_doc', 'doc', false]]);
  assert.deepEqual(router.pick('答案\n通知：P3', candidates), { body: '答案', people: [candidates[2]] });
  assert.deepEqual(router.pick('答案\n通知：无', candidates).people, []);
  assert.deepEqual(router.pick('答案', candidates).people.map(p => p.id), ['P1', 'P2']); // fallback: rule matches only
});

test('projects: plain folders are searched by walking, guides are included and paths reported', async () => {
  const root = await mkdtemp(join(tmpdir(), 'proj-'));
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'Library'));
  await writeFile(join(root, 'README.md'), '项目说明');
  await writeFile(join(root, 'src', 'Build.cs'), 'class A {}\n// 打包入口 BuildPipeline\n');
  await writeFile(join(root, 'Library', 'Cache.cs'), '// 打包缓存');
  const read = await createProjectReader([{ name: 'Demo', root, guides: ['README.md'] }]);
  const result = await read('BuildPipeline 打包入口在哪');
  assert.deepEqual(result.files, [{ project: 'Demo', path: 'src/Build.cs' }]);
  assert.match(result.context, /默认文档 README\.md：\n项目说明/);
  assert.match(result.context, /2: \/\/ 打包入口 BuildPipeline/);
  await assert.rejects(createProjectReader([{ name: 'X', root: join(root, 'missing') }]), /不存在/);
});

test('handler: gathers all sources, @mentions picked people in the group and DMs dm-rule owners', async () => {
  const prompts = [];
  const sent = [];
  const direct = [];
  const router = createRouter({ rules: [{ name: '打包', keywords: ['打包'], users: [{ name: '张三', openId: 'ou_z' }], dm: true }] });
  const h = createHandler({ botId: 'bot', system: 'SYS', router,
    loadHistory: async () => [{ role: 'user', content: '老李：昨天 iOS 包也挂了' }],
    loadGroupContext: async () => '上次问答',
    searchWiki: () => ({ context: '《打包指南》 片段', docs: [] }),
    loadProjectContext: async () => ({ context: '项目片段', files: [] }),
    ask: async messages => { prompts.push(messages); return '先看 command.log。\n通知：P1'; },
    send: async (item, content) => sent.push(JSON.parse(content)),
    sendDirect: async (openId, content) => direct.push([openId, JSON.parse(content)]),
  });
  h.accept(groupEvent('m1', '@_user_1 打包失败怎么办')); await h.drain();
  const joined = prompts[0].map(m => m.content).join('\n');
  for (const part of ['SYS', '《打包指南》 片段', '项目片段', '上次问答', '老李：昨天 iOS 包也挂了', '通知：P1', '小王：打包失败怎么办']) assert.ok(joined.includes(part), part);
  const paragraphs = sent[0].zh_cn.content;
  assert.equal(paragraphs[0][0].text, '先看 command.log。');
  assert.deepEqual(paragraphs[1][1], { tag: 'at', user_id: 'ou_z' });
  assert.equal(direct[0][0], 'ou_z');
});

test('handler commands and AI client errors', async () => {
  const sent = [];
  const h = createHandler({ botId: 'bot', system: 's', ask: async () => 'x', send: async (_, c) => sent.push(JSON.parse(c).zh_cn.content[0][0].text),
    syncWiki: async () => ({ documents: 5, fetched: 2, complete: true }) });
  h.accept(groupEvent('c1', '@_user_1 /sync')); await h.drain();
  assert.match(sent[0], /共 5 篇，本次更新 2 篇/);
  assert.deepEqual(JSON.parse(createPostContent('a\n\n\n\nb')).zh_cn.content, [[{ tag: 'md', text: 'a\n\nb' }]]);
  const config = { endpoint: 'http://x', apiKey: 'k', model: 'm', timeout: 1000 };
  assert.equal(await askAI(config, [], async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '<think>x</think>答' } }] }) })), '答');
  await assert.rejects(askAI(config, [], async () => ({ ok: false, status: 401 })), /HTTP 401/);
});

test('/openid lists and records the open_ids of @mentioned people, or the sender when nobody is mentioned', async () => {
  const replies = [];
  const recorded = [];
  const h = createHandler({ botId: 'bot', system: 's', ask: async () => 'QA', recordOpenIds: async people => recorded.push(...people),
    send: async (_, content) => replies.push(JSON.parse(content).zh_cn.content[0][0].text) });
  h.accept(groupEvent('o1', '@_user_1 /openid @_user_2 @_user_3', { mentions: [
    { key: '@_user_1', name: 'Bot', id: { open_id: 'bot' } },
    { key: '@_user_2', name: '阿飞（苏敬袁）', id: { open_id: 'ou_a' } },
    { key: '@_user_3', name: '张海鹏', id: { open_id: 'ou_b' } }] }));
  await h.drain();
  assert.match(replies[0], /- 阿飞（苏敬袁）：`ou_a`\n- 张海鹏：`ou_b`/);
  assert.deepEqual(recorded.map(p => p.openId), ['ou_a', 'ou_b']);
  h.accept(groupEvent('o2', '@_user_1 /openid')); await h.drain();
  assert.match(replies[1], /小王：`asker`/);
});
