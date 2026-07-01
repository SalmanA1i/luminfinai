// Vercel Edge Function — secure proxy to Twelve Data
// Holds the API key server-side and caches responses to respect rate limits.
//
// Supported types (via ?type=):
//   quote        1 credit   — single or comma-separated symbols (batched)
//   price        1 credit
//   time_series  1 credit   — needs interval, outputsize
//   profile      10 credits — cached 24h
//   dividends    20 credits — cached 24h
//   stocks       1 credit   — full symbol list for an exchange, cached 24h
//   ipo          40 credits — upcoming IPO calendar, cached 12h
//
// Examples:
//   /api/market?type=quote&symbol=AAPL,MSFT,NVDA
//   /api/market?type=stocks&exchange=PSX
//   /api/market?type=stocks&country=Singapore
//   /api/market?type=ipo

export const config = { runtime: 'edge' };

const CACHE = new Map();
const TTL = {
  quote: 60_000,          // 1 min
  price: 60_000,
  time_series: 300_000,   // 5 min
  profile: 86_400_000,    // 24 h
  dividends: 86_400_000,  // 24 h
  stocks: 86_400_000,     // 24 h — the list of what exists barely changes
  ipo: 43_200_000,        // 12 h
  news: 1_800_000         // 30 min — company press releases
};

function cacheGet(key){
  const hit = CACHE.get(key);
  if(hit && Date.now() < hit.exp) return hit.val;
  CACHE.delete(key);
  return null;
}
function cacheSet(key, val, ttl){
  CACHE.set(key, { val, exp: Date.now() + (ttl || 60_000) });
}

export default async function handler(req){
  const KEY = process.env.TDKEY;
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
  if(req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  if(!KEY){
    return new Response(JSON.stringify({ error: 'no_key', message: 'TDKEY is not set in environment variables.' }), { status: 200, headers: cors });
  }

  try{
    const url = new URL(req.url);
    const type = (url.searchParams.get('type') || 'quote').toLowerCase();
    const symbol = url.searchParams.get('symbol') || '';
    const exchange = url.searchParams.get('exchange') || '';
    const country = url.searchParams.get('country') || '';
    const interval = url.searchParams.get('interval') || '1day';
    const outputsize = url.searchParams.get('outputsize') || '30';

    const allowed = ['quote','price','time_series','profile','dividends','stocks','ipo','news'];
    if(!allowed.includes(type)) return new Response(JSON.stringify({ error: 'bad_type' }), { status: 200, headers: cors });

    // Symbol required for everything except stocks/ipo
    if(!symbol && !['stocks','ipo'].includes(type)){
      return new Response(JSON.stringify({ error: 'no_symbol' }), { status: 200, headers: cors });
    }

    const cacheKey = `${type}:${symbol}:${exchange}:${interval}:${outputsize}:${country}`;
    const cached = cacheGet(cacheKey);
    if(cached) return new Response(JSON.stringify({ ...cached, cached: true }), { status: 200, headers: cors });

    // Map our type → Twelve Data path
    const pathMap = { ipo: 'ipo_calendar', news: 'press_releases' };
    const tdPath = pathMap[type] || type;

    const td = new URL(`https://api.twelvedata.com/${tdPath}`);
    td.searchParams.set('apikey', KEY);
    if(symbol) td.searchParams.set('symbol', symbol);
    if(exchange) td.searchParams.set('exchange', exchange);
    if(country) td.searchParams.set('country', country);
    if(type === 'time_series'){ td.searchParams.set('interval', interval); td.searchParams.set('outputsize', outputsize); }
    if(type === 'dividends'){ td.searchParams.set('range', '1y'); }
    if(type === 'stocks'){ td.searchParams.set('format', 'JSON'); td.searchParams.set('outputsize', '150'); }
    if(type === 'news'){ td.searchParams.set('outputsize', '3'); }

    const r = await fetch(td.toString(), { headers: { 'Accept': 'application/json' } });
    let data = await r.json();

    // Twelve Data error object
    if(data && data.status === 'error'){
      return new Response(JSON.stringify({ error: 'td_error', code: data.code, message: data.message }), { status: 200, headers: cors });
    }

    // Large exchanges (e.g. Hong Kong ~2600 stocks) return huge payloads that can
    // time out the function. Trim the /stocks list to a workable size server-side.
    if(type === 'stocks' && data && Array.isArray(data.data) && data.data.length > 150){
      data = { ...data, data: data.data.slice(0, 150), count: 150, _trimmed: true };
    }

    cacheSet(cacheKey, data, TTL[type]);
    return new Response(JSON.stringify({ ...data, cached: false }), { status: 200, headers: cors });

  }catch(e){
    return new Response(JSON.stringify({ error: 'proxy_error', message: String(e) }), { status: 200, headers: cors });
  }
}
