// 매수 신호등 — 미국 주식 · 코인 · 미 장기채
// 거시 지표는 data/macro.json(30분마다 수집), 코인 시세는 여기서 직접 30초마다 읽는다.
// 지표마다 초록·노랑·빨강을 매기고, (초록 + 노랑×0.5) ÷ 지표 수 로 0~100 점수를 낸다.
// 투자 자문이 아니라 미리 정해 둔 규칙을 기계적으로 적용하는 점검표다.

const LIVE_MS = 30_000;
const MACRO_MS = 5 * 60_000;

const state = { macro: null, manual: null, events: [], live: {}, liveAt: null, tab: location.hash.slice(1) || "all" };

// ---------- 작은 도구 ----------

const $ = (sel) => document.querySelector(sel);
const fmt = (n, d = 0) => n.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
const signed = (n, d = 1) => `${n > 0 ? "+" : ""}${n.toFixed(d)}`;
const dev = (a, b) => (a / b - 1) * 100;
const todayKst = () => new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
const md = (date) => date.slice(5).replace("-", "/");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

async function getJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

/** 문턱값으로 신호 매기기: 낮을수록 좋으면 low(g, y), 높을수록 좋으면 high(g, y) */
const low = (v, g, y) => (v <= g ? "g" : v <= y ? "y" : "r");
const high = (v, g, y) => (v >= g ? "g" : v >= y ? "y" : "r");

// ---------- 실시간 코인 값 ----------

async function loadLive() {
  const tasks = {
    btc: async () => {
      const [t, k] = await Promise.all([
        getJson("https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT"),
        getJson("https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=4"),
      ]);
      // 마지막 봉은 진행 중인 오늘이라 빼고 끝난 3일 종가만
      return { price: Number(t.lastPrice), change: Number(t.priceChangePercent), closes: k.slice(0, -1).map((c) => Number(c[4])) };
    },
    upbit: async () => (await getJson("https://api.upbit.com/v1/ticker?markets=KRW-BTC"))[0].trade_price,
    fng: async () => {
      const d = (await getJson("https://api.alternative.me/fng/?limit=1")).data[0];
      return { value: Number(d.value), label: d.value_classification };
    },
    funding: async () => Number((await getJson("https://www.okx.com/api/v5/public/funding-rate?instId=BTC-USDT-SWAP")).data[0].fundingRate) * 100,
  };
  await Promise.all(
    Object.entries(tasks).map(async ([key, task]) => {
      try {
        state.live[key] = await task();
      } catch {
        // 실패하면 직전 값을 그대로 둔다
      }
    })
  );
  // 바이낸스가 막힌 곳에서는 코인베이스 현물가로 대신
  if (!state.live.btc) {
    try {
      const d = await getJson("https://api.coinbase.com/v2/prices/BTC-USD/spot");
      state.live.btc = { price: Number(d.data.amount), closes: [] };
    } catch {}
  }
  state.liveAt = new Date();
}

async function loadMacro() {
  const [macro, manual, events, calendar] = await Promise.allSettled([
    getJson("data/macro.json"),
    getJson("data/manual.json"),
    getJson("data/events.json"),
    getJson("data/calendar.json"),
  ]);
  if (macro.status === "fulfilled") state.macro = macro.value;
  if (manual.status === "fulfilled") state.manual = manual.value;
  if (events.status === "fulfilled") state.events = events.value;
  if (calendar.status === "fulfilled") state.calendar = calendar.value.events ?? [];
}

// ---------- 지표 ----------

/** 값이 없거나 계산이 깨져도 그 지표만 「확인 불가」로 두고 나머지는 계속 */
function ind(base, build) {
  try {
    const out = build();
    if (!out) throw new Error("no data");
    return { ...base, ...out };
  } catch {
    return { ...base, value: "—", light: null, detail: "아직 값을 불러오지 못했습니다" };
  }
}

const M = (key) => {
  const v = state.macro?.values?.[key];
  if (!v) throw new Error(`no ${key}`);
  return v;
};

