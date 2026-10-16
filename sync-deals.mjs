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

// Normaliza o título para evitar duplicatas com IDs diferentes
function cleanTitleKey(title) {
  if (!title) return '';
  return title.toLowerCase().replace(/[^a-z0-9]/g, '').trim();
}

// Valida se a imagem é real e não uma miniatura quebrada
function cleanImageUrl(url) {
  if (!url || typeof url !== 'string') return 'https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=600';
  if (url.includes('placeholder') || url.length < 10) return 'https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=600';
  return url;
}

// 1. EPIC GAMES BRASIL
async function fetchEpicGames() {
  console.log('-> Buscando Epic Games...');
  const deals = [];
  try {
    const res = await fetch('https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=pt-BR&country=BR&allowCountries=BR');
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
          image_url: cleanImageUrl(pickFirst(wideImg, game.keyImages?.[0]?.url)),
          deal_url: slug ? `https://store.epicgames.com/pt-BR/p/${slug}` : 'https://store.epicgames.com/pt-BR/free-games',
          expires_at: null
        });
      }
    }
  } catch (e) {
    console.warn('Erro Epic:', e.message);
  }
  return deals;
}

// 2. STEAM BRASIL (Catálogo Oficial)
async function fetchSteamDeals() {
  console.log('-> Buscando Steam Brasil...');
  const deals = [];
  try {
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
        image_url: cleanImageUrl(`https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${item.id}/header.jpg`),
        deal_url: `https://store.steampowered.com/app/${item.id}/?l=portuguese`,
        expires_at: null
      });
    }

    const searchRes = await fetch('https://store.steampowered.com/search/results/?query&start=0&count=60&dynamic_data=&sort_by=_ASC&specials=1&cc=br&l=portuguese&infinite=1');
    const sJson = await searchRes.json();
    if (sJson?.results_html) {
      const $= cheerio.load(sJson.results_html);$('a.search_result_row').each((_, el) => {
        const appId = $(el).attr('data-ds-appid');
        const title = $(el).find('.title').text().trim();
        const discText = $(el).find('.discount_pct').text().trim();
        const origText = $(el).find('.discount_original_price').text().trim();
        const finalText = $(el).find('.discount_final_price').text().trim();

        if (appId && title && finalText) {
          const cleanAppId = appId.split(',')[0];
          const origPrice = parsePriceBR(origText);
          const finalPrice = finalText.toLowerCase().includes('gratuito') ? 0 : parsePriceBR(finalText);
          const pct = pickFirst(parseInt(discText.replace(/\D/g, '')), 0);

          if (finalPrice > 0 ? true : pct === 100) {
            deals.push({
              id: `steam-${cleanAppId}`,
              title,
              store: 'steam',
              platform: 'pc',
              category: pct === 100 ? 'free_game' : 'game_deal',
              original_price: origPrice > 0 ? origPrice : finalPrice,
              discount_price: finalPrice,
              discount_pct: pct,
              is_lowest_ever: pct >= 80,
              image_url: cleanImageUrl(`https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${cleanAppId}/header.jpg`),
              deal_url: `https://store.steampowered.com/app/${cleanAppId}/?l=portuguese`,
              expires_at: null
            });
          }
        }
      });
    }
  } catch (e) {
    console.warn('Erro Steam:', e.message);
  }
  return deals;
}

// 3. NUUVEM BRASIL
async function fetchNuuvem(browserPage) {
  console.log('-> Buscando Nuuvem...');
  const deals = [];
  try {
    await browserPage.goto('https://www.nuuvem.com/br-pt/catalog/price/promo/sort/bestselling/sort-mode/desc', { waitUntil: 'domcontentloaded', timeout: 25000 });
    await browserPage.waitForTimeout(2000);
    const html = await browserPage.content();
    const $ = cheerio.load(html);

    $('.product-card--grid, .product-card').each((_, el) => {
      const id = $(el).attr('data-product-id');
      const title = $(el).find('.product-title').text().trim();
      const link = $(el).find('a').first().attr('href');
      const img = pickFirst($(el).find('img').attr('src'),$(el).find('img').attr('data-src'));
      const discountText = $(el).find('.product-price--discount').text().trim();
      const priceSaleText = $(el).find('.product-price--val').text().trim();
      const priceOldText = $(el).find('.product-price--old').text().trim();

      if (title && link) {
        const salePrice = parsePriceBR(priceSaleText);
        const pct = pickFirst(parseInt(discountText.replace(/\D/g, '')), 0);
        const origPrice = priceOldText ? parsePriceBR(priceOldText) : (pct > 0 && salePrice > 0 ? +(salePrice / (1 - pct / 100)).toFixed(2) : salePrice);

        if (salePrice > 0) {
          const cleanId = pickFirst(id, link.split('/').filter(Boolean).pop());
          deals.push({
            id: `nuuvem-${cleanId}`,
            title,
            store: 'nuuvem',
            platform: title.toLowerCase().includes('gift card') ? 'giftcard' : 'pc',
            category: title.toLowerCase().includes('gift card') ? 'gift_card' : 'game_deal',
            original_price: origPrice > 0 ? origPrice : salePrice,
            discount_price: salePrice,
            discount_pct: pct,
            is_lowest_ever: pct >= 75,
            image_url: cleanImageUrl(img),
            deal_url: link.startsWith('http') ? link : `https://www.nuuvem.com${link}`,
            expires_at: null
          });
        }
      }
    });
  } catch (e) {
    console.warn('Aviso Nuuvem:', e.message);
  }
  return deals;
}

