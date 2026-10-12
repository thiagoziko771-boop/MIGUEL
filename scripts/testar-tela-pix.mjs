/**
 * Audita a tela de pagamento: o QR Code, o copia e cola e o botão que copia.
 *
 *   PLAYWRIGHT_DIR=~/teste-funil node scripts/testar-tela-pix.mjs http://localhost:4300
 *
 * Exige o servidor em PIX_MODE=mock, e de preferência com
 * MOCK_CONFIRM_DELAY_MS alto (600000). Nada aqui move dinheiro.
 *
 * O aviso sobre o atraso do mock não é preciosismo: no padrão de 12 s a
 * cobrança falsa se confirma sozinha no meio da bateria, a tela avança para o
 * upsell e as medições seguintes acusam "sumiu tudo" — um alarme falso que
 * manda procurar defeito onde não há nenhum.
 *
 * Por que uma bateria só para esta tela: ela é o último metro da venda. A
 * pessoa já decidiu, já digitou o CPF, e o que falta é copiar um código e colar
 * no banco. Todo defeito aqui — código cortado, botão que não copia de verdade,
 * QR fora do enquadramento, tutorial na frente do botão — cobra o preço mais
 * caro possível, porque acontece depois de todo o resto ter dado certo.
 *
 * A ordem dos elementos é testada de propósito. Ela não é gosto: no celular, o
 * que aparece primeiro é o que a pessoa faz, e QR -> código -> botão é o
 * caminho de quem paga pelo mesmo aparelho, que é a maioria deste público.
 */
import path from 'node:path';
import { createRequire } from 'node:module';

const { chromium } = await (async () => {
  const fora = process.env.PLAYWRIGHT_DIR;
  try {
    if (fora) return createRequire(path.resolve(fora) + path.sep)('playwright');
    return await import('playwright');
  } catch {
    console.error('\nplaywright nao encontrado. Use PLAYWRIGHT_DIR=<pasta com playwright>\n');
    process.exit(1);
  }
})();

const BASE = process.argv[2] ?? 'http://localhost:4300';

let tudoOk = true;
function checar(ok, descricao, extra) {
  console.log(`  ${ok ? 'PASSOU' : 'FALHOU'}  ${descricao}${extra && !ok ? ` -> ${extra}` : ''}`);
  if (!ok) tudoOk = false;
}

const navegador = await chromium.launch();

/*
 * iPhone 14 como tela padrão da bateria: é o aparelho mediano deste público, e
 * medir num monitor de 1280px esconderia justamente os defeitos de
 * enquadramento que esta tela tinha.
 */
const contexto = await navegador.newContext({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 3,
  // Sem isto o clipboard do Chromium recusa a escrita e o teste do botão
  // mediria a nossa mensagem de erro, não a cópia.
  permissions: ['clipboard-read', 'clipboard-write'],
});

const pagina = await contexto.newPage();

/* Erro de console é defeito: nesta tela ele costuma significar QR que não
   desenhou ou requisição que não saiu. */
const errosDeConsole = [];
pagina.on('console', (msg) => {
  if (msg.type() === 'error') errosDeConsole.push(msg.text().slice(0, 200));
});
pagina.on('pageerror', (erro) => errosDeConsole.push(String(erro.message).slice(0, 200)));

/*
 * O código que o SERVIDOR devolveu, capturado na resposta da criação do pedido.
 *
 * É contra ele que a tela é conferida. Ler só o que está na tela provaria que
 * existe um texto com cara de PIX ali — e um código inventado passaria no
 * teste. O que precisa ser verdade é que a tela mostra o código do gateway,
 * caractere por caractere.
 */
let codigoDoServidor = null;
pagina.on('response', async (resposta) => {
  if (!resposta.url().includes('/api/orders') || resposta.request().method() !== 'POST') return;
  try {
    const corpo = await resposta.json();
    const codigo = corpo?.data?.pix?.code;
    if (typeof codigo === 'string' && codigo) codigoDoServidor = codigo;
  } catch {
    // Resposta de erro: o teste falha adiante, com mensagem melhor.
  }
});

console.log(`\nTela de pagamento em ${BASE}\n`);

await pagina.goto(`${BASE}/?tela=13&cta=0`, { waitUntil: 'domcontentloaded' });
await pagina.waitForTimeout(1200);

await pagina.getByRole('button', { name: 'SIM, EU QUERO A ORAÇÃO COMPLETA E CONSAGRADA' }).click();
await pagina.waitForTimeout(900);

await pagina.getByPlaceholder('Seu nome completo').fill('Maria de Teste');
await pagina.getByPlaceholder('Seu melhor e-mail (onde chega o acesso)').fill('maria@exemplo.com');
await pagina.getByPlaceholder('CPF de quem vai pagar (000.000.000-00)').fill('52998224725');

/*
 * A posição da rolagem ANTES de apertar o botão, para provar que a tela se
 * moveu sozinha depois. Sem essa medida, "rolou até o QR" não é verificável.
 */
const rolagemAntes = await pagina.evaluate(() => window.scrollY);

