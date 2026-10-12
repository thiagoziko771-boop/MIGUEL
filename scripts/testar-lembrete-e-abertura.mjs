/**
 * Audita as duas metades da pergunta "eu falei com essa pessoa, e ela viu?".
 *
 *   node scripts/testar-lembrete-e-abertura.mjs
 *
 * PARTE A — O LEMBRETE ALCANÇA QUEM PERDEU O PRAZO. A cobrança da PixGo vive 20
 * minutos e o lembrete espera 15, o que deixava uma janela de cinco minutos
 * para um agendador externo que atrasa até uma hora. O resultado medido em
 * produção foi o pior possível: o motor rodou o dia inteiro, respondeu
 * "candidatos: 0" em toda execução e não mandou um único e-mail enquanto os
 * pedidos abandonados se acumulavam. Agora quem perdeu o prazo recebe a mesma
 * mensagem com o botão que gera outro código — e é isso que se verifica aqui,
 * junto do cuidado que veio com a mudança: NUNCA mandar um código morto no
 * corpo, porque quem cola código morto leva um "não" do banco e conclui que a
 * loja é quebrada.
 *
 * PARTE B — A ABERTURA É MEDIDA. Sem isto o painel só sabia dizer "o provedor
 * aceitou mandar", que é o começo da história. A medição é uma imagem de 1
 * pixel no rodapé; o que se verifica é que ela conta a leitura, que reabrir
 * conta de novo sem mexer na primeira vez, e que ninguém consegue inflar o
 * número sem a assinatura.
 */

import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const PORTA_EMAIL = 3399;
const PORTA_APP = 3349;
const CRON_SECRET = 'segredo-do-cron-de-teste';
/** Curto de propósito: a bateria precisa de um código VENCIDO para conferir. */
const EXPIRA_EM_MS = 2000;
/** O mesmo papel do limiar de dois minutos em produção, encolhido para o teste. */
const LIMIAR_DE_LEITURA_MS = 2000;

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

const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));

/* ========================================================================== */
/* Provedor de e-mail falso                                                    */
/* ========================================================================== */

const enviados = [];

const provedorFalso = http.createServer((req, res) => {
  let corpo = '';
  req.on('data', (p) => { corpo += p; });
  req.on('end', () => {
    try {
      enviados.push(JSON.parse(corpo));
    } catch {
      enviados.push({ invalido: corpo });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg-' + enviados.length }));
  });
});

await new Promise((ok) => provedorFalso.listen(PORTA_EMAIL, ok));

/* ========================================================================== */
/* Servidor sob teste                                                          */
/* ========================================================================== */

const jaOcupada = await fetch(`${base}/api/health`).then(() => true).catch(() => false);
if (jaOcupada) {
  console.error(`\nA porta ${PORTA_APP} ja esta ocupada -- provavelmente um servidor de teste que sobrou.\n`);
  provedorFalso.close();
  process.exit(1);
}

const SENHA_PAINEL = 'senha-de-teste-' + crypto.randomBytes(4).toString('hex');
const dataDir = mkdtempSync(path.join(tmpdir(), 'lembrete-abertura-'));
const app = spawn('npx', ['tsx', path.join(raiz, 'server', 'index.ts')], {
  cwd: dataDir,
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    PIX_MODE: 'mock',
    // Nunca se confirma sozinha: pedido que vira "pago" no meio acusaria falha
    // onde não há.
    MOCK_CONFIRM_DELAY_MS: '600000',
    MOCK_EXPIRY_MS: String(EXPIRA_EM_MS),
    // Dois segundos no lugar dos dois minutos: abaixo disso a carga da imagem é
    // do provedor buscando sozinho, acima é gente.
    EMAIL_LEITURA_APOS_MS: String(LIMIAR_DE_LEITURA_MS),
    META_TRACKING_ENABLED: 'false',
    ADMIN_SENHA: SENHA_PAINEL,
    PAINEL_CHAVE_MESTRA: crypto.randomBytes(32).toString('hex'),
    CRON_SECRET,
    PORT: String(PORTA_APP),
    DATA_DIR: dataDir,
    DATABASE_URL: '',
    LOG_LEVEL: 'warn',
    EMAIL_API_KEY: 'chave-falsa-de-teste',
    EMAIL_BASE_URL: `http://localhost:${PORTA_EMAIL}`,
    PUBLIC_BASE_URL: base,
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
  await esperar(500);
}

function encerrar(codigo) {
  /*
   * No Windows, spawn com shell:true cria a arvore cmd -> npx -> node, e
   * app.kill() mata SO o cmd: o node continua vivo segurando a porta, e a
   * proxima execucao morre em 'porta ocupada'. Foi exatamente o que travou a
   * esteira em 14/08/2026 - tres baterias em sequencia, tres zumbis. O
   * taskkill /T derruba a arvore inteira.
   */
  if (app?.pid && process.platform === 'win32') {
    try { spawnSync('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ja morreu */ }
  } else if (app) {
    app.kill();
  }
  provedorFalso.close();
  process.exit(codigo);
}

if (!subiu) {
  console.error('\nO servidor nao subiu.\n');
  encerrar(1);
}

const cron = (minutos) =>
  fetch(`${base}/api/cron/recuperacao${minutos === undefined ? '' : `?minutos=${minutos}`}`, {
    headers: { Authorization: `Bearer ${CRON_SECRET}` },
  }).then((r) => r.json());

const criarPedido = (email, document) =>
  fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      offer: 'main',
      bumps: [],
      customer: { name: 'Maria Aparecida de Souza', email, phone: '11988887777', document },
    }),
  }).then((r) => r.json());

