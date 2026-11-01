// 거시 지표 수집: node tools/collect.js
// 브라우저가 직접 못 부르는 출처(야후 · FRED · Kalshi)만 여기서 모아 data/macro.json 으로 남긴다.
// 코인 값(업비트 · 바이낸스 · 공포지수 · CoinMetrics · DefiLlama)은 화면이 직접 실시간으로 읽는다.
// GitHub Actions 가 30분마다 이 스크립트를 돌린 뒤 사이트를 다시 배포한다.
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "data", "macro.json");
const HEADERS = { "User-Agent": "Mozilla/5.0" };

async function text(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

const avg = (list) => list.reduce((s, v) => s + v, 0) / list.length;
const round = (n, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

// 야후 일봉 — 현재가, 이동평균, 며칠 전 값
async function yahoo(symbol, range = "1y") {
  const json = JSON.parse(await text(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`));
  const r = json.chart.result[0];
  const closes = r.indicators.quote[0].close.filter((c) => typeof c === "number");
  const price = r.meta.regularMarketPrice;
  const ago = (n) => closes[closes.length - 1 - n];
  const sma = (n) => (closes.length >= n ? round(avg(closes.slice(-n))) : null);
  return { price: round(price), sma20: sma(20), sma50: sma(50), sma200: sma(200), weekAgo: round(ago(5)), monthAgo: round(ago(21)) };
}

// FRED 시계열 — 최신값과 날짜, 비교용 과거값
async function fred(id) {
  const rows = (await text(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`))
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.split(","))
    .filter(([, v]) => v && v !== ".")
    .map(([date, v]) => ({ date, v: Number(v) }));
  return rows;
}

async function fredLatest(id, lookbackRows) {
  const rows = await fred(id);
  const last = rows[rows.length - 1];
  const past = rows[rows.length - 1 - lookbackRows];
  return { date: last.date, value: last.v, past: past ? past.v : null };
}

// CPI 전년비: 이번 달과 지난달
async function cpi() {
  const rows = await fred("CPIAUCSL");
  const yoy = (i) => round((rows[i].v / rows[i - 12].v - 1) * 100, 2);
  const last = rows.length - 1;
  return { month: rows[last].date.slice(0, 7), now: yoy(last), prev: yoy(last - 1) };
}

// Kalshi: 가장 가까운 FOMC 의 인상 · 동결 · 인하 확률
async function fomc() {
  const json = JSON.parse(
    await text("https://api.elections.kalshi.com/trade-api/v2/events?series_ticker=KXFEDDECISION&status=open&with_nested_markets=true")
  );
  const now = Date.now();
  const next = json.events
    .filter((e) => e.markets.length && Date.parse(e.markets[0].close_time) > now)
    .sort((a, b) => Date.parse(a.markets[0].close_time) - Date.parse(b.markets[0].close_time))[0];
  const price = (m) => Number(m.last_price_dollars) || (Number(m.yes_bid_dollars || 0) + Number(m.yes_ask_dollars || 0)) / 2;
  const sum = (prefix) => round(next.markets.filter((m) => m.yes_sub_title.startsWith(prefix)).reduce((s, m) => s + price(m), 0) * 100, 1);
  return { event: next.event_ticker, decidesAt: next.markets[0].close_time, hike: sum("Hike"), hold: sum("Fed maintains"), cut: sum("Cut") };
}

// 비트코인 온체인 — CoinMetrics 무료 API 로 직접 계산
//   MVRV Z = (시가총액 − 실현 시가총액) / 시가총액 표준편차, 실현 시가총액 = 시총 / MVRV
//   실현 가격 = 실현 시가총액 / 유통량, 200주 이동평균 = 최근 1400일 평균
//   퓨엘 멀티플 = 오늘 채굴 수익 / 365일 평균
async function onchain() {
  const url =
    "https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=btc&metrics=CapMVRVCur,CapMrktCurUSD,PriceUSD,SplyCur,IssTotUSD&frequency=1d&page_size=10000";
  const rows = JSON.parse(await text(url))
    .data.map((r) => ({
      date: r.time.slice(0, 10),
      mvrv: Number(r.CapMVRVCur),
      mc: Number(r.CapMrktCurUSD),
      price: Number(r.PriceUSD),
      supply: Number(r.SplyCur),
      iss: Number(r.IssTotUSD),
    }))
    .filter((r) => r.mvrv > 0 && r.mc > 0 && r.price > 0);
  const last = rows[rows.length - 1];
  const mean = avg(rows.map((r) => r.mc));
  const sd = Math.sqrt(avg(rows.map((r) => (r.mc - mean) ** 2)));
  const realizedCap = last.mc / last.mvrv;
  const issLastYear = rows.slice(-365).map((r) => r.iss).filter((v) => v > 0);
  return {
    date: last.date,
    price: round(last.price, 0),
    mvrv: round(last.mvrv, 3),
    mvrvZ: round((last.mc - realizedCap) / sd, 2),
    realizedPrice: round(realizedCap / last.supply, 0),
    wma200: round(avg(rows.slice(-1400).map((r) => r.price)), 0),
    puell: round(last.iss / avg(issLastYear), 2),
  };
}

// 스테이블코인 전체 유통량 — 30일 전과 비교
async function stablecoins() {
  const rows = JSON.parse(await text("https://stablecoins.llama.fi/stablecoincharts/all"));
  const v = (r) => r.totalCirculatingUSD.peggedUSD;
  const last = rows[rows.length - 1];
  const past = rows[rows.length - 31];
  return { date: new Date(Number(last.date) * 1000).toISOString().slice(0, 10), total: round(v(last) / 1e9, 1), change30d: round((v(last) / v(past) - 1) * 100, 2) };
}

async function main() {
  const jobs = {
    sp500: () => yahoo("^GSPC"),
    nasdaq: () => yahoo("^IXIC"),
    vix: () => yahoo("^VIX", "3mo"),
    vix3m: () => yahoo("^VIX3M", "3mo"),
    move: () => yahoo("^MOVE", "3mo"),
    us10y: () => yahoo("^TNX", "6mo"),
    usdkrw: () => yahoo("KRW=X", "3mo"),
    dxy: () => yahoo("DX-Y.NYB", "6mo"),
    tlt: () => yahoo("TLT"),
    hySpread: () => fredLatest("BAMLH0A0HYM2", 20), // 일간, 약 4주 전과 비교
    curve10y3m: () => fredLatest("T10Y3M", 20),
    sahm: () => fredLatest("SAHMREALTIME", 3),
    nfci: () => fredLatest("NFCI", 4), // 주간, 4주 전과 비교
    realYield: () => fredLatest("DFII10", 20),
    breakeven: () => fredLatest("T10YIE", 20),
    termPremium: () => fredLatest("THREEFYTP10", 20),
    claims: () => fredLatest("ICSA", 4),
    cpi,
    fomc,
    onchain,
    stablecoins,
  };

  // 하나가 실패해도 나머지는 남긴다 — 직전 값이 있으면 그걸 이어 쓴다
  let previous = {};
  try {
    previous = JSON.parse(fs.readFileSync(OUT, "utf8")).values || {};
  } catch {}

  const values = {};
  const failed = [];
  await Promise.all(
    Object.entries(jobs).map(async ([key, job]) => {
      try {
        values[key] = await job();
      } catch (err) {
        failed.push(key);
        if (previous[key]) values[key] = { ...previous[key], stale: true };
        console.error(`✗ ${key}: ${err.message}`);
      }
    })
  );

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ collectedAt: new Date().toISOString(), failed, values }, null, 1));
  console.log(`macro.json 저장 — ${Object.keys(values).length}개, 실패 ${failed.length}개`);
}

main();
