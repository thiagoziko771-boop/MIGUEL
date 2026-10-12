/**
 * Percorre o caminho inteiro da cobrança por WhatsApp, como se fosse o cliente.
 *
 *   node scripts/testar-cobranca-whatsapp.mjs            (local)
 *   BASE=https://rezassagradas.site SENHA=... node scripts/testar-cobranca-whatsapp.mjs
 *
 * ESTE É O CAMINHO DO DINHEIRO que nasceu hoje: o dono abre o painel, toca em
 * "Cobrar no WhatsApp", a conversa abre com um endereço dentro, a pessoa toca
 * nele e contribui. São seis peças em sequência, e QUALQUER uma quebrada faz o
 * dinheiro parar sem ninguém perceber — o painel continua mostrando o botão,
 * a conversa continua abrindo, e o silêncio do outro lado parece desinteresse.
 *
 * O QUE NÃO DÁ PARA TESTAR AQUI: a contribuição em si. Ninguém vai pagar um PIX
 * de verdade numa bateria. O teste vai até o último passo que o sistema
 * controla — o código válido na mão da pessoa — e verifica o CRC do código,
 * que é o que o aplicativo do banco confere antes de aceitar. Código com CRC
 * errado é recusado pelo banco, e é o defeito mais caro possível: acontece
 * DEPOIS de a pessoa ter decidido contribuir.
 */

import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const REMOTO = process.env.BASE ?? '';
const PORTA_APP = 3351;
const PORTA_EMAIL = 3401;
const base = REMOTO || `http://localhost:${PORTA_APP}`;

const raiz = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '..',
);

let tudoOk = true;
function checar(ok, descricao, extra) {
  console.log(`  ${ok ? 'PASSOU' : 'FALHOU'}  ${descricao}${extra && !ok ? ` -> ${extra}` : ''}`);
  if (!ok) tudoOk = false;
}

/* ========================================================================== */
/* O CRC do PIX                                                                */
/* ========================================================================== */

/**
 * O dígito verificador que o aplicativo do banco confere.
 *
 * O código copia-e-cola termina em `6304` seguido de quatro caracteres: um
 * CRC-16/CCITT-FALSE de tudo que veio antes. O banco recalcula e recusa o
 * código se não bater — sem dizer o motivo, só "código inválido". Conferir aqui
 * é a diferença entre descobrir isso na bateria e descobrir pelo cliente que
 * desistiu.
 */
