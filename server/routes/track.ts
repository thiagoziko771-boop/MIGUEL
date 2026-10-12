import { Router, type Request, type Response } from 'express';
import { asyncHandler } from './../asyncHandler.js';
import { limparAtribuicao } from './../atribuicao.js';
import { config } from './../config.js';
import { credenciaisDoMeta } from './../metaCredenciais.js';
import { credenciaisDaBm } from './../bms.js';
import { credenciaisDoTikTok } from './../tiktokCredenciais.js';
import { registrarPassagem } from './../mensuracao.js';
import { createRateLimiter } from './../rateLimit.js';
import { ipDoClienteOuNulo } from './../utils.js';
import { ehPedidoDeOracao } from './../pedidoDeOracao.js';

export const trackRouter: Router = Router();

/**
 * Qual Pixel o navegador deve carregar.
 *
 * Existe porque o Pixel pode ser trocado no painel, e o número embutido no
 * bundle pelo Vite só muda com um build novo. Sem esta rota, mudar o Pixel
 * exigiria deploy — e o dono não tem como fazer deploy.
 *
 * Devolve SÓ o identificador do Pixel, que já é público (vai no HTML e viaja em
 * toda chamada ao Facebook). O token da API de Conversões não aparece aqui nem
 * em nenhuma outra rota sem senha.
 */
trackRouter.get(
  '/rastreamento/pixel',
  asyncHandler(async (_req: Request, res: Response) => {
    /*
     * Os dois pixels na MESMA resposta, e não em duas rotas.
     *
     * O navegador pergunta isto antes da primeira tela, e cada requisição a mais
     * nesse ponto atrasa o PageView — que é justamente o evento que identifica a
     * visita. Uma ida ao servidor entrega os dois.
     */
    /*
     * O pixel DA BM do visitante, não o geral.
     *
     * A BM chega por query string porque o navegador a conhece antes de o
     * servidor saber quem é ele: ela vem da URL do anúncio, capturada na
     * primeira carga. Saneada aqui com a mesma régua da atribuição — o valor
     * nasce numa URL digitada à mão.
     */
    const bmBruta = String(_req.query.bm ?? '').trim().toLowerCase().slice(0, 64);
    const bm = bmBruta !== '' && /^[a-z0-9_-]+$/.test(bmBruta) ? bmBruta : null;

    const [meta, tiktok] = await Promise.all([credenciaisDaBm(bm), credenciaisDoTikTok()]);
    // Cache curto: o navegador não pode ficar com um Pixel velho por horas
    // depois de o dono trocar o número, mas também não precisa perguntar de novo
    // a cada aba aberta.
    res.set('Cache-Control', 'public, max-age=60');
    res.json({
      success: true,
      data: {
        pixelId: meta.pixelId,
        // Desligado no painel devolve vazio, e o navegador trata vazio como
        // "não existe" — assim o interruptor do dono realmente desliga, em vez
        // de o pixel subir e ficar mudo.
        tiktokPixelId: tiktok.ligado ? tiktok.pixelId : '',
      },
    });
  }),
);

/**
 * Rastreamento do funil.
 *
 * O navegador nunca fala direto com o Meta nos eventos que importam: fala
 * conosco, e nós repassamos. Isso faz três coisas ao mesmo tempo — o evento
 * fica registrado no nosso banco (é o que alimenta a aba Anúncios), sobrevive a
 * bloqueador de anúncio, e o valor da venda continua saindo só do catálogo do
 * servidor.
 *
 * Esta rota é PÚBLICA. Trate tudo que chega como hostil.
 */

/**
 * Mandar SÓ a compra ao Meta foi tentado em 14/08/2026 e desfeito no mesmo dia.
 * Fica escrito para ninguém refazer achando que otimiza.
 *
 * A ideia era limpar o Gerenciador, deixando só conversão que é venda. O engano
 * está em supor que os outros eventos competem pela atenção do robô. Não
 * competem: quem decide onde o dinheiro é gasto é o `optimization_goal` do
 * conjunto, que aqui já é `OFFSITE_CONVERSIONS` com `custom_event_type:
 * PURCHASE`. O algoritmo já mirava só em compra antes e depois.
 *
 * O que os eventos de navegação fazem é OUTRA coisa: alimentam o modelo que
 * decide a quem mostrar o anúncio ANTES de existir compra. Cortá-los não afina
 * a mira — tira a comida de quem está aprendendo a mirar.
 *
 * E o momento era o pior possível: pixel criado no dia anterior, histórico
 * zero, R$ 114 de verba, umas 4 ou 5 vendas previstas contra as ~50 semanais
 * que a fase de aprendizado pede. Sinal era exatamente o que faltava.
 *
 * SE O INCÔMODO FOR O RELATÓRIO, o conserto é no Gerenciador — Colunas →
 * Personalizar, deixando Compras, Custo por compra e ROAS. O dado continua
 * chegando ao algoritmo e a tela mostra só dinheiro. Cortar o envio resolve a
 * tela e estraga a entrega.
 *
 * `SO_A_COMPRA = true` volta a cortar, e a bateria de rastreamento acusa a
 * mudança nos dois sentidos.
 */
