# LC Deals 2.0 — como instalar

## O que mudou em relação à versão do Gemini

| Problema | Causa | Correção |
|---|---|---|
| Xbox, PlayStation e Nintendo sempre vazios | NTDeals/XBDeals/PSDeals bloqueiam robôs (Cloudflare) | Busca direto nas lojas oficiais: API da Microsoft Store BR, preço oficial da Nintendo BR, API da PS Store BR |
| Poucos jogos de PC | Steam só pegava ~100 itens da vitrine | API do IsThereAnyDeal: todas as promoções da Steam, Epic, Nuuvem e Humble em R$, com menor preço histórico real |
| Jogos repetidos | Mesmo jogo vindo de fontes com IDs diferentes + "dados de demonstração" e CheapShark no site | O site agrupa por título normalizado: 1 card por jogo, com todas as lojas dentro |
| Capas estouradas | Miniaturas de 120px esticadas e imagem genérica repetida | Capas em 400–480px das próprias lojas; se quebrar, aparece um bloco com as iniciais |
| Preços em dólar × 5,2 | Conversão inventada no site | Tudo em R$ nativo; quando a loja só dá USD/EUR, converte pela cotação do dia e marca com "≈" |
| "Ficou pior", sumiu tudo | O script apagava a tabela inteira a cada execução | Só remove ofertas de uma loja se aquela loja foi coletada com sucesso |
| Abas não funcionavam | Botões trocando classes de forma inconsistente | Site reescrito; testado aba por aba |

## Passo a passo (uma vez só)

1. **Chave grátis do IsThereAnyDeal**: entre em https://isthereanydeal.com/apps/my/ , crie uma conta, clique em *Register app* (nome: LC Deals) e copie a **API Key**. Confirme o e-mail para ter limite maior.
2. **Supabase**: SQL Editor → cole todo o `supabase/schema.sql` → Run. (Ele apaga a tabela `deals` antiga e recria do jeito certo.)
3. **GitHub → Settings → Secrets and variables → Actions**: confira que existem `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` e crie o terceiro: `ITAD_API_KEY`.
4. **Arquivos no repositório `lc-deals`**: apague o `sync-deals.mjs` e o `index.html` antigos e envie os deste pacote mantendo as pastas:
   - `index.html` (cole sua chave anon na linha `SUPABASE_ANON_KEY`)
   - `sync-deals.mjs`
   - `package.json`
   - `.github/workflows/main.yml` (substitui o antigo)
   - `supabase/schema.sql` (só para guardar)
   Dica: em *Add file → Upload files* dá para arrastar a pasta inteira. A pasta `.github` às vezes fica oculta no Windows/Mac: se não aparecer, edite o `main.yml` existente e cole o conteúdo novo.
5. **Actions → Sincronizar Ofertas → Run workflow**. A primeira execução leva uns 10–15 minutos.

## Como ler o resultado

- No fim do log do passo *Rodar coletor* aparece um **RESUMO** com ✔/✘ por loja e o motivo de cada falha.
- O site mostra a mesma coisa na barra de status (bolinha verde/vermelha por loja).
- Se uma loja falhar, abra a execução no Actions, desça até **Artifacts** e baixe `debug-lojas`: tem o print e o HTML da página que o navegador invisível viu.
- Para testar uma loja só: *Run workflow* → campo "Rodar só algumas fontes" → por exemplo `xbox,nintendo`.

Fontes: `itad` (PC), `epic_free`, `xbox`, `nintendo`, `playstation`, `nuuvem_gift`, `instant_gaming`.

## Limites do plano grátis

- **GitHub Actions**: repositório público = minutos ilimitados. Se o repositório for privado, cada execução gasta ~10–15 min; 4×/dia ≈ 1.500 min/mês (o limite é 2.000). Se ficar apertado, troque o cron para `17 */8 * * *` (3×/dia).
- **Supabase**: 500 MB. Com ~20–30 mil ofertas o banco fica em torno de 30–60 MB, mais o histórico de preços crescendo devagar.
- **IsThereAnyDeal**: uso pessoal permitido; o coletor fica bem abaixo do limite de 1.000 chamadas a cada 5 minutos. Os links de PC passam pelo ITAD (exigência deles: não alterar os links).

## Botão "Atualizar" do site (configurar uma vez)

O botão chama a função `api/refresh.js` na Vercel, que pede ao GitHub para rodar o robô.
Ela recusa um novo pedido se o robô já estiver rodando ou se a última rodada começou há menos de 30 minutos.

1. **GitHub** → foto do perfil → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token.
   - Repository access: *Only select repositories* → `lc-deals`
   - Permissions → Repository permissions → **Actions: Read and write** (o resto fica como está)
   - Expiration: a mais longa disponível. Copie o token (começa com `github_pat_`).
2. **Vercel** → projeto lc-deals → Settings → Environment Variables → adicione `GITHUB_TOKEN` com o token.
   Se o seu usuário do GitHub não for `brunoalvesabao`, adicione também `GITHUB_REPO` = `seu-usuario/lc-deals`.
3. Envie os arquivos para o GitHub (a Vercel publica sozinha). Se o token foi adicionado depois do último deploy, vá em Deployments → ⋯ → Redeploy.

## Horários automáticos

`cron: '0 3,9,15,21 * * *'` = 00h, 06h, 12h e 18h de Brasília (o GitHub conta em UTC, 3h à frente).
O GitHub não garante o minuto exato: em horários cheios, a execução agendada costuma começar de 10 a 60 minutos depois.

## Versão 2.5 — o que fazer uma vez

1. **config.js**: cole a chave anon do Supabase neste arquivo (não mais no index.html). As próximas atualizações não vão trazer o config.js, então você não precisa colar de novo.
2. **Supabase → SQL Editor**: rode o arquivo `supabase/migration-002.sql` (cria a tabela de notas/Metascore). Não apaga nada.
3. A nova fonte `meta` busca Metascore e "mais procurados" no IsThereAnyDeal: ~500 jogos por rodada, começando pelos mais desejados. Com 4 rodadas por dia, o catálogo de PC fica todo coberto em poucos dias. Jogos de console usam a nota do jogo de mesmo nome; exclusivos sem versão de PC ficam sem nota.
