/**
 * Audita a mensagem de recuperação de compra.
 *
 *   PLAYWRIGHT_DIR=~/teste-funil node scripts/testar-retomada.mjs http://localhost:4300
 *
 * Exige o servidor em PIX_MODE=mock, de preferência com MOCK_CONFIRM_DELAY_MS
 * alto (600000) — senão a cobrança falsa se confirma no meio da bateria, a tela
 * troca para o upsell e as medições acusam falha onde não há.
 *
 * O caso que esta bateria existe para proteger é o do FALSO POSITIVO: a
 * mensagem diz "percebemos que você não concluiu", e mostrá-la a quem apertou o
 * botão de comprar há três segundos é pior do que não ter mensagem nenhuma —
 * soa como sistema que não está acompanhando o que a pessoa acabou de fazer.
 * Por isso o primeiro teste aqui verifica a AUSÊNCIA dela.
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
const contexto = await navegador.newContext({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 3,
});

/* Os eventos que o navegador manda ao servidor, para conferir o rastreamento. */
const eventosEnviados = [];
await contexto.route('**/api/track', async (rota) => {
  try {
    const corpo = JSON.parse(rota.request().postData() ?? '{}');
    if (corpo.evento) eventosEnviados.push(corpo.evento);
  } catch {
    // corpo ilegível: o teste do rastreamento falha adiante, com mensagem melhor
  }
  await rota.continue();
});

const pagina = await contexto.newPage();
const errosDeConsole = [];
pagina.on('console', (m) => {
  if (m.type() === 'error') errosDeConsole.push(m.text().slice(0, 160));
});
pagina.on('pageerror', (e) => errosDeConsole.push(e.message.slice(0, 160)));

console.log(`\nMensagem de recuperacao em ${BASE}\n`);

/* -------------------------------------------------------------------------- */
/* 1. Quem acabou de gerar o PIX NAO ve a mensagem                             */
/* -------------------------------------------------------------------------- */

await pagina.goto(`${BASE}/?tela=13&cta=0`, { waitUntil: 'domcontentloaded' });
await pagina.waitForTimeout(1200);
await pagina.getByRole('button', { name: 'SIM, EU QUERO A ORAÇÃO COMPLETA E CONSAGRADA' }).click();
await pagina.waitForTimeout(800);

await pagina.getByPlaceholder('Seu nome completo').fill('Maria de Teste');
await pagina.getByPlaceholder('Seu melhor e-mail', { exact: false }).fill('retomada@exemplo.com');
await pagina.getByPlaceholder('CPF de quem vai pagar (000.000.000-00)').fill('52998224725');
await pagina.getByRole('button', { name: /QUERO MINHA ORAÇÃO/ }).click();
await pagina.waitForTimeout(3000);

const titulo = pagina.getByText('Sua oração ainda está esperando por você', { exact: false }).first();

checar(
  await pagina.getByText('Pix Copia e Cola').first().isVisible().catch(() => false),
  'o PIX foi gerado',
);
checar(
  !(await titulo.isVisible().catch(() => false)),
  'quem acabou de gerar o PIX NAO recebe a mensagem de recuperacao',
);
checar(
  !eventosEnviados.includes('RecuperacaoVista'),
  'e nenhum evento de recuperacao e registrado nesse caso',
);

/* -------------------------------------------------------------------------- */
/* 2. Quem volta depois recebe a mensagem                                       */
/* -------------------------------------------------------------------------- */

/*
 * Recarregar é o mesmo caminho de quem saiu para o app do banco e voltou: o
 * pedido é relido do localStorage e o checkout devolve a pessoa para o PIX.
 */
eventosEnviados.length = 0;
await pagina.reload({ waitUntil: 'domcontentloaded' });
await pagina.waitForTimeout(3500);

checar(await titulo.isVisible().catch(() => false), 'quem volta recebe a mensagem de recuperacao');

const trechos = [
  ['Percebemos que você iniciou seu pedido', 'explica por que a mensagem apareceu'],
  ['você pode continuar de onde parou', 'oferece continuar de onde parou'],
  ['São Miguel Arcanjo, defendei-nos no combate', 'traz a oração de São Miguel'],
  ['continua reservado em seu nome', 'diz que o pedido continua reservado'],
  ['Que São Miguel Arcanjo interceda por você', 'fecha com a bênção'],
];
for (const [texto, descricao] of trechos) {
  const visivel = await pagina.getByText(texto, { exact: false }).first().isVisible().catch(() => false);
  checar(visivel, descricao);
}

// O valor vem do servidor e precisa ser o do pedido em aberto, não um número
// escrito na tela: a mensagem some junto com a credibilidade se disser errado.
const valorNaMensagem = await pagina.getByText('continua reservado em seu nome', { exact: false }).first().innerText();
checar(/R\$\s?74,00/.test(valorNaMensagem), `a mensagem mostra o valor real do pedido (veio: ${valorNaMensagem.slice(0, 90)})`);

checar(eventosEnviados.includes('RecuperacaoVista'), 'registra que a mensagem foi mostrada');
checar(
  eventosEnviados.filter((e) => e === 'RecuperacaoVista').length === 1,
  `registra UMA vez, e nao uma por segundo (veio ${eventosEnviados.filter((e) => e === 'RecuperacaoVista').length})`,
);