/*
 * A lista do que a rota ACEITA. Antes ela tinha um segundo papel — decidir o
 * que era repassado ao Meta — e por isso os nomes são os do padrão dele. Com a
 * remoção do rastreamento de terceiros em 21/08/2026 sobrou o papel de
 * validação, e os nomes ficaram por serem os que o funil já emite: renomeá-los
 * quebraria o histórico da tabela `eventos_funil` sem ganhar nada.
 */
const EVENTOS_QUE_O_FUNIL_EMITE: string[] = [
  'PageView',
  'ViewContent',
  'CompleteRegistration',
  'InitiateCheckout',
  'Lead',
  'AddPaymentInfo',
];

/*
 * A COMPRA NÃO ESTÁ NA LISTA, e continua não estando.
 *
 * `Purchase` só nasce de dentro do servidor, quando o gateway confirma o
 * pagamento (server/orders.ts → applyStatus → registrarConversao). Aceitar
 * compra por esta rota seria publicar um endereço onde qualquer pessoa declara
 * uma venda que não existiu — e agora que o nosso banco é a fonte de verdade
 * das conversões, isso valeria faturamento inventado no relatório do dono.
 */

/**
 * Eventos que gravamos e NÃO repassamos ao Meta.
 *
 * `EtapaDoFunil` marca a passagem por cada tela do quiz — é o que permite ao
 * painel dizer em qual pergunta as pessoas desistem. Os dois de recuperação
 * medem a mensagem que recebe quem volta.
 *
 * Ficam fora do Meta porque lá todo nome fora do padrão vira "evento
 * personalizado" e entra no gerenciador ao lado das conversões que valem
 * dinheiro. "Passou pela pergunta 4" não é conversão, e enfiar isso no
 * relatório de quem decide orçamento é pior do que não medir — o robô de
 * otimização passaria a mirar em quem navega, não em quem compra.
 *
 * Eles também não têm degrau em `ESTAGIO_DO_EVENTO` (server/painel/repositorio.ts),
 * de propósito: não são etapas do funil e não podem mexer nas colunas de
 * Visitas, Quiz, VSL e Checkout.
 */
const EVENTOS_SO_NOSSOS = new Set<string>([
  'EtapaDoFunil',
  'RecuperacaoVista',
  'RecuperacaoClique',
  /*
   * PEDIU BOLETO E FOI PARA O WHATSAPP.
   *
   * Enquanto não existe provedor que emita boleto por API, a opção do checkout
   * abre uma conversa com os dados do pagador e alguém emite à mão. Só que o
   * WhatsApp é uma porta de saída do site: se a pessoa não tocar em enviar, ela
   * some sem deixar rastro — e o dono nunca fica sabendo que houve alguém ali
   * querendo pagar de outro jeito.
   *
   * Este evento é a única prova de que o pedido de boleto existiu. Fica FORA do
   * Meta pelo mesmo motivo dos vizinhos: lá viraria conversão personalizada
   * disputando espaço com venda de verdade.
   */
  'PedidoDeBoleto',
  /*
   * `MarcoDaVSL` diz até que segundo a pessoa assistiu o vídeo da oferta. Fica
   * de fora do Meta pelo mesmo motivo dos outros: assistir não é conversão, e
   * dar ao robô de otimização um alvo que não é venda faz ele buscar quem
   * assiste em vez de quem compra.
   */
  'MarcoDaVSL',
]);

/**
 * O que esta rota ACEITA, que é coisa diferente do que ela REPASSA.
 *
 * Sai de `EVENTOS_QUE_O_FUNIL_EMITE`, e não de `EVENTOS_DO_META`, e a distinção
 * é o ponto todo: com `SO_A_COMPRA` ligado o segundo conjunto fica vazio, e
 * derivar daqui faria a rota descartar PageView, ViewContent e InitiateCheckout
 * antes mesmo de gravar. O painel perderia as colunas de Visitas, Quiz, VSL e
 * Checkout de uma vez — parar de contar para o Meta não pode virar parar de
 * contar para nós.
 */
const EVENTOS_ACEITOS = new Set<string>([...EVENTOS_QUE_O_FUNIL_EMITE, ...EVENTOS_SO_NOSSOS]);

