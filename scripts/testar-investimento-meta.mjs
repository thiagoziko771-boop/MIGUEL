/**
 * Testa a importação do gasto direto da API de Marketing do Meta.
 *
 *   node scripts/testar-investimento-meta.mjs
 *
 * Sobe um Graph falso e um servidor com banco em arquivo temporário. Nenhuma
 * chamada sai para o Meta de verdade e nenhum token real é usado.
 *
 * O que esta bateria protege, em ordem de estrago:
 *
 * 1. O TOTAL TRIPLICADO. O mesmo dinheiro aparece três vezes no Gerenciador —
 *    por campanha, conjunto e anúncio. Importamos os três para a coluna
 *    "Investido" existir em qualquer agrupamento; se eles se somarem, o painel
 *    mostra três vezes o gasto real, o ROAS aparece a um terço e a decisão que
 *    sai daí é desligar um anúncio que estava lucrando.
 * 2. O TOKEN EM TEXTO. Ele é a chave de leitura de uma conta de anúncios e
 *    nunca pode voltar para a tela nem sair de um endpoint.
 * 3. O CRON ABERTO. Um endereço público que dispara chamadas à API do Meta é um
 *    jeito barato de alguém queimar o limite de requisições da conta do dono.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PORTA_GRAPH = 3399;
const PORTA_APP = 3343;
const CRON_SECRET = 'segredo-do-cron-de-teste';
const TOKEN_ADS = 'EAAG-token-de-anuncios-falso';
const CONTA = 'act_998877';

/*
 * Os dois dias do teste, relativos ao calendário de São Paulo.
 *
 * Antes eram datas fixas, e isso bastava enquanto todo período terminava hoje:
 * qualquer janela larga pegava as duas. Com "Ontem" no painel a data virou
 * parte do que está sendo testado — só dá para afirmar que o filtro separa um
 * dia do outro se o teste souber que dia é hoje.
 */
const emSaoPaulo = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' });
const DIA_DE_HOJE = emSaoPaulo.format(new Date());
const DIA_DE_ONTEM = emSaoPaulo.format(new Date(Date.now() - 86400000));

const raiz = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '..',
);
const base = `http://localhost:${PORTA_APP}`;

let tudoOk = true;
function checar(ok, descricao, extra) {
  console.log(`  ${ok ? 'PASSOU' : 'FALHOU'}  ${descricao}${extra && !ok ? ` -> ${extra}` : ''}`);
  if (!ok) tudoOk = false;
}

/* ========================================================================== */
/* Graph falso                                                                 */
/* ========================================================================== */

const chamadas = [];
/** Trocado pelos testes para simular erro do Meta. */
let respostaDoGraph = 'ok';

