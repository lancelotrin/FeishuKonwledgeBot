// Local BM25 search shared by the wiki knowledge base. No model calls, no network.
const STOP = new Set(['这个', '那个', '什么', '怎么', '一下', '可以', '问题', '请问', '如何', '是否', '我们', '你们',
  '他们', '就是', '还是', '没有', '一个', '现在', '时候', '因为', '所以', '如果', 'the', 'and', 'for', 'with', 'this', 'that']);

export function tokenize(text) {
  const tokens = [];
  const lower = String(text || '').toLowerCase();
  for (const word of lower.match(/[a-z_][a-z0-9_]{1,63}|[0-9]{3,}/g) || []) {
    if (!STOP.has(word)) tokens.push(word);
    // CamelCase / snake_case parts also match: "BattleManager" -> "battle", "manager".
    for (const part of word.split('_')) if (part !== word && part.length > 2) tokens.push(part);
  }
  for (const word of String(text || '').match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g) || []) {
    const part = word.toLowerCase();
    if (part.length > 2 && !STOP.has(part)) tokens.push(part);
  }
  for (const run of String(text || '').match(/[㐀-鿿]+/gu) || []) {
    if (run.length === 1) continue;
    for (let i = 0; i < run.length - 1; i++) {
      const pair = run.slice(i, i + 2);
      if (!STOP.has(pair)) tokens.push(pair);
    }
  }
  return tokens;
}

// Split long text on paragraph boundaries into chunks of roughly `size` characters.
export function chunkText(text, size = 900, overlap = 150) {
  const paragraphs = String(text || '').split(/\n+/).map(x => x.trim()).filter(Boolean);
  const chunks = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 1 > size) {
      chunks.push(current);
      current = current.slice(-overlap);
    }
    if (paragraph.length > size) {
      for (let i = 0; i < paragraph.length; i += size - overlap) {
        const piece = paragraph.slice(i, i + size);
        if (current && current.length + piece.length + 1 > size) { chunks.push(current); current = ''; }
        current += (current ? '\n' : '') + piece;
      }
    } else current += (current ? '\n' : '') + paragraph;
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}

export function createBm25Index(docs, { k1 = 1.2, b = 0.75 } = {}) {
  const postings = new Map();
  const lengths = [];
  docs.forEach((doc, index) => {
    const tokens = tokenize(doc.text);
    lengths.push(tokens.length || 1);
    const counts = new Map();
    for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
    for (const [token, count] of counts) {
      if (!postings.has(token)) postings.set(token, []);
      postings.get(token).push([index, count]);
    }
  });
  const average = lengths.reduce((a, x) => a + x, 0) / (lengths.length || 1);
  return {
    size: docs.length,
    search(query, limit = 8) {
      const scores = new Map();
      for (const token of new Set(tokenize(query))) {
        const list = postings.get(token);
        if (!list) continue;
        const idf = Math.log(1 + (docs.length - list.length + 0.5) / (list.length + 0.5));
        const weight = /[a-z0-9]/.test(token) ? 1.5 : 1; // identifiers are more specific than CJK pairs
        for (const [index, count] of list) {
          const tf = (count * (k1 + 1)) / (count + k1 * (1 - b + b * lengths[index] / average));
          scores.set(index, (scores.get(index) || 0) + idf * tf * weight);
        }
      }
      return [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
        .map(([index, score]) => ({ ...docs[index], score }));
    },
  };
}
