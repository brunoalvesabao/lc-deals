// =====================================================================
// LC Deals — coletor de ofertas (roda no GitHub Actions)
//
// Estratégia: buscar nas FONTES ORIGINAIS, não nos agregadores.
//   PC (Steam, Epic, Nuuvem, Humble) -> API do IsThereAnyDeal (preço em R$ + menor histórico)
//   Jogos grátis                     -> Epic (oficial) + brindes do IsThereAnyDeal
//   Xbox                             -> API pública da Microsoft Store (mercado BR)
//   Nintendo                         -> busca da Nintendo (Algolia) + API oficial de preços BR
//   PlayStation                      -> PS Store BR (a mesma API que o site deles usa)
//   Gift cards                       -> Nuuvem e Instant Gaming (navegador invisível)
//
// NTDeals/XBDeals/PSDeals NÃO são usados: eles só repetem os preços das lojas
// oficiais e bloqueiam robôs (Cloudflare). Buscando direto na fonte não há bloqueio.
//
// Cada coletor é isolado: se um falhar, os outros continuam, e o motivo vai
// para a tabela sync_runs (aparece no site) e para o log do Actions.
// =====================================================================

import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import fs from 'node:fs';

chromium.use(stealth());

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ITAD_KEY = process.env.ITAD_API_KEY;
const ITAD_MAX_PAGES = Number(process.env.ITAD_MAX_PAGES || 50); // 200 ofertas por página por loja
const ONLY = (process.env.ONLY_SOURCES || '').split(',').map(s => s.trim()).filter(Boolean);

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Faltam os secrets SUPABASE_URL e/ou SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
const RUN_STARTED = new Date().toISOString();
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
fs.mkdirSync('debug', { recursive: true });

// ---------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const round2 = n => (n == null || Number.isNaN(Number(n)) ? null : Math.round(Number(n) * 100) / 100);

function gameKey(title) {
  return String(title || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[™®©]/g, '')
    .replace(/\((?=[^)]*\b(ps4|ps5|xbox|switch|pc|windows)\b)[^)]*\)/gi, ' ')
    .replace(/\s*[-–:|]\s*(ps4|ps5|xbox series x\|s|xbox one|xbox|nintendo switch|switch|pc)((\s*(e|&|and|\/|,)\s*)(ps4|ps5|xbox series x\|s|xbox one))*\s*$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function parseMoney(text) {
  if (text == null) return null;
  if (typeof text === 'number') return text;
  const s = String(text);
  if (/gr[aá]tis|free|gratuito/i.test(s)) return 0;
  const m = s.replace(/[\s ]/g, '').match(/\d[\d.,]*/);
  if (!m) return null;
  let n = m[0].replace(/[.,]+$/, '');
  const lastDot = n.lastIndexOf('.');
  const lastComma = n.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    // os dois aparecem: o último é o separador decimal
    const dec = lastDot > lastComma ? '.' : ',';
    const thou = dec === '.' ? ',' : '.';
    n = n.split(thou).join('').replace(dec, '.');
  } else if (lastComma >= 0) {
    n = /,\d{1,2}$/.test(n) ? n.replace(/,(?=\d{3}(\D|$))/g, '').replace(',', '.') : n.replace(/,/g, '');
  } else if (lastDot >= 0) {
    n = /\.\d{3}$/.test(n) ? n.replace(/\./g, '') : n.replace(/\.(?=.*\.)/g, '');
  }
  const v = parseFloat(n);
  return Number.isNaN(v) ? null : v;
}

function pct(orig, sale) {
  if (!orig || orig <= 0 || sale == null) return 0;
  return Math.max(0, Math.round((1 - sale / orig) * 100));
}

function slugify(t) {
  return gameKey(t).replace(/\s+/g, '-') || 'jogo';
}

function classifyGiftCard(title) {
  const t = title.toLowerCase();
  const isGift = /gift ?card|cart[aã]o|wallet|saldo|cr[eé]ditos?|psn|eshop|xbox live|game ?pass|playstation plus|ps plus|nintendo switch online|assinatura|membership/.test(t);
  let platform = 'giftcard';
  return { isGift, platform };
}

async function fetchJson(url, opts = {}, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { ...opts, headers: { 'User-Agent': UA, Accept: 'application/json', ...(opts.headers || {}) } });
      if (res.status === 429) {
        const wait = Number(res.headers.get('retry-after') || 10) * 1000;
        console.log(`   429 (limite), esperando ${wait / 1000}s...`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} em ${url.split('?')[0]}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      await sleep(1000 * (i + 1));
    }
  }
  throw lastErr;
}

// Cotação para lojas que às vezes devolvem USD/EUR (Humble, Instant Gaming)
const rateCache = {};
async function toBRL(amount, currency) {
  if (amount == null || !currency || currency === 'BRL') return { value: amount, currency: 'BRL' };
  try {
    if (!rateCache[currency]) {
      const j = await fetchJson(`https://open.er-api.com/v6/latest/${currency}`);
      rateCache[currency] = j?.rates?.BRL;
    }
    if (rateCache[currency]) return { value: round2(amount * rateCache[currency]), currency: `${currency}>BRL` };
  } catch { /* segue sem converter */ }
  return { value: amount, currency };
}

function baseRow(source, fields) {
  const original = round2(fields.original_price);
  const sale = round2(fields.discount_price);
  return {
    id: fields.id,
    source,
    game_key: gameKey(fields.title),
    title: String(fields.title).trim().slice(0, 300),
    store: fields.store,
    platform: fields.platform,
    category: fields.category,
    original_price: original,
    discount_price: sale,
    discount_pct: fields.discount_pct ?? pct(original, sale),
    currency: fields.currency || 'BRL',
    history_low: round2(fields.history_low),
    image_url: fields.image_url || null,
    deal_url: fields.deal_url,
    expires_at: fields.expires_at || null,
    last_seen_at: RUN_STARTED,
  };
}

async function dump(page, name) {
  try {
    await page.screenshot({ path: `debug/${name}.png`, fullPage: false });
    fs.writeFileSync(`debug/${name}.html`, await page.content());
  } catch { /* ignora */ }
}

function withTimeout(promise, ms, label) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label}: tempo esgotado (${ms / 1000}s)`)), ms))]);
}

// ---------------------------------------------------------------------
// 1) IsThereAnyDeal — Steam, Epic, Nuuvem, Humble (PC) em R$
// ---------------------------------------------------------------------
const PC_STORES = [
  { key: 'steam', match: /^steam$/i, fallbackId: 61 },
  { key: 'epic', match: /epic/i, fallbackId: 16 },
  { key: 'nuuvem', match: /nuuvem/i, fallbackId: 50 },
  { key: 'humble', match: /humble/i, fallbackId: 37 },
];

async function itadShops() {
  const list = await fetchJson(`https://api.isthereanydeal.com/service/shops/v1?country=BR`);
  const map = {};
  for (const s of PC_STORES) {
    const found = (list || []).find(x => s.match.test(x.title || x.name || ''));
    map[s.key] = found ? found.id : s.fallbackId;
  }
  return map;
}

