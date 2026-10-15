import { createClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';
import { chromium } from 'playwright';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function pickFirst(...values) {
  for (const val of values) {
    if (val !== undefined && val !== null && val !== '' && !Number.isNaN(val)) {
      return val;
    }
  }
  return null;
}

function parsePriceBR(text) {
  if (!text) return 0;
  const cleaned = String(text).replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3})/g, '').replace(',', '.');
  const num = parseFloat(cleaned);
  return Number.isNaN(num) ? 0 : num;
}

// ============================================================================
// 1. EPIC GAMES BRASIL (Jogos Grátis + Promoções da Loja em R$)
// ============================================================================
async function fetchEpicGames() {
  console.log('-> Buscando Epic Games Brasil...');
  const deals = [];
  try {
    const url = 'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=pt-BR&country=BR&allowCountries=BR';
    const res = await fetch(url);
    const data = await res.json();
    const elements = pickFirst(data?.data?.Catalog?.searchStore?.elements, []);

    for (const game of elements) {
      const totalPrice = game.price?.totalPrice;
      if (!totalPrice) continue;

      const orig = totalPrice.originalPrice / 100;
      const disc = totalPrice.discountPrice / 100;
      const isFree = disc === 0 && game.promotions?.promotionalOffers?.length > 0;

      if (isFree ? true : (disc < orig && orig > 0)) {
        const slug = pickFirst(game.catalogNs?.mappings?.[0]?.pageSlug, game.productSlug, game.urlSlug);
        const wideImg = game.keyImages?.find(img => img.type === 'OfferImageWide')?.url;
        const firstImg = game.keyImages?.[0]?.url;
        const pct = orig > 0 ? Math.round(((orig - disc) / orig) * 100) : 100;

        deals.push({
          id: `epic-${game.id}`,
          title: game.title,
          store: 'epic',
          platform: 'pc',
          category: isFree ? 'free_game' : 'game_deal',
          original_price: orig,
          discount_price: disc,
          discount_pct: isFree ? 100 : pct,
          is_lowest_ever: isFree ? true : (pct >= 75),
          image_url: pickFirst(wideImg, firstImg),
          deal_url: slug ? `https://store.epicgames.com/pt-BR/p/${slug}` : 'https://store.epicgames.com/pt-BR/free-games',
          expires_at: null
        });
      }
    }
  } catch (e) {
    console.warn('Erro Epic:', e.message);
  }
  console.log(`   Epic: ${deals.length} ofertas.`);
  return deals;
}

// ============================================================================
// 2. STEAM BRASIL (Catálogo Expandido de Promoções em R$ - Mais de 120 jogos)
// ============================================================================
async function fetchSteamDeals() {
  console.log('-> Buscando Steam Brasil (Múltiplas páginas em R$)...');
  const deals = [];
  try {
    // Parte A: Featured Specials
    const featRes = await fetch('https://store.steampowered.com/api/featuredcategories/?cc=br&l=portuguese');
    const featData = await featRes.json();
    const specials = pickFirst(featData?.specials?.items, []);

    for (const item of specials) {
      const pct = item.discount_percent;
      deals.push({
        id: `steam-${item.id}`,
        title: item.name,
        store: 'steam',
        platform: 'pc',
        category: pct === 100 ? 'free_game' : 'game_deal',
        original_price: item.original_price / 100,
        discount_price: item.final_price / 100,
        discount_pct: pct,
        is_lowest_ever: pct >= 80,
        image_url: `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${item.id}/header.jpg`,
        deal_url: `https://store.steampowered.com/app/${item.id}/?l=portuguese`,
        expires_at: item.discount_expiration ? new Date(item.discount_expiration * 1000).toISOString() : null
      });
    }

    // Parte B: Busca paginada da Steam Brasil (Pega +100 jogos em promoção em R$)
    for (const start of [0, 50]) {
      const searchUrl = `https://store.steampowered.com/search/results/?query&start=${start}&count=50&dynamic_data=&sort_by=_ASC&specials=1&cc=br&l=portuguese&infinite=1`;
      const sRes = await fetch(searchUrl);
      const sJson = await sRes.json();
      if (sJson?.results_html) {
        const $ = cheerio.load(sJson.results_html);
        $('a.search_result_row').each((_, el) => {
          const appId = $(el).attr('data-ds-appid');
          const title = $(el).find('.title').text().trim();
          const discText = $(el).find('.discount_pct').text().trim();
          const origText = $(el).find('.discount_original_price').text().trim();
          const finalText = $(el).find('.discount_final_price').text().trim();

          if (appId && title && finalText) {
            const origPrice = parsePriceBR(origText);
            const finalPrice = finalText.toLowerCase().includes('gratuito') ? 0 : parsePriceBR(finalText);
            const pct = pickFirst(parseInt(discText.replace(/\D/g, '')), 0);

            if (finalPrice > 0 ? true : pct === 100) {
              deals.push({
                id: `steam-${appId.split(',')[0]}`,
                title,
                store: 'steam',
                platform: 'pc',
                category: pct === 100 ? 'free_game' : 'game_deal',
                original_price: origPrice > 0 ? origPrice : finalPrice,
                discount_price: finalPrice,
                discount_pct: pct,
                is_lowest_ever: pct >= 80,
                image_url: `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appId.split(',')[0]}/header.jpg`,
                deal_url: `https://store.steampowered.com/app/${appId.split(',')[0]}/?l=portuguese`,
                expires_at: null
              });
            }
          }
        });
      }
    }
  } catch (e) {
    console.warn('Erro Steam:', e.message);
  }
  console.log(`   Steam: ${deals.length} ofertas.`);
  return deals;
}