/* ========================================================================== */
/* PARTE A — o lembrete de quem perdeu o prazo                                 */
/* ========================================================================== */

console.log('\n== O codigo venceu, e mesmo assim falamos com a pessoa ==\n');

const criado = await criarPedido('vencido@exemplo.com', '39053344705');
checar(criado.success === true, 'cria o pedido com PIX', JSON.stringify(criado).slice(0, 200));
const pedidoId = criado.data?.id;
const codigoPix = criado.data?.pix?.code ?? '';

// Passa do prazo da cobrança falsa.
await esperar(EXPIRA_EM_MS + 500);

const rodada = await cron(0);
checar(rodada.data?.enviados === 1, `com o codigo vencido, o lembrete SAI (enviados: ${rodada.data?.enviados})`);
checar(enviados.length === 1, `um e-mail, nao dois (veio ${enviados.length})`);

const carta = enviados[0] ?? {};
const html = String(carta.html ?? '');
const texto = String(carta.text ?? '');

checar(
  codigoPix !== '' && !html.includes(codigoPix) && !texto.includes(codigoPix),
  'o codigo morto NAO vai no corpo -- colar codigo vencido faz o banco recusar',
);
checar(/GERAR O MEU C[ÓO]DIGO AGORA/i.test(html), 'o botao oferece gerar outro codigo');
checar(/j[áa] venceu/i.test(html) && /j[áa] venceu/i.test(texto), 'e a mensagem diz a verdade sobre o prazo');