// 여러 자산이 함께 쓰는 지표
const shared = {
  fomc: () =>
    ind({ key: "fomc", name: "다음 FOMC 인상 확률", hint: "초록 40% 미만 · 노랑 40~70% · 빨강 70% 이상", source: "Kalshi 예측시장" }, () => {
      const f = M("fomc");
      const month = Number(f.decidesAt.slice(5, 7));
      return { value: `${Math.round(f.hike)}%`, light: f.hike < 40 ? "g" : f.hike < 70 ? "y" : "r", detail: `${month}월 회의 · 동결 ${Math.round(f.hold)}% · 인하 ${Math.round(f.cut)}%` };
    }),
  cpi: () =>
    ind({ key: "cpi", name: "물가 방향 (CPI 전년비)", hint: "전월보다 0.1%p 이상 내리면 초록, 오르면 빨강", source: "FRED CPIAUCSL" }, () => {
      const c = M("cpi");
      const diff = c.now - c.prev;
      const light = diff <= -0.1 ? "g" : diff < 0.1 ? "y" : "r";
      return { value: `${c.now.toFixed(1)}% ${{ g: "둔화", y: "보합", r: "상승" }[light]}`, light, detail: `${c.month} 기준 · 전월 ${c.prev.toFixed(1)}%` };
    }),
  ndx: () =>
    ind({ key: "ndx", name: "나스닥 단기 추세", hint: "20일선 0.5% 위면 초록 · 근처 노랑 · 0.5% 아래 빨강", source: "야후 ^IXIC" }, () => {
      const n = M("nasdaq");
      const d = dev(n.price, n.sma20);
      return { value: fmt(n.price), light: d >= 0.5 ? "g" : d > -0.5 ? "y" : "r", detail: `20일선 ${fmt(n.sma20)} 대비 ${signed(d)}%` };
    }),
  event: () =>
    ind({ key: "event", name: "큰 이벤트 (★4 이상)", hint: "3일 안에 없으면 초록 · 있으면 노랑 · 당일이면 빨강 (정지)", source: "자동 일정 + data/events.json" }, () => {
      const first = upcoming().find((e) => e.stars >= BIG_STARS);
      const light = first?.dday === 0 ? "r" : first && first.dday <= 3 ? "y" : "g";
      return { value: first ? (first.dday === 0 ? "오늘" : `D-${first.dday}`) : "없음", light, detail: first ? `${first.name} ${"★".repeat(first.stars)}` : "등록된 일정 없음" };
    }),
};

// 신호등에 반영하는 이벤트 중요도 기준 — 그 아래는 목록에만 보인다
const BIG_STARS = 4;

/** 자동 수집 일정(data/calendar.json) + 손으로 넣은 일정(data/events.json). 같은 날 같은 이름이면 손으로 넣은 쪽이 이긴다 */
function upcoming() {
  const today = todayKst();
  const merged = new Map();
  for (const e of state.calendar ?? []) merged.set(`${e.date}|${e.name}`, e);
  for (const e of state.events) merged.set(`${e.date}|${e.name}`, { stars: 3, ...e });
  return [...merged.values()]
    .map((e) => ({ ...e, dday: daysBetween(today, e.date) }))
    .filter((e) => e.dday >= 0)
    .sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));
}

