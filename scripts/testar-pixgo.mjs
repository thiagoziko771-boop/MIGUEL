/**
 * Testa a integração com a PixGo contra um servidor falso que imita a API.
 *
 * Existe porque a PixGo NÃO tem ambiente de teste: toda chave é de produção e
 * toda cobrança criada é dinheiro de verdade. Sem este arquivo, a única forma de
 * conferir o formato da requisição seria cobrando um cliente real.
 *
 * O servidor falso confere o que mandamos (cabeçalho de autenticação, valor em
 * reais, CPF obrigatório) e devolve as respostas documentadas, inclusive o 410
 * dos estados finais. Também assina os callbacks como a PixGo assina, para
 * exercitar a verificação de assinatura de ponta a ponta.
 *
 *   node scripts/testar-pixgo.mjs
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PORTA_FALSA = 3390;
const PORTA_APP = 3336;
const CHAVE = 'pk_chavedeteste';
const SEGREDO = 'whsec_segredodeteste';

let tudoOk = true;
function checar(ok, descricao, extra) {
  console.log(`  ${ok ? 'PASSOU' : 'FALHOU'}  ${descricao}${extra && !ok ? ` -> ${extra}` : ''}`);
  if (!ok) tudoOk = false;
}

/* ------------------------------------------------------------------ falsa -- */

const cobrancas = new Map();
let ultimoPedidoRecebido = null;

const falsa = http.createServer((req, res) => {
  let corpo = '';
  req.on('data', (p) => (corpo += p));
  req.on('end', () => {
    const responder = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    // A PixGo autentica por X-API-Key. Sem ela, 401.
    if (req.headers['x-api-key'] !== CHAVE) {
      responder(401, { success: false, error: 'UNAUTHORIZED', message: 'Chave invalida' });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/v1/payment/create') {
      let dados;
      try {
        dados = JSON.parse(corpo);
      } catch {
        responder(400, { success: false, error: 'INVALID_JSON' });
        return;
      }
      ultimoPedidoRecebido = dados;

      // Regras que a documentação define como obrigatórias.
      if (typeof dados.amount !== 'number' || dados.amount < 10) {
        responder(400, { success: false, error: 'INVALID_AMOUNT', message: 'Minimo R$ 10,00' });
        return;
      }
      /*
       * Regra real da PixGo, descoberta em producao: se receiver_phone vier e
       * nao for celular com 9 apos o DDD, ela recusa a COBRANCA INTEIRA -- por
       * um campo opcional. Reproduzida aqui com o mesmo formato de resposta,
       * com o campo dentro de `errors`.
       */
      if (dados.receiver_phone !== undefined) {
        const fone = String(dados.receiver_phone);
        if (fone.length !== 11 || fone[2] !== '9') {
          responder(400, {
            success: false,
            error: 'VALIDATION_ERROR',
            message: 'Dados invalidos fornecidos',
            errors: { receiver_phone: 'Celular deve comecar com 9 apos o DDD' },
          });
          return;
        }
      }
      if (!dados.receiver_cpf || !/^\d{11}$|^\d{14}$/.test(String(dados.receiver_cpf))) {
        responder(400, { success: false, error: 'CPF_REQUIRED', message: 'receiver_cpf obrigatorio' });
        return;
      }

      const id = `dep_${crypto.randomBytes(8).toString('hex')}`;
      cobrancas.set(id, { status: 'pending', amount: dados.amount, external_id: dados.external_id });
      responder(201, {
        success: true,
        data: {
          payment_id: id,
          external_id: dados.external_id,
          amount: dados.amount,
          status: 'pending',
          qr_code: '00020126580014BR.GOV.BCB.PIX-FALSO-' + id,
          qr_image_url: `https://pixgo.org/qr/${id}.png`,
          expires_at: '2026-08-06T23:59:00',
          created_at: '2026-08-06T12:00:00',
        },
      });
      return;
    }

    const casaStatus = req.url.match(/^\/api\/v1\/payment\/([^/]+?)(?:\/status)?$/);
    if (req.method === 'GET' && casaStatus) {
      const id = decodeURIComponent(casaStatus[1]);
      const cobranca = cobrancas.get(id);
      if (!cobranca) {
        // Texto e codigo iguais aos da PixGo de verdade: e' o que ela responde
        // depois de apagar uma cobranca vencida.
        responder(404, {
          success: false,
          error: 'PAYMENT_NOT_FOUND',
          message:
            'Pagamento nao encontrado. Este endpoint espera o payment_id devolvido na criacao. ' +
            'Se voce tem apenas o external_id que enviou, use GET /api/v1/payments?external_id=',
        });
        return;
      }
      // Estados finais respondem 410 com o mesmo corpo do 200.
      const terminal = ['expired', 'cancelled', 'refunded'].includes(cobranca.status);
      responder(terminal ? 410 : 200, {
        success: true,
        terminal,
        data: {
          payment_id: id,
          external_id: cobranca.external_id,
          amount: cobranca.amount,
          status: cobranca.status,
          customer_cpf: '***.982.247-**',
          payer_euid: null,
          updated_at: '2026-08-06T12:15:30',
        },
      });
      return;
    }

    responder(404, { success: false, error: 'NOT_FOUND' });
  });
});