const graphFalso = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORTA_GRAPH}`);
  chamadas.push({
    caminho: url.pathname,
    // Qual pergunta foi feita: `insights` é quanto gastou, `campaigns`/`adsets`/
    // `ads` é o cadastro (nome e situação). As duas viajam pelo mesmo Graph e
    // precisam ser contadas separadamente, senão uma some dentro da outra.
    colecao: url.pathname.split('/').pop(),
    nivel: url.searchParams.get('level'),
    incremento: url.searchParams.get('time_increment'),
    intervalo: url.searchParams.get('time_range'),
    token: url.searchParams.get('access_token'),
    campos: url.searchParams.get('fields'),
  });

  const responder = (status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  if (respostaDoGraph === 'sem_permissao') {
    responder(400, { error: { message: '(#278) Requires ads_read permission', type: 'OAuthException', code: 278 } });
    return;
  }
  if (respostaDoGraph === 'token_expirado') {
    responder(401, { error: { message: 'Session has expired', type: 'OAuthException', code: 190 } });
    return;
  }

  /*
   * O cadastro: nome e situação de cada campanha, conjunto e anúncio.
   *
   * Outra pergunta e outro endereço — o insights não sabe dizer o que está
   * ligado. É daqui que sai a separação entre "rodando agora" e "parado", e por
   * isso a campanha 120201 vem PAUSED de propósito: sem uma parada na resposta,
   * o teste passaria mesmo se o painel marcasse tudo como ativo.
   */
  const colecao = url.pathname.split('/').pop();
  const cadastro = {
    campaigns: [
      { id: '120200', name: 'CTV-PADRE', effective_status: 'ACTIVE' },
      { id: '120201', name: 'CA-ANTIGA', effective_status: 'PAUSED' },
    ],
    adsets: [{ id: '120300', name: 'Conjunto de teste', effective_status: 'ACTIVE' }],
    ads: [{ id: '120400', name: 'Anuncio de teste', effective_status: 'PAUSED' }],
  };
  if (cadastro[colecao]) {
    responder(200, { data: cadastro[colecao] });
    return;
  }

  const nivel = url.searchParams.get('level');
  /*
   * O MESMO dinheiro em três alturas: R$ 12,34 num dia e R$ 7,00 no outro.
   * É assim que o Meta responde de verdade -- e é o que faria o total triplicar
   * se o painel somasse os três níveis.
   */
  const porNivel = {
    campaign: [
      { date_start: DIA_DE_ONTEM, spend: '12.34', impressions: '1000', clicks: '25', campaign_id: '120200' },
      { date_start: DIA_DE_HOJE, spend: '7.00', impressions: '500', clicks: '10', campaign_id: '120200' },
    ],
    adset: [
      { date_start: DIA_DE_ONTEM, spend: '12.34', impressions: '1000', clicks: '25', adset_id: '120300' },
      { date_start: DIA_DE_HOJE, spend: '7.00', impressions: '500', clicks: '10', adset_id: '120300' },
    ],
    ad: [
      { date_start: DIA_DE_ONTEM, spend: '12.34', impressions: '1000', clicks: '25', ad_id: '120400' },
      { date_start: DIA_DE_HOJE, spend: '7.00', impressions: '500', clicks: '10', ad_id: '120400' },
    ],
  };

  responder(200, { data: porNivel[nivel] ?? [] });
});

await new Promise((ok) => graphFalso.listen(PORTA_GRAPH, ok));

/* ========================================================================== */
/* Servidor sob teste                                                          */
/* ========================================================================== */

const senhaPainel = 'senha-de-teste-' + crypto.randomBytes(4).toString('hex');

const jaOcupada = await fetch(`${base}/api/health`).then(() => true).catch(() => false);
if (jaOcupada) {
  console.error(`\nA porta ${PORTA_APP} ja esta ocupada -- provavelmente um servidor de teste que sobrou.\n`);
  graphFalso.close();
  process.exit(1);
}

const dataDir = mkdtempSync(path.join(tmpdir(), 'meta-ads-app-'));
const app = spawn('npx', ['tsx', path.join(raiz, 'server', 'index.ts')], {
  cwd: dataDir,
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    PIX_MODE: 'mock',
    META_TRACKING_ENABLED: 'false',
    ADMIN_SENHA: senhaPainel,
    PAINEL_CHAVE_MESTRA: crypto.randomBytes(32).toString('hex'),
    CRON_SECRET,
    PORT: String(PORTA_APP),
    DATA_DIR: dataDir,
    DATABASE_URL: '',
    LOG_LEVEL: 'warn',
    // O cliente monta a URL a partir daqui; apontando para o Graph falso,
    // nenhuma chamada sai para o Meta de verdade. É a mesma variável que a
    // bateria de rastreamento usa para a API de Conversões.
    META_BASE_URL: `http://localhost:${PORTA_GRAPH}`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

app.stderr.on('data', (d) => {
  const linha = String(d);
  if (process.env.DEPURAR || /Uncaught|TypeError|ReferenceError/.test(linha)) process.stderr.write('[app] ' + linha);
});

let subiu = false;
for (let tentativa = 0; tentativa < 60; tentativa += 1) {
  if (app.exitCode !== null) break;
  try {
    const resposta = await fetch(`${base}/api/health`);
    if (resposta.ok) { subiu = true; break; }
  } catch { /* ainda subindo */ }
  await new Promise((ok) => setTimeout(ok, 500));
}

function matarArvore() {
  if (app.exitCode !== null) return;
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ja morreu */ }
    return;
  }
  try { app.kill(); } catch { /* ja morreu */ }
}

function encerrar(codigo) {
  matarArvore();
  graphFalso.close();
  process.exit(codigo);
}

