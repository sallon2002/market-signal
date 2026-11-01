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
  // 장중이면 마지막 종가가 곧 현재가라, 하루 전 종가(ago(1))와 비교하면 장중·장마감 모두 일간 등락이 된다
  return { price: round(price), dayAgo: round(ago(1)), sma20: sma(20), sma50: sma(50), sma200: sma(200), weekAgo: round(ago(5)), monthAgo: round(ago(21)) };
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

// ---------- 2차 조사로 더한 지표 ----------

/** 야후 종가 배열만 */
async function closes(symbol, range = "1y") {
  const json = JSON.parse(await text(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`));
  return json.chart.result[0].indicators.quote[0].close.filter((c) => typeof c === "number");
}

/** 두 종목 비율의 200일 · 50일선 대비 위치 (%) */
async function ratio(a, b) {
  const [x, y] = await Promise.all([closes(a), closes(b)]);
  const n = Math.min(x.length, y.length);
  const r = x.slice(-n).map((v, i) => v / y.slice(-n)[i]);
  const now = r[r.length - 1];
  return { vs200: round((now / avg(r.slice(-200)) - 1) * 100, 2), vs50: round((now / avg(r.slice(-50)) - 1) * 100, 2) };
}

// S&P 500 구성 종목 중 200일선 위에 있는 비율 — 야후 spark 로 20개씩
async function breadth() {
  const csv = await text("https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv");
  const syms = csv.trim().split(/\r?\n/).slice(1).map((l) => l.split(",")[0].replace(".", "-"));
  let above = 0;
  let total = 0;
  for (let i = 0; i < syms.length; i += 20) {
    const batch = syms.slice(i, i + 20);
    try {
      const json = JSON.parse(await text(`https://query1.finance.yahoo.com/v7/finance/spark?symbols=${batch.join(",")}&range=1y&interval=1d`));
      for (const s of json.spark?.result ?? []) {
        const c = (s.response?.[0]?.indicators?.quote?.[0]?.close ?? []).filter((v) => v != null);
        if (c.length < 200) continue;
        total++;
        if (c[c.length - 1] > avg(c.slice(-200))) above++;
      }
    } catch {}
  }
  if (total < 400) throw new Error(`종목 ${total}개만 받음`);
  return { pct: round((above / total) * 100, 1), total };
}

// 실업수당 청구 4주 평균이 52주 최저보다 얼마나 올라왔나
async function claimsTrend() {
  const rows = await fred("IC4WSA");
  const last = rows[rows.length - 1];
  const low = Math.min(...rows.slice(-52).map((r) => r.v));
  return { date: last.date, value: last.v, low, vsLow: round((last.v / low - 1) * 100, 1) };
}

// 미국 순유동성 = 연준 총자산 − 재무부 계좌(TGA) − 역레포, 13주 변화 (십억 달러)
async function netLiquidity() {
  const [w, t, r] = await Promise.all([fred("WALCL"), fred("WTREGEN"), fred("RRPONTSYD")]);
  const tga = new Map(t.map((x) => [x.date, x.v]));
  const rrp = new Map(r.map((x) => [x.date, x.v]));
  const rrpOn = (date) => {
    for (let k = 0; k < 7; k++) {
      const d = new Date(Date.parse(date) - k * 86_400_000).toISOString().slice(0, 10);
      if (rrp.has(d)) return rrp.get(d);
    }
    return null;
  };
  const series = w
    .map((x) => ({ date: x.date, nl: tga.has(x.date) && rrpOn(x.date) !== null ? (x.v - tga.get(x.date) - rrpOn(x.date) * 1000) / 1000 : null }))
    .filter((x) => x.nl !== null);
  const last = series[series.length - 1];
  const past = series[series.length - 14];
  return { date: last.date, value: round(last.nl, 0), change13w: round(last.nl - past.nl, 0) };
}

// Kalshi 경기침체 시장 (NBER 판정 기준, 내년)
async function recession() {
  const year = new Date().getUTCFullYear() + 1;
  const json = JSON.parse(await text(`https://api.elections.kalshi.com/trade-api/v2/markets?event_ticker=KXRECSSNBER-${String(year).slice(2)}`));
  const m = json.markets[0];
  const p = Number(m.last_price_dollars) || (Number(m.yes_bid_dollars || 0) + Number(m.yes_ask_dollars || 0)) / 2;
  return { year, prob: round(p * 100, 1) };
}

// 거래소 순유출입 30일 + 해시 리본 (CoinMetrics 무료)
async function chainFlows() {
  const json = JSON.parse(
    await text("https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=btc&metrics=HashRate,FlowInExNtv,FlowOutExNtv&frequency=1d&page_size=200&paging_from=end")
  );
  const d = json.data;
  const netflow = d.slice(-30).reduce((s, x) => s + (Number(x.FlowInExNtv) - Number(x.FlowOutExNtv)), 0);
  const hr = d.map((x) => Number(x.HashRate));
  const ribbon = (end) => avg(hr.slice(end - 30, end)) / avg(hr.slice(end - 60, end));
  const ratios = [];
  for (let k = 60; k >= 0; k--) ratios.push(ribbon(hr.length - k));
  const now = ratios[ratios.length - 1];
  // 최근 60일 안에 30일선이 60일선 아래(채굴자 항복)였다가 다시 올라섰으면 매수 신호
  const recovered = now > 1 && ratios.some((r) => r < 1);
  return { date: d[d.length - 1].time.slice(0, 10), netflow30d: round(netflow, 0), ribbon: round(now, 4), capitulation: now < 1, recovered };
}

