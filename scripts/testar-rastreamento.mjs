/**
 * Testa o rastreamento do Meta de ponta a ponta, sem tocar em dinheiro nem
 * falar com o Facebook de verdade.
 *
 * Sobem dois dublês locais: uma PixGo falsa (para o pedido nascer e ser
 * confirmado) e um Meta falso (para conferir exatamente o que sai daqui). O
 * Meta não tem ambiente de teste utilizável para isto: o código "Testar
 * eventos" mostra o que chega, mas não deixa afirmar nada num teste automático.
 *
 *   node scripts/testar-rastreamento.mjs
 *
 * O que cada caso protege está escrito junto dele. Todos nasceram de erro que
 * custa dinheiro de verdade: valor em centavos vira faturamento cem vezes
 * maior, evento duplicado ensina o robô a mirar no público errado, e uma falha
 * de rastreamento que derrube o checkout tira a venda inteira.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PORTA_PIXGO = 3391;
const PORTA_META = 3392;
const PORTA_APP = 3337;
const PORTA_PLANILHA = 3393;
const CHAVE_PIX = 'pk_chavedeteste';
const SEGREDO_PIX = 'whsec_segredodeteste';
const PIXEL = '123456789012345';
const TOKEN_META = 'EAAtokendeteste';

const raiz = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '..',
);

let tudoOk = true;
function checar(ok, descricao, extra) {
  console.log(`  ${ok ? 'PASSOU' : 'FALHOU'}  ${descricao}${extra && !ok ? ` -> ${extra}` : ''}`);
  if (!ok) tudoOk = false;
}

const sha256 = (texto) => crypto.createHash('sha256').update(texto, 'utf8').digest('hex');
const ehHash = (valor) => typeof valor === 'string' && /^[a-f0-9]{64}$/.test(valor);

/* ========================================================================== */
/* PARTE 1 — o carimbo no navegador, sem servidor nenhum                       */
/* ========================================================================== */

/*
 * A captura de origem roda no navegador e depende de `window`, `document` e
 * `localStorage`. Em vez de subir um Chromium só para isso, damos ao módulo um
 * ambiente mínimo e conferimos o comportamento direto.
 *
 * O primeiro caso é o mais importante da bateria: abrir a página SEM parâmetro
 * nenhum é o que 100% dos visitantes diretos fazem, e foi exatamente o caso sem
 * teste que já quebrou o funil uma vez (`URLSearchParams.get()` devolve null, e
 * `Number(null)` é 0, não NaN).
 */
console.log('\n== Carimbo de origem no navegador ==\n');

const pastaTemp = mkdtempSync(path.join(tmpdir(), 'rastreio-teste-'));
const arquivoDoTeste = path.join(pastaTemp, 'atribuicao.test.mts');

writeFileSync(
  arquivoDoTeste,
  `
// file:// e obrigatorio: no Windows um caminho absoluto cru ("c:\\...") nao e
// um especificador ESM valido, e o import falha antes de rodar qualquer caso.
import { capturarAtribuicao, getAttribution } from ${JSON.stringify(pathToFileURL(path.join(raiz, 'src/lib/attribution.ts')).href)};

const resultados: Array<[boolean, string]> = [];
const checar = (ok: boolean, descricao: string) => resultados.push([ok, descricao]);

const guardado = new Map<string, string>();
const daSessao = new Map<string, string>();
let cookies = '';

function montarAmbiente(url: string) {
  (globalThis as any).window = {
    location: { search: new URL(url).search, href: url },
    localStorage: {
      getItem: (c: string) => guardado.get(c) ?? null,
      setItem: (c: string, v: string) => void guardado.set(c, v),
      removeItem: (c: string) => void guardado.delete(c),
    },
    sessionStorage: {
      getItem: (c: string) => daSessao.get(c) ?? null,
      setItem: (c: string, v: string) => void daSessao.set(c, v),
    },
  };
  (globalThis as any).document = {
    referrer: '',
    get cookie() { return cookies; },
    // Como no navegador: gravar um cookie de nome já existente SUBSTITUI o valor.
    set cookie(valor: string) {
      const par = valor.split(';')[0];
      const nome = par.split('=')[0];
      const outros = cookies.split('; ').filter((c) => c && !c.startsWith(nome + '='));
      cookies = [...outros, par].join('; ');
    },
  };
}

// 1. Sem parâmetro nenhum: não quebra e não inventa origem.
montarAmbiente('https://rezassagradas.com.br/');
let atual = capturarAtribuicao();
checar(atual.fbclid === undefined && atual.utm_source === undefined, 'URL sem parametro nenhum nao inventa origem');
checar(atual.landing_url === 'https://rezassagradas.com.br/', 'guarda a pagina de entrada');

// 2. Clique do Facebook: carimba e monta o _fbc na mão.
montarAmbiente('https://rezassagradas.com.br/?utm_source=facebook&utm_campaign=RS_frio&fb_ad_id=987&fbclid=ABC123');
atual = capturarAtribuicao();
checar(atual.fb_ad_id === '987' && atual.utm_campaign === 'RS_frio', 'guarda o carimbo do anuncio');
checar(/^fb\\.1\\.\\d+\\.ABC123$/.test(atual.fbc ?? ''), 'monta o _fbc no formato fb.1.<ms>.<fbclid>');

// 3. Volta direta, sem parâmetro: NÃO apaga a origem paga.
montarAmbiente('https://rezassagradas.com.br/');
atual = capturarAtribuicao();
checar(atual.fb_ad_id === '987', 'visita direta depois nao apaga a origem do anuncio');

// 4. Clique novo em outro anúncio: o último clique pago vence.
montarAmbiente('https://rezassagradas.com.br/?fbclid=XYZ789&fb_ad_id=555');
atual = capturarAtribuicao();
checar(atual.fb_ad_id === '555', 'clique pago novo sobrescreve o anterior');

// 5. Valor gigante na URL não entra inteiro no banco — mas um fbclid REAL,
//    que hoje passa de 200 caracteres, tem que chegar inteiro: cortado, o
//    '_fbc' fica inválido e a compra perde o clique (15/08/2026).
montarAmbiente('https://rezassagradas.com.br/?fbclid=' + 'x'.repeat(900) + '&fb_ad_id=1&utm_campaign=' + 'y'.repeat(900));
atual = capturarAtribuicao();
checar((atual.fbclid ?? '').length <= 500, 'corta valor gigante vindo da URL (fbclid ate 500)');
checar((atual.utm_campaign ?? '').length <= 200, 'corta valor gigante vindo da URL (demais campos ate 200)');
montarAmbiente('https://rezassagradas.com.br/?fbclid=' + 'IwZXh0bgNhZW0'.repeat(23) + '&fb_ad_id=2');
atual = capturarAtribuicao();
checar((atual.fbclid ?? '').length === 299, 'fbclid longo de verdade (299) chega inteiro');
checar((atual.fbc ?? '').endsWith('IwZXh0bgNhZW0'.repeat(23)), 'o _fbc montado carrega o fbclid inteiro');

// 6. Formato "nome|id" da UTMify: o ID nao pode se perder.
montarAmbiente('https://rezassagradas.com.br/?utm_source=facebook&utm_campaign=RS_frio|120210000001&utm_medium=conjunto_A|120310000001&utm_content=criativo_02|120410000001&fbclid=PACOTE1');
atual = capturarAtribuicao();
checar(atual.fb_campaign_id === '120210000001', 'desempacota o id da campanha do formato nome|id');
checar(atual.fb_adset_id === '120310000001', 'desempacota o id do conjunto');
checar(atual.fb_ad_id === '120410000001', 'desempacota o id do anuncio');
checar(atual.utm_campaign === 'RS_frio', 'guarda o nome limpo, sem o id grudado');

// 7. Nome com "|" e sem id numerico continua sendo nome, nao vira identificador.
montarAmbiente('https://rezassagradas.com.br/?utm_campaign=Promo | Julho&fbclid=PACOTE2');
atual = capturarAtribuicao();
checar(atual.utm_campaign === 'Promo | Julho', 'nome com barra vertical nao vira id');
checar(atual.fb_campaign_id === undefined, 'nao inventa id a partir de texto');

// 8. Storage bloqueado (aba privada) não pode derrubar a pagina.
montarAmbiente('https://rezassagradas.com.br/?fbclid=BLOQ');
(globalThis as any).window.localStorage.setItem = () => { throw new Error('storage bloqueado'); };
let sobreviveu = true;
try { capturarAtribuicao(); getAttribution(); } catch { sobreviveu = false; }
checar(sobreviveu, 'storage bloqueado nao derruba a captura');

console.log(JSON.stringify(resultados));
`,
  'utf8',
);