await pagina.getByRole('button', { name: /QUERO MINHA ORAÇÃO/ }).click();
await pagina.waitForTimeout(3000);

/* -------------------------------------------------------------------------- */
/* O PIX nasceu?                                                               */
/* -------------------------------------------------------------------------- */

checar(Boolean(codigoDoServidor), 'o servidor devolveu o codigo do PIX');
if (!codigoDoServidor) {
  console.log('\nSem cobranca criada nao ha o que medir. O servidor esta em PIX_MODE=mock?\n');
  await navegador.close();
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/* 1. A ordem na tela: QR -> Copia e Cola -> codigo -> botao -> tutorial        */
/* -------------------------------------------------------------------------- */

const posicoes = await pagina.evaluate(() => {
  const topoDe = (el) => (el ? el.getBoundingClientRect().top + window.scrollY : null);
  const acharTexto = (texto) =>
    [...document.querySelectorAll('p, span, h1, h2, h3, h4, li')].find((el) => el.textContent?.trim().startsWith(texto));

  const area = document.getElementById('area-de-pagamento-pix');
  const codigo = document.querySelector('[aria-label="Código PIX copia e cola"]');
  const botao = [...document.querySelectorAll('button')].find((el) => el.textContent?.includes('Copiar código'));

  return {
    qr: topoDe(area?.querySelector('img') ?? null),
    rotulo: topoDe(acharTexto('Pix Copia e Cola')),
    codigo: topoDe(codigo),
    botao: topoDe(botao),
    tutorial: topoDe(acharTexto('Nunca pagou com PIX')),
    alturaDoBotao: botao ? Math.round(botao.getBoundingClientRect().height) : 0,
    larguraDoBotao: botao ? Math.round(botao.getBoundingClientRect().width) : 0,
  };
});

const naOrdem = (a, b) => a !== null && b !== null && a < b;

checar(posicoes.qr !== null, 'o QR Code aparece na tela');
/*
 * NO CELULAR O COPIA E COLA VEM PRIMEIRO, e o QR desce.
 *
 * Esta asserção dizia o contrário até 17/08/2026 — ficou para trás quando o dono
 * pediu a inversão, em 14/08, e desde então a bateria acusava falha na ordem que
 * ele mandou implementar. O motivo da inversão está em src/components/PixPanel.tsx:
 * quem chega de anúncio está no celular e paga no MESMO aparelho, então o QR é
 * inútil para ela (não dá para apontar a câmera para a própria tela) e o que a
 * rolagem precisa enquadrar é rótulo + código + botão.
 *
 * Como a bateria roda num viewport de 390px, é a ordem do celular que vale aqui.
 */
checar(naOrdem(posicoes.rotulo, posicoes.qr), 'no celular, o "Pix Copia e Cola" vem ANTES do QR Code');
checar(naOrdem(posicoes.rotulo, posicoes.codigo), 'o campo do codigo vem depois do rotulo');
checar(naOrdem(posicoes.codigo, posicoes.botao), 'o botao "Copiar codigo" vem logo depois do campo');
checar(naOrdem(posicoes.botao, posicoes.tutorial), 'o tutorial vem DEPOIS do botao, e nao entre o QR e o codigo');

/* -------------------------------------------------------------------------- */
/* 2. Enquadramento: QR quadrado, codigo inteiro, botao grande                  */
/* -------------------------------------------------------------------------- */

const enquadramento = await pagina.evaluate(() => {
  const area = document.getElementById('area-de-pagamento-pix');
  const img = area?.querySelector('img');
  const codigo = document.querySelector('[aria-label="Código PIX copia e cola"]');
  const documento = document.documentElement;

  const caixaDoQr = img?.getBoundingClientRect();
  const caixaDoCodigo = codigo?.getBoundingClientRect();

  return {
    larguraDoQr: caixaDoQr ? Math.round(caixaDoQr.width) : 0,
    alturaDoQr: caixaDoQr ? Math.round(caixaDoQr.height) : 0,
    qrDentro: caixaDoQr ? caixaDoQr.left >= 0 && caixaDoQr.right <= documento.clientWidth : false,
    // Rolagem interna no campo do codigo = codigo cortado.
    codigoCortado: codigo ? codigo.scrollHeight > codigo.clientHeight + 1 : true,
    codigoDentro: caixaDoCodigo ? caixaDoCodigo.right <= documento.clientWidth + 1 : false,
    excessoHorizontal: documento.scrollWidth - documento.clientWidth,
  };
});

checar(
  enquadramento.larguraDoQr === enquadramento.alturaDoQr,
  `o QR Code nao e distorcido (veio ${enquadramento.larguraDoQr}x${enquadramento.alturaDoQr})`,
);
checar(
  enquadramento.larguraDoQr >= 168,
  `o QR Code e grande o bastante para outro celular ler (veio ${enquadramento.larguraDoQr}px)`,
);
checar(enquadramento.qrDentro, 'o QR Code cabe inteiro na largura da tela');
checar(!enquadramento.codigoCortado, 'o codigo aparece inteiro, sem rolagem interna cortando o fim');
checar(enquadramento.codigoDentro, 'o campo do codigo nao passa da borda da tela');
checar(
  enquadramento.excessoHorizontal <= 1,
  `nao ha rolagem horizontal (excesso de ${enquadramento.excessoHorizontal}px)`,
);
checar(
  posicoes.alturaDoBotao >= 44 && posicoes.larguraDoBotao >= 44,
  `o botao de copiar e facil de tocar (veio ${posicoes.larguraDoBotao}x${posicoes.alturaDoBotao}px)`,
);

/* -------------------------------------------------------------------------- */
/* 3. A tela rolou sozinha ate o pagamento                                      */
/* -------------------------------------------------------------------------- */

const rolagem = await pagina.evaluate(() => {
  const area = document.getElementById('area-de-pagamento-pix');
  if (!area) return null;
  const caixa = area.getBoundingClientRect();
  return { depois: window.scrollY, topoNaTela: caixa.top, alturaDaTela: window.innerHeight };
});

checar(rolagem !== null && rolagem.depois > rolagemAntes, 'a tela rola sozinha quando o PIX e gerado');
checar(
  rolagem !== null && rolagem.topoNaTela >= -1 && rolagem.topoNaTela < rolagem.alturaDaTela * 0.5,
  `a area do QR fica visivel sem precisar rolar a mao (topo em ${Math.round(rolagem?.topoNaTela ?? 0)}px)`,
);

/* -------------------------------------------------------------------------- */
/* 4. O codigo na tela e o codigo do servidor                                   */
/* -------------------------------------------------------------------------- */

const codigoNaTela = (
  await pagina.locator('[aria-label="Código PIX copia e cola"]').innerText()
).replace(/\s+/g, '');

checar(
  codigoNaTela === codigoDoServidor.replace(/\s+/g, ''),
  'a tela mostra exatamente o codigo que o gateway devolveu',
  `tela=${codigoNaTela.slice(0, 40)}... servidor=${codigoDoServidor.slice(0, 40)}...`,
);

/* -------------------------------------------------------------------------- */
/* 5. O botao copia de verdade                                                  */
/* -------------------------------------------------------------------------- */

await pagina.getByRole('button', { name: /Copiar código/ }).click();
await pagina.waitForTimeout(400);

const naAreaDeTransferencia = await pagina.evaluate(() => navigator.clipboard.readText());
checar(
  naAreaDeTransferencia.replace(/\s+/g, '') === codigoDoServidor.replace(/\s+/g, ''),
  'o botao copia o codigo PIX de verdade para a area de transferencia',
  `copiado=${naAreaDeTransferencia.slice(0, 40)}...`,
);

const confirmacao = pagina.getByText('Código copiado!', { exact: false }).first();
checar(await confirmacao.isVisible().catch(() => false), 'aparece a confirmacao "Codigo copiado!"');

/* -------------------------------------------------------------------------- */
/* 6. O tutorial de sete passos                                                 */
/* -------------------------------------------------------------------------- */

const passos = [
  'Abra seu banco',
  'Entre no Pix',
  'Toque em Pagar',
  'Escolha Copia e Cola',
  'Copie o código',
  'Cole no aplicativo do banco',
  'Confirme o pagamento',
];

for (const passo of passos) {
  const visivel = await pagina.getByText(passo, { exact: false }).first().isVisible().catch(() => false);
  checar(visivel, `o tutorial traz o passo "${passo}"`);
}

/* -------------------------------------------------------------------------- */
/* 7. O que nao pode ter sumido                                                 */
/* -------------------------------------------------------------------------- */

const preservado = [
  ['Aguardando a confirmação', 'o aviso de que a liberacao e automatica continua na tela'],
  ['Já paguei — verificar agora', 'o botao de conferir o pagamento continua na tela'],
  ['O pagamento precisa ser feito pelo CPF', 'o aviso do CPF continua na tela'],
  ['Quero mudar meu pedido', 'a saida para corrigir o pedido continua na tela'],
];

for (const [texto, descricao] of preservado) {
  const visivel = await pagina.getByText(texto, { exact: false }).first().isVisible().catch(() => false);
  checar(visivel, descricao);
}

/* -------------------------------------------------------------------------- */
/* 8. A confirmacao de copia some sozinha                                       */
/* -------------------------------------------------------------------------- */

/*
 * Por último na bateria porque é a única checagem que precisa esperar. Estava
 * no meio e empurrava tudo o que vinha depois para além do prazo em que a
 * cobrança falsa se confirma sozinha — a tela trocava para o upsell e as
 * medições seguintes falhavam sem defeito nenhum no código.
 */
await pagina.waitForTimeout(5000);
checar(
  !(await confirmacao.isVisible().catch(() => false)),
  'a confirmacao some sozinha depois de alguns segundos',
);

checar(errosDeConsole.length === 0, 'nenhum erro no console', errosDeConsole.join(' | '));

await navegador.close();

console.log(tudoOk ? '\nTODOS OS TESTES PASSARAM\n' : '\nHOUVE FALHAS\n');
process.exit(tudoOk ? 0 : 1);