// OKX 선물 미결제약정 30일 변화 + 롱숏 계정 비율
async function leverage() {
  const [oi, ls, px] = await Promise.all([
    text("https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-volume?ccy=BTC&period=1D").then(JSON.parse),
    text("https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=BTC&period=1D").then(JSON.parse),
    closes("BTC-USD", "3mo"),
  ]);
  // rubik 은 최신이 앞에 온다: [ts, 미결제약정(USD), 거래대금]
  const oiNow = Number(oi.data[0][1]);
  const oiPast = Number(oi.data[30][1]);
  const priceChg = (px[px.length - 1] / px[px.length - 31] - 1) * 100;
  return { oi: round(oiNow / 1e9, 2), oiChange30d: round((oiNow / oiPast - 1) * 100, 1), priceChange30d: round(priceChg, 1), longShort: round(Number(ls.data[0][1]), 2) };
}

// 데리비트 옵션: 약 30일 만기에서 10% 외가격 풋 IV − 콜 IV, DVOL
async function options() {
  const book = JSON.parse(await text("https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option")).result;
  const MON = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
  const parsed = book
    .map((o) => {
      const m = o.instrument_name.match(/^BTC-(\d{1,2})([A-Z]{3})(\d{2})-(\d+)-([CP])$/);
      if (!m || !o.mark_iv) return null;
      return { exp: Date.UTC(2000 + Number(m[3]), MON[m[2]], Number(m[1]), 8), label: `${m[1]}${m[2]}${m[3]}`, strike: Number(m[4]), type: m[5], iv: o.mark_iv, spot: o.underlying_price };
    })
    .filter(Boolean);
  const target = Date.now() + 30 * 86_400_000;
  const exp = [...new Set(parsed.map((o) => o.exp))].sort((a, b) => Math.abs(a - target) - Math.abs(b - target))[0];
  const chain = parsed.filter((o) => o.exp === exp);
  const spot = chain[0].spot;
  const nearest = (type, k) => chain.filter((o) => o.type === type).sort((a, b) => Math.abs(a.strike - k) - Math.abs(b.strike - k))[0];
  const put = nearest("P", spot * 0.9);
  const call = nearest("C", spot * 1.1);
  const now = Date.now();
  const dvol = JSON.parse(
    await text(`https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC&resolution=1D&start_timestamp=${now - 5 * 86_400_000}&end_timestamp=${now}`)
  ).result.data;
  return { expiry: chain[0].label, putIv: round(put.iv, 1), callIv: round(call.iv, 1), skew: round(put.iv - call.iv, 1), dvol: round(dvol[dvol.length - 1][4], 1) };
}

// 실질 기준금리 = 실효 연방기금금리 − CPI 전년비
async function realFedFunds() {
  const [dff, cpiRows] = await Promise.all([fred("DFF"), fred("CPIAUCSL")]);
  const yoy = (cpiRows[cpiRows.length - 1].v / cpiRows[cpiRows.length - 13].v - 1) * 100;
  const ff = dff[dff.length - 1].v;
  return { ff, cpi: round(yoy, 2), real: round(ff - yoy, 2) };
}

// 커브 국면: 4주 동안 2년물 · 10년물이 어떻게 움직였나
async function curveRegime() {
  const [two, ten, spread] = await Promise.all([fred("DGS2"), fred("DGS10"), fred("T10Y2Y")]);
  const chg = (rows) => round(rows[rows.length - 1].v - rows[rows.length - 21].v, 2);
  return { twoChg: chg(two), tenChg: chg(ten), spread: spread[spread.length - 1].v, spreadChg: chg(spread) };
}

// 최근 10년 · 30년물 입찰 수요 (TreasuryDirect)
async function auctionDemand() {
  const [notes, bonds] = await Promise.all(
    ["Note", "Bond"].map((type) => text(`https://www.treasurydirect.gov/TA_WS/securities/auctioned?format=json&type=${type}&days=120`).then(JSON.parse))
  );
  const pick = (list, term) =>
    list.filter((a) => a.securityTerm.startsWith(term) && a.bidToCoverRatio).sort((a, b) => (b.auctionDate ?? b.competitiveAuctionCloseDate).localeCompare(a.auctionDate ?? a.competitiveAuctionCloseDate))[0];
  const shape = (a) => ({
    date: (a.auctionDate ?? a.competitiveAuctionCloseDate).slice(0, 10),
    term: a.securityTerm,
    bidToCover: round(Number(a.bidToCoverRatio), 2),
    dealers: round((Number(a.primaryDealersCompetitiveParAwarded) / Number(a.offeringAmount)) * 100, 1),
    indirect: round((Number(a.indirectBiddersCompetitiveParAwarded) / Number(a.offeringAmount)) * 100, 1),
  });
  const ten = pick(notes, "9-Year") ?? pick(notes, "10-Year");
  const thirty = pick(bonds, "29-Year") ?? pick(bonds, "30-Year");
  return { ten: ten && shape(ten), thirty: thirty && shape(thirty) };
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
    breadth,
    claimsTrend,
    netLiquidity,
    recession,
    riskOn: async () => ({ discretionary: await ratio("XLY", "XLP"), smallCap: await ratio("IWM", "SPY") }),
    copperGold: () => ratio("HG=F", "GC=F"),
    oil: () => yahoo("CL=F"),
    fiveYFiveY: () => fredLatest("T5YIFR", 20),
    chainFlows,
    leverage,
    options,
    realFedFunds,
    curveRegime,
    auctionDemand,
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

  await require("./calendar").main();
}

main();