const ASSETS = [
  {
    id: "stocks",
    code: "SEC-01 EQUITY",
    label: "미국 주식",
    sub: "S&P 500 · 나스닥",
    indicators: () => [
      ind({ key: "sp200", name: "S&P 500 장기 추세", hint: "200일선 1% 위면 초록 · ±1% 노랑 · 1% 아래 빨강", source: "야후 ^GSPC" }, () => {
        const s = M("sp500");
        const d = dev(s.price, s.sma200);
        return { value: fmt(s.price), light: d >= 1 ? "g" : d > -1 ? "y" : "r", detail: `200일선 ${fmt(s.sma200)} 대비 ${signed(d)}% · 50일선 ${fmt(s.sma50)}` };
      }),
      shared.ndx(),
      ind({ key: "hy", name: "하이일드 신용 스프레드", hint: "초록 4%p 미만이고 4주 새 +0.5%p 안 넘게 · 노랑 4~5 · 빨강 5 초과 또는 급등 (정지)", source: "FRED BAMLH0A0HYM2" }, () => {
        const h = M("hySpread");
        const chg = h.past !== null ? h.value - h.past : 0;
        const light = h.value > 5 || chg >= 1 ? "r" : h.value >= 4 || chg >= 0.5 ? "y" : "g";
        return { value: `${h.value.toFixed(2)}%p`, light, detail: `4주 전 대비 ${signed(chg, 2)}%p · ${md(h.date)}` };
      }),
      ind({ key: "vixts", name: "VIX 기간 구조", hint: "VIX÷VIX3M 0.9 미만 초록 · 0.9~1.0 노랑 · 1.0 초과 빨강 (급성 공포)", source: "야후 ^VIX · ^VIX3M" }, () => {
        const r = M("vix").price / M("vix3m").price;
        return { value: r.toFixed(2), light: r < 0.9 ? "g" : r <= 1 ? "y" : "r", detail: `VIX ${M("vix").price.toFixed(1)} · VIX3M ${M("vix3m").price.toFixed(1)}` };
      }),
      ind({ key: "nfci", name: "금융여건지수 (NFCI)", hint: "초록 -0.3 미만 (완화) · 노랑 -0.3~0 · 빨강 0 초과 (긴축)", source: "FRED NFCI (주간)" }, () => {
        const n = M("nfci");
        return { value: n.value.toFixed(2), light: n.value < -0.3 ? "g" : n.value <= 0 ? "y" : "r", detail: `4주 전 ${n.past.toFixed(2)} · ${md(n.date)}` };
      }),
      ind({ key: "sahm", name: "샴 룰 (경기침체 경보)", hint: "초록 0.3 미만 · 노랑 0.3~0.5 · 빨강 0.5 이상", source: "FRED SAHMREALTIME (월간)" }, () => {
        const s = M("sahm");
        return { value: s.value.toFixed(2), light: low(s.value, 0.29, 0.49), detail: `${s.date.slice(0, 7)} 기준` };
      }),
      ind({ key: "y10s", name: "금리 부담 (미 10년물)", hint: "초록 4.5% 미만 · 노랑 4.5~5.0% · 빨강 5.0% 초과", source: "야후 ^TNX" }, () => {
        const t = M("us10y");
        return { value: `${t.price.toFixed(2)}%`, light: low(t.price, 4.5, 5.0), detail: `1주 전 ${t.weekAgo.toFixed(2)}%` };
      }),
      shared.fomc(),
      shared.cpi(),
      shared.event(),
    ],
    stop: (L) => (L.event === "r" ? "큰 이벤트 당일입니다." : L.hy === "r" ? "신용 스프레드가 위험 구간입니다. 신용 경색 때는 주식이 뒤따라 빠지곤 했습니다." : null),
  },
  {
    id: "crypto",
    code: "SEC-02 CRYPTO",
    label: "코인",
    sub: "비트코인 기준",
    live: true,
    indicators: () => [
      ind({ key: "btc", name: "BTC 가격", hint: "초록 85k 이상 3일 안착 · 노랑 70~85k · 빨강 70k 미만", source: "바이낸스 (실시간)" }, () => {
        const b = state.live.btc;
        if (!b) return null;
        const settled = b.price >= 85_000 && b.closes.length > 0 && b.closes.every((c) => c >= 85_000);
        return {
          value: `$${fmt(b.price)}`,
          light: settled ? "g" : b.price >= 70_000 ? "y" : "r",
          detail: b.closes.length ? `최근 3일 종가 ${b.closes.map((c) => `${(c / 1000).toFixed(1)}k`).join(" · ")}` : "코인베이스 현물가",
        };
      }),
      ind({ key: "mvrvz", name: "MVRV Z-점수", hint: "초록 0 미만 (역사적 바닥권) · 노랑 0~5 · 빨강 5 이상 (과열)", source: "CoinMetrics 무료 API" }, () => {
        const o = M("onchain");
        return { value: o.mvrvZ.toFixed(2), light: o.mvrvZ < 0 ? "g" : o.mvrvZ < 5 ? "y" : "r", detail: `MVRV ${o.mvrv.toFixed(2)} · 실현 가격 $${fmt(o.realizedPrice)}` };
      }),
      ind({ key: "wma", name: "200주 이동평균 대비", hint: "초록 1.1배 이하 · 노랑 1.1~2배 · 빨강 2배 초과", source: "CoinMetrics 일간 가격" }, () => {
        const o = M("onchain");
        const price = state.live.btc?.price ?? o.price;
        const r = price / o.wma200;
        return { value: `${r.toFixed(2)}배`, light: r <= 1.1 ? "g" : r <= 2 ? "y" : "r", detail: `200주선 $${fmt(o.wma200)}` };
      }),
      ind({ key: "puell", name: "퓨엘 멀티플 (채굴자 수익)", hint: "초록 0.5 미만 (채굴자 항복) · 노랑 0.5~3 · 빨강 3 초과", source: "CoinMetrics" }, () => {
        const o = M("onchain");
        return { value: o.puell.toFixed(2), light: o.puell < 0.5 ? "g" : o.puell <= 3 ? "y" : "r", detail: `${md(o.date)} 기준` };
      }),
      ind({ key: "stable", name: "스테이블코인 유통량 30일", hint: "초록 +2% 이상 (대기 자금 유입) · 노랑 0~2% · 빨강 감소", source: "DefiLlama" }, () => {
        const s = M("stablecoins");
        return { value: `${signed(s.change30d, 2)}%`, light: s.change30d >= 2 ? "g" : s.change30d >= 0 ? "y" : "r", detail: `총 ${fmt(s.total, 1)}B 달러` };
      }),
      ind({ key: "fng", name: "공포·탐욕 지수", hint: "초록 25 이하 (극단적 공포) · 노랑 26~60 · 빨강 60 초과", source: "alternative.me (실시간)" }, () => {
        const f = state.live.fng;
        return f && { value: String(f.value), light: low(f.value, 25, 60), detail: f.label };
      }),
      ind({ key: "funding", name: "펀딩비 (8시간)", hint: "초록 0.005% 이하 · 노랑 ~0.02% · 빨강 0.02% 초과 (롱 과열)", source: "OKX (실시간)" }, () => {
        const f = state.live.funding;
        return typeof f === "number" && { value: `${f.toFixed(4)}%`, light: low(f, 0.005, 0.02), detail: f < 0 ? "숏 우위" : f > 0.02 ? "롱 과열" : "중립 부근" };
      }),
      ind({ key: "etf", name: "현물 ETF 순유입 (5거래일)", hint: "초록 +5억 달러 이상 · 빨강 -5억 달러 이하", source: "직접 입력 (data/manual.json)" }, () => {
        const m = state.manual;
        if (!m || m.etfFlow === null) return null;
        const age = daysBetween(m.etfUpdated, todayKst());
        return {
          value: `${signed(m.etfFlow)}억 달러`,
          light: m.etfFlow >= 5 ? "g" : m.etfFlow > -5 ? "y" : "r",
          detail: `${md(m.etfUpdated)} 입력${age > 3 ? ` · ${age}일 지남, 새 값 필요` : ""}`,
        };
      }),
      ind({ key: "kimp", name: "김치 프리미엄", hint: "초록 1% 미만 · 노랑 1~3% · 빨강 3% 이상", source: "업비트 · 바이낸스 (실시간)" }, () => {
        const krw = state.live.upbit;
        const usd = state.live.btc?.price;
        if (!krw || !usd) return null;
        const p = dev(krw, usd * M("usdkrw").price);
        return { value: `${signed(p, 2)}%`, light: p < 1 ? "g" : p < 3 ? "y" : "r", detail: `업비트 ${fmt(Math.round(krw / 10_000))}만원` };
      }),
      ind({ key: "fx", name: "원/달러 1주 흐름", hint: "±1% 안정 초록 · 원화 강세 1~2% 노랑 · ±2% 급변 빨강", source: "야후 KRW=X" }, () => {
        const f = M("usdkrw");
        const chg = dev(f.price, f.weekAgo);
        return { value: `${fmt(f.price, 1)}원`, light: Math.abs(chg) >= 2 ? "r" : chg <= -1 ? "y" : "g", detail: `1주 ${signed(chg, 2)}%${chg < 0 ? " (원화 강세)" : ""}` };
      }),
      ind({ key: "y10", name: "미 10년물 금리", hint: "초록 4.8% 이하 · 노랑 4.8~5.2% · 빨강 5.2% 초과 (정지)", source: "야후 ^TNX" }, () => {
        const t = M("us10y");
        return { value: `${t.price.toFixed(2)}%`, light: low(t.price, 4.8, 5.2), detail: `1주 전 대비 ${signed((t.price - t.weekAgo) * 100, 0)}bp` };
      }),
      shared.fomc(),
      shared.ndx(),
      shared.event(),
    ],
    stop: (L) => (L.event === "r" ? "큰 이벤트 당일입니다." : L.y10 === "r" ? "미 10년물이 5.2%를 넘었습니다." : null),
    bottom: () => {
      const o = state.macro?.values?.onchain;
      const b = state.live.btc?.price;
      const f = state.live.fng?.value;
      if ((b && f !== undefined && b <= 62_000 && f <= 25) || (o && o.mvrvZ < 0)) {
        return "BTC 62k 이하와 극단적 공포가 겹쳤거나 MVRV Z가 0 아래입니다. 과거 사이클 바닥에서 나타난 조합입니다.";
      }
      return null;
    },
  },
  {
    id: "bonds",
    code: "SEC-03 RATES",
    label: "미 장기채",
    sub: "10년물 · TLT",
    indicators: () => [
      ind({ key: "lvl", name: "10년물 금리 수준", hint: "높을수록 좋은 진입: 초록 4.75% 이상 · 노랑 4.25~4.75% · 빨강 4.25% 미만", source: "야후 ^TNX" }, () => {
        const t = M("us10y");
        return { value: `${t.price.toFixed(2)}%`, light: high(t.price, 4.75, 4.25), detail: `1달 전 ${t.monthAgo.toFixed(2)}%` };
      }),
      ind({ key: "trend", name: "10년물 금리 추세", hint: "50일선보다 0.05%p 아래 (금리 하락 = 채권 상승) 초록 · 근처 노랑 · 위 빨강", source: "야후 ^TNX" }, () => {
        const t = M("us10y");
        const d = t.price - t.sma50;
        return { value: `${signed(d * 100, 0)}bp`, light: d <= -0.05 ? "g" : d < 0.05 ? "y" : "r", detail: `50일선 ${t.sma50.toFixed(2)}% 대비` };
      }),
      ind({ key: "real", name: "실질금리 (10년 TIPS)", hint: "초록 2.0% 이상 (역사적으로 매력) · 노랑 1~2% · 빨강 1% 미만", source: "FRED DFII10" }, () => {
        const r = M("realYield");
        return { value: `${r.value.toFixed(2)}%`, light: high(r.value, 2, 1), detail: `4주 전 ${r.past.toFixed(2)}% · ${md(r.date)}` };
      }),
      ind({ key: "tp", name: "기간 프리미엄", hint: "초록 1.0%p 초과 · 노랑 0~1.0 · 빨강 0 미만", source: "FRED THREEFYTP10 (주간)" }, () => {
        const t = M("termPremium");
        return { value: `${t.value.toFixed(2)}%p`, light: t.value > 1 ? "g" : t.value >= 0 ? "y" : "r", detail: `4주 전 ${t.past.toFixed(2)} · ${md(t.date)}` };
      }),
      ind({ key: "be", name: "기대인플레 (10년 BEI)", hint: "초록 2.3% 미만 · 노랑 2.3~2.6% · 빨강 2.6% 초과", source: "FRED T10YIE" }, () => {
        const b = M("breakeven");
        return { value: `${b.value.toFixed(2)}%`, light: b.value < 2.3 ? "g" : b.value <= 2.6 ? "y" : "r", detail: `4주 전 ${b.past.toFixed(2)}%` };
      }),
      ind({ key: "move", name: "채권 변동성 (MOVE)", hint: "초록 85 미만 · 노랑 85~120 · 빨강 120 초과", source: "야후 ^MOVE" }, () => {
        const m = M("move");
        return { value: m.price.toFixed(1), light: m.price < 85 ? "g" : m.price <= 120 ? "y" : "r", detail: `50일 평균 ${m.sma50.toFixed(1)}` };
      }),
      ind({ key: "tlt", name: "TLT 추세", hint: "200일선 위 초록 · 200일선 아래지만 50일선 위 노랑 · 둘 다 아래 빨강", source: "야후 TLT" }, () => {
        const t = M("tlt");
        const light = t.price > t.sma200 ? "g" : t.price > t.sma50 ? "y" : "r";
        return { value: `$${t.price.toFixed(2)}`, light, detail: `200일선 ${t.sma200.toFixed(2)} · 50일선 ${t.sma50.toFixed(2)}` };
      }),
      ind({ key: "labor", name: "고용 둔화 (샴 룰)", hint: "0.3 이상이면 초록 (경기 둔화 = 금리 하락 압력) · 그 아래 노랑", source: "FRED SAHMREALTIME" }, () => {
        const s = M("sahm");
        return { value: s.value.toFixed(2), light: s.value >= 0.3 ? "g" : "y", detail: `${s.date.slice(0, 7)} 기준` };
      }),
      shared.fomc(),
      shared.cpi(),
      shared.event(),
    ],
    stop: (L) => (L.event === "r" ? "큰 이벤트 당일입니다." : null),
  },
];

