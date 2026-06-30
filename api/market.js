// Vercel Edge Function — secure proxy to Twelve Data
// Holds the API key server-side and caches responses to respect rate limits.
// Endpoints proxied: /quote, /price, /time_series, /profile, /dividends
// Usage from the app:  /api/market?type=quote&symbol=AAPL
//                      /api/market?type=quote&symbol=ENGRO&exchange=PSX
//                      /api/market?type=time_series&symbol=AAPL&interval=1day&outputsize=30
//                      /api/market?type=profile&symbol=AAPL

export const config = { runtime: 'edge' };

// Simple in-memory cache (per edge instance). Quotes cached 60s, profiles 24h.
const CACHE = new Map();
const TTL = { quote: 60_000, price: 60_000, time_series: 300_000, profile: 86_400_000, dividends: 86_400_000 };

function cacheGet(key){
  const hit = CACHE.get(key);
  if(hit && Date.now() < hit.exp) return hit.val;
  CACHE.delete(key);
  return null;
}
function cacheSet(key, val, ttl){
  CACHE.set(key, { val, exp: Date.now() + (ttl||60_000) });
}

export default async function handler(req){
  const KEY = process.env.TWELVEDATA_API_KEY;
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
  if(req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  if(!KEY){
    return new Response(JSON.stringify({ error: 'no_key', message: 'TWELVEDATA_API_KEY is not set in environment variables.' }), { status: 200, headers: cors });
  }

  try{
    const url = new URL(req.url);
    const type = (url.searchParams.get('type') || 'quote').toLowerCase();
    const symbol = url.searchParams.get('symbol');
    if(!symbol) return new Response(JSON.stringify({ error: 'no_symbol' }), { status: 200, headers: cors });

    const allowed = ['quote','price','time_series','profile','dividends'];
    if(!allowed.includes(type)) return new Response(JSON.stringify({ error: 'bad_type' }), { status: 200, headers: cors });

    // Build cache key from all relevant params
    const exchange = url.searchParams.get('exchange') || '';
    const interval = url.searchParams.get('interval') || '1day';
    const outputsize = url.searchParams.get('outputsize') || '30';
    const country = url.searchParams.get('country') || '';
    const cacheKey = `${type}:${symbol}:${exchange}:${interval}:${outputsize}:${country}`;

    const cached = cacheGet(cacheKey);
    if(cached) return new Response(JSON.stringify({ ...cached, cached: true }), { status: 200, headers: cors });

    // Build the Twelve Data request
    const td = new URL(`https://api.twelvedata.com/${type}`);
    td.searchParams.set('symbol', symbol);
    td.searchParams.set('apikey', KEY);
    if(exchange) td.searchParams.set('exchange', exchange);
    if(country) td.searchParams.set('country', country);
    if(type === 'time_series'){ td.searchParams.set('interval', interval); td.searchParams.set('outputsize', outputsize); }
    if(type === 'dividends'){ td.searchParams.set('range', '1y'); }

    const r = await fetch(td.toString(), { headers: { 'Accept': 'application/json' } });
    const data = await r.json();

    // Twelve Data signals errors with status:"error" and a code
    if(data && data.status === 'error'){
      // Don't cache errors. Surface a clean message.
      return new Response(JSON.stringify({ error: 'td_error', code: data.code, message: data.message }), { status: 200, headers: cors });
    }

    cacheSet(cacheKey, data, TTL[type]);
    return new Response(JSON.stringify({ ...data, cached: false }), { status: 200, headers: cors });

  }catch(e){
    return new Response(JSON.stringify({ error: 'proxy_error', message: String(e) }), { status: 200, headers: cors });
  }
}