const navegador = spawnSync('npx', ['tsx', arquivoDoTeste], {
  cwd: raiz,
  shell: process.platform === 'win32',
  encoding: 'utf8',
});

try {
  const saida = (navegador.stdout ?? '').trim().split('\n').at(-1);
  for (const [ok, descricao] of JSON.parse(saida)) checar(ok, descricao);
} catch {
  checar(false, 'a bateria do navegador rodou', (navegador.stderr ?? '').slice(0, 300));
}

/* ========================================================================== */
/* PARTE 1b — leitura da planilha de investimento                              */
/* ========================================================================== */

/*
 * O risco aqui não é falhar, é acertar o formato errado calado. "1.234" vale
 * mil duzentos e trinta e quatro numa planilha brasileira e um vírgula duzentos
 * e trinta e quatro numa americana — errar por mil vezes faz um anúncio
 * lucrativo parecer prejuízo, e ninguém desconfia de um número plausível.
 */
console.log('\n== Planilha de investimento ==\n');

const arquivoPlanilha = path.join(pastaTemp, 'planilha.test.mts');
const moduloInvestimento = pathToFileURL(path.join(raiz, 'server/investimento.ts')).href;

writeFileSync(
  arquivoPlanilha,
  `
import { paraCentavos, paraDia, interpretarCsv, conferirEndereco } from ${JSON.stringify(moduloInvestimento)};

const resultados: Array<[boolean, string]> = [];
const checar = (ok: boolean, descricao: string) => resultados.push([ok, descricao]);

// Dinheiro, nos formatos que aparecem de verdade.
checar(paraCentavos('12.34') === 1234, 'le 12.34 como doze reais e trinta e quatro');
checar(paraCentavos('12,34') === 1234, 'le 12,34 (decimal brasileiro)');
checar(paraCentavos('R$ 12,34') === 1234, 'ignora o R$ e o espaco');
checar(paraCentavos('1.234,56') === 123456, 'le 1.234,56 (milhar brasileiro)');
checar(paraCentavos('1,234.56') === 123456, 'le 1,234.56 (milhar americano)');
checar(paraCentavos('1.234') === 123400, 'le 1.234 como milhar, nao como um virgula dois');
checar(paraCentavos('0') === 0, 'aceita zero');
checar(paraCentavos('') === null, 'campo vazio nao vira zero');
checar(paraCentavos('-') === null, 'traco nao vira zero');
checar(paraCentavos('abc') === null, 'texto nao vira numero');

// Datas.
checar(paraDia('2026-08-08') === '2026-08-08', 'le data ISO');
checar(paraDia('08/08/2026') === '2026-08-08', 'le data brasileira');
checar(paraDia('ontem') === null, 'data que nao entende e recusada');

// CSV com ponto e virgula, aspas e nome com virgula dentro.
const csvBr = [
  'Data;Nome da campanha;ID da campanha;Valor gasto',
  '08/08/2026;"Frio, video 01";120210000001;"1.234,56"',
  '08/08/2026;Remarketing;120210000003;89,90',
].join('\\n');

const lido = interpretarCsv(csvBr);
checar(lido.linhas.length === 2, 'le as duas linhas do CSV com ponto e virgula');
checar(lido.linhas[0].centavos === 123456, 'nome com virgula dentro de aspas nao desloca as colunas');
checar(lido.linhas[0].chave === '120210000001', 'pega o id da campanha');
checar(lido.linhas[0].nome === 'Frio, video 01', 'preserva o nome com virgula');

// Mesma campanha em varias linhas no mesmo dia: soma, nao sobrescreve.
const csvRepetido = [
  'date,campaign_id,spend',
  '2026-08-08,120,10.00',
  '2026-08-08,120,5.50',
].join('\\n');
const somado = interpretarCsv(csvRepetido);
checar(somado.linhas.length === 1 && somado.linhas[0].centavos === 1550, 'soma linhas repetidas do mesmo dia');

// Linha ruim nao derruba a importacao inteira, mas aparece no relatorio.
const csvSujo = [
  'date,campaign_id,spend',
  '2026-08-08,120,10.00',
  'sem data,121,9.99',
].join('\\n');
const sujo = interpretarCsv(csvSujo);
checar(sujo.linhas.length === 1, 'linha ruim nao derruba as boas');
checar(sujo.ignoradas.length === 1, 'linha ruim e relatada, nao engolida');

// Planilha sem as colunas necessarias precisa dizer o que faltou.
let mensagem = '';
try { interpretarCsv('a,b\\n1,2'); } catch (erro) { mensagem = (erro as Error).message; }
checar(mensagem.includes('data') && mensagem.includes('valor gasto'), 'diz quais colunas faltaram');

// O servidor e quem busca a URL: sem trava, o painel viraria porta para sondar
// a rede interna de onde ele roda.
const recusa = (url: string) => { try { conferirEndereco(url); return false; } catch { return true; } };
checar(recusa('http://localhost:3333/api/health'), 'recusa endereco interno');
checar(recusa('https://exemplo.com/planilha.csv'), 'recusa host fora do Google');
checar(recusa('http://docs.google.com/x'), 'recusa http sem TLS');
checar(!recusa('https://docs.google.com/spreadsheets/d/e/x/pub?output=csv'), 'aceita planilha publicada do Google');

console.log(JSON.stringify(resultados));
`,
  'utf8',
);

