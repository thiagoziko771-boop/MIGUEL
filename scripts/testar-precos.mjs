/**
 * Confere se a TELA diz o mesmo preço que o SERVIDOR cobra.
 *
 *   node scripts/testar-precos.mjs
 *
 * Roda em segundos, sem subir servidor nem navegador. Existe porque este é o
 * erro que mais se repetiu no projeto e o único que o cliente descobre sozinho:
 * o preço vive em server/catalog.ts, mas quem a pessoa lê é a copy em
 * src/data/funnelData.ts e o espelho em InlineCheckout.tsx. Trocar o preço num
 * lugar e esquecer do outro não quebra nada — a página abre, o PIX é gerado, e
 * a pessoa só descobre a diferença na hora de pagar.
 *
 * Já aconteceu três vezes em um único dia: a VSL falando R$ 47 com o checkout
 * cobrando R$ 27, o preço base duplicado em dois arquivos que sairam de
 * sincronia, e a âncora do downsell apontando para um preço de upsell que não
 * existia mais — prometendo um desconto inventado.
 *
 * O que se checa aqui é a coerência interna, não o valor certo. Qual preço
 * cobrar é decisão do dono; que a tela não minta sobre ele é obrigação nossa.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const raiz = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '..',
);

let tudoOk = true;
function checar(ok, descricao) {
  console.log(`  ${ok ? 'PASSOU' : 'FALHOU'}  ${descricao}`);
  if (!ok) tudoOk = false;
}

/*
 * Os módulos são TypeScript e importam irmãos com extensão .js: só o tsx
 * resolve isso. Mesmo caminho de scripts/testar-rastreamento.mjs.
 */
const pasta = mkdtempSync(path.join(tmpdir(), 'precos-'));
const arquivo = path.join(pasta, 'precos.test.mts');
const url = (relativo) => JSON.stringify(pathToFileURL(path.join(raiz, relativo)).href);

writeFileSync(
  arquivo,
  `
import { OFFER_DATA, UPSELL_DATA, DOWNSELL_DATA } from ${url('src/data/funnelData.ts')};
import { CATALOG } from ${url('server/catalog.ts')};
import { formatBRL } from ${url('server/utils.ts')};

const resultados: Array<[boolean, string]> = [];
const checar = (ok: boolean, descricao: string) => resultados.push([ok, descricao]);

/*
 * formatBRL e o formatador DO SERVIDOR -- o mesmo que escreve o valor que vai
 * na cobranca. Comparar com Intl.toLocaleString daria falso alarme: o Intl
 * separa "R$" do numero com espaco NAO-SEPARAVEL (U+00A0) e o texto escrito a
 * mao usa espaco comum. Os dois parecem iguais na tela e nunca sao iguais no
 * ===, o que faria esta bateria acusar erro onde nao ha.
 */
const preco = (id: string) => formatBRL(CATALOG[id].priceCents);
const numero = (texto: string) => Number(texto.replace(/[^\\d,]/g, '').replace(',', '.'));

// 1. A tela diz o que o servidor cobra.
checar(OFFER_DATA.offerPrice === preco('main'),
  'principal: a tela diz ' + OFFER_DATA.offerPrice + ' e o catalogo cobra ' + preco('main'));
checar(UPSELL_DATA.offerPrice === preco('upsell'),
  'upsell: a tela diz ' + UPSELL_DATA.offerPrice + ' e o catalogo cobra ' + preco('upsell'));
checar(DOWNSELL_DATA.offerPrice === preco('downsell'),
  'downsell: a tela diz ' + DOWNSELL_DATA.offerPrice + ' e o catalogo cobra ' + preco('downsell'));

// 2. Toda ancora riscada e MAIOR que o preco que ela ancora. Igual ou menor
//    anuncia desconto de zero (ou negativo) com cara de oferta.
for (const [nome, dados] of [['principal', OFFER_DATA], ['upsell', UPSELL_DATA], ['downsell', DOWNSELL_DATA]] as const) {
  checar(numero(dados.originalPrice) > numero(dados.offerPrice),
    nome + ': a ancora ' + dados.originalPrice + ' e maior que o preco ' + dados.offerPrice);
}

/*
 * 3. A ancora do downsell e o preco REAL do upsell.
 *
 * Ela nao e um numero de enfeite: e exatamente o que a pessoa acabou de
 * recusar na tela anterior. Quando o upsell muda de preco e a ancora fica para
 * tras, a tela passa a riscar um valor que nao existe em lugar nenhum.
 */
checar(DOWNSELL_DATA.originalPrice === preco('upsell'),
  'a ancora do downsell (' + DOWNSELL_DATA.originalPrice + ') e o preco do upsell (' + preco('upsell') + ')');

// 4. O selo de desconto bate com a conta, com 1 ponto de folga para arredondar.
const real = Math.round((1 - numero(DOWNSELL_DATA.offerPrice) / numero(DOWNSELL_DATA.originalPrice)) * 100);
const prometido = Number(DOWNSELL_DATA.discountLabel.match(/\\d+/)?.[0]);
checar(Math.abs(real - prometido) <= 1,
  'o selo do downsell promete ' + prometido + '% e o desconto real e ' + real + '%');

// 5. O botao repete o mesmo preco do resto da tela.
checar(DOWNSELL_DATA.ctaText.includes(DOWNSELL_DATA.offerPrice),
  'o botao do downsell repete ' + DOWNSELL_DATA.offerPrice);

/*
 * 6. Piso da PixGo: R$ 10,00 por cobranca (INVALID_AMOUNT abaixo disso). Vale
 *    para upsell e downsell, que sao cobrados sozinhos. Os bumps nao entram:
 *    eles so somam ao pedido principal, nunca viram cobranca separada.
 */
for (const id of ['main', 'upsell', 'downsell']) {
  checar(CATALOG[id].priceCents >= 1000,
    id + ' custa ' + preco(id) + ', no minimo de R$ 10,00 da PixGo ou acima');
}

console.log(JSON.stringify(resultados));
`,
  'utf8',
);

console.log('\n== A tela diz o mesmo que o servidor cobra? ==\n');

const saida = spawnSync('npx', ['tsx', arquivo], {
  cwd: raiz,
  shell: process.platform === 'win32',
  encoding: 'utf8',
});

try {
  const ultima = (saida.stdout ?? '').trim().split('\n').at(-1);
  for (const [ok, descricao] of JSON.parse(ultima)) checar(ok, descricao);
} catch {
  checar(false, `a bateria rodou -> ${(saida.stderr ?? '').slice(0, 400)}`);
}

console.log(tudoOk ? '\nTODOS OS TESTES PASSARAM\n' : '\nHOUVE FALHAS\n');
process.exit(tudoOk ? 0 : 1);