// ---------- 판정 ----------

function evaluate(asset) {
  const list = asset.indicators();
  const counts = { g: 0, y: 0, r: 0, unknown: 0 };
  const L = {};
  for (const i of list) {
    L[i.key] = i.light;
    if (i.light) counts[i.light]++;
    else counts.unknown++;
  }
  const known = counts.g + counts.y + counts.r;
  const score = known ? Math.round(((counts.g + counts.y * 0.5) / known) * 100) : null;

  let verdict;
  const stop = asset.stop(L);
  const bottom = asset.bottom?.();
  if (stop) verdict = { tone: "r", title: "정지: 이번 회차 미루기", desc: `${stop} 다른 신호와 상관없이 하루 이상 기다립니다.` };
  else if (bottom) verdict = { tone: "g", title: "바닥권 신호: 예비금 검토", desc: bottom };
  else if (score === null) verdict = { tone: null, title: "값을 불러오는 중", desc: "" };
  else if (score >= 85 && counts.r === 0) verdict = { tone: "g", title: "강한 매수 신호: 가속 조건", desc: "점수 85 이상, 빨강 0개입니다. 남은 회차를 앞당기는 것을 검토할 수 있습니다." };
  else if (score >= 75) verdict = { tone: "g", title: "매수 신호: 이번 회차 실행", desc: "점수 75 이상입니다. 계획한 회차를 계획 금액대로 실행합니다." };
  else if (score >= 60) verdict = { tone: "y", title: "부분 신호: 예정된 회차만", desc: "점수 60~74입니다. 날짜가 된 회차만 계획 금액대로 넣고 앞당기지 않습니다." };
  else verdict = { tone: "r", title: "대기: 회차 미루기", desc: "점수 60 미만입니다. 다음 점검일까지 기다립니다." };

  return { list, counts, score, verdict };
}

