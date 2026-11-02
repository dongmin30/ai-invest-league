import type { InstrumentKind, LeagueMarket, Market, SymbolRow } from '../../../shared/api-types';

export interface SymbolInfo {
  /** Provider-neutral code: '005930' (KR) or 'AAPL' (US). */
  symbol: string;
  name: string;
  market: Market;
  exchange: SymbolRow['exchange'];
  /** Yahoo Finance ticker: '005930.KS' (KOSPI), '247540.KQ' (KOSDAQ), 'AAPL'. */
  yahoo: string;
  /** KIS overseas exchange code (EXCD), US symbols only. NYSE Arca / Cboe ETFs are 'AMS'. */
  kisExchange?: 'NAS' | 'NYS' | 'AMS';
  kind: InstrumentKind;
  /**
   * Daily return multiple the product targets: 1 for stocks and plain ETFs, 2/3 leveraged,
   * -1/-2/-3 inverse (UVXY: 1.5× VIX short-term futures).
   */
  leverage: number;
  /** Universe symbol whose daily return a leveraged/inverse ETF multiplies (sim follows it). */
  underlying?: string;
  /** Short Korean category label (업종·테마·자산군). */
  category: string;
}

const kospi = (symbol: string, name: string, category: string): SymbolInfo => ({
  symbol, name, market: 'KR', exchange: 'KOSPI', yahoo: `${symbol}.KS`, kind: 'stock', leverage: 1, category,
});

const kosdaq = (symbol: string, name: string, category: string): SymbolInfo => ({
  symbol, name, market: 'KR', exchange: 'KOSDAQ', yahoo: `${symbol}.KQ`, kind: 'stock', leverage: 1, category,
});

const nasdaq = (symbol: string, name: string, category: string): SymbolInfo => ({
  symbol, name, market: 'US', exchange: 'NASDAQ', yahoo: symbol, kisExchange: 'NAS', kind: 'stock', leverage: 1, category,
});

const nyse = (symbol: string, name: string, category: string): SymbolInfo => ({
  symbol, name, market: 'US', exchange: 'NYSE', yahoo: symbol, kisExchange: 'NYS', kind: 'stock', leverage: 1, category,
});

/** Korean ETFs are all listed on the KOSPI market. */
const krEtf = (symbol: string, name: string, category: string, leverage = 1, underlying?: string): SymbolInfo => ({
  symbol, name, market: 'KR', exchange: 'KOSPI', yahoo: `${symbol}.KS`, kind: 'etf', leverage, category,
  ...(underlying ? { underlying } : {}),
});

const usEtf =
  (exchange: SymbolRow['exchange'], kisExchange: 'NAS' | 'AMS') =>
  (symbol: string, name: string, category: string, leverage = 1, underlying?: string): SymbolInfo => ({
    symbol, name, market: 'US', exchange, yahoo: symbol, kisExchange, kind: 'etf', leverage, category,
    ...(underlying ? { underlying } : {}),
  });

const nasdaqEtf = usEtf('NASDAQ', 'NAS');
const arcaEtf = usEtf('NYSE Arca', 'AMS');
const cboeEtf = usEtf('Cboe BZX', 'AMS');

