// 경제 일정 자동 수집 → data/calendar.json (collect.js 가 함께 돌린다)
// 공식 일정표만 쓴다: BLS(고용·CPI·PPI·JOLTS), BEA(GDP·PCE), 연준(FOMC), 재무부(국채 입찰).
// 매주 목요일 실업수당 청구, 매달 첫 영업일 ISM, 비트코인 월물 옵션 만기는 규칙으로 만든다.
// 시간은 모두 한국 시간(KST)으로 바꿔 저장한다.
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "data", "calendar.json");
const HEADERS = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36" };
const WINDOW_DAYS = 75;

async function text(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

// ---------- 시간 변환 ----------

/** 미국 서머타임: 3월 둘째 일요일 ~ 11월 첫째 일요일 */
function isUsDst(y, m, d) {
  const nthSunday = (month, n) => {
    const first = new Date(Date.UTC(y, month - 1, 1)).getUTCDay();
    return 1 + ((7 - first) % 7) + (n - 1) * 7;
  };
  const start = nthSunday(3, 2);
  const end = nthSunday(11, 1);
  const key = m * 100 + d;
  return key >= 300 + start && key < 1100 + end;
}

/** 미국 동부 시각 → { date, time } (KST) */
function etToKst(y, m, d, hh, mm) {
  const offset = isUsDst(y, m, d) ? 4 : 5;
  return utcToKst(Date.UTC(y, m - 1, d, hh + offset, mm));
}

function utcToKst(ms) {
  const k = new Date(ms + 9 * 3_600_000).toISOString();
  return { date: k.slice(0, 10), time: k.slice(11, 16) };
}

const pad = (n) => String(n).padStart(2, "0");

// ---------- 출처별 ----------

// BLS 공식 ICS: DTSTART 는 미국 동부 현지 시각
const BLS = [
  [/^Employment Situation$/, "미국 고용보고서 (비농업 고용)", 5],
  [/^Consumer Price Index$/, "미국 CPI", 5],
  [/^Producer Price Index$/, "미국 PPI", 3],
  [/^Job Openings and Labor Turnover Survey$/, "미국 JOLTS 구인", 3],
  [/^Employment Cost Index$/, "미국 고용비용지수", 2],
];

// BLS 는 GitHub 서버(데이터센터 IP)를 막는다(403). 집 PC 에서 받을 때마다 사본을 남겨 두고, 막히면 사본을 쓴다.
const BLS_COPY = path.join(__dirname, "..", "data", "bls-schedule.json");

async function bls() {
  let out;
  try {
    out = await blsLive();
    fs.writeFileSync(BLS_COPY, JSON.stringify({ savedAt: new Date().toISOString(), events: out }, null, 1));
  } catch (err) {
    out = JSON.parse(fs.readFileSync(BLS_COPY, "utf8")).events;
    console.error(`  BLS 직접 수집 실패(${err.message}) → 저장해 둔 사본 사용`);
  }
  return out;
}

async function blsLive() {
  const ics = (await text("https://www.bls.gov/schedule/news_release/bls.ics")).replace(/\r?\n[ \t]/g, ""); // 접힌 줄 펴기
  const out = [];
  for (const block of ics.split("BEGIN:VEVENT").slice(1)) {
    const start = block.match(/DTSTART[^:]*:(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/);
    const summary = block.match(/SUMMARY:([^\r\n]*)/)?.[1]?.trim();
    if (!start || !summary) continue;
    const hit = BLS.find(([re]) => re.test(summary));
    if (!hit) continue;
    const [, y, m, d, hh, mm] = start.map(Number);
    out.push({ ...etToKst(y, m, d, hh, mm), name: hit[1], stars: hit[2], src: "BLS" });
  }
  return out;
}

// BEA 공식 일정 JSON: UTC ISO
const BEA = { "Gross Domestic Product": ["미국 GDP", 3], "Personal Income and Outlays": ["미국 PCE 물가 · 개인소비", 4] };

async function bea() {
  const json = JSON.parse(await text("https://apps.bea.gov/API/signup/release_dates.json"));
  const out = [];
  for (const [key, [name, stars]] of Object.entries(BEA)) {
    for (const iso of json[key]?.release_dates ?? []) out.push({ ...utcToKst(Date.parse(iso)), name, stars, src: "BEA" });
  }
  return out;
}

// 연준 FOMC 일정 페이지: 회의 둘째 날 오후 2시(ET)에 결정, * 는 경제전망(점도표) 회의
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

async function fomc() {
  const html = await text("https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm");
  const out = [];
  for (const section of html.split(/(?=\d{4} FOMC Meetings)/).slice(1)) {
    const year = Number(section.slice(0, 4));
    const re = /fomc-meeting__month[^>]*>\s*<strong>([A-Za-z/]+)<\/strong>[\s\S]*?fomc-meeting__date[^>]*>([^<]+)</g;
    for (const [, monthText, dateText] of section.matchAll(re)) {
      const days = dateText.match(/(\d+)-(\d+)(\*?)/);
      if (!days) continue; // 「notation vote」 같은 서면 결정은 건너뜀
      // 「Apr/May」처럼 달을 걸치면 둘째 날은 뒤쪽 달
      const month = MONTHS.indexOf(monthText.split("/").pop().toLowerCase()) + 1;
      if (!month) continue;
      const sep = days[3] === "*";
      out.push({ ...etToKst(year, month, Number(days[2]), 14, 0), name: sep ? "FOMC 금리 결정 (점도표)" : "FOMC 금리 결정", stars: 5, src: "Fed" });
    }
  }
  return out;
}

// 재무부 예정 입찰 중 10년 · 30년물만 — 입찰 결과는 오후 1시(ET)
async function auctions() {
  const json = JSON.parse(
    await text("https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/upcoming_auctions?sort=auction_date&page[size]=100")
  );
  return json.data
    .filter((a) => /^(10|30)-Year$/.test(a.security_term))
    .map((a) => {
      const [y, m, d] = a.auction_date.split("-").map(Number);
      return { ...etToKst(y, m, d, 13, 0), name: `미국 ${a.security_term.replace("-Year", "년")}물 국채 입찰`, stars: 2, src: "Treasury" };
    });
}

// Kalshi 지표 시장: 마감 직후가 발표 시각(08:29 마감 → 08:30 발표). BLS 사본이 아직 없는 다음 해 일정을 메운다
const KALSHI = [
  ["KXPAYROLLS", "미국 고용보고서 (비농업 고용)", 5],
  ["KXCPI", "미국 CPI", 5],
  ["KXUSPPI", "미국 PPI", 3],
];

async function kalshi() {
  const out = [];
  for (const [series, name, stars] of KALSHI) {
    const json = JSON.parse(await text(`https://api.elections.kalshi.com/trade-api/v2/events?series_ticker=${series}&status=open&with_nested_markets=true`));
    for (const e of json.events) {
      const close = Math.min(...e.markets.map((m) => Date.parse(m.close_time)));
      const release = Math.ceil(close / 1_800_000) * 1_800_000; // 30분 단위로 올림
      out.push({ ...utcToKst(release), name, stars, src: "Kalshi" });
    }
  }
  return out;
}

// 규칙으로 만드는 일정
function rules(today) {
  const out = [];
  const start = new Date(today + "T00:00:00Z");
  for (let i = 0; i <= WINDOW_DAYS; i++) {
    const day = new Date(start.getTime() + i * 86_400_000);
    const [y, m, d, dow] = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), day.getUTCDay()];
    // 실업수당 청구: 매주 목요일 08:30 ET (휴일 주간엔 하루 당겨질 수 있음)
    if (dow === 4) out.push({ ...etToKst(y, m, d, 8, 30), name: "미국 신규 실업수당 청구", stars: 2, src: "규칙" });
    // ISM 제조업: 매달 첫 영업일 10:00 ET (1월 1일 등 휴일은 다음 날)
    const firstBiz = [1, 2, 3, 4].find((n) => {
      const w = new Date(Date.UTC(y, m - 1, n)).getUTCDay();
      return w !== 0 && w !== 6 && !(m === 1 && n === 1);
    });
    if (d === firstBiz) out.push({ ...etToKst(y, m, d, 10, 0), name: "미국 ISM 제조업지수", stars: 3, src: "규칙" });
    // 비트코인 월물 옵션 만기: 마지막 금요일 08:00 UTC, 분기 말월은 더 크다
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    if (dow === 5 && d + 7 > lastDay) {
      const quarterly = m % 3 === 0;
      out.push({ ...utcToKst(Date.UTC(y, m - 1, d, 8, 0)), name: quarterly ? "비트코인 분기 옵션 만기 (데리비트)" : "비트코인 월물 옵션 만기 (데리비트)", stars: quarterly ? 3 : 2, src: "규칙" });
    }
  }
  return out;
}

