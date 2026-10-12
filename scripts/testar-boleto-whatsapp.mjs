/**
 * Audita o caminho do BOLETO MANUAL: escolher boleto -> preencher -> os dados
 * irem para o WhatsApp de quem vai emitir.
 *
 *   npm run teste            (noutro terminal)
 *   PLAYWRIGHT_DIR=~/teste-funil node scripts/testar-boleto-whatsapp.mjs
 *
 * Enquanto não há provedor que emita boleto por API (17/08/2026), a opção do
 * checkout abre uma conversa no WhatsApp levando os dados do pagador, e alguém
 * emite o documento à mão. Esta bateria existe porque essa mensagem é a única
 * coisa que separa a venda de um atendimento que começa com quatro perguntas.
 *
 * O que ela protege, e por que cada item importa:
 *
 *  - CPF OBRIGATÓRIO. Boleto sem CPF não existe. Se o campo virar opcional
 *    outra vez, a conversa começa pedindo o dado que a tela já tinha à mão.
 *  - OS QUATRO DADOS NA MENSAGEM (nome, CPF, e-mail, telefone). Faltando um,
 *    quem atende precisa perguntar — e cada pergunta perde gente.
 *  - O CPF VAI FORMATADO. É assim que ele é digitado no sistema do banco;
 *    conferir 11 dígitos corridos no celular é onde nasce o boleto no nome
 *    errado.
 *  - A TELA AVISA QUE FALTA TOCAR EM ENVIAR. O WhatsApp abre com o texto
 *    pronto, mas não envia sozinho. Sem esse aviso, a pessoa fecha a aba
 *    achando que já pediu, e ninguém do outro lado recebe nada.
 */
import path from 'node:path';
import { createRequire } from 'node:module';
const { chromium } = createRequire(path.resolve(process.env.PLAYWRIGHT_DIR) + path.sep)('playwright');
let ok = true;
const checar = (b, d, e) => { console.log(`  ${b ? 'PASSOU' : 'FALHOU'}  ${d}${e && !b ? ' -> ' + e : ''}`); if (!b) ok = false; };
const nav = await chromium.launch();
const ctx = await nav.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const p = await ctx.newPage();
const erros = [];
p.on('pageerror', (e) => erros.push(String(e.message)));
p.on('console', (m) => { if (m.type() === 'error') erros.push(m.text().slice(0,160)); });

await p.goto('http://localhost:4300/?tela=13&cta=0', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(1400);
await p.getByRole('button', { name: 'SIM, EU QUERO A ORAÇÃO COMPLETA E CONSAGRADA' }).click();
await p.waitForTimeout(1200);

const opcao = (await p.locator('[role="radio"]').nth(1).textContent() || '').replace(/\s+/g,' ');
checar(/Boleto banc/i.test(opcao), 'a opcao se chama Boleto bancario', opcao);
checar(/ENVIAMOS PELO WHATSAPP/i.test(opcao), 'a tarja diz que enviamos pelo WhatsApp', opcao);
checar(/emite o boleto no seu nome/i.test(opcao), 'o texto explica que a equipe emite', opcao);

await p.getByRole('radio', { name: /Boleto banc/ }).click();
await p.waitForTimeout(400);
const rotulo = (await p.getByRole('button', { name: /GERAR BOLETO|QUERO MINHA/ }).textContent() || '').trim();
checar(/GERAR BOLETO DE R\$ 74,00/.test(rotulo), 'o botao diz GERAR BOLETO com o valor', rotulo);

// CPF obrigatorio neste caminho.
await p.getByPlaceholder('Seu nome completo').fill('Maria de Teste');
await p.getByPlaceholder('Seu melhor e-mail (onde chega o acesso)').fill('maria@exemplo.com');
await p.getByPlaceholder(/WhatsApp com DDD/).fill('11912345678');
const cpfObrig = await p.evaluate(() => document.querySelector('input[placeholder*="CPF"]')?.required);
checar(cpfObrig === true, 'o CPF e obrigatorio para gerar boleto');
const ph = await p.evaluate(() => document.querySelector('input[placeholder*="CPF"]')?.placeholder);
checar(/no boleto/i.test(ph || ''), 'o campo explica que o CPF vai no boleto', ph);

await p.getByPlaceholder(/CPF/).fill('52998224725');
await p.getByRole('button', { name: /GERAR BOLETO/ }).click();
await p.waitForTimeout(1500);

const href = await p.evaluate(() => document.querySelector('a[href*="wa.me"]')?.getAttribute('href') || ''); const msg = decodeURIComponent(href);
// "Contribuir", nunca "pagar": a mesma regra do resto do funil. Se esta linha
// falhar, alguem trocou a mensagem por uma de cobranca.
checar(/contribuir pelo boleto/i.test(msg), 'a mensagem diz CONTRIBUIR pelo boleto');
checar(!/quero pagar/i.test(msg), 'a mensagem NAO fala em pagar');
checar(/Nome: Maria de Teste/.test(msg), 'a mensagem leva o NOME');
checar(/CPF: 529\.982\.247-25/.test(msg), 'a mensagem leva o CPF formatado');
checar(/E-mail: maria@exemplo\.com/.test(msg), 'a mensagem leva o E-MAIL');
checar(/WhatsApp: \(11\) 91234-5678/.test(msg), 'a mensagem leva o TELEFONE');
checar(/Minha contribuição: R\$ 74,00/.test(msg), 'a mensagem leva o VALOR como contribuicao');
checar(/Arcanjo Miguel/.test(msg), 'a mensagem leva o PEDIDO');

const tela = await p.evaluate(() => document.body.innerText);
checar(/Seus dados foram enviados/.test(tela), 'a tela confirma o envio dos dados');
checar(/Toque em enviar/.test(tela), 'a tela avisa que precisa TOCAR EM ENVIAR no WhatsApp');
checar(erros.length === 0, 'nenhum erro de console', erros.join(' | '));

console.log('\n--- mensagem que vai para o WhatsApp ---');
console.log(msg.split('?text=')[1] || '(vazia)');

await nav.close();
console.log(`\n${ok ? 'TUDO OK' : 'HOUVE FALHA'}\n`);
process.exit(ok ? 0 : 1);