await new Promise((ok) => falsa.listen(PORTA_FALSA, ok));
console.log(`\nPixGo falsa em http://localhost:${PORTA_FALSA}\n`);

/* -------------------------------------------------------------------- app -- */

/*
 * Se já houver alguém escutando na porta, PARAMOS.
 *
 * Uma sobra de execução anterior responde às requisições no lugar do servidor
 * deste teste — possivelmente apontada para a PixGo de verdade, o que faria a
 * bateria criar cobrança real achando que fala com o servidor falso. Já
 * aconteceu: o sintoma foi um PAYER_BLOCKED vindo de produção no meio do teste.
 */
const portaOcupada = await fetch(`http://127.0.0.1:${PORTA_APP}/api/health`)
  .then(() => true)
  .catch(() => false);
if (portaOcupada) {
  console.log(
    `\n  FALHOU  ja existe um servidor na porta ${PORTA_APP}.\n` +
      '          E sobra de uma execucao anterior; encerre antes de rodar de novo,\n' +
      '          senao o teste mede o servidor errado.\n',
  );
  await new Promise((ok) => falsa.close(ok));
  process.exit(1);
}

const dataDir = mkdtempSync(path.join(tmpdir(), 'pixgo-teste-'));

/*
 * O servidor roda a partir de uma pasta vazia, de propósito.
 *
 * server/config.ts carrega o .env.local do diretório atual com `override: true`,
 * o que faz o arquivo GANHAR das variáveis passadas aqui. Rodando na raiz do
 * projeto, o PIXGO_BASE_URL do .env.local apontaria o teste para a PixGo de
 * verdade — testes criando cobrança real, silenciosamente. Fora da raiz não há
 * .env.local para carregar, e só o que está abaixo vale.
 */