const planilha = spawnSync('npx', ['tsx', arquivoPlanilha], {
  cwd: raiz,
  shell: process.platform === 'win32',
  encoding: 'utf8',
});

try {
  const saida = (planilha.stdout ?? '').trim().split('\n').at(-1);
  for (const [ok, descricao] of JSON.parse(saida)) checar(ok, descricao);
} catch {
  checar(false, 'a bateria da planilha rodou', (planilha.stderr ?? '').slice(0, 300));
}

/* ========================================================================== */
/* Dublês                                                                      */
/* ========================================================================== */

const cobrancas = new Map();

const pixgoFalsa = http.createServer((req, res) => {
  let corpo = '';
  req.on('data', (p) => (corpo += p));
  req.on('end', () => {
    const responder = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.headers['x-api-key'] !== CHAVE_PIX) {
      responder(401, { success: false, error: 'UNAUTHORIZED' });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/v1/payment/create') {
      const dados = JSON.parse(corpo);
      const id = `dep_${crypto.randomBytes(8).toString('hex')}`;
      cobrancas.set(id, { status: 'pending', amount: dados.amount, external_id: dados.external_id });
      responder(201, {
        success: true,
        data: {
          payment_id: id,
          external_id: dados.external_id,
          amount: dados.amount,
          status: 'pending',
          qr_code: '00020126-FALSO-' + id,
          expires_at: '2026-12-31T23:59:00',
        },
      });
      return;
    }

    const casa = req.url.match(/^\/api\/v1\/payment\/([^/?]+?)(?:\/status)?$/);
    if (req.method === 'GET' && casa) {
      const cobranca = cobrancas.get(decodeURIComponent(casa[1]));
      if (!cobranca) {
        responder(404, { success: false, error: 'NOT_FOUND' });
        return;
      }
      responder(200, { success: true, data: { payment_id: casa[1], status: cobranca.status, amount: cobranca.amount } });
      return;
    }

    responder(404, { success: false, error: 'NOT_FOUND' });
  });
});

/** Tudo que o servidor mandou para o "Facebook". É o que a bateria inspeciona. */
let eventosRecebidos = [];
/** Ligado, o Meta falso responde 500 — para provar que a venda não depende dele. */
let metaForaDoAr = false;

const metaFalso = http.createServer((req, res) => {
  let corpo = '';
  req.on('data', (p) => (corpo += p));
  req.on('end', () => {
    const url = new URL(req.url, `http://localhost:${PORTA_META}`);
    const casa = url.pathname.match(/^\/(v\d+\.\d+)\/(\d+)\/events$/);

    if (req.method !== 'POST' || !casa) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'rota desconhecida' } }));
      return;
    }
    if (metaForaDoAr) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'instabilidade simulada', code: 2 } }));
      return;
    }
    if (url.searchParams.get('access_token') !== TOKEN_META) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'token invalido', code: 190 } }));
      return;
    }

    const recebido = JSON.parse(corpo);

    /*
     * Corpo vazio e RECUSADO, imitando o Meta real de 2026.
     *
     * O Meta de verdade respondia `events_received: 0` para `data: []` — e era
     * nisso que o botao "Testar conexao" do painel se apoiava. Em algum momento
     * a API passou a devolver erro 100 "param data must be non-empty", e o
     * botao virou alarme falso: credencial boa aparecia como recusada (visto em
     * producao em 14/08/2026). O servidor agora TRADUZ essa recusa como
     * conexao confirmada; este duble imita o comportamento novo para a bateria
     * cobrar a traducao — se o mock aceitasse o vazio, o caso passaria sem
     * provar nada.
     */
    if ((recebido.data ?? []).length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: '(#100) param data must be non-empty.', type: 'OAuthException', code: 100 } }));
      return;
    }

    for (const evento of recebido.data ?? []) {
      eventosRecebidos.push({ ...evento, pixelId: casa[2], versao: casa[1], testCode: recebido.test_event_code });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ events_received: (recebido.data ?? []).length, messages: [] }));
  });
});

await new Promise((ok) => pixgoFalsa.listen(PORTA_PIXGO, ok));
await new Promise((ok) => metaFalso.listen(PORTA_META, ok));

/* ========================================================================== */
/* Servidor sob teste                                                          */
/* ========================================================================== */

let app = null;

/*
 * O servidor roda a partir de uma PASTA VAZIA, de propósito.
 *
 * server/config.ts carrega o .env.local do diretório atual com `override: true`,
 * então o arquivo ganharia das variáveis passadas aqui: rodando na raiz, este
 * teste falaria com a PixGo de verdade e com o Pixel de verdade — criando
 * cobrança real e sujando os dados da conta de anúncios.
 */
async function subirApp(extras) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'rastreio-app-'));
  const processo = spawn('npx', ['tsx', path.join(raiz, 'server', 'index.ts')], {
    cwd: dataDir,
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      PIX_MODE: 'live',
      PIXGO_API_KEY: CHAVE_PIX,
      PIXGO_WEBHOOK_SECRET: SEGREDO_PIX,
      PIXGO_BASE_URL: `http://localhost:${PORTA_PIXGO}/api/v1`,
      META_PIXEL_ID: PIXEL,
      META_CAPI_TOKEN: TOKEN_META,
      META_BASE_URL: `http://localhost:${PORTA_META}`,
      META_API_VERSION: 'v25.0',
      META_TEST_EVENT_CODE: '',
      PORT: String(PORTA_APP),
      DATA_DIR: dataDir,
      DATABASE_URL: '',
      LOG_LEVEL: 'warn',
      STATUS_POLL_MIN_INTERVAL_MS: '0',
      ...extras,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  processo.stderr.on('data', (d) => {
    const linha = String(d);
    if (/Uncaught|TypeError|ReferenceError/.test(linha)) process.stderr.write('[app] ' + linha);
  });

  for (let tentativa = 0; tentativa < 60; tentativa += 1) {
    if (processo.exitCode !== null) break;
    try {
      const r = await fetch(`http://127.0.0.1:${PORTA_APP}/api/health`);
      if (r.ok) return processo;
    } catch {
      /* ainda subindo */
    }
    await new Promise((ok) => setTimeout(ok, 500));
  }
  return processo;
}

/** No Windows, matar só o pai deixa o filho vivo segurando a porta. */
function derrubar(processo) {
  if (!processo?.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(processo.pid), '/T', '/F'], { stdio: 'ignore' });
  else processo.kill('SIGTERM');
}

