import { config } from './config.js';
import { logger } from './logger.js';
import { getDeliverables } from './delivery.js';
import { assinarAbertura, assinarEntrega, assinarRecuperacao } from './painel/sessao.js';
import { saveOrder } from './store/index.js';
import type { Order } from './store/types.js';

/**
 * O e-mail com os acessos, enviado quando o pagamento é confirmado.
 *
 * A tela do checkout e a /obg prometem esse e-mail desde o primeiro dia, e até
 * aqui nada era enviado. Quem fechava a aba antes de anotar o link perdia o que
 * tinha acabado de comprar — e o público deste funil é justamente quem tem menos
 * intimidade com tecnologia. Cada um desses vira chamado no WhatsApp ou pedido
 * de reembolso.
 *
 * TRÊS REGRAS, todas herdadas do que já vale para o rastreamento:
 *
 *  1. NUNCA lança. Falhar em enviar e-mail não pode derrubar a confirmação do
 *     pagamento nem a liberação do acesso. O cliente pagou; o produto é dele
 *     mesmo que o provedor de e-mail esteja fora do ar.
 *  2. Aguardado com orçamento curto. Na Vercel a função congela assim que
 *     responde, então promessa solta não executa — e a PixGo desiste do webhook
 *     em ~10 s.
 *  3. É o ÚNICO arquivo que conhece o provedor. O resto do sistema chama
 *     `enviarEmailDeAcesso` e não sabe se por trás tem Resend, SendGrid ou
 *     pombo-correio.
 *
 * O e-mail leva o MESMO link assinado que o botão "reenviar entrega" do painel
 * gera — a página de entrega já existe, já é testada, e continua funcionando
 * mesmo quando os links dos produtos ainda não foram preenchidos. Mandar os
 * links dos produtos direto no corpo seria duplicar essa lógica e criar um
 * segundo lugar para ela ficar desatualizada.
 */

/** As mesmas 72 h do link que o painel gera à mão. */
const HORAS_DE_VALIDADE = 72;

export interface ResultadoDoEnvio {
  enviado: boolean;
  /** Por que não foi, quando não foi. Vai para o log e para o painel. */
  motivo?: string;
  /** Id da mensagem no provedor, quando ele devolve um. Serve para achá-la no painel dele. */
  provedorId?: string | null;
}

export function emailAtivo(): boolean {
  return Boolean(config.email.apiKey && config.painel.chaveMestra);
}

/* -------------------------------------------------------------------------- */
/* Texto                                                                       */
/* -------------------------------------------------------------------------- */

function escaparHtml(texto: string): string {
  return texto.replace(/[&<>"']/g, (caractere) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[caractere] as string;
  });
}

/**
 * O telefone como a pessoa lê, para ela conferir se acertou.
 *
 * A Oração vai por WhatsApp, então um dígito errado no checkout é a entrega
 * inteira perdida — e perdida em silêncio, porque ninguém reclama de uma
 * mensagem que nunca soube que ia receber.
 */
function telefoneVisivel(bruto: string): string {
  const d = (bruto ?? '').replace(/\D/g, '').replace(/^55/, '');
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return bruto ?? '';
}

/** Primeiro nome, para o e-mail falar com a pessoa e não com o cadastro. */
function primeiroNome(completo: string): string {
  const primeiro = (completo ?? '').trim().split(/\s+/)[0] ?? '';
  if (!primeiro) return '';
  return primeiro.charAt(0).toUpperCase() + primeiro.slice(1).toLowerCase();
}

/* -------------------------------------------------------------------------- */
/* As peças visuais, compartilhadas pelos dois e-mails                         */
/* -------------------------------------------------------------------------- */

/*
 * A identidade da oferta, em variáveis, para os dois e-mails não divergirem.
 *
 * São as mesmas cores do funil (src/index.css): o ouro velho e o ouro vivo do
 * botão, o quase-preto do fundo das telas. Quem clicou no anúncio, passou pelo
 * quiz e chegou ao checkout viu essa paleta o caminho inteiro — o e-mail
 * chegando com outra cara lê como remetente diferente, e neste ramo isso
 * significa golpe.
 */
const OURO_VELHO = '#d4af37';
const OURO_VIVO = '#f2ca50';
const QUASE_PRETO = '#131313';
const PAPEL = '#F4F1EC';
const TINTA = '#2C2416';
const TINTA_FRACA = '#7A7570';

/*
 * Serifada nos títulos, sem serifa no corpo — o mesmo par do site.
 *
 * As fontes do site (Caslon, Work Sans) não existem em cliente de e-mail e
 * baixar arquivo de fonte é bloqueado na maioria deles. Georgia é a serifada
 * que praticamente todo aparelho tem, e é a que mais se aproxima do desenho do
 * Caslon: mesma cor de texto na página, mesma sensação de missal.
 */
const FONTE_TITULO = "Georgia,'Times New Roman',serif";
const FONTE_CORPO = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif";

/**
 * A arte do Arcanjo, em endereço absoluto.
 *
 * Caminho relativo não existe em e-mail: a mensagem é lida dentro do Gmail ou
 * do aplicativo do celular, onde `/images/...` aponta para o servidor deles.
 * O domínio sai da configuração para o e-mail nunca apontar para o ambiente
 * errado, e cai no domínio público quando `PUBLIC_BASE_URL` não estiver posta —
 * um link quebrado aqui é uma imagem faltando na frente do cliente.
 */
const ARTE_DO_ANJO = `${(config.publicBaseUrl || 'https://rezassagradas.site').replace(/\/+$/, '')}/images/arcanjo-email.jpg`;

