// EXECUTOR PRINCIPAL
async function runAggregator() {
  console.log('=== INICIANDO COLETOR MULTI-LOJA ROBUSTO ===');
  const allDeals = [];

  const [epic, steam] = await Promise.all([fetchEpicGames(), fetchSteamDeals()]);
  allDeals.push(...epic, ...steam);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: 'pt-BR',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  const ntDeals = await fetchConsoleDeals(page, 'https://ntdeals.net/br-store', 'ntdeals', 'switch');
  const xbDeals = await fetchConsoleDeals(page, 'https://xbdeals.net/br-store', 'xbdeals', 'xbox');
  const psDeals = await fetchConsoleDeals(page, 'https://psdeals.net/br-store', 'psdeals', 'ps');
  const nuuvemDeals = await fetchNuuvem(page);

  await browser.close();
  allDeals.push(...ntDeals, ...xbDeals, ...psDeals, ...nuuvemDeals);

  // GARANTE UNICIDADE ABSOLUTA POR ID ANTES DE MANDAR AO SUPABASE
  const uniqueMap = new Map();
  for (const item of allDeals) {
    if (item && item.id && item.title) {
      uniqueMap.set(item.id, item);
    }
  }
  const cleanDeals = Array.from(uniqueMap.values());

  console.log(`=== TOTAL COLETADO ÚNICO: ${cleanDeals.length} OFERTAS ===`);

  if (cleanDeals.length > 0) {
    const { error } = await supabase.from('deals').upsert(cleanDeals, { onConflict: 'id' });
    if (error) {
      console.error('Erro Supabase:', error);
      process.exit(1);
    } else {
      console.log('Sucesso absoluto! Todas as lojas sincronizadas.');
    }
  }
}

runAggregator();