process.on('exit', matarArvore);
process.on('uncaughtException', (erro) => {
  console.error('\nA bateria parou no meio:', erro?.message ?? erro);
  encerrar(1);
});

if (!subiu) {
  console.error('O servidor nao subiu.');
  encerrar(1);
}

async function pedir(caminho, opcoes) {
  opcoes = opcoes || {};
  const resposta = await fetch(`${base}${caminho}`, {
    ...opcoes,
    headers: { Connection: 'close', ...(opcoes.headers ?? {}) },
  });
  const corpo = await resposta.json().catch(() => ({}));
  return { status: resposta.status, ...corpo };
}

const sessao = await pedir('/api/admin/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ senha: senhaPainel }),
});
const token = sessao.data?.token ?? '';
const cabecalho = { 'X-Admin-Sessao': token, 'Content-Type': 'application/json' };

console.log(`\nInvestimento direto do Meta em ${base}\n`);
checar(Boolean(token), 'entra no painel');

/* ========================================================================== */
/* PARTE 1 — credenciais                                                       */
/* ========================================================================== */

console.log('\n== Credenciais da conta de anuncios ==\n');

const semNada = await pedir('/api/admin/meta/anuncios', { headers: { 'X-Admin-Sessao': token } });
checar(semNada.data?.ligado === false, 'comeca desligado');
checar(semNada.data?.podeGuardarToken === true, 'com chave mestra, pode guardar token');

// O dono cola o numero como estiver na tela dele -- com act_, sem act_, tanto faz.
const salvo = await pedir('/api/admin/meta/anuncios', {
  method: 'POST',
  headers: cabecalho,
  body: JSON.stringify({ contaId: '998877', token: TOKEN_ADS }),
});
checar(salvo.data?.contaId === CONTA, `normaliza a conta para act_ (veio ${salvo.data?.contaId})`);
checar(salvo.data?.ligado === true, 'com conta e token, fica ligado');

const depois = await pedir('/api/admin/meta/anuncios', { headers: { 'X-Admin-Sessao': token } });
const corpoCru = JSON.stringify(depois);
checar(corpoCru.includes(CONTA), 'a tela recebe o numero da conta');
checar(
  !corpoCru.includes(TOKEN_ADS),
  'o token NUNCA volta para a tela, nem mascarado',
  corpoCru.slice(0, 200),
);
checar(depois.data?.temToken === true, 'mas a tela sabe que existe um token');

const contaRuim = await pedir('/api/admin/meta/anuncios', {
  method: 'POST',
  headers: cabecalho,
  body: JSON.stringify({ contaId: 'minha conta' }),
});
checar(contaRuim.success === false, 'recusa conta sem digito nenhum');

/* ========================================================================== */
/* PARTE 2 — a importacao                                                      */
/* ========================================================================== */

console.log('\n== A importacao ==\n');

chamadas.length = 0;
const importado = await pedir('/api/admin/meta/anuncios/importar', {
  method: 'POST',
  headers: cabecalho,
  body: JSON.stringify({ dias: 7 }),
});

// Só as consultas de gasto. O cadastro (nome e situação) vai pelo mesmo Graph e
// tem outras regras: não pede `level` nem `time_increment`, e contá-lo aqui
// faria o teste do dia-a-dia falhar por um motivo que não é o dele.
const deGasto = () => chamadas.filter((c) => c.colecao === 'insights');
const deCadastro = () => chamadas.filter((c) => c.colecao !== 'insights');

checar(importado.success === true, 'importa', JSON.stringify(importado).slice(0, 200));
checar(deGasto().length === 3, `pede os tres niveis ao Meta (veio ${deGasto().length})`);
checar(
  deGasto().map((c) => c.nivel).join(',') === 'campaign,adset,ad',
  `na ordem campanha, conjunto e anuncio (veio ${deGasto().map((c) => c.nivel).join(',')})`,
);
checar(
  deGasto().every((c) => c.incremento === '1'),
  'pede o gasto DIA A DIA (sem isso viria o total do periodo somado num dia so)',
);
checar(
  deCadastro().map((c) => c.colecao).sort().join(',') === 'ads,adsets,campaigns',
  `busca tambem o cadastro dos tres niveis (veio ${deCadastro().map((c) => c.colecao).join(',')})`,
);
checar(chamadas.every((c) => c.token === TOKEN_ADS), 'manda o token de leitura');
checar(
  deGasto()[0].caminho.includes(CONTA),
  `chama a conta certa (veio ${deGasto()[0].caminho})`,
);

