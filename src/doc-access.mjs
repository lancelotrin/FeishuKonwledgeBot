// Decides whether a person can already read a Feishu doc, so a private reply may carry a clickable
// link without Feishu granting anything. Confirmed only by (1) the doc's link sharing being open to the
// whole organisation (or everyone), or (2) the person being a direct collaborator. Access through a
// group, department or wiki-space membership cannot be resolved with the app's identity, so it is
// treated as "not confirmed" and the link is sent as plain text: false negatives are harmless,
// false positives would grant access. Needs the read-only scopes docs:permission.setting:read and
// docs:permission.member:retrieve; without them every check returns false.

const TYPES = { wiki: 'wiki', docx: 'docx', docs: 'doc', sheets: 'sheet', base: 'bitable', file: 'file', mindnotes: 'mindnote', slides: 'slides' };
const OPEN_TO_TENANT = /^(tenant|anyone)_(readable|editable)$/;

export function parseDocUrl(url) {
  const match = String(url).match(/\/(wiki|docx|docs|sheets|base|file|mindnotes|slides)\/([A-Za-z0-9]+)/);
  return match ? { type: TYPES[match[1]], token: match[2] } : null;
}

export function createAccessChecker({ request, ttlMs = 10 * 60_000, now = () => Date.now() }) {
  const cache = new Map(); // `${kind}:${token}` -> { at, value }
  async function cached(key, load) {
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const value = await load();
    cache.set(key, { at: now(), value });
    if (cache.size > 2000) cache.delete(cache.keys().next().value);
    return value;
  }

  async function openToTenant({ type, token }) {
    return cached(`public:${token}`, async () => {
      const body = await request('GET', `/open-apis/drive/v2/permissions/${token}/public`, { type });
      return body?.code === 0 && OPEN_TO_TENANT.test(body.data?.permission_public?.link_share_entity || '');
    });
  }

  async function directMembers({ type, token }) {
    return cached(`members:${token}`, async () => {
      const body = await request('GET', `/open-apis/drive/v1/permissions/${token}/members`, { type });
      if (body?.code !== 0) return new Set();
      return new Set((body.data?.items || []).filter(m => m.member_type === 'openid').map(m => m.member_id));
    });
  }

  return async function canRead(openId, url) {
    const doc = parseDocUrl(url);
    if (!doc || !openId) return false;
    if (await openToTenant(doc)) return true;
    return (await directMembers(doc)).has(openId);
  };
}