async function encerrar(codigo) {
  derrubar(app);
  await new Promise((ok) => pixgoFalsa.close(ok));
  await new Promise((ok) => metaFalso.close(ok));
  await new Promise((ok) => planilhaFalsa.close(ok));
  process.exit(codigo);
}

// Sobra de execução anterior responde no lugar do servidor deste teste.
const portaOcupada = await fetch(`http://127.0.0.1:${PORTA_APP}/api/health`).then(() => true).catch(() => false);
if (portaOcupada) {
  console.log(`\n  FALHOU  ja existe um servidor na porta ${PORTA_APP}. Encerre antes de rodar de novo.\n`);
  await encerrar(1);
}

const base = `http://127.0.0.1:${PORTA_APP}`;
app = await subirApp({});
if (app.exitCode !== null) {
  console.log('\n  FALHOU  o servidor de teste nao subiu.\n');
  await encerrar(1);
}

const esperarEventos = async (quantos, ms = 4000) => {
  const limite = Date.now() + ms;
  while (Date.now() < limite && eventosRecebidos.length < quantos) {
    await new Promise((ok) => setTimeout(ok, 100));
  }
  return eventosRecebidos.length >= quantos;
};

/* ========================================================================== */
/* PARTE 2 — eventos de navegação                                              */
/* ========================================================================== */

console.log('\n== Eventos do funil (POST /api/track) ==\n');

const carimbo = {
  utm_source: 'facebook',
  utm_medium: 'paid',
  utm_campaign: 'RS_frio_video01',
  utm_content: 'RS_criativo_02',
  fb_campaign_id: '120200',
  fb_adset_id: '120300',
  fb_ad_id: '120400',
  fbclid: 'IwAR2xyz',
  fbc: 'fb.1.1754567890123.IwAR2xyz',
  fbp: 'fb.1.1754567890123.1098765432',
};

/*
 * O cabeçalho da Vercel vai em toda chamada, imitando produção.
 *
 * Lá o servidor nunca fala direto com o cliente: quem chega no Express é a
 * borda da CDN. Sem mandar o cabeçalho, o teste enxergaria 127.0.0.1 e passaria
 * com qualquer implementação -- inclusive a que mandava ao Meta o IP do proxy.
 */
const IP_DO_CLIENTE = '187.35.120.44';

async function track(corpo) {
  return fetch(`${base}/api/track`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Connection: 'close',
      'x-vercel-forwarded-for': IP_DO_CLIENTE,
    },
    body: JSON.stringify(corpo),
  });
}

eventosRecebidos = [];
const respostaLead = await track({
  evento: 'Lead',
  event_id: 'evt_teste_lead',
  session_id: 'sessao-1',
  step: 13,
  // Com query de proposito: e ela que precisa ser cortada antes de sair daqui.
  url: 'https://rezassagradas.com.br/?fb_campaign_id=120200&utm_campaign=RS_frio_video01',
  attrib: carimbo,
  contato: { nome: 'Maria Aparecida Silva', email: ' MARIA@Exemplo.COM ', telefone: '11988887777' },
});
checar(respostaLead.status === 204, 'aceita evento da lista branca', String(respostaLead.status));
/*
 * O REPASSE PRECISA ACONTECER, e este caso existe para o dia em que alguem
 * achar que cortar sinal otimiza.
 *
 * Foi tentado em 14/08/2026: os seis eventos de navegacao deixaram de ir ao
 * Meta, com a ideia de limpar o Gerenciador. Desfeito no mesmo dia. Quem decide
 * onde o dinheiro e gasto e o `optimization_goal` do conjunto (aqui, PURCHASE),
 * e ele nunca esteve em disputa com PageView; o que os eventos de navegacao
 * fazem e alimentar o modelo que escolhe A QUEM mostrar o anuncio antes de
 * existir compra. Num pixel de um dia de vida, com verba para ~5 vendas, era
 * justamente o que faltava.
 *
 * Se este caso ficar vermelho, o rastreamento parou de repassar -- e a conta vai
 * sentir dias depois, sem erro nenhum aparecer em lugar nenhum.
 */
checar(await esperarEventos(1), 'repassa o evento de navegacao ao Meta');

const lead = eventosRecebidos[0] ?? {};
checar(lead.event_id === 'evt_teste_lead', 'usa o MESMO event_id do navegador (deduplicacao)');
checar(lead.pixelId === PIXEL && lead.versao === 'v25.0', 'chama o pixel e a versao configurados');
checar(lead.action_source === 'website', 'marca a origem como website');
checar(
  typeof lead.event_source_url === 'string' && !lead.event_source_url.includes('?'),
  `a URL do evento vai sem query string (veio "${lead.event_source_url}")`,
);
checar(
  typeof lead.event_time === 'number' && String(lead.event_time).length === 10,
  `manda event_time em SEGUNDOS (recebido: ${lead.event_time})`,
);
checar(
  lead.user_data?.client_ip_address === IP_DO_CLIENTE,
  `manda o IP do CLIENTE, nao o do proxy (veio "${lead.user_data?.client_ip_address}")`,
);
checar(!lead.custom_data?.value, 'evento de navegacao nao carrega valor em dinheiro');

/*
 * TODO evento sai com `event_source_url` -- inclusive o que chega sem `url` no
 * corpo e sem PUBLIC_BASE_URL no ambiente (que e o caso deste teste). Em
 * 15/08/2026 o Gerenciador de Eventos acusou 7% dos eventos da API sem URL de
 * origem; eram exatamente esses. Sem `url` a rota usa a landing da sessao; sem
 * nada, o endereco fixo do site.
 */
eventosRecebidos = [];
await track({
  evento: 'PageView',
  event_id: 'evt_sem_url_com_landing',
  session_id: 'sessao-2',
  step: 0,
  attrib: { ...carimbo, landing_url: 'https://rezassagradas.site/pedido?fbclid=ABC&utm_source=facebook' },
});
checar(await esperarEventos(1), 'repassa PageView sem url no corpo');
const semUrl = eventosRecebidos[0] ?? {};
checar(
  semUrl.event_source_url === 'https://rezassagradas.site/pedido',
  `sem url no corpo, usa a landing da sessao, limpa (veio "${semUrl.event_source_url}")`,
);
eventosRecebidos = [];
await track({ evento: 'PageView', event_id: 'evt_sem_url_nenhuma', session_id: 'sessao-3', step: 0, attrib: {} });
checar(await esperarEventos(1), 'repassa PageView sem url e sem landing');
const semNada1 = eventosRecebidos[0] ?? {};
checar(
  semNada1.event_source_url === 'https://rezassagradas.site/',
  `sem url nem landing nem PUBLIC_BASE_URL, cai no endereco fixo do site (veio "${semNada1.event_source_url}")`,
);
eventosRecebidos = [];
await track({ evento: 'PageView', event_id: 'evt_url_lixo', session_id: 'sessao-4', step: 0, url: 'javascript:alert(1)', attrib: {} });
checar(await esperarEventos(1), 'repassa PageView com url invalida');
checar(
  (eventosRecebidos[0] ?? {}).event_source_url === 'https://rezassagradas.site/',
  'url que nao e http(s) e descartada e cai no endereco fixo',
);


