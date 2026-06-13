// /api/parts — live parts pricing via the eBay Browse API.
// Returns { median, low, high, count } for a part query.
// Inert until EBAY_CLIENT_ID / EBAY_CLIENT_SECRET env vars are set in Vercel.
//
// Auth: eBay OAuth client-credentials (application token), cached in-memory.
// Scope: https://api.ebay.com/oauth/api_scope (Browse API public access).

let cachedToken = null;
let tokenExpiry = 0;

async function getToken() {
  const id = process.env.EBAY_CLIENT_ID;
  const secret = process.env.EBAY_CLIENT_SECRET;
  if (!id || !secret) throw new Error('eBay credentials not configured');
  if (cachedToken && Date.now() < tokenExpiry - 60_000) return cachedToken;

  const basic = Buffer.from(`${id}:${secret}`).toString('base64');
  const r = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basic}`,
    },
    body: 'grant_type=client_credentials&scope=' +
          encodeURIComponent('https://api.ebay.com/oauth/api_scope'),
  });
  if (!r.ok) throw new Error('eBay token request failed: ' + r.status);
  const d = await r.json();
  cachedToken = d.access_token;
  tokenExpiry = Date.now() + (d.expires_in || 7200) * 1000;
  return cachedToken;
}

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export default async function handler(req, res) {
  const q = (req.query.q || '').toString().trim();
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');
  if (!q) return res.status(400).json({ error: 'missing q' });

  try {
    const token = await getToken();
    const url = 'https://api.ebay.com/buy/browse/v1/item_summary/search' +
      `?q=${encodeURIComponent(q)}` +
      '&category_ids=6028' +                 // eBay Motors > Parts & Accessories
      '&filter=buyingOptions:{FIXED_PRICE},conditions:{NEW}' +
      '&limit=50';
    const r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
      },
    });
    if (!r.ok) return res.status(502).json({ error: 'ebay search failed', status: r.status });
    const d = await r.json();
    const prices = (d.itemSummaries || [])
      .map(i => parseFloat(i.price && i.price.value))
      .filter(p => Number.isFinite(p) && p > 0)
      // trim obvious outliers (whole assemblies, lots) using IQR-ish bounds
      .sort((a, b) => a - b);
    if (prices.length < 3) return res.json({ median: 0, count: prices.length });

    const lo = prices[Math.floor(prices.length * 0.15)];
    const hi = prices[Math.floor(prices.length * 0.85)];
    const core = prices.filter(p => p >= lo && p <= hi);
    return res.json({
      median: Math.round(median(core)),
      low: Math.round(lo),
      high: Math.round(hi),
      count: core.length,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