// ============================================================================
// 3. NUUVEM BRASIL (Jogos PC, Console & Gift Cards Nintendo/PlayStation/Xbox)
// ============================================================================
async function fetchNuuvem(browserPage) {
  console.log('-> Buscando Nuuvem Brasil (Promoções + Gift Cards)...');
  const deals = [];
  const urls = [
    { url: 'https://www.nuuvem.com/br-pt/catalog/price/promo/sort/bestselling/sort-mode/desc', cat: 'game_deal', plat: 'pc' },
    { url: 'https://www.nuuvem.com/br-pt/catalog/platforms/nintendo', cat: 'gift_card', plat: 'switch' },
    { url: 'https://www.nuuvem.com/br-pt/catalog/platforms/playstation', cat: 'gift_card', plat: 'ps' },
    { url: 'https://www.nuuvem.com/br-pt/catalog/platforms/xbox', cat: 'gift_card', plat: 'xbox' }
  ];

  for (const item of urls) {
    try {
      await browserPage.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await browserPage.waitForTimeout(2000);
      const html = await browserPage.content();
      const $ = cheerio.load(html);

      $('.product-card--grid, .product-card, [data-product-id]').each((_, el) => {
        const id = pickFirst($(el).attr('data-product-id'), $(el).find('[data-product-id]').attr('data-product-id'));
        const title = pickFirst($(el).find('.product-title').text().trim(), $(el).attr('title'));
        const link = $(el).find('a').first().attr('href');
        const img = pickFirst($(el).find('img').attr('src'), $(el).find('img').attr('data-src'));
        const discountText = $(el).find('.product-price--discount, .discount-badge').text().trim();
        const priceSaleText = $(el).find('.product-price--val, .integer').text().trim();
        const priceOldText = $(el).find('.product-price--old').text().trim();

        if (title && link) {
          const isGift = title.toLowerCase().includes('gift card') ? true : (title.toLowerCase().includes('cartão') ? true : (item.cat === 'gift_card'));
          const salePrice = parsePriceBR(priceSaleText);
          const pct = pickFirst(parseInt(discountText.replace(/\D/g, '')), 0);
          const origPrice = priceOldText ? parsePriceBR(priceOldText) : (pct > 0 && salePrice > 0 ? +(salePrice / (1 - pct / 100)).toFixed(2) : salePrice);

          if (salePrice > 0) {
            const cleanId = pickFirst(id, link.split('/').filter(Boolean).pop());
            deals.push({
              id: `nuuvem-${cleanId}`,
              title,
              store: 'nuuvem',
              platform: isGift ? 'giftcard' : item.plat,
              category: isGift ? 'gift_card' : 'game_deal',
              original_price: origPrice > 0 ? origPrice : salePrice,
              discount_price: salePrice,
              discount_pct: pct,
              is_lowest_ever: pct >= 75,
              image_url: img,
              deal_url: link.startsWith('http') ? link : `https://www.nuuvem.com${link}`,
              expires_at: null
            });
          }
        }
      });
    } catch (e) {
      console.warn(`Aviso Nuuvem (${item.url}):`, e.message);
    }
  }
  console.log(`   Nuuvem: ${deals.length} ofertas.`);
  return deals;
}

