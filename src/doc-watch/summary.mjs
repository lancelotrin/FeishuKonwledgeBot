// Turns a change list into a short notification body (pure rules, no model calls).
const NOISE = /^[\w\-. ()一-鿿]*\.(png|jpe?g|gif|bmp|webp|mp4|mov|avi|xlsx?|docx?|pptx?|pdf|txt|zip|rar|7z)$/i;
const MAX_PER_SECTION = 4;
const MAX_SECTIONS = 12;
const MAX_LINE = 60;

export const isNoise = text => { const t = text.trim(); return !t || t.length <= 1 || NOISE.test(t); };

export function shorten(text, limit = MAX_LINE) {
  const t = text.trim().replace(/\s+/g, ' ');
  return Array.from(t).length <= limit ? t : Array.from(t).slice(0, limit - 1).join('') + '…';
}

export function headline(changes) {
  const parts = [];
  if (changes.added.length) parts.push(`新增 ${changes.added.length}`);
  if (changes.changed.length) parts.push(`修改 ${changes.changed.length}`);
  if (changes.removed.length) parts.push(`删除 ${changes.removed.length}`);
  return parts.join('，') || '无变更';
}

// Groups changes by heading path, merges duplicates and folds long lists.
export function summarize(changes) {
  const groups = new Map();
  let noise = 0;
  const add = (mark, item) => {
    if (item.level) return; // headings only act as section labels
    if (isNoise(item.text)) { noise++; return; }
    const key = item.section || '（无标题）';
    if (!groups.has(key)) groups.set(key, []);
    const line = `${mark} ${shorten(item.text)}`;
    if (!groups.get(key).includes(line)) groups.get(key).push(line);
  };
  changes.added.forEach(item => add('＋', item));
  changes.changed.forEach(item => add('～', item));
  changes.removed.forEach(item => add('－', item));
  const lines = [];
  const keys = [...groups.keys()];
  keys.forEach((section, n) => {
    if (n === MAX_SECTIONS) lines.push(`…另有 ${keys.slice(n).reduce((s, k) => s + groups.get(k).length, 0)} 处变更`);
    if (n >= MAX_SECTIONS) return;
    const items = groups.get(section);
    lines.push(`▸ ${Array.from(section).length > 40 ? Array.from(section).slice(-40).join('') : section}`);
    for (const line of items.slice(0, MAX_PER_SECTION)) lines.push(`   ${line}`);
    if (items.length > MAX_PER_SECTION) lines.push(`   …本节共 ${items.length} 处`);
  });
  if (noise) lines.push(`（另有 ${noise} 个附件/图片变更未列出）`);
  return lines.join('\n');
}