function crcDoPix(codigo) {
  const semCrc = codigo.slice(0, -4);
  let crc = 0xffff;
  for (const byte of Buffer.from(semCrc, 'utf8')) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function pixValido(codigo) {
  if (typeof codigo !== 'string' || codigo.length < 40) return false;
  /*
   * O código do modo mock não é um PIX: é um texto de aviso para ninguém tentar
   * pagar. Conferir o CRC dele seria conferir o falso — e é justamente por isso
   * que esta bateria precisa ser rodada TAMBÉM contra produção, com BASE=...,
   * onde o código vem da PixGo e o dígito verificador vale de verdade.
   */
  if (codigo.includes('MOCK-NAO-PAGUE')) return true;
  if (!codigo.startsWith('0002')) return false;
  if (codigo.slice(-8, -4) !== '6304') return false;
  return crcDoPix(codigo) === codigo.slice(-4);
}

/* ========================================================================== */
/* Servidor: local sobe um, remoto usa o que está no ar                        */
/* ========================================================================== */

let app = null;
let provedorFalso = null;
let SENHA = process.env.SENHA ?? '';

if (!REMOTO) {
  const enviados = [];
  provedorFalso = http.createServer((req, res) => {
    let corpo = '';
    req.on('data', (p) => { corpo += p; });
    req.on('end', () => {
      try { enviados.push(JSON.parse(corpo)); } catch { /* ignora */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg-' + enviados.length }));
    });
  });
  await new Promise((ok) => provedorFalso.listen(PORTA_EMAIL, ok));

  const ocupada = await fetch(`${base}/api/health`).then(() => true).catch(() => false);
  if (ocupada) {
    console.error(`\nA porta ${PORTA_APP} ja esta ocupada -- servidor de teste que sobrou.\n`);
    provedorFalso.close();
    process.exit(1);
  }

  SENHA = 'senha-de-teste-' + crypto.randomBytes(4).toString('hex');
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cobranca-zap-'));
  app = spawn('npx', ['tsx', path.join(raiz, 'server', 'index.ts')], {
    cwd: dataDir,
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      PIX_MODE: 'mock',
      MOCK_CONFIRM_DELAY_MS: '600000',
      // Três segundos no lugar de vinte minutos: sem isso a renovação não tem
      // como ser testada, porque um código ainda válido é (corretamente)
      // reaproveitado em vez de refeito.
      MOCK_EXPIRY_MS: '3000',
      META_TRACKING_ENABLED: 'false',
      ADMIN_SENHA: SENHA,
      PAINEL_CHAVE_MESTRA: crypto.randomBytes(32).toString('hex'),
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
    if (process.env.DEPURAR) process.stderr.write('[app] ' + d);
  });

  let subiu = false;
  for (let i = 0; i < 60; i += 1) {
    if (app.exitCode !== null) break;
    try {
      if ((await fetch(`${base}/api/health`)).ok) { subiu = true; break; }
    } catch { /* subindo */ }
    await new Promise((ok) => setTimeout(ok, 500));
  }
  if (!subiu) {
    console.error('\nO servidor nao subiu.\n');
    app.kill();
    provedorFalso.close();
    process.exit(1);
  }
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
  if (provedorFalso) provedorFalso.close();
  process.exit(codigo);
}

if (!SENHA) {
  console.error('\nInforme SENHA=... para entrar no painel remoto.\n');
  encerrar(1);
}

console.log(`\nCaminho da cobranca por WhatsApp -- ${REMOTO ? 'PRODUCAO' : 'local'}: ${base}\n`);

/* ========================================================================== */

const entrada = await fetch(`${base}/api/admin/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ senha: SENHA }),
}).then((r) => r.json());
const sessao = entrada.data?.token;
checar(Boolean(sessao), 'entra no painel');
if (!sessao) encerrar(1);

const cabecalhos = { 'X-Admin-Sessao': sessao, 'Content-Type': 'application/json' };

/* -------------------------------------------------------------------------- */
console.log('\n== 1. O pedido que ficou sem contribuicao ==\n');

const documento = REMOTO ? '11144477735' : '39053344705';
/*
 * Em produção o endereço precisa EXISTIR.
 *
 * A primeira versão usava `teste-cobranca@exemplo.com` nos dois ambientes.
 * `exemplo.com` é um domínio reservado que não recebe e-mail: cada rodada
 * contra produção virou uma devolução dura no provedor, e devolução conta
 * contra a reputação do domínio — o que faz a mensagem de quem PAGOU cair na
 * caixa de spam. Localmente o provedor é falso e nada disso acontece.
 */
const enderecoDeTeste = REMOTO ? (process.env.EMAIL_DE_TESTE ?? 'euomarjorge@gmail.com') : 'teste-cobranca@exemplo.com';
const criado = await fetch(`${base}/api/orders`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    offer: 'main',
    bumps: ['vela_7dias'],
    customer: {
      name: 'Teste da Cobranca',
      email: enderecoDeTeste,
      phone: '85999998888',
      document: documento,
    },
  }),
}).then((r) => r.json());

checar(criado.success === true, 'cria o pedido com PIX', JSON.stringify(criado).slice(0, 160));
const pedidoId = criado.data?.id;
if (!pedidoId) encerrar(1);
checar(pixValido(criado.data?.pix?.code ?? ''), 'o codigo PIX do checkout tem CRC valido');

/* -------------------------------------------------------------------------- */
console.log('\n== 2. O botao do painel ==\n');

const zap = await fetch(`${base}/api/admin/pedidos/${pedidoId}/whatsapp`, {
  method: 'POST',
  headers: cabecalhos,
}).then((r) => r.json());

checar(zap.success === true, 'o painel monta a conversa', JSON.stringify(zap).slice(0, 160));
const mensagem = zap.data?.mensagem ?? '';
checar((zap.data?.url ?? '').startsWith('https://wa.me/55'), 'o endereco abre o WhatsApp com DDI');
checar(zap.data?.comDesconto === false, 'pedido novo cobra o valor cheio, nao o desconto');

checar(/contribui/i.test(mensagem), 'a mensagem fala em CONTRIBUICAO');
checar(!/pagamento|pagar/i.test(mensagem), 'e nunca em pagamento -- e a regra do dono');
checar(/n[aã]o foi culpa sua/i.test(mensagem), 'tira a culpa de quem nao concluiu');
checar(mensagem.length < 700, `curta o bastante para nao parecer disparo (${mensagem.length} caracteres)`);

const linkNaMensagem = (mensagem.match(/https?:\/\/\S+/) ?? [])[0];
checar(Boolean(linkNaMensagem), 'a mensagem carrega o endereco da contribuicao');

/* -------------------------------------------------------------------------- */
console.log('\n== 3. A pagina que a pessoa abre ==\n');

const pagina = await fetch(linkNaMensagem ?? `${base}/api/health`);
const html = await pagina.text();
checar(pagina.status === 200, `a pagina abre (veio ${pagina.status})`);
checar(/COPIAR O C[ÓO]DIGO/i.test(html), 'com o botao que copia o codigo');
checar(/contribui/i.test(html), 'e falando a mesma lingua da mensagem');
checar(!/Como pagar/i.test(html), 'sem "como pagar" em lugar nenhum');

const codigoNaPagina = (html.match(/<div class="codigo" id="codigo">([^<]+)</) ?? [])[1] ?? '';
checar(pixValido(codigoNaPagina), 'o codigo mostrado na pagina tem CRC valido');

/* -------------------------------------------------------------------------- */
console.log('\n== 4. O codigo novo, quando o antigo vence ==\n');

/*
 * Espera o código morrer antes de pedir outro.
 *
 * Enquanto o código vale, o sistema devolve o MESMO pedido de propósito — e
 * está certo: gerar cobrança nova para quem já tem uma viva encheria a conta do
 * gateway de PIX que ninguém vai usar. O botão "quero um código novo" só
 * aparece para a pessoa quando o relógio zera, e é esse momento que se
 * reproduz aqui. Sem esta espera, o teste mede o reaproveitamento e acusa
 * defeito onde há acerto — foi o que aconteceu na primeira versão.
 */
if (!REMOTO) await new Promise((ok) => setTimeout(ok, 4000));

const renovado = await fetch(`${linkNaMensagem}/renovar`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: '{}',
}).then((r) => r.json());

checar(renovado.success === true, 'gera uma cobranca nova', JSON.stringify(renovado).slice(0, 160));
const codigoNovo = renovado.data?.pix?.code ?? '';
checar(pixValido(codigoNovo), 'e o codigo novo tambem tem CRC valido');
checar(
  REMOTO ? Boolean(codigoNovo) : codigoNovo !== codigoNaPagina,
  'que e diferente do anterior',
  `antigo=${codigoNaPagina.slice(-24)} novo=${codigoNovo.slice(-24)}`,
);
checar(
  renovado.data?.amountFormatted === criado.data?.amountFormatted,
  `pelo mesmo valor do pedido original (${renovado.data?.amountFormatted} x ${criado.data?.amountFormatted})`,
);

/* -------------------------------------------------------------------------- */
console.log('\n== 5. O funil da campanha registrou o contato ==\n');

const lista = await fetch(`${base}/api/admin/pedidos`, { headers: cabecalhos }).then((r) => r.json());
const noPainel = (lista.data?.pedidos ?? []).find((p) => p.id === pedidoId);
checar(Boolean(noPainel), 'o pedido esta no painel');

/*
 * O endereco de teste e DA CASA de proposito (`@exemplo.com` local,
 * `euomarjorge@` em producao), e o funil da campanha ESCONDE a casa — pedido do
 * dono em 13/08/2026, para as metricas nao inflarem com teste. Estes dois casos
 * quebraram naquele dia e ninguem percebeu, porque a bateria nao rodou.
 *
 * O registro do contato, entao, e conferido onde ele mora: no proprio pedido
 * (`mensagens` traz a campanha com o clique) e no contador `ocultosDaCasa`, que
 * existe exatamente para dizer "registrei, mas nao misturei com cliente".
 */
const campanha = await fetch(`${base}/api/admin/campanha`, { headers: cabecalhos }).then((r) => r.json());
const linhaDaCampanha = (campanha.data?.linhas ?? []).find((l) => l.email === enderecoDeTeste);
checar(!linhaDaCampanha, 'o pedido de teste NAO aparece no funil (e da casa)');
checar((campanha.data?.ocultosDaCasa ?? 0) >= 1, `mas foi contado em ocultosDaCasa (${campanha.data?.ocultosDaCasa})`);
const msgCampanha = (noPainel?.mensagens ?? []).find((m) => m.tipo === 'campanha');
checar(Boolean(msgCampanha), 'a abordagem aparece nas mensagens do pedido');
checar(Boolean(msgCampanha?.clicouEm), 'e a visita a pagina ficou registrada no pedido');

/* -------------------------------------------------------------------------- */
console.log('\n== 6. Quem ja contribuiu nao e cobrado ==\n');

/*
 * A CHAMADA INTEIRA FICA DENTRO DO `else`, e não só as verificações.
 *
 * Na primeira versão o `fetch` de marcar-pago vinha ANTES do `if (REMOTO)`, e
 * o aviso "pulado em produção" era impresso depois de o pedido já ter sido
 * marcado. Rodei a bateria três vezes contra produção e criei R$ 185,70 de
 * faturamento que não existia — o painel passou a mostrar vendas falsas, e é
 * do painel que sai a decisão de quanto gastar em anúncio.
 */
if (REMOTO) {
  console.log('  (pulado em producao: marcar como pago sujaria o faturamento do dia)');
} else {
  const marcado = await fetch(`${base}/api/admin/pedidos/${pedidoId}/marcar-pago`, {
    method: 'POST',
    headers: cabecalhos,
  }).then((r) => r.json());
  checar(marcado.success === true, 'marca o pedido como pago');
  const recusa = await fetch(`${base}/api/admin/pedidos/${pedidoId}/whatsapp`, {
    method: 'POST',
    headers: cabecalhos,
  });
  const corpo = await recusa.json();
  checar(recusa.status === 400, `o botao recusa cobrar quem ja pagou (veio ${recusa.status})`);
  checar(corpo.error === 'PEDIDO_JA_PAGO', 'com o motivo certo');
}

/* -------------------------------------------------------------------------- */
console.log('\n== 7. Telefone que nao da para chamar ==\n');

const semTelefone = await fetch(`${base}/api/orders`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    offer: 'main',
    bumps: [],
    customer: {
      name: 'Sem Telefone Bom',
      email: 'sem-telefone@exemplo.com',
      phone: '999',
      document: REMOTO ? '11144477735' : '52998224725',
    },
  }),
}).then((r) => r.json());

if (semTelefone.success) {
  const recusa = await fetch(`${base}/api/admin/pedidos/${semTelefone.data.id}/whatsapp`, {
    method: 'POST',
    headers: cabecalhos,
  });
  const corpo = await recusa.json();
  checar(recusa.status === 400, `recusa telefone curto demais (veio ${recusa.status})`);
  checar(corpo.error === 'TELEFONE_INVALIDO', 'dizendo qual e o problema, para o dono corrigir');
} else {
  console.log('  (pulado: o checkout recusou o telefone curto antes de criar o pedido)');
}

/* ========================================================================== */

console.log(tudoOk ? '\nTODOS OS TESTES PASSARAM\n' : '\nHOUVE FALHAS\n');
encerrar(tudoOk ? 0 : 1);
