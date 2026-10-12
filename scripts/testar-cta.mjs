/**
 * Testa a tela da oferta num navegador de verdade.
 *
 * Existe porque uma vez o botão de compra passou a aparecer na hora para todo
 * cliente e a leitura do código não mostrou isso: o defeito estava no cálculo do
 * atraso, não nas condições de renderização. O caso que quebrou era justamente o
 * único sem teste — abrir a página sem parâmetro nenhum, que é o que 100% dos
 * clientes fazem.
 *
 * O playwright NÃO é dependência do funil: ele baixa um Chromium inteiro na
 * instalação e isso pesaria em todo build da Vercel, para um teste que roda à
 * mão. Instale numa pasta qualquer fora do projeto e aponte para ela:
 *
 *   mkdir ~/teste-funil && cd ~/teste-funil
 *   npm i playwright && npx playwright install chromium
 *
 *   PLAYWRIGHT_DIR=~/teste-funil node scripts/testar-cta.mjs http://localhost:4300 260
 *   PLAYWRIGHT_DIR=~/teste-funil node scripts/testar-cta.mjs https://rezassagradas.vercel.app 260
 *
 * Sem PLAYWRIGHT_DIR ele procura do jeito normal, para o caso de um dia virar
 * dependência de verdade.
 *
 * O segundo argumento é a espera configurada em `segundosAteOCta`, em
 * src/data/funnelData.ts. Passe o valor de lá ao trocar o tempo: as asserções se
 * ajustam sozinhas, inclusive para zero (botão sempre visível).
 */
import path from 'node:path';
import { createRequire } from 'node:module';

// import estático de 'playwright' falharia aqui antes de qualquer mensagem útil,
// e NODE_PATH não vale para módulos ESM — daí a resolução manual.
const { chromium } = await (async () => {
  const fora = process.env.PLAYWRIGHT_DIR;
  try {
    if (fora) return createRequire(path.resolve(fora) + path.sep)('playwright');
    return await import('playwright');
  } catch {
    console.error(
      '\nplaywright nao encontrado.\n' +
      '  npm i playwright && npx playwright install chromium   (numa pasta fora do projeto)\n' +
      '  PLAYWRIGHT_DIR=<essa pasta> node scripts/testar-cta.mjs <url> <segundos>\n'
    );
    process.exit(1);
  }
})();

const BASE = process.argv[2] ?? 'http://localhost:4300';
/** Espera configurada em funnelData.ts. Ajustar junto ao trocar o valor la. */
const PADRAO = Number(process.argv[3] ?? 260);
const BOTAO = 'SIM, EU QUERO A ORAÇÃO COMPLETA E CONSAGRADA';
/** Espelho de CHAVE_CTA_VISTO, em src/components/OfferScreen.tsx. Muda junto. */
const CHAVE_CTA_VISTO = 'rezas_sagradas.cta_visto.v2';

const navegador = await chromium.launch();

const erros = [];
let tudoOk = true;

/*
 * Cada caso ganha um contexto NOVO, com armazenamento em branco.
 *
 * Todos dividiam um só, e isso virou vazamento quando a tela passou a lembrar
 * de quem já cumpriu a espera (`rezas_sagradas.cta_visto.vN`). O primeiro caso
 * espera os ~242 s até o botão aparecer — e é justamente aparecer que GRAVA a
 * marca. Dali em diante todo caso herdava "essa pessoa já esperou", o botão
 * saía na hora e o teste reprovava por um motivo que não existe no produto.
 *
 * Um contexto por caso deixa cada um contando a história de um cliente novo,
 * que é o que quase todos querem medir. Quem quiser testar a memória em si
 * grava a marca de propósito — é o que faz o caso 2b logo abaixo.
 */
const contextos = [];
async function novoContexto() {
  const ctx = await navegador.newContext({ viewport: { width: 420, height: 900 } });
  contextos.push(ctx);
  return ctx;
}

function checar(ok, descricao) {
  console.log(`  ${ok ? 'PASSOU' : 'FALHOU'}  ${descricao}`);
  if (!ok) tudoOk = false;
}

/*
 * Antes da hora nao ha mais nenhuma mensagem abaixo do video: a frase que
 * anunciava o botao foi removida em 08/08/2026, porque anunciar a espera faz a
 * pessoa vigiar o espaco vazio em vez de assistir.
 *
 * O que restou para verificar e o que sempre importou de verdade: o botao de
 * compra NAO pode estar clicavel antes do tempo, e o checkout nao pode estar
 * aberto. Uma frase a menos nao custa venda; um botao liberado cedo custa,
 * porque leva ao checkout quem ainda nao ouviu o preco.
 */