// A compra NÃO pode nascer do navegador: seria um endereço público onde
// qualquer um declara faturamento que não existiu.
eventosRecebidos = [];
const compraForjada = await track({
  evento: 'Purchase',
  event_id: 'evt_forjado',
  session_id: 'sessao-1',
  attrib: carimbo,
  value: 9999,
});
checar(compraForjada.status === 204, 'responde 204 mesmo ao recusar (nao ensina o que a rota aceita)');
await new Promise((ok) => setTimeout(ok, 700));
checar(eventosRecebidos.length === 0, 'RECUSA Purchase vindo do navegador');

eventosRecebidos = [];
const desconhecido = await track({ evento: 'InventadoAqui', event_id: 'evt_x', session_id: 's', attrib: {} });
await new Promise((ok) => setTimeout(ok, 500));
checar(desconhecido.status === 204 && eventosRecebidos.length === 0, 'ignora evento fora da lista branca');

const semNada = await track({});
checar(semNada.status === 204, 'corpo vazio nao derruba a rota');

/*
 * Os eventos da mensagem de recuperacao sao NOSSOS: entram no banco e param
 * ali.
 *
 * No Meta, nome fora da lista padrao vira "evento personalizado" e aparece no
 * gerenciador ao lado das conversoes que valem dinheiro. "Viu um aviso" nao e
 * conversao -- e, pior que sujar relatorio, daria ao robo de otimizacao um alvo
 * que nao e venda. Ele passaria a procurar gente que abandona checkout.
 */
for (const evento of ['RecuperacaoVista', 'RecuperacaoClique']) {
  eventosRecebidos = [];
  const resposta = await track({
    evento,
    event_id: `evt_${evento}`,
    session_id: 'sessao-recuperacao',
    attrib: carimbo,
  });
  await new Promise((ok) => setTimeout(ok, 700));
  checar(resposta.status === 204, `${evento} e aceito pela rota`);
  checar(eventosRecebidos.length === 0, `${evento} NAO e repassado ao Meta`);
}

/* ========================================================================== */
/* PARTE 3 — a compra, que nasce no servidor                                   */
/* ========================================================================== */

console.log('\n== Compra confirmada (servidor) ==\n');

eventosRecebidos = [];
const cliente = {
  name: 'Maria Aparecida Silva',
  email: 'maria@exemplo.com',
  phone: '11988887777',
  document: '52998224725',
};

const criacao = await fetch(`${base}/api/orders`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-vercel-forwarded-for': IP_DO_CLIENTE },
  body: JSON.stringify({
    offer: 'main',
    bumps: ['salmos_150'],
    customer: cliente,
    attrib: carimbo,
    session_id: 'sessao-1',
  }),
}).then((r) => r.json());

checar(criacao.success === true, 'cria o pedido com o carimbo do anuncio', JSON.stringify(criacao).slice(0, 200));
const pedido = criacao.data ?? {};
checar(pedido.purchaseEventId === null, 'pedido pendente ainda nao tem evento de compra');

// Confirma o pagamento pelo caminho real: callback assinado da PixGo.
const idCobranca = [...cobrancas.keys()].at(-1);
cobrancas.get(idCobranca).status = 'completed';

function assinar(corpo, carimboSeg) {
  return crypto.createHmac('sha256', CHAVE_PIX).update(`${carimboSeg}.${corpo}`).digest('hex');
}

async function avisarPagamento() {
  const corpo = JSON.stringify({ event: 'payment.completed', payment_id: idCobranca, status: 'completed' });
  const segundos = Math.floor(Date.now() / 1000);
  return fetch(`${base}/api/webhooks/pix`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Connection: 'close',
      'X-Webhook-Timestamp': String(segundos),
      'X-Webhook-Signature': assinar(corpo, segundos),
    },
    body: corpo,
  });
}

/**
 * Uma venda inteira, do zero: cria o pedido e confirma o pagamento.
 *
 * Existe por causa do corte de 14/08/2026. As verificacoes de credencial mais
 * abaixo -- trocar o Pixel pelo painel, deixar o campo de token em branco,
 * escrever "apagar" -- provavam que a credencial vale disparando um `Lead` pela
 * /api/track e vendo o evento chegar. Com so a compra indo ao Meta, `Lead` nao
 * chega mais, e aquelas cinco linhas ficariam vermelhas medindo o nada.
 *
 * Cada chamada precisa de um pedido NOVO: o `event_id` do Purchase e
 * deterministico por pedido (`purchase_<id>_main`), e reconfirmar o mesmo
 * pagamento e justamente o caso que o sistema ignora de proposito, para a
 * reentrega da PixGo nao virar faturamento em dobro.
 */
let vendasDeTeste = 0;
async function venderDeVerdade() {
  vendasDeTeste += 1;
  await fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-vercel-forwarded-for': IP_DO_CLIENTE },
    body: JSON.stringify({
      offer: 'main',
      customer: { ...cliente, email: `credencial${vendasDeTeste}@exemplo.com` },
      attrib: carimbo,
      session_id: `sessao-cred-${vendasDeTeste}`,
    }),
  }).then((r) => r.json());

  const id = [...cobrancas.keys()].at(-1);
  cobrancas.get(id).status = 'completed';

  const corpo = JSON.stringify({ event: 'payment.completed', payment_id: id, status: 'completed' });
  const segundos = Math.floor(Date.now() / 1000);
  return fetch(`${base}/api/webhooks/pix`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Connection: 'close',
      'X-Webhook-Timestamp': String(segundos),
      'X-Webhook-Signature': assinar(corpo, segundos),
    },
    body: corpo,
  });
}

const aviso = await avisarPagamento();
checar(aviso.status === 200, 'o callback da PixGo foi aceito', String(aviso.status));
checar(await esperarEventos(1), 'a compra confirmada vira evento no Meta');

