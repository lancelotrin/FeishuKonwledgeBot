import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig } from '../src/config.mjs';
import { parseMessage, createHandler, createPostContent, askAI } from '../src/core.mjs';
import { createWikiKnowledgeBase, parseWikiSource, parseDocLinks } from '../src/wiki-kb.mjs';
import { createRouter } from '../src/routing.mjs';
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