async function collectItad() {
  if (!ITAD_KEY) throw new Error('Falta o secret ITAD_API_KEY (crie grátis em isthereanydeal.com/apps/my)');
  const shops = await itadShops();
  console.log('   IDs das lojas no ITAD:', shops);
  const rows = [];
  for (const store of PC_STORES) {
    let offset = 0;
    let pages = 0;
    let n = 0;
    while (pages < ITAD_MAX_PAGES) {
      const url = `https://api.isthereanydeal.com/deals/v2?key=${ITAD_KEY}&country=BR&shops=${shops[store.key]}&limit=200&offset=${offset}&sort=-cut`;
      const j = await fetchJson(url);
      for (const g of j.list || []) {
        const d = g.deal || {};
        const sale = await toBRL(d.price?.amount, d.price?.currency);
        const reg = await toBRL(d.regular?.amount, d.regular?.currency);
        const low = await toBRL(d.historyLow?.amount, d.historyLow?.currency);
        const a = g.assets || {};
        let category = g.type === 'dlc' ? 'dlc' : 'game_deal';
        if (sale.value === 0) category = 'free_game';
        rows.push(baseRow('itad', {
          id: `${store.key}:itad-${g.id}`,
          title: g.title,
          store: store.key,
          platform: 'pc',
          category,
          original_price: reg.value,
          discount_price: sale.value,
          discount_pct: d.cut,
          currency: sale.currency,
          history_low: low.value,
          image_url: a.banner400 || a.banner300 || a.banner600 || a.boxart || null,
          deal_url: d.url,
          expires_at: d.expiry,
        }));
        n++;
      }
      pages++;
      if (!j.hasMore) break;
      offset = j.nextOffset ?? offset + 200;
      await sleep(250);
    }
    console.log(`   ${store.key}: ${n} ofertas (${pages} páginas)`);
  }

  // Bundles da Humble
  try {
    let offset = 0;
    for (let p = 0; p < 6; p++) {
      const list = await fetchJson(`https://api.isthereanydeal.com/bundles/v1?key=${ITAD_KEY}&country=BR&limit=50&offset=${offset}`);
      if (!Array.isArray(list) || list.length === 0) break;
      for (const b of list) {
        if (!/humble/i.test(b.page?.name || '')) continue;
        const prices = (b.tiers || []).map(t => t.price).filter(Boolean);
        const cheapest = prices.sort((x, y) => x.amount - y.amount)[0];
        const conv = cheapest ? await toBRL(cheapest.amount, cheapest.currency) : { value: null, currency: 'BRL' };
        const firstGame = b.tiers?.flatMap(t => t.games || [])[0];
        rows.push(baseRow('itad', {
          id: `humble:bundle-${b.id}`,
          title: b.title,
          store: 'humble',
          platform: 'pc',
          category: 'bundle',
          original_price: null,
          discount_price: conv.value,
          discount_pct: 0,
          currency: conv.currency,
          image_url: firstGame?.assets?.banner400 || firstGame?.assets?.banner300 || null,
          deal_url: b.url,
          expires_at: b.expiry,
        }));
      }
      offset += 50;
      await sleep(250);
    }
  } catch (e) {
    console.warn('   bundles: ', e.message);
  }

  // Brindes (jogos grátis para resgatar em qualquer loja de PC)
  try {
    const gws = await fetchJson(`https://api.isthereanydeal.com/giveaways/v1?key=${ITAD_KEY}&limit=50`);
    for (const gw of gws || []) {
      const shopName = (gw.shop?.name || '').toLowerCase();
      const store = PC_STORES.find(s => s.match.test(shopName))?.key || 'outras';
      for (const g of gw.games || [{ title: gw.title }]) {
        rows.push(baseRow('itad', {
          id: `${store}:giveaway-${gw.id}-${g.id || slugify(g.title)}`,
          title: g.title || gw.title,
          store,
          platform: 'pc',
          category: 'free_game',
          original_price: null,
          discount_price: 0,
          discount_pct: 100,
          image_url: g.assets?.banner400 || g.assets?.banner300 || null,
          deal_url: gw.url,
          expires_at: gw.expiry,
        }));
      }
    }
  } catch (e) {
    console.warn('   brindes: ', e.message);
  }

  return rows;
}

// ---------------------------------------------------------------------
// 2) Epic — grátis agora e grátis em breve (API oficial)
// ---------------------------------------------------------------------
async function collectEpicFree() {
  const j = await fetchJson('https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=pt-BR&country=BR&allowCountries=BR');
  const elements = j?.data?.Catalog?.searchStore?.elements || [];
  const rows = [];
  for (const g of elements) {
    const now = g.promotions?.promotionalOffers?.[0]?.promotionalOffers || [];
    const soon = g.promotions?.upcomingPromotionalOffers?.[0]?.promotionalOffers || [];
    const freeNow = now.find(o => o.discountSetting?.discountPercentage === 0);
    const freeSoon = soon.find(o => o.discountSetting?.discountPercentage === 0);
    if (!freeNow && !freeSoon) continue;
    const offer = freeNow || freeSoon;
    const slug = g.catalogNs?.mappings?.[0]?.pageSlug || g.offerMappings?.[0]?.pageSlug || g.productSlug || g.urlSlug;
    const img = (g.keyImages || []).find(i => i.type === 'OfferImageWide')
      || (g.keyImages || []).find(i => i.type === 'DieselStoreFrontWide')
      || (g.keyImages || []).find(i => i.type === 'Thumbnail')
      || (g.keyImages || [])[0];
    rows.push(baseRow('epic_free', {
      id: `epic:free-${g.id}`,
      title: g.title,
      store: 'epic',
      platform: 'pc',
      category: freeNow ? 'free_game' : 'free_upcoming',
      original_price: (g.price?.totalPrice?.originalPrice ?? 0) / 100,
      discount_price: 0,
      discount_pct: 100,
      image_url: img?.url,
      deal_url: slug ? `https://store.epicgames.com/pt-BR/p/${slug}` : 'https://store.epicgames.com/pt-BR/free-games',
      expires_at: freeNow ? offer.endDate : offer.startDate, // "em breve": guarda quando começa
    }));
  }
  return rows;
}