// ---------- 그리기 ----------

const LABEL = { g: "초록", y: "노랑", r: "빨강" };
const TAG = { g: "GO", y: "HOLD", r: "STOP" };

function gauge(score, big = false) {
  const r = 46;
  const c = 2 * Math.PI * r;
  const off = c * (1 - (score ?? 0) / 100);
  return `
    <div class="gauge${big ? " big" : ""}">
      <svg viewBox="0 0 108 108" aria-hidden="true">
        <circle class="track" cx="54" cy="54" r="${r}" fill="none" stroke-width="7"/>
        <circle class="arc" cx="54" cy="54" r="${r}" fill="none" stroke-width="7" stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"/>
      </svg>
      <div class="num"><b>${score ?? "—"}</b><small>/ 100</small></div>
    </div>`;
}

function bar(c) {
  return `<div class="bar" aria-hidden="true">${["g", "y", "r"].map((l) => (c[l] ? `<span class="${l}" style="flex:${c[l]}"></span>` : "")).join("")}</div>`;
}

function counts(c) {
  return `<p class="counts">GO <b class="t-g">${c.g}</b> · HOLD <b class="t-y">${c.y}</b> · STOP <b class="t-r">${c.r}</b>${c.unknown ? ` · N/A ${c.unknown}` : ""}</p>`;
}

