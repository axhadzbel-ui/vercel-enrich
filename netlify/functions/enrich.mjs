// netlify/functions/enrich.mjs — standalone zero-dep port of enrich.mjs
// 402 body shape mirrors local x402 v2 output exactly (amount 20000, Bazaar GET extension).
const PAY_TO = '0x032Ee9775D1b5c4066Cc73039DC1beF7465b5Be5';
const NETWORK = 'eip155:8453';
const AMOUNT = '20000';
const ASSET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const DESC = 'Domain to emails plus socials enrichment from free public sources: DNS MX SPF, RDAP registrar, homepage mailto and social links';
const BAZAAR_EXT = { info: { input: { type: 'http', method: 'GET', queryParams: {} } }, schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { input: { type: 'object', properties: { type: { type: 'string', const: 'http' }, method: { type: 'string', enum: ['GET'] }, queryParams: { type: 'object', properties: {} } }, required: ['type', 'method'], additionalProperties: false } }, required: ['input'] } };

const cache = new Map();
const jfetch = async (url, ms = 5000, opts = {}) => {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(url, { ...opts, signal: c.signal }); return r; }
  finally { clearTimeout(t); }
};

async function enrich(domain) {
  domain = String(domain || '').toLowerCase().trim().replace(/^https?:\/\//, '').split('/')[0];
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain)) { const e = new Error('invalid domain'); e.code = 400; throw e; }
  if (cache.has(domain)) return cache.get(domain);
  const [mxR, txtR, rdapR, siteR] = await Promise.allSettled([
    jfetch(`https://dns.google/resolve?name=${domain}&type=MX`).then(r => r.json()),
    jfetch(`https://dns.google/resolve?name=${domain}&type=TXT`).then(r => r.json()),
    jfetch(`https://rdap.org/domain/${domain}`).then(r => r.ok ? r.json() : null),
    jfetch(`https://${domain}/`, 5000, { headers: { 'User-Agent': 'enrich-x402/1.0' } }).then(r => r.ok ? r.text() : ''),
  ]);
  const mx = mxR.status === 'fulfilled' ? ((mxR.value.Answer || []).map(a => String(a.data).split(' ').pop()).filter(Boolean)) : [];
  if (!mx.length && siteR.status !== 'fulfilled') { const e = new Error('no DNS'); e.code = 404; throw e; }
  const txt = txtR.status === 'fulfilled' ? ((txtR.value.Answer || []).map(a => a.data).join(' ').slice(0, 500)) : '';
  const rdap = rdapR.status === 'fulfilled' ? rdapR.value : null;
  const registrar = rdap ? String(rdap.registrar || rdap.port43 || '').slice(0, 120) : '';
  const html = siteR.status === 'fulfilled' ? String(siteR.value).slice(0, 200000) : '';
  const emailSet = new Set();
  for (const m of html.matchAll(/mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g)) emailSet.add(m[1].toLowerCase());
  for (const m of html.matchAll(/(?<![a-zA-Z0-9._%+-])([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g)) emailSet.add(m[1].toLowerCase());
  const socials = { x: null, linkedin: null, github: null };
  const sx = html.match(/https?:\/\/(x\.com|twitter\.com)\/[A-Za-z0-9_]{1,30}/); if (sx) socials.x = sx[0];
  const sl = html.match(/https?:\/\/(www\.)?linkedin\.com\/(company|in)\/[A-Za-z0-9_.-]{1,80}/); if (sl) socials.linkedin = sl[0];
  const sg = html.match(/https?:\/\/(www\.)?github\.com\/[A-Za-z0-9_.-]{1,60}/); if (sg) socials.github = sg[0];
  const title = (html.match(/<title[^>]*>([^<]{1,200})<\/title>/i) || [])[1] || '';
  const desc = (html.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']{1,300})/i) || [])[1] || '';
  const out = { domain, mx: mx.slice(0, 8), spf: txt.includes('spf') ? txt.slice(0, 300) : '', registrar, emails_found: [...emailSet].slice(0, 20), socials, site_meta: { title: title.trim(), description: desc.trim() }, sources: ['doh', 'rdap', 'fetch'], upstream_cost_usd: '0.00' };
  cache.set(domain, out);
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return out;
}

function payBody(url) {
  return {
    x402Version: 2,
    error: 'Payment required',
    resource: { url, description: DESC, mimeType: 'application/json' },
    accepts: [{ scheme: 'exact', network: NETWORK, amount: AMOUNT, asset: ASSET, payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' } }],
    extensions: { bazaar: BAZAAR_EXT },
  };
}

export const handler = async (event) => {
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: JSON.stringify({ error: 'method not allowed' }) };
  const proto = event.headers['x-forwarded-proto'] || 'https';
  const host = event.headers['x-forwarded-host'] || event.headers.host;
  const url = `${proto}://${host}/.netlify/functions/enrich${event.rawQuery ? '?' + event.rawQuery : ''}`;
  const payment = event.headers['x-payment'] || event.headers['X-Payment'];
  if (!payment) {
    const body = payBody(url);
    return { statusCode: 402, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Payment-Required': Buffer.from(JSON.stringify(body)).toString('base64') }, body: '{}' };
  }
  // verify via PayAI facilitator
  try {
    let payload;
    try { payload = JSON.parse(Buffer.from(payment, 'base64').toString('utf8')); }
    catch { payload = JSON.parse(payment); }
    const vr = await fetch('https://facilitator.payai.network/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x402Version: 2, paymentPayload: payload, paymentRequirements: { scheme: 'exact', network: NETWORK, maxAmountRequired: AMOUNT, asset: ASSET, payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' } } }),
    });
    const vj = await vr.json();
    if (!vj.isValid) throw new Error('invalid payment');
  } catch {
    const body = payBody(url);
    return { statusCode: 402, headers: { 'Content-Type': 'application/json', 'Payment-Required': Buffer.from(JSON.stringify(body)).toString('base64') }, body: '{}' };
  }
  try {
    const domain = (event.queryStringParameters || {}).domain;
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(await enrich(domain)) };
  } catch (e) { return { statusCode: e.code || 500, body: JSON.stringify({ error: e.message }) }; }
};