// ---------------------------------------------------------------------
// 3) Xbox — API pública da Microsoft Store (mercado BR)
// ---------------------------------------------------------------------
async function collectXboxApi() {
  const ids = new Set();
  for (const type of ['Game', 'Durable']) {
    let skip = 0;
    for (let p = 0; p < 30; p++) {
      const url = `https://reco-public.rec.mp.microsoft.com/channels/Reco/V8.0/Lists/Computed/Deal?Market=BR&Language=pt&ItemTypes=${type}&deviceFamily=Windows.Xbox&count=200&skipitems=${skip}`;
      let j;
      try { j = await fetchJson(url); } catch (e) { console.warn(`   xbox ${type}:`, e.message); break; }
      const items = j?.Items || [];
      items.forEach(i => i.Id && ids.add(i.Id));
      const total = j?.PagingInfo?.TotalItems ?? 0;
      skip += items.length;
      if (items.length === 0 || skip >= total) break;
    }
  }
  console.log(`   IDs de ofertas Xbox: ${ids.size}`);
  if (ids.size === 0) throw new Error('a lista de ofertas da Microsoft voltou vazia');

  const rows = [];
  for (const group of chunk([...ids], 20)) {
    const url = `https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=${group.join(',')}&market=BR&languages=pt-br&MS-CV=DGU1mcuYo0WMMp+F.1`;
    let j;
    try { j = await fetchJson(url); } catch (e) { console.warn('   lote xbox falhou:', e.message); continue; }
    for (const p of j?.Products || []) {
      const lp = p.LocalizedProperties?.[0] || {};
      let best = null;
      for (const sku of p.DisplaySkuAvailabilities || []) {
        for (const av of sku.Availabilities || []) {
          if (!(av.Actions || []).includes('Purchase')) continue;
          if (av.RemediationRequired) continue; // desconto só para assinantes (Game Pass)
          const price = av.OrderManagementData?.Price;
          if (!price || price.CurrencyCode !== 'BRL') continue;
          if (!(price.ListPrice < price.MSRP)) continue;
          if (!best || price.ListPrice < best.price.ListPrice) best = { price, av };
        }
      }
      if (!best) continue;
      const imgs = lp.Images || [];
      const pick = ['TitledHeroArt', 'SuperHeroArt', 'BrandedKeyArt', 'Poster', 'BoxArt']
        .map(k => imgs.find(i => i.ImagePurpose === k)).find(Boolean);
      const img = pick?.Uri ? `${pick.Uri.startsWith('//') ? 'https:' : ''}${pick.Uri}?w=480` : null;
      const isAddon = p.ProductType === 'Durable';
      rows.push(baseRow('xbox', {
        id: `xbox:${p.ProductId}`,
        title: lp.ProductTitle,
        store: 'xbox',
        platform: 'xbox',
        category: isAddon ? 'dlc' : 'game_deal',
        original_price: best.price.MSRP,
        discount_price: best.price.ListPrice,
        image_url: img,
        deal_url: `https://www.xbox.com/pt-BR/games/store/${slugify(lp.ProductTitle)}/${p.ProductId}`,
        expires_at: best.av.Conditions?.EndDate && !best.av.Conditions.EndDate.startsWith('9998') ? best.av.Conditions.EndDate : null,
      }));
    }
    await sleep(150);
  }
  return rows;
}

// Plano B do Xbox: abre o xbox.com BR, clica em "Carregar mais" e captura os dados da página
function xboxRowsFrom(json, seen) {
  const rows = [];
  walk(json, o => {
    const id = o.productId || o.ProductId;
    const title = o.title || o.Title || o.name;
    if (!id || !title || seen.has(id)) return;
    const sp = o.specificPrices?.purchaseable?.[0] || o.specificPrices?.Purchaseable?.[0];
    const price = sp || o.price || o.Price;
    if (!price || typeof price !== 'object') return;
    const list = Number(price.listPrice ?? price.ListPrice);
    const msrp = Number(price.msrp ?? price.MSRP);
    if (!(list >= 0) || !(msrp > 0) || !(list < msrp)) return;
    seen.add(id);
    const im = o.images || o.Images || {};
    const pick = im.superHeroArt || im.titledHeroArt || im.boxArt || im.poster || im.SuperHeroArt || im.BoxArt;
    let img = typeof pick === 'string' ? pick : pick?.url || pick?.Uri || null;
    if (img && img.startsWith('//')) img = `https:${img}`;
    rows.push(baseRow('xbox', {
      id: `xbox:${id}`,
      title,
      store: 'xbox',
      platform: 'xbox',
      category: /durable|add-?on|dlc/i.test(o.productKind || o.ProductKind || '') ? 'dlc' : 'game_deal',
      original_price: msrp,
      discount_price: list,
      image_url: img ? `${img}${img.includes('?') ? '&' : '?'}w=480` : null,
      deal_url: `https://www.xbox.com/pt-BR/games/store/${slugify(title)}/${id}`,
      expires_at: sp?.endDate && !String(sp.endDate).startsWith('9998') ? sp.endDate : null,
    }));
  });
  return rows;
}

async function collectXboxBrowser() {
  const page = await newPage();
  const seen = new Set();
  const rows = [];
  jsonCatcher(page, json => rows.push(...xboxRowsFrom(json, seen)));
  const candidates = [
    'https://www.xbox.com/pt-BR/games/browse/DynamicChannel.GameDeals',
    'https://www.xbox.com/pt-BR/promotions/sales/sales-and-specials',
    'https://www.xbox.com/pt-BR/games/all-games/console',
  ];
  for (const url of candidates) {
    const before = rows.length;
    await gotoFast(page, url, { settle: 8000 }).catch(e => console.warn('   xbox goto:', e.message));
    await acceptCookies(page);
    // Dados que vêm embutidos no HTML (primeira página)
    const embedded = await page.evaluate(() => {
      const out = [];
      for (const sc of document.querySelectorAll('script')) {
        const t = sc.textContent || '';
        const m = t.match(/window\.__PRELOADED_STATE__\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
        if (m) out.push(m[1]);
        else if (sc.type === 'application/json' && t.length > 1000) out.push(t);
      }
      return out;
    }).catch(() => []);
    for (const e of embedded) { try { rows.push(...xboxRowsFrom(JSON.parse(e), seen)); } catch { /* ignora */ } }
    await loadMoreUntilDone(page, { label: 'xbox', textRe: /carreg\w*\s+mais|mostrar mais|load more/i, count: () => rows.length, maxClicks: 200 });
    console.log(`   xbox ${url.split('/').slice(-1)[0]}: +${rows.length - before} ofertas`);
    if (rows.length >= 300) break;
  }
  if (rows.length < 50) await dump(page, 'xbox');
  await page.context().close();
  return rows;
}

async function collectXbox() {
  let rows = [];
  try {
    rows = await collectXboxApi();
    console.log(`   xbox (API): ${rows.length} ofertas`);
  } catch (e) {
    console.warn(`   xbox (API) falhou: ${e.message} — tentando pelo xbox.com`);
  }
  if (rows.length < 50) {
    const seen = new Set(rows.map(r => r.id));
    for (const r of await collectXboxBrowser()) if (!seen.has(r.id)) rows.push(r);
  }
  return rows;
}

// ---------------------------------------------------------------------
// Navegador invisível (com "stealth" para não parecer robô)
// ---------------------------------------------------------------------
let browser;
async function newPage() {
  if (!browser) browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] });
  const ctx = await browser.newContext({ locale: 'pt-BR', timezoneId: 'America/Sao_Paulo', userAgent: UA, viewport: { width: 1366, height: 900 }, extraHTTPHeaders: { 'Accept-Language': 'pt-BR,pt;q=0.9' }, geolocation: { latitude: -15.79, longitude: -47.88 }, permissions: ['geolocation'] });
  return ctx.newPage();
}

// ---------------------------------------------------------------------
// Ajudante: clica em "Carregar mais" até a lista parar de crescer
// ---------------------------------------------------------------------
async function acceptCookies(page) {
  for (const re of [/aceitar|accept all|accept|concordo|permitir/i]) {
    const btn = page.getByRole('button', { name: re }).first();
    if (await btn.isVisible().catch(() => false)) { await btn.click().catch(() => {}); await sleep(800); }
  }
}