const linkDoCodigo = (html.match(/https?:\/\/[^"']*\/api\/codigo\/[^"']+/) ?? [])[0];
checar(Boolean(linkDoCodigo), 'o e-mail leva o endereco da pagina que gera o codigo novo');

/* ========================================================================== */
/* PARTE B — a abertura                                                        */
/* ========================================================================== */

console.log('\n== A abertura, medida ==\n');

const alvoDoPixel = (html.match(/https?:\/\/[^"']*\/api\/e\/[^"']+/) ?? [])[0];
checar(Boolean(alvoDoPixel), 'o rodape carrega a imagem que mede a leitura');
checar(
  alvoDoPixel ? alvoDoPixel.includes(`/api/e/${pedidoId}/recuperacao/`) : false,
  'a imagem aponta para este pedido e para este e-mail',
);

const entrada = await fetch(`${base}/api/admin/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ senha: SENHA_PAINEL }),
}).then((r) => r.json());
const sessao = entrada.data?.token;
checar(Boolean(sessao), 'entra no painel');

const doPainel = async () => {
  const lista = await fetch(`${base}/api/admin/pedidos`, { headers: { 'X-Admin-Sessao': sessao } })
    .then((r) => r.json());
  return (lista.data?.pedidos ?? []).find((p) => p.id === pedidoId)?.email ?? null;
};

const antes = await doPainel();
checar(antes?.estado === 'enviado', `antes de qualquer carga, o painel diz "enviado" (veio ${antes?.estado})`);
checar(antes?.marca === 'recuperacao', `e sabe qual mensagem foi (veio ${antes?.marca})`);

const pixel = await fetch(alvoDoPixel);
checar(pixel.status === 200, `a imagem responde 200 (veio ${pixel.status})`);
checar(
  (pixel.headers.get('content-type') ?? '').includes('image/gif'),
  `e responde uma imagem de verdade (veio ${pixel.headers.get('content-type')})`,
);
checar(
  (pixel.headers.get('cache-control') ?? '').includes('no-store'),
  'sem cache -- senao a segunda leitura nunca chega ate o servidor',
);

/*
 * O CORAÇÃO DESTA PARTE. A carga que chega no mesmo instante do envio é o
 * provedor buscando a imagem para o cache dele — medido em produção entre 3 e 7
 * segundos, no Gmail. Contá-la como leitura foi o que transformou 2 leituras
 * reais em "43% de abertura" no primeiro dia no ar.
 */
const imediato = await doPainel();
checar(imediato?.estado === 'entregue', `carga instantanea vira ENTREGUE, nao lida (veio ${imediato?.estado})`);
checar(imediato?.aberturas === 0, `e nao conta como leitura (veio ${imediato?.aberturas})`);
checar(Boolean(imediato?.entregueEm), 'mas fica registrada: e a prova de que a caixa existe');
checar(!imediato?.abertoEm, 'sem hora de leitura, porque ninguem leu');

// Passado o limiar, a mesma carga passa a ser gente.
await esperar(LIMIAR_DE_LEITURA_MS + 400);
await fetch(alvoDoPixel);

const depois = await doPainel();
checar(depois?.estado === 'aberto', `carga depois do limiar vira LEITURA (veio ${depois?.estado})`);
checar(depois?.aberturas === 1, `uma leitura contada (veio ${depois?.aberturas})`);
checar(Boolean(depois?.abertoEm), 'com a hora da leitura');
checar(
  depois?.entregueEm !== depois?.abertoEm,
  'e a entrega continua marcando o instante ANTERIOR, nao o da leitura',
);

await fetch(alvoDoPixel);
const relido = await doPainel();
checar(relido?.aberturas === 2, `reler conta de novo (veio ${relido?.aberturas})`);
checar(
  relido?.abertoEm === depois?.abertoEm,
  'mas a PRIMEIRA leitura nao se perde -- e ela que diz quanto tempo o e-mail levou para funcionar',
);

const forjado = alvoDoPixel.replace(/\/[0-9a-f]+\.gif$/, '/0000000000000000000000ff.gif');
const respostaForjada = await fetch(forjado);
checar(respostaForjada.status === 200, 'assinatura errada tambem recebe a imagem -- nao se confirma nem se nega nada');
const aposForja = await doPainel();
checar(aposForja?.aberturas === 2, `mas nao conta (continua ${aposForja?.aberturas})`);

/* ========================================================================== */
/* PARTE C — o clique, que é o sinal que vale dinheiro                         */
/* ========================================================================== */

console.log('\n== O clique ==\n');

if (linkDoCodigo) {
  const pagina = await fetch(linkDoCodigo);
  checar(pagina.status === 200, `a pagina do codigo abre (veio ${pagina.status})`);

  const apos = await doPainel();
  checar(apos?.estado === 'clicou', `o painel passa a dizer "clicou" (veio ${apos?.estado})`);
  checar(Boolean(apos?.clicouEm), 'com a hora da visita');
}

/* ========================================================================== */

console.log(tudoOk ? '\nTODOS OS TESTES PASSARAM\n' : '\nHOUVE FALHAS\n');
encerrar(tudoOk ? 0 : 1);