async function main() {
  const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
  const until = new Date(Date.parse(today) + WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);

  let previous = [];
  try {
    previous = JSON.parse(fs.readFileSync(OUT, "utf8")).events || [];
  } catch {}

  // 순서가 우선순위: 같은 날 같은 이름이면 앞쪽(공식 일정)이 남는다
  const sources = { bls, bea, fomc, auctions, kalshi };
  const failed = [];
  const results = await Promise.all(
    Object.entries(sources).map(async ([key, load]) => {
      try {
        return await load();
      } catch (err) {
        failed.push(key);
        console.error(`✗ 일정 ${key}: ${err.message}`);
        // 실패한 출처는 직전 수집분을 이어 쓴다
        const label = { bls: "BLS", bea: "BEA", fomc: "Fed", auctions: "Treasury", kalshi: "Kalshi" }[key];
        return previous.filter((e) => e.src === label);
      }
    })
  );
  const events = [...results.flat(), ...rules(today)];

  const seen = new Set();
  const list = events
    .filter((e) => e.date >= today && e.date <= until)
    .filter((e) => {
      const k = `${e.date}|${e.name}`;
      return seen.has(k) ? false : seen.add(k);
    })
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ collectedAt: new Date().toISOString(), failed, events: list }, null, 1));
  console.log(`calendar.json 저장 — ${list.length}개 일정, 실패 ${failed.length}개`);
}

module.exports = { main };
if (require.main === module) main();