/** 점수를 끌어내리는 빨강 지표 이름 */
function drag(list) {
  const reds = list.filter((i) => i.light === "r").map((i) => i.name);
  return reds.length ? `<p class="drag">발목 잡는 지표 · <b>${reds.map(esc).join(", ")}</b></p>` : "";
}

function summaryCard(asset, e) {
  return `
    <button class="panel summary tone-${e.verdict.tone ?? "n"}" data-go="${asset.id}">
      <div class="sum-head">
        <div>
          <p class="label">${asset.code}</p>
          <h2 class="h2">${asset.label}</h2>
          <p class="muted">${asset.sub}</p>
          <p class="verdict">${esc(e.verdict.title)}</p>
        </div>
        ${gauge(e.score)}
      </div>
      ${bar(e.counts)}
      ${counts(e.counts)}
      ${drag(e.list)}
    </button>`;
}

function indicatorCard(i) {
  const t = i.light ?? "n";
  return `
    <article class="panel ind tone-${t}">
      <div class="ind-top"><span class="led"></span><h3 class="ind-name">${esc(i.name)}</h3><span class="tag">${i.light ? TAG[i.light] : "N/A"}</span></div>
      <p class="ind-value">${esc(i.value)}</p>
      ${i.detail ? `<p class="ind-detail">${esc(i.detail)}</p>` : ""}
      <div class="ind-foot">
        <p class="hint">${esc(i.hint)}</p>
        <p class="src">// ${esc(i.source)}</p>
      </div>
    </article>`;
}