async function abrir(caminho, esperarMs) {
  const pagina = await (await novoContexto()).newPage();
  pagina.on('pageerror', (e) => erros.push(e.message));
  await pagina.goto(BASE + caminho, { waitUntil: 'domcontentloaded' });
  await pagina.waitForTimeout(esperarMs);
  const botao = await pagina.getByRole('button', { name: BOTAO }).isVisible().catch(() => false);
  const checkoutAberto = await pagina.locator('[role="dialog"]').isVisible().catch(() => false);
  return { pagina, botao, checkoutAberto };
}

console.log(`\nTela da oferta em ${BASE}\n`);

// 1. O caso do cliente: sem parametro, vale a espera configurada.
{
  const { pagina, botao, checkoutAberto } = await abrir('/?tela=13', 2000);
  checar(botao === (PADRAO <= 0), `SEM parametro: aos 2 s o botao ${PADRAO <= 0 ? 'aparece' : 'ainda nao aparece'}`);
  checar(!checkoutAberto, 'SEM parametro: o checkout nao abre sozinho');

  if (PADRAO > 0) {
    await pagina.waitForTimeout(PADRAO * 1000 + 1500);
    const depois = await pagina.getByRole('button', { name: BOTAO }).isVisible().catch(() => false);
    checar(depois, `SEM parametro: o botao aparece depois dos ${PADRAO} s`);
  }
  await pagina.close();
}

// 2. Parâmetro vazio ou inválido não pode mudar o comportamento padrão.
{
  const { pagina, botao } = await abrir('/?tela=13&cta=', 2000);
  checar(botao === (PADRAO <= 0), 'cta vazio: cai no padrao, nao em zero');
  await pagina.close();
}
{
  const { pagina, botao } = await abrir('/?tela=13&cta=abc', 2000);
  checar(botao === (PADRAO <= 0), 'cta invalido: cai no padrao');
  await pagina.close();
}

/*
 * 2b. Quem já cumpriu a espera uma vez não a cumpre de novo.
 *
 * Esta é a memória gravada em localStorage quando o botão APARECE. Ela nunca
 * teve teste próprio — e sem teste próprio ela já se disfarçou de defeito: os
 * casos acima dividiam um contexto só, herdavam a marca deixada pelo caso 1 e
 * reprovavam como se o parâmetro inválido estivesse liberando o botão cedo.
 *
 * Aqui a marca é gravada de propósito, antes de abrir a VSL, e o esperado se
 * inverte: o botão TEM de aparecer na hora.
 */
{
  const pagina = await (await novoContexto()).newPage();
  await pagina.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  /*
   * A chave TEM de ser a mesma de CHAVE_CTA_VISTO, em OfferScreen.tsx. Ela muda
   * de versão de propósito toda vez que a VSL ou o preço mudam, para as marcas
   * antigas virarem lixo ignorado — e quando isso acontecer, este teste vai
   * falhar até ser atualizado aqui. Foi o que aconteceu em 10/08/2026 na troca
   * da VSL: a falha não era defeito, era a virada da chave funcionando.
   */
  await pagina.evaluate((chave) => localStorage.setItem(chave, '1'), CHAVE_CTA_VISTO);

  await pagina.goto(BASE + '/?tela=13', { waitUntil: 'domcontentloaded' });
  await pagina.waitForTimeout(2000);
  const botao = await pagina.getByRole('button', { name: BOTAO }).isVisible().catch(() => false);
  checar(botao, 'quem ja esperou uma vez ve o botao na hora');
  await pagina.close();
}

// 3. O mecanismo de espera segue funcionando, mesmo quando o padrão é zero.
{
  const { pagina, botao, checkoutAberto } = await abrir('/?tela=13&cta=5', 1500);
  checar(!botao, 'cta=5: antes do tempo o botao nao aparece');
  checar(!checkoutAberto, 'cta=5: antes do tempo o checkout continua fechado');
  await pagina.waitForTimeout(4500);
  const depois = await pagina.getByRole('button', { name: BOTAO }).isVisible().catch(() => false);
  checar(depois, 'cta=5: depois do tempo o botao aparece');
  await pagina.close();
}