async function loadMoreUntilDone(page, { label, textRe, count, maxClicks = 200 }) {
  // count() pode ser assíncrono; depois de cada clique espera a lista crescer (no máx. 10s) em vez de esperar a rede "parar"
  let stale = 0;
  let clicks = 0;
  let last = await count();
  const t0 = Date.now();
  while (clicks < maxClicks && stale < 3) {
    let btn = page.locator('button').filter({ hasText: textRe }).last();
    if (!(await btn.count().catch(() => 0))) {
      await page.mouse.wheel(0, 20000);
      await sleep(1200);
      btn = page.locator('button').filter({ hasText: textRe }).last();
      if (!(await btn.count().catch(() => 0))) break;
    }
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await btn.click({ timeout: 10000 }).catch(() => {});
    clicks++;
    let now = last;
    for (let i = 0; i < 33; i++) {
      await sleep(300);
      now = await count();
      if (now > last) break;
    }
    if (now > last) await sleep(400); // deixa terminar de chegar o lote
    now = await count();
    stale = now > last ? 0 : stale + 1;
    last = now;
    if (clicks % 10 === 0) console.log(`   ${label}: ${clicks} cliques, ${now} itens (${Math.round((Date.now() - t0) / 1000)}s)`);
  }
  console.log(`   ${label}: fim após ${clicks} cliques (${last} itens, ${Math.round((Date.now() - t0) / 1000)}s)`);
}

// Abre a página sem esperar a rede "ficar parada" (lojas grandes nunca param: anúncios, estatísticas...).
// Espera o HTML, dá até 4s para o resto e segue. Antes cada página podia travar 45–60s.
async function gotoFast(page, url, { settle = 4000, timeout = 30000 } = {}) {
  const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  await page.waitForLoadState('networkidle', { timeout: settle }).catch(() => {});
  return resp;
}

function jsonCatcher(page, onJson) {
  page.on('response', async res => {
    const ct = res.headers()['content-type'] || '';
    if (!ct.includes('json')) return;
    try { onJson(await res.json()); } catch { /* ignora */ }
  });
}