const raiz = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const app = spawn(
  'npx',
  ['tsx', path.join(raiz, 'server', 'index.ts')],
  {
    cwd: dataDir,
    // shell no Windows: desde o Node 20, spawn recusa .cmd sem ele (EINVAL).
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      PIX_MODE: 'live',
      PIXGO_API_KEY: CHAVE,
      PIXGO_WEBHOOK_SECRET: SEGREDO,
      PIXGO_BASE_URL: `http://localhost:${PORTA_FALSA}/api/v1`,
      PORT: String(PORTA_APP),
      DATA_DIR: dataDir,
      DATABASE_URL: '',
      LOG_LEVEL: 'warn',
      // Sem intervalo entre consultas: em produção ele existe para não martelar
      // a API (limite de 1.000 por dia), mas aqui seguraria a reconsulta que
      // este teste precisa exercitar.
      STATUS_POLL_MIN_INTERVAL_MS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
// Só o que indica defeito. Os avisos de configuração são esperados aqui (não há
// banco nem senha de painel neste teste) e só abafariam o resultado.
app.stderr.on('data', (d) => {
  const linha = String(d);
  if (/ERROR|Uncaught|TypeError|ReferenceError|throw/.test(linha)) process.stderr.write('[app] ' + linha);
});

// 127.0.0.1 em vez de localhost: no Windows o nome resolve para ::1 primeiro, e
// o servidor escuta em IPv4 — a diferença aparece como ECONNREFUSED enganoso.
const base = `http://127.0.0.1:${PORTA_APP}`;

let subiu = false;
for (let tentativa = 0; tentativa < 60; tentativa += 1) {
  if (app.exitCode !== null) break;
  try {
    const r = await fetch(`${base}/api/health`);
    if (r.ok) {
      subiu = true;
      break;
    }
  } catch {
    /* ainda subindo */
  }
  await new Promise((ok) => setTimeout(ok, 500));
}

/**
 * Encerra a árvore de processos.
 *
 * No Windows o spawn com `shell: true` cria um cmd.exe que por sua vez roda o
 * node: matar só o pai deixa o filho vivo segurando a porta, e a rodada seguinte
 * do teste esbarra nele — foi o que fazia este teste falhar de forma
 * intermitente, sempre culpando o código errado.
 */
async function encerrar(codigo) {
  if (app.pid) {
    if (process.platform === 'win32') {
      const { spawnSync } = await import('node:child_process');
      spawnSync('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      app.kill('SIGTERM');
    }
  }
  await new Promise((ok) => falsa.close(ok));
  process.exit(codigo);
}

if (!subiu) {
  console.log(
    '\n  FALHOU  o servidor de teste nao subiu.\n' +
      `          Confira se a porta ${PORTA_APP} esta livre (sobra de uma rodada anterior).\n`,
  );
  await encerrar(1);
}

/**
 * Envia um callback e confere que o servidor continuou de pé.
 *
 * `Connection: close` evita reaproveitar socket: disparando vários POSTs em
 * sequência, o cliente do Node às vezes pega uma conexão que o servidor já
 * fechou e devolve ECONNRESET — o que pareceria queda do servidor sem ser.
 * Como o teste precisa distinguir "recusou" de "caiu", cada chamada usa conexão
 * nova e a saúde é conferida logo depois.
 */
async function enviarCallback(corpo, cabecalhos) {
  let status = 0;
  try {
    const resposta = await fetch(`${base}/api/webhooks/pix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Connection: 'close', ...cabecalhos },
      body: corpo,
    });
    status = resposta.status;
  } catch (erro) {
    status = -1;
    console.log(`    (falha de rede: ${erro.cause?.code ?? erro.message})`);
  }
  const vivo = await fetch(`${base}/api/health`)
    .then((r) => r.ok)
    .catch(() => false);
  return { status, vivo };
}

/* ------------------------------------------------------------------ casos -- */

const cliente = {
  name: 'Teste PixGo',
  email: 'teste@exemplo.com',
  phone: '71999999999',
  document: '52998224725',
};

// 1. Criação da cobrança: o que sai daqui precisa casar com a documentação.
const criacao = await fetch(`${base}/api/orders`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ offer: 'main', bumps: [], customer: cliente }),
}).then((r) => r.json());

checar(criacao.success === true, 'cria a cobranca na PixGo', JSON.stringify(criacao).slice(0, 200));

const pedido = criacao.data ?? {};
checar(Boolean(pedido.pix?.code), 'devolve o copia e cola para a tela');

const enviado = ultimoPedidoRecebido ?? {};
checar(enviado.amount === 47, `manda o valor em REAIS, nao centavos (enviado: ${enviado.amount})`);
checar(enviado.receiver_cpf === '52998224725', 'manda o CPF de quem vai pagar, so digitos');
checar(enviado.receiver_phone === '71999999999', 'manda o telefone so com digitos');
checar(
  typeof enviado.external_id === 'string' && enviado.external_id.length <= 50,
  'manda nosso id de pedido dentro do limite de 50 caracteres',
);
checar((enviado.description ?? '').length <= 200, 'respeita o limite da descricao');

// 2. Valor abaixo do minimo da PixGo tem de ser barrado por nos, antes da API.
const barrado = await fetch(`${base}/api/orders`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ offer: 'downsell', bumps: [], customer: cliente }),
}).then((r) => r.json());
checar(
  barrado.success === false,
  'pedido abaixo do minimo nao vira cobranca (downsell exige pedido pai, entao recusa antes)',
);

// 3. Webhook com assinatura valida: confirma o pagamento.
const idCobranca = Object.keys(Object.fromEntries(cobrancas)).at(-1);
cobrancas.get(idCobranca).status = 'completed';

/*
 * Assina com a CHAVE DA API, e nao com o whsec_. As duas documentacoes da PixGo
 * se contradizem sobre isso, e o nosso servidor precisa aceitar os dois -- e o
 * caso da chave que este teste exercita, por ser o que a versao mais recente
 * da documentacao manda usar nos tres exemplos de codigo.
 */
function assinar(corpo, carimbo) {
  return crypto.createHmac('sha256', CHAVE).update(`${carimbo}.${corpo}`).digest('hex');
}

/** Assinatura com o outro segredo possivel, que tambem precisa ser aceita. */
function assinarComSegredo(corpo, carimbo) {
  return crypto.createHmac('sha256', SEGREDO).update(`${carimbo}.${corpo}`).digest('hex');
}

const corpoWebhook = JSON.stringify({
  event: 'payment.completed',
  timestamp: new Date().toISOString(),
  data: { payment_id: idCobranca, external_id: pedido.id, status: 'completed', amount: 47 },
});
const agora = Math.floor(Date.now() / 1000);

const okWebhook = await enviarCallback(corpoWebhook, {
  'X-Webhook-Event': 'payment.completed',
  'X-Webhook-Timestamp': String(agora),
  'X-Webhook-Signature': assinar(corpoWebhook, agora),
});
checar(okWebhook.status === 200, `callback assinado e aceito (status ${okWebhook.status})`);

const depois = await fetch(`${base}/api/orders/${pedido.id}`).then((r) => r.json());
checar(depois?.data?.status === 'completed', `o pedido fica pago (status: ${depois?.data?.status})`);

// 3b. A outra documentacao manda assinar com o whsec_. Os dois precisam passar,
// porque errar o segredo significaria recusar todo callback legitimo.
{
  const corpoB = JSON.stringify({
    event: 'payment.completed',
    payment_id: idCobranca,
    external_id: pedido.id,
    status: 'completed',
  });
  const t = Math.floor(Date.now() / 1000);
  const r = await enviarCallback(corpoB, {
    'X-Webhook-Timestamp': String(t),
    'X-Webhook-Signature': assinarComSegredo(corpoB, t),
  });
  checar(r.status === 200, `callback assinado com o whsec_ tambem e aceito (status ${r.status})`);
}

// 3c. order.created nao confirma nada e nao pode gastar consulta do teto diario.
{
  const corpoC = JSON.stringify({
    event: 'order.created',
    payment_id: idCobranca,
    external_id: pedido.id,
    status: 'pending',
  });
  const t = Math.floor(Date.now() / 1000);
  const r = await enviarCallback(corpoC, {
    'X-Webhook-Event': 'order.created',
    'X-Webhook-Timestamp': String(t),
    'X-Webhook-Signature': assinar(corpoC, t),
  });
  checar(r.status === 200, `order.created e aceito e ignorado (status ${r.status})`);
  checar(r.vivo, 'o servidor segue de pe depois do order.created');
}

// 3d. O payload novo vem PLANO, com payment_id na raiz em vez de dentro de data.
// Se o identificador nao for achado ali, nenhuma venda se confirma.
{
  const corpoD = JSON.stringify({
    event: 'payment.completed',
    payment_id: idCobranca,
    external_id: pedido.id,
    amount: 47,
    customer: { name: 'Maria', cpf: '52998224725' },
    amounts: { gross: 47, net: 45.3 },
  });
  const t = Math.floor(Date.now() / 1000);
  const r = await enviarCallback(corpoD, {
    'X-Webhook-Timestamp': String(t),
    'X-Webhook-Signature': assinar(corpoD, t),
  });
  checar(r.status === 200, `payload plano (payment_id na raiz) e entendido (status ${r.status})`);
}

// 4. Assinatura errada: recusa.
const ruim = await enviarCallback(corpoWebhook, {
  'X-Webhook-Timestamp': String(agora),
  'X-Webhook-Signature': 'f'.repeat(64),
});
checar(ruim.status === 401, `callback com assinatura errada e recusado (status ${ruim.status})`);
checar(ruim.vivo, 'o servidor segue de pe depois da assinatura errada');

// 5. Assinatura truncada nao pode derrubar o processo (timingSafeEqual lanca
//    quando os tamanhos diferem; e o defeito do exemplo da documentacao).
const curta = await enviarCallback(corpoWebhook, {
  'X-Webhook-Timestamp': String(agora),
  'X-Webhook-Signature': 'abcd',
});
checar(curta.status === 401, `assinatura truncada e recusada (status ${curta.status})`);
checar(curta.vivo, 'o servidor segue de pe depois da assinatura truncada');

// Assinatura que nem hexadecimal e: Buffer.from devolve vazio, e o tamanho
// diferente precisa recusar em vez de estourar.
const naoHex = await enviarCallback(corpoWebhook, {
  'X-Webhook-Timestamp': String(agora),
  'X-Webhook-Signature': 'zzzz',
});
checar(naoHex.status === 401, `assinatura nao-hexadecimal e recusada (status ${naoHex.status})`);
checar(naoHex.vivo, 'o servidor segue de pe depois da assinatura nao-hexadecimal');

// 6. Carimbo velho: recusa (protecao contra reenvio).
const velho = agora - 3600;
const antigo = await enviarCallback(corpoWebhook, {
  'X-Webhook-Timestamp': String(velho),
  'X-Webhook-Signature': assinar(corpoWebhook, velho),
});
checar(antigo.status === 401, `callback com carimbo velho e recusado (status ${antigo.status})`);
checar(antigo.vivo, 'o servidor segue de pe depois do carimbo velho');

// 7. O 410 dos estados finais e resposta valida, nao erro.
const outra = await fetch(`${base}/api/orders`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ offer: 'main', bumps: [], customer: { ...cliente, document: '11144477735' } }),
}).then((r) => r.json());
const idOutra = Object.keys(Object.fromEntries(cobrancas)).at(-1);
cobrancas.get(idOutra).status = 'expired';
const consultado = await fetch(`${base}/api/orders/${outra.data.id}`).then((r) => r.json());
checar(
  consultado.success === true && consultado.data.status === 'expired',
  `410 da PixGo e lido como estado final, nao como falha (status: ${consultado?.data?.status})`,
);

/*
 * 7b. Cobranca vencida que a PixGo JA APAGOU vira pedido expirado.
 *
 * Depois do prazo a PixGo remove o registro e passa a responder 404
 * PAYMENT_NOT_FOUND. Antes esse 404 caia no catch generico e o pedido ficava
 * pendente PARA SEMPRE, voltando a consultar a cada 25 s. O estrago nao e' o
 * relatorio errado: e' o orcamento diario de consultas sendo queimado por
 * pedidos zumbis ate faltar consulta para confirmar quem pagou de verdade.
 */
const sumida = await fetch(`${base}/api/orders`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ offer: 'main', bumps: [], customer: { ...cliente, document: '11144477735' } }),
}).then((r) => r.json());

const idSumida = [...cobrancas.keys()].at(-1);
cobrancas.delete(idSumida); // a PixGo apagou a cobranca vencida

const depoisDeSumir = await fetch(`${base}/api/orders/${sumida.data.id}`).then((r) => r.json());
checar(
  depoisDeSumir.data?.status === 'expired',
  `cobranca apagada pelo gateway vira expirada, nao pendente eterna (veio ${depoisDeSumir.data?.status})`,
);

/*
 * 7c. Telefone que a PixGo nao aceita NAO pode derrubar a venda.
 *
 * Aconteceu em producao em 08/08/2026: cliente digitou "(89) 66452-2210",
 * um numero sem o 9 depois do DDD. A PixGo recusou a cobranca inteira por causa
 * desse campo -- que e OPCIONAL -- e a mensagem que aparecia na tela mandava
 * conferir o CPF, que estava correto. O cliente tentou quatro vezes e desistiu.
 *
 * Agora o telefone so e enviado quando e um celular valido; caso contrario,
 * fica so no nosso banco, onde serve para falar com o cliente.
 */
const semNove = await fetch(`${base}/api/orders`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    offer: 'main',
    bumps: [],
    customer: { ...cliente, document: '52998224725', phone: '8966452210' },
  }),
}).then((r) => r.json());

checar(
  semNove.success === true,
  `telefone sem o 9 nao derruba a cobranca (${semNove.error ?? 'cobranca criada'})`,
);
checar(
  ultimoPedidoRecebido?.receiver_phone === undefined,
  'telefone invalido nao e enviado ao gateway',
);

// Celular valido continua indo: a trava nao pode cortar quem esta certo.
await fetch(`${base}/api/orders`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    offer: 'main',
    bumps: [],
    customer: { ...cliente, document: '11144477735', phone: '11912345678' },
  }),
}).then((r) => r.json());
checar(
  ultimoPedidoRecebido?.receiver_phone === '11912345678',
  `celular valido continua sendo enviado (veio ${ultimoPedidoRecebido?.receiver_phone})`,
);

// 8. Servidor no ar e saudavel depois de tudo.
const saude = await fetch(`${base}/api/health`).then((r) => r.json());
checar(saude?.data?.mode === 'live', 'o servidor seguiu em modo live o teste inteiro');

console.log(`\n${tudoOk ? 'TODOS OS TESTES PASSARAM' : 'ALGUM TESTE FALHOU'}\n`);
await encerrar(tudoOk ? 0 : 1);