// 4. NTDEALS, XBDEALS, PSDEALS
async function fetchDealsFamily(browserPage, siteUrl, storeName, platformName) {
  console.log(`-> Buscando ${storeName}...`);
  const deals = [];
  try {
    await browserPage.goto(siteUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await browserPage.waitForTimeout(3000);
    const html = await browserPage.content();
    const $ = cheerio.load(html);

    $('.game-collection-item').each((_, el) => {
      const title = $(el).find('.game-collection-item-details-title').text().trim();
      const link = $(el).find('a.game-collection-item-link').attr('href');
      const img = pickFirst($(el).find('img').attr('data-src'),$(el).find('img').attr('src'));
      const discountText = $(el).find('.game-collection-item-discount').text().trim();
      const regText = $(el).find('.game-collection-item-regular-price').text().trim();
      const saleText = pickFirst($(el).find('.game-collection-item-price-discount').text().trim(),$(el).find('.game-collection-item-price').text().trim());

      const priceSale = parsePriceBR(saleText);
      const priceRegular = parsePriceBR(regText);
      const pct = pickFirst(parseInt(discountText.replace(/\D/g, '')), 0);

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
          is_lowest_ever: pct >= 75,
          image_url: cleanImageUrl(img),
          deal_url: new URL(link, siteUrl).href,
          expires_at: null
        });
      }
    });
  } catch (e) {
    console.warn(`Aviso ${storeName}:`, e.message);
  }
  return deals;
}

// EXECUTOR PRINCIPAL
async function runAggregator() {
  console.log('=== INICIANDO SINCRONIZAÇÃO LIMPA ===');
  const allDeals = [];

  const [epic, steam] = await Promise.all([fetchEpicGames(), fetchSteamDeals()]);
  allDeals.push(...epic, ...steam);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: 'pt-BR',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  const ntDeals = await fetchDealsFamily(page, 'https://ntdeals.net/br-store', 'ntdeals', 'switch');
  const xbDeals = await fetchDealsFamily(page, 'https://xbdeals.net/br-store', 'xbdeals', 'xbox');
  const psDeals = await fetchDealsFamily(page, 'https://psdeals.net/br-store', 'psdeals', 'ps');
  const nuuvemDeals = await fetchNuuvem(page);

  await browser.close();
  allDeals.push(...ntDeals, ...xbDeals, ...psDeals, ...nuuvemDeals);

  // FILTRA DUPLICATAS POR TÍTULO NORMALIZADO
  const uniqueMap = new Map();
  for (const item of allDeals) {
    if (item && item.title) {
      const key = cleanTitleKey(item.title);
      // Se já existe um item com o mesmo título, prioriza o que tem maior desconto ou menor preço
      if (!uniqueMap.has(key) || item.discount_pct > uniqueMap.get(key).discount_pct) {
        uniqueMap.set(key, item);
      }
    }
  }

  const finalDeals = Array.from(uniqueMap.values());
  console.log(`=== TOTAL LIMPO: ${finalDeals.length} OFERTAS ÚNICAS ===`);

  if (finalDeals.length > 0) {
    // Limpa a tabela antiga para recriar sem lixo acumulado
    await supabase.from('deals').delete().neq('id', 'placeholder');

    const { error } = await supabase.from('deals').upsert(finalDeals, { onConflict: 'id' });
    if (error) {
      console.error('Erro Supabase:', error);
      process.exit(1);
    } else {
      console.log('Sucesso! Banco limpo e atualizado.');
    }
  }
}

runAggregator();