/**
 * Freio por IP. Existe para um laço num navegador qualquer não encher a tabela
 * do funil e a conta do banco.
 *
 * O teto é alto de propósito. Uma visita inteira dispara seis eventos, então
 * 60 por minuto pareceria folgado — e não é: a maior parte deste público entra
 * pelo celular, e operadora brasileira usa CGNAT, com centenas de clientes
 * saindo pelo MESMO endereço de IP. Com o teto baixo, evento de cliente
 * legítimo seria descartado em horário de pico e o relatório mentiria para
 * baixo, justamente na hora em que há mais gente comprando.
 *
 * Errar para o lado generoso custa linhas de banco; errar para o lado apertado
 * custa a informação que decide onde colocar dinheiro.
 */
const limitador = createRateLimiter({
  windowMs: readInt(process.env.RATE_LIMIT_TRACK_WINDOW_MS, 60_000),
  max: readInt(process.env.RATE_LIMIT_TRACK_MAX, 300),
  message: 'Muitos eventos. Aguarde um instante.',
});

function readInt(valor: string | undefined, padrao: number): number {
  const numero = Number.parseInt((valor ?? '').trim(), 10);
  return Number.isFinite(numero) && numero > 0 ? numero : padrao;
}

function texto(valor: unknown, limite: number): string | null {
  if (typeof valor !== 'string') return null;
  const limpo = valor.trim().slice(0, limite);
  return limpo === '' ? null : limpo;
}

trackRouter.post(
  '/track',
  limitador,
  asyncHandler(async (req: Request, res: Response) => {
    const corpo = (req.body ?? {}) as Record<string, unknown>;

    const evento = texto(corpo.evento, 60);
    const sessionId = texto(corpo.session_id, 80);
    const eventId = texto(corpo.event_id, 120);

    /*
     * Responde 204 em qualquer caso, inclusive nos recusados.
     *
     * Rastreamento não pode virar mensagem de erro na tela de quem está
     * comprando, e um 4xx aqui só ensinaria um curioso a descobrir o que a rota
     * aceita. O que é ignorado, é ignorado em silêncio.
     */
    if (!evento || !sessionId || !eventId || !EVENTOS_ACEITOS.has(evento)) {
      res.status(204).end();
      return;
    }

    const atribuicao = limparAtribuicao(corpo.attrib);
    const stepBruto = Number(corpo.step);
    const step = Number.isInteger(stepBruto) && stepBruto >= 0 && stepBruto <= 13 ? stepBruto : null;

    const ip = ipDoClienteOuNulo(req);
    const userAgent = texto(req.header('User-Agent'), 500);
    const url = texto(corpo.url, 500);
    const pedidoId = texto(corpo.order_id, 80);

    const contato = (corpo.contato ?? {}) as Record<string, unknown>;

    /*
     * Grava ANTES de tentar o Meta. O registro é nosso e é o que responde
     * "onde o funil vaza"; o envio é de terceiro e pode falhar. Perder o dado
     * porque o Facebook estava fora do ar seria trocar o certo pelo incerto.
     */
    /*
     * A resposta do quiz vem do navegador, então é tratada como hostil: só o
     * texto, cortado, e nada mais. Não vai ao Meta — lá viraria parâmetro
     * personalizado sem uso e com dado de comportamento de gente identificável.
     * Fica no nosso banco, que é onde serve para escrever o remarketing.
     */
    const respostaBruta = (corpo.resposta ?? {}) as Record<string, unknown>;
    const pergunta = texto(respostaBruta.pergunta, 200);
    /*
     * 200 caracteres cobrem qualquer opção do quiz. O PEDIDO DE ORAÇÃO (fluxo
     * "peça e será dado", 15/08/2026) é texto livre da pessoa mais o contato
     * empacotado em JSON, e 200 cortaria o pedido no meio — que é a parte
     * que serve para escrever o e-mail de recuperação. 600 dá o pedido inteiro
     * (a tela limita a 600 antes de mandar) e continua sendo um teto duro
     * contra quem tentar encher o banco por esta rota pública.
     */
    const limiteDaResposta = ehPedidoDeOracao(pergunta) ? 600 : 200;
    const resposta = texto(respostaBruta.escolha, limiteDaResposta);

    await registrarPassagem({
      sessionId,
      pedidoId,
      evento,
      step,
      url,
      ip,
      userAgent,
      atribuicao,
      pergunta,
      resposta,
    });

    /*
     * AQUI O EVENTO ERA REPASSADO AO META pela API de Conversões, com nome,
     * e-mail, telefone, IP, user-agent, `fbp` e `fbc`. Removido em 21/08/2026.
     *
     * O `registrarPassagem` acima continua igual: a visita, a etapa e o carimbo
     * do anúncio seguem sendo gravados no nosso banco. O que deixou de existir
     * é a saída para plataforma de terceiro — nenhum dado desta rota sai da
     * nossa infraestrutura.
     */

    res.status(204).end();
  }),
);
