/**
 * 가계부 주식 시세 프록시 (Google Apps Script)
 *
 * 브라우저에서는 네이버 증권 API를 직접 부를 수 없어서(CORS),
 * 이 스크립트가 대신 시세를 가져와 가계부 앱에 돌려줍니다.
 * 종목 코드와 가격만 오가고, 개인정보는 다루지 않습니다.
 *
 *   ?action=search&q=삼성전자          → 종목 검색
 *   ?action=quotes&codes=KOR:005930,USA:AAPL.O  → 현재가
 *   ?action=resolve&url=(증권 앱 링크)   → 종목명·티커·현재가
 *     지원: 네이버 증권, 토스증권, 야후 파이낸스, 구글 파이낸스, 종목코드(005930)·티커(AAPL)
 */

function doGet(e) {
  const p = (e && e.parameter) || {};
  let data;
  try {
    if (p.action === 'search') data = search_(p.q || '');
    else if (p.action === 'resolve') data = resolve_(p.url || '', 0);
    else if (p.action === 'quotes') data = quotes_((p.codes || '').split(',').filter(String));
    else data = { ok: true, message: '가계부 시세 프록시가 동작 중이에요' };
  } catch (err) {
    data = { error: String(err) };
  }
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

const UA_ = { 'User-Agent': 'Mozilla/5.0' };

function search_(q) {
  q = q.trim();
  if (!q) return { items: [] };
  const url = 'https://ac.stock.naver.com/ac?target=stock&q=' + encodeURIComponent(q);
  const res = UrlFetchApp.fetch(url, { headers: UA_, muteHttpExceptions: true });
  const items = (JSON.parse(res.getContentText()).items || [])
    .filter(it => it.nationCode === 'KOR' || it.nationCode === 'USA') // 가계부는 원화·달러만 지원
    .slice(0, 10).map(it => {
    const kor = it.nationCode === 'KOR';
    return {
      key: (kor ? 'KOR:' + it.code : it.nationCode + ':' + it.reutersCode),
      name: it.name,
      symbol: it.code,
      market: it.typeName,
      nation: it.nationName,
    };
  });
  return { items };
}

function resolve_(text, depth) {
  const m = String(text).match(/https?:\/\/[^\s"'<>]+/);
  const url = m ? m[0] : String(text).trim();
  let r;

  // 네이버 증권: finance.naver.com/item/main.naver?code=005930, m.stock.naver.com/domestic/stock/005930/total
  if ((r = url.match(/naver\.com\/.*[?&]code=([0-9A-Z]{6})(?![0-9A-Z])/i)) ||
      (r = url.match(/\/domestic\/(?:stock|etf)\/([0-9A-Z]{6})(?![0-9A-Z])/i))) {
    return lookup_('KOR:' + r[1].toUpperCase());
  }
  // 네이버 해외: m.stock.naver.com/worldstock/stock/TSLA.O/total
  if ((r = url.match(/\/worldstock\/(?:stock|etf)\/([A-Z0-9.\-]+)/i))) {
    return lookup_('USA:' + r[1].toUpperCase());
  }
  // 토스증권: tossinvest.com/stocks/A005930/order, tossinvest.com/stocks/US20100629001
  if ((r = url.match(/tossinvest\.com\/stocks\/([A-Z0-9]+)/i))) {
    const res = UrlFetchApp.fetch('https://wts-info-api.tossinvest.com/api/v2/stock-infos/' + r[1],
      { headers: UA_, muteHttpExceptions: true });
    const info = (JSON.parse(res.getContentText()) || {}).result;
    if (!info) return { error: '토스증권 종목을 찾지 못했어요' };
    if (info.currency === 'KRW') return lookup_('KOR:' + info.symbol);
    if (info.currency === 'USD') return bySymbol_(info.symbol);
    return { error: '국내·미국 주식만 지원해요' };
  }
  // 야후 파이낸스: finance.yahoo.com/quote/005930.KS, finance.yahoo.com/quote/AAPL
  if ((r = url.match(/finance\.yahoo\.com\/quote\/([^/?#]+)/i))) {
    const s = decodeURIComponent(r[1]).toUpperCase();
    const k = s.match(/^([0-9A-Z]{6})\.(KS|KQ)$/);
    return k ? lookup_('KOR:' + k[1]) : bySymbol_(s);
  }
  // 구글 파이낸스: google.com/finance/quote/AAPL:NASDAQ, 005930:KRX
  if ((r = url.match(/google\.[^/]+\/finance\/quote\/([^/?#:]+):([A-Z]+)/i))) {
    return /^(KRX|KOSDAQ)$/i.test(r[2]) ? lookup_('KOR:' + r[1]) : bySymbol_(r[1].toUpperCase());
  }
  // 코드·티커만 붙여넣은 경우
  if (/^[0-9][0-9A-Z]{5}$/i.test(url)) return lookup_('KOR:' + url.toUpperCase());
  if (/^[A-Z][A-Z.\-]{0,6}$/i.test(url)) return bySymbol_(url.toUpperCase());

  // 공유용 단축 링크면 한 번 따라가서 다시 확인
  if (/^https?:\/\//.test(url) && depth < 2) {
    const res = UrlFetchApp.fetch(url, { headers: UA_, followRedirects: false, muteHttpExceptions: true });
    const loc = res.getHeaders()['Location'] || res.getHeaders()['location'];
    if (loc) return resolve_(loc, depth + 1);
  }
  return { error: '이 링크에서 종목을 찾지 못했어요' };
}

// 미국 티커(AAPL) → 네이버 코드(USA:AAPL.O)
function bySymbol_(sym) {
  const it = search_(sym).items.find(x => x.key.indexOf('USA:') === 0 && x.symbol.toUpperCase() === sym);
  return it ? lookup_(it.key, it.market) : { error: sym + ' 종목을 찾지 못했어요' };
}

function lookup_(key, market) {
  const q = quotes_([key]).quotes[key];
  if (!q || q.error) return { error: '시세를 찾지 못했어요' };
  const symbol = key.split(':')[1].replace(/\.[A-Z]$/, '');
  return {
    item: {
      key, name: q.name, symbol,
      market: market || (key.indexOf('KOR:') === 0 ? '국내' : '미국'),
    },
    quote: q,
  };
}

function quotes_(keys) {
  keys = keys.slice(0, 50);
  const cache = CacheService.getScriptCache();
  const cached = cache.getAll(keys);
  const out = {};
  const todo = keys.filter(k => {
    if (cached[k]) { out[k] = JSON.parse(cached[k]); return false; }
    return true;
  });

  const reqs = todo.map(k => {
    const [nation, code] = k.split(':');
    const url = nation === 'KOR'
      ? 'https://m.stock.naver.com/api/stock/' + encodeURIComponent(code) + '/basic'
      : 'https://api.stock.naver.com/stock/' + encodeURIComponent(code) + '/basic';
    return { url, headers: UA_, muteHttpExceptions: true };
  });
  const resps = reqs.length ? UrlFetchApp.fetchAll(reqs) : [];

  resps.forEach((res, i) => {
    const k = todo[i];
    try {
      const d = JSON.parse(res.getContentText());
      const num = s => parseFloat(String(s).replace(/,/g, ''));
      let chg = num(d.fluctuationsRatio);
      const dir = d.compareToPreviousPrice && d.compareToPreviousPrice.name;
      if ((dir === 'FALLING' || dir === 'LOWER_LIMIT') && chg > 0) chg = -chg;
      const q = {
        name: d.stockName,
        price: num(d.closePrice),
        cur: k.startsWith('KOR:') ? 'KRW' : ((d.currencyType && d.currencyType.code) || 'USD'),
        chg: isFinite(chg) ? chg : 0,
        at: d.localTradedAt || null,
      };
      if (!isFinite(q.price)) throw new Error('no price');
      out[k] = q;
      cache.put(k, JSON.stringify(q), 60); // 1분 캐시
    } catch (err) {
      out[k] = { error: '시세를 찾지 못했어요' };
    }
  });
  return { quotes: out };
}