/* -------------------------------------------------------------------------- */
/* 3. Enquadramento e ordem                                                     */
/* -------------------------------------------------------------------------- */

const layout = await pagina.evaluate(() => {
  const topoDe = (el) => (el ? el.getBoundingClientRect().top + window.scrollY : null);
  const acharTexto = (t) =>
    [...document.querySelectorAll('p, span, h1, h2, h3, h4')].find((el) => el.textContent?.trim().startsWith(t));
  const botao = [...document.querySelectorAll('button')].find((el) =>
    el.textContent?.includes('CONTINUAR MEU PEDIDO'),
  );
  const caixa = botao?.getBoundingClientRect();

  return {
    mensagem: topoDe(acharTexto('Sua oração ainda está esperando')),
    areaDePagamento: topoDe(document.getElementById('area-de-pagamento-pix')),
    alturaDoBotao: caixa ? Math.round(caixa.height) : 0,
    larguraDoBotao: caixa ? Math.round(caixa.width) : 0,
    botaoDentro: caixa ? caixa.left >= 0 && caixa.right <= document.documentElement.clientWidth : false,
    excessoHorizontal: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    // Onde a mensagem está NA TELA, e não a que altura da página ela fica: o
    // que importa é se a pessoa a vê sem rolar.
    topoNaTela: document.getElementById('convite-de-retomada')?.getBoundingClientRect().top ?? null,
    alturaDaTela: window.innerHeight,
  };
});

checar(
  layout.mensagem !== null && layout.areaDePagamento !== null && layout.mensagem < layout.areaDePagamento,
  'a mensagem vem ANTES do QR Code, e nao depois',
);
checar(
  layout.alturaDoBotao >= 44 && layout.larguraDoBotao >= 44,
  `o botao de continuar e facil de tocar (veio ${layout.larguraDoBotao}x${layout.alturaDoBotao}px)`,
);
checar(layout.botaoDentro, 'o botao cabe na largura da tela');
checar(layout.excessoHorizontal <= 1, `sem rolagem horizontal (excesso de ${layout.excessoHorizontal}px)`);
/*
 * A mensagem tem de estar VISIVEL quando a pessoa volta.
 *
 * Sao dois jeitos de errar isto, e os dois ja aconteceram aqui: a pagina
 * reabria no topo da VSL (a mensagem ficava a mil pixels de rolagem, atras do
 * video e do formulario inteiros) e, antes disso, a rolagem automatica pulava
 * direto para o QR Code, deixando a mensagem para tras. Medir a posicao NA TELA
 * pega os dois casos; medir `window.scrollY` nao pega nenhum.
 */
checar(
  layout.topoNaTela !== null && layout.topoNaTela >= -1 && layout.topoNaTela < layout.alturaDaTela * 0.5,
  `a mensagem aparece na tela sem precisar rolar (topo em ${Math.round(layout.topoNaTela ?? 0)}px)`,
);

/* -------------------------------------------------------------------------- */
/* 4. O botao leva ao pagamento e registra o clique                             */
/* -------------------------------------------------------------------------- */

await pagina.getByRole('button', { name: /CONTINUAR MEU PEDIDO/ }).click();
await pagina.waitForTimeout(1500);

const depoisDoClique = await pagina.evaluate(() => {
  const area = document.getElementById('area-de-pagamento-pix');
  const caixa = area?.getBoundingClientRect();
  return {
    topoNaTela: caixa ? caixa.top : null,
    alturaDaTela: window.innerHeight,
    rolagem: window.scrollY,
  };
});

checar(depoisDoClique.rolagem > 0, 'o botao rola a tela');
checar(
  depoisDoClique.topoNaTela !== null &&
    depoisDoClique.topoNaTela >= -1 &&
    depoisDoClique.topoNaTela < depoisDoClique.alturaDaTela * 0.5,
  `o botao leva ate o QR Code (topo em ${Math.round(depoisDoClique.topoNaTela ?? 0)}px)`,
);
checar(eventosEnviados.includes('RecuperacaoClique'), 'registra o clique no botao');

/* -------------------------------------------------------------------------- */
/* 5. O que nao pode ter mudado                                                 */
/* -------------------------------------------------------------------------- */

/*
 * Que estes eventos não vão para o Meta é garantido do lado do SERVIDOR, e o
 * teste disso vive em scripts/testar-rastreamento.mjs, que sobe um Meta falso e
 * confere que nada chega lá. Aqui não daria: sem credencial configurada o Pixel
 * nem carrega no navegador, e o teste passaria sem provar coisa nenhuma.
 */
checar(
  await pagina.getByRole('button', { name: /Copiar código/ }).isVisible().catch(() => false),
  'o botao de copiar o PIX continua na tela',
);
checar(
  await pagina.getByText('Nunca pagou com PIX', { exact: false }).first().isVisible().catch(() => false),
  'o tutorial de sete passos continua na tela',
);
checar(errosDeConsole.length === 0, 'nenhum erro no console', errosDeConsole.join(' | '));

await navegador.close();

console.log(tudoOk ? '\nTODOS OS TESTES PASSARAM\n' : '\nHOUVE FALHAS\n');
process.exit(tudoOk ? 0 : 1);
