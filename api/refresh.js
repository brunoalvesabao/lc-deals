// =====================================================================
// LC Deals — botão "Atualizar" do site (função da Vercel)
//   GET  /api/refresh  -> status da última execução do robô (e de cada loja)
//   POST /api/refresh  -> dispara o robô no GitHub Actions
//
// Variáveis de ambiente na Vercel:
//   GITHUB_TOKEN  (obrigatória) token "fine-grained" com permissão Actions: Read and write só no repo lc-deals
//   GITHUB_REPO   (opcional)    padrão: brunoalvesabao/lc-deals
//   REFRESH_COOLDOWN_MIN (opcional) intervalo mínimo entre atualizações, padrão 30
// =====================================================================

const REPO = process.env.GITHUB_REPO || 'brunoalvesabao/lc-deals';
const WORKFLOW = process.env.GITHUB_WORKFLOW || 'main.yml';
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const COOLDOWN_MIN = Number(process.env.REFRESH_COOLDOWN_MIN || 30);

function gh(path, opts = {}) {
  return fetch(`https://api.github.com/repos/${REPO}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'lc-deals-refresh',
      ...(opts.headers || {}),
    },
  });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!process.env.GITHUB_TOKEN) return res.status(500).json({ error: 'Falta a variável GITHUB_TOKEN na Vercel' });

  const runsRes = await gh(`/actions/workflows/${WORKFLOW}/runs?per_page=1`);
  if (!runsRes.ok) return res.status(502).json({ error: `GitHub respondeu ${runsRes.status} (confira o token e o nome do repositório)` });
  const latest = (await runsRes.json()).workflow_runs?.[0] || null;

  let jobs = [];
  if (latest) {
    const jr = await gh(`/actions/runs/${latest.id}/jobs?per_page=50`);
    if (jr.ok) jobs = ((await jr.json()).jobs || []).map(j => ({ name: j.name, status: j.status, conclusion: j.conclusion }));
  }
  const running = !!latest && latest.status !== 'completed';
  const run = latest && {
    status: latest.status, conclusion: latest.conclusion, event: latest.event,
    created_at: latest.created_at, updated_at: latest.updated_at, url: latest.html_url,
  };

  if (req.method === 'GET') return res.status(200).json({ running, run, jobs });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use GET ou POST' });

  if (running) return res.status(409).json({ running, message: 'O robô já está rodando agora.' });
  const minutesAgo = latest ? (Date.now() - Date.parse(latest.created_at)) / 60000 : Infinity;
  if (minutesAgo < COOLDOWN_MIN) {
    const wait = Math.ceil(COOLDOWN_MIN - minutesAgo);
    return res.status(429).json({ message: `A última atualização começou há ${Math.floor(minutesAgo)} min. Dá para pedir outra em ${wait} min.` });
  }

  const d = await gh(`/actions/workflows/${WORKFLOW}/dispatches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: BRANCH, inputs: { only_sources: '' } }),
  });
  if (d.status !== 204) return res.status(502).json({ error: `GitHub recusou (${d.status}): ${(await d.text()).slice(0, 200)}` });
  return res.status(202).json({ started: true });
}