// 12,34 + 7,00 = 19,34 em UM nivel. Se somasse os tres, daria 58,02.
checar(
  importado.data?.totalCentavos === 1934,
  `soma so um nivel: R$ 19,34 (veio ${importado.data?.totalCentavos} centavos)`,
);
checar(importado.data?.linhas === 6, `grava as seis linhas, duas por nivel (veio ${importado.data?.linhas})`);

/* --- E na tela? O total nao pode triplicar --- */

const porCampanha = await pedir('/api/admin/anuncios?dias=30&agrupamento=campanha', {
  headers: { 'X-Admin-Sessao': token },
});
checar(
  porCampanha.data?.totais?.investimentoCentavos === 1934,
  `agrupado por campanha, o investido e R$ 19,34 (veio ${porCampanha.data?.totais?.investimentoCentavos})`,
);
checar(
  porCampanha.data?.totais?.impressoes === 1500,
  `as impressoes tambem nao triplicam (veio ${porCampanha.data?.totais?.impressoes})`,
);

/* --- O que esta rodando agora --- */

console.log('\n== Ativos e parados ==\n');

const campanhaAtiva = (porCampanha.data?.linhas ?? []).find((l) => l.chave === '120200');
checar(campanhaAtiva?.ativo === true, `campanha ACTIVE volta marcada como ativa (veio ${campanhaAtiva?.ativo})`);
checar(
  campanhaAtiva?.rotulo === 'CTV-PADRE',
  `e com o nome do Meta no lugar do numero (veio ${campanhaAtiva?.rotulo})`,
);

const anunciosComSituacao = await pedir('/api/admin/anuncios?dias=30&agrupamento=anuncio', {
  headers: { 'X-Admin-Sessao': token },
});
const anuncioParado = (anunciosComSituacao.data?.linhas ?? []).find((l) => l.chave === '120400');
checar(anuncioParado?.ativo === false, `anuncio PAUSED volta como parado (veio ${anuncioParado?.ativo})`);

/* --- O recorte por dia --- */

console.log('\n== Hoje e ontem ==\n');

const deOntem = await pedir('/api/admin/anuncios?dias=1&ate=ontem&agrupamento=campanha', {
  headers: { 'X-Admin-Sessao': token },
});
checar(
  deOntem.data?.totais?.investimentoCentavos === 1234,
  `"Ontem" traz so o gasto de ontem: R$ 12,34 (veio ${deOntem.data?.totais?.investimentoCentavos})`,
);
checar(
  deOntem.data?.periodo?.diaInicial === DIA_DE_ONTEM && deOntem.data?.periodo?.diaFinal === DIA_DE_ONTEM,
  `e a janela abre e fecha em ontem (veio ${deOntem.data?.periodo?.diaInicial} a ${deOntem.data?.periodo?.diaFinal})`,
);

const deHoje = await pedir('/api/admin/anuncios?dias=1&ate=hoje&agrupamento=campanha', {
  headers: { 'X-Admin-Sessao': token },
});
checar(
  deHoje.data?.totais?.investimentoCentavos === 700,
  `"Hoje" traz so o gasto de hoje: R$ 7,00 (veio ${deHoje.data?.totais?.investimentoCentavos})`,
);

const porConjunto = await pedir('/api/admin/anuncios?dias=30&agrupamento=conjunto', {
  headers: { 'X-Admin-Sessao': token },
});
checar(
  porConjunto.data?.totais?.investimentoCentavos === 1934,
  `por conjunto, o mesmo valor -- e nao o dobro (veio ${porConjunto.data?.totais?.investimentoCentavos})`,
);
const linhaDoConjunto = (porConjunto.data?.linhas ?? []).find((l) => l.chave === '120300');
checar(Boolean(linhaDoConjunto), 'o conjunto aparece com o ID do Meta');

const porAnuncio = await pedir('/api/admin/anuncios?dias=30&agrupamento=anuncio', {
  headers: { 'X-Admin-Sessao': token },
});
checar(
  porAnuncio.data?.totais?.investimentoCentavos === 1934,
  `por anuncio, idem (veio ${porAnuncio.data?.totais?.investimentoCentavos})`,
);