const stars = (n) => `<span class="stars" aria-label="중요도 ${n}점">${"★".repeat(n)}<i>${"★".repeat(5 - n)}</i></span>`;

function eventsCard() {
  const list = upcoming().slice(0, 14);
  return `
    <section class="panel">
      <p class="label">EVENT RADAR</p>
      <h2 class="h2">다가오는 이벤트</h2>
      <p class="muted">한국 시간 · ★${BIG_STARS} 이상이 3일 안이면 HOLD, 당일이면 모든 자산 STOP</p>
      <ul class="events">
        ${
          list.length
            ? list
                .map((e) => {
                  const big = e.stars >= BIG_STARS;
                  const cls = big && e.dday === 0 ? "r" : big && e.dday <= 3 ? "y" : "";
                  return `<li>
                    <span class="dday ${cls}">${e.dday === 0 ? "TODAY" : `D-${e.dday}`}</span>
                    <span class="when">${md(e.date)}</span>
                    <span class="ev-name">${esc(e.name)}${e.time ? `<small>${esc(e.time)} KST</small>` : ""}</span>
                    ${stars(e.stars ?? 0)}
                  </li>`;
                })
                .join("")
            : `<li class="muted">남은 일정이 없습니다</li>`
        }
      </ul>
    </section>`;
}

const RULES = `
  <section class="panel">
    <p class="label">DECISION LOGIC</p>
    <h2 class="h2">판정 규칙</h2>
    <ol class="rules">
      <li><b>점수</b> = (GO + HOLD×0.5) ÷ 확인된 지표 수 × 100</li>
      <li><b>STOP</b>: ★${BIG_STARS} 이상 이벤트 당일 (모든 자산), 하이일드 스프레드 빨강 (주식), 10년물 5.2% 초과 (코인)</li>
      <li><b>바닥권</b> (코인): BTC 62k 이하 + 극단적 공포, 또는 MVRV Z 0 미만</li>
      <li><b>85점 이상 · STOP 0</b> 강한 매수 → 남은 회차 앞당기기 검토</li>
      <li><b>75점 이상</b> 매수 → 계획 회차 실행</li>
      <li><b>60~74점</b> 부분 → 날짜가 된 회차만</li>
      <li><b>60점 미만</b> 대기 → 다음 점검일까지</li>
    </ol>
    <p class="muted">투자 자문이 아니라 미리 정한 규칙을 기계적으로 적용한 점검표입니다. 최종 판단은 본인 몫입니다.</p>
  </section>`;

