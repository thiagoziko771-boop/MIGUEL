/**
 * Verifica o pulso dos botoes de compra.
 *
 * Tres coisas que so se pegam medindo: se o pulso esta realmente rodando, se
 * ele NAO briga com o transform que o motion escreve no clique (o defeito seria
 * o botao travar bem na hora da compra) e se some para quem pediu menos
 * movimento no sistema.
 */
import path from 'node:path';
import { createRequire } from 'node:module';

const { chromium } = createRequire(path.resolve(process.env.PLAYWRIGHT_DIR) + path.sep)('playwright');
const BASE = process.argv[2];
const BOTAO = 'SIM, EU QUERO A ORAÇÃO COMPLETA E CONSAGRADA';

let tudoOk = true;
function checar(ok, d, extra) {
  console.log(`  ${ok ? 'PASSOU' : 'FALHOU'}  ${d}${extra ? '  (' + extra + ')' : ''}`);
  if (!ok) tudoOk = false;
}

const navegador = await chromium.launch();

// --- 1. Movimento normal ---------------------------------------------------
{
  const contexto = await navegador.newContext({ viewport: { width: 390, height: 844 } });
  const pagina = await contexto.newPage();
  console.log(`\nPulso dos botoes em ${BASE}\n`);

  await pagina.goto(`${BASE}/?tela=13&cta=0`, { waitUntil: 'networkidle' });
  const cta = pagina.getByRole('button', { name: BOTAO });
  await cta.waitFor({ state: 'visible', timeout: 20000 });

  const anim = await cta.evaluate((el) => {
    const s = getComputedStyle(el);
    return { nome: s.animationName, duracao: s.animationDuration, repete: s.animationIterationCount };
  });
  checar(anim.nome !== 'none', 'o botao de compra tem animacao', anim.nome);
  checar(anim.repete === 'infinite', 'a animacao repete sem parar');

  // A sombra precisa MUDAR ao longo do tempo: animacao declarada mas parada
  // passaria na checagem acima e nao pulsaria nada.
  const a = await cta.evaluate((el) => getComputedStyle(el).boxShadow);
  await pagina.waitForTimeout(700);
  const b = await cta.evaluate((el) => getComputedStyle(el).boxShadow);
  checar(a !== b, 'a sombra muda com o tempo (esta pulsando de verdade)');

  // O clique nao pode ser afetado: o motion escreve transform, o pulso so sombra.
  const usaTransform = await cta.evaluate((el) => {
    const folhas = [...document.styleSheets];
    for (const folha of folhas) {
      let regras;
      try { regras = [...folha.cssRules]; } catch { continue; }
      for (const regra of regras) {
        if (regra.type === CSSRule.KEYFRAMES_RULE && regra.name === 'pulsoDeCompra') {
          return [...regra.cssRules].some((q) => q.style.transform);
        }
      }
    }
    return false;
  });
  checar(!usaTransform, 'o pulso NAO usa transform (nao briga com o toque)');

  // E o botao continua clicavel e funcional.
  await cta.click();
  await pagina.waitForTimeout(1000);
  checar(
    await pagina.getByText('Não deixe essa decisão').isVisible().catch(() => false),
    'o botao pulsando continua abrindo o checkout',
  );

  // O botao de gerar PIX tambem pulsa.
  const pix = pagina.getByRole('button', { name: /QUERO MINHA ORAÇÃO/ });
  await pix.scrollIntoViewIfNeeded();
  const animPix = await pix.evaluate((el) => getComputedStyle(el).animationName);
  checar(animPix !== 'none', 'o botao de gerar PIX tambem pulsa', animPix);

  // O "Continuar" do quiz NAO pulsa: se tudo pulsa, nada aponta.
  await pagina.goto(`${BASE}/?tela=11`, { waitUntil: 'networkidle' });
  const continuar = pagina.getByRole('button', { name: 'Continuar' }).first();
  if (await continuar.isVisible().catch(() => false)) {
    const animQuiz = await continuar.evaluate((el) => getComputedStyle(el).animationName);
    checar(animQuiz === 'none', 'o "Continuar" do quiz NAO pulsa', animQuiz);
  }

  await contexto.close();
}

// --- 2. Quem pediu menos movimento ----------------------------------------
{
  const contexto = await navegador.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
  });
  const pagina = await contexto.newPage();
  await pagina.goto(`${BASE}/?tela=13&cta=0`, { waitUntil: 'networkidle' });
  const cta = pagina.getByRole('button', { name: BOTAO });
  await cta.waitFor({ state: 'visible', timeout: 20000 });

  const anim = await cta.evaluate((el) => getComputedStyle(el).animationName);
  checar(anim === 'none', 'com "menos movimento" no sistema, o pulso some', anim);
  await contexto.close();
}

await navegador.close();
console.log(`\n${tudoOk ? 'TODOS OS TESTES PASSARAM' : 'ALGUM TESTE FALHOU'}\n`);
process.exit(tudoOk ? 0 : 1);