/**
 * O topo escuro com a marca e a arte do Arcanjo, igual nos dois e-mails.
 *
 * `background` sólido ANTES do gradiente de propósito: o Outlook ignora
 * `linear-gradient` e ficaria com o fundo transparente — texto dourado sobre
 * branco, ilegível. Com o sólido declarado primeiro, quem não entende o
 * gradiente fica com o quase-preto, que é o pior caso aceitável.
 *
 * A ARTE VEM DEPOIS DO NOME, e não atrás dele. Texto sobreposto a imagem some
 * junto com ela: quase todo cliente de e-mail bloqueia imagem por padrão até a
 * pessoa liberar, e um e-mail que abre sem cabeçalho nenhum não se identifica.
 * Assim, quando a imagem não carrega, o e-mail continua se apresentando e só
 * perde a ilustração.
 *
 * JPG, e não o WebP que o site usa: o Outlook não abre WebP e mostraria o
 * quadrado de imagem quebrada. É a mesma arte, recortada em faixa e
 * comprimida — 72 KB, porque parte deste público abre e-mail no 4G.
 */
function cabecalho(chapeu: string): string {
  return `
  <tr><td style="background:${QUASE_PRETO};background-image:linear-gradient(160deg,#1c1a15 0%,${QUASE_PRETO} 55%,#241f14 100%);padding:30px 24px 22px;text-align:center;border-radius:16px 16px 0 0">
    <p style="margin:0 0 12px;font-family:${FONTE_TITULO};font-size:23px;letter-spacing:.03em;color:${OURO_VIVO}">
      Rezas Sagradas
    </p>
    <p style="margin:0;font-family:${FONTE_CORPO};font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:rgba(242,202,80,.72)">
      ${chapeu}
    </p>
  </td></tr>
  <tr><td style="padding:0;font-size:0;line-height:0;background:${QUASE_PRETO}">
    <img src="${ARTE_DO_ANJO}" width="560" alt="São Miguel Arcanjo"
         style="display:block;width:100%;max-width:560px;height:auto;border:0;outline:none;text-decoration:none">
  </td></tr>`;
}

/**
 * Um passo numerado, em linha própria.
 *
 * Numerado e empilhado, não em três colunas como se vê em e-mail de empresa de
 * tecnologia: em tela de celular as três colunas encolhem a ponto de o texto
 * quebrar letra a letra, e boa parte deste público lê com a fonte do sistema
 * aumentada, o que piora. Empilhado ocupa mais rolagem e continua legível.
 */
function passo(numero: number, titulo: string, detalhe: string): string {
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 10px">
    <tr>
      <td width="34" valign="top" style="padding-top:2px">
        <div style="width:26px;height:26px;line-height:26px;border-radius:50%;background:${OURO_VIVO};color:#241a00;font-family:${FONTE_CORPO};font-size:13px;font-weight:700;text-align:center">${numero}</div>
      </td>
      <td valign="top" style="font-family:${FONTE_CORPO}">
        <p style="margin:0 0 2px;font-size:15px;font-weight:600;color:${TINTA}">${titulo}</p>
        <p style="margin:0;font-size:14px;line-height:1.5;color:${TINTA_FRACA}">${detalhe}</p>
      </td>
    </tr>
  </table>`;
}

/** O rodapé, com o aviso de que dá para responder. */
function rodape(pedidoId: string): string {
  return `
  <tr><td style="padding:22px 26px 28px;border-top:1px solid #EDE7DE;text-align:center;font-family:${FONTE_CORPO}">
    <p style="margin:0 0 6px;font-size:13px;line-height:1.6;color:${TINTA_FRACA}">
      Qualquer dúvida, é só <strong style="color:${TINTA}">responder este e-mail</strong>. Uma pessoa lê.
    </p>
    <p style="margin:0;font-size:11px;color:#B3ACA3">Pedido ${escaparHtml(pedidoId)}</p>
  </td></tr>`;
}

/** A moldura: fundo, cartão centralizado e cantos arredondados. */
function moldura(miolo: string, previa = ''): string {
  /*
   * A PRÉVIA é a segunda linha da caixa de entrada, e ela existia vazia.
   *
   * Depois do assunto, o Gmail mostra o começo do corpo. Sem uma prévia
   * declarada, o que ele mostrava era o texto do cabeçalho — "Rezas Sagradas
   * Falta só o último passo" —, ou seja, o assunto repetido em outras palavras.
   * Uma linha desperdiçada bem no lugar onde a pessoa decide se abre.
   *
   * O truque é o padrão do mercado: um bloco escondido no topo, com altura e
   * opacidade zero, que o cliente de e-mail lê para a prévia e nunca desenha na
   * tela. Os caracteres invisíveis no fim empurram para longe qualquer sobra do
   * HTML que viria depois.
   */
  const cabecalhoInvisivel = previa
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${escaparHtml(previa)}` +
      `${'&#847;&zwnj;&nbsp;'.repeat(60)}</div>`
    : '';

  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:0;background:${PAPEL};font-family:${FONTE_CORPO};color:${TINTA}">
  ${cabecalhoInvisivel}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPEL};padding:26px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #EAE3D8">
        ${miolo}
      </table>
      <p style="margin:16px 0 0;font-family:${FONTE_CORPO};font-size:11px;color:#B3ACA3">
        Rezas Sagradas &middot; rezassagradas.site
      </p>
    </td></tr>
  </table>