// Every entry was checked live against the Yahoo chart/spark endpoints on 2026-10-31
// (instrumentType EQUITY/ETF, exchange, a positive regularMarketPrice).
// Walmart moved its listing from NYSE to Nasdaq in December 2025.
export const SYMBOLS: SymbolInfo[] = [
  // KR stocks
  kospi('005930', '삼성전자', '반도체'),
  kospi('000660', 'SK하이닉스', '반도체'),
  kospi('373220', 'LG에너지솔루션', '2차전지'),
  kospi('207940', '삼성바이오로직스', '바이오'),
  kospi('005380', '현대차', '자동차'),
  kospi('000270', '기아', '자동차'),
  kospi('068270', '셀트리온', '바이오'),
  kospi('005490', 'POSCO홀딩스', '철강·소재'),
  kospi('035420', 'NAVER', '인터넷'),
  kospi('035720', '카카오', '인터넷'),
  kospi('051910', 'LG화학', '화학'),
  kospi('006400', '삼성SDI', '2차전지'),
  kospi('105560', 'KB금융', '금융'),
  kospi('055550', '신한지주', '금융'),
  kospi('086790', '하나금융지주', '금융'),
  kospi('012330', '현대모비스', '자동차'),
  kospi('028260', '삼성물산', '지주·상사'),
  kospi('066570', 'LG전자', '전자'),
  kospi('003550', 'LG', '지주·상사'),
  kospi('032830', '삼성생명', '금융'),
  kospi('015760', '한국전력', '유틸리티'),
  kospi('017670', 'SK텔레콤', '통신'),
  kospi('034020', '두산에너빌리티', '기계·에너지'),
  kospi('012450', '한화에어로스페이스', '방산'),
  kospi('329180', 'HD현대중공업', '조선'),
  kospi('009540', 'HD한국조선해양', '조선'),
  kosdaq('247540', '에코프로비엠', '2차전지'),
  kosdaq('086520', '에코프로', '2차전지'),
  kosdaq('196170', '알테오젠', '바이오'),
  kosdaq('028300', 'HLB', '바이오'),
  kospi('000810', '삼성화재', '금융'),
  kospi('010130', '고려아연', '철강·소재'),
  kospi('011200', 'HMM', '운송'),
  kospi('096770', 'SK이노베이션', '에너지'),
  kospi('034730', 'SK', '지주·상사'),
  kospi('018260', '삼성에스디에스', 'IT서비스'),
  kospi('033780', 'KT&G', '필수소비재'),
  kospi('030200', 'KT', '통신'),
  kospi('010950', 'S-Oil', '에너지'),
  kospi('009150', '삼성전기', '전자'),
  kospi('000100', '유한양행', '바이오'),
  kospi('138040', '메리츠금융지주', '금융'),
  kospi('316140', '우리금융지주', '금융'),
  kospi('024110', '기업은행', '금융'),
  kospi('323410', '카카오뱅크', '금융'),
  kospi('259960', '크래프톤', '게임'),
  kospi('352820', '하이브', '엔터'),
  kospi('036570', '엔씨소프트', '게임'),
  kospi('090430', '아모레퍼시픽', '소비재'),
  kospi('097950', 'CJ제일제당', '필수소비재'),
  kospi('004020', '현대제철', '철강·소재'),
  kospi('010140', '삼성중공업', '조선'),
  kospi('042660', '한화오션', '조선'),
  kospi('267250', 'HD현대', '지주·상사'),
  kospi('064350', '현대로템', '방산'),
  kospi('047810', '한국항공우주', '방산'),
  kospi('003670', '포스코퓨처엠', '2차전지'),
  kospi('006800', '미래에셋증권', '금융'),
  kospi('071050', '한국금융지주', '금융'),
  kospi('000720', '현대건설', '건설'),
  kospi('086280', '현대글로비스', '운송'),
  kospi('011070', 'LG이노텍', '전자'),
  kospi('402340', 'SK스퀘어', '지주·상사'),
  kospi('042700', '한미반도체', '반도체'),
  kospi('326030', 'SK바이오팜', '바이오'),
  kosdaq('035900', 'JYP Ent.', '엔터'),
  kosdaq('041510', '에스엠', '엔터'),
  kosdaq('058470', '리노공업', '반도체'),
  kosdaq('039030', '이오테크닉스', '반도체'),
  kosdaq('145020', '휴젤', '바이오'),
  kosdaq('277810', '레인보우로보틱스', '로봇'),
  kosdaq('141080', '리가켐바이오', '바이오'),
  kosdaq('214450', '파마리서치', '바이오'),
  kosdaq('263750', '펄어비스', '게임'),

  // KR ETFs (KOSPI-listed)
  krEtf('069500', 'KODEX 200', '국내 지수'),
  krEtf('102110', 'TIGER 200', '국내 지수'),
  krEtf('278530', 'KODEX 200TR', '국내 지수'),
  krEtf('229200', 'KODEX 코스닥150', '국내 지수'),
  krEtf('292150', 'TIGER 코리아TOP10', '국내 지수'),
  krEtf('122630', 'KODEX 레버리지', '레버리지', 2, '069500'),
  krEtf('123320', 'TIGER 레버리지', '레버리지', 2, '069500'),
  krEtf('233740', 'KODEX 코스닥150레버리지', '레버리지', 2, '229200'),
  krEtf('114800', 'KODEX 인버스', '인버스', -1, '069500'),
  krEtf('123310', 'TIGER 인버스', '인버스', -1, '069500'),
  krEtf('252670', 'KODEX 200선물인버스2X', '인버스', -2, '069500'),
  krEtf('252710', 'TIGER 200선물인버스2X', '인버스', -2, '069500'),
  krEtf('251340', 'KODEX 코스닥150선물인버스', '인버스', -1, '229200'),
  krEtf('360750', 'TIGER 미국S&P500', '해외 지수'),
  krEtf('379800', 'KODEX 미국S&P500TR', '해외 지수'),
  krEtf('133690', 'TIGER 미국나스닥100', '해외 지수'),
  krEtf('379810', 'KODEX 미국나스닥100TR', '해외 지수'),
  krEtf('381170', 'TIGER 미국테크TOP10 INDXX', '해외 테마'),
  krEtf('381180', 'TIGER 미국필라델피아반도체나스닥', '해외 테마'),
  krEtf('458730', 'TIGER 미국배당다우존스', '배당'),
  krEtf('091160', 'KODEX 반도체', '업종·테마'),
  krEtf('396500', 'TIGER 반도체TOP10', '업종·테마'),
  krEtf('091170', 'KODEX 은행', '업종·테마'),
  krEtf('305720', 'KODEX 2차전지산업', '업종·테마'),
  krEtf('305540', 'TIGER 2차전지테마', '업종·테마'),
  krEtf('139260', 'TIGER 200 IT', '업종·테마'),
  krEtf('132030', 'KODEX 골드선물(H)', '원자재'),
  krEtf('144600', 'KODEX 은선물(H)', '원자재'),
  krEtf('261220', 'KODEX WTI원유선물(H)', '원자재'),
  krEtf('114260', 'KODEX 국고채3년', '채권'),
  krEtf('261240', 'KODEX 미국달러선물', '통화'),

  // US stocks
  nasdaq('AAPL', '애플', '빅테크'),
  nasdaq('MSFT', '마이크로소프트', '빅테크'),
  nasdaq('NVDA', '엔비디아', '반도체'),
  nasdaq('AMZN', '아마존', '빅테크'),
  nasdaq('GOOGL', '알파벳 A', '빅테크'),
  nasdaq('META', '메타 플랫폼스', '빅테크'),
  nasdaq('TSLA', '테슬라', '자동차'),
  nasdaq('AVGO', '브로드컴', '반도체'),
  nasdaq('COST', '코스트코', '소비재'),
  nasdaq('NFLX', '넷플릭스', '미디어'),
  nasdaq('AMD', 'AMD', '반도체'),
  nasdaq('ADBE', '어도비', '소프트웨어'),
  nasdaq('PEP', '펩시코', '필수소비재'),
  nasdaq('CSCO', '시스코', '네트워크'),
  nasdaq('QCOM', '퀄컴', '반도체'),
  nasdaq('WMT', '월마트', '소비재'),
  nyse('JPM', 'JP모건체이스', '금융'),
  nyse('V', '비자', '금융'),
  nyse('MA', '마스터카드', '금융'),
  nyse('JNJ', '존슨앤드존슨', '헬스케어'),
  nyse('PG', 'P&G', '필수소비재'),
  nyse('XOM', '엑슨모빌', '에너지'),
  nyse('UNH', '유나이티드헬스', '헬스케어'),
  nyse('HD', '홈디포', '소비재'),
  nyse('KO', '코카콜라', '필수소비재'),
  nyse('BAC', '뱅크오브아메리카', '금융'),
  nyse('CVX', '셰브론', '에너지'),
  nyse('LLY', '일라이 릴리', '헬스케어'),
  nyse('ORCL', '오라클', '소프트웨어'),
  nyse('DIS', '디즈니', '미디어'),
  nasdaq('INTC', '인텔', '반도체'),
  nasdaq('TXN', '텍사스 인스트루먼트', '반도체'),
  nasdaq('AMAT', '어플라이드 머티어리얼즈', '반도체'),
  nasdaq('LRCX', '램리서치', '반도체'),
  nasdaq('KLAC', 'KLA', '반도체'),
  nasdaq('MU', '마이크론', '반도체'),
  nasdaq('ADI', '아날로그 디바이스', '반도체'),
  nasdaq('MRVL', '마벨 테크놀로지', '반도체'),
  nasdaq('ARM', 'Arm 홀딩스', '반도체'),
  nyse('TSM', 'TSMC', '반도체'),
  nasdaq('ASML', 'ASML', '반도체'),
  nasdaq('PANW', '팔로알토 네트웍스', '소프트웨어'),
  nasdaq('CRWD', '크라우드스트라이크', '소프트웨어'),
  nasdaq('INTU', '인튜이트', '소프트웨어'),
  nyse('CRM', '세일즈포스', '소프트웨어'),
  nyse('NOW', '서비스나우', '소프트웨어'),
  nasdaq('PLTR', '팔란티어', '소프트웨어'),
  nasdaq('SNPS', '시놉시스', '소프트웨어'),
  nasdaq('CDNS', '케이던스', '소프트웨어'),
  nyse('IBM', 'IBM', 'IT서비스'),
  nyse('ACN', '액센츄어', 'IT서비스'),
  nyse('ANET', '아리스타 네트웍스', '네트워크'),
  nasdaq('APP', '앱러빈', '소프트웨어'),
  nasdaq('SHOP', '쇼피파이', '인터넷'),
  nyse('UBER', '우버', '인터넷'),
  nasdaq('ABNB', '에어비앤비', '인터넷'),
  nasdaq('BKNG', '부킹홀딩스', '인터넷'),
  nasdaq('MELI', '메르카도리브레', '인터넷'),
  nasdaq('PDD', 'PDD 홀딩스', '인터넷'),
  nyse('BABA', '알리바바', '인터넷'),
  nasdaq('PYPL', '페이팔', '금융'),
  nasdaq('COIN', '코인베이스', '금융'),
  nasdaq('MSTR', '스트래티지', '소프트웨어'),
  nasdaq('TMUS', 'T-모바일 US', '통신'),
  nasdaq('CMCSA', '컴캐스트', '미디어'),
  nyse('T', 'AT&T', '통신'),
  nyse('VZ', '버라이즌', '통신'),
  nyse('WFC', '웰스파고', '금융'),
  nyse('GS', '골드만삭스', '금융'),
  nyse('MS', '모건스탠리', '금융'),
  nyse('C', '씨티그룹', '금융'),
  nyse('AXP', '아메리칸 익스프레스', '금융'),
  nyse('BLK', '블랙록', '금융'),
  nyse('SCHW', '찰스 슈왑', '금융'),
  nyse('SPGI', 'S&P 글로벌', '금융'),
  nyse('MRK', '머크', '헬스케어'),
  nyse('ABBV', '애브비', '헬스케어'),
  nyse('PFE', '화이자', '헬스케어'),
  nyse('TMO', '써모피셔', '헬스케어'),
  nyse('ABT', '애보트', '헬스케어'),
  nasdaq('AMGN', '암젠', '헬스케어'),
  nasdaq('ISRG', '인튜이티브 서지컬', '헬스케어'),
  nasdaq('GILD', '길리어드', '헬스케어'),
  nasdaq('VRTX', '버텍스', '헬스케어'),
  nyse('MCD', '맥도날드', '소비재'),
  nyse('NKE', '나이키', '소비재'),
  nasdaq('SBUX', '스타벅스', '소비재'),
  nyse('LOW', '로우스', '소비재'),
  nyse('TGT', '타깃', '소비재'),
  nyse('PM', '필립모리스', '필수소비재'),
  nasdaq('MDLZ', '몬델리즈', '필수소비재'),
  nyse('CAT', '캐터필러', '산업재'),
  nyse('DE', '디어', '산업재'),
  nyse('GE', 'GE 에어로스페이스', '산업재'),
  nyse('BA', '보잉', '산업재'),
  nyse('RTX', 'RTX', '방산'),
  nyse('LMT', '록히드마틴', '방산'),
  nasdaq('HON', '하니웰', '산업재'),
  nyse('UNP', '유니온퍼시픽', '운송'),
  nyse('UPS', 'UPS', '운송'),
  nasdaq('LIN', '린데', '소재'),
  nyse('NEE', '넥스트에라 에너지', '유틸리티'),
  nyse('COP', '코노코필립스', '에너지'),

  // US ETFs
  arcaEtf('SPY', 'SPDR S&P 500', '미국 지수'),
  arcaEtf('VOO', '뱅가드 S&P 500', '미국 지수'),
  arcaEtf('VTI', '뱅가드 토탈 스톡마켓', '미국 지수'),
  nasdaqEtf('QQQ', '인베스코 QQQ (나스닥100)', '미국 지수'),
  arcaEtf('DIA', 'SPDR 다우존스', '미국 지수'),
  arcaEtf('IWM', 'iShares 러셀2000', '미국 지수'),
  arcaEtf('RSP', 'S&P 500 동일가중', '미국 지수'),
  arcaEtf('XLK', '기술 섹터 SPDR', '섹터'),
  arcaEtf('XLF', '금융 섹터 SPDR', '섹터'),
  arcaEtf('XLE', '에너지 섹터 SPDR', '섹터'),
  arcaEtf('XLV', '헬스케어 섹터 SPDR', '섹터'),
  arcaEtf('XLY', '임의소비재 섹터 SPDR', '섹터'),
  arcaEtf('XLP', '필수소비재 섹터 SPDR', '섹터'),
  arcaEtf('XLI', '산업재 섹터 SPDR', '섹터'),
  arcaEtf('XLU', '유틸리티 섹터 SPDR', '섹터'),
  nasdaqEtf('SMH', '반에크 반도체', '테마'),
  nasdaqEtf('SOXX', 'iShares 반도체', '테마'),
  cboeEtf('ARKK', 'ARK 이노베이션', '테마'),
  arcaEtf('XBI', 'SPDR S&P 바이오텍', '테마'),
  arcaEtf('KRE', 'SPDR S&P 지역은행', '테마'),
  arcaEtf('SCHD', '슈왑 미국 배당', '배당'),
  arcaEtf('EEM', 'iShares 신흥국', '해외 지수'),
  arcaEtf('EFA', 'iShares 선진국(미국 제외)', '해외 지수'),
  arcaEtf('EWY', 'iShares 한국(MSCI Korea)', '해외 지수'),
  nasdaqEtf('TLT', 'iShares 미국 장기국채(20년+)', '채권'),
  nasdaqEtf('IEF', 'iShares 미국 중기국채(7-10년)', '채권'),
  nasdaqEtf('SHY', 'iShares 미국 단기국채(1-3년)', '채권'),
  arcaEtf('HYG', 'iShares 하이일드 회사채', '채권'),
  arcaEtf('GLD', 'SPDR 금', '원자재'),
  arcaEtf('SLV', 'iShares 은', '원자재'),
  arcaEtf('USO', '미국 원유 펀드', '원자재'),
  nasdaqEtf('TQQQ', '프로셰어즈 울트라프로 QQQ', '레버리지', 3, 'QQQ'),
  arcaEtf('QLD', '프로셰어즈 울트라 QQQ', '레버리지', 2, 'QQQ'),
  arcaEtf('UPRO', '프로셰어즈 울트라프로 S&P500', '레버리지', 3, 'SPY'),
  arcaEtf('SPXL', '디렉시온 S&P500 불 3X', '레버리지', 3, 'SPY'),
  arcaEtf('SSO', '프로셰어즈 울트라 S&P500', '레버리지', 2, 'SPY'),
  arcaEtf('UDOW', '프로셰어즈 울트라프로 다우30', '레버리지', 3, 'DIA'),
  arcaEtf('SOXL', '디렉시온 반도체 불 3X', '레버리지', 3, 'SOXX'),
  arcaEtf('TECL', '디렉시온 기술주 불 3X', '레버리지', 3, 'XLK'),
  arcaEtf('TNA', '디렉시온 소형주 불 3X', '레버리지', 3, 'IWM'),
  arcaEtf('LABU', '디렉시온 바이오 불 3X', '레버리지', 3, 'XBI'),
  arcaEtf('FAS', '디렉시온 금융 불 3X', '레버리지', 3, 'XLF'),
  arcaEtf('TMF', '디렉시온 20년+ 국채 불 3X', '레버리지', 3, 'TLT'),
  nasdaqEtf('NVDL', 'GraniteShares 엔비디아 2X', '레버리지', 2, 'NVDA'),
  nasdaqEtf('TSLL', '디렉시온 테슬라 불 2X', '레버리지', 2, 'TSLA'),
  nasdaqEtf('SQQQ', '프로셰어즈 울트라프로 숏 QQQ', '인버스', -3, 'QQQ'),
  arcaEtf('QID', '프로셰어즈 울트라숏 QQQ', '인버스', -2, 'QQQ'),
  arcaEtf('PSQ', '프로셰어즈 숏 QQQ', '인버스', -1, 'QQQ'),
  arcaEtf('SPXU', '프로셰어즈 울트라프로 숏 S&P500', '인버스', -3, 'SPY'),
  arcaEtf('SPXS', '디렉시온 S&P500 베어 3X', '인버스', -3, 'SPY'),
  arcaEtf('SDS', '프로셰어즈 울트라숏 S&P500', '인버스', -2, 'SPY'),
  arcaEtf('SH', '프로셰어즈 숏 S&P500', '인버스', -1, 'SPY'),
  arcaEtf('DOG', '프로셰어즈 숏 다우30', '인버스', -1, 'DIA'),
  arcaEtf('SDOW', '프로셰어즈 울트라프로 숏 다우30', '인버스', -3, 'DIA'),
  arcaEtf('SOXS', '디렉시온 반도체 베어 3X', '인버스', -3, 'SOXX'),
  arcaEtf('TZA', '디렉시온 소형주 베어 3X', '인버스', -3, 'IWM'),
  arcaEtf('LABD', '디렉시온 바이오 베어 3X', '인버스', -3, 'XBI'),
  arcaEtf('FAZ', '디렉시온 금융 베어 3X', '인버스', -3, 'XLF'),
  nasdaqEtf('TSLQ', 'Tradr 테슬라 숏 2X', '인버스', -2, 'TSLA'),
  cboeEtf('UVXY', '프로셰어즈 울트라 VIX 단기선물', '변동성', 1.5),
];

const bySymbol = new Map(SYMBOLS.map((s) => [s.symbol, s]));

export function getSymbol(symbol: string): SymbolInfo | undefined {
  return bySymbol.get(symbol);
}

/** The pool of a market; 'ALL' (통합 leagues) is every symbol (KR codes are 6 digits, US letters, so codes never collide). */
export function symbolsFor(market: LeagueMarket): SymbolInfo[] {
  return market === 'ALL' ? SYMBOLS : SYMBOLS.filter((s) => s.market === market);
}

/** Leveraged or inverse product (anything that does not track 1× its index). */
export function isLeveraged(info: Pick<SymbolInfo, 'leverage'>): boolean {
  return info.leverage !== 1;
}