/*
 * 3b. Cada entrada na VSL conta o SEU tempo — recarregar reinicia a contagem.
 *
 * Este caso já verificou o contrário. A contagem ficava no sessionStorage para
 * sobreviver ao celular descartar a aba quando a pessoa troca de app, e o teste
 * exigia que o relógio continuasse de onde parou.
 *
 * O que derrubou aquela ideia: o passo do funil NÃO é persistido. Quem recarrega
 * volta para a primeira tela e refaz o quiz inteiro, o que leva minutos — e o
 * relógio antigo seguia correndo durante a refeita. Quando a pessoa chegava de
 * novo na VSL, a espera já tinha vencido e o botão de compra aparecia de cara,
 * antes de o vídeo dizer o preço. Era exatamente o que a espera existe para
 * impedir, e acontecia com quem tinha MAIS interesse: quem voltou.
 *
 * O atalho `?tela=13` usado aqui não existe para o cliente; ele serve para
 * chegar à VSL sem refazer o quiz. Recarregar com ele é a única forma de cair
 * duas vezes na tela da oferta, e o correto é a contagem recomeçar.
 */
{
  const pagina = await (await novoContexto()).newPage();
  await pagina.goto(BASE + '/?tela=13&cta=20', { waitUntil: 'domcontentloaded' });
  await pagina.waitForTimeout(14000);
  const recarregouEm = Date.now();
  await pagina.reload({ waitUntil: 'domcontentloaded' });

  // Passados 24 s da PRIMEIRA abertura o botão ainda não pode estar visível:
  // a contagem válida é a que começou no recarregamento.
  const faltamParaOsVinteEQuatro = 24000 - (Date.now() - (recarregouEm - 14000));
  if (faltamParaOsVinteEQuatro > 0) await pagina.waitForTimeout(faltamParaOsVinteEQuatro);

  const cedoDemais = await pagina.getByRole('button', { name: BOTAO }).isVisible().catch(() => false);
  checar(!cedoDemais, 'recarregar REINICIA a contagem (o relogio velho nao vale)');

  // E aos 20 s contados do recarregamento, aparece.
  const faltam = 24000 - (Date.now() - recarregouEm);
  if (faltam > 0) await pagina.waitForTimeout(faltam);

  const depois = await pagina.getByRole('button', { name: BOTAO }).isVisible().catch(() => false);
  checar(depois, 'a contagem reiniciada tambem libera o botao no fim');
  await pagina.close();
}

/*
 * 4. Clicar no botão revela o checkout abaixo do vídeo — e o vídeo NÃO pode parar.
 *
 * O checkout chegou a ser uma camada por cima da VSL e voltou a ser revelado na
 * própria página, a pedido do dono em 08/08/2026.
 *
 * O que continua valendo nos dois formatos, e é invisível olhando a tela: o
 * `<wistia-player>` precisa continuar montado. Se ele for desmontado, o vídeo
 * para, perde o ponto e recomeça do zero — e a VSL deixa de vender justamente
 * enquanto a pessoa preenche os dados, que é quando ela mais hesita.
 */
{
  const pagina = await (await novoContexto()).newPage();
  await pagina.goto(BASE + '/?tela=13&cta=0', { waitUntil: 'domcontentloaded' });
  await pagina.waitForTimeout(1200);

  // Marca o player para reconhecer, depois, se é o MESMO elemento.
  await pagina.evaluate(() => {
    document.querySelector('wistia-player')?.setAttribute('data-marca-de-teste', 'antes');
  });

  await pagina.getByRole('button', { name: BOTAO }).click();
  await pagina.waitForTimeout(1200);

  const checkout = await pagina.getByText('Não deixe essa decisão').isVisible().catch(() => false);
  checar(checkout, 'clicar no botao abre o checkout');

  const marca = await pagina.evaluate(
    () => document.querySelector('wistia-player')?.getAttribute('data-marca-de-teste') ?? null,
  );
  checar(marca === 'antes', 'o MESMO player continua montado: o video nao reinicia');

  // O checkout fica na propria pagina, sem camada por cima.
  const semCamada = (await pagina.locator('[role="dialog"]').count()) === 0;
  checar(semCamada, 'o checkout fica na pagina, sem popup');

  // E o video segue visivel na tela, acima do formulario.
  const videoNaPagina = await pagina.locator('wistia-player').isVisible().catch(() => false);
  checar(videoNaPagina, 'o video continua na pagina com o checkout aberto');

  await pagina.close();
}

// 5. Sem atalho, o funil começa no começo.
{
  const pagina = await (await novoContexto()).newPage();
  await pagina.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await pagina.waitForTimeout(1200);
  const hero = await pagina.getByText('Essa é a resposta que você pediu em oração.').isVisible().catch(() => false);
  checar(hero, 'sem atalho: o funil comeca no hero');
  await pagina.close();
}

if (erros.length > 0) {
  console.log('\n  erros de javascript na pagina:');
  for (const e of erros) console.log('    ' + e);
  tudoOk = false;
}

for (const ctx of contextos) await ctx.close();
await navegador.close();
console.log(`\n${tudoOk ? 'TODOS OS TESTES PASSARAM' : 'ALGUM TESTE FALHOU'}\n`);
process.exit(tudoOk ? 0 : 1);
