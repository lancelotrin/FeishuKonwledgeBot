// Works out who should be notified about an answer: configured owners whose keywords / paths match,
// plus owners of the wiki documents the answer relied on. The model picks from these candidates.

export function normalizeRules(rules = []) {
  return rules.map((rule, n) => ({
    name: rule.name || `规则${n + 1}`,
    keywords: (rule.keywords || []).map(x => String(x).toLowerCase()).filter(Boolean),
    paths: (rule.paths || []).map(x => String(x).replaceAll('\\', '/').toLowerCase()).filter(Boolean),
    wiki: (rule.wiki || []).map(x => String(x).toLowerCase()).filter(Boolean),
    users: (rule.users || []).filter(u => u?.openId || u?.email),
    dm: Boolean(rule.dm),
  }));
}

export function matchRules(rules, { question, files = [], docs = [] }) {
  const text = question.toLowerCase();
  const matched = [];
  for (const rule of rules) {
    const reasons = [];
    const word = rule.keywords.find(k => text.includes(k));
    if (word) reasons.push(`问题涉及“${word}”`);
    const file = files.find(f => rule.paths.some(p => `${f.path}`.toLowerCase().startsWith(p) || `${f.project}/${f.path}`.toLowerCase().startsWith(p)));
    if (file) reasons.push(`相关代码 ${file.path}`);
    const doc = docs.find(d => rule.wiki.some(w => d.path.join('/').toLowerCase().includes(w)));
    if (doc) reasons.push(`相关文档《${doc.title}》`);
    if (reasons.length) matched.push({ rule, reasons });
  }
  return matched;
}

export function createRouter({ rules = [], notifyDocOwners = true, maxNotify = 3, resolveEmails = async () => ({}), lookupName = async () => '' }) {
  const normalized = normalizeRules(rules);
  return {
    async candidates({ question, files, docs, askerId }) {
      const list = [];
      const add = (openId, name, reason, source, dm) => {
        if (!openId || openId === askerId) return;
        const existing = list.find(x => x.openId === openId);
        if (existing) { if (!existing.reasons.includes(reason)) existing.reasons.push(reason); existing.dm ||= dm; return; }
        list.push({ id: `P${list.length + 1}`, openId, name, reasons: [reason], source, dm });
      };
      const matched = matchRules(normalized, { question, files, docs });
      const emails = matched.flatMap(m => m.rule.users.filter(u => !u.openId).map(u => u.email));
      const resolved = emails.length ? await resolveEmails(emails).catch(() => ({})) : {};
      for (const { rule, reasons } of matched) {
        for (const user of rule.users) add(user.openId || resolved[user.email], user.name || user.email || '', `${rule.name}：${reasons.join('，')}`, 'rule', rule.dm);
      }
      if (notifyDocOwners) {
        for (const doc of docs.slice(0, 3)) {
          if (!doc.owner) continue;
          add(doc.owner, await lookupName(doc.owner).catch(() => ''), `文档《${doc.title}》负责人`, 'doc', false);
        }
      }
      return list;
    },
    // The model ends its answer with a line such as "通知：P1,P2" or "通知：无".
    pick(answer, candidates) {
      const match = answer.match(/\n?[ \t]*[\[【]?(?:通知|NOTIFY)[:：]\s*([^\n\]】]*)[\]】]?\s*$/i);
      const body = match ? answer.slice(0, match.index).trimEnd() : answer;
      if (!candidates.length) return { body, people: [] };
      if (!match) return { body, people: candidates.filter(c => c.source === 'rule').slice(0, maxNotify) };
      const ids = match[1].toUpperCase().match(/P\d+/g) || [];
      return { body, people: candidates.filter(c => ids.includes(c.id)).slice(0, maxNotify) };
    },
  };
}

export function candidatePrompt(candidates) {
  if (!candidates.length) return '';
  const lines = candidates.map(c => `${c.id}：${c.name || '（未命名）'}，${c.reasons.join('；')}`);
  return `以下是可能需要知晓此问题的相关人。判断谁真的需要跟进（例如问题需要他确认、他负责相关模块或文档、答案不确定需要人工补充）。在回答最后单独一行写“通知：P1,P2”，不需要通知任何人则写“通知：无”。不要在正文中提到这些编号。\n${lines.join('\n')}`;
}
