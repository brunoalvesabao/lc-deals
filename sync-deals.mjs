import { createClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Função auxiliar segura para substituir o operador OR
function pickFirst(...values) {
  for (const val of values) {
    if (val !== undefined && val !== null && val !== '' && !Number.isNaN(val)) {
      return val;
    }
  }
  return null;
}

// 1. EPIC GAMES BRASIL (Jogos Grátis da Semana)
async function fetchEpicFreeGames() {
  const url = 'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=pt-BR&country=BR&allowCountries=BR';
  const res = await fetch(url);
  const data = await res.json();
  const elements = pickFirst(data?.data?.Catalog?.searchStore?.elements, []);

  const deals = [];
  for (const game of elements) {
    const promos = game.promotions?.promotionalOffers;
    if (promos && promos.length > 0 && game.price?.totalPrice?.discountPrice === 0) {
      const offer = promos[0].promotionalOffers[0];
      const slug = pickFirst(game.catalogNs?.mappings?.[0]?.pageSlug, game.productSlug, game.urlSlug);
      const wideImg = game.keyImages?.find(img => img.type === 'OfferImageWide')?.url;
      const firstImg = game.keyImages?.[0]?.url;

      deals.push({
        id: `epic-${game.id}`,
        title: game.title,
        store: 'epic',
        platform: 'pc',
        category: 'free_game',
        original_price: (game.price.totalPrice.originalPrice / 100),
        discount_price: 0,
        discount_pct: 100,
        is_lowest_ever: true,
        image_url: pickFirst(wideImg, firstImg),
        deal_url: `https://store.epicgames.com/pt-BR/p/${slug}`,
        expires_at: offer.endDate
      });
    }
  }
  return deals;
}

// 2. STEAM BRASIL (Ofertas em Destaque em R$)
async function fetchSteamDeals() {
  const url = 'https://store.steampowered.com/api/featuredcategories/?cc=br&l=portuguese';
  const res = await fetch(url);
  const data = await res.json();
  const specials = pickFirst(data?.specials?.items, []);

  return specials.map(item => ({
    id: `steam-${item.id}`,
    title: item.name,
    store: 'steam',
    platform: 'pc',
    category: item.discount_percent === 100 ? 'free_game' : 'game_deal',
    original_price: item.original_price / 100,
    discount_price: item.final_price / 100,
    discount_pct: item.discount_percent,
    is_lowest_ever: false,
    image_url: pickFirst(item.large_capsule_image, item.header_image),
    deal_url: `https://store.steampowered.com/app/${item.id}/?l=portuguese`,
    expires_at: item.discount_expiration ? new Date(item.discount_expiration * 1000).toISOString() : null
  }));
}

// 3. PARSER PARA XBDEALS, NTDEALS E PSDEALS
async function fetchConsoleDeals(siteUrl, storeName, platformName) {
  try {
    const res = await fetch(siteUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    if (!res.ok) return [];
    const html = await res.text();
    const $ = cheerio.load(html);
    const deals = [];

    $('.game-collection-item').each((_, el) => {
      const title = $(el).find('.game-collection-item-details-title').text().trim();
      const link = $(el).find('a.game-collection-item-link').attr('href');
      const img = pickFirst($(el).find('img').attr('src'),$(el).find('img').attr('data-src'));
      const discountText = $(el).find('.game-collection-item-discount').text().trim();
      const priceRegular = pickFirst(parseFloat($(el).find('.game-collection-item-regular-price').text().replace(/[^\d,]/g, '').replace(',', '.')), 0);
      const priceSale = pickFirst(parseFloat($(el).find('.game-collection-item-price-discount').text().replace(/[^\d,]/g, '').replace(',', '.')), 0);
      const isLowest = $(el).text().toLowerCase().includes('menor preço') ? true : ($(el).find('.lowest-price-badge').length > 0);

      if (title && link) {
        const slugId = link.split('/').filter(Boolean).pop();
        deals.push({
          id: `${storeName}-${slugId}`,
          title,
          store: storeName,
          platform: platformName,
          category: 'game_deal',
          original_price: priceRegular,
          discount_price: priceSale,
          discount_pct: pickFirst(parseInt(discountText.replace(/\D/g, '')), 0),
          is_lowest_ever: isLowest,
          image_url: img,
          deal_url: new URL(link, siteUrl).href,
          expires_at: null
        });
      }
    });
    return deals;
  } catch (e) {
    console.warn(`Aviso ao ler ${storeName}:`, e.message);
    return [];
  }
}

// 4. EXECUTOR PRINCIPAL QUE SALVA NO SUPABASE
async function runAggregator() {
  console.log('Buscando ofertas nas lojas...');
  const results = await Promise.allSettled([
    fetchEpicFreeGames(),
    fetchSteamDeals(),
    fetchConsoleDeals('https://ntdeals.net/br-store', 'ntdeals', 'switch'),
    fetchConsoleDeals('https://xbdeals.net/br-store', 'xbdeals', 'xbox'),
    fetchConsoleDeals('https://psdeals.net/br-store', 'psdeals', 'ps')
  ]);

  const allDeals = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && Array.isArray(r.value)) {
      allDeals.push(...r.value);
    }
  }

  console.log(`Total de ofertas encontradas: ${allDeals.length}`);

  if (allDeals.length > 0) {
    const { error } = await supabase.from('deals').upsert(allDeals, { onConflict: 'id' });
    if (error) {
      console.error('Erro ao salvar no Supabase:', error);
      process.exit(1);
    } else {
      console.log(`${allDeals.length} ofertas sincronizadas com sucesso no Supabase!`);
    }
  }
}

runAggregator();