/** 위쪽 시세 띠 — 같은 묶음을 두 번 이어 붙여 끊김 없이 흐르게 */
function ticker() {
  const v = state.macro?.values ?? {};
  const items = [];
  const push = (k, price, change, digits = 2) => {
    if (price === undefined || price === null) return;
    const cls = change === null || Math.abs(change) < 0.005 ? "flat" : change > 0 ? "up" : "down";
    const arrow = cls === "up" ? "▲" : cls === "down" ? "▼" : "■";
    items.push(`<span class="tk"><span class="k">${k}</span>${fmt(price, digits)}${change === null ? "" : ` <span class="${cls}">${arrow}${Math.abs(change).toFixed(2)}%</span>`}</span>`);
  };
  const y = (key) => (v[key] ? [v[key].price, v[key].dayAgo ? dev(v[key].price, v[key].dayAgo) : null] : [null, null]);
  if (state.live.btc) push("BTC", state.live.btc.price, state.live.btc.change ?? null, 0);
  if (state.live.upbit) push("BTC/KRW", state.live.upbit, null, 0);
  push("S&P500", ...y("sp500"));
  push("NASDAQ", ...y("nasdaq"));
  push("US10Y", ...y("us10y"), 3);
  push("VIX", ...y("vix"));
  push("DXY", ...y("dxy"));
  push("USD/KRW", ...y("usdkrw"), 1);
  push("TLT", ...y("tlt"));
  const row = items.join("");
  return row + row;
}

function render() {
  const results = ASSETS.map((a) => ({ asset: a, e: evaluate(a) }));
  const tab = state.tab;

  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-current", b.dataset.tab === tab ? "page" : "false"));

  let html = "";
  if (tab === "all") {
    html += `<div class="grid3">${results.map(({ asset, e }) => summaryCard(asset, e)).join("")}</div>`;
    html += `<div class="grid2">${eventsCard()}${RULES}</div>`;
  } else {
    const { asset, e } = results.find((r) => r.asset.id === tab) ?? results[0];
    html += `
      <section class="panel hero tone-${e.verdict.tone ?? "n"}">
        <div class="hero-row">
          <div>
            <p class="label">${asset.code} · ${asset.label} · ${asset.sub}</p>
            <h2 class="verdict-big">${esc(e.verdict.title)}</h2>
            <p class="desc">${esc(e.verdict.desc)}</p>
          </div>
          ${gauge(e.score, true)}
        </div>
        ${bar(e.counts)}
        ${counts(e.counts)}
        ${drag(e.list)}
      </section>
      <div class="grid3">${e.list.map(indicatorCard).join("")}</div>`;
  }
  $("#main").innerHTML = html;

  const track = $("#ticker");
  const t = ticker();
  if (track.dataset.html !== t) {
    track.innerHTML = t;
    track.dataset.html = t;
  }

  const macroAt = state.macro?.collectedAt ? new Date(state.macro.collectedAt) : null;
  $("#stamp").innerHTML = [
    state.liveAt ? `<span class="pulse"></span>LIVE <b>${state.liveAt.toTimeString().slice(0, 8)}</b>` : "",
    macroAt ? `MACRO <b>${macroAt.getMonth() + 1}/${macroAt.getDate()} ${macroAt.toTimeString().slice(0, 5)}</b>` : "",
  ]
    .filter(Boolean)
    .join(" &nbsp;·&nbsp; ");
}

// ---------- 시작 ----------

document.querySelector(".tabs").addEventListener("click", (ev) => {
  const b = ev.target.closest("button[data-tab]");
  if (!b) return;
  state.tab = b.dataset.tab;
  history.replaceState(null, "", state.tab === "all" ? location.pathname : `#${state.tab}`);
  render();
  window.scrollTo({ top: 0 });
});

$("#main").addEventListener("click", (ev) => {
  const card = ev.target.closest("[data-go]");
  if (!card) return;
  state.tab = card.dataset.go;
  history.replaceState(null, "", `#${state.tab}`);
  render();
  window.scrollTo({ top: 0 });
});

// 주소창의 #crypto 처럼 직접 바꿔도 따라간다
window.addEventListener("hashchange", () => {
  state.tab = location.hash.slice(1) || "all";
  render();
});

(async function start() {
  await Promise.all([loadMacro(), loadLive()]);
  render();
  setInterval(async () => {
    await loadLive();
    render();
  }, LIVE_MS);
  setInterval(async () => {
    await loadMacro();
    render();
  }, MACRO_MS);
})();