const compra = eventosRecebidos.find((evento) => evento.event_name === 'Purchase') ?? {};
checar(compra.event_name === 'Purchase', 'o evento e um Purchase');
// 47,00 do principal + 27,00 do bump salmos_150. Se este numero falhar depois
// de mexer em preco, a fonte da verdade e server/catalog.ts -- este caso ja
// passou um commit inteiro desatualizado, cobrando um valor que nao existia
// mais, e a bateria ficou vermelha sem ninguem saber por que.
checar(
  compra.custom_data?.value === 74,
  `manda o valor em REAIS decimais, nao em centavos (recebido: ${compra.custom_data?.value})`,
);
checar(compra.custom_data?.currency === 'BRL', 'manda a moeda como BRL');
checar(
  JSON.stringify(compra.custom_data?.content_ids) === JSON.stringify(['main', 'salmos_150']),
  'manda os produtos comprados, incluindo o order bump',
);
checar(compra.event_id === `purchase_${pedido.id}_main`, 'usa event_id deterministico da compra');
checar(ehHash(compra.user_data?.external_id?.[0]), 'manda o CPF hasheado como external_id');
checar(
  compra.user_data?.external_id?.[0] === sha256('52998224725'),
  'usa so os digitos do CPF no external_id',
);
checar(compra.user_data?.fbc === carimbo.fbc, 'a compra carrega o fbc do clique original');

/*
 * A CORRESPONDENCIA, que antes era cobrada no evento de navegacao.
 *
 * Enquanto seis eventos subiam por visita, errar a normalizacao aparecia cedo e
 * em volume. Agora sobe UM evento por VENDA -- e um hash errado aqui nao
 * degrada a medicao, apaga. Nao ha um segundo evento para o Meta usar no lugar,
 * e o erro nao acusa nada: o Purchase chega, e simplesmente nao casa com pessoa
 * nenhuma.
 *
 * Por isso estas linhas mudaram de secao em vez de sumir junto com o repasse de
 * navegacao. Sao as mesmas de antes, cobradas onde passou a doer.
 */
const dadosDaCompra = compra.user_data ?? {};
checar(ehHash(dadosDaCompra.em?.[0]), 'a compra manda o e-mail em SHA-256, nunca em texto puro');
checar(dadosDaCompra.em?.[0] === sha256('maria@exemplo.com'), 'normaliza o e-mail antes do hash');
checar(dadosDaCompra.ph?.[0] === sha256('5511988887777'), 'poe o 55 no telefone antes do hash');
checar(dadosDaCompra.fn?.[0] === sha256('maria'), 'separa o primeiro nome');
checar(dadosDaCompra.ln?.[0] === sha256('silva'), 'separa o sobrenome');
checar(dadosDaCompra.fbp === carimbo.fbp, 'manda o fbp SEM hash (o Meta exige assim)');
checar(
  typeof dadosDaCompra.client_user_agent === 'string' && dadosDaCompra.client_user_agent.length > 0,
  'manda o User-Agent junto, que e a outra metade do par com o IP',
);
checar(compra.action_source === 'website', 'marca a origem como website');
checar(
  compra.pixelId === PIXEL && compra.versao === 'v25.0',
  `chama o pixel e a versao configurados (foi para ${compra.pixelId})`,
);
checar(
  typeof compra.event_time === 'number' && String(compra.event_time).length === 10,
  `manda event_time em SEGUNDOS (recebido: ${compra.event_time})`,
);
/*
 * A URL do evento vai SEM query string.
 *
 * A "Configuracao Core" do Meta corta tudo depois do dominio quando esta ativa,
 * entao mandar a query so aumenta o que trafega para ser descartado la. E este
 * funil e devocional: crenca religiosa e dado sensivel nos Termos das
 * Ferramentas Comerciais, e quanto menos texto livre nosso viaja junto do
 * identificador de uma pessoa, menor o risco de a fonte de dados cair numa
 * categoria restrita -- o que degradaria a medicao inteira.
 *
 * Nada se perde: a atribuicao do Meta vem do fbc/fbclid em user_data.
 */
/*
 * A compra NUNCA sai sem `event_source_url` -- nem aqui, sem PUBLIC_BASE_URL.
 * Ate 15/08/2026 este caso aceitava a ausencia "em voz alta"; foi exatamente
 * essa ausencia que o Gerenciador de Eventos acusou. Agora e falha.
 */
checar(
  typeof compra.event_source_url === 'string' && /^https:\/\/[^?]+$/.test(compra.event_source_url),
  `a URL da compra existe e vai sem query string (veio "${compra.event_source_url}")`,
);
/*
 * O IP do Purchase vem do PEDIDO, gravado quando o checkout abriu.
 *
 * Quando o webhook confirma, horas depois, nao ha navegador nenhum aberto e a
 * requisicao vem da PixGo -- usar o IP dela mandaria ao Meta o endereco do
 * gateway como se fosse o do comprador. Este caso prova que o IP guardado no
 * pedido e o de quem comprou, e que ele sobrevive ate a confirmacao.
 */
checar(
  compra.user_data?.client_ip_address === IP_DO_CLIENTE,
  `a compra leva o IP de quem comprou, nao o do gateway (veio "${compra.user_data?.client_ip_address}")`,
);
checar(!compra.test_event_code, 'sem codigo de teste em producao');

// O identificador precisa chegar ao navegador para a /obg deduplicar o Pixel.
const pedidoPago = await fetch(`${base}/api/orders/${pedido.id}`).then((r) => r.json());
checar(
  pedidoPago.data?.purchaseEventId === compra.event_id,
  'devolve o mesmo event_id ao navegador (a /obg dispara o Pixel com ele)',
);

// Reentrega do webhook: a PixGo reenvia por desenho.
eventosRecebidos = [];
const reentrega = await avisarPagamento();
await new Promise((ok) => setTimeout(ok, 800));
checar(reentrega.status === 200, 'reentrega do callback e aceita');
checar(eventosRecebidos.length === 0, 'reentrega NAO gera um segundo Purchase');

/* ========================================================================== */
/* PARTE 3b — importar o investimento e ver o retorno no painel                */
/* ========================================================================== */

console.log('\n== Importacao do investimento (planilha) ==\n');

const senhaPainel = 'senha-de-teste-do-painel';

// A data da planilha é ONTEM, e não fixa. Com "08/08/2026" escrito à mão, a
// linha saiu da janela de 7 dias uma semana depois e o teste passou a falhar
// sozinho (15/08/2026), sem ninguém ter tocado no código que ele testa.
const DIA_ONTEM_BR = (() => {
  const d = new Date(Date.now() - 86_400_000);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
})();

// Planilha falsa, no formato que a Stract exporta para uma conta brasileira.
const planilhaFalsa = http.createServer((req, res) => {
  if (req.url?.startsWith('/pub')) {
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8' });
    res.end(
      [
        'Data;Nome da campanha;ID da campanha;Valor gasto',
        `${DIA_ONTEM_BR};"Frio, video 01";${carimbo.fb_campaign_id};"1.234,56"`,
        `${DIA_ONTEM_BR};Remarketing;120299999;89,90`,
      ].join('\n'),
    );
    return;
  }
  res.writeHead(404).end();
});
await new Promise((ok) => planilhaFalsa.listen(PORTA_PLANILHA, ok));