// Reimportar nao pode duplicar: o Meta revisa numeros fechados por ate 72 h e a
// importacao roda todo dia sobre a mesma janela.
await pedir('/api/admin/meta/anuncios/importar', {
  method: 'POST',
  headers: cabecalho,
  body: JSON.stringify({ dias: 7 }),
});
const depoisDeDuas = await pedir('/api/admin/anuncios?dias=30&agrupamento=campanha', {
  headers: { 'X-Admin-Sessao': token },
});
checar(
  depoisDeDuas.data?.totais?.investimentoCentavos === 1934,
  `importar duas vezes nao duplica o gasto (veio ${depoisDeDuas.data?.totais?.investimentoCentavos})`,
);

/* ========================================================================== */
/* PARTE 3 — quando o Meta reclama                                             */
/* ========================================================================== */

console.log('\n== Quando o Meta reclama ==\n');

respostaDoGraph = 'sem_permissao';
const semPermissao = await pedir('/api/admin/meta/anuncios/importar', {
  method: 'POST',
  headers: cabecalho,
  body: JSON.stringify({ dias: 7 }),
});
checar(semPermissao.success === false, 'falha quando o token nao tem ads_read');
checar(
  String(semPermissao.message ?? '').includes('ads_read'),
  `e explica em portugues o que fazer (veio: ${String(semPermissao.message ?? '').slice(0, 90)})`,
);

respostaDoGraph = 'token_expirado';
const expirado = await pedir('/api/admin/meta/anuncios/importar', {
  method: 'POST',
  headers: cabecalho,
  body: JSON.stringify({ dias: 7 }),
});
checar(
  String(expirado.message ?? '').toLowerCase().includes('expirou'),
  `token vencido vira mensagem clara (veio: ${String(expirado.message ?? '').slice(0, 90)})`,
);

// O gasto ja importado continua na tela: uma falha de hoje nao pode apagar o
// historico de ontem.
const aindaTem = await pedir('/api/admin/anuncios?dias=30&agrupamento=campanha', {
  headers: { 'X-Admin-Sessao': token },
});
checar(
  aindaTem.data?.totais?.investimentoCentavos === 1934,
  'uma falha na importacao nao apaga o que ja tinha sido importado',
);
respostaDoGraph = 'ok';

/* ========================================================================== */
/* PARTE 4 — o cron                                                            */
/* ========================================================================== */

console.log('\n== O agendamento ==\n');

const semSegredo = await pedir('/api/cron/investimento');
checar(semSegredo.status === 404, `sem o segredo, a rota nem existe (veio ${semSegredo.status})`);

const segredoErrado = await pedir('/api/cron/investimento', {
  headers: { Authorization: 'Bearer segredo-errado' },
});
checar(segredoErrado.status === 404, `com segredo errado, idem (veio ${segredoErrado.status})`);

chamadas.length = 0;
const comSegredo = await pedir('/api/cron/investimento', {
  headers: { Authorization: `Bearer ${CRON_SECRET}` },
});
checar(comSegredo.status === 200, `com o segredo certo, roda (veio ${comSegredo.status})`);
checar(deGasto().length === 3, `e busca os tres niveis (veio ${deGasto().length})`);

/*
 * Falha na importacao devolve 200 de proposito: o agendador da Vercel desativa
 * o que falha sempre, e enquanto o dono nao tiver colado o token -- o estado
 * normal no primeiro dia -- isso desligaria a rotina justamente antes de ela
 * ser util.
 */
respostaDoGraph = 'token_expirado';
const cronComFalha = await pedir('/api/cron/investimento', {
  headers: { Authorization: `Bearer ${CRON_SECRET}` },
});
checar(cronComFalha.status === 200, `falha no Meta nao vira erro para o agendador (veio ${cronComFalha.status})`);
checar(cronComFalha.data?.importado === false, 'mas a resposta diz que nao importou');
respostaDoGraph = 'ok';

console.log(tudoOk ? '\nTODOS OS TESTES PASSARAM\n' : '\nHOUVE FALHAS\n');
encerrar(tudoOk ? 0 : 1);