</body></html>`;
}

/**
 * Corpo do e-mail.
 *
 * HTML simples e tabela de uma coluna de propósito: este público abre e-mail no
 * aplicativo nativo de celular antigo, onde layout de coluna dupla e CSS moderno
 * quebram. O texto também vai em versão pura, porque cliente de e-mail que
 * bloqueia HTML mostraria uma mensagem vazia — e uma mensagem vazia depois de
 * uma compra parece golpe.
 */
function montarCorpo(order: Order, urlDeAcesso: string, itens: string[]): { html: string; texto: string } {
  const nome = primeiroNome(order.customer.name);
  const saudacao = nome ? `Que a paz esteja com você, ${escaparHtml(nome)}!` : 'Que a paz esteja com você!';

  /*
   * Cada item numa linha própria, com um sinal dourado à esquerda.
   *
   * Era `<ul>` com marcador do navegador. A lista dourada faz o pacote parecer
   * o que é — várias coisas entregues, não uma frase com bolinhas —, e quem
   * comprou dois bônus precisa ver os dois separados para saber que chegaram.
   */
  const lista = itens
    .map(
      (item) => `
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 8px">
            <tr>
              <td width="24" valign="top" style="font-size:15px;line-height:1.6;color:${OURO_VELHO}">&#10022;</td>
              <td valign="top" style="font-size:15px;line-height:1.6;color:${TINTA}">${escaparHtml(item)}</td>
            </tr>
          </table>`,
    )
    .join('');

  const html = moldura(`
        ${cabecalho('Pagamento confirmado')}
        <tr><td style="padding:30px 26px 8px">
          <h1 style="margin:0 0 14px;font-family:${FONTE_TITULO};font-size:25px;line-height:1.28;color:${TINTA}">${saudacao}</h1>
          <p style="margin:0 0 20px;font-size:16px;line-height:1.65;color:${TINTA}">
            A sua contribuição foi recebida e a sua <strong>Oração Sagrada do Arcanjo Miguel</strong>
            já está liberada. É só tocar no botão abaixo.
          </p>

          <p style="margin:0 0 10px;font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#A89060">
            O que você garantiu
          </p>
          <div style="padding:16px 18px 10px;background:#FBF8F2;border:1px solid #EFE7D8;border-radius:12px;margin:0 0 24px">
            ${lista}
          </div>

          <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr><td align="center">
            <a href="${urlDeAcesso}" style="display:block;background:#1F7A45;color:#ffffff;text-decoration:none;font-size:17px;font-weight:700;padding:17px 20px;border-radius:12px;text-align:center;letter-spacing:.02em">
              ACESSAR MINHA ORAÇÃO &rarr;
            </a>
          </td></tr></table>

          <p style="margin:18px 0 0;font-size:13px;line-height:1.6;color:${TINTA_FRACA}">
            Se o botão não abrir, copie e cole este endereço no seu navegador:<br>
            <span style="word-break:break-all;color:${TINTA}">${escaparHtml(urlDeAcesso)}</span>
          </p>

          <!--
            O prazo dito no e-mail, e não só na página.
            Quem paga uma oração espera algo imediato; se ninguém avisar que ela
            é rezada uma por uma, o silêncio de 24 horas vira chamado no
            WhatsApp e, no segundo dia, pedido de estorno.
          -->
          <div style="margin:22px 0 0;padding:18px 20px;background:#17150F;border-radius:12px">
            <p style="margin:0 0 10px;font-family:${FONTE_TITULO};font-size:17px;color:${OURO_VIVO}">
              Sua Oração já está sendo preparada
            </p>
            <p style="margin:0 0 10px;font-size:15px;line-height:1.65;color:#BDB5A6">
              O padre está rezando a Oração <strong style="color:#fff">dedicada ao seu nome</strong>.
              Não é um arquivo pronto que sai na hora — é feito para você, um por um.
            </p>
            <!--
              O CANAL PROMETIDO PRECISA SER O QUE EXISTE.

              Aqui dizia WhatsApp, e o número da operação foi restringido em
              13/08/2026. Prometer entrega por um canal que não funciona faz
              cada venda nascer com uma dívida que ninguém tem como pagar.

              Quando o WhatsApp voltar, muda-se este bloco E o equivalente em
              routes/admin.ts (paginaDeEntrega) — os dois juntos, sempre, senão
              a página promete uma coisa e o e-mail promete outra.
            -->
            <p style="margin:0 0 12px;font-size:15px;line-height:1.65;color:#BDB5A6">
              Ela chega <strong style="color:#fff">neste e-mail, em até 72 horas</strong>.
              Você não precisa fazer nada.
            </p>
            <p style="margin:12px 0 0;font-size:14px;line-height:1.6;color:#8A8375">
              Guarde esta mensagem: é por aqui que a sua Oração chega.
            </p>
          </div>

          <div style="margin:16px 0 6px;padding:14px 16px;background:#FBF8F2;border-left:3px solid ${OURO_VIVO};border-radius:0 8px 8px 0">
            <p style="margin:0;font-size:14px;line-height:1.6;color:${TINTA}">
              <strong>Guarde este e-mail.</strong> O link acima vale por ${HORAS_DE_VALIDADE} horas —
              se expirar, responda aqui que reenviamos na hora.
            </p>
          </div>
        </td></tr>
        ${rodape(order.id)}`, 'A sua Oração já está liberada — e o padre começou a rezar a sua hoje.');

  const texto = [
    saudacao.replace(/&[a-z]+;/g, ''),
    '',
    'A sua contribuição foi recebida e a sua Oração Sagrada do Arcanjo Miguel já está liberada.',
    '',
    // Mesma promessa da versão em HTML: quem lê o e-mail sem imagens precisa
    // saber por onde a Oração chega, ou vai esperar no lugar errado.
    'O padre está rezando a Oração dedicada ao seu nome. Ela chega neste e-mail,',
    'em até 72 horas. Guarde esta mensagem.',
    '',
    'O que você garantiu:',
    ...itens.map((item) => `- ${item}`),
    '',
    'Acesse aqui:',
    urlDeAcesso,
    '',
    `Guarde este e-mail. O link vale por ${HORAS_DE_VALIDADE} horas; se expirar, responda que reenviamos.`,
    '',
    `Pedido ${order.id}`,
  ].join('\n');

  return { html, texto };
}

/**
 * Corpo do lembrete de PIX gerado e não pago.
 *
 * O código copia-e-cola vai DENTRO do e-mail, e não um link de volta ao site.
 * Quem gerou o PIX e não pagou saiu para o aplicativo do banco e se perdeu no
 * caminho; devolvê-lo ao site obrigaria a refazer o percurso inteiro para
 * chegar ao mesmo código que já existe. Aqui ele cola e paga.
 *
 * O tom não cobra. Este público é religioso e o produto é uma oração — "não
 * identificamos seu pagamento" com urgência de loja soa como cobrança de
 * dívida, e a pessoa que já estava em dúvida desiste de vez.
 */
function montarCorpoDeRecuperacao(
  order: Order,
  codigo: string,
  paginaDoCodigo: string | null,
  codigoVivo: boolean,
): { html: string; texto: string } {
  const nome = primeiroNome(order.customer.name);
  const chamada = nome ? `${escaparHtml(nome)},` : 'Olá,';

  /* O botão só existe se a página existir. Botão morto é pior que nenhum. */
  const botaoCopiar = paginaDoCodigo
    ? `
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 18px"><tr><td align="center">
            <a href="${paginaDoCodigo}" style="display:block;background:linear-gradient(135deg,${OURO_VELHO},${OURO_VIVO});background-color:${OURO_VELHO};color:#241a00;text-decoration:none;font-size:17px;font-weight:700;padding:18px 20px;border-radius:12px;text-align:center;letter-spacing:.02em">
              ${codigoVivo ? 'ABRIR E COPIAR O CÓDIGO' : 'GERAR O MEU CÓDIGO AGORA'} &rarr;
            </a>
          </td></tr></table>
          <p style="margin:0 0 22px;font-size:13px;line-height:1.6;color:${TINTA_FRACA};text-align:center">
            ${codigoVivo
              ? 'Abre uma página com o código e um botão que copia sozinho.'
              : 'Leva um segundo. Os seus dados já estão lá — você não digita nada de novo.'}
          </p>`
    : '';

  /*
   * O aviso muda conforme o código ainda vale ou não.
   *
   * Um lembrete que chega com código morto e finge que ele está vivo manda a
   * pessoa até o aplicativo do banco para levar um "não" — e quem leva um "não"
   * do banco conclui que a loja é quebrada, não que o código venceu. Dizer a
   * verdade e oferecer o botão que resolve custa duas linhas e salva a venda.
   */
  const avisoDoPrazo = codigoVivo
    ? `<strong>Seu código vence em poucos minutos.</strong> Depois disso é preciso
              gerar outro do começo.`
    : `<strong>O código que você gerou já venceu</strong> — é o prazo do banco, não seu.
              Toque no botão abaixo e a gente faz outro na hora, com o seu pedido do jeito
              que você deixou.`;

  /* Código morto não vai no corpo: seria um convite a colar algo que já não funciona. */
  const blocoDoCodigo = codigoVivo
    ? `
          <p style="margin:0 0 8px;font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#A89060">
            ${paginaDoCodigo ? 'Ou copie daqui mesmo' : 'Seu código PIX'}
          </p>
          <div style="margin:0 0 20px;padding:16px 18px;background:#FBF8F2;border:1px solid #EFE7D8;border-radius:12px">
            <p style="margin:0;font-family:'Courier New',Courier,monospace;font-size:13px;line-height:1.6;word-break:break-all;color:${TINTA}">
              ${escaparHtml(codigo)}
            </p>
          </div>`
    : '';

  const passos = codigoVivo
    ? `${passo(1, 'Copie o código acima', 'Toque e segure sobre ele até aparecer "copiar".')}
          ${passo(2, 'Abra o aplicativo do seu banco', 'Procure a área de PIX e escolha "PIX Copia e Cola".')}
          ${passo(3, 'Cole e confirme', 'A sua Oração é liberada na hora, no seu e-mail.')}`
    : `${passo(1, 'Toque no botão acima', 'Um código novo é gerado na hora, com os seus dados.')}
          ${passo(2, 'Copie e abra o seu banco', 'Na área de PIX, escolha "PIX Copia e Cola".')}
          ${passo(3, 'Cole e confirme', 'A sua Oração é liberada na hora, no seu e-mail.')}`;

  const html = moldura(`
        ${cabecalho('Falta só o último passo')}
        <tr><td style="padding:32px 26px 8px">
          <p style="margin:0 0 20px;font-size:17px;line-height:1.6;color:${TINTA}">${chamada}</p>

          <p style="margin:0 0 10px;font-family:${FONTE_TITULO};font-size:27px;line-height:1.25;color:${TINTA}">
            Você já iniciou.
          </p>
          <p style="margin:0 0 24px;font-size:17px;line-height:1.7;color:${TINTA}">
            E já deu o passo mais difícil: o de decidir. Não desista agora de conquistar
            tudo aquilo que você deseja.
          </p>

          <p style="margin:0 0 18px;font-size:17px;line-height:1.7;color:${TINTA}">
            Não foi curiosidade que te levou até ali. Foi alguma coisa que está apertando —
            e você sabe o nome dela, mesmo que nunca tenha dito em voz alta para ninguém.
          </p>
          <p style="margin:0 0 26px;font-size:17px;line-height:1.7;color:${TINTA}">
            <strong>Miguel sabe também. Por isso você chegou até o fim.</strong>
          </p>

          <div style="margin:0 0 26px;padding:20px 22px;background:#FBF8F2;border-left:3px solid ${OURO_VIVO};border-radius:0 10px 10px 0">
            <p style="margin:0;font-size:17px;line-height:1.7;color:${TINTA}">
              O céu tem uma lei antiga: <strong>quem contribui, recebe.</strong> Não é troca
              de mercado. É reciprocidade. Você estende a mão, e ela volta cheia.
            </p>
          </div>

          <!--
            O aviso do prazo vem ANTES do código, não depois: quem lê no celular
            decide se vale a pena buscar o aplicativo do banco enquanto rola. Se
            a urgência aparecesse embaixo, chegaria depois da decisão.
          -->
          <div style="margin:0 0 18px;padding:14px 16px;background:#FFF4E5;border:1px solid #F0D9A8;border-radius:10px">
            <p style="margin:0;font-size:15px;line-height:1.6;color:#7A5A12">
              ${avisoDoPrazo}
            </p>
          </div>

          ${botaoCopiar}
          ${blocoDoCodigo}

          ${passos}

          <div style="margin:20px 0 6px;padding:16px 18px;background:#FBF8F2;border-left:3px solid ${OURO_VIVO};border-radius:0 8px 8px 0">
            <p style="margin:0 0 10px;font-size:15px;line-height:1.6;color:${TINTA}">
              Assim que a sua contribuição chegar, a sua Oração vai para o seu e-mail. Você não precisa
              fazer mais nada.
            </p>
            <p style="margin:0;font-size:16px;line-height:1.6;color:${TINTA}">
              <strong>Miguel esperou você chegar até aqui. Não deixe ele esperando na porta.</strong>
            </p>
          </div>

          <p style="margin:18px 0 0;font-size:13px;line-height:1.6;color:${TINTA_FRACA}">
            Se você já contribuiu, pode desconsiderar esta mensagem — às vezes o banco leva
            alguns minutos para nos avisar.
          </p>
        </td></tr>
        ${rodape(order.id)}`, codigoVivo
    ? 'O seu código ainda dá tempo. São dois toques para concluir.'
    : 'O prazo do banco venceu, mas a sua Oração continua reservada no seu nome.');

  const texto = [
    `${nome || 'Olá'},`,
    '',
    'Você já iniciou.',
    '',
    'E já deu o passo mais difícil: o de decidir. Não desista agora de conquistar',
    'tudo aquilo que você deseja.',
    '',
    'Não foi curiosidade que te levou até ali. Foi alguma coisa que está apertando',
    '— e você sabe o nome dela, mesmo que nunca tenha dito em voz alta para ninguém.',
    '',
    'Miguel sabe também. Por isso você chegou até o fim.',
    '',
    'O céu tem uma lei antiga: quem contribui, recebe. Não é troca de mercado.',
    'É reciprocidade. Você estende a mão, e ela volta cheia.',
    '',
    ...(codigoVivo
      ? [
        'ATENÇÃO: seu código vence em poucos minutos. Depois disso é preciso gerar',
        'outro do começo.',
        '',
        'SEU CÓDIGO PIX:',
        codigo,
        '',
        ...(paginaDoCodigo ? [`Ou abra e copie com um toque: ${paginaDoCodigo}`, ''] : []),
        '1. Copie o código acima',
        '2. Abra o aplicativo do seu banco, na área de PIX, em "PIX Copia e Cola"',
        '3. Cole e confirme',
      ]
      : [
        'O código que você gerou já venceu — é o prazo do banco, não seu.',
        'Gere outro agora, com o seu pedido do jeito que você deixou:',
        '',
        paginaDoCodigo ?? '',
        '',
        '1. Abra o endereço acima e toque no botão',
        '2. Copie o código novo e abra o seu banco, na área de PIX',
        '3. Cole em "PIX Copia e Cola" e confirme',
      ]),
    '',
    'Assim que a sua contribuição chegar, a sua Oração vai para o seu e-mail.',
    'Você não precisa fazer mais nada.',
    '',
    'Miguel esperou você chegar até aqui. Não deixe ele esperando na porta.',
    '',
    'Se você já contribuiu, pode desconsiderar — às vezes o banco leva alguns minutos.',
    '',
    'Qualquer dúvida, é só responder este e-mail. Uma pessoa lê.',
    '',
    `Pedido ${order.id}`,
  ].join('\n');

  return { html, texto };
}

/**
 * O e-mail da promoção de R$ 27,99 — a campanha que busca quem abandonou.
 *
 * A copy é a MESMA da campanha disparada à mão em 12-13/08/2026, que converteu
 * (Maria de Fátima, R$ 27,99, clicou dia 12 e pagou dia 13). Foi portada do
 * script avulso para cá em 14/08 pelo motivo de sempre: o script rodava fora
 * do servidor e exigia a chave do Resend na mão de quem dispara; aqui a chave
 * já mora, o envio ganha o selo de abertura, e o painel passa a mostrar
 * entrega e leitura como faz com os outros e-mails.
 *
 * "Até a meia-noite de hoje" com link de 48 h não é descuido: a urgência é da
 * mensagem, a validade folgada é para quem abre no dia seguinte não encontrar
 * a porta trancada. Quem clica depois da meia-noite ainda paga R$ 27,99 — o
 * preço de quem voltou vale mais que a coerência do relógio.
 */
function montarCorpoDeCampanha(order: Order, urlDaOferta: string): { html: string; texto: string } {
  const nome = primeiroNome(order.customer.name);
  const tratamento = nome ? `${escaparHtml(nome)}, Miguel não desistiu de você.` : 'Miguel não desistiu de você.';

  const miolo = `
  ${cabecalho('Um desconto abençoado, só hoje')}

  <tr><td style="padding:30px 26px 8px">
    <h1 style="margin:0 0 16px;font-family:${FONTE_TITULO};font-size:26px;line-height:1.28;color:${TINTA}">
      ${tratamento}
    </h1>

    <p style="margin:0 0 16px;font-size:16px;line-height:1.65;color:${TINTA}">
      Você chegou até o fim. Preencheu seus dados, gerou o código, e alguma coisa
      no meio do caminho a fez parar. Acontece — a vida chama, o telefone toca,
      o dia atropela.
    </p>

    <p style="margin:0 0 22px;font-size:16px;line-height:1.65;color:${TINTA}">
      Mas quem começa uma oração e não termina, fica com ela presa no peito.
      Então nós separamos <strong>um desconto abençoado</strong> para você
      concluir hoje o que já tinha começado.
    </p>

    <div style="margin:0 0 22px;padding:24px 20px;background:#17150F;border-radius:14px;text-align:center">
      <p style="margin:0 0 6px;font-family:${FONTE_CORPO};font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:${OURO_VIVO}">Somente hoje, para você</p>
      <p style="margin:0 0 4px;font-size:15px;color:#8A8375;text-decoration:line-through">de R$ 47,00</p>
      <p style="margin:0 0 2px;font-family:${FONTE_TITULO};font-size:44px;line-height:1;color:${OURO_VIVO}">R$ 27,99</p>
      <p style="margin:8px 0 0;font-size:13px;color:#BDB5A6">à vista, no PIX &middot; acesso imediato</p>
    </div>

    <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr><td align="center">
      <a href="${urlDaOferta}" style="display:block;background:linear-gradient(135deg,${OURO_VELHO},${OURO_VIVO});background-color:${OURO_VELHO};color:#241a00;text-decoration:none;font-size:17px;font-weight:700;padding:18px 20px;border-radius:12px;text-align:center;letter-spacing:.02em">
        QUERO RECEBER MINHA ORAÇÃO &rarr;
      </a>
    </td></tr></table>

    <div style="margin:22px 0 6px;padding:14px 16px;background:#FBF8F2;border-left:3px solid ${OURO_VIVO};border-radius:0 8px 8px 0">
      <p style="margin:0;font-size:14px;line-height:1.6;color:${TINTA}">
        <strong>Este valor vale até a meia-noite de hoje.</strong> Depois disso a
        Oração volta ao preço normal, e este código deixa de funcionar.
      </p>
    </div>
  </td></tr>

  ${rodape(order.id)}`;

  const texto = [
    nome ? `${nome}, Miguel não desistiu de você.` : 'Miguel não desistiu de você.',
    '',
    'Você chegou até o fim. Preencheu seus dados, gerou o código, e alguma coisa no',
    'meio do caminho a fez parar. Acontece.',
    '',
    'Separamos um desconto abençoado para você concluir hoje o que já tinha começado:',
    '',
    'DE R$ 47,00 POR R$ 27,99 — somente hoje.',
    '',
    'Toque aqui para receber a sua Oração:',
    urlDaOferta,
    '',
    'Este valor vale até a meia-noite de hoje.',
    '',
    'Qualquer dúvida, é só responder este e-mail. Uma pessoa lê.',
  ].join('\n');

  return { html: moldura(miolo, 'De R$ 47 por R$ 27,99, somente hoje — a sua Oração continua separada no seu nome.'), texto };
}

/** Assunto da campanha. Numa função para o exemplar e o disparo nunca divergirem. */
export function assuntoDeCampanha(order: Order): string {
  const nome = primeiroNome(order.customer.name);
  return nome ? `${nome}, Miguel ainda está esperando você` : 'Miguel ainda está esperando você';
}

/**
 * Envia a campanha de verdade, para o cliente do pedido, com selo de abertura e
 * registro no pedido (marca `campanha`). Nunca lança.
 */
export async function enviarEmailDeCampanha(order: Order, urlDaOferta: string): Promise<ResultadoDoEnvio> {
  try {
    if (!config.email.apiKey) return { enviado: false, motivo: 'EMAIL_API_KEY não configurada' };
    const destino = (order.customer.email ?? '').trim();
    if (!destino || !destino.includes('@')) return { enviado: false, motivo: 'pedido sem e-mail válido' };

    const { html, texto } = montarCorpoDeCampanha(order, urlDaOferta);
    return await entregarAoProvedor({
      destino,
      assunto: assuntoDeCampanha(order),
      html,
      texto,
      order,
      rotulo: 'da campanha',
      marca: 'campanha',
    });
  } catch (erro) {
    const motivo = (erro as Error)?.message ?? 'falha desconhecida';
    logger.error('Falha ao enviar o e-mail da campanha', { orderId: order.id, motivo });
    return { enviado: false, motivo };
  }
}

/**
 * O EXEMPLAR: a mesma peça, enviada ao e-mail do dono para aprovação.
 *
 * Regra da casa — nada vai a cliente sem o dono ter visto antes na própria
 * caixa de entrada. Sai SEM selo de abertura e SEM registro no pedido: o selo
 * carregaria o id do pedido do cliente, e a abertura do dono viraria "o
 * cliente leu" no painel — mentira de medição.
 */
export async function enviarExemplarDeCampanha(order: Order, urlDaOferta: string, destino: string): Promise<ResultadoDoEnvio> {
  try {
    if (!config.email.apiKey) return { enviado: false, motivo: 'EMAIL_API_KEY não configurada' };

    const { html, texto } = montarCorpoDeCampanha(order, urlDaOferta);
    const abortar = new AbortController();
    const relogio = setTimeout(() => abortar.abort(), config.email.timeoutMs);
    try {
      const resposta = await fetch(`${config.email.baseUrl}/emails`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.email.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: config.email.remetente,
          to: [destino],
          subject: `[EXEMPLAR] ${assuntoDeCampanha(order)}`,
          html,
          text: texto,
          ...(config.email.responderPara ? { reply_to: config.email.responderPara } : {}),
        }),
        signal: abortar.signal,
      });
      if (!resposta.ok) {
        const corpo = await resposta.text().catch(() => '');
        return { enviado: false, motivo: `provedor respondeu ${resposta.status}: ${corpo.slice(0, 200)}` };
      }
      return { enviado: true, provedorId: null };
    } finally {
      clearTimeout(relogio);
    }
  } catch (erro) {
    return { enviado: false, motivo: (erro as Error)?.message ?? 'falha desconhecida' };
  }
}

/* -------------------------------------------------------------------------- */
/* Envio                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A conversa com o provedor, uma vez só.
 *
 * Os dois e-mails do sistema falham do mesmo jeito e têm o mesmo orçamento de
 * tempo; o que muda entre eles é só o texto. Duplicar este bloco significaria,
 * mais cedo ou mais tarde, corrigir um timeout em um lugar e esquecer o outro.
 */
async function entregarAoProvedor(entrada: {
  destino: string;
  assunto: string;
  html: string;
  texto: string;
  order: Order;
  rotulo: string;
  /** Chave curta usada para guardar o rastro no pedido: `recuperacao`, `acesso`. */
  marca: string;
}): Promise<ResultadoDoEnvio> {
  const abortar = new AbortController();
  const relogio = setTimeout(() => abortar.abort(), config.email.timeoutMs);
  const orderId = entrada.order.id;

  let resposta: Response;
  try {
    resposta = await fetch(`${config.email.baseUrl}/emails`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.email.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: config.email.remetente,
        to: [entrada.destino],
        subject: entrada.assunto,
        html: comSeloDeAbertura(entrada.html, orderId, entrada.marca),
        text: entrada.texto,
        ...(config.email.responderPara ? { reply_to: config.email.responderPara } : {}),
      }),
      signal: abortar.signal,
    });
  } finally {
    clearTimeout(relogio);
  }

  if (!resposta.ok) {
    const corpo = await resposta.text().catch(() => '');
    const motivo = `provedor respondeu ${resposta.status}: ${corpo.slice(0, 200)}`;
    logger.error(`E-mail ${entrada.rotulo} recusado pelo provedor`, { orderId, motivo });
    return { enviado: false, motivo };
  }

  /*
   * O id da mensagem, quando vier. É o que permite procurar no provedor por que
   * um e-mail aceito não chegou — a resposta 200 diz só que ele aceitou a
   * tarefa, e caixa cheia ou endereço morto só aparecem depois disso.
   */
  const corpo = (await resposta.json().catch(() => null)) as { id?: unknown } | null;
  const provedorId = typeof corpo?.id === 'string' ? corpo.id : null;

  logger.info(`E-mail ${entrada.rotulo} enviado`, { orderId, provedorId });
  await registrarEnvio(entrada.order, entrada.marca, provedorId);
  return { enviado: true, provedorId };
}

/**
 * A imagem de um pixel que mede a abertura, colada no fim do HTML.
 *
 * Vai em `entregarAoProvedor` e não dentro de cada corpo de propósito: e-mail
 * novo que alguém escrever daqui a três meses nasce medido, sem depender de
 * ninguém lembrar. Ver `MarcaDeEmail` em store/types.ts para os dois defeitos
 * conhecidos do método.
 *
 * Sem chave mestra o e-mail sai sem a imagem — perde-se a medição, nunca a
 * mensagem.
 */
function comSeloDeAbertura(html: string, pedidoId: string, marca: string): string {
  if (!config.painel.chaveMestra) return html;

  const base = (config.publicBaseUrl || 'https://rezassagradas.site').replace(/\/+$/, '');
  const url = `${base}/api/e/${pedidoId}/${marca}/${assinarAbertura(pedidoId, marca)}.gif`;

  /*
   * `alt` vazio e dimensão explícita: cliente que bloqueia imagem mostra o
   * espaço reservado, e um retângulo cinza com texto alternativo no rodapé de
   * um e-mail de pagamento parece anexo estranho.
   */
  const selo = `<img src="${url}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;opacity:0">`;

  return html.includes('</body>') ? html.replace('</body>', `${selo}</body>`) : html + selo;
}

/**
 * Guarda no pedido que a mensagem saiu.
 *
 * Escreve aqui, e não em quem chama, porque os três pontos de envio gravam o
 * carimbo de formas diferentes — um deles (o reenvio pelo painel) não grava
 * nada quando o pedido já tinha carimbo, e o rastro do reenvio se perderia.
 *
 * Nunca lança: o rastro é acessório. Perder o registro de um envio é um buraco
 * no painel; derrubar o envio por causa dele é um cliente sem o que comprou.
 */
async function registrarEnvio(order: Order, marca: string, provedorId: string | null): Promise<void> {
  try {
    const agora = new Date().toISOString();
    const anterior = order.emails?.[marca];

    order.emails = {
      ...(order.emails ?? {}),
      [marca]: {
        enviadoEm: agora,
        provedorId,
        // Reenvio zera a leitura: quem lê o segundo e-mail está abrindo outra
        // mensagem, e manter a abertura antiga faria o novo envio nascer lido.
        entregueEm: null,
        abertoEm: null,
        ultimaAberturaEm: null,
        aberturas: 0,
        cargas: 0,
        agente: null,
      },
    };
    if (anterior?.abertoEm) {
      logger.info('E-mail reenviado por cima de um que já tinha sido aberto', { orderId: order.id, marca });
    }

    await saveOrder(order);
  } catch (erro) {
    logger.warn('Não consegui registrar o envio no pedido', { orderId: order.id, marca, erro: (erro as Error).message });
  }
}

/**
 * Lembrete de PIX gerado e não pago. Nunca lança, como todo envio deste arquivo.
 *
 * Idempotência é de quem chama — `server/recuperacao.ts` marca
 * `recoveryEmailSentAt` no sucesso e nunca reconsidera o pedido depois disso.
 *
 * Sem `qrCode` não há e-mail: um lembrete que não traz o código de pagamento
 * pede que a pessoa recomece a compra do zero, e isso rende menos que silêncio.
 */
export async function enviarEmailDeRecuperacao(order: Order): Promise<ResultadoDoEnvio> {
  try {
    if (!config.email.apiKey) return { enviado: false, motivo: 'EMAIL_API_KEY não configurada' };

    const destino = (order.customer.email ?? '').trim();
    if (!destino || !destino.includes('@')) {
      return { enviado: false, motivo: 'pedido sem e-mail válido' };
    }

    const codigo = (order.qrCode ?? '').trim();
    if (codigo === '') return { enviado: false, motivo: 'pedido sem código PIX para reenviar' };

    /*
     * O endereço da página com o botão que copia de verdade.
     *
     * E-mail não roda JavaScript — nenhum cliente permite. Um botão de copiar
     * dentro da mensagem seria um retângulo que não faz nada ao toque, e falhar
     * calado na hora do pagamento é pior do que não ter botão. Aqui o e-mail
     * leva à página, e lá o botão funciona.
     *
     * Sem chave mestra, o link não nasce e o e-mail sai só com o código para
     * copiar à mão: perde o atalho, não perde o pagamento.
     */
    let paginaDoCodigo: string | null = null;
    if (config.painel.chaveMestra) {
      const expiraEm = Date.now() + 48 * 3_600_000;
      const base = (config.publicBaseUrl || 'https://rezassagradas.site').replace(/\/+$/, '');
      paginaDoCodigo = `${base}/api/codigo/${order.id}/${expiraEm}/${assinarRecuperacao(order.id, expiraEm)}`;
    }

    /*
     * O código ainda vale?
     *
     * A pergunta virou parte do e-mail em vez de virar um veto ao envio. Antes,
     * lembrete só saía enquanto a cobrança estivesse viva — e como a PixGo dá 20
     * minutos e o agendador externo atrasa, na prática QUASE NINGUÉM era pego
     * dentro da janela: o motor rodou o dia inteiro devolvendo "candidatos: 0".
     *
     * Agora quem perdeu o prazo recebe a mesma mensagem com o botão que gera
     * outro código na hora. A janela de recuperação deixa de ser de cinco
     * minutos e passa a ser de horas, que é o tempo real que uma pessoa leva
     * para voltar a olhar o celular.
     */
    const expiraEm = order.expiresAt ? Date.parse(order.expiresAt) : NaN;
    const codigoVivo = Number.isFinite(expiraEm) && expiraEm > Date.now();

    // Código morto e sem página para renovar: não sobrou nada de útil para dizer.
    if (!codigoVivo && !paginaDoCodigo) {
      return { enviado: false, motivo: 'código vencido e sem página para gerar outro' };
    }

    const { html, texto } = montarCorpoDeRecuperacao(order, codigo, paginaDoCodigo, codigoVivo);

    return await entregarAoProvedor({
      destino,
      assunto: `${primeiroNome(order.customer.name) || 'Você'}, você já deu o passo mais difícil`,
      html,
      texto,
      order,
      rotulo: 'de recuperação',
      marca: 'recuperacao',
    });
  } catch (erro) {
    const motivo = (erro as Error)?.name === 'AbortError'
      ? `o provedor demorou mais que ${config.email.timeoutMs} ms`
      : ((erro as Error)?.message ?? 'falha desconhecida');
    logger.error('Falha ao enviar o e-mail de recuperação', { orderId: order.id, motivo });
    return { enviado: false, motivo };
  }
}

/**
 * Envia o e-mail de acesso. Nunca lança — devolve o que aconteceu.
 *
 * Idempotência é de quem chama: `applyStatus` só chama quando o pedido acabou de
 * virar `completed` e marca `accessEmailSentAt` no sucesso. Sem isso, a
 * reentrega do webhook — que a PixGo faz por desenho — mandaria o mesmo e-mail
 * várias vezes, e cliente que recebe quatro cópias da mesma compra acha que foi
 * cobrado quatro vezes.
 */
export async function enviarEmailDeAcesso(order: Order): Promise<ResultadoDoEnvio> {
  try {
    if (!config.email.apiKey) return { enviado: false, motivo: 'EMAIL_API_KEY não configurada' };
    if (!config.painel.chaveMestra) {
      // Sem ela não há como assinar o link, e um e-mail sem link não serve.
      return { enviado: false, motivo: 'PAINEL_CHAVE_MESTRA não configurada' };
    }

    const destino = (order.customer.email ?? '').trim();
    if (!destino || !destino.includes('@')) {
      return { enviado: false, motivo: 'pedido sem e-mail válido' };
    }

    const expiraEm = Date.now() + HORAS_DE_VALIDADE * 3_600_000;
    const base = config.publicBaseUrl.replace(/\/+$/, '');
    if (!base) return { enviado: false, motivo: 'PUBLIC_BASE_URL não configurada' };
    const urlDeAcesso = `${base}/api/entrega/${order.id}/${expiraEm}/${assinarEntrega(order.id, expiraEm)}`;

    /*
     * Os nomes dos produtos vêm da mesma fonte da página de entrega. Se essa
     * leitura falhar, o e-mail vai assim mesmo, com o nome do pedido: um e-mail
     * sem a lista continua entregando o acesso, e é melhor que e-mail nenhum.
     */
    let itens: string[] = [];
    try {
      itens = (await getDeliverables(order.itemIds)).map((item) => item.title);
    } catch {
      itens = [];
    }
    if (itens.length === 0) itens = ['Oração Sagrada do Arcanjo Miguel'];

    const { html, texto } = montarCorpo(order, urlDeAcesso, itens);

    return await entregarAoProvedor({
      destino,
      /*
       * O nome no assunto, e o emoji trocado por um do bloco básico.
       *
       * O 🙏 chegava quebrado em cliente que não monta o par de blocos — o
       * mesmo defeito que apareceu no WhatsApp —, e um losango de interrogação
       * na linha do assunto é o pior lugar possível para ele aparecer: é ali
       * que a pessoa decide se abre. A cruz (U+271D) atravessa qualquer caixa.
       */
      assunto: `${primeiroNome(order.customer.name) || 'Sua'} Oração do Arcanjo Miguel está liberada ✝`,
      html,
      texto,
      order,
      rotulo: 'de acesso',
      marca: 'acesso',
    });
  } catch (erro) {
    // Engole por desenho: ver a regra 1 no cabeçalho deste arquivo.
    const motivo = (erro as Error)?.name === 'AbortError'
      ? `o provedor demorou mais que ${config.email.timeoutMs} ms`
      : ((erro as Error)?.message ?? 'falha desconhecida');
    logger.error('Falha ao enviar o e-mail de acesso', { orderId: order.id, motivo });
    return { enviado: false, motivo };
  }
}
