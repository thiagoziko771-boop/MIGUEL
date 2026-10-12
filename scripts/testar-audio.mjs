/**
 * Prova que a etapa de audio toca a GRAVACAO, e nao a voz sintetica.
 *
 * O defeito que isto pega e mudo por natureza: se o arquivo nao for servido, ou
 * o <audio> nao existir, a tela continua bonita e o player continua clicavel --
 * so que ninguem ouve nada. Era exatamente o que acontecia antes, com
 * SpeechSynthesis: nao falhava, so nao falava.
 *
 * Precisa do backend em modo mock servindo o dist/ (o mp3 vive em public/):
 *
 *   PIX_MODE=mock PORT=3387 SERVE_STATIC=true npx tsx server/index.ts
 *   PLAYWRIGHT_DIR=~/teste-funil node scripts/testar-audio.mjs http://localhost:3387
 */
import path from 'node:path';
import { createRequire } from 'node:module';

const { chromium } = createRequire(path.resolve(process.env.PLAYWRIGHT_DIR) + path.sep)('playwright');
const BASE = process.argv[2];

let tudoOk = true;
function checar(ok, descricao, extra) {
  console.log(`  ${ok ? 'PASSOU' : 'FALHOU'}  ${descricao}${extra ? '  (' + extra + ')' : ''}`);
  if (!ok) tudoOk = false;
}

const navegador = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const contexto = await navegador.newContext({ viewport: { width: 390, height: 844 } });
const pagina = await contexto.newPage();
const erros = [];
pagina.on('pageerror', (e) => erros.push(e.message));

console.log(`\nEtapa de audio em ${BASE}\n`);

// A etapa do audio e a 7 na ordem do funil (App.tsx, SCREEN 7).
let achou = false;
for (const tela of [7, 6, 8, 9, 10]) {
  await pagina.goto(`${BASE}/?tela=${tela}`, { waitUntil: 'networkidle' });
  await pagina.waitForTimeout(900);
  if (await pagina.locator('audio').count()) { achou = true; console.log(`  (a etapa de audio e a tela ${tela})`); break; }
}
checar(achou, 'a etapa de audio existe no funil');

if (achou) {
  const audio = pagina.locator('audio');
  const src = await audio.getAttribute('src');
  checar(Boolean(src && src.endsWith('.mp3')), 'o player aponta para um ARQUIVO mp3', src);

  // O arquivo precisa existir de verdade no servidor.
  const resposta = await pagina.request.get(`${BASE}${src}`);
  checar(resposta.status() === 200, 'o servidor entrega o arquivo', `HTTP ${resposta.status()}`);
  const bytes = (await resposta.body()).length;
  checar(bytes > 100000, 'o arquivo tem conteudo de verdade', `${(bytes / 1024 / 1024).toFixed(2)} MB`);

  // A duracao vem do proprio arquivo, e nao de um numero escrito na mao.
  await pagina.waitForTimeout(2500);
  const duracao = await audio.evaluate((el) => el.duration);
  checar(Number.isFinite(duracao) && duracao > 10, 'a duracao e lida do arquivo', `${duracao?.toFixed(1)} s`);

  /*
   * A tela e so a copy e o player: sem titulo, sem contador e sem instrucao.
   * E um recado de voz, e recado de voz nao vem rotulado. Se algum texto voltar
   * a aparecer ao redor do player, este caso avisa.
   */
  const contador = await pagina.getByText(/\d:\d\d \/ \d:\d\d/).count();
  checar(contador === 0, 'nao ha contador de tempo na tela');
  const instrucao = await pagina.getByText(/Clique no botão de reproduzir/i).count();
  checar(instrucao === 0, 'nao ha texto de instrucao abaixo do player');

  // E o mais importante: apertar play faz o audio ANDAR.
  await pagina.getByRole('button', { name: /Tocar áudio/i }).click();
  await pagina.waitForTimeout(2500);
  const tocou = await audio.evaluate((el) => ({ tempo: el.currentTime, pausado: el.paused }));
  checar(tocou.tempo > 0.4 && !tocou.pausado, 'apertar play faz o audio TOCAR', `andou ${tocou.tempo.toFixed(1)} s`);

  // Pausar precisa pausar de verdade.
  await pagina.getByRole('button', { name: /Pausar áudio/i }).click();
  await pagina.waitForTimeout(700);
  checar(await audio.evaluate((el) => el.paused), 'apertar pausa para o audio');
}

if (erros.length) {
  console.log('\n  erros de javascript:');
  for (const e of erros) console.log('    ' + e);
  tudoOk = false;
}

await navegador.close();
console.log(`\n${tudoOk ? 'TODOS OS TESTES PASSARAM' : 'ALGUM TESTE FALHOU'}\n`);
process.exit(tudoOk ? 0 : 1);
