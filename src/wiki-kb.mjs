// Feishu wiki knowledge base: mirrors configured wiki spaces into a local cache and searches it with BM25.
// Feishu's wiki search API only works with user tokens, so the bot syncs with its app identity and searches locally.
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chunkText, createBm25Index } from './text-search.mjs';

const LINK = /https?:\/\/[^\s/]+\/(wiki|docx|docs)\/([A-Za-z0-9]{10,})/g;

export function parseDocLinks(text) {
  const links = [];
  for (const [url, kind, token] of String(text || '').matchAll(LINK)) {
    if (!links.some(x => x.token === token)) links.push({ url, kind, token });
  }
  return links;
}

async function pool(items, size, worker) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const item = items[next++]; await worker(item); }
  }));
}

function ensureOk(body, what) {
  if (body?.code !== 0) {
    const error = new Error(`${what}失败（飞书错误码 ${body?.code ?? '未知'}）`);
    error.feishuCode = body?.code;
    throw error;
  }
  return body.data || {};
}

const sleep = ms => new Promise(done => setTimeout(done, ms));

export function createWikiKnowledgeBase({ request: rawRequest, sources, cacheDir = 'data/wiki', maxDocs = 3000,
  report = console.error, contextChars = 9000, minInterval = 250 }) {
  const root = resolve(cacheDir);
  // Feishu limits document APIs to a few requests per second per app (error 99991400):
  // space requests out evenly and back off when the limit is still hit.
  let nextSlot = 0;
  async function request(method, url, params) {
    for (let attempt = 0; ; attempt++) {
      const now = Date.now();
      const wait = Math.max(0, nextSlot - now);
      nextSlot = Math.max(nextSlot, now) + minInterval;
      if (wait) await sleep(wait);
      const body = await rawRequest(method, url, params);
      if (![99991400, 429].includes(body?.code) || attempt >= 5) return body;
      await sleep(Math.min(16000, 1000 * 2 ** attempt));
    }
  }
  let docs = new Map(); // objToken -> cached document
  let index = createBm25Index([]);
  let syncing = null;
  let lastSync = null;

  const fileFor = token => join(root, `${token.replace(/[^A-Za-z0-9_-]/g, '')}.json`);

  async function fetchText(objType, objToken) {
    if (objType === 'docx') {
      return ensureOk(await request('GET', `/open-apis/docx/v1/documents/${objToken}/raw_content`), '读取文档').content || '';
    }
    if (objType === 'doc') {
      return ensureOk(await request('GET', `/open-apis/doc/v2/${objToken}/raw_content`), '读取旧版文档').content || '';
    }
    return ''; // sheets, bitables, files, mindnotes: indexed by title and path only
  }

  // Docs reached by a plain /docx/ link carry no wiki edit time; the revision number serves the same purpose.
  async function docxVersion(objToken) {
    const data = ensureOk(await request('GET', `/open-apis/docx/v1/documents/${objToken}`), '读取文档版本');
    return data.document?.revision_id ? `rev:${data.document.revision_id}` : '';
  }

  // A cached copy is reusable only when its version matches and the earlier download actually succeeded.
  function cachedCopy(objToken, editTime) {
    const cached = docs.get(objToken);
    if (!cached || !editTime || cached.editTime !== editTime) return null;
    if (!cached.text && ['docx', 'doc'].includes(cached.objType)) return null;
    return cached;
  }

  async function saveDoc(doc) {
    docs.set(doc.objToken, doc);
    await writeFile(`${fileFor(doc.objToken)}.tmp`, JSON.stringify(doc), 'utf8');
    await rename(`${fileFor(doc.objToken)}.tmp`, fileFor(doc.objToken));
  }

  async function getNode(token) {
    return ensureOk(await request('GET', '/open-apis/wiki/v2/spaces/get_node', { token }), '读取知识库节点').node;
  }

  async function listChildren(spaceId, parent) {
    const nodes = [];
    let pageToken = '';
    do {
      const data = ensureOk(await request('GET', `/open-apis/wiki/v2/spaces/${spaceId}/nodes`,
        { page_size: 50, ...(parent ? { parent_node_token: parent } : {}), ...(pageToken ? { page_token: pageToken } : {}) }), '列出知识库目录');
      nodes.push(...(data.items || []));
      pageToken = data.has_more ? data.page_token : '';
    } while (pageToken);
    return nodes;
  }

  function rebuildIndex() {
    const chunks = [];
    for (const doc of docs.values()) {
      const heading = doc.path.join(' / ');
      const parts = doc.text ? chunkText(doc.text) : [''];
      parts.forEach((part, n) => chunks.push({ token: doc.objToken, n, text: `${heading}\n${heading}\n${part}` }));
    }
    index = createBm25Index(chunks);
  }

  async function loadCache() {
    let names = [];
    try { names = await readdir(root); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const next = new Map();
    for (const name of names.filter(x => x.endsWith('.json'))) {
      try {
        const doc = JSON.parse(await readFile(join(root, name), 'utf8'));
        if (doc?.objToken) next.set(doc.objToken, doc);
      } catch { /* a broken cache file is refetched on the next sync */ }
    }
    docs = next;
    rebuildIndex();
    return docs.size;
  }

  async function syncNow() {
    await mkdir(root, { recursive: true });
    const seen = new Set();
    const queue = [];
    let complete = true;
    let fetched = 0;
    for (const source of sources) {
      try {
        if (source.kind === 'docx') {
          queue.push({ node: { obj_token: source.token, obj_type: 'docx', title: source.name || source.token, obj_edit_time: '' },
            path: [source.name || '文档'], url: source.url });
          continue;
        }
        const start = await getNode(source.token);
        const origin = source.origin || '';
        const visit = async (spaceId, parentToken, path) => {
          for (const child of await listChildren(spaceId, parentToken)) {
            if (queue.length >= maxDocs) { complete = false; return; }
            const childPath = [...path, child.title || '无标题'];
            queue.push({ node: child, path: childPath, url: `${origin}/wiki/${child.node_token}` });
            if (child.has_child) await visit(spaceId, child.node_token, childPath);
          }
        };
        const visitSubtree = async () => {
          queue.push({ node: start, path: [start.title], url: `${origin}/wiki/${start.node_token}` });
          if (start.has_child) await visit(start.space_id, start.node_token, [start.title]);
        };
        if (source.scope === 'subtree') await visitSubtree();
        else {
          try { await visit(start.space_id, '', [source.name].filter(Boolean)); }
          catch (error) {
            // Not a space member yet, but document-level sharing may still expose this node's subtree.
            if (error.feishuCode !== 131006) throw error;
            complete = false;
            report(`[知识库] 机器人还不是「${source.name || start.title}」的空间成员，暂时只同步《${start.title}》及其子文档。把包含机器人的群加为空间成员后即可同步整个空间。`);
            await visitSubtree();
          }
        }
      } catch (error) {
        complete = false;
        const hint = error.feishuCode === 99991672
          ? '应用缺少权限：请在开发者后台开通 wiki:wiki:readonly，并创建版本发布后再试。'
          : error.feishuCode === 131006
            ? '机器人没有该知识空间的访问权限：请把包含机器人的群加为知识空间成员。'
            : '请确认应用已开通 wiki:wiki:readonly 并被加入知识空间。';
        report(`[知识库] 同步「${source.name || source.token}」失败：${error.message}。${hint}`);
      }
    }
    await pool(queue, 4, async ({ node, path, url }) => {
      // Shortcuts point at another node; index the original document once.
      const objToken = node.obj_token;
      if (!objToken || seen.has(objToken)) return;
      seen.add(objToken);
      const cached = docs.get(objToken);
      let editTime = String(node.obj_edit_time || '');
      if (!editTime && node.obj_type === 'docx') editTime = await docxVersion(objToken).catch(() => '');
      // Unchanged version: read from the local cache, no download.
      const reusable = cachedCopy(objToken, editTime);
      if (reusable) {
        if (reusable.path.join('/') !== path.join('/') || reusable.url !== url || reusable.title !== node.title) {
          await saveDoc({ ...reusable, path, url, title: node.title || reusable.title });
        }
        return;
      }
      let text;
      try { text = (await fetchText(node.obj_type, objToken)).slice(0, 400000); fetched++; }
      catch (error) {
        report(`[知识库] 读取《${node.title}》失败：${error.message}${cached ? '，继续使用本地旧版本' : '，下次同步会重试'}`);
        if (cached) return; // keep the stale copy rather than losing the document
        // Keep the title searchable but leave the version empty so the next sync retries the download.
        docs.set(objToken, { objToken, objType: node.obj_type, title: node.title || '无标题', path, url,
          owner: node.owner || node.creator || '', editTime: '', text: '' });
        return;
      }
      await saveDoc({ objToken, objType: node.obj_type, title: node.title || '无标题', path, url,
        owner: node.owner || node.creator || '', editTime, text });
    });
    // Only drop deleted documents after a full, error-free walk; a partial sync must not erase the cache.
    if (complete) {
      for (const token of [...docs.keys()]) {
        if (seen.has(token)) continue;
        docs.delete(token);
        try { await unlink(fileFor(token)); } catch { /* already gone */ }
      }
    }
    rebuildIndex();
    lastSync = new Date();
    return { documents: docs.size, fetched, complete };
  }

  return {
    loadCache,
    sync() {
      syncing ||= syncNow().finally(() => { syncing = null; });
      return syncing;
    },
    get status() { return { documents: docs.size, lastSync }; },

    // Returns prompt context plus the hit documents (used to route the answer to owners).
    search(query, limit = 6) {
      const hits = index.search(query, 24);
      const byDoc = new Map();
      for (const hit of hits) {
        const doc = docs.get(hit.token);
        if (!doc) continue;
        const entry = byDoc.get(doc.objToken) || { doc, score: 0, chunks: [] };
        entry.score += hit.score;
        if (entry.chunks.length < 2) entry.chunks.push(hit.text.split('\n').slice(2).join('\n'));
        byDoc.set(doc.objToken, entry);
      }
      const ranked = [...byDoc.values()].sort((a, b) => b.score - a.score).slice(0, limit);
      const sections = [];
      let used = 0;
      const kept = [];
      for (const { doc, chunks } of ranked) {
        const body = chunks.filter(Boolean).join('\n…\n') || '（该文档无可读取正文，仅标题匹配）';
        const section = `《${doc.path.join(' / ')}》 ${doc.url}\n${body}`;
        if (used + section.length > contextChars) break;
        sections.push(section); kept.push(doc); used += section.length;
      }
      return { context: sections.join('\n\n---\n\n'), docs: kept };
    },

    // Reads Feishu doc links pasted into the chat directly, even if they are outside the configured spaces.
    async readLinked(text, maxChars = 8000) {
      const parts = [];
      for (const link of parseDocLinks(text).slice(0, 3)) {
        try {
          let objType = link.kind === 'docs' ? 'doc' : 'docx';
          let objToken = link.token;
          let title = docs.get(link.token)?.title || link.token;
          let editTime = '';
          if (link.kind === 'wiki') {
            const node = await getNode(link.token);
            ({ obj_type: objType, obj_token: objToken, title } = node);
            editTime = String(node.obj_edit_time || '');
          } else if (objType === 'docx' && docs.has(objToken)) {
            editTime = await docxVersion(objToken).catch(() => '');
          }
          const body = cachedCopy(objToken, editTime)?.text ?? await fetchText(objType, objToken);
          parts.push(`《${title}》 ${link.url}\n${Array.from(body).slice(0, maxChars).join('')}`);
        } catch {
          parts.push(`《${link.url}》无法读取：请确认机器人应用有该文档的阅读权限。`);
        }
      }
      return parts.join('\n\n---\n\n');
    },
  };
}

// Accepts wiki/docx URLs or bare tokens from config.
export function parseWikiSource(entry) {
  const value = typeof entry === 'string' ? { url: entry } : { ...entry };
  const text = value.url || value.token || '';
  const match = text.match(/^(https?:\/\/[^/\s]+)\/(wiki|docx)\/([A-Za-z0-9]+)/);
  if (match) return { ...value, origin: match[1], kind: match[2], token: match[3], scope: value.scope || 'space' };
  if (/^[A-Za-z0-9]{10,}$/.test(text)) return { ...value, origin: value.origin || '', kind: value.kind || 'wiki', token: text, scope: value.scope || 'space' };
  throw new Error(`无法识别的知识库地址：${text}`);
}