// ============================================================================
// 4. NTDEALS (Switch BR), XBDEALS (Xbox BR) e PSDEALS (PSN BR) via Playwright
// ============================================================================
async function fetchDealsFamily(browserPage, siteUrl, storeName, platformName) {
  console.log(`-> Buscando ${storeName} (${siteUrl})...`);
  const deals = [];
  try {
    await browserPage.goto(siteUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await browserPage.waitForTimeout(3500);
    const html = await browserPage.content();
    const $ = cheerio.load(html);

    $('.game-collection-item').each((_, el) => {
      const title = $(el).find('.game-collection-item-details-title').text().trim();
      const link = $(el).find('a.game-collection-item-link').attr('href');
      const img = pickFirst($(el).find('img').attr('data-src'), $(el).find('img').attr('src'));
      const discountText = $(el).find('.game-collection-item-discount').text().trim();
      const regText = $(el).find('.game-collection-item-regular-price').text().trim();
      const saleText = pickFirst(
        $(el).find('.game-collection-item-price-discount').text().trim(),
        $(el).find('.game-collection-item-price').text().trim()
      );

      const priceSale = parsePriceBR(saleText);
      const priceRegular = parsePriceBR(regText);
      const pct = pickFirst(parseInt(discountText.replace(/\D/g, '')), 0);
      const cardText = $(el).text().toLowerCase();
      const isLowest = cardText.includes('menor') ? true : (cardText.includes('lowest') ? true : (pct >= 75));

      if (title && link && priceSale > 0) {
        const slugId = link.split('/').filter(Boolean).pop();
        deals.push({
          id: `${storeName}-${slugId}`,
          title,
          store: storeName,
          platform: platformName,
          category: 'game_deal',
          original_price: priceRegular > 0 ? priceRegular : +(priceSale / (1 - (pct > 0 ? pct : 20) / 100)).toFixed(2),
          discount_price: priceSale,
          discount_pct: pct,
          is_lowest_ever: isLowest,
          image_url: img,
          deal_url: new URL(link, siteUrl).href,
          expires_at: null
        });
      }
    });
  } catch (e) {
    console.warn(`Aviso ${storeName}:`, e.message);
  }
  console.log(`   ${storeName}: ${deals.length} ofertas.`);
  return deals;
}

// ============================================================================
// 5. NINTENDO ESHOP BRASIL OFICIAL / DEKU DEALS MIRROR (Garantia de Jogos Switch)
// ============================================================================
async function fetchSwitchBrazilFallback(browserPage) {
  console.log('-> Buscando Ofertas Nintendo Switch Brasil (Catálogo Complementar)...');
  const deals = [];
  try {
    await browserPage.goto('https://www.dekudeals.com/hottest?country=br', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await browserPage.waitForTimeout(2500);
    const html = await browserPage.content();
    const $ = cheerio.load(html);

    $('.cell').each((_, el) => {
      const title = $(el).find('.name, h6').text().trim();
      const link = $(el).find('a.main-link').attr('href');
      const img = $(el).find('img').attr('src');
      const priceRegular = parsePriceBR($(el).find('s, .text-muted').first().text());
      const priceSale = parsePriceBR($(el).find('strong').first().text());
      const badgeText = $(el).find('.badge').text().trim();
      const pct = pickFirst(parseInt(badgeText.replace(/\D/g, '')), 0);
      const isLowest = $(el).text().toLowerCase().includes('lowest price ever');

      if (title && link && priceSale > 0) {
        const slug = link.split('/').filter(Boolean).pop();
        deals.push({
          id: `ntdeals-dd-${slug}`,
          title,
          store: 'ntdeals',
          platform: 'switch',
          category: 'game_deal',
          original_price: priceRegular > 0 ? priceRegular : priceSale,
          discount_price: priceSale,
          discount_pct: pct,
          is_lowest_ever: isLowest,
          image_url: img,
          deal_url: `https://ntdeals.net/br-store`,
          expires_at: null
        });
      }
    });
  } catch (e) {
    console.warn('Aviso Switch BR Complementar:', e.message);
  }
  console.log(`   Switch BR (Complementar): ${deals.length} ofertas.`);
  return deals;
}

// ============================================================================
// 6. INSTANT GAMING (Jogos + Gift Cards Xbox, PSN, Nintendo e Steam)
// ============================================================================
async function fetchInstantGaming(browserPage) {
  console.log('-> Buscando Instant Gaming (Jogos + Gift Cards)...');
  const deals = [];
  const targets = [
    { url: 'https://www.instant-gaming.com/pt/pesquisar/?sort_by=discount_desc', cat: 'game_deal', plat: 'pc' },
    { url: 'https://www.instant-gaming.com/pt/pesquisar/?q=gift+card', cat: 'gift_card', plat: 'giftcard' }
  ];

  for (const t of targets) {
    try {
      await browserPage.goto(t.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await browserPage.waitForTimeout(2500);
      const html = await browserPage.content();
      const $ = cheerio.load(html);

      $('.item').each((_, el) => {
        const title = $(el).find('.title, .name').text().trim();
        const link = $(el).find('a.cover').attr('href');
        const img = pickFirst($(el).find('img.picture').attr('data-src'), $(el).find('img').attr('src'));
        const discText = $(el).find('.discount').text().trim();
        const priceText = $(el).find('.price').text().trim();

        if (title && link && priceText) {
          let salePrice = parsePriceBR(priceText);
          // Se vier em Euro (€), converte aproximado para BRL (x6.0)
          if (priceText.includes('€')) salePrice = +(salePrice * 6.1).toFixed(2);
          const pct = pickFirst(parseInt(discText.replace(/\D/g, '')), 0);
          const origPrice = pct > 0 && salePrice > 0 ? +(salePrice / (1 - pct / 100)).toFixed(2) : salePrice;
          const isGift = t.cat === 'gift_card' ? true : (title.toLowerCase().includes('card') ? true : title.toLowerCase().includes('assinatura'));

          if (salePrice > 0) {
            const slug = link.split('/').filter(Boolean).pop();
            deals.push({
              id: `ig-${slug}`,
              title,
              store: 'instant_gaming',
              platform: isGift ? 'giftcard' : 'pc',
              category: isGift ? 'gift_card' : 'game_deal',
              original_price: origPrice,
              discount_price: salePrice,
              discount_pct: pct,
              is_lowest_ever: pct >= 70,
              image_url: img,
              deal_url: link,
              expires_at: null
            });
          }
        }
      });
    } catch (e) {
      console.warn('Aviso Instant Gaming:', e.message);
    }
  }
  console.log(`   Instant Gaming: ${deals.length} ofertas.`);
  return deals;
}

// ============================================================================
// 7. HUMBLE BUNDLE (Bundles + Store Deals via API)
// ============================================================================
async function fetchHumbleBundle() {
  console.log('-> Buscando Humble Bundle...');
  const deals = [];
  try {
    const res = await fetch('https://www.cheapshark.com/api/1.0/deals?storeID=11&pageSize=40&sortBy=Savings');
    const items = await res.json();
    for (const d of items) {
      const pct = Math.round(parseFloat(d.savings));
      const origBRL = +(parseFloat(d.normalPrice) * 5.6).toFixed(2);
      const saleBRL = +(parseFloat(d.salePrice) * 5.6).toFixed(2);

      deals.push({
        id: `humble-${d.gameID}`,
        title: d.title,
        store: 'humble',
        platform: 'pc',
        category: pct >= 85 ? 'bundle' : 'game_deal',
        original_price: origBRL,
        discount_price: saleBRL,
        discount_pct: pct,
        is_lowest_ever: pct >= 80,
        image_url: d.thumb.replace('capsule_sm_120', 'header'),
        deal_url: `https://www.humblebundle.com/store/search?sort=discount&search=${encodeURIComponent(d.title)}`,
        expires_at: null
      });
    }
  } catch (e) {
    console.warn('Aviso Humble:', e.message);
  }
  console.log(`   Humble Bundle: ${deals.length} ofertas.`);
  return deals;
}

// ============================================================================
// EXECUTOR GERAL
// ============================================================================
async function runAggregator() {
  console.log('=== INICIANDO COLETOR COMPLETO DAS 8 LOJAS ===');
  const allDeals = [];

  // 1. Coleta APIs diretas rápidas
  const [epic, steam, humble] = await Promise.all([
    fetchEpicGames(),
    fetchSteamDeals(),
    fetchHumbleBundle()
  ]);
  allDeals.push(...epic, ...steam, ...humble);

  // 2. Inicia navegador real Playwright para passar por Cloudflare e páginas dinâmicas
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: 'pt-BR',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  const ntDeals = await fetchDealsFamily(page, 'https://ntdeals.net/br-store', 'ntdeals', 'switch');
  const switchFallback = await fetchSwitchBrazilFallback(page);
  const xbDeals = await fetchDealsFamily(page, 'https://xbdeals.net/br-store', 'xbdeals', 'xbox');
  const psDeals = await fetchDealsFamily(page, 'https://psdeals.net/br-store', 'psdeals', 'ps');
  const nuuvemDeals = await fetchNuuvem(page);
  const igDeals = await fetchInstantGaming(page);

  await browser.close();

  allDeals.push(...ntDeals, ...switchFallback, ...xbDeals, ...psDeals, ...nuuvemDeals, ...igDeals);

  // Remove duplicados pelo ID
  const uniqueMap = new Map();
  for (const item of allDeals) {
    if (item && item.id && item.title) {
      uniqueMap.set(item.id, item);
    }
  }
  const finalDeals = Array.from(uniqueMap.values());

  console.log(`=== TOTAL UNIFICADO: ${finalDeals.length} OFERTAS PRONTAS PARA SALVAR ===`);

  if (finalDeals.length > 0) {
    const { error } = await supabase.from('deals').upsert(finalDeals, { onConflict: 'id' });
    if (error) {
      console.error('Erro ao gravar no Supabase:', error);
      process.exit(1);
    } else {
      console.log('Sucesso! Banco do Supabase atualizado com todas as lojas!');
    }
  }
}

runAggregator();