derrubar(app);
app = await subirApp({
  ADMIN_SENHA: senhaPainel,
  PAINEL_CHAVE_MESTRA: crypto.randomBytes(32).toString('hex'),
  INVESTIMENTO_HOSTS_EXTRA: 'localhost',
});

const sessao = await fetch(`${base}/api/admin/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ senha: senhaPainel }),
}).then((r) => r.json());
const cabecalhoAdmin = { 'X-Admin-Sessao': sessao.data?.token ?? '', 'Content-Type': 'application/json' };
checar(Boolean(sessao.data?.token), 'entra no painel');

// Endereco fora do Google e recusado mesmo com sessao valida.
const recusado = await fetch(`${base}/api/admin/investimento/planilha`, {
  method: 'POST',
  headers: cabecalhoAdmin,
  body: JSON.stringify({ url: 'https://exemplo.com/planilha.csv' }),
}).then((r) => r.json());
checar(recusado.success === false, 'recusa planilha fora do Google');

const salvo = await fetch(`${base}/api/admin/investimento/planilha`, {
  method: 'POST',
  headers: cabecalhoAdmin,
  body: JSON.stringify({ url: `http://localhost:${PORTA_PLANILHA}/pub?output=csv` }),
}).then((r) => r.json());
checar(salvo.success === true, 'salva o endereco da planilha');

const importado = await fetch(`${base}/api/admin/investimento/importar`, {
  method: 'POST',
  headers: cabecalhoAdmin,
}).then((r) => r.json());

checar(importado.success === true, 'importa a planilha', JSON.stringify(importado).slice(0, 200));
checar(importado.data?.linhas === 2, `importa as duas campanhas (veio ${importado.data?.linhas})`);
checar(
  importado.data?.totalFormatado === 'R$ 1.324,46',
  `soma o gasto em reais, nao em centavos (veio ${importado.data?.totalFormatado})`,
);

// A prova final: o investimento tem de aparecer na linha da campanha certa.
const comInvestimento = await fetch(`${base}/api/admin/anuncios?dias=7&agrupamento=campanha`, {
  headers: { 'X-Admin-Sessao': sessao.data?.token ?? '' },
}).then((r) => r.json());

const linhaDaCampanha = (comInvestimento.data?.linhas ?? []).find((l) => l.chave === carimbo.fb_campaign_id);
checar(Boolean(linhaDaCampanha), 'a campanha aparece na aba Anuncios');
checar(
  linhaDaCampanha?.investimentoCentavos === 123456,
  `o investimento cai na campanha certa (veio ${linhaDaCampanha?.investimentoCentavos})`,
);

/* ========================================================================== */
/* PARTE 3c — credenciais do Meta configuradas pelo painel                     */
/* ========================================================================== */

/*
 * O que está sendo provado aqui é a precedência: o que o dono digita no painel
 * tem de vencer a variável de ambiente e valer NA HORA. Se o cache de
 * server/metaCredenciais.ts não for invalidado ao salvar, o painel diria "salvo"
 * e os eventos continuariam indo para o Pixel antigo por mais 30 segundos — o
 * tipo de erro que ninguém percebe até conferir o Gerenciador de Eventos.
 */

console.log('\n== Credenciais do Meta pelo painel ==\n');

const PIXEL_DO_PAINEL = '998877665544332';

const lidas = await fetch(`${base}/api/admin/meta/credenciais`, {
  headers: { 'X-Admin-Sessao': sessao.data?.token ?? '' },
}).then((r) => r.json());

checar(lidas.data?.pixelId === PIXEL, 'le o pixel que veio do ambiente');
checar(
  typeof lidas.data?.tokenMascarado === 'string' && !lidas.data.tokenMascarado.includes(TOKEN_META),
  'NUNCA devolve o token inteiro, so a mascara',
);
checar(
  !JSON.stringify(lidas).includes(TOKEN_META),
  'o token nao aparece em nenhum campo da resposta',
);
checar(lidas.data?.origemDoToken === 'ambiente', 'sabe dizer de onde veio cada credencial');

// O erro mais comum: colar o ID da conta de anuncio no lugar do conjunto de dados.
const pixelErrado = await fetch(`${base}/api/admin/meta/credenciais`, {
  method: 'POST',
  headers: cabecalhoAdmin,
  body: JSON.stringify({ pixelId: 'act_1234567890123456' }),
}).then((r) => r.json());
checar(pixelErrado.success === false, 'recusa "act_..." no lugar do ID do Pixel');

// Testar a conexao NAO pode registrar evento: a conta de anuncio e de producao.
eventosRecebidos = [];
const testeDeConexao = await fetch(`${base}/api/admin/meta/testar`, {
  method: 'POST',
  headers: cabecalhoAdmin,
}).then((r) => r.json());
checar(testeDeConexao.data?.ok === true, 'testa a conexao com o Meta', JSON.stringify(testeDeConexao).slice(0, 160));
checar(eventosRecebidos.length === 0, 'o teste de conexao nao registra evento nenhum');

// Troca o Pixel pelo painel e prova que vale sem reiniciar nada.
const trocado = await fetch(`${base}/api/admin/meta/credenciais`, {
  method: 'POST',
  headers: cabecalhoAdmin,
  body: JSON.stringify({ pixelId: PIXEL_DO_PAINEL, ligado: true }),
}).then((r) => r.json());
checar(trocado.data?.pixelId === PIXEL_DO_PAINEL, 'salva o pixel novo');
checar(trocado.data?.origemDoPixel === 'painel', 'o painel vence a variavel de ambiente');

const pixelPublico = await fetch(`${base}/api/rastreamento/pixel`).then((r) => r.json());
checar(pixelPublico.data?.pixelId === PIXEL_DO_PAINEL, 'a rota publica entrega o pixel novo ao navegador');
checar(!JSON.stringify(pixelPublico).includes(TOKEN_META), 'a rota publica nao vaza o token');

eventosRecebidos = [];
await venderDeVerdade();
checar(await esperarEventos(1), 'continua enviando evento depois da troca');
checar(
  eventosRecebidos[0]?.pixelId === PIXEL_DO_PAINEL,
  `o evento vai para o pixel novo na hora (foi para ${eventosRecebidos[0]?.pixelId})`,
);

/*
 * Campo de token em branco NAO apaga o que ja existe.
 *
 * A tela mostra o token mascarado, entao quem abre para mexer so no Pixel deixa
 * o campo vazio sem querer remover nada. Se isso apagasse, o rastreamento
 * morreria calado no meio de uma campanha.
 */
eventosRecebidos = [];
await fetch(`${base}/api/admin/meta/credenciais`, {
  method: 'POST',
  headers: cabecalhoAdmin,
  body: JSON.stringify({ pixelId: PIXEL_DO_PAINEL, token: '', ligado: true }),
});
await venderDeVerdade();
checar(await esperarEventos(1), 'campo de token vazio MANTEM o token que ja estava salvo');