// ---------------------------------------------------------------------
// 4) Nintendo — abre a página de promoções BR, clica em "Carregar mais"
//    e captura os dados que o próprio site recebe
// ---------------------------------------------------------------------
async function collectNintendo() {
  const page = await newPage();
  const found = new Map();
  const take = json => walk(json, o => {
    if (o.nsuid && o.name && o.urlKey && o.prices && typeof o.prices === 'object') found.set(String(o.nsuid), o);
  });
  jsonCatcher(page, take);

  await gotoFast(page, 'https://www.nintendo.com/pt-br/store/sales-and-deals/', { settle: 10000 })
    .catch(e => console.warn('   nintendo goto:', e.message));
  await acceptCookies(page);
  const nextData = await page.$eval('#__NEXT_DATA__', el => el.textContent).catch(() => null);
  if (nextData) { try { take(JSON.parse(nextData)); } catch { /* ignora */ } }
  console.log(`   nintendo: ${found.size} itens na 1ª página`);

  // Clica em "Carregue mais" até acabar (40 jogos por clique)
  const cardSel = 'a[href*="/store/products/"]';
  await loadMoreUntilDone(page, {
    label: 'nintendo',
    textRe: /carreg\w*\s+mais|load more/i,
    count: async () => Math.max(found.size, await page.locator(cardSel).count().catch(() => 0)),
    maxClicks: 200,
  });

  // Plano B: lê os cards que estão na tela (caso algum lote não tenha passado pela captura de dados)
  const domCards = await page.evaluate((sel) => {
    const out = []; const seen = new Set();
    for (const a of document.querySelectorAll(sel)) {
      const key = (a.getAttribute('href').match(/products\/([^/?#]+)/) || [])[1];
      if (!key || seen.has(key)) continue;
      let card = a;
      for (let i = 0; i < 6 && card.parentElement && !/R\$\s*\d/.test(card.innerText || ''); i++) card = card.parentElement;
      const text = card.innerText || '';
      const prices = text.match(/R\$\s*\d[\d.,]*/g) || [];
      if (prices.length < 2) continue;
      seen.add(key);
      const img = card.querySelector('img');
      const title = (card.querySelector('h2, h3, [class*="title" i]')?.innerText || img?.alt || '').trim().split('\n')[0];
      out.push({ key, title, prices, img: img ? (img.currentSrc || img.src) : null });
    }
    return out;
  }, cardSel).catch(() => []);
  const byKey = new Set([...found.values()].map(o => o.urlKey));
  const extraDom = domCards.filter(c => !byKey.has(c.key) && c.title);
  console.log(`   nintendo: ${found.size} pela captura, ${domCards.length} cards na tela, ${extraDom.length} extras pela tela`);

  if (found.size < 100) await dump(page, 'nintendo');
  await page.context().close();
  if (found.size === 0) throw new Error('a página de promoções da Nintendo não entregou jogos (veja debug/nintendo.png)');

  // Preço: se a página já veio em R$, usa direto. Se veio em dólar, consulta a API oficial BR.
  const needBR = [...found.values()].filter(o => o.prices.currency !== 'BRL').map(o => String(o.nsuid));
  const brPrices = new Map();
  for (const group of chunk(needBR, 50)) {
    try {
      const j = await fetchJson(`https://api.ec.nintendo.com/v1/price?country=BR&lang=pt&ids=${group.join(',')}`);
      for (const pr of j.prices || []) {
        if (pr.discount_price && pr.sales_status === 'onsale') {
          brPrices.set(String(pr.title_id), { regular: parseFloat(pr.regular_price?.raw_value), sale: parseFloat(pr.discount_price.raw_value), end: pr.discount_price.end_datetime });
        }
      }
    } catch (e) { console.warn('   preço BR nintendo:', e.message); }
    await sleep(200);
  }

  const rows = [];
  for (const o of found.values()) {
    let regular; let sale; let end = o.eshopDetails?.discountPriceEnd || null;
    if (o.prices.currency === 'BRL') {
      if (!o.prices.discounted) continue;
      regular = o.prices.regularPrice; sale = o.prices.finalPrice;
    } else {
      const br = brPrices.get(String(o.nsuid));
      if (!br) continue;
      regular = br.regular; sale = br.sale; end = br.end || end;
    }
    if (regular == null || sale == null || !(sale < regular)) continue;
    const pid = o.productImage?.publicId;
    const img = pid
      ? `https://assets.nintendo.com/image/upload/ar_16:9,b_auto:border,c_lpad/b_white/f_auto/q_auto/c_scale,w_480/${pid}`
      : o.productImageSquare?.url || null;
    const topCat = typeof o.topLevelCategory === 'string' ? o.topLevelCategory : `${o.topLevelCategory?.code || ''} ${o.topLevelCategory?.label || ''}`;
    rows.push(baseRow('nintendo', {
      id: `nintendo:${o.nsuid}`,
      title: o.name,
      store: 'nintendo',
      platform: 'switch',
      category: o.dlcType || /dlc|conte[uú]do|add-on|adicional/i.test(topCat) ? 'dlc' : 'game_deal',
      original_price: regular,
      discount_price: sale,
      image_url: img,
      deal_url: `https://www.nintendo.com/pt-br/store/products/${o.urlKey}/`,
      expires_at: end,
    }));
  }
  for (const c of extraDom) {
    const nums = c.prices.map(parseMoney).filter(v => v != null).sort((x, y) => x - y);
    const sale = nums[0]; const regular = nums[nums.length - 1];
    if (!(sale < regular)) continue;
    rows.push(baseRow('nintendo', {
      id: `nintendo:${c.key}`,
      title: c.title,
      store: 'nintendo',
      platform: 'switch',
      category: 'game_deal',
      original_price: regular,
      discount_price: sale,
      image_url: c.img && !c.img.startsWith('data:') ? c.img : null,
      deal_url: `https://www.nintendo.com/pt-br/store/products/${c.key}/`,
    }));
  }
  return rows;
}

// ---------------------------------------------------------------------
// 5) PlayStation — usa a mesma API (GraphQL) que a PS Store BR usa
// ---------------------------------------------------------------------
function walk(obj, fn, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 25) return;
  fn(obj);
  for (const v of Array.isArray(obj) ? obj : Object.values(obj)) walk(v, fn, depth + 1);
}

function psRowsFrom(json, seen) {
  const rows = [];
  walk(json, o => {
    if (!o.id || !o.name || !o.price || typeof o.price !== 'object') return;
    if (seen.has(o.id)) return;
    const pr = o.price;
    if (pr.isTiedToSubscription) return; // desconto só para PS Plus
    const base = parseMoney(pr.basePrice);
    const sale = parseMoney(pr.discountedPrice);
    if (base == null || sale == null || !(sale < base)) return;
    seen.add(o.id);
    const media = o.media || [];
    const img = (media.find(m => m.role === 'BACKGROUND') || media.find(m => m.role === 'GAMEHUB_COVER_ART') || media.find(m => m.role === 'MASTER') || media.find(m => m.type === 'IMAGE'))?.url;
    rows.push(baseRow('playstation', {
      id: `playstation:${o.id}`,
      title: o.name,
      store: 'playstation',
      platform: 'ps',
      category: /add.?on|dlc|pacote|season|expans/i.test(`${o.storeDisplayClassification || ''} ${o.localizedStoreDisplayClassification || ''}`) ? 'dlc' : 'game_deal',
      original_price: base,
      discount_price: sale,
      image_url: img ? `${img}?w=480` : null,
      deal_url: `https://store.playstation.com/pt-br/product/${o.id}`,
      expires_at: pr.endTime ? new Date(Number(pr.endTime)).toISOString() : null,
      currency: 'BRL',
    }));
  });
  return rows;
}

async function collectPlayStation() {
  const page = await newPage();
  const gridReqs = [];
  const seen = new Set();
  let rows = [];
  page.on('request', req => {
    const u = req.url();
    if (u.includes('/api/graphql/v1') && u.includes('categoryGridRetrieve')) gridReqs.push({ url: u, headers: req.headers() });
  });
  page.on('response', async res => {
    if (!res.url().includes('/api/graphql/v1')) return;
    try { rows.push(...psRowsFrom(await res.json(), seen)); } catch { /* ignora */ }
  });

  await gotoFast(page, 'https://store.playstation.com/pt-br/pages/deals', { settle: 10000 }).catch(e => console.warn('   ps goto:', e.message));
  await sleep(2000);
  const catIds = [...new Set((await page.$$eval('a[href*="/category/"]', as => as.map(a => a.getAttribute('href'))).catch(() => []))
    .map(h => (h.match(/category\/([0-9a-f-]{36})/) || [])[1]).filter(Boolean))];
  console.log(`   categorias de ofertas na PS Store: ${catIds.length}`);
  if (catIds.length === 0) { await dump(page, 'playstation'); }

  // Abre a 1ª categoria para "aprender" a chamada da API
  if (catIds.length && gridReqs.length === 0) {
    await gotoFast(page, `https://store.playstation.com/pt-br/category/${catIds[0]}/1`, { settle: 10000 }).catch(() => {});
    await sleep(2000);
  }

  if (gridReqs.length) {
    const tpl = new URL(gridReqs[0].url);
    const hdrs = Object.fromEntries(Object.entries(gridReqs[0].headers).filter(([k]) => /^(x-psn|apollo|content-type|accept-language)/i.test(k)));
    for (const cat of catIds) {
      for (let offset = 0; offset < 3000; offset += 100) {
        const vars = JSON.parse(tpl.searchParams.get('variables') || '{}');
        vars.id = cat;
        vars.pageArgs = { size: 100, offset };
        const u = new URL(tpl);
        u.searchParams.set('variables', JSON.stringify(vars));
        const json = await page.evaluate(async ({ url, headers }) => {
          try { const r = await fetch(url, { headers, credentials: 'include' }); return await r.json(); } catch (e) { return null; }
        }, { url: u.toString(), headers: hdrs });
        const grid = json?.data?.categoryGridRetrieve;
        rows.push(...psRowsFrom(json, seen));
        const total = grid?.pageInfo?.totalCount ?? 0;
        if (!grid || !(grid.products || []).length || offset + 100 >= total) break;
        await sleep(300);
      }
    }
  } else {
    // Plano B: navega página por página e captura o que o site carregar
    console.log('   (plano B) navegando pelas páginas das categorias');
    for (const cat of catIds.slice(0, 8)) {
      for (let n = 1; n <= 15; n++) {
        const before = rows.length;
        await gotoFast(page, `https://store.playstation.com/pt-br/category/${cat}/${n}`).catch(() => {});
        const nextData = await page.$eval('#__NEXT_DATA__', el => el.textContent).catch(() => null);
        if (nextData) { try { rows.push(...psRowsFrom(JSON.parse(nextData), seen)); } catch { /* ignora */ } }
        if (rows.length === before) break;
      }
    }
  }
  if (rows.length === 0) await dump(page, 'playstation');
  await page.context().close();
  return rows;
}

// ---------------------------------------------------------------------
// 6) Gift cards — Nuuvem e Instant Gaming (leitura genérica dos cards da página)
// ---------------------------------------------------------------------
// Lê os cards de produto de uma página de listagem.
// O "card" de cada link é o MAIOR bloco que ainda contém só aquele produto (sem outros links de produto).
// Antes, o robô subia até achar um preço e acabava pegando a lista inteira (mesma imagem/preço em todos).
async function scrapeCards(page, linkPattern, anchorSelector = 'a[href]') {
  return page.evaluate(({ pattern, anchorSelector }) => {
    const re = new RegExp(pattern);
    const keyOf = h => h.split('?')[0].split('#')[0].replace(/\/$/, '');
    const MONEY = /(R\$|€|US\$|\$|£)\s*\d[\d.,]*/g;
    const links = [...document.querySelectorAll(anchorSelector)].filter(a => a.href && re.test(a.href));
    const out = [];
    const seen = new Set();
    for (const a of links) {
      const key = keyOf(a.href);
      if (seen.has(key)) continue;
      let card = a;
      while (card.parentElement && card.parentElement !== document.body) {
        const others = [...card.parentElement.querySelectorAll(anchorSelector)]
          .filter(x => x.href && re.test(x.href) && keyOf(x.href) !== key);
        if (others.length) break;
        card = card.parentElement;
      }
      const titleEl = card.querySelector('[class*="title" i], [class*="name" i], h2, h3, h4');
      const img = card.querySelector('img');
      const title = (titleEl?.innerText || a.getAttribute('title') || img?.alt || a.innerText || '').trim().split('\n')[0];
      let text = card.innerText || '';
      if (title) text = text.split(title).join(' ');      // não confundir "R$ 100" do nome do cartão com o preço
      const prices = text.match(MONEY) || [];
      if (!prices.length) continue;
      seen.add(key);
      const disc = (text.match(/-\s?(\d{1,2})\s?%/) || [])[1];
      const src = img ? (img.currentSrc || img.getAttribute('data-src') || img.src || '') : '';
      out.push({ href: a.href, title, prices, discount: disc ? Number(disc) : 0, img: src && !src.startsWith('data:') ? src : null });
    }
    return out;
  }, { pattern: linkPattern.source, anchorSelector });
}

async function cardsToRows(cards, { source, store }) {
  const rows = [];
  for (const c of cards) {
    if (!c.title || c.title.length < 3) continue;
    const { isGift } = classifyGiftCard(c.title);
    const values = c.prices.map(p => ({ v: parseMoney(p), cur: p.includes('R$') ? 'BRL' : p.includes('€') ? 'EUR' : 'USD' })).filter(x => x.v != null);
    if (!values.length) continue;
    const cur = values[0].cur;
    const nums = values.map(x => x.v).sort((a, b) => a - b);
    let sale = nums[0];
    let orig = nums.length > 1 ? nums[nums.length - 1] : (c.discount ? sale / (1 - c.discount / 100) : sale);
    const s = await toBRL(sale, cur);
    const o = await toBRL(orig, cur);
    rows.push(baseRow(source, {
      id: `${store}:${slugify(c.href.split('?')[0].split('/').filter(Boolean).pop())}`,
      title: c.title,
      store,
      platform: isGift ? 'giftcard' : 'pc',
      category: isGift ? 'gift_card' : 'game_deal',
      original_price: o.value,
      discount_price: s.value,
      discount_pct: c.discount || pct(o.value, s.value),
      currency: s.currency,
      image_url: c.img && !c.img.startsWith('data:') ? c.img : null,
      deal_url: c.href,
    }));
  }
  return rows;
}

async function collectNuuvemGiftCards() {
  const page = await newPage();
  const rows = [];
  const terms = ['gift card', 'cartão presente', 'playstation store', 'xbox', 'nintendo eshop', 'steam'];
  for (const t of terms) {
    const url = `https://www.nuuvem.com/br-pt/catalog/search/${encodeURIComponent(t)}`;
    try {
      await gotoFast(page, url);
      await page.mouse.wheel(0, 4000);
      await sleep(1500);
      const cards = await scrapeCards(page, /nuuvem\.com\/br-pt\/item\//);
      const r = (await cardsToRows(cards, { source: 'nuuvem_gift', store: 'nuuvem' })).filter(x => x.category === 'gift_card');
      console.log(`   nuuvem "${t}": ${cards.length} cards, ${r.length} gift cards`);
      rows.push(...r);
    } catch (e) { console.warn(`   nuuvem "${t}":`, e.message); }
  }
  if (rows.length === 0) await dump(page, 'nuuvem');
  await page.context().close();
  return rows;
}

// Plataforma do gift card pela página onde ele aparece na Instant Gaming
function igPlatformFromUrl(u) {
  if (/\/xbox\//.test(u)) return 'xbox';
  if (/\/(playstation|psn)\//.test(u)) return 'ps';
  if (/\/(nintendo|switch)\//.test(u)) return 'switch';
  if (/\/(pc|steam|battle-net|ea-app|ubisoft)\//.test(u)) return 'pc';
  return null;
}

// Tenta deixar a Instant Gaming na região/moeda do Brasil (o robô roda nos EUA,
// e sem isso a loja mostra os cartões americanos em dólar/euro).
async function igPreferBrazil(page) {
  for (const u of ['https://www.instant-gaming.com/pt/?currency=BRL', 'https://www.instant-gaming.com/pt/?country=BR&currency=BRL']) {
    await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  }
  await acceptCookies(page);
  // Seletor de moeda/país no site (se existir): clica em BRL / Brasil
  const clicked = await page.evaluate(() => {
    const els = [...document.querySelectorAll('a, button, li, option, span, div')]
      .filter(e => e.children.length === 0 && /^\s*(BRL|R\$|Brasil|Brazil)\b/.test(e.textContent || ''));
    const el = els[0];
    if (!el) return null;
    if (el.tagName === 'OPTION') { el.selected = true; el.parentElement.dispatchEvent(new Event('change', { bubbles: true })); }
    else el.click();
    return el.textContent.trim().slice(0, 30);
  }).catch(() => null);
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  const brl = await page.evaluate(() => /R\$\s*\d/.test(document.body.innerText)).catch(() => false);
  console.log(`   instant gaming: região Brasil ${brl ? 'ATIVA (preços em R$)' : 'não confirmada'}${clicked ? ` — cliquei em "${clicked}"` : ''}`);
  return brl;
}

async function collectInstantGaming() {
  const page = await newPage();
  const rows = [];
  const IG = /instant-gaming\.com\/pt\/\d+-/;
  await igPreferBrazil(page);
  const roots = [
    'https://www.instant-gaming.com/pt/xbox/gift-cards/',
    'https://www.instant-gaming.com/pt/xbox/gift-cards/brands/microsoft-store/',
    'https://www.instant-gaming.com/pt/playstation/gift-cards/',
    'https://www.instant-gaming.com/pt/nintendo/gift-cards/',
    'https://www.instant-gaming.com/pt/pc/gift-cards/',
  ];
  const queue = [...roots];
  const visited = new Set();
  async function readListing(url, giftOnly) {
    const plat = igPlatformFromUrl(url);
    for (let pg = 1; pg <= 10; pg++) {
      const u = pg === 1 ? url : `${url}${url.includes('?') ? '&' : '?'}page=${pg}`;
      try {
        const resp = await gotoFast(page, u);
        if (resp && resp.status() >= 400) { console.log(`   instant gaming ${u}: HTTP ${resp.status()}`); break; }
      } catch (e) { console.warn(`   instant gaming ${u}: ${e.message}`); break; }
      // descobre outras páginas de gift cards (marcas) a partir desta
      const more = await page.$$eval('a[href*="/gift-cards/"]', as => as.map(a => a.href.split('#')[0].split('?')[0])).catch(() => []);
      for (const h of more) if (/instant-gaming\.com\/pt\/.+\/gift-cards\//.test(h) && !queue.includes(h)) queue.push(h);
      await page.mouse.wheel(0, 6000); await sleep(1200);
      const cards = await scrapeCards(page, IG);
      let r = await cardsToRows(cards, { source: 'instant_gaming', store: 'instant_gaming' });
      if (giftOnly) r = r.map(x => ({ ...x, category: 'gift_card', platform: plat || platformFromTitle(x.title) }));
      const ids = new Set(rows.map(x => x.id));
      const fresh = r.filter(x => !ids.has(x.id));
      rows.push(...fresh);
      console.log(`   instant gaming ${u.replace('https://www.instant-gaming.com/pt/', '')}: ${cards.length} cards, ${fresh.length} novos`);
      if (!fresh.length) break;
    }
  }
  for (let i = 0; i < queue.length && i < 40; i++) {
    const u = queue[i];
    if (visited.has(u)) continue; visited.add(u);
    await readListing(u, true);
  }
  // Cartões brasileiros pela busca (aparecem mesmo quando a região não muda)
  for (const q of ['BRL', 'Brasil', 'R$']) await readListing(`https://www.instant-gaming.com/pt/pesquisar/?q=${encodeURIComponent(q)}&type%5B%5D=gift-card`, true);
  const br = rows.filter(r => /\bBRL\b|R\$|reais|brasil/i.test(r.title)).length;
  console.log(`   instant gaming: ${rows.length} gift cards (${br} do Brasil)`);
  // Jogos mais vendidos (promoções)
  await readListing('https://www.instant-gaming.com/pt/pesquisar/?sort_by=bestsellers_desc', false);
  if (rows.length === 0) await dump(page, 'instant_gaming');
  await page.context().close();
  return rows;
}

// ---------------------------------------------------------------------
// 9) Loaded (antiga CDKeys) — loja em Magento.
//    1º tenta a API GraphQL da própria loja (rápida e completa); se não der, lê as páginas de categoria.
// ---------------------------------------------------------------------
const LOADED_BASE = 'https://www.loaded.com/pt_pt/';
const LOADED_CATS = ['deals', 'gift-cards'];

function platformFromTitle(t) {
  const s = String(t).toLowerCase();
  if (/xbox|game pass/.test(s)) return 'xbox';
  if (/\bps[345]\b|playstation|psn/.test(s)) return 'ps';
  if (/nintendo|switch|eshop/.test(s)) return 'switch';
  return 'pc';
}

async function loadedGraphql(page) {
  return page.evaluate(async ({ cats }) => {
    const store = location.pathname.split('/')[1] || 'default';
    const out = { store, items: {}, errors: [] };
    async function q(query, variables, currency) {
      const headers = { 'Content-Type': 'application/json', Store: store };
      if (currency) headers['Content-Currency'] = currency;
      const r = await fetch('/graphql', { method: 'POST', headers, body: JSON.stringify({ query, variables }) });
      return r.json();
    }
    const PRODUCTS = `query($u:String,$p:Int){products(filter:{category_uid:{eq:$u}},pageSize:100,currentPage:$p){
      total_count page_info{total_pages}
      items{ name sku url_key url_suffix canonical_url small_image{url}
        price_range{minimum_price{regular_price{value currency} final_price{value currency} discount{percent_off}}} } }}`;
    let currency = 'BRL';
    for (const key of cats) {
      try {
        const c = await q('query($k:String){categoryList(filters:{url_key:{eq:$k}}){uid name}}', { k: key });
        const uid = c?.data?.categoryList?.[0]?.uid;
        if (!uid) { out.errors.push(`${key}: categoria não encontrada ${JSON.stringify(c?.errors || '').slice(0, 160)}`); continue; }
        const items = [];
        for (let p = 1; p <= 80; p++) {
          let r = await q(PRODUCTS, { u: uid, p }, currency);
          if (!r?.data?.products && currency) { currency = null; r = await q(PRODUCTS, { u: uid, p }); }
          const d = r?.data?.products;
          if (!d) { out.errors.push(`${key} p${p}: ${JSON.stringify(r?.errors || r).slice(0, 160)}`); break; }
          items.push(...d.items);
          if (p >= (d.page_info?.total_pages || 1)) break;
        }
        out.items[key] = items;
      } catch (e) { out.errors.push(`${key}: ${e.message}`); }
    }
    return out;
  }, { cats: LOADED_CATS });
}

async function collectLoaded() {
  const page = await newPage();
  const rows = [];
  await gotoFast(page, LOADED_BASE + 'deals', { settle: 8000 }).catch(e => console.warn('   loaded goto:', e.message));
  await acceptCookies(page);

  // 1) API da loja
  let api = null;
  try { api = await loadedGraphql(page); } catch (e) { console.warn('   loaded graphql:', e.message); }
  if (api) {
    console.log(`   loaded: loja "${api.store}", ${Object.entries(api.items).map(([k, v]) => `${k}=${v.length}`).join(', ') || 'nada'}`);
    api.errors.forEach(e => console.warn('   loaded graphql:', e));
    for (const [cat, items] of Object.entries(api.items)) {
      for (const it of items) {
        const mp = it.price_range?.minimum_price;
        if (!mp) continue;
        const isGiftCat = cat === 'gift-cards';
        const sale = await toBRL(mp.final_price?.value, mp.final_price?.currency);
        const reg = await toBRL(mp.regular_price?.value, mp.regular_price?.currency);
        if (sale.value == null) continue;
        if (!isGiftCat && !(sale.value < reg.value)) continue;
        const { isGift } = classifyGiftCard(it.name);
        const gift = isGiftCat || isGift;
        const url = it.canonical_url
          ? (it.canonical_url.startsWith('http') ? it.canonical_url : LOADED_BASE + it.canonical_url.replace(/^\//, ''))
          : `${LOADED_BASE}${it.url_key}${it.url_suffix || ''}`;
        rows.push(baseRow('loaded', {
          id: `loaded:${it.sku || it.url_key}`,
          title: it.name,
          store: 'loaded',
          platform: platformFromTitle(it.name),
          category: gift ? 'gift_card' : 'game_deal',
          original_price: reg.value,
          discount_price: sale.value,
          discount_pct: mp.discount?.percent_off != null ? Math.round(mp.discount.percent_off) : undefined,
          currency: sale.currency,
          image_url: it.small_image?.url || null,
          deal_url: url,
        }));
      }
    }
  }

  // 2) Plano B: páginas de categoria (?p=2, ?p=3...)
  if (rows.length < 20) {
    console.log('   loaded: usando as páginas de categoria');
    const sel = 'a.product-item-link, .product-item a, .product-item-info a, [class*="product-item"] a, [class*="product-card"] a';
    for (const cat of LOADED_CATS) {
      const seen = new Set(rows.map(r => r.id));
      for (let pg = 1; pg <= 60; pg++) {
        await gotoFast(page, `${LOADED_BASE}${cat}?p=${pg}&product_list_limit=48`).catch(() => {});
        const cards = await scrapeCards(page, /loaded\.com\/pt_pt\/[^/?#]+$/, sel);
        let r = await cardsToRows(cards, { source: 'loaded', store: 'loaded' });
        r = r.map(x => {
          const gift = cat === 'gift-cards' || x.category === 'gift_card';
          return { ...x, category: gift ? 'gift_card' : 'game_deal', platform: platformFromTitle(x.title) };
        }).filter(x => !seen.has(x.id));
        r.forEach(x => seen.add(x.id));
        rows.push(...r);
        console.log(`   loaded ${cat} p${pg}: ${cards.length} cards, ${r.length} novos`);
        if (!r.length) break;
      }
    }
  }
  if (rows.length < 20) await dump(page, 'loaded');
  await page.context().close();
  return rows;
}

// ---------------------------------------------------------------------
// 8) Metascore e "mais procurados" (IsThereAnyDeal) -> tabela game_meta
//    Não mexe nas ofertas. A cada rodada completa até META_MAX jogos que ainda não têm nota,
//    começando pelos mais desejados; em poucos dias todo o catálogo de PC fica coberto.
//    Consoles aproveitam a nota pelo nome do jogo (game_key).
// ---------------------------------------------------------------------
const META_MAX = Number(process.env.META_MAX || 600);

async function selectAll(table, cols, build = q => q) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(supabase.from(table).select(cols)).range(from, from + 999);
    if (error) throw new Error(`Supabase (${table}): ${error.message}`);
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

function dedupeBy(rows, key, better) {
  const m = new Map();
  for (const r of rows) { const k = r[key]; if (!k) continue; const old = m.get(k); m.set(k, old ? better(old, r) : r); }
  return [...m.values()];
}

async function collectMeta() {
  if (!ITAD_KEY) throw new Error('Falta o secret ITAD_API_KEY');
  const now = new Date().toISOString();

  // 1) Ranking dos mais desejados (wishlists do IsThereAnyDeal)
  const wl = new Map();
  for (let off = 0; off < 5000; off += 500) {
    const list = await fetchJson(`https://api.isthereanydeal.com/stats/most-waitlisted/v1?key=${ITAD_KEY}&offset=${off}&limit=500`);
    if (!Array.isArray(list) || !list.length) break;
    for (const x of list) wl.set(x.id, { count: x.count, title: x.title });
    await sleep(300);
  }
  console.log(`   ranking de mais desejados: ${wl.size} jogos`);
  const wlRows = dedupeBy([...wl.entries()].map(([id, v]) => ({ game_key: gameKey(v.title), itad_id: id, title: v.title, waitlisted: v.count })),
    'game_key', (a, b) => (b.waitlisted > a.waitlisted ? b : a));
  for (const part of chunk(wlRows, 500)) {
    const { error } = await supabase.from('game_meta').upsert(part, { onConflict: 'game_key' });
    if (error) throw new Error(`Supabase (game_meta): ${error.message} — rodou o arquivo supabase/migration-002.sql?`);
  }

  // 2) Jogos de PC em oferta agora (o id do ITAD está dentro do id da oferta)
  const deals = await selectAll('deals', 'id,discount_pct', q => q.eq('source', 'itad').like('id', '%:itad-%'));
  const cut = new Map();
  for (const d of deals) { const id = d.id.split(':itad-')[1]; if (id) cut.set(id, Math.max(cut.get(id) || 0, d.discount_pct || 0)); }
  const ids = [...cut.keys()];

  // 3) Pula os que já têm nota buscada nos últimos 30 dias
  const known = await selectAll('game_meta', 'itad_id,meta_fetched_at', q => q.not('meta_fetched_at', 'is', null));
  const cutoff = Date.now() - 30 * 864e5;
  const fresh = new Set(known.filter(k => Date.parse(k.meta_fetched_at) > cutoff).map(k => k.itad_id));
  // Metade da cota para os mais desejados, metade para os maiores descontos (os que aparecem em "Destaques")
  const pending = ids.filter(id => !fresh.has(id));
  const byWanted = [...pending].sort((a, b) => (wl.get(b)?.count || 0) - (wl.get(a)?.count || 0));
  const byCut = [...pending].sort((a, b) => (cut.get(b) || 0) - (cut.get(a) || 0));
  const todo = [];
  for (let i = 0; todo.length < META_MAX && i < pending.length; i++) {
    for (const id of [byCut[i], byWanted[i]]) if (id && !todo.includes(id) && todo.length < META_MAX) todo.push(id);
  }
  console.log(`   ${ids.length} jogos de PC em oferta; ${ids.filter(id => !fresh.has(id)).length} sem nota; buscando ${todo.length} agora`);

  // 4) Detalhes de cada jogo (nota Metascore, nota Steam, quantas pessoas desejam)
  const info = [];
  for (const id of todo) {
    try {
      const g = await fetchJson(`https://api.isthereanydeal.com/games/info/v2?key=${ITAD_KEY}&id=${id}`);
      const score = src => (g.reviews || []).find(r => r.source === src)?.score ?? null;
      info.push({
        game_key: gameKey(g.title), itad_id: id, title: g.title,
        metascore: score('Metascore'), steam_score: score('Steam'),
        waitlisted: g.stats?.waitlisted ?? wl.get(id)?.count ?? null,
        meta_fetched_at: now,
      });
    } catch (e) { console.warn(`   info ${id}: ${e.message}`); }
    if (info.length % 100 === 0 && info.length) console.log(`   ${info.length}/${todo.length}`);
    await sleep(150);
  }
  const infoRows = dedupeBy(info, 'game_key', (a, b) => ((b.waitlisted || 0) > (a.waitlisted || 0) ? b : a));
  for (const part of chunk(infoRows, 500)) {
    const { error } = await supabase.from('game_meta').upsert(part, { onConflict: 'game_key' });
    if (error) throw new Error(`Supabase (game_meta): ${error.message}`);
  }
  console.log(`   notas salvas: ${infoRows.filter(r => r.metascore != null).length} com Metascore`);
  return wlRows.length + infoRows.length;
}

// ---------------------------------------------------------------------
// Execução
// ---------------------------------------------------------------------
const SOURCES = [
  { name: 'itad', label: 'PC (Steam/Epic/Nuuvem/Humble)', fn: collectItad, timeout: 15 * 60e3 },
  { name: 'epic_free', label: 'Epic grátis', fn: collectEpicFree, timeout: 60e3 },
  { name: 'xbox', label: 'Xbox', fn: collectXbox, timeout: 18 * 60e3 },
  { name: 'nintendo', label: 'Nintendo', fn: collectNintendo, timeout: 18 * 60e3 },
  { name: 'playstation', label: 'PlayStation', fn: collectPlayStation, timeout: 12 * 60e3 },
  { name: 'nuuvem_gift', label: 'Gift cards Nuuvem', fn: collectNuuvemGiftCards, timeout: 6 * 60e3 },
  { name: 'instant_gaming', label: 'Instant Gaming', fn: collectInstantGaming, timeout: 6 * 60e3 },
  { name: 'loaded', label: 'Loaded', fn: collectLoaded, timeout: 20 * 60e3 },
  { name: 'meta', label: 'Metascore e mais procurados', fn: collectMeta, timeout: 20 * 60e3, custom: true },
];

async function save(rows) {
  const unique = [...new Map(rows.filter(r => r.id && r.title && r.deal_url).map(r => [r.id, r])).values()];
  for (const part of chunk(unique, 500)) {
    const { error } = await supabase.from('deals').upsert(part, { onConflict: 'id' });
    if (error) throw new Error(`Supabase: ${error.message}`);
  }
  return unique.length;
}

async function main() {
  console.log(`=== LC Deals — início ${RUN_STARTED} ===`);
  const summary = [];
  for (const s of SOURCES) {
    if (ONLY.length && !ONLY.includes(s.name)) continue;
    console.log(`\n-> ${s.label}`);
    let ok = false; let count = 0; let message = null;
    const t0 = Date.now();
    try {
      const result = await withTimeout(s.fn(), s.timeout, s.label);
      count = s.custom ? result : await save(result);
      ok = count > 0;
      if (!ok) message = 'nenhuma oferta encontrada (veja os arquivos de debug)';
      if (ok && !s.custom) {
        // Remove o que a loja não tem mais em promoção (só se a coleta deu certo)
        const { error } = await supabase.from('deals').delete().eq('source', s.name).lt('last_seen_at', RUN_STARTED);
        if (error) console.warn('   limpeza:', error.message);
      }
    } catch (e) {
      message = e.message;
    }
    const secs = Math.round((Date.now() - t0) / 1000);
    if (ok) message = `tempo: ${secs}s`;
    console.log(ok ? `   OK: ${count} ofertas salvas em ${secs}s` : `   FALHOU (${secs}s): ${message}`);
    summary.push({ source: s.name, ok, count, message, ran_at: new Date().toISOString() });
    await supabase.from('sync_runs').upsert(summary[summary.length - 1], { onConflict: 'source' });
  }
  if (browser) await browser.close();

  console.log('\n=== RESUMO ===');
  for (const r of summary) console.log(`${r.ok ? '✔' : '✘'} ${r.source.padEnd(15)} ${String(r.count).padStart(6)}  ${r.message || ''}`);
  // Só marca o workflow como erro se TUDO falhou
  process.exit(summary.length && summary.every(r => !r.ok) ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
