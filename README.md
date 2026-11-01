# 매수 신호등

미국 주식 · 코인 · 미 장기채의 매수 시점을 지표 신호등(초록·노랑·빨강)과 0~100 점수로 점검하는 개인용 정적 사이트.
빌드 없이 `index.html` · `styles.css` · `app.js` 세 파일로 돈다.

## 데이터 흐름
- **코인 실시간** (브라우저가 30초마다 직접): 바이낸스 · 업비트 · alternative.me 공포지수 · OKX 펀딩비
- **거시 지표** (`tools/collect.js` → `data/macro.json`, 30분마다): 야후(S&P · 나스닥 · VIX · MOVE · 10년물 · TLT · 원/달러 · XLY/XLP · IWM/SPY · 구리/금 · WTI · S&P 500 전 종목 200일선) · FRED(하이일드 스프레드 · NFCI · 샴 룰 · 실질금리 · BEI · 5y5y · 기간 프리미엄 · CPI · 실업수당 · 순유동성 · 실질 기준금리 · 커브) · Kalshi(FOMC · 경기침체) · CoinMetrics(MVRV Z · 200주선 · 퓨엘 · 거래소 순유출입 · 해시 리본) · OKX(미결제약정 · 롱숏) · 데리비트(옵션 스큐 · DVOL) · DefiLlama(스테이블코인) · TreasuryDirect(입찰 수요)
- **경제 일정** (`tools/calendar.js` → `data/calendar.json`, 30분마다): BLS ICS(고용 · CPI · PPI · JOLTS) · BEA JSON(GDP · PCE) · 연준 FOMC 페이지 · 재무부 입찰 + 규칙(실업수당 목요일 · ISM 첫 영업일 · 비트코인 옵션 만기). 중요도 ★0~5, ★4 이상만 신호등에 반영
- **손으로 넣는 값**: `data/manual.json` (현물 ETF 5거래일 순유입, 억 달러) · `data/events.json` (자동 수집에 없는 일정 — 선거 등, 한국 시간, stars 0~5)

## 로컬에서 보기
```
node tools/serve.js 4180
```
켜면 거시 지표를 한 번 모으고, 켜져 있는 동안 30분마다 다시 모은다.

## 배포
GitHub Pages(Actions). `.github/workflows/pages.yml` 이 30분마다 `collect.js` 를 돌리고 사이트를 다시 올린다.
`data/macro.json` · `data/calendar.json` 은 커밋하지 않는다 — 배포본에만 담긴다.

## 판정 규칙
점수 = (초록 + 노랑×0.5) ÷ 확인된 지표 수 × 100.
85 이상 · 빨강 0 → 강한 매수 / 75 이상 → 매수 / 60~74 → 부분 / 60 미만 → 대기.
정지: 이벤트 당일(전체) · 하이일드 스프레드 빨강(주식) · 10년물 5.2% 초과(코인).
바닥권(코인): BTC 62k 이하 + 공포지수 25 이하, 또는 MVRV Z 0 미만.
기준선은 2026년 11월 상황에 맞춘 값이라 몇 달마다 `app.js` 의 `ASSETS` 에서 다시 본다.

투자 자문이 아닌 개인 점검용.