// Token guardado no painel vence o do ambiente — aqui, um errado de proposito.
eventosRecebidos = [];
await fetch(`${base}/api/admin/meta/credenciais`, {
  method: 'POST',
  headers: cabecalhoAdmin,
  body: JSON.stringify({ pixelId: PIXEL_DO_PAINEL, token: 'token-errado-de-proposito', ligado: true }),
});
await venderDeVerdade();
await new Promise((ok) => setTimeout(ok, 800));
checar(eventosRecebidos.length === 0, 'o token salvo no painel vence o do ambiente');

const recusa = await fetch(`${base}/api/admin/meta/testar`, {
  method: 'POST',
  headers: cabecalhoAdmin,
}).then((r) => r.json());
checar(recusa.data?.ok === false, 'o teste de conexao acusa o token errado');

// "apagar" e a unica forma de remover: volta a valer o token do ambiente.
eventosRecebidos = [];
await fetch(`${base}/api/admin/meta/credenciais`, {
  method: 'POST',
  headers: cabecalhoAdmin,
  body: JSON.stringify({ pixelId: '', token: 'apagar', ligado: true }),
}).then((r) => r.json());
await venderDeVerdade();
checar(await esperarEventos(1), 'a palavra "apagar" remove o token e devolve o do ambiente');
checar(
  eventosRecebidos[0]?.pixelId === PIXEL,
  `pixel em branco volta para o do ambiente (foi para ${eventosRecebidos[0]?.pixelId})`,
);

// O interruptor do painel desliga tudo, mesmo com credencial valida.
eventosRecebidos = [];
await fetch(`${base}/api/admin/meta/credenciais`, {
  method: 'POST',
  headers: cabecalhoAdmin,
  body: JSON.stringify({ pixelId: '', ligado: false }),
});
/*
 * Uma VENDA, e nao um `Lead`.
 *
 * Com so a compra indo ao Meta, um `Lead` aqui passaria sempre -- inclusive com
 * o interruptor quebrado, porque `Lead` ja nao sai por motivo nenhum. O caso
 * viraria uma linha verde que nao prova nada, que e pior que caso nenhum: dá a
 * impressao de cobertura onde nao ha.
 */
await venderDeVerdade();
await new Promise((ok) => setTimeout(ok, 700));
checar(eventosRecebidos.length === 0, 'o interruptor do painel desliga o envio');

// E religa, para as partes seguintes encontrarem o ambiente como esperam.
await fetch(`${base}/api/admin/meta/credenciais`, {
  method: 'POST',
  headers: cabecalhoAdmin,
  body: JSON.stringify({ pixelId: '', ligado: true }),
});

// Sem senha, nada disso e acessivel.
const semSessao = await fetch(`${base}/api/admin/meta/credenciais`).then((r) => r.status);
checar(semSessao === 401, `as credenciais exigem login no painel (veio ${semSessao})`);

/* ========================================================================== */
/* PARTE 4 — o rastreamento não pode derrubar a venda                          */
/* ========================================================================== */

console.log('\n== Falhas do Meta nao podem custar a venda ==\n');

metaForaDoAr = true;
eventosRecebidos = [];

const clienteDois = { ...cliente, email: 'segunda@exemplo.com' };
const segundaCriacao = await fetch(`${base}/api/orders`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ offer: 'main', bumps: [], customer: clienteDois, attrib: carimbo, session_id: 'sessao-2' }),
}).then((r) => r.json());
checar(segundaCriacao.success === true, 'com o Meta fora do ar, o checkout continua criando cobranca');

const idDois = [...cobrancas.keys()].at(-1);
cobrancas.get(idDois).status = 'completed';
const corpoDois = JSON.stringify({ event: 'payment.completed', payment_id: idDois, status: 'completed' });
const segundosDois = Math.floor(Date.now() / 1000);
const comecou = Date.now();
const avisoDois = await fetch(`${base}/api/webhooks/pix`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Connection: 'close',
    'X-Webhook-Timestamp': String(segundosDois),
    'X-Webhook-Signature': assinar(corpoDois, segundosDois),
  },
  body: corpoDois,
});
const demorou = Date.now() - comecou;

checar(avisoDois.status === 200, 'com o Meta fora do ar, o pagamento e confirmado assim mesmo');
checar(
  demorou < 9000,
  `a resposta do webhook cabe na paciencia da PixGo, ~10s (levou ${demorou} ms)`,
);

const acessoDois = await fetch(`${base}/api/orders/${segundaCriacao.data.id}/access`).then((r) => r.json());
checar(acessoDois.success === true && acessoDois.data?.released === true, 'o acesso e liberado mesmo sem o Meta');

// O evento nao se perde: fica pendente e o painel reenvia (ver a aba Anuncios).
metaForaDoAr = false;
eventosRecebidos = [];

/* ========================================================================== */
/* PARTE 5 — desligado, o rastreamento não faz nada                            */
/* ========================================================================== */

console.log('\n== META_TRACKING_ENABLED=false ==\n');

derrubar(app);
eventosRecebidos = [];
app = await subirApp({ META_TRACKING_ENABLED: 'false' });

const semRastreio = await fetch(`${base}/api/orders`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    offer: 'main',
    bumps: [],
    customer: { ...cliente, email: 'terceira@exemplo.com' },
    attrib: carimbo,
    session_id: 'sessao-3',
  }),
}).then((r) => r.json());
checar(semRastreio.success === true, 'checkout funciona com o rastreamento desligado');

// A prova aqui e a COMPRA logo abaixo, que e o unico evento que ainda sai. Um
// `Lead` neste ponto nao acrescentaria nada: ele nao vai ao Meta de todo jeito.
const idTres = [...cobrancas.keys()].at(-1);
cobrancas.get(idTres).status = 'completed';
const corpoTres = JSON.stringify({ event: 'payment.completed', payment_id: idTres, status: 'completed' });
const segundosTres = Math.floor(Date.now() / 1000);
await fetch(`${base}/api/webhooks/pix`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Connection: 'close',
    'X-Webhook-Timestamp': String(segundosTres),
    'X-Webhook-Signature': assinar(corpoTres, segundosTres),
  },
  body: corpoTres,
});

await new Promise((ok) => setTimeout(ok, 800));
checar(eventosRecebidos.length === 0, 'desligado, NADA e enviado ao Meta');

const acessoTres = await fetch(`${base}/api/orders/${semRastreio.data.id}/access`).then((r) => r.json());
checar(acessoTres.data?.released === true, 'desligado, a venda e liberada normalmente');

/* ========================================================================== */

console.log(`\n${tudoOk ? 'TUDO PASSOU' : 'HOUVE FALHAS'}\n`);
await encerrar(tudoOk ? 0 : 1);
