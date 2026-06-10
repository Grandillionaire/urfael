# Free APIs Urfael can use

When the user wants live info, call these via `curl` (Bash tool). Keys (4 of them) live in
`~/.claude/urfael/api-keys.env` — read that file for the value; never print keys aloud.
No-key APIs work immediately. Always set a `User-Agent` where noted.

## No key needed (use immediately)
- **Weather — Open-Meteo:** `curl 'https://api.open-meteo.com/v1/forecast?latitude=51.51&longitude=-0.13&current=temperature_2m,weather_code'` (London coords shown; change to yours). ~10k calls/day.
- **Knowledge — Wikipedia:** `curl -H 'User-Agent: Urfael/1.0' 'https://en.wikipedia.org/api/rest_v1/page/summary/<Topic>'`
- **FX rates — Frankfurter:** `curl 'https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD'` (ECB rates, no quota).
- **Geocoding — Nominatim:** `curl -H 'User-Agent: Urfael/1.0' 'https://nominatim.openstreetmap.org/search?q=London&format=json&limit=1'` (max 1 req/sec).
- **Stocks (quick) — Stooq:** `curl 'https://stooq.com/q/l/?s=aapl.us&f=sd2t2ohlcv&h&e=csv'`

## Free key needed (from ~/.claude/urfael/api-keys.env)
- **Web search — Tavily** (the main search tool): `curl -s https://api.tavily.com/search -H 'Content-Type: application/json' -d '{"api_key":"'"$TAVILY_API_KEY"'","query":"...","max_results":5}'` — 1,000 searches/mo. Get key: tavily.com.
- **Crypto — CoinGecko:** `curl 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&x_cg_demo_api_key='"$COINGECKO_DEMO_KEY"` — 10k/mo. Get key: coingecko.com/en/api.
- **News — NewsData.io:** `curl 'https://newsdata.io/api/1/latest?apikey='"$NEWSDATA_API_KEY"'&q=...&language=en'` — 200 credits/day. Get key: newsdata.io.
- **Stocks — Finnhub:** `curl 'https://finnhub.io/api/v1/quote?symbol=AAPL&token='"$FINNHUB_API_KEY"` — 60 req/min. Get key: finnhub.io.

To load keys in a shell call: `set -a; . ~/.claude/urfael/api-keys.env; set +a` then curl.
Prefer Tavily for "search the web"; Open-Meteo/Wikipedia/Frankfurter need no setup.
