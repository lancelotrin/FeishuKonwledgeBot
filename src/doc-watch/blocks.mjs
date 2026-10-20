// docx block snapshot and block-level diff. Block ids stay stable while their text is edited,
// so comparing by block_id tells added / changed / removed paragraphs apart precisely.

const HEADING_LEVEL = { 3: 1, 4: 2, 5: 3, 6: 4, 7: 5, 8: 6, 9: 7, 10: 8, 11: 9 };
const TEXT_KEYS = ['text', 'heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'heading6', 'heading7',
  'heading8', 'heading9', 'bullet', 'ordered', 'code', 'quote', 'todo', 'callout'];

function elementsText(elements = []) {
  return elements.map(el => el.text_run?.content ?? el.mention_doc?.title ?? el.equation?.content
    ?? (el.mention_user ? `@${el.mention_user.name || ''}` : '')).join('');
}

// Flattens the block tree into document order: [{ id, type, level, text }].
export function flattenBlocks(blocks, documentId) {
  const index = new Map(blocks.map(b => [b.block_id, b]));
  const order = [];
  const walk = id => {
    const block = index.get(id);
    if (!block) return;
    const type = block.block_type || 0;
    const key = TEXT_KEYS.find(k => block[k] && typeof block[k] === 'object');
    const text = key ? elementsText(block[key].elements) : '';
    if (text.trim() || HEADING_LEVEL[type]) order.push({ id, type, level: HEADING_LEVEL[type] || 0, text });
    for (const child of block.children || []) walk(child);
  };
  walk(documentId);
  return order;
}

// Heading path of every block ("2026-10-20 / 议题一"); a heading's own path excludes itself.
function sections(blocks) {
  const result = new Map();
  let stack = [];
  for (const block of blocks) {
    if (block.level) {
      stack = stack.filter(h => h.level < block.level);
      result.set(block.id, stack.map(h => h.text).join(' / '));
      stack.push({ level: block.level, text: block.text.trim() });
    } else result.set(block.id, stack.map(h => h.text).join(' / '));
  }
  return result;
}

export function diffDocs(old, next) {
  if (!old) return { firstRun: true, added: [], changed: [], removed: [] };
  const before = new Map(old.blocks.map(b => [b.id, b]));
  const after = new Set(next.blocks.map(b => b.id));
  const newSections = sections(next.blocks);
  const oldSections = sections(old.blocks);
  const added = [];
  const changed = [];
  for (const block of next.blocks) {
    const prev = before.get(block.id);
    if (!prev) { if (block.text.trim()) added.push({ ...block, section: newSections.get(block.id) }); }
    else if (prev.text !== block.text) changed.push({ ...block, section: newSections.get(block.id), oldText: prev.text });
  }
  const removed = old.blocks.filter(b => !after.has(b.id) && b.text.trim()).map(b => ({ ...b, section: oldSections.get(b.id) }));
  return { firstRun: false, added, changed, removed };
}

export const countChanges = changes => changes.added.length + changes.changed.length + changes.removed.length;
