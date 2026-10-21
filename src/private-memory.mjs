// Private-chat memory: every answered private question is condensed into a short keyword record and
// stored locally, so later related questions (scope "all": from anyone; "user": from the same person)
// can find it. Storage and keyword retrieval reuse the group Q&A store; condensing is one background
// model call per turn, with a local key-sentence fallback when the model is unavailable.
import { createLocalGroupContextStore } from './local-group-context.mjs';
import { extractKeyPoints } from './group-memory.mjs';

const FOLLOWUP_ONLY = /^(继续|接着|然后呢|展开|详细说|上面|刚才|之前那个|这个呢|好的|谢谢|收到|ok)[，。？！?!\s]*$/i;

function parseRecord(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('no JSON object');
  const value = JSON.parse(text.slice(start, end + 1));
  const keywords = (Array.isArray(value.keywords) ? value.keywords : []).map(String).map(x => x.trim()).filter(Boolean).slice(0, 12);
  const points = (Array.isArray(value.points) ? value.points : []).map(String).map(x => x.trim()).filter(Boolean).slice(0, 6);
  if (!points.length) throw new Error('empty record');
  return { title: String(value.title || '').trim(), keywords, points };
}

export async function condenseTurn(question, answer, ask) {
  const reply = await ask([
    { role: 'system', content: '把下面这轮问答整理成一条可复用的知识记录。只输出 JSON，不要解释，格式：{"title":"一句话问题（20 字内）","keywords":["关键词",...],"points":["结论或要点",...]}。keywords 3-10 个：模块名、功能名、角色名、文档名、代码类名/字段名等便于以后检索的词；points 最多 5 条，每条不超过 60 字，只保留结论、做法、文件路径或文档链接，不要寒暄。回答里没有确定结论的内容不要写成结论。' },
    { role: 'user', content: JSON.stringify({ question: question.slice(0, 2000), answer: answer.slice(0, 6000) }) },
  ]);
  return parseRecord(reply);
}

export function formatRecord(record) {
  return [record.points.map(p => `- ${p}`).join('\n'), record.keywords.length ? `关键词：${record.keywords.join('、')}` : ''].filter(Boolean).join('\n');
}

export function createPrivateMemory({ dir, ask = null, scope = 'all', report = () => {} }) {
  // retrievalThreshold 0: always pick records by keywords, never inject the whole file.
  const store = createLocalGroupContextStore(dir, { report, retrievalThreshold: 0 });
  const keyFor = item => scope === 'user' ? `p2p:${item.userId}` : 'p2p-all';
  return {
    async read(item, query) {
      if (!query.trim() || FOLLOWUP_ONLY.test(item.text.trim())) return '';
      return store.read(keyFor(item), query);
    },
    async save(item, answer) {
      let record;
      try { record = ask ? await condenseTurn(item.text, answer, ask) : null; }
      catch { record = null; }
      const text = record
        ? formatRecord(record)
        : `${extractKeyPoints(item.text, answer)}`; // local fallback: whole key sentences, no model call
      const question = record?.title ? `${record.title}（原问：${item.text.slice(0, 200)}）` : item.text.slice(0, 500);
      // The asker's name is not stored: with scope "all" records are shared with other people's questions.
      await store.append({ chatId: keyFor(item), text: question, userName: '' }, text);
    },
    pathFor: item => store.pathFor(keyFor(item)),
  };
}
