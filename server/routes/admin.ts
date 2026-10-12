import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { asyncHandler } from './../asyncHandler.js';
import { chaveDoGrupo, plataformaDaOrigem, veioDeAnuncio, type AgrupamentoDeAnuncio } from './../atribuicao.js';
import { listarLeads, perfilDoLead, resumoDoCrm, REGRA_DO_CRM, type EtapaCrm, type FiltrosDeLeads } from './../crm.js';
import { CATALOG } from './../catalog.js';
import { config } from './../config.js';
import { logger } from './../logger.js';
import { buscarPlanilha, conferirEndereco, ImportacaoError } from './../investimento.js';
import { enviarEmailDeAcesso, enviarEmailDeCampanha, enviarExemplarDeCampanha } from './../email.js';
import { montarFechamento, textoDoFechamento } from './../fechamento.js';
import { montarResumo } from './../resumo.js';
import { cabeLembrete, EVENTO_LEMBRETE, linkDoLembrete } from './../lembreteWhatsapp.js';
import { enderecosDoDiscord, mascararEndereco, salvarEnderecos } from './../discord.js';
import { importarInvestimentoPorBm } from './../metaAnuncios.js';
import {
  despesasDaJanela,
  lerCustos,
  repartir,
  listarDespesas,
  paraPercentual,
  roasDeEquilibrio,
  salvarCustos,
  salvarDespesas,
} from './../custos.js';
import { auditar, auditarEscritasDoPainel, rotuloDaAcao } from './../auditoria.js';
import { LEITURA_HUMANA_APOS_MS } from './aberturaDeEmail.js';
import {
  CHAVE_LIGADO,
  CHAVE_PIXEL,
  CHAVE_TEST_CODE,
  CHAVE_TOKEN,
  cifrar,
  credenciaisDoMeta,
  invalidarCredenciaisDoMeta,
  mascararToken,
  podeGuardarToken,
} from './../metaCredenciais.js';
import {
  PARAMETROS_PADRAO_DO_TIKTOK,
  credenciaisDoTikTok,
  guardarLigadoDoTikTok,
  guardarParametrosDoTikTok,
  guardarPixelDoTikTok,
  guardarTokenDoTikTok,
  mascarar as mascararTokenDoTikTok,
} from './../tiktokCredenciais.js';
import {
  guardarBms,
  guardarTokenAdsDaBm,
  guardarTokenDaBm,
  listarBmsCadastradas,
  mascararToken as mascararTokenDaBm,
  tokenAdsCadastradoDaBm,
  tokenDaBm,
} from './../bms.js';
import { applyStatus, buildAccessBundle, reconcileOrder } from './../orders.js';
import { ValidationError } from './../validation.js';
import {
  assinarEntrega,
  assinarRecuperacao,
  conferirBloqueio,
  criarToken,
  entregaAssinaturaConfere,
  exigirAdmin,
  exigirLeads,
  ipDoCliente,
  limparErrosDeSenha,
  registrarErroDeSenha,
  senhaConfere,
  type Papel,
} from './../painel/sessao.js';
import {
  repositorioDoPainel,
  ROTULO_DO_TIPO,
  SITUACOES_DO_BOLETO,
  TIPOS_DE_ENTREGA,
  type NivelDeInvestimento,
  type RespostaDoQuiz,
  type SituacaoDoBoleto,
  type TipoEntrega,
} from './../painel/repositorio.js';
import { mudarSituacaoDoBoleto, reenviarCompraDeBoleto } from './../pedidoDeBoleto.js';
import { diaLocal, FUSO_DO_PAINEL, inicioDoDiaLocal, janelaAnterior, janelaDeDiasAte, somarDias, type Janela } from './../periodo.js';
import {
  CHAVE_ULTIMA_IMPORTACAO_META,
  credenciaisDeAnuncios,
  estadoDosAnuncios,
  importarInvestimentoDoMeta,
  MetaAdsError,
  normalizarConta,
  mudarCampanhaNoMeta,
  salvarCredenciaisDeAnuncios,
  testarCredenciaisDeAnuncios,
} from './../metaAnuncios.js';
import { MINUTOS_PADRAO, emailPlausivel, motivoDaRecusa } from './../recuperacao.js';
import { getOrder, getStatusPollUsage, listOrders, saveOrder, type Order } from './../store/index.js';
import { formatBRL } from './../utils.js';

export const adminRouter: Router = Router();

/** Validade do link de entrega gerado pelo painel. */
const HORAS_LINK_ENTREGA = 72;
/** Teto de pedidos carregados de uma vez. Segura a memória da função. */
const LIMITE_PEDIDOS = 2_000;
/** O mesmo teto para os pedidos de boleto, que são muito menos numerosos. */
const LIMITE_BOLETOS = 500;
/**
 * Pendentes reconsultados por clique. A função da Vercel tem maxDuration de
 * 20 s: 12 consultas em lotes de 4 cabem com folga, e o que sobrar o dono
 * resolve clicando de novo.
 */
const PENDENTES_POR_CLIQUE = 12;
const LOTE_PENDENTES = 4;

/** Nenhuma resposta do painel pode ser cacheada pela CDN. */
adminRouter.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
/** Toda escrita do painel fica na auditoria (aba Acessos). Ver server/auditoria.ts. */
adminRouter.use(auditarEscritasDoPainel);

/* -------------------------------------------------------------------------- */
/* Login                                                                       */
/* -------------------------------------------------------------------------- */

function autenticar(req: Request, res: Response, papeisAceitos: Papel[]): void {
  const ip = ipDoCliente(req);
  const bloqueio = conferirBloqueio(ip);

  if (bloqueio.bloqueado) {
    logger.warn('Painel: login bloqueado por senhas erradas', { ip });
    void auditar({ papel: 'anonimo', ip, acao: 'login.bloqueado', status: 429 });
    res.status(429).json({
      success: false,
      error: 'BLOQUEADO',
      message: `Muitas senhas erradas. Tente de novo em ${bloqueio.minutosRestantes} min.`,
    });
    return;
  }

  const senha = String((req.body as { senha?: unknown })?.senha ?? '');
  if (!senha) {
    res.status(400).json({ success: false, error: 'SENHA_OBRIGATORIA', message: 'Digite a senha.' });
    return;
  }

  const papel = papeisAceitos.find((candidato) => senhaConfere(senha, candidato));
  if (!papel) {
    const depois = registrarErroDeSenha(ip);
    logger.warn('Painel: senha errada', { ip, bloqueado: depois.bloqueado });
    void auditar({ papel: 'anonimo', ip, acao: 'login.senha-errada', detalhe: depois.bloqueado ? 'bloqueou' : null, status: 401 });
    res.status(401).json({
      success: false,
      error: 'SENHA_INVALIDA',
      message: depois.bloqueado
        ? `Muitas senhas erradas. Tente de novo em ${depois.minutosRestantes} min.`
        : 'Senha incorreta.',
    });
    return;
  }

  limparErrosDeSenha(ip);
  logger.info('Painel: entrada', { ip, papel });
  void auditar({ papel, ip, acao: 'login.ok', detalhe: String(req.header('user-agent') ?? '').slice(0, 200), status: 200 });
  res.json({ success: true, data: { token: criarToken(papel), horas: config.painel.horasSessao, papel } });
}

adminRouter.post(
  '/admin/login',
  asyncHandler(async (req: Request, res: Response) => {
    autenticar(req, res, ['dono']);
  }),
);

adminRouter.post(
  '/leads/login',
  asyncHandler(async (req: Request, res: Response) => {
    // Dono primeiro: se as duas senhas forem iguais, ele entra como dono.
    autenticar(req, res, ['dono', 'equipe']);
  }),
);

/* -------------------------------------------------------------------------- */
/* Pedidos                                                                     */
/* -------------------------------------------------------------------------- */

export interface PedidoDoPainel {
  id: string;
  criadoEm: string;
  pagoEm: string | null;
  status: Order['status'];
  oferta: Order['offer'];
  ofertaRotulo: string;
  itens: { id: string; titulo: string; valor: number }[];
  adicionais: string[];
  valor: number;
  valorFormatado: string;
  cliente: { nome: string; email: string; telefone: string; cpf: string };
  pedidoPaiId: string | null;
  /** Id da cobrança no gateway, para conferir o pagamento no painel dele. */
  cobrancaId: string | null;
  /** Status cru do gateway. É o único lugar onde MED aparece. */
  statusGateway: string | null;
  /** Se este pedido aceita lembrete: gerou PIX e não foi pago. */
  cabeLembrete: boolean;
  /** Quantos lembretes já foram abertos para ele. Zero é o normal. */
  lembretesEnviados: number;
  ultimoLembreteEm: string | null;
  emAnalise: boolean;
  origem: 'anuncio' | 'direto';
  aparelho: { tipo: string; so: string; nav: string } | null;
  temPix: boolean;
  /** `pix` ou `boleto`. Pedido antigo não tem o campo e vale como `pix`. */
  metodo: 'pix' | 'boleto';
  /** Vencimento do boleto, quando for boleto. Só para exibição. */
  boletoVenceEm: string | null;
  expiraEm: string | null;
  entregas: { total: number; ultimoEm: string | null };
  /**
   * O que aconteceu com o e-mail deste pedido, em uma linha.
   *
   * `estado` é o que a tabela mostra e resume a pergunta do dono — "falei com
   * essa pessoa, e ela viu?" — em seis respostas possíveis:
   *
   *   nao_enviado  ninguém falou com ela ainda
   *   sem_email    o pedido nasceu sem endereço válido; não há como falar
   *   enviado      o provedor aceitou, e a mensagem ainda não deu sinal de vida
   *   entregue     chegou a uma caixa que existe, e ninguém leu
   *   aberto       uma pessoa leu
   *   clicou       leu E voltou para pagar — o único que vale dinheiro
   *
   * A separação entre `entregue` e `aberto` não é preciosismo: o Gmail busca a
   * imagem do rodapé sozinho, poucos segundos depois do envio, e sem essa
   * distinção toda mensagem entregue apareceria como lida. Ver
   * `LEITURA_HUMANA_APOS_MS` em routes/aberturaDeEmail.ts.
   */
  email: {
    estado: 'nao_enviado' | 'sem_email' | 'enviado' | 'entregue' | 'aberto' | 'clicou';
    /** Qual mensagem: `recuperacao` (lembrete do PIX) ou `acesso` (pós-compra). */
    marca: string | null;
    enviadoEm: string | null;
    entregueEm: string | null;
    abertoEm: string | null;
    aberturas: number;
    /** Do funil da campanha: quando ela voltou ao site pelo link do e-mail. */
    clicouEm: string | null;
  };
  /**
   * TODAS as mensagens que este pedido gerou, e não só a última.
   *
   * O resumo acima responde "e agora?"; esta lista responde "o que já foi dito
   * a essa pessoa?" — que é outra pergunta, e é a que evita o erro caro: mandar
   * promoção de R$ 27,99 para quem recebeu o lembrete de preço cheio há duas
   * horas ensina que basta esperar para o preço cair.
   */
  mensagens: Array<{
    tipo: string;
    /** Nome que o dono lê: "Lembrete do PIX", "Promoção R$ 27,99", "Acesso liberado". */
    rotulo: string;
    enviadoEm: string;
    entregueEm: string | null;
    abertoEm: string | null;
    aberturas: number;
    clicouEm: string | null;
  }>;
}

const ROTULO_OFERTA: Record<Order['offer'], string> = {
  main: 'Oração Sagrada',
  upsell: 'App completo',
  downsell: 'App essencial',
  // Rótulo próprio para a campanha aparecer separada na lista de pedidos: sem
  // isso, a venda recuperada some no meio das vendas do funil e ninguém sabe
  // se a campanha se pagou.
  recuperacao: 'Oração (recuperação)',
};

/**
 * @param origemPelaSessao Origem resgatada pela sessão do funil, para pedidos
 *   que nasceram sem carimbo (a pessoa clicou no anúncio num navegador e
 *   comprou noutro — o navegador embutido do Facebook e o Chrome não dividem
 *   memória). É a mesma malha que a aba Anúncios já usa; ver `/admin/pedidos`.
 */
/**
 * `lembretes` vem pronto do chamador, e não é buscado aqui dentro.
 *
 * Esta função é chamada uma vez por pedido — buscar a contagem dentro dela seria
 * uma ida ao banco por linha da tela. O chamador faz UMA consulta agrupada e
 * passa o mapa; quem não passa recebe zero, que é a resposta certa para as telas
 * que não mostram o contador.
 */
function paraPainel(
  order: Order,
  origemPelaSessao?: Map<string, string>,
  lembretes?: Map<string, { total: number; ultimoEm: string }>,
): PedidoDoPainel {
  const rastreio = order.rastreio ?? null;
  /*
   * ATÉ 15/08/2026 esta conta olhava SÓ `order.rastreio` (gclid/gbraid/wbraid,
   * que é o carimbo do Google) e ignorava `order.atribuicao`, onde mora o do
   * Facebook. Resultado: toda venda vinda do Meta — quase todas — aparecia
   * como "direto" na lista de pedidos, enquanto a aba Anúncios, que lê o
   * campo certo, atribuía a mesma venda ao anúncio. O dono viu a divergência
   * e perguntou por quê. Agora a lista usa a mesma régua do resto do sistema
   * (`veioDeAnuncio`), e resgata pela sessão quando o pedido nasceu sem
   * carimbo.
   */
  const temClique =
    Boolean(rastreio?.gclid || rastreio?.gbraid || rastreio?.wbraid) ||
    veioDeAnuncio(order.atribuicao) ||
    Boolean(order.trackId && origemPelaSessao?.get(order.trackId));

  const itens = order.itemIds.map((itemId) => ({
    id: itemId,
    titulo: CATALOG[itemId]?.title ?? itemId,
    valor: CATALOG[itemId]?.priceCents ?? 0,
  }));

  return {
    id: order.id,
    criadoEm: order.createdAt,
    pagoEm: order.paidAt,
    status: order.status,
    oferta: order.offer,
    ofertaRotulo: ROTULO_OFERTA[order.offer] ?? order.offer,
    itens,
    // Os adicionais são o que veio junto da oferta principal (order bumps).
    adicionais: itens.filter((item) => CATALOG[item.id]?.kind === 'bump').map((item) => item.titulo),
    valor: order.amountCents,
    valorFormatado: formatBRL(order.amountCents),
    cliente: {
      nome: order.customer.name,
      email: order.customer.email,
      telefone: order.customer.phone,
      cpf: order.customer.document,
    },
    pedidoPaiId: order.parentOrderId,
    cobrancaId: order.paymentId,
    statusGateway: order.statusGateway ?? null,
    /*
     * Se cabe lembrete e quantos já foram. A tela usa os dois para decidir se
     * desenha o botão e o que escrever no contador — sem isso, o botão
     * apareceria em pedido pago, que é o único lugar onde ele não pode aparecer.
     */
    cabeLembrete: cabeLembrete(order),
    lembretesEnviados: lembretes?.get(order.id)?.total ?? 0,
    ultimoLembreteEm: lembretes?.get(order.id)?.ultimoEm ?? null,
    emAnalise: String(order.statusGateway ?? '').toUpperCase() === 'MED',
    origem: temClique ? 'anuncio' : 'direto',
    aparelho: order.aparelho ?? null,
    temPix: Boolean(order.qrCode),
    /*
     * A forma de pagamento, para o painel não mentir sobre a espera.
     *
     * Sem isto, um boleto pendente é indistinguível de um PIX que não entrou —
     * e a atitude certa é o contrário em cada caso: PIX parado há uma hora é
     * venda perdida a recuperar, boleto parado há um dia é o prazo bancário
     * correndo, e cobrar essa pessoa no WhatsApp é cobrar quem talvez já tenha
     * pago. Ausente = PIX, pelo mesmo motivo do resto do sistema.
     */
    metodo: order.metodo ?? 'pix',
    /** A data que o CLIENTE vê no documento. Não confundir com `expiraEm`. */
    boletoVenceEm: order.boleto?.vencimento ?? null,
    expiraEm: order.expiresAt,
    entregas: { total: order.entregas?.total ?? 0, ultimoEm: order.entregas?.ultimoEm ?? null },
    email: estadoDoEmail(order),
    mensagens: mensagensDoPedido(order),
  };
}

/** Como cada tipo de mensagem se chama na tela do dono. */
const ROTULO_DA_MENSAGEM: Record<string, string> = {
  recuperacao: 'Lembrete do PIX',
  acesso: 'Acesso liberado',
  campanha: 'Promoção R$ 27,99',
};

/**
 * A linha do tempo das mensagens de um pedido.
 *
 * JUNTA DUAS FONTES que nasceram separadas: `emails`, que o próprio envio
 * grava, e `campanha.enviadoEm`, que veio antes e registra a promoção de
 * R$ 27,99 disparada à mão. Sem a costura, a tela mostraria o lembrete de PIX e
 * esconderia justamente a mensagem que ofereceu desconto — a mais importante de
 * saber antes de oferecer de novo.
 */
function mensagensDoPedido(order: Order): PedidoDoPainel['mensagens'] {
  const lista: PedidoDoPainel['mensagens'] = [];

  for (const [tipo, dado] of Object.entries(order.emails ?? {})) {
    if (!dado?.enviadoEm) continue;
    lista.push({
      tipo,
      rotulo: ROTULO_DA_MENSAGEM[tipo] ?? tipo,
      enviadoEm: dado.enviadoEm,
      entregueEm: dado.entregueEm ?? null,
      abertoEm: dado.abertoEm ?? null,
      aberturas: dado.aberturas ?? 0,
      clicouEm: null,
    });
  }

  /*
   * A campanha enviada pela rota nova grava DOIS rastros: a marca rica em
   * `emails.campanha` (com entrega e abertura, pelo selo) e o carimbo em
   * `campanha.enviadoEm` (que o funil da campanha conta). O loop acima já
   * mostrou a marca rica; repetir o carimbo aqui viraria duas linhas da mesma
   * mensagem. O bloco fica para as abordagens SEM marca rica: o WhatsApp e as
   * campanhas antigas do script avulso.
   */
  if (order.campanha?.enviadoEm && !order.emails?.['campanha']?.enviadoEm) {
    /*
     * O rótulo diz QUAL mensagem foi, não o nome do mecanismo.
     *
     * "Promoção R$ 27,99" fixo aqui fez uma cobrança de preço cheio, mandada
     * 12 minutos depois de o pedido nascer, aparecer como promoção — e o dono
     * concluiu que a regra das 48 h tinha sido furada. Pedido antigo, de antes
     * do campo `comDesconto`, fica com o nome neutro: afirmar qual das duas
     * foi seria inventar.
     */
    const rotuloDaCampanha =
      order.campanha.comDesconto === true
        ? (ROTULO_DA_MENSAGEM.campanha as string)
        : order.campanha.comDesconto === false
          ? 'Cobrança no WhatsApp (preço cheio)'
          : 'Abordagem da campanha (antiga, sem registro do preço)';
    lista.push({
      tipo: 'campanha',
      rotulo: rotuloDaCampanha,
      enviadoEm: order.campanha.enviadoEm,
      entregueEm: null,
      abertoEm: null,
      aberturas: 0,
      clicouEm: order.campanha.visitadoEm ?? null,
    });
  } else if (order.campanha?.linkGeradoEm) {
    /*
     * Link gerado, mensagem NUNCA enviada — e a tela precisa dizer isso com
     * essas palavras. A versão anterior tratava os dois como a mesma coisa, e o
     * dono deixava de abordar quem parecia já abordado. O clique continua
     * aparecendo: se a pessoa visitou, o link chegou a ela por algum caminho.
     */
    lista.push({
      tipo: 'campanha_link',
      rotulo: 'Link da promoção gerado (mensagem não enviada)',
      enviadoEm: order.campanha.linkGeradoEm,
      entregueEm: null,
      abertoEm: null,
      aberturas: 0,
      clicouEm: order.campanha.visitadoEm ?? null,
    });
  }

  /*
   * Pedido antigo, anterior ao registro por mensagem: os dois carimbos soltos
   * ainda contam. Sem isto, quem recebeu e-mail antes de 12/08 apareceria como
   * se nunca tivesse ouvido nada.
   */
  if (lista.length === 0) {
    if (order.accessEmailSentAt) {
      lista.push({ tipo: 'acesso', rotulo: ROTULO_DA_MENSAGEM.acesso as string, enviadoEm: order.accessEmailSentAt, entregueEm: null, abertoEm: null, aberturas: 0, clicouEm: null });
    }
    if (order.recoveryEmailSentAt) {
      lista.push({ tipo: 'recuperacao', rotulo: ROTULO_DA_MENSAGEM.recuperacao as string, enviadoEm: order.recoveryEmailSentAt, entregueEm: null, abertoEm: null, aberturas: 0, clicouEm: null });
    }
  }

  return lista.sort((a, b) => b.enviadoEm.localeCompare(a.enviadoEm));
}

/**
 * Resume em uma linha o que aconteceu com o e-mail deste pedido.
 *
 * A ORDEM DE PREFERÊNCIA IMPORTA: quando um pedido recebeu as duas mensagens —
 * o lembrete de PIX e depois o de acesso, porque ela acabou pagando —, o que o
 * dono quer ver é a última, que é onde a conversa está. Por isso a escolha é
 * pelo carimbo mais recente, e não por uma ordem fixa de rótulos.
 *
 * O TRECHO DE PEDIDO ANTIGO existe porque `emails` nasceu depois de milhares de
 * envios já terem acontecido. Sem ele, todo cliente anterior a hoje apareceria
 * como "não enviado" — e o painel diria que ninguém nunca falou com eles, que é
 * exatamente o erro que este campo veio corrigir.
 */
function estadoDoEmail(order: Order): PedidoDoPainel['email'] {
  const clicouEm = order.campanha?.visitadoEm ?? null;

  const marcas = Object.entries(order.emails ?? {});
  let marca: string | null = null;
  let enviadoEm: string | null = null;
  let entregueEm: string | null = null;
  let abertoEm: string | null = null;
  let aberturas = 0;

  for (const [chave, dado] of marcas) {
    if (!dado?.enviadoEm) continue;
    if (enviadoEm && dado.enviadoEm <= enviadoEm) continue;
    marca = chave;
    enviadoEm = dado.enviadoEm;
    entregueEm = dado.entregueEm ?? null;
    abertoEm = dado.abertoEm ?? null;
    aberturas = dado.aberturas ?? 0;

    /*
     * Registro anterior à regra dos dois minutos, corrigido AQUI e não no banco.
     *
     * No primeiro dia com o pixel no ar, toda carga da imagem virava leitura, e
     * o Gmail carrega sozinho em poucos segundos: sete "aberturas" que eram
     * duas. Reclassificar na leitura corrige o painel sem reescrever o que foi
     * observado — se um dia a regra mudar, o dado cru continua lá para ser
     * lido de outro jeito.
     */
    if (abertoEm && !entregueEm) {
      const demora = Date.parse(abertoEm) - Date.parse(enviadoEm);
      if (Number.isFinite(demora) && demora < LEITURA_HUMANA_APOS_MS) {
        entregueEm = abertoEm;
        abertoEm = null;
        aberturas = 0;
      }
    }
  }

  // Pedido anterior ao campo `emails`: os dois carimbos antigos ainda contam.
  if (!enviadoEm) {
    if (order.accessEmailSentAt) {
      marca = 'acesso';
      enviadoEm = order.accessEmailSentAt;
    } else if (order.recoveryEmailSentAt) {
      marca = 'recuperacao';
      enviadoEm = order.recoveryEmailSentAt;
    }
  }

  const temEndereco = (order.customer.email ?? '').includes('@');

  const estado: PedidoDoPainel['email']['estado'] = !enviadoEm
    ? (temEndereco ? 'nao_enviado' : 'sem_email')
    : clicouEm
      ? 'clicou'
      : abertoEm
        ? 'aberto'
        : entregueEm
          ? 'entregue'
          : 'enviado';

  return { estado, marca, enviadoEm, entregueEm, abertoEm, aberturas, clicouEm };
}

adminRouter.get(
  '/admin/pedidos',
  exigirLeads,
  asyncHandler(async (req: Request, res: Response) => {
    const pedidos = await listOrders({ limite: LIMITE_PEDIDOS });

    /*
     * Origem pela sessão só para os órfãos de carimbo — e só se der. Uma
     * falha nesta consulta não pode derrubar a lista de pedidos: no pior
     * caso o órfão volta a aparecer como "direto", que é como era antes.
     */
    let origemPelaSessao = new Map<string, string>();
    const orfaos = pedidos.filter((order) => !veioDeAnuncio(order.atribuicao) && order.trackId);
    if (orfaos.length > 0) {
      const maisAntigo = orfaos.reduce((min, o) => (o.createdAt < min ? o.createdAt : min), orfaos[0].createdAt);
      try {
        origemPelaSessao = await repositorioDoPainel().chaveDasSessoes({
          sessoes: [...new Set(orfaos.map((order) => order.trackId as string))],
          agrupamento: 'anuncio',
          desde: maisAntigo,
        });
      } catch (erro) {
        logger.error('Falha ao recuperar a origem pela sessão na lista de pedidos', { erro: (erro as Error).message });
      }
    }

    /*
     * A contagem de lembretes da lista inteira, numa consulta so.
     *
     * Falhar aqui deixa o contador em zero e NAO derruba a tela de pedidos: o
     * numero de lembretes e informacao util, mas a lista de quem comprou e a
     * razao de a aba existir.
     */
    let lembretes = new Map<string, { total: number; ultimoEm: string }>();
    try {
      lembretes = new Map(
        (await repositorioDoPainel().contarEventosPorPedido(EVENTO_LEMBRETE))
          .map((c) => [c.pedidoId, { total: c.total, ultimoEm: c.ultimoEm }]),
      );
    } catch (erro) {
      logger.warn('Nao consegui contar os lembretes enviados', { erro: (erro as Error).message });
    }

    res.json({
      success: true,
      data: {
        pedidos: pedidos.map((order) => paraPainel(order, origemPelaSessao, lembretes)),
        papel: req.papelSessao,
        consultas: await getStatusPollUsage(),
        modo: config.mode,
        armazenamento: config.databaseUrl ? 'postgres' : 'arquivo',
      },
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* Ações do dono                                                               */
/* -------------------------------------------------------------------------- */

adminRouter.post(
  '/admin/pedidos/:id/marcar-pago',
  exigirAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const order = await getOrder(req.params.id);
    if (!order) {
      res.status(404).json({ success: false, error: 'NAO_ENCONTRADO', message: 'Pedido não encontrado.' });
      return;
    }
    if (order.status === 'completed') {
      res.json({ success: true, data: { jaEstavaPago: true, pedido: paraPainel(order) } });
      return;
    }

    // Mesma porta de entrada de um pagamento real: applyStatus é quem impede
    // que o pedido seja pago duas vezes, venha de onde vier.
    const atualizado = await applyStatus(order, 'completed', 'manual');
    logger.info('Painel: pedido marcado como pago à mão', { orderId: order.id, ip: ipDoCliente(req) });

    res.json({ success: true, data: { jaEstavaPago: false, pedido: paraPainel(atualizado) } });
  }),
);

/**
 * O funil da campanha de recuperação, para o painel.
 *
 * Quatro degraus, e cada queda entre eles aponta um culpado diferente:
 * enviado→clicou é o assunto do e-mail; clicou→pediu PIX é a página e o preço;
 * pediu→pagou é o meio de pagamento. Sem a separação, "a campanha não deu
 * resultado" não diz o que consertar.
 */
/**
 * Endereços da casa: os do dono e os das baterias.
 *
 * Toda mensagem enviada para eles conta como envio, clique e visita no funil da
 * campanha — e eram NOVE das quarenta e quatro linhas, um quinto do relatório.
 * Com um quinto de ruído, "a campanha teve 24% de clique" deixa de ser um número
 * e vira uma sensação: parte daqueles cliques sou eu conferindo se a página
 * abre.
 *
 * A lista fica no código porque é curta e muda pouco. `@exemplo.com` e
 * `@rezassagradas.com.br` entram por padrão de nome, não um a um: as baterias
 * criam endereços novos a cada rodada e ninguém vai lembrar de cadastrar cada
 * um aqui.
 *
 * NADA É APAGADO — os pedidos continuam na aba Pedidos, onde o dono precisa
 * vê-los para conferir os próprios testes. O que muda é só a conta do relatório,
 * e a tela diz em voz alta quantas linhas ficaram de fora.
 */
const ENDERECOS_DA_CASA = new Set(['euomarjorge@gmail.com', 'teste@gmail.com', 'etete@gmail.com']);
const DOMINIOS_DE_TESTE = /@exemplo\.com$|@rezassagradas\.com\.br$|^teste[.\-_]/i;

function ehDaCasa(email: string | null | undefined): boolean {
  const limpo = (email ?? '').trim().toLowerCase();
  if (limpo === '') return false;
  return ENDERECOS_DA_CASA.has(limpo) || DOMINIOS_DE_TESTE.test(limpo);
}

adminRouter.get(
  '/admin/campanha',
  exigirAdmin,
  asyncHandler(async (_req: Request, res: Response) => {
    const pedidos = await listOrders({ limite: 500 });
    /*
     * Entra no funil quem foi abordado OU está com a abordagem em andamento.
     *
     * `linkGeradoEm` sozinho significa "o dono gerou o link e ainda não mandou
     * (ou mandou por fora, sem registrar)". Filtrar só por `enviadoEm` faria
     * essa pessoa SUMIR do relatório — e quem some da lista não recebe o resto
     * do acompanhamento. A coluna `mensagemEnviada` de cada linha diz em qual
     * dos dois estágios o pedido está; esconder o estágio seria repetir a
     * imprecisão antiga com o sinal trocado.
     */
    const enviados_ = pedidos.filter((o) => o.campanha?.enviadoEm || o.campanha?.linkGeradoEm);
    const daCampanha = enviados_.filter((o) => !ehDaCasa(o.customer.email));
    const ocultos = enviados_.length - daCampanha.length;

    // As vendas geradas: pedidos filhos apontados pelo campo `pedidoGerado`.
    const gerados = new Map(pedidos.filter((o) => o.offer === 'recuperacao').map((o) => [o.id, o]));

    let enviados = 0;
    let clicaram = 0;
    let pediramPix = 0;
    let pagaram = 0;
    let receitaCentavos = 0;
    const linhas = [];

    for (const o of daCampanha) {
      enviados += 1;
      if (o.campanha?.visitadoEm) clicaram += 1;
      if (o.campanha?.cobrancaEm) pediramPix += 1;

      const filho = o.campanha?.pedidoGerado ? gerados.get(o.campanha.pedidoGerado) : undefined;
      const pago = filho?.status === 'completed';
      if (pago) {
        pagaram += 1;
        receitaCentavos += filho?.amountCents ?? 0;
      }

      linhas.push({
        nome: o.customer.name,
        email: o.customer.email,
        // O carimbo de abordagem: o envio real quando houve, o link quando não.
        enviadoEm: o.campanha?.enviadoEm ?? o.campanha?.linkGeradoEm ?? null,
        mensagemEnviada: Boolean(o.campanha?.enviadoEm),
        visitadoEm: o.campanha?.visitadoEm ?? null,
        cliques: o.campanha?.cliques ?? 0,
        cobrancaEm: o.campanha?.cobrancaEm ?? null,
        pago,
        valorCentavos: pago ? (filho?.amountCents ?? 0) : null,
      });
    }

    linhas.sort((a, b) => String(b.enviadoEm).localeCompare(String(a.enviadoEm)));

    const taxa = (parte: number, todo: number) => (todo > 0 ? parte / todo : null);

    res.json({
      success: true,
      data: {
        enviados,
        clicaram,
        pediramPix,
        pagaram,
        receitaCentavos,
        taxaDeClique: taxa(clicaram, enviados),
        taxaDePix: taxa(pediramPix, clicaram),
        taxaDePagamento: taxa(pagaram, pediramPix),
        conversaoTotal: taxa(pagaram, enviados),
        linhas,
        /*
         * Quantas linhas saíram da conta por serem da casa.
         *
         * Vai para a tela de propósito: relatório que esconde dado sem dizer é
         * relatório em que não se pode confiar. Se um dia este número subir sem
         * explicação, é sinal de que a lista está pegando cliente de verdade.
         */
        ocultosDaCasa: ocultos,
      },
    });
  }),
);

/**
 * O link "escolha e pague" a PREÇO CHEIO (15/08/2026, caso Ricardo).
 *
 * Irmão do link de recuperação, mas para quem se ofereceu a pagar o valor
 * normal e só quer decidir os bônus sem preencher nada de novo. Abre
 * /api/escolher/:id/:exp/:sig (server/routes/escolherOferta.ts): Oração
 * R$ 47 + caixinhas dos bônus + botão que gera o PIX. Mesma assinatura e
 * mesmo prazo do link de recuperação; NÃO grava nada em `campanha`, porque
 * não é promoção — é venda de preço cheio.
 */
adminRouter.post(
  '/admin/pedidos/:id/link-escolha',
  exigirAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const order = await getOrder(String(req.params.id ?? ''));
    if (!order) {
      res.status(404).json({ success: false, error: 'PEDIDO_NAO_ENCONTRADO' });
      return;
    }
    if (order.status === 'completed') {
      res.status(409).json({ success: false, error: 'PEDIDO_JA_PAGO', message: 'Este pedido já foi pago.' });
      return;
    }
    if (!config.painel.chaveMestra) {
      res.status(503).json({ success: false, error: 'SEM_CHAVE_MESTRA', message: 'Configure a PAINEL_CHAVE_MESTRA para gerar links.' });
      return;
    }
    const expiraEm = Date.now() + 48 * 3_600_000;
    const assinatura = assinarRecuperacao(order.id, expiraEm);
    const base = config.publicBaseUrl || `${req.protocol}://${req.get('host') ?? 'localhost'}`;
    res.json({ success: true, data: { url: `${base}/api/escolher/${order.id}/${expiraEm}/${assinatura}`, expiraEm } });
  }),
);

/**
 * O link da campanha de recuperação, para um pedido que ficou sem pagamento.
 *
 * Existe porque a assinatura só pode nascer dentro do servidor: a chave mestra
 * é a mesma que assina os links de entrega e nunca sai da Vercel. Sem esta
 * rota, montar a campanha exigiria copiar o segredo para a máquina de quem
 * dispara — e um segredo copiado é um segredo perdido.
 *
 * Quarenta e oito horas: o e-mail precisa sobreviver a quem só lê a caixa de
 * entrada no fim de semana. Prazo curto demais transforma a campanha inteira em
 * uma pilha de links mortos antes de alguém abrir.
 */
adminRouter.post(
  '/admin/pedidos/:id/link-recuperacao',
  exigirAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const order = await getOrder(req.params.id);
    if (!order) {
      res.status(404).json({ success: false, error: 'NAO_ENCONTRADO', message: 'Pedido não encontrado.' });
      return;
    }
    if (order.status === 'completed') {
      res.status(400).json({
        success: false,
        error: 'PEDIDO_JA_PAGO',
        message: 'Este pedido já foi pago. A campanha é só para quem não pagou.',
      });
      return;
    }
    if (!config.painel.chaveMestra) {
      res.status(503).json({
        success: false,
        error: 'SEM_CHAVE_MESTRA',
        message: 'Configure a PAINEL_CHAVE_MESTRA para gerar links.',
      });
      return;
    }

    const expiraEm = Date.now() + 48 * 3_600_000;
    const assinatura = assinarRecuperacao(order.id, expiraEm);
    const base = config.publicBaseUrl || `${req.protocol}://${req.get('host') ?? 'localhost'}`;

    /*
     * Gerar o link NÃO é enviar — e esta linha já mentiu o contrário.
     *
     * A versão anterior gravava `enviadoEm` aqui, apostando que "o disparo
     * acontece no segundo seguinte". Na prática o segundo seguinte nem sempre
     * chegou: link gerado para testar, aba fechada, e-mail que não saiu. O
     * painel então mostrava "Promoção enviada" para quem nunca recebeu nada, e
     * o dono deixava de abordar quem parecia já abordado — o defeito foi
     * apontado por ele em 13/08/2026.
     *
     * Agora o degrau é honesto: aqui fica só `linkGeradoEm`; `enviadoEm` passa
     * a ser gravado por `POST /admin/pedidos/:id/campanha-enviada`, chamado por
     * quem de fato disparou a mensagem.
     */
    order.campanha = {
      enviadoEm: order.campanha?.enviadoEm ?? null,
      linkGeradoEm: new Date().toISOString(),
      visitadoEm: order.campanha?.visitadoEm ?? null,
      cliques: order.campanha?.cliques ?? 0,
      cobrancaEm: order.campanha?.cobrancaEm ?? null,
      pedidoGerado: order.campanha?.pedidoGerado ?? null,
    };
    await saveOrder(order);

    logger.info('Painel: link de recuperação gerado', { orderId: order.id, ip: ipDoCliente(req) });
    res.json({
      success: true,
      data: {
        url: `${base}/api/recuperar/${order.id}/${expiraEm}/${assinatura}`,
        horas: 48,
        cliente: { nome: order.customer.name, email: order.customer.email },
      },
    });
  }),
);

/**
 * Endereços que NUNCA recebem campanha, além dos que `ehDaCasa` já filtra.
 *
 * Barrados na conferência com o dono em 12/08/2026, quando a campanha rodava
 * por script avulso. A Sônia pagou e foi estornada — desconto para ela vira
 * reclamação; os outros dois são cadastros estranhos que o dono não reconheceu.
 */
const BLOQUEADOS_DA_CAMPANHA = new Set([
  'russianvorostov@gmail.com',
  'higor.dias@geradornv.com.br',
  'soniacetrimadv@gmail.com',
]);

/**
 * Quem está na fila da promoção de R$ 27,99 — e o disparo em si.
 *
 * A seleção espelha o script aprovado de 12/08/2026, com um corte diferente:
 * >24 h em vez de >2 h, porque desde então o lembrete automático de preço
 * cheio cobre as primeiras 24 horas — mandar desconto dentro da janela dele
 * canibalizaria o preço cheio de quem ainda ia pagar inteiro.
 *
 * `modo: "exemplar"` envia a peça para o e-mail informado (o do dono), com os
 * dados do primeiro da fila, sem marcar ninguém — é a regra da casa: nada vai
 * a cliente sem o dono ver antes. `modo: "valendo"` dispara de verdade, marca
 * `campanha.enviadoEm` + `comDesconto: true` e conta no funil.
 *
 * O limite por chamada existe por causa da Vercel: a função tem ~20 s, e cada
 * envio fala com o provedor. A resposta diz quantos restam; chamar de novo
 * continua de onde parou — quem já foi marcado não entra mais na fila.
 */
adminRouter.post(
  '/admin/campanha/disparar',
  exigirAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const corpo = (req.body ?? {}) as { modo?: unknown; para?: unknown; limite?: unknown };
    const modo = String(corpo.modo ?? '');
    if (modo !== 'exemplar' && modo !== 'valendo') {
      throw new ValidationError('Informe o modo: "exemplar" (peça para o dono aprovar) ou "valendo" (disparo real).', { field: 'modo' });
    }
    if (!config.painel.chaveMestra) {
      res.status(503).json({ success: false, error: 'SEM_CHAVE_MESTRA', message: 'Configure a PAINEL_CHAVE_MESTRA para gerar os links.' });
      return;
    }

    const agora = Date.now();
    const pedidos = await listOrders({ limite: 500 });

    const jaCompraram = new Set(
      pedidos
        .filter((o) => o.status === 'completed' || o.paidAt)
        .map((o) => (o.customer.email ?? '').toLowerCase().trim()),
    );

    const elegivel = (o: Order): boolean => {
      if (o.status !== 'pending' && o.status !== 'expired') return false;
      if (o.parentOrderId) return false;
      const email = (o.customer.email ?? '').toLowerCase().trim();
      if (!email || jaCompraram.has(email)) return false;
      if (ehDaCasa(email) || BLOQUEADOS_DA_CAMPANHA.has(email)) return false;
      if (!emailPlausivel(o.customer.email)) return false;
      if (o.campanha?.enviadoEm || o.campanha?.linkGeradoEm) return false;
      const idadeMs = agora - Date.parse(o.createdAt);
      if (!Number.isFinite(idadeMs) || idadeMs < 24 * 3_600_000) return false;
      return true;
    };

    // Uma pessoa, um e-mail: fica o pedido de maior valor, que reflete a maior
    // intenção que ela chegou a demonstrar.
    const porPessoa = new Map<string, Order>();
    for (const o of pedidos.filter(elegivel)) {
      const email = (o.customer.email ?? '').toLowerCase().trim();
      const atual = porPessoa.get(email);
      if (!atual || o.amountCents > atual.amountCents) porPessoa.set(email, o);
    }
    const fila = [...porPessoa.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

    const linkDaOferta = (o: Order): string => {
      const expiraEm = Date.now() + 48 * 3_600_000;
      const base = config.publicBaseUrl || 'https://rezassagradas.site';
      return `${base}/api/recuperar/${o.id}/${expiraEm}/${assinarRecuperacao(o.id, expiraEm)}`;
    };

    if (modo === 'exemplar') {
      const destino = String(corpo.para ?? '').trim() || 'euomarjorge@gmail.com';
      const modelo = fila[0];
      if (!modelo) {
        res.json({ success: true, data: { fila: 0, mensagem: 'Ninguém elegível para a campanha agora.' } });
        return;
      }
      const envio = await enviarExemplarDeCampanha(modelo, linkDaOferta(modelo), destino);
      res.json({
        success: envio.enviado,
        data: {
          fila: fila.length,
          exemplarPara: destino,
          modeloDosDados: { nome: modelo.customer.name, valor: formatBRL(modelo.amountCents) },
          ...(envio.enviado ? {} : { motivo: envio.motivo }),
        },
      });
      return;
    }

    const limiteBruto = Number.parseInt(String(corpo.limite ?? '10'), 10);
    const limite = Number.isFinite(limiteBruto) && limiteBruto > 0 ? Math.min(limiteBruto, 15) : 10;

    let enviados = 0;
    let falhas = 0;
    for (const o of fila.slice(0, limite)) {
      const envio = await enviarEmailDeCampanha(o, linkDaOferta(o));
      if (!envio.enviado) {
        falhas += 1;
        logger.warn('Campanha: envio falhou', { orderId: o.id, motivo: envio.motivo });
        continue;
      }
      o.campanha = {
        ...o.campanha,
        enviadoEm: new Date().toISOString(),
        comDesconto: true,
        linkGeradoEm: o.campanha?.linkGeradoEm ?? new Date().toISOString(),
        visitadoEm: o.campanha?.visitadoEm ?? null,
        cliques: o.campanha?.cliques ?? 0,
        cobrancaEm: o.campanha?.cobrancaEm ?? null,
        pedidoGerado: o.campanha?.pedidoGerado ?? null,
      };
      await saveOrder(o);
      await repositorioDoPainel().registrarEvento({
        pedidoId: o.id,
        evento: 'campanha_enviada',
        origem: req.papelSessao ?? 'dono',
        detalhe: 'promoção R$ 27,99 por e-mail (rota do servidor)',
      });
      enviados += 1;
    }

    logger.info('Campanha disparada pela rota', { enviados, falhas, restam: fila.length - enviados });
    res.json({ success: true, data: { enviados, falhas, restam: Math.max(0, fila.length - enviados - falhas) } });
  }),
);

/**
 * Registra que a mensagem da campanha SAIU de verdade.
 *
 * É a segunda metade da separação feita em `link-recuperacao`: gerar o link
 * grava `linkGeradoEm`, e quem dispara a mensagem — o script de campanha, ou o
 * dono depois de colar o link num e-mail manual — chama isto para gravar
 * `enviadoEm`. Sem a chamada, o painel mostra "link gerado, sem envio", que é
 * a verdade que faltava.
 */
adminRouter.post(
  '/admin/pedidos/:id/campanha-enviada',
  exigirAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const order = await getOrder(req.params.id);
    if (!order) {
      res.status(404).json({ success: false, error: 'NAO_ENCONTRADO', message: 'Pedido não encontrado.' });
      return;
    }

    order.campanha = {
      enviadoEm: new Date().toISOString(),
      linkGeradoEm: order.campanha?.linkGeradoEm ?? null,
      visitadoEm: order.campanha?.visitadoEm ?? null,
      cliques: order.campanha?.cliques ?? 0,
      cobrancaEm: order.campanha?.cobrancaEm ?? null,
      pedidoGerado: order.campanha?.pedidoGerado ?? null,
    };
    await saveOrder(order);

    await repositorioDoPainel().registrarEvento({
      pedidoId: order.id,
      evento: 'campanha_enviada',
      origem: req.papelSessao ?? 'dono',
      detalhe: 'mensagem da promoção marcada como enviada',
    });

    res.json({ success: true, data: { enviadoEm: order.campanha.enviadoEm } });
  }),
);

/**
 * Por que cada pedido recente recebeu — ou não — o lembrete de PIX.
 *
 * O motor de recuperação responde `candidatos: 0` igualzinho quando está tudo
 * certo e quando um filtro está engolindo gente que devia receber. Já custou
 * dias de lembrete nenhum (a janela dos cinco minutos) e uma tarde de caça a
 * um pedido elegível recusado sem explicação. Esta rota pergunta ao MESMO
 * código que decide (`motivoDaRecusa`), não a uma cópia — se a regra mudar, o
 * diagnóstico muda junto.
 */
adminRouter.get(
  '/admin/recuperacao/diagnostico',
  exigirAdmin,
  asyncHandler(async (_req: Request, res: Response) => {
    const agoraMs = Date.now();
    const desde = new Date(agoraMs - 24 * 3_600_000).toISOString();
    const pedidos = await listOrders({ desde, limite: 200 });

    const linhas = pedidos.map((o) => ({
      id: o.id.slice(0, 8),
      criadoEm: o.createdAt,
      status: o.status,
      cliente: (o.customer.name ?? '').split(/\s+/)[0] ?? '',
      motivo: motivoDaRecusa(o, agoraMs, MINUTOS_PADRAO) ?? 'CANDIDATO — recebe na próxima passada',
    }));

    res.json({ success: true, data: { agora: new Date(agoraMs).toISOString(), linhas } });
  }),
);

/** O convite do grupo de orações, colado pelo dono no painel. */
const CHAVE_GRUPO = 'whatsapp.grupo_url';

/**
 * A conversa de entrega: quem contribuiu recebe notícia e um convite.
 *
 * SEPARADA DA COBRANÇA de propósito, porque sai por outro número — o de
 * cobrança é sacrificável, o de entrega é onde mora a base. Misturar os dois
 * num botão só faria a cobrança sair pelo número que não pode ser bloqueado.
 *
 * O CONVITE DO GRUPO É O QUE MUDA A CONTA DO NEGÓCIO. Hoje todo o dinheiro vem
 * da primeira compra, o que obriga cada real de anúncio a se pagar na hora —
 * o jeito mais difícil de escalar que existe. Quem entra num grupo que reza
 * junto todo dia continua alcançável sem custo de mídia, e a segunda venda
 * deixa de depender do Meta.
 *
 * O LINK É CONVITE, NUNCA ADIÇÃO À FORÇA. Entrar num grupo sem ter pedido é o
 * caminho mais rápido para a denúncia — e denúncia derruba justamente o número
 * que não pode cair.
 */
adminRouter.post(
  '/admin/pedidos/:id/whatsapp-entrega',
  exigirAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const order = await getOrder(req.params.id);
    if (!order) {
      res.status(404).json({ success: false, error: 'NAO_ENCONTRADO', message: 'Pedido não encontrado.' });
      return;
    }
    if (order.status !== 'completed') {
      res.status(400).json({
        success: false,
        error: 'PEDIDO_NAO_PAGO',
        message: 'A entrega é para quem já contribuiu.',
      });
      return;
    }

    const digitos = (order.customer.phone ?? '').replace(/\D/g, '').replace(/^55/, '');
    if (digitos.length < 10 || digitos.length > 11) {
      res.status(400).json({
        success: false,
        error: 'TELEFONE_INVALIDO',
        message: `O telefone deste pedido não dá para chamar: "${order.customer.phone ?? ''}".`,
      });
      return;
    }

    const grupo = ((await repositorioDoPainel().lerConfiguracao(CHAVE_GRUPO)) ?? '').trim();

    const bruto = (order.customer.name ?? '').trim().split(/\s+/)[0] ?? '';
    const primeiro = bruto ? bruto.charAt(0).toUpperCase() + bruto.slice(1).toLowerCase() : '';

    const mensagem = [
      primeiro ? `${primeiro}, que a paz esteja com você ${CRUZ}` : `Que a paz esteja com você ${CRUZ}`,
      '',
      `${LUZ} Aqui é das Rezas Sagradas. Recebemos a sua contribuição — que Miguel te cubra.`,
      '',
      `${ESPADA} A sua Oração está sendo preparada com o seu nome e chega por aqui mesmo.`,
      ...(grupo
        ? [
          '',
          'E tem mais uma coisa: abrimos um círculo onde rezamos juntos todos os dias. Você tem lugar nele, se quiser:',
          grupo,
        ]
        : []),
      '',
      'Qualquer coisa, é só me chamar por aqui.',
    ].join('\n');

    res.json({
      success: true,
      data: {
        url: `https://wa.me/55${digitos}?text=${encodeURIComponent(mensagem)}`,
        telefone: telefoneVisivel(order.customer.phone ?? ''),
        comGrupo: Boolean(grupo),
        mensagem,
      },
    });
  }),
);

/** Lê e grava o convite do grupo. Vazio remove o convite das entregas. */
adminRouter.get(
  '/admin/grupo',
  exigirAdmin,
  asyncHandler(async (_req: Request, res: Response) => {
    const url = ((await repositorioDoPainel().lerConfiguracao(CHAVE_GRUPO)) ?? '').trim();
    res.json({ success: true, data: { url } });
  }),
);

adminRouter.post(
  '/admin/grupo',
  exigirAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const url = String((req.body as { url?: unknown })?.url ?? '').trim();

    if (url !== '' && !/^https:\/\/chat\.whatsapp\.com\/[A-Za-z0-9]+/.test(url)) {
      res.status(400).json({
        success: false,
        error: 'LINK_INVALIDO',
        message: 'O convite do grupo começa com https://chat.whatsapp.com/ — cole o link do convite, não o nome.',
      });
      return;
    }

    await repositorioDoPainel().salvarConfiguracao(CHAVE_GRUPO, url);
    logger.info('Painel: convite do grupo atualizado', { tem: url !== '' });
    res.json({ success: true, data: { url } });
  }),
);

/**
 * Desfaz um pedido que nunca foi uma venda.
 *
 * Existe porque marcar como pago é fácil e não tinha volta: um pedido de teste
 * carimbado à mão vira faturamento, e faturamento falso não fica só no
 * relatório — ele contamina o ROAS, e o ROAS é quem decide quanto se gasta em
 * anúncio no dia seguinte. Aconteceu aqui: uma bateria rodada contra produção
 * marcou três pedidos de teste como pagos e inventou R$ 185,70.
 *
 * A TRAVA IMPORTANTE: só desfaz o que NÃO foi confirmado pelo gateway. Se a
 * PixGo disse que o dinheiro entrou, o assunto é estorno e se resolve no painel
 * dela — apagar aqui esconderia uma venda real de um cliente que pagou e
 * continua esperando o produto, que é o pior estrago possível neste sistema.
 */
adminRouter.post(
  '/admin/pedidos/:id/cancelar',
  exigirAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const order = await getOrder(req.params.id);
    if (!order) {
      res.status(404).json({ success: false, error: 'NAO_ENCONTRADO', message: 'Pedido não encontrado.' });
      return;
    }

    const motivo = String((req.body as { motivo?: unknown })?.motivo ?? '').trim();
    if (motivo.length < 5) {
      res.status(400).json({
        success: false,
        error: 'MOTIVO_OBRIGATORIO',
        message: 'Diga por que este pedido está sendo desfeito — isso fica no histórico.',
      });
      return;
    }

    const confirmadoPeloGateway = String(order.statusGateway ?? '').toUpperCase() === 'PAID';
    if (confirmadoPeloGateway) {
      res.status(409).json({
        success: false,
        error: 'PAGAMENTO_REAL',
        message:
          'A PixGo confirmou este pagamento. Desfazer aqui esconderia uma venda de verdade — ' +
          'o caminho é estornar no painel do gateway.',
      });
      return;
    }

    const anterior = order.status;

    /*
     * ESCRITA DIRETA, sem passar por `applyStatus` — e o motivo precisa estar
     * claro, porque contornar aquele guarda é coisa séria.
     *
     * `applyStatus` recusa tirar um pedido de `completed` para qualquer coisa
     * que não seja `refunded`, e a recusa está certíssima: é ela que impede uma
     * resposta atrasada do gateway de "despagar" alguém que pagou. Só que essa
     * mesma trava tornava impossível limpar um `completed` que nunca foi venda,
     * e a rota respondia sucesso sem ter mudado nada — mentira pior que o
     * problema original.
     *
     * O que torna isto seguro é a guarda acima: só chega aqui pedido que o
     * gateway NÃO confirmou. Dinheiro de verdade continua intocável por este
     * caminho.
     */
    order.status = 'cancelled';
    order.paidAt = null;
    order.updatedAt = new Date().toISOString();
    await saveOrder(order);
    const atualizado = order;

    await repositorioDoPainel()
      .registrarEvento({
        pedidoId: order.id,
        evento: 'pedido_desfeito',
        origem: req.papelSessao ?? 'dono',
        detalhe: `${anterior} → cancelled; ${motivo}`,
      })
      .catch(() => {
        /* auditoria é acessória */
      });

    logger.warn('Painel: pedido desfeito à mão', { orderId: order.id, anterior, motivo, ip: ipDoCliente(req) });
    res.json({ success: true, data: { pedido: paraPainel(atualizado), anterior } });
  }),
);

/**
 * A conversa de WhatsApp pronta para quem gerou o PIX e não pagou.
 *
 * POR QUE O WHATSAPP E NÃO SÓ O E-MAIL: das 21 primeiras mensagens enviadas,
 * treze não deram sinal nenhum de entrega e duas foram lidas por gente. Este
 * público tem 50 anos ou mais, resolve a vida por WhatsApp e muitas vezes nem
 * abre o e-mail que usou para comprar. O telefone já está no pedido desde o
 * primeiro dia, e ninguém falava com ele.
 *
 * O SERVIDOR MONTA A MENSAGEM, o navegador só abre a conversa. Dois motivos: o
 * link de pagamento precisa ser assinado com a chave mestra, que nunca sai
 * daqui; e a escolha entre preço cheio e desconto é regra de negócio, não
 * decisão de quem está clicando com pressa.
 *
 * O PREÇO MUDA COM O TEMPO, e é regra do dono: nas primeiras 48 h a cobrança é
 * a cheia — a pessoa acabou de decidir comprar por aquele valor, e dar desconto
 * na mesma hora ensina a ela que o preço deste site é negociável. Passados dois
 * dias, aí sim entra a oferta de recuperação.
 */
const HORAS_ATE_O_DESCONTO = 48;

/*
 * A HISTÓRIA DESTES EMOJIS, em dois capítulos de defeito:
 *
 * 1. O 🙏 original chegou quebrado no WhatsApp do dono. Diagnóstico da época:
 *    mora acima de U+FFFF, o par de blocos se perde na URL. Desci tudo para o
 *    bloco básico (✝ ⚔ ✨) achando que resolvia.
 *
 * 2. Em 14/08/2026 os três do bloco básico chegaram quebrados TAMBÉM — o mesmo
 *    losango com interrogação. Ou seja, o diagnóstico 1 era meia-verdade: o
 *    defeito não é o par de blocos, é o CAMINHO. O handler do protocolo do
 *    WhatsApp no Windows corrompe qualquer byte fora do ASCII quando o texto
 *    viaja dentro da URL do `wa.me` — 3 bytes ou 4, tanto faz.
 *
 * A CONSEQUÊNCIA: não existe emoji seguro pela URL. O conserto de verdade foi
 * dar ao painel o botão "Copiar mensagem", que leva o texto pelo clipboard —
 * UTF-16 nativo, nunca corrompe. Com o caminho consertado, os emojis voltaram
 * a ser os de apresentação colorida: o U+FE0F em seguida ao símbolo força a
 * versão emoji (sem ele, cruz e espadas renderizam como símbolo de texto preto
 * e miúdo). Escapes explícitos porque o FE0F é invisível — colado no literal,
 * o próximo editor o apaga sem saber que existia.
 *
 * Um por bloco de texto, nunca mais. Mensagem de cobrança salpicada de emoji
 * lê como disparo automático, e disparo automático é o que faz bloquear o
 * número.
 */
const CRUZ = '✝️';   // cruz latina, colorida
const ESPADA = '⚔️'; // espadas — o símbolo de Miguel
const LUZ = '✨';           // faíscas — a bênção (já nasce colorida)

adminRouter.post(
  '/admin/pedidos/:id/whatsapp',
  exigirAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const order = await getOrder(req.params.id);
    if (!order) {
      res.status(404).json({ success: false, error: 'NAO_ENCONTRADO', message: 'Pedido não encontrado.' });
      return;
    }
    if (order.status === 'completed') {
      res.status(400).json({
        success: false,
        error: 'PEDIDO_JA_PAGO',
        message: 'Este pedido já foi pago — não há o que cobrar.',
      });
      return;
    }
    if (!config.painel.chaveMestra) {
      res.status(503).json({
        success: false,
        error: 'SEM_CHAVE_MESTRA',
        message: 'Configure a PAINEL_CHAVE_MESTRA para gerar o link.',
      });
      return;
    }

    /*
     * O número no formato que o WhatsApp entende: só dígitos, com o 55 na
     * frente. Telefone guardado sem DDD não vira conversa nenhuma — melhor
     * dizer isso agora do que abrir uma janela vazia no celular do dono.
     */
    const digitos = (order.customer.phone ?? '').replace(/\D/g, '').replace(/^55/, '');
    if (digitos.length < 10 || digitos.length > 11) {
      res.status(400).json({
        success: false,
        error: 'TELEFONE_INVALIDO',
        message: `O telefone deste pedido não dá para chamar: "${order.customer.phone ?? ''}".`,
      });
      return;
    }

    const idadeMs = Date.now() - Date.parse(order.createdAt);
    const comDesconto = Number.isFinite(idadeMs) && idadeMs > HORAS_ATE_O_DESCONTO * 3_600_000;

    const expiraEm = Date.now() + 48 * 3_600_000;
    const assinatura = assinarRecuperacao(order.id, expiraEm);
    const base = config.publicBaseUrl || `${req.protocol}://${req.get('host') ?? 'localhost'}`;
    const url = comDesconto
      ? `${base}/api/recuperar/${order.id}/${expiraEm}/${assinatura}`
      : `${base}/api/codigo/${order.id}/${expiraEm}/${assinatura}`;

    /*
     * O nome com a inicial maiúscula, venha como vier do checkout.
     *
     * Muita gente digita tudo minúsculo no celular, e "anthony, que a paz
     * esteja com você" abre a conversa parecendo formulário automático — que é
     * justamente o que esta mensagem não pode parecer. O e-mail já tratava
     * disso; o WhatsApp não.
     */
    const bruto = (order.customer.name ?? '').trim().split(/\s+/)[0] ?? '';
    const primeiro = bruto ? bruto.charAt(0).toUpperCase() + bruto.slice(1).toLowerCase() : '';
    const tratamento = primeiro
      ? `${primeiro}, que a paz esteja com você ${CRUZ}`
      : `Que a paz esteja com você ${CRUZ}`;

    /*
     * CONTRIBUIÇÃO, NUNCA PAGAMENTO — e a escolha é do dono, com razão de
     * negócio: quem entra num funil de oração não está comprando um arquivo,
     * está retribuindo. "Pagamento vencido" transforma um gesto de fé em conta
     * atrasada, e conta atrasada dá vergonha — a pessoa não responde, some.
     *
     * A RECIPROCIDADE VEM DO QUE JÁ FOI DADO, e é verdadeira: ela respondeu as
     * nove perguntas, ouviu o áudio, recebeu o diagnóstico dela, e a Oração
     * está de fato reservada no nome dela — o pedido existe neste banco. Nada
     * aqui promete o que não aconteceu.
     *
     * TIRAR A CULPA DA PESSOA é o que reabre a conversa: "acontece muito, não
     * foi culpa sua" desarma quem sumiu por vergonha de não ter concluído, que
     * é a maioria.
     *
     * Curto de propósito: mensagem longa no WhatsApp parece disparo automático,
     * e disparo automático faz bloquear o número — o que custa muito mais que
     * uma venda.
     */
    const mensagem = comDesconto
      ? [
        tratamento,
        '',
        `${ESPADA} Aqui é das Rezas Sagradas. A sua Oração do Arcanjo Miguel continua guardada no seu nome — ninguém tomou o seu lugar.`,
        '',
        'Sei que às vezes o momento aperta, e ninguém deveria ficar sem oração por causa disso. Por hoje, a sua contribuição pode ser de R$ 27,99:',
        url,
        '',
        `${LUZ} Quem contribui, recebe. É a lei mais antiga do céu: você estende a mão, e ela volta cheia.`,
        '',
        'Se precisar de ajuda, é só me chamar por aqui.',
      ].join('\n')
      : [
        tratamento,
        '',
        'Aqui é das Rezas Sagradas. Você foi até o fim do caminho e respondeu tudo de coração — e o código venceu antes de você concluir. Acontece muito, e não foi culpa sua.',
        '',
        `${ESPADA} A sua Oração continua separada no seu nome. Ninguém tomou o seu lugar.`,
        '',
        'Deixei tudo pronto para você fazer a sua contribuição com um toque:',
        url,
        '',
        `${LUZ} Miguel esperou você chegar até aqui.`,
        'Qualquer coisa, me chama por aqui. Estou por perto.',
      ].join('\n');

    /*
     * Marca a campanha ANTES de responder, e não depois de o dono mandar: o
     * navegador abre o WhatsApp e some, e não há segundo momento em que este
     * servidor volte a ser chamado. Registrar aqui deixa o funil da campanha
     * contar quem já foi abordado, mesmo que a conversa acabe não sendo enviada.
     */
    order.campanha = {
      // Espalha primeiro para não descartar campos que esta rota não conhece.
      ...order.campanha,
      enviadoEm: order.campanha?.enviadoEm ?? new Date().toISOString(),
      // O rótulo do painel depende disto: preço cheio e promoção são mensagens
      // OPOSTAS, e chamar uma pelo nome da outra já fez o dono achar que a
      // regra das 48 h tinha sido furada.
      comDesconto: order.campanha?.comDesconto ?? comDesconto,
      visitadoEm: order.campanha?.visitadoEm ?? null,
      cliques: order.campanha?.cliques ?? 0,
      cobrancaEm: order.campanha?.cobrancaEm ?? null,
      pedidoGerado: order.campanha?.pedidoGerado ?? null,
    };
    await saveOrder(order);

    logger.info('Painel: conversa de WhatsApp preparada', { orderId: order.id, comDesconto });

    res.json({
      success: true,
      data: {
        url: `https://wa.me/55${digitos}?text=${encodeURIComponent(mensagem)}`,
        telefone: telefoneVisivel(order.customer.phone ?? ''),
        comDesconto,
        mensagem,
        /*
         * O ENDEREÇO DE PAGAMENTO SOZINHO, sem a mensagem em volta.
         *
         * Ele já existia aqui dentro — estava embutido no texto e não havia como
         * pegar só ele. Numa conversa que o dono JÁ abriu à mão (o caso comum:
         * ele pergunta "posso mandar o link do pix?" e a pessoa responde que
         * sim), colar a mensagem inteira repete o que ele acabou de dizer e faz
         * a conversa parecer atendimento automático — depois de a pessoa ter
         * respondido a um ser humano.
         */
        linkPagamento: url,
        /** Quando a assinatura do link morre. Depois disso a página recusa. */
        linkExpiraEm: new Date(expiraEm).toISOString(),
        /**
         * Quando este pedido passa a valer o preço com desconto. Vai para a tela
         * porque a pergunta "por que saiu R$ 74 e não R$ 27,99?" é do dono, e a
         * resposta é uma data — não uma regra que ele tem de lembrar de cabeça.
         */
        descontoLiberadoEm: new Date(Date.parse(order.createdAt) + HORAS_ATE_O_DESCONTO * 3_600_000).toISOString(),
        valorFormatado: formatBRL(order.amountCents),
      },
    });
  }),
);

adminRouter.post(
  '/admin/pedidos/:id/link',
  exigirAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const order = await getOrder(req.params.id);
    if (!order) {
      res.status(404).json({ success: false, error: 'NAO_ENCONTRADO', message: 'Pedido não encontrado.' });
      return;
    }
    if (order.status !== 'completed') {
      res.status(400).json({
        success: false,
        error: 'PEDIDO_NAO_PAGO',
        message: 'O link de entrega só existe para pedido pago.',
      });
      return;
    }
    if (!config.painel.chaveMestra) {
      res.status(503).json({
        success: false,
        error: 'SEM_CHAVE_MESTRA',
        message: 'Configure a PAINEL_CHAVE_MESTRA para gerar links de entrega.',
      });
      return;
    }

    const expiraEm = Date.now() + HORAS_LINK_ENTREGA * 3_600_000;
    const assinatura = assinarEntrega(order.id, expiraEm);
    const base = config.publicBaseUrl || `${req.protocol}://${req.get('host') ?? 'localhost'}`;

    logger.info('Painel: link de entrega gerado', { orderId: order.id, ip: ipDoCliente(req) });
    res.json({
      success: true,
      data: { url: `${base}/api/entrega/${order.id}/${expiraEm}/${assinatura}`, horas: HORAS_LINK_ENTREGA },
    });
  }),
);

adminRouter.post(
  '/admin/verificar-pendentes',
  exigirAdmin,
  asyncHandler(async (_req: Request, res: Response) => {
    const orcamento = await getStatusPollUsage();
    if (orcamento.budget - orcamento.count < 50) {
      res.status(429).json({
        success: false,
        error: 'ORCAMENTO_BAIXO',
        message:
          'As consultas ao sistema de Pix de hoje estão no fim. A confirmação automática continua funcionando; tente amanhã.',
      });
      return;
    }

    const desde = new Date(Date.now() - 48 * 3_600_000).toISOString();
    const pendentes = (await listOrders({ desde, limite: LIMITE_PEDIDOS }))
      .filter((order) => order.status === 'pending' && order.paymentId)
      .slice(0, PENDENTES_POR_CLIQUE);

    let pagosNovos = 0;
    let verificados = 0;

    for (let inicio = 0; inicio < pendentes.length; inicio += LOTE_PENDENTES) {
      const lote = pendentes.slice(inicio, inicio + LOTE_PENDENTES);
      const resultados = await Promise.allSettled(
        lote.map((order) => reconcileOrder(order, { ignorarIntervalo: true })),
      );

      for (const resultado of resultados) {
        // Erro em um pedido não interrompe o lote: o dono prefere 11 de 12.
        if (resultado.status !== 'fulfilled') continue;
        verificados += 1;
        if (resultado.value.status === 'completed') pagosNovos += 1;
      }
    }

    res.json({
      success: true,
      data: { verificados, pagosNovos, restantes: Math.max(0, pendentes.length - verificados) },
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* Entregas: links editáveis, teste e histórico                                */
/* -------------------------------------------------------------------------- */

adminRouter.get(
  '/admin/entregas',
  exigirAdmin,
  asyncHandler(async (_req: Request, res: Response) => {
    const repositorio = repositorioDoPainel();
    const [entregas, historico] = await Promise.all([
      repositorio.listarEntregas(),
      repositorio.historicoDeEntregas(200),
    ]);

    res.json({
      success: true,
      data: {
        entregas,
        historico,
        tipos: TIPOS_DE_ENTREGA.map((tipo) => ({ valor: tipo, rotulo: ROTULO_DO_TIPO[tipo] })),
        armazenamento: repositorio.tipo,
      },
    });
  }),
);

adminRouter.post(
  '/admin/entregas/:itemId',
  exigirAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const corpo = (req.body ?? {}) as Record<string, unknown>;
    const itemId = req.params.itemId;

    if (!CATALOG[itemId]) {
      res.status(404).json({ success: false, error: 'PRODUTO_DESCONHECIDO', message: 'Produto não existe no catálogo.' });
      return;
    }

    const tipo = String(corpo.tipo ?? 'arquivo') as TipoEntrega;
    if (!TIPOS_DE_ENTREGA.includes(tipo)) {
      res.status(400).json({ success: false, error: 'TIPO_INVALIDO', message: 'Tipo de produto desconhecido.' });
      return;
    }

    const url = String(corpo.url ?? '').trim();
    // Link quebrado entregue ao cliente é pior que link ausente: o aviso de
    // "não configurado" pelo menos diz a verdade.
    if (url && !/^https:\/\/\S+$/i.test(url)) {
      res.status(400).json({
        success: false,
        error: 'URL_INVALIDA',
        message: 'O link precisa começar com https:// e não pode ter espaços.',
      });
      return;
    }

    const nome = String(corpo.nome ?? '').trim() || CATALOG[itemId].title;
    const ativo = corpo.ativo !== false;

    const salvo = await repositorioDoPainel().salvarEntrega(
      { itemId, nome: nome.slice(0, 160), url, ativo, tipo },
      req.papelSessao ?? 'dono',
    );

    logger.info('Painel: link de entrega alterado', { itemId, ativo, tipo, temUrl: Boolean(url), ip: ipDoCliente(req) });
    res.json({ success: true, data: { entrega: salvo } });
  }),
);

/**
 * Testa o link do lado do servidor. Feito pelo navegador, a checagem esbarraria
 * em CORS e diria "falhou" para link bom.
 */
adminRouter.post(
  '/admin/entregas/:itemId/testar',
  exigirAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const entregas = await repositorioDoPainel().listarEntregas();
    const entrega = entregas.find((item) => item.itemId === req.params.itemId);

    if (!entrega || !entrega.url) {
      res.status(400).json({ success: false, error: 'SEM_URL', message: 'Este produto ainda não tem link.' });
      return;
    }

    const controlador = new AbortController();
    const relogio = setTimeout(() => controlador.abort(), 8000);
    const comecou = Date.now();

    try {
      // HEAD primeiro por ser barato; muitos servidores só respondem ao GET.
      let resposta = await fetch(entrega.url, { method: 'HEAD', signal: controlador.signal, redirect: 'follow' });
      if (resposta.status === 405 || resposta.status === 501) {
        resposta = await fetch(entrega.url, { method: 'GET', signal: controlador.signal, redirect: 'follow' });
      }

      const ok = resposta.status >= 200 && resposta.status < 400;
      res.json({
        success: true,
        data: {
          ok,
          status: resposta.status,
          tipoDoConteudo: resposta.headers.get('content-type'),
          levouMs: Date.now() - comecou,
          mensagem: ok
            ? 'O link respondeu normalmente.'
            : `O servidor do link respondeu ${resposta.status}. Confira se o arquivo é público.`,
        },
      });
    } catch (erro) {
      const abortou = (erro as Error).name === 'AbortError';
      res.json({
        success: true,
        data: {
          ok: false,
          status: 0,
          levouMs: Date.now() - comecou,
          mensagem: abortou
            ? 'O link demorou mais de 8 segundos para responder.'
            : `Não foi possível abrir o link: ${(erro as Error).message}`,
        },
      });
    } finally {
      clearTimeout(relogio);
    }
  }),
);

/* -------------------------------------------------------------------------- */
/* Webhooks recebidos                                                          */
/* -------------------------------------------------------------------------- */

adminRouter.get(
  '/admin/webhooks',
  exigirAdmin,
  asyncHandler(async (_req: Request, res: Response) => {
    const recebidos = await repositorioDoPainel().listarWebhooks(200);
    res.json({ success: true, data: { recebidos } });
  }),
);

/* -------------------------------------------------------------------------- */
/* Reenvio manual da entrega                                                   */
/* -------------------------------------------------------------------------- */

adminRouter.post(
  '/admin/pedidos/:id/reenviar-entrega',
  exigirAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const order = await getOrder(req.params.id);
    if (!order) {
      res.status(404).json({ success: false, error: 'NAO_ENCONTRADO', message: 'Pedido não encontrado.' });
      return;
    }
    if (order.status !== 'completed') {
      res.status(400).json({
        success: false,
        error: 'PEDIDO_NAO_PAGO',
        message: 'Só é possível reenviar a entrega de um pedido pago.',
      });
      return;
    }
    if (!config.painel.chaveMestra) {
      res.status(503).json({
        success: false,
        error: 'SEM_CHAVE_MESTRA',
        message: 'Configure a PAINEL_CHAVE_MESTRA para gerar links de entrega.',
      });
      return;
    }

    const bundle = await buildAccessBundle(order);
    const semLink = bundle.contents.filter((item) => !item.url && item.tipo !== 'servico');

    const expiraEm = Date.now() + HORAS_LINK_ENTREGA * 3_600_000;
    const base = config.publicBaseUrl || `${req.protocol}://${req.get('host') ?? 'localhost'}`;
    const url = `${base}/api/entrega/${order.id}/${expiraEm}/${assinarEntrega(order.id, expiraEm)}`;

    /*
     * Reenvia por e-mail TAMBÉM, além de devolver o link.
     *
     * O link continua existindo porque é ele que o dono cola no WhatsApp — que
     * é como este público resolve problema. Mas quando o envio automático falha
     * (provedor fora do ar, caixa cheia, endereço digitado errado e corrigido
     * depois), sem isto a única saída seria um deploy. Aqui o envio é o mesmo
     * caminho do automático e não passa pela guarda de `accessEmailSentAt`: se
     * o dono apertou o botão, é porque quer que saia de novo.
     */
    const envio = await enviarEmailDeAcesso(order);
    if (envio.enviado && !order.accessEmailSentAt) {
      order.accessEmailSentAt = new Date().toISOString();
      await saveOrder(order);
    }

    await repositorioDoPainel().registrarEvento({
      pedidoId: order.id,
      evento: 'entrega_reenviada',
      origem: req.papelSessao ?? 'dono',
      detalhe: `link válido por ${HORAS_LINK_ENTREGA} h` +
        (envio.enviado ? '; e-mail reenviado' : `; e-mail NÃO saiu (${envio.motivo ?? 'motivo desconhecido'})`),
    });

    logger.info('Painel: entrega reenviada', { orderId: order.id, email: envio.enviado, ip: ipDoCliente(req) });

    res.json({
      success: true,
      data: {
        url,
        horas: HORAS_LINK_ENTREGA,
        itens: bundle.contents.map((item) => ({ titulo: item.title, tipo: item.tipo, temLink: Boolean(item.url) })),
        // O dono precisa saber ANTES de mandar que o link vai chegar vazio.
        avisoSemLink: semLink.map((item) => item.title),
        // E precisa saber se o e-mail saiu, para decidir se manda pelo WhatsApp.
        email: { enviado: envio.enviado, destino: order.customer.email, motivo: envio.motivo ?? null },
      },
    });
  }),
);


/*
 * O lembrete de WhatsApp para PIX nao pago.
 *
 * NAO COBRA NADA: nao cria pagamento, nao gera link de recuperacao, nao aplica
 * desconto e NAO MUDA O STATUS do pedido. Devolve um endereco `wa.me` com a
 * mensagem pronta e grava que o lembrete foi aberto. Quem envia e o dono, pelo
 * aplicativo dele.
 *
 * E DIFERENTE de `/admin/pedidos/:id/whatsapp`, logo acima, que gera um link
 * ASSINADO com preco menor. Aquele e uma oferta nova; este e so um toque no
 * ombro. Ter os dois no mesmo botao faria o dono dar desconto sem querer, todo
 * dia, para gente que ainda pagaria o preco cheio.
 */
adminRouter.post(
  '/admin/pedidos/:id/lembrete-whatsapp',
  exigirAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const order = await getOrder(req.params.id);
    if (!order) {
      res.status(404).json({ success: false, error: 'NAO_ENCONTRADO', message: 'Pedido não encontrado.' });
      return;
    }

    /*
     * Pedido pago nao recebe lembrete, e a recusa e do SERVIDOR e nao da tela.
     * A tela ja esconde o botao; se a unica guarda fosse ela, uma aba aberta
     * desde antes do pagamento mandaria "falta concluir sua contribuicao" para
     * quem acabou de pagar -- que e a mensagem mais cara que este painel poderia
     * enviar.
     */
    if (!cabeLembrete(order)) {
      res.status(400).json({
        success: false,
        error: 'NAO_CABE_LEMBRETE',
        message: order.status === 'completed'
          ? 'Este pedido já foi pago — não há lembrete a enviar.'
          : 'Este pedido não chegou a gerar PIX, então não há o que lembrar.',
      });
      return;
    }

    const montado = linkDoLembrete(order);
    if ('erro' in montado) {
      res.status(400).json({ success: false, error: 'TELEFONE_INVALIDO', message: montado.erro });
      return;
    }

    /*
     * Grava ANTES de responder. Na Vercel a funcao pode congelar assim que
     * responde, e uma gravacao solta simplesmente nao aconteceria (regra 8) --
     * o contador ficaria parado em zero por mais que o dono clicasse.
     *
     * Se a gravacao falhar, o link SAI MESMO ASSIM: perder o registro de um
     * lembrete e um numero errado; nao abrir a conversa e uma venda a menos.
     */
    let registrado = true;
    try {
      await repositorioDoPainel().registrarEvento({
        pedidoId: order.id,
        evento: EVENTO_LEMBRETE,
        origem: req.papelSessao ?? 'dono',
        detalhe: `lembrete aberto para ${montado.numero}`,
      });
    } catch (erro) {
      registrado = false;
      logger.warn('Lembrete aberto, mas nao registrado', { orderId: order.id, erro: (erro as Error).message });
    }

    const contagem = (await repositorioDoPainel().contarEventosPorPedido(EVENTO_LEMBRETE))
      .find((c) => c.pedidoId === order.id);

    logger.info('Painel: lembrete de WhatsApp aberto', {
      orderId: order.id,
      total: contagem?.total ?? 0,
      ip: ipDoCliente(req),
    });

    res.json({
      success: true,
      data: {
        url: montado.url,
        numero: montado.numero,
        lembretesEnviados: contagem?.total ?? (registrado ? 1 : 0),
        registrado,
        /* Para a tela nao precisar saber que este botao nao cobra: o servidor diz. */
        alterouStatus: false,
      },
    });
  }),
);

adminRouter.get(
  '/admin/pedidos/:id/eventos',
  exigirAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const eventos = await repositorioDoPainel().listarEventos(req.params.id);
    res.json({ success: true, data: { eventos } });
  }),
);

/* -------------------------------------------------------------------------- */
/* Anúncios: o que cada campanha, conjunto e anúncio trouxe                     */
/* -------------------------------------------------------------------------- */

/** Os números que são contados. Tudo o mais nesta tela é derivado deles. */
interface NumerosBrutos {
  impressoes: number;
  cliques: number;
  visitas: number;
  quiz: number;
  vsl: number;
  checkout: number;
  pixGerados: number;
  vendas: number;
  receitaCentavos: number;
  investimentoCentavos: number;
}

interface LinhaDeAnuncio extends NumerosBrutos {
  chave: string;
  rotulo: string;
  plataforma: 'facebook' | 'google' | 'tiktok' | 'direto';
  /**
   * Está rodando agora?
   *
   * `null` quando o painel não sabe: conta sem a situação importada ainda, ou
   * linha que não existe mais no Meta — uma venda antiga de anúncio já apagado
   * continua na tabela e não tem situação nenhuma para mostrar.
   *
   * Nulo NÃO é "parado". A tela precisa distinguir "está desligado" de "não
   * faço ideia", senão a primeira importação que falhar vai declarar a conta
   * inteira como parada.
   */
  ativo: boolean | null;
  /**
   * O identificador do nível acima: a campanha de um conjunto, o conjunto de
   * um anúncio. Serve para o painel descer a hierarquia — clicar numa campanha
   * e ver só os conjuntos dela, em vez de uma lista solta em que só o nome
   * diferencia os filhos.
   */
  pai?: string | null;
}

function brutosZerados(): NumerosBrutos {
  return {
    impressoes: 0,
    cliques: 0,
    visitas: 0,
    quiz: 0,
    vsl: 0,
    checkout: 0,
    pixGerados: 0,
    vendas: 0,
    receitaCentavos: 0,
    investimentoCentavos: 0,
  };
}

function linhaVazia(chave: string): LinhaDeAnuncio {
  return { chave, rotulo: '', plataforma: 'direto', ativo: null, ...brutosZerados() };
}

function somarBrutos(destino: NumerosBrutos, parcela: NumerosBrutos): void {
  destino.impressoes += parcela.impressoes;
  destino.cliques += parcela.cliques;
  destino.visitas += parcela.visitas;
  destino.quiz += parcela.quiz;
  destino.vsl += parcela.vsl;
  destino.checkout += parcela.checkout;
  destino.pixGerados += parcela.pixGerados;
  destino.vendas += parcela.vendas;
  destino.receitaCentavos += parcela.receitaCentavos;
  destino.investimentoCentavos += parcela.investimentoCentavos;
}

/**
 * Fecha o funil de baixo para cima: nenhuma etapa pode ser menor que a
 * seguinte.
 *
 * As quatro primeiras colunas vêm de evento de navegador e as duas últimas, de
 * pedido gravado no banco. São fontes de confiabilidade diferente, e a de cima
 * é a que falha: bloqueador de anúncio, aba fechada antes de a requisição sair,
 * rede de celular caindo. O resultado aparecia na tela como "2 no checkout, 3
 * Pix, 3 vendas" — um funil que engorda para baixo, que nenhum dono consegue
 * ler e que faz a taxa de passagem passar de 100 %.
 *
 * A correção é para o lado do que é certo: uma venda PROVA que houve checkout,
 * VSL, quiz e visita. O evento que não chegou não desfaz o pagamento. O
 * contrário — deixar a etapa menor — seria dar ao evento perdido o poder de
 * apagar dinheiro que entrou.
 */
function firmarFunil(n: NumerosBrutos): void {
  n.checkout = Math.max(n.checkout, n.pixGerados, n.vendas);
  n.vsl = Math.max(n.vsl, n.checkout);
  n.quiz = Math.max(n.quiz, n.vsl);
  n.visitas = Math.max(n.visitas, n.quiz);
}

/**
 * As medidas que se calculam a partir dos números contados.
 *
 * `null` e não zero quando a conta não existe. Zero é uma resposta — "o CPA
 * deste anúncio é R$ 0,00" — e seria mentira quando o que houve foi divisão por
 * zero. A tela mostra "—" e o dono entende que ainda não há base, em vez de
 * comemorar um custo por venda inexistente.
 */
interface MetricasDerivadas {
  ctr: number | null;
  cpcCentavos: number | null;
  cpmCentavos: number | null;
  custoPorVisitaCentavos: number | null;
  cpaCentavos: number | null;
  roas: number | null;
  ticketCentavos: number | null;
  conversao: number | null;
  lucroCentavos: number | null;
  /** Quanto do que entrou sobrou depois de pagar o anúncio. */
  margem: number | null;
}

function derivar(n: NumerosBrutos): MetricasDerivadas {
  const dividir = (topo: number, base: number): number | null => (base > 0 ? topo / base : null);

  return {
    ctr: dividir(n.cliques, n.impressoes),
    cpcCentavos: dividir(n.investimentoCentavos, n.cliques),
    // CPM é por mil impressões — daí o × 1000, e não o × 100 de sempre.
    cpmCentavos: n.impressoes > 0 ? (n.investimentoCentavos / n.impressoes) * 1000 : null,
    custoPorVisitaCentavos: dividir(n.investimentoCentavos, n.visitas),
    cpaCentavos: dividir(n.investimentoCentavos, n.vendas),
    roas: dividir(n.receitaCentavos, n.investimentoCentavos),
    ticketCentavos: dividir(n.receitaCentavos, n.vendas),
    conversao: dividir(n.vendas, n.visitas),
    // Sem gasto anotado não há lucro a mostrar: seria a receita disfarçada de
    // lucro, que é exatamente o erro que esta tela existe para evitar.
    lucroCentavos: n.investimentoCentavos > 0 ? n.receitaCentavos - n.investimentoCentavos : null,
    margem:
      n.investimentoCentavos > 0 && n.receitaCentavos > 0
        ? (n.receitaCentavos - n.investimentoCentavos) / n.receitaCentavos
        : null,
  };
}

/**
 * Quantas vezes a receita precisa cobrir o gasto para o anúncio valer a pena.
 *
 * Fica configurável porque o número certo depende do custo do negócio, não do
 * código: produto digital tem custo marginal quase zero, mas ainda há taxa do
 * gateway, reembolso e o tempo de quem atende o WhatsApp. O padrão de 2x é
 * conservador o bastante para não mandar escalar anúncio que só empata.
 */
const CHAVE_META_ROAS = 'anuncios.meta_roas';
const META_ROAS_PADRAO = 2;

async function lerMetaDeRoas(): Promise<number> {
  const guardado = await repositorioDoPainel().lerConfiguracao(CHAVE_META_ROAS);
  const numero = Number.parseFloat(guardado ?? '');
  return Number.isFinite(numero) && numero > 0 ? numero : META_ROAS_PADRAO;
}

/**
 * O recorte que a tela pediu: quantos dias, terminando quando.
 *
 * `ate=ontem` é o único valor que desloca o fim da janela, e existe porque
 * "ontem" é a pergunta que se faz de manhã — o dia que já fechou e não muda
 * mais. Sem ele o menor período possível era "hoje", que às 8 h da manhã tem
 * quase nada dentro e faz qualquer anúncio parecer morto.
 *
 * Qualquer outro valor cai em hoje, inclusive lixo: o painel prefere mostrar o
 * período padrão a devolver erro por causa de um parâmetro digitado errado.
 */
function recortePedido(req: Request, agoraMs: number): { dias: number; janela: Janela } {
  const bruto = Number.parseInt(String(req.query.dias ?? '7'), 10);
  const dias = Number.isFinite(bruto) && bruto > 0 && bruto <= 365 ? bruto : 7;
  const ate = String(req.query.ate ?? 'hoje')
    .trim()
    .toLowerCase();
  const hoje = diaLocal(agoraMs);
  const diaFinal = ate === 'ontem' ? somarDias(hoje, -1) : hoje;

  return { dias, janela: janelaDeDiasAte(dias, diaFinal, agoraMs) };
}

/*
 * Histórico de acessos + auditoria (aba Acessos). Ver server/auditoria.ts.
 *
 * Três blocos: quem entrou no painel (e quem errou a senha), o que foi feito
 * no painel, e quais clientes abriram a página de entrega — com a lista de
 * quem PAGOU e nunca abriu, que é quem precisa de um WhatsApp.
 */
adminRouter.get(
  '/admin/acessos',
  exigirAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const agoraMs = Date.now();
    const bruto = Number.parseInt(String(req.query.dias ?? '7'), 10);
    const dias = Number.isFinite(bruto) && bruto > 0 && bruto <= 90 ? bruto : 7;
    const janela = janelaDeDiasAte(dias, diaLocal(agoraMs), agoraMs);

    const [registros, pedidos] = await Promise.all([
      repositorioDoPainel().listarAuditoria({ desde: janela.desde, limite: 600 }),
      listOrders({ desde: janela.desde, limite: LIMITE_PEDIDOS }),
    ]);

    const auditoria = registros.map((r) => ({ ...r, rotulo: rotuloDaAcao(r.acao) }));
    const logins = auditoria.filter((r) => r.acao.startsWith('login.'));
    const acoes = auditoria.filter((r) => r.acao.startsWith('POST '));
    const clientes = auditoria.filter((r) => r.papel === 'cliente');

    /*
     * Entregas: cada pedido pago do período, com quantas vezes a página foi
     * aberta. O contador mora no próprio pedido (order.entregas), então isto
     * funciona para vendas anteriores à auditoria existir.
     */
    const entregas = pedidos
      .filter((o) => o.status === 'completed')
      .map((o) => ({
        id: o.id,
        pagoEm: o.paidAt ?? o.createdAt,
        nome: o.customer.name,
        email: o.customer.email ?? '',
        telefone: o.customer.phone ?? '',
        itens: o.itemIds.map((i) => CATALOG[i]?.title ?? i),
        principal: o.parentOrderId === null,
        emailEnviadoEm: o.accessEmailSentAt ?? null,
        aberturas: o.entregas?.total ?? 0,
        ultimaAberturaEm: o.entregas?.ultimoEm ?? null,
        ultimoIp: o.entregas?.ultimoIp ?? null,
      }))
      .sort((a, b) => b.pagoEm.localeCompare(a.pagoEm));

    res.json({
      success: true,
      data: {
        dias,
        resumo: {
          loginsOk: logins.filter((r) => r.acao === 'login.ok').length,
          senhasErradas: logins.filter((r) => r.acao !== 'login.ok').length,
          ipsDistintos: new Set(logins.filter((r) => r.acao === 'login.ok').map((r) => r.ip)).size,
          acoesNoPainel: acoes.length,
          entregasAbertas: entregas.filter((e) => e.aberturas > 0).length,
          pagosSemAbrir: entregas.filter((e) => e.aberturas === 0 && e.principal).length,
          pagos: entregas.filter((e) => e.principal).length,
        },
        logins,
        acoes,
        clientes,
        entregas,
        armazenamento: repositorioDoPainel().tipo,
      },
    });
  }),
);

/*
 * Fechamento diário (aba Relatórios). Ver server/fechamento.ts.
 *
 * `dias` é quantos dias terminando hoje (padrão 14, teto 90). Tudo em
 * dia-calendário de São Paulo, o mesmo dia do Gerenciador de Anúncios.
 */
adminRouter.get(
  '/admin/relatorios',
  exigirAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const agoraMs = Date.now();
    const bruto = Number.parseInt(String(req.query.dias ?? '14'), 10);
    const dias = Number.isFinite(bruto) && bruto > 0 && bruto <= 90 ? bruto : 14;
    const janela = janelaDeDiasAte(dias, diaLocal(agoraMs), agoraMs);

    const [pedidos, funil, investimentos] = await Promise.all([
      listOrders({ desde: janela.desde, limite: LIMITE_PEDIDOS }),
      repositorioDoPainel().funilPorDia({ desde: janela.desde, ate: janela.ate }),
      // Só campanha: os três níveis são o mesmo dinheiro (ver NivelDeInvestimento).
      repositorioDoPainel().listarInvestimentos({ desde: janela.diaInicial, nivel: 'campanha' }),
    ]);

    const fechamento = montarFechamento({ dias, agoraMs, pedidos, funil, investimentos });
    res.json({
      success: true,
      data: {
        ...fechamento,
        textos: {
          hoje: textoDoFechamento(fechamento.dias[0]),
          ontem: fechamento.dias[1] ? textoDoFechamento(fechamento.dias[1]) : null,
          periodo: textoDoFechamento(fechamento.totais),
        },
      },
    });
  }),
);

adminRouter.get(
  '/admin/anuncios',
  exigirAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const pedido = String(req.query.agrupamento ?? 'campanha');
    const agrupamento: AgrupamentoDeAnuncio =
      pedido === 'conjunto' || pedido === 'anuncio' ? pedido : 'campanha';

    /*
     * O período é de dia-calendário em São Paulo, não de "N × 24 h atrás".
     *
     * "Hoje" precisa significar da meia-noite até agora, igual ao que o
     * Gerenciador de Anúncios mostra e igual ao dia que o dono anota o gasto.
     * Como o processo roda em UTC na Vercel, a janela deslizante misturava
     * ontem com hoje o dia inteiro — e depois das 21 h, quando o UTC já virou,
     * o gasto anotado hoje caía fora do próprio dia. Ver server/periodo.ts.
     */
    const agoraMs = Date.now();
    const { dias: diasValidos, janela } = recortePedido(req, agoraMs);
    // Mesmo tamanho, colada no começo desta e cortada no mesmo horário: hoje
    // até as 10 h contra ontem até as 10 h.
    const passada = janelaAnterior(janela, diasValidos, agoraMs);
    const desde = janela.desde;

    /*
     * A BM escolhida no painel. Vazio (ou "todas") = sem filtro.
     *
     * Saneada com a mesma regra dos parâmetros de atribuição, e pelo mesmo
     * motivo: o valor nasce numa URL de anúncio digitada à mão e chega aqui pela
     * query string. Alfabeto fechado e 64 caracteres bastam para o uso e fecham
     * a porta para um nome forjado virar chave de objeto no relatório.
     */
    const bmBruta = String(req.query.bm ?? '').trim().toLowerCase().slice(0, 64);
    const bmEscolhida =
      bmBruta === '' || bmBruta === 'todas' || !/^[a-z0-9_-]+$/.test(bmBruta) ? null : bmBruta;

    const [contagens, contagensAnteriores, pedidos, investimentos, credenciais, metaRoas, estado, bmsDisponiveis] = await Promise.all([
      repositorioDoPainel().contarFunil({ desde, ate: janela.ate, agrupamento, bm: bmEscolhida }),
      repositorioDoPainel().contarFunil({ desde: passada.desde, ate: passada.ate, agrupamento, bm: bmEscolhida }),
      /*
       * Uma consulta só, cobrindo as duas janelas, separada em memória depois.
       *
       * `listOrders` devolve do mais novo para o mais antigo: se o limite
       * cortar, o que se perde é o começo do período ANTERIOR — o número de
       * hoje continua inteiro, e só a seta de comparação fica conservadora.
       * O contrário (perder o período atual) seria inaceitável.
       */
      listOrders({ desde: passada.desde, limite: LIMITE_PEDIDOS }),
      /*
       * Só o gasto do MESMO nível que a tabela está mostrando.
       *
       * O Gerenciador de Anúncios expõe o mesmo dinheiro em três alturas —
       * campanha, conjunto e anúncio — e a importação automática guarda as três,
       * para a coluna "Investido" existir em qualquer agrupamento. Trazer todas
       * de uma vez somaria o mesmo gasto três vezes no rodapé de totais, e o
       * ROAS apareceria a um terço do real.
       */
      repositorioDoPainel().listarInvestimentos({ desde: passada.diaInicial, nivel: agrupamento }),
      credenciaisDoMeta(),
      lerMetaDeRoas(),
      /*
       * A situação de cada campanha, conjunto e anúncio, como está AGORA.
       *
       * Não depende do período: a pergunta "o que está rodando" não muda
       * conforme o dono escolhe ontem ou trinta dias. Nunca lança — sem esse
       * dado a tabela só deixa de separar ligados de parados.
       */
      estadoDosAnuncios(),
      /*
       * A lista sai da janela INTEIRA (período atual + anterior), não só do
       * atual. Se saísse só do atual, a BM que você pausou ontem sumiria do
       * seletor hoje — e some junto a chance de comparar com o período em que
       * ela rodava, que é a única pergunta que importa sobre uma BM pausada.
       */
      repositorioDoPainel().listarBms({ desde: passada.desde, ate: janela.ate }),
    ]);

    const linhas = new Map<string, LinhaDeAnuncio>();
    const pegar = (chave: string): LinhaDeAnuncio => {
      const atual = linhas.get(chave) ?? linhaVazia(chave);
      linhas.set(chave, atual);
      return atual;
    };
    const anterior = brutosZerados();

    // O caminho pelo funil vem dos eventos: são eles que sabem de quem chegou e
    // não comprou, que é justamente quem o pedido nunca registra. As etapas já
    // chegam cumulativas do repositório (ver EtapasDoFunil).
    for (const contagem of contagens) {
      const linha = pegar(contagem.chave);
      if (!linha.rotulo && contagem.nome) linha.rotulo = contagem.nome;
      if (contagem.temFacebook) linha.plataforma = 'facebook';
      else if (linha.plataforma === 'direto') {
        linha.plataforma = plataformaDaOrigem({ utm_source: contagem.fonte, gclid: null });
      }

      linha.visitas += contagem.visitas;
      linha.quiz += contagem.quiz;
      linha.vsl += contagem.vsl;
      linha.checkout += contagem.checkout;
    }

    // Do período anterior só interessa o total: a comparação é da tela inteira,
    // não linha a linha — campanha que nem existia antes não tem com o que ser
    // comparada.
    for (const contagem of contagensAnteriores) {
      anterior.visitas += contagem.visitas;
      anterior.quiz += contagem.quiz;
      anterior.vsl += contagem.vsl;
      anterior.checkout += contagem.checkout;
    }

    /*
     * Vendas e receita vêm dos PEDIDOS, não dos eventos.
     *
     * O pedido é a única fonte que sobrevive ao cliente fechar a aba para pagar
     * no banco — e é o servidor quem confirma o pagamento. Contar venda por
     * evento de navegador daria um número menor e instável.
     *
     * Antes de somar, porém: o pedido que chegou sem carimbo herda o do funil.
     *
     * A origem viaja no `localStorage` do navegador e pode se perder entre a
     * visita e o pagamento. Quando isso acontece, a visita fica na linha do
     * anúncio e a VENDA cai em "(sem origem)" — a campanha que pagou pela venda
     * aparece com checkout e zero vendas, que é o número que faz o dono
     * desligar justamente o anúncio que estava funcionando. O `trackId` do
     * pedido é a sessão do funil, então a origem certa está a uma consulta de
     * distância.
     */
    const orfaos = pedidos.filter(
      (order) => order.createdAt >= desde && chaveDoGrupo(order.atribuicao ?? {}, agrupamento) === '' && order.trackId,
    );
    let chavePorSessao = new Map<string, string>();
    if (orfaos.length > 0) {
      try {
        chavePorSessao = await repositorioDoPainel().chaveDasSessoes({
          sessoes: [...new Set(orfaos.map((order) => order.trackId as string))],
          agrupamento,
          desde: passada.desde,
        });
      } catch (erro) {
        // Sem isto a tela inteira cairia por causa de um refinamento de
        // relatório. O pior caso aqui é a venda voltar a aparecer em
        // "(sem origem)", que é exatamente como era antes — nenhum número
        // fica errado, só menos preciso.
        logger.error('Falha ao recuperar a origem pela sessão do funil', { erro: (erro as Error).message });
      }
    }

    const chaveDoPedido = (order: Order): string => {
      const doCarimbo = chaveDoGrupo(order.atribuicao ?? {}, agrupamento);
      if (doCarimbo !== '') return doCarimbo;
      return (order.trackId && chavePorSessao.get(order.trackId)) || '';
    };

    for (const order of pedidos) {
      /*
       * A venda tambem obedece ao filtro de BM, e isto NAO e detalhe.
       *
       * As visitas ja vem filtradas do banco. Se as vendas nao viessem, a tabela
       * mostraria o trafego de uma BM com o faturamento das cinco: o ROAS de
       * cada linha ficaria varias vezes maior que o real, e a decisao tomada em
       * cima dele seria escalar a conta errada com dinheiro de verdade.
       *
       * O pedido carrega o carimbo em `atribuicao.bm`, gravado na primeira carga
       * junto do resto da origem.
       */
      if (bmEscolhida !== null && (order.atribuicao?.bm ?? '').trim().toLowerCase() !== bmEscolhida) {
        continue;
      }

      const doPeriodoAtual = order.createdAt >= desde;
      // Fora das duas janelas o pedido não entra em conta nenhuma: a janela
      // anterior termina no mesmo horário desta, e não à meia-noite.
      if (!doPeriodoAtual && order.createdAt >= passada.ate) continue;

      const alvo = doPeriodoAtual ? pegar(chaveDoPedido(order)) : anterior;

      if (doPeriodoAtual) {
        const linha = alvo as LinhaDeAnuncio;
        if (linha.plataforma === 'direto') linha.plataforma = plataformaDaOrigem(order.atribuicao);
      }

      // PIX gerado e venda contam só o pedido principal: upsell e downsell são
      // pedidos separados do MESMO cliente, e somá-los infla a contagem e
      // destrói o ticket médio.
      const principal = order.parentOrderId === null;
      if (principal) {
        alvo.pixGerados += 1;
        if (order.status === 'completed') alvo.vendas += 1;
      }
      // A receita, ao contrário, soma tudo que foi pago: é dinheiro que entrou.
      if (order.status === 'completed') alvo.receitaCentavos += order.amountCents;
    }

    // `pegar` e não `get`: a campanha precisa entrar na lista mesmo que não
    // tenha trazido visita nenhuma — ver o comentário do filtro, abaixo.
    /*
     * O gasto é anotado por dia-calendário, e agora o corte é o MESMO dia que
     * o painel chama de primeiro dia do período. Com a janela deslizante
     * antiga, `desde` era um instante no meio de ontem e o gasto de ontem
     * inteiro entrava no total de "hoje".
     */
    const diaDeCorte = janela.diaInicial;
    for (const investimento of investimentos) {
      /*
       * Teto, além do piso.
       *
       * Enquanto todo período terminava hoje, não existia gasto depois do fim
       * da janela e bastava cortar por baixo. Com "Ontem" passou a existir: o
       * gasto de hoje é posterior ao recorte e não pertence nem ao período
       * atual nem ao anterior — cairia no total de ontem e faria um dia
       * fechado crescer ao longo do dia seguinte.
       */
      if (investimento.dia > janela.diaFinal) continue;
      const alvo = investimento.dia >= diaDeCorte ? pegar(investimento.chave) : anterior;
      alvo.investimentoCentavos += investimento.centavos;
      alvo.impressoes += investimento.impressoes;
      alvo.cliques += investimento.cliques;
    }

    /*
     * Campanha com investimento e SEM visita nenhuma continua na lista.
     *
     * O filtro antes exigia tráfego, e isso escondia justamente o pior caso:
     * dinheiro gasto que não trouxe ninguém. O dono olharia a tabela, não veria
     * a campanha, e concluiria que não gastou — quando o problema é exatamente
     * ter gastado à toa. O que dói precisa aparecer.
     */
    /*
     * `receitaCentavos > 0` no filtro: sem ele, dinheiro sumia da tela.
     *
     * `pixGerados` conta só o pedido principal — upsell e downsell são pedidos
     * separados do mesmo cliente. Um upsell pago hoje, de um pedido principal
     * de ontem, produzia uma linha com receita e mais nada: zero visita (foram
     * ontem), zero Pix (não é principal), zero gasto anotado. O filtro descartava
     * essa linha, e a venda desaparecia do total do período.
     */
    /*
     * Nome e situação vêm do cadastro do Meta, não do carimbo `utm`.
     *
     * O rótulo só é substituído quando não havia nenhum: quem chegou com `utm`
     * já traz o nome que o dono escreveu no anúncio, e trocá-lo faria a mesma
     * linha mudar de nome de um dia para o outro sem motivo visível. O que
     * ganha nome novo é a linha que aparecia como número puro.
     */
    for (const linha of linhas.values()) {
      const doMeta = estado[linha.chave];
      if (doMeta === undefined) continue;
      if (linha.rotulo === '' && doMeta.nome !== '') linha.rotulo = doMeta.nome;
      linha.ativo = doMeta.ativo;
      linha.pai = doMeta.pai ?? null;
    }

    const lista = [...linhas.values()]
      .filter(
        (linha) =>
          linha.visitas > 0 ||
          linha.pixGerados > 0 ||
          linha.investimentoCentavos > 0 ||
          linha.receitaCentavos > 0,
      )
      .sort((a, b) => b.receitaCentavos - a.receitaCentavos || b.visitas - a.visitas);

    for (const linha of lista) firmarFunil(linha);

    const totais = brutosZerados();
    for (const linha of lista) somarBrutos(totais, linha);
    firmarFunil(anterior);

    res.json({
      success: true,
      data: {
        agrupamento,
        dias: diasValidos,
        // O painel anota o gasto no dia que o SERVIDOR chama de hoje. Deixar o
        // navegador decidir isso gravava a despesa no dia errado sempre que o
        // relógio do aparelho estivesse fora de hora ou em outro fuso — e o
        // valor sumia da tela logo depois de ser digitado.
        periodo: {
          diaInicial: janela.diaInicial,
          diaFinal: janela.diaFinal,
          diaDeHoje: diaLocal(agoraMs),
          desde: janela.desde,
          ate: janela.ate,
        },
        metaRoas,
        /* Qual BM está filtrando agora, e todas as que existem no período. O
           painel precisa das duas: uma para marcar o chip aceso, outra para
           desenhar os chips. */
        bm: bmEscolhida,
        bmsDisponiveis,
        linhas: lista.map((linha) => ({ ...linha, ...derivar(linha) })),
        totais: { ...totais, ...derivar(totais) },
        anterior: { ...anterior, ...derivar(anterior) },
        // Sem isso o dono olharia uma tabela vazia achando que não vendeu nada,
        // quando o que falta é o rastreamento estar ligado.
        rastreamento: {
          pixelConfigurado: Boolean(credenciais.pixelId),
          capiAtiva: credenciais.ligado,
          modoTeste: Boolean(credenciais.testEventCode),
        },
      },
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* Funil: onde as pessoas param antes de comprar                                */
/* -------------------------------------------------------------------------- */

/**
 * Nome de cada tela, na ordem de src/App.tsx.
 *
 * Escrito como o dono fala, não como o código chama. Ele não sabe o que é
 * "step 7" nem precisa saber — precisa saber que a intermissão de áudio é onde
 * some um terço das pessoas.
 */
const NOMES_DAS_ETAPAS: Record<number, string> = {
  0: 'Abriu o site',
  1: 'Pergunta 1',
  2: 'Pergunta 2',
  3: 'Pergunta 3',
  4: 'Pergunta 4',
  5: 'Pergunta 5',
  6: 'Pergunta 6',
  7: 'Áudio da Irmã Maria',
  8: 'Pergunta 7',
  9: 'Pergunta 8',
  10: 'Pergunta 9',
  11: 'Depoimentos',
  12: 'Tela de análise',
  13: 'Oferta e VSL',
};

/**
 * Junta as opções sob a pergunta a que pertencem.
 *
 * O banco devolve uma linha por opção porque é assim que ele agrega; a tela
 * precisa da pergunta inteira de uma vez para poder mostrar a proporção de cada
 * resposta dentro dela. Fazer a costura aqui, e não em SQL, mantém as duas
 * implementações do repositório contando a mesma história.
 */
function agruparRespostas(linhas: RespostaDoQuiz[]): Array<{
  pergunta: string;
  pessoas: number;
  opcoes: Array<{ resposta: string; pessoas: number; compraram: number; fatia: number; conversao: number | null }>;
}> {
  const porPergunta = new Map<string, RespostaDoQuiz[]>();
  for (const linha of linhas) {
    porPergunta.set(linha.pergunta, [...(porPergunta.get(linha.pergunta) ?? []), linha]);
  }

  return [...porPergunta.entries()]
    .map(([pergunta, opcoes]) => {
      const pessoas = opcoes.reduce((total, o) => total + o.pessoas, 0);
      return {
        pergunta,
        pessoas,
        opcoes: opcoes
          .map((o) => ({
            resposta: o.resposta,
            pessoas: o.pessoas,
            compraram: o.compraram,
            fatia: pessoas > 0 ? o.pessoas / pessoas : 0,
            // Null e não zero quando a amostra é pequena demais: "0%" numa
            // opção com três pessoas leria como "essa dor não compra", e a
            // leitura certa é "ainda não dá para saber".
            conversao: o.pessoas >= 5 ? o.compraram / o.pessoas : null,
          }))
          .sort((a, b) => (b.conversao ?? -1) - (a.conversao ?? -1) || b.pessoas - a.pessoas),
      };
    })
    .sort((a, b) => b.pessoas - a.pessoas);
}

/**
 * Os pedidos de oração, SEPARADOS dos pedidos de PIX (pedido do dono em
 * 15/08/2026, junto com o fluxo "peça e será dado").
 *
 * A regra de negócio que esta lista serve: quem pediu oração e NÃO comprou
 * vai para a régua da reciprocidade (e-mail e WhatsApp em cima do próprio
 * pedido que a pessoa escreveu); quem comprou segue o fluxo normal de upsell
 * e downsell e NÃO entra nessa régua. Por isso cada linha vem com `comprou`
 * resolvido aqui, cruzando o e-mail do pedido com os pedidos pagos.
 */
adminRouter.get(
  '/admin/pedidos-de-oracao',
  exigirAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const agoraMs = Date.now();
    const { dias: diasValidos, janela } = recortePedido(req, agoraMs);

    const [brutos, pedidos] = await Promise.all([
      repositorioDoPainel().pedidosDeOracao({ desde: janela.desde, limite: 500 }),
      listOrders({ desde: janela.desde, limite: LIMITE_PEDIDOS }),
    ]);

    const emailsQuePagaram = new Set(
      pedidos.filter((o) => o.status === 'completed').map((o) => o.customer.email.trim().toLowerCase()),
    );
    const sessoesQuePagaram = new Set(
      pedidos.filter((o) => o.status === 'completed' && o.trackId).map((o) => o.trackId as string),
    );

    const linhas = brutos.map((b) => {
      let nome = '';
      let email = '';
      let telefone = '';
      let pedido = b.resposta;
      try {
        const j = JSON.parse(b.resposta) as Record<string, unknown>;
        nome = typeof j.nome === 'string' ? j.nome : '';
        email = typeof j.email === 'string' ? j.email : '';
        telefone = typeof j.tel === 'string' ? j.tel : '';
        pedido = typeof j.pedido === 'string' ? j.pedido : '';
      } catch {
        // Resposta antiga ou fora do formato: fica o texto cru como pedido.
      }
      const comprou = sessoesQuePagaram.has(b.sessionId) || (email !== '' && emailsQuePagaram.has(email.trim().toLowerCase()));
      return {
        sessionId: b.sessionId,
        quando: b.quando,
        nome,
        email,
        telefone,
        pedido,
        anuncio: b.utmContent ?? b.fbAdId ?? null,
        comprou,
        // O destino de cada um, já decidido: quem não comprou vai para a
        // reciprocidade; quem comprou está no fluxo normal.
        destino: comprou ? 'fluxo-normal' : 'reciprocidade',
      };
    });

    res.json({
      success: true,
      data: {
        dias: diasValidos,
        periodo: { diaInicial: janela.diaInicial, diaFinal: janela.diaFinal },
        total: linhas.length,
        compraram: linhas.filter((l) => l.comprou).length,
        paraReciprocidade: linhas.filter((l) => !l.comprou).length,
        pedidos: linhas,
      },
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* CRM (15/08/2026) — camada de leitura sobre eventos + pedidos.              */
/* Toda a regra mora em server/crm.ts; aqui é só recorte de período,          */
/* filtros da query e resposta. Sempre atrás de exigirAdmin: aqui há nome,    */
/* e-mail, WhatsApp e o pedido de oração das pessoas.                         */
/* -------------------------------------------------------------------------- */

const LIMITE_PEDIDOS_CRM = 5000;

function filtrosDaQuery(req: Request): FiltrosDeLeads {
  const q = req.query as Record<string, string | undefined>;
  const compra = q.compra === 'comprou' || q.compra === 'nao_comprou' || q.compra === 'pix_pendente' ? q.compra : null;
  const etapas: EtapaCrm[] = ['pedido', 'quiz', 'analise', 'oferta', 'checkout', 'pix', 'compra'];
  const etapa = etapas.includes(q.etapa as EtapaCrm) ? (q.etapa as EtapaCrm) : null;
  return {
    status: q.status ?? null,
    compra,
    segmento: q.segmento ?? null,
    anuncio: q.anuncio ?? null,
    etapa,
    busca: q.busca ?? null,
    soComPedido: q.soComPedido === '1' || q.soComPedido === 'true',
  };
}

adminRouter.get(
  '/admin/crm/resumo',
  exigirAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const agoraMs = Date.now();
    const { dias: diasValidos, janela } = recortePedido(req, agoraMs);
    const [pedidos, resumoFunil] = await Promise.all([
      listOrders({ desde: janela.desde, limite: LIMITE_PEDIDOS_CRM }),
      repositorioDoPainel().resumoDoFunil({ desde: janela.desde, ate: janela.ate, agoraMs }).catch(() => null),
    ]);
    const visitantes = resumoFunil?.sessoes ?? 0;
    const resumo = await resumoDoCrm({ desde: janela.desde, ate: janela.ate, pedidos, agoraMs, visitantes });
    res.json({ success: true, data: { dias: diasValidos, periodo: { diaInicial: janela.diaInicial, diaFinal: janela.diaFinal }, regra: REGRA_DO_CRM, ...resumo } });
  }),
);

adminRouter.get(
  '/admin/crm/leads',
  exigirAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const agoraMs = Date.now();
    const { dias: diasValidos, janela } = recortePedido(req, agoraMs);
    const pedidos = await listOrders({ desde: janela.desde, limite: LIMITE_PEDIDOS_CRM });
    const { leads, total } = await listarLeads({ desde: janela.desde, ate: janela.ate, pedidos, agoraMs, filtros: filtrosDaQuery(req), limite: 400 });
    res.json({ success: true, data: { dias: diasValidos, periodo: { diaInicial: janela.diaInicial, diaFinal: janela.diaFinal }, total, leads } });
  }),
);

adminRouter.get(
  '/admin/crm/lead/:sessionId',
  exigirAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = String(req.params.sessionId ?? '').slice(0, 80);
    if (!sessionId) {
      res.status(400).json({ success: false, error: 'SESSAO_INVALIDA' });
      return;
    }
    const agoraMs = Date.now();
    // Perfil olha TODOS os pedidos (sem janela): a pessoa pode ter comprado
    // meses atrás e voltado hoje — e "comprou" precisa vencer sempre.
    const pedidos = await listOrders({ limite: LIMITE_PEDIDOS_CRM });
    const perfil = await perfilDoLead({ sessionId, pedidos, agoraMs, mensagensDoPedido });
    if (!perfil) {
      res.status(404).json({ success: false, error: 'NAO_ENCONTRADO', message: 'Sessão sem eventos.' });
      return;
    }
    res.json({ success: true, data: perfil });
  }),
);

adminRouter.post(
  '/admin/crm/lead/:sessionId/nota',
  exigirAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = String(req.params.sessionId ?? '').slice(0, 80);
    const texto = String((req.body ?? {}).texto ?? '').trim().slice(0, 2000);
    if (!sessionId || !texto) {
      res.status(400).json({ success: false, error: 'DADOS_INVALIDOS', message: 'Escreva a nota.' });
      return;
    }
    const nota = await repositorioDoPainel().salvarNotaCrm({ sessao: sessionId, autor: req.papelSessao ?? 'dono', texto });
    res.json({ success: true, data: nota });
  }),
);

adminRouter.post(
  '/admin/crm/lead/:sessionId/marcar',
  exigirAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = String(req.params.sessionId ?? '').slice(0, 80);
    const corpo = (req.body ?? {}) as Record<string, unknown>;
    if (!sessionId) {
      res.status(400).json({ success: false, error: 'SESSAO_INVALIDA' });
      return;
    }
    const entrada: { sessao: string; statusManual?: string | null; optOut?: boolean; contatadoEm?: string | null } = { sessao: sessionId };
    if ('statusManual' in corpo) entrada.statusManual = corpo.statusManual === null || corpo.statusManual === '' ? null : String(corpo.statusManual).slice(0, 40);
    if ('optOut' in corpo) entrada.optOut = Boolean(corpo.optOut);
    if (corpo.contatado === true) entrada.contatadoEm = new Date().toISOString();
    if (corpo.contatado === false) entrada.contatadoEm = null;
    const marcacao = await repositorioDoPainel().salvarMarcacaoCrm(entrada);
    res.json({ success: true, data: marcacao });
  }),
);

adminRouter.get(
  '/admin/crm/reciprocidade',
  exigirAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const agoraMs = Date.now();
    const { dias: diasValidos, janela } = recortePedido(req, agoraMs);
    const pedidos = await listOrders({ desde: janela.desde, limite: LIMITE_PEDIDOS_CRM });
    const { leads } = await listarLeads({ desde: janela.desde, ate: janela.ate, pedidos, agoraMs, filtros: { soComPedido: true }, limite: 2000 });
    /*
     * Só quem: pediu oração, NÃO comprou, já saiu da recuperação de cobrança
     * (ou nunca gerou PIX) e não é opt-out. Comprador nunca chega aqui —
     * `pagou` vence tudo em classificar().
     */
    const fila = leads
      .filter((l) => !l.pagou && l.segmento !== 'NAO_CONTATAR' && l.segmento !== 'RECUPERACAO_DE_COBRANCA')
      .map((l) => ({
        ...l,
        diasDesdeOPedido: l.pedidoEm ? Math.floor((agoraMs - Date.parse(l.pedidoEm)) / 86_400_000) : null,
        jaContatado: l.ultimoContatoEm !== null,
      }));
    res.json({ success: true, data: { dias: diasValidos, periodo: { diaInicial: janela.diaInicial, diaFinal: janela.diaFinal }, total: fila.length, fila } });
  }),
);

adminRouter.get(
  '/admin/funil',
  exigirAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const agoraMs = Date.now();
    const { dias: diasValidos, janela } = recortePedido(req, agoraMs);

    const [resumo, pedidos] = await Promise.all([
      repositorioDoPainel().resumoDoFunil({ desde: janela.desde, ate: janela.ate, agoraMs }),
      listOrders({ desde: janela.desde, limite: LIMITE_PEDIDOS }),
    ]);

    /*
     * As sessões de quem pagou, para cruzar com o que essa gente respondeu.
     *
     * `trackId` é o fio: ele nasce no navegador, vai grudado no pedido e é o
     * mesmo `session_id` dos eventos do quiz. Sem esse cruzamento, as respostas
     * dizem só o que o público SENTE; com ele, dizem qual dor PAGA — que é
     * outra pergunta, e é a que decide o próximo anúncio.
     */
    const sessoesQueCompraram = pedidos
      .filter((o) => o.status === 'completed' && o.trackId)
      .map((o) => o.trackId as string);

    const respostas = await repositorioDoPainel()
      .respostasDoQuiz({ desde: janela.desde, ate: janela.ate, sessoesQueCompraram })
      .catch(() => []);

    /*
     * A verdade financeira vem dos PEDIDOS, como em toda tela deste painel.
     *
     * O navegador some no meio do caminho — o cliente vai pagar no app do banco
     * e a aba morre —, então contar venda por evento daria sempre menos do que
     * de fato entrou. Aqui os eventos respondem "onde as pessoas param" e os
     * pedidos respondem "quantas pagaram"; cada fonte no que ela é boa.
     */
    let pixGerados = 0;
    let pagos = 0;
    let receitaCentavos = 0;
    let upsellsPagos = 0;
    for (const order of pedidos) {
      const principal = order.parentOrderId === null;
      if (principal) {
        pixGerados += 1;
        if (order.status === 'completed') pagos += 1;
      } else if (order.status === 'completed') {
        upsellsPagos += 1;
      }
      if (order.status === 'completed') receitaCentavos += order.amountCents;
    }

    const visitas = resumo.etapas[0]?.alcancaram ?? 0;
    const chegaramNaOferta = resumo.etapas[13]?.alcancaram ?? 0;

    const dividir = (topo: number, base: number): number | null => (base > 0 ? topo / base : null);

    res.json({
      success: true,
      data: {
        dias: diasValidos,
        periodo: { diaInicial: janela.diaInicial, diaFinal: janela.diaFinal },
        sessoes: resumo.sessoes,
        /*
         * Abaixo de 20 sessões a porcentagem oscila tanto que atrapalha: uma
         * venda a mais muda a conversão em cinco pontos. A tela avisa em vez de
         * deixar o dono decidir orçamento em cima de ruído.
         */
        amostraPequena: resumo.sessoes < 20,
        /*
         * A maior parte do período é anterior à medição das telas do meio?
         *
         * Enquanto for, o funil do quiz mostra as nove perguntas com o mesmo
         * número — não porque ninguém desiste ali, mas porque não havia como
         * saber. A tela precisa dizer isso em voz alta: um funil reto entre a
         * pergunta 1 e a 9 é uma afirmação e tanto, e mandaria o dono procurar
         * o vazamento em qualquer outro lugar.
         *
         * Metade como corte: abaixo disso o desenho do quiz é dominado por
         * visitas que nunca tiveram as telas intermediárias registradas.
         */
        quizSemMedicao: resumo.sessoes > 0 && resumo.sessoesComTelasDoMeio < resumo.sessoes / 2,
        sessoesComTelasDoMeio: resumo.sessoesComTelasDoMeio,
        etapas: resumo.etapas.map((etapa) => ({
          ...etapa,
          nome: NOMES_DAS_ETAPAS[etapa.step] ?? `Tela ${etapa.step}`,
          // Quanto passou da tela anterior. A primeira não tem de onde passar.
          passagem: etapa.step === 0 ? null : dividir(etapa.alcancaram, resumo.etapas[etapa.step - 1]?.alcancaram ?? 0),
        })),
        abandono: resumo.abandono.map((linha) => ({
          ...linha,
          nome: NOMES_DAS_ETAPAS[linha.step] ?? `Tela ${linha.step}`,
        })),
        tempos: resumo.tempos,
        checkout: {
          chegaramNaOferta,
          pixGerados,
          pagos,
          upsellsPagos,
          receitaCentavos,
          /* Quem viu a oferta e gerou o Pix. */
          daOfertaAoPix: dividir(pixGerados, chegaramNaOferta),
          /* Quem gerou o Pix e pagou — o buraco mais caro do funil. */
          doPixAoPagamento: dividir(pagos, pixGerados),
          naoPagaramOPix: Math.max(0, pixGerados - pagos),
        },
        conversao: {
          visitaAteVenda: dividir(pagos, visitas),
          visitas,
        },
        /*
         * As respostas do quiz, agrupadas por pergunta e ordenadas pela taxa de
         * compra — não pela popularidade.
         *
         * A opção mais escolhida e a opção que mais compra raramente são a
         * mesma, e é a segunda que decide onde colocar dinheiro. Uma dor que
         * 10% do público sente e 20% desses compram vale mais que uma que
         * metade sente e ninguém paga para resolver.
         */
        quiz: agruparRespostas(respostas.filter((r) => r.pergunta !== 'VSL')),
        /*
         * Até onde as pessoas assistem o vídeo da oferta.
         *
         * Separado do quiz porque a leitura é outra: ali cada opção compete com
         * as irmãs, aqui os degraus são cumulativos e o que importa é quanta
         * gente sobrevive a cada minuto. O degrau de 242 s é o que decide — é
         * quando o vídeo diz o preço e o botão de compra nasce.
         */
        vsl: respostas
          .filter((r) => r.pergunta === 'VSL')
          .map((r) => ({
            segundos: Number(r.resposta),
            pessoas: r.pessoas,
            compraram: r.compraram,
            /** O marco em que o preço é dito e o botão aparece. Ver OFFER_DATA.segundosAteOCta. */
            ondeOBotaoNasce: Number(r.resposta) === 242,
          }))
          .filter((r) => Number.isFinite(r.segundos))
          .sort((a, b) => a.segundos - b.segundos),
      },
    });
  }),
);

adminRouter.post(
  '/admin/anuncios/meta-roas',
  exigirAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const bruto = String((req.body ?? {}).valor ?? '').replace(',', '.');
    const valor = Number.parseFloat(bruto);

    if (!Number.isFinite(valor) || valor <= 0 || valor > 100) {
      throw new ValidationError('A meta de retorno precisa ser um número entre 0,1 e 100.', { field: 'valor' });
    }

    await repositorioDoPainel().salvarConfiguracao(CHAVE_META_ROAS, String(valor));
    res.json({ success: true, data: { metaRoas: valor } });
  }),
);

/**
 * Ligar, desligar e mudar o orçamento de uma campanha, pelo painel.
 *
 * Fica aqui, e não num script, por decisão do dono em 17/08/2026: a campanha
 * precisa ser decidida NA TELA onde o gasto, a receita e o lucro dela estão à
 * vista. Mexer por fora foi o que fez uma campanha com ROAS de 2,13x ser
 * desligada.
 *
 * A rota é deliberadamente burra: faz o que mandaram, no id que mandaram. Ela
 * não julga se a campanha merece — quem julga é quem está olhando os números.
 */
adminRouter.post(
  '/admin/anuncios/:id/estado',
  exigirAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const corpo = (req.body ?? {}) as { ativo?: unknown; orcamento?: unknown };
    const id = String(req.params.id ?? '').trim();
    if (!/^\d{5,}$/.test(id)) {
      throw new ValidationError('Identificador de campanha inválido.', { field: 'id' });
    }

    const alteracao: { id: string; ativo?: boolean; orcamentoDiarioCentavos?: number } = { id };
    if (typeof corpo.ativo === 'boolean') alteracao.ativo = corpo.ativo;

    if (corpo.orcamento !== undefined && corpo.orcamento !== null && String(corpo.orcamento).trim() !== '') {
      // "35,50" e "35.50": o dono digita como fala, igual ao resto do painel.
      const reais = Number.parseFloat(String(corpo.orcamento).replace(',', '.'));
      if (!Number.isFinite(reais) || reais < 1) {
        throw new ValidationError('O orçamento diário precisa ser de pelo menos R$ 1,00.', { field: 'orcamento' });
      }
      /*
       * Teto de segurança. O campo aceita digitação livre, e um zero a mais
       * aqui é dinheiro real saindo da conta enquanto ninguém olha — o tipo de
       * engano que só se percebe no extrato do dia seguinte.
       */
      if (reais > 2000) {
        throw new ValidationError('Orçamento acima de R$ 2.000/dia precisa ser feito no gerenciador do Meta.', {
          field: 'orcamento',
        });
      }
      alteracao.orcamentoDiarioCentavos = Math.round(reais * 100);
    }

    try {
      const feito = await mudarCampanhaNoMeta(alteracao);
      await auditar({
        papel: 'dono',
        ip: null,
        acao: 'POST /admin/anuncios/:id/estado',
        alvo: id,
      });
      res.json({ success: true, data: feito });
    } catch (erro) {
      if (erro instanceof MetaAdsError) {
        res.status(erro.codigo === 'SEM_CREDENCIAL' ? 400 : 502).json({
          success: false,
          error: 'META_RECUSOU',
          message: erro.message,
        });
        return;
      }
      throw erro;
    }
  }),
);

/**
 * Vendas PAGAS por anúncio, contadas no nosso banco.
 *
 * Existe porque o robô que pausa anúncio (scripts/gerenciar-anuncios.mjs) lia as
 * compras no Meta — e desde 15/08/2026 o Meta bloqueou o Purchase deste site.
 * Resultado: ele via zero venda em anúncio que tinha vendido, e desligava os
 * vencedores a cada duas horas. Em 17/08 desligou o D-AVATAR-VSL-9x16-CBO com
 * R$ 60,50 gastos "sem nenhuma venda".
 *
 * Aqui a fonte é o pedido pago, que é a única verdade que não depende de
 * plataforma nenhuma: quem pagou está no banco, e o carimbo do anúncio veio
 * grudado nele desde a criação (server/atribuicao.ts).
 *
 * Só conta `completed`. Pedido pendente é intenção, e intenção não paga mídia.
 */
adminRouter.get(
  '/admin/anuncios/vendas',
  exigirAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const dias = Math.min(90, Math.max(1, Number.parseInt(String(req.query.dias ?? '30'), 10) || 30));
    const desde = new Date(Date.now() - dias * 24 * 3_600_000).toISOString();
    const pedidos = await listOrders({ desde, limite: 2000 });

    const porAnuncio: Record<string, { pagos: number; receita: number; pagosBoleto: number; receitaBoleto: number }> = {};
    let pagosSemAnuncio = 0;

    function linhaDoAnuncio(anuncio: string) {
      const atual = porAnuncio[anuncio] ?? { pagos: 0, receita: 0, pagosBoleto: 0, receitaBoleto: 0 };
      porAnuncio[anuncio] = atual;
      return atual;
    }

    for (const pedido of pedidos) {
      if (pedido.status !== 'completed') continue;
      const anuncio = (pedido.atribuicao?.fb_ad_id ?? '').trim();
      if (!anuncio) {
        pagosSemAnuncio += 1;
        continue;
      }
      const atual = linhaDoAnuncio(anuncio);
      atual.pagos += 1;
      atual.receita += pedido.amountCents;
    }

    /*
     * BOLETO PAGO CONTA COMO VENDA AQUI, e isso não é detalhe.
     *
     * A venda por boleto acontece inteira fora do site: nenhum gateway avisa, e
     * ela não existe na tabela de pedidos. Deixá-la de fora faria o anúncio que
     * a pagou aparecer nesta consulta rendendo menos do que rende — e esta
     * consulta é a que responde "qual criativo vale o dinheiro". Um criativo
     * que vende bem por boleto seria desligado por parecer que não vende.
     *
     * Entram na mesma soma, e aparecem TAMBÉM em separado (`pagosBoleto`,
     * `receitaBoleto`): quem lê precisa poder conferir de onde veio o número,
     * porque essa metade depende de alguém ter marcado a mão.
     *
     * Uma falha aqui não derruba a tela: sem os boletos ela volta a ser o que
     * era antes disto existir.
     */
    let boletosPagos = 0;
    let receitaDeBoletos = 0;
    try {
      const boletos = await repositorioDoPainel().listarPedidosDeBoleto({ desde, limite: LIMITE_BOLETOS });
      for (const boleto of boletos) {
        if (boleto.situacao !== 'pago') continue;
        boletosPagos += 1;
        receitaDeBoletos += boleto.valorCentavos;

        const anuncio = (boleto.atribuicao.fb_ad_id ?? '').trim();
        if (!anuncio) {
          pagosSemAnuncio += 1;
          continue;
        }
        const atual = linhaDoAnuncio(anuncio);
        atual.pagos += 1;
        atual.receita += boleto.valorCentavos;
        atual.pagosBoleto += 1;
        atual.receitaBoleto += boleto.valorCentavos;
      }
    } catch (erro) {
      logger.error('Vendas por anúncio: falha ao somar os boletos pagos', { erro: (erro as Error).message });
    }

    res.json({
      success: true,
      data: {
        dias,
        porAnuncio,
        /** Quanto do total acima veio de boleto marcado à mão. */
        boletos: { pagos: boletosPagos, receitaCentavos: receitaDeBoletos },
        /*
         * Venda paga que NÃO carrega id de anúncio: veio de tráfego direto, do
         * Google, ou de um clique cujo carimbo se perdeu. O robô não pode culpar
         * anúncio nenhum por ela — mas quem lê precisa saber que ela existe,
         * senão a soma daqui não bate com o faturamento do painel.
         */
        pagosSemAnuncio,
      },
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* Boletos (17/08/2026)                                                        */
/*                                                                             */
/* Boleto aqui é OFFLINE: o site registra a intenção, alguém emite à mão em     */
/* outro gateway, e o desfecho é digitado nesta aba. Ver                        */
/* server/pedidoDeBoleto.ts para o ciclo de vida e o envio ao Meta.             */
/* -------------------------------------------------------------------------- */

adminRouter.get(
  '/admin/boletos',
  exigirAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const dias = Math.min(180, Math.max(1, Number.parseInt(String(req.query.dias ?? '30'), 10) || 30));
    const desde = new Date(Date.now() - dias * 24 * 3_600_000).toISOString();

    const pedidos = await repositorioDoPainel().listarPedidosDeBoleto({ desde, limite: LIMITE_BOLETOS });

    /*
     * O nome do criativo, quando o painel já importou o cadastro do Meta. Sem
     * ele a linha mostra o número do anúncio — que serve para achar no
     * Gerenciador, mas não diz nada a quem está olhando a tela.
     */
    let nomes: Record<string, { nome: string }> = {};
    try {
      nomes = await estadoDosAnuncios();
    } catch (erro) {
      logger.warn('Boletos: não consegui ler o nome dos anúncios', { erro: (erro as Error).message });
    }

    const resumo = {
      total: pedidos.length,
      pedido: 0,
      gerado: 0,
      pago: 0,
      naoPago: 0,
      /** Só o que compensou. É a única receita real desta tela. */
      receitaCentavos: 0,
      /** Pedido + gerado: dinheiro que ainda pode entrar, e que vale uma cobrada. */
      emAbertoCentavos: 0,
      /** Pagos que ainda não viraram compra no Meta. Cada um é um anúncio subvalorizado. */
      pagosSemMeta: 0,
    };

    const linhas = pedidos.map((pedido) => {
      if (pedido.situacao === 'pedido') resumo.pedido += 1;
      if (pedido.situacao === 'gerado') resumo.gerado += 1;
      if (pedido.situacao === 'nao_pago') resumo.naoPago += 1;
      if (pedido.situacao === 'pago') {
        resumo.pago += 1;
        resumo.receitaCentavos += pedido.valorCentavos;
        if (!pedido.metaEnviadoEm) resumo.pagosSemMeta += 1;
      }
      if (pedido.situacao === 'pedido' || pedido.situacao === 'gerado') {
        resumo.emAbertoCentavos += pedido.valorCentavos;
      }

      const anuncioId = (pedido.atribuicao.fb_ad_id ?? '').trim() || null;
      const campanhaId = (pedido.atribuicao.fb_campaign_id ?? '').trim() || null;

      return {
        id: pedido.id,
        criadoEm: pedido.criadoEm,
        atualizadoEm: pedido.atualizadoEm,
        sessao: pedido.sessao,
        nome: pedido.nome,
        email: pedido.email,
        telefone: pedido.telefone,
        /*
         * CPF INTEIRO, e de propósito. Quem abre esta tela é quem vai digitar o
         * número no painel do banco para emitir o boleto — mascarar aqui só
         * empurraria o dono de volta para a conversa do WhatsApp, que é
         * exatamente o lugar de onde esta tela existe para tirá-lo. Rota de
         * dono, resposta sem cache.
         */
        documento: pedido.documento,
        valorCentavos: pedido.valorCentavos,
        valorFormatado: formatBRL(pedido.valorCentavos),
        itens: pedido.itemIds.map((id) => CATALOG[id]?.title ?? id),
        situacao: pedido.situacao,
        observacao: pedido.observacao,
        geradoEm: pedido.geradoEm,
        pagoEm: pedido.pagoEm,
        naoPagoEm: pedido.naoPagoEm,
        anuncioId,
        anuncioNome: anuncioId ? (nomes[anuncioId]?.nome ?? null) : null,
        campanhaId,
        campanhaNome: campanhaId ? (nomes[campanhaId]?.nome ?? null) : null,
        /** Nome do criativo carimbado na URL. É o que sobra quando não há cadastro importado. */
        criativo: (pedido.atribuicao.utm_content ?? '').trim() || null,
        plataforma: plataformaDaOrigem(pedido.atribuicao),
        metaEnviadoEm: pedido.metaEnviadoEm,
      };
    });

    res.json({ success: true, data: { dias, resumo, pedidos: linhas, papel: req.papelSessao } });
  }),
);

adminRouter.post(
  '/admin/boletos/:id/situacao',
  exigirAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const corpo = (req.body ?? {}) as { situacao?: unknown; observacao?: unknown };

    const situacao = String(corpo.situacao ?? '');
    if (!SITUACOES_DO_BOLETO.includes(situacao as SituacaoDoBoleto)) {
      throw new ValidationError('Situação inválida para o boleto.', { field: 'situacao' });
    }

    /*
     * Ausente é "não mexe na anotação"; string vazia é "apaga". São coisas
     * diferentes: o botão de marcar pago não pode limpar o número do boleto que
     * alguém digitou ali.
     */
    const observacao =
      corpo.observacao === undefined ? undefined : String(corpo.observacao ?? '').trim().slice(0, 500) || null;

    const resultado = await mudarSituacaoDoBoleto({
      id: req.params.id,
      situacao: situacao as SituacaoDoBoleto,
      observacao,
    });

    if (!resultado) {
      res.status(404).json({ success: false, error: 'NAO_ENCONTRADO', message: 'Pedido de boleto não encontrado.' });
      return;
    }

    logger.info('Painel: boleto marcado', { boleto: req.params.id, situacao, ip: ipDoCliente(req) });
    res.json({ success: true, data: resultado });
  }),
);

/**
 * Reenvia ao Meta a compra de um boleto pago.
 *
 * Existe porque o envio automático da marcação pode falhar — rede, token
 * vencido, Meta fora do ar — e sem este botão a venda ficaria invisível para
 * sempre no anúncio que a pagou.
 */
adminRouter.post(
  '/admin/boletos/:id/meta',
  exigirAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const resultado = await reenviarCompraDeBoleto(req.params.id);
    if (!resultado) {
      res.status(404).json({ success: false, error: 'NAO_ENCONTRADO', message: 'Pedido de boleto não encontrado.' });
      return;
    }
    res.json({ success: true, data: resultado });
  }),
);

adminRouter.post(
  '/admin/investimento',
  exigirAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const corpo = (req.body ?? {}) as {
      chave?: unknown;
      dia?: unknown;
      nivel?: unknown;
      valor?: unknown;
      impressoes?: unknown;
      cliques?: unknown;
      bm?: unknown;
    };
    const chave = String(corpo.chave ?? '').trim().slice(0, 300);
    const dia = String(corpo.dia ?? '').trim();
    // Aceita "12,50" e "12.50": o dono digita como fala.
    const valor = Number.parseFloat(String(corpo.valor ?? '').replace(',', '.'));

    if (!chave || !/^\d{4}-\d{2}-\d{2}$/.test(dia) || !Number.isFinite(valor) || valor < 0) {
      throw new ValidationError('Informe a campanha, o dia (AAAA-MM-DD) e um valor válido.', { field: 'valor' });
    }

    /*
     * Contagem em branco vira zero, e não erro.
     *
     * Quem só quer ver retorno anota o gasto e ignora os outros dois campos —
     * exigir os três transformaria a anotação diária, que já é chata, em coisa
     * que o dono deixa de fazer. Sem gasto anotado não há ROAS nenhum.
     */
    const contar = (bruto: unknown): number => {
      const numero = Number.parseInt(String(bruto ?? '').replace(/[^\d]/g, ''), 10);
      return Number.isFinite(numero) && numero >= 0 ? numero : 0;
    };

    /*
     * O nível vem da tela: o dono digita olhando uma tabela agrupada por
     * campanha, conjunto ou anúncio, e o gasto pertence àquele nível. Sem isto,
     * quem anotasse com a tabela em "Por anúncio" gravaria no nível de campanha
     * e veria o valor sumir no recarregamento seguinte.
     *
     * Padrão `campanha` porque é o que a tela abre e o que a planilha traz.
     */
    const nivelPedido = String(corpo.nivel ?? 'campanha');
    const nivel: NivelDeInvestimento =
      nivelPedido === 'conjunto' || nivelPedido === 'anuncio' ? nivelPedido : 'campanha';

    /*
     * De qual BM é este gasto — herdado do filtro que está aberto na tela.
     *
     * Sem seletor próprio de propósito: o dono digita o gasto olhando a tabela
     * já filtrada num gerenciador, e um segundo seletor logo ao lado seria uma
     * chance a mais de escolher errado. Filtro em "Todas as BMs" grava sem
     * carimbo, que é a verdade — não dá para saber de quem foi.
     *
     * É o que permite ver ROAS por BM ANTES de existir token de leitura da
     * conta: o dono copia o gasto do Gerenciador de Anúncios uma vez por dia e
     * o painel fecha a conta igual.
     */
    const bmBruto = String(corpo.bm ?? '').trim().toLowerCase().slice(0, 64);
    const bm = bmBruto !== '' && /^[a-z0-9_-]+$/.test(bmBruto) ? bmBruto : '';

    const entrada = {
      chave,
      dia,
      nivel,
      bm,
      centavos: Math.round(valor * 100),
      impressoes: contar(corpo.impressoes),
      cliques: contar(corpo.cliques),
    };

    await repositorioDoPainel().salvarInvestimento(entrada);
    logger.info('Painel: investimento anotado', { chave, dia, bm, ip: ipDoCliente(req) });

    res.json({ success: true, data: entrada });
  }),
);

/* -------------------------------------------------------------------------- */
/* Investimento vindo direto do Meta                                            */
/* -------------------------------------------------------------------------- */

/**
 * O estado da ligação com a conta de anúncios.
 *
 * O token nunca volta, nem mascarado: aqui basta dizer se existe. A tela só
 * precisa saber se está ligado, quando importou pela última vez e o que fazer
 * se não estiver.
 */
adminRouter.get(
  '/admin/meta/anuncios',
  exigirAdmin,
  asyncHandler(async (_req: Request, res: Response) => {
    const [credenciais, ultima] = await Promise.all([
      credenciaisDeAnuncios(),
      repositorioDoPainel().lerConfiguracao(CHAVE_ULTIMA_IMPORTACAO_META),
    ]);

    res.json({
      success: true,
      data: {
        contaId: credenciais.contaId,
        temToken: credenciais.token !== '',
        ligado: credenciais.ligado,
        tokenIlegivel: credenciais.tokenIlegivel,
        podeGuardarToken: podeGuardarToken(),
        ultimaImportacao: ultima,
      },
    });
  }),
);

adminRouter.post(
  '/admin/meta/anuncios',
  exigirAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const corpo = (req.body ?? {}) as { contaId?: unknown; token?: unknown };

    const contaBruta = corpo.contaId === undefined ? undefined : String(corpo.contaId).trim().slice(0, 60);
    const token = corpo.token === undefined ? undefined : String(corpo.token).trim().slice(0, 500);

    if (contaBruta !== undefined && contaBruta !== '' && normalizarConta(contaBruta) === '') {
      throw new ValidationError('O número da conta precisa ter dígitos. No Gerenciador ele aparece como act_1234567890.', {
        field: 'contaId',
      });
    }

    try {
      await salvarCredenciaisDeAnuncios({ contaId: contaBruta, token });
    } catch (erro) {
      if (erro instanceof MetaAdsError) throw new ValidationError(erro.message, { field: 'token', code: erro.codigo });
      throw erro;
    }

    logger.info('Painel: credenciais de anúncios do Meta salvas', { ip: ipDoCliente(req) });
    const credenciais = await credenciaisDeAnuncios();
    res.json({
      success: true,
      data: { contaId: credenciais.contaId, temToken: credenciais.token !== '', ligado: credenciais.ligado },
    });
  }),
);

adminRouter.post(
  '/admin/meta/anuncios/testar',
  exigirAdmin,
  asyncHandler(async (_req: Request, res: Response) => {
    try {
      const resultado = await testarCredenciaisDeAnuncios(diaLocal());
      res.json({ success: true, data: resultado });
    } catch (erro) {
      if (erro instanceof MetaAdsError) {
        res.status(400).json({ success: false, error: erro.codigo, message: erro.message });
        return;
      }
      throw erro;
    }
  }),
);

adminRouter.post(
  '/admin/meta/anuncios/importar',
  exigirAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const dias = Number.parseInt(String((req.body ?? {}).dias ?? '7'), 10);

    try {
      const resultado = await importarInvestimentoDoMeta({
        dias: Number.isFinite(dias) ? dias : 7,
        hoje: diaLocal(),
      });
      res.json({
        success: true,
        data: {
          dias: resultado.dias,
          linhas: resultado.linhas.length,
          totalCentavos: resultado.totalCentavos,
          totalFormatado: formatBRL(resultado.totalCentavos),
        },
      });
    } catch (erro) {
      if (erro instanceof MetaAdsError) {
        res.status(400).json({ success: false, error: erro.codigo, message: erro.message });
        return;
      }
      throw erro;
    }
  }),
);

/* -------------------------------------------------------------------------- */
/* Importação do investimento a partir de uma planilha                         */
/* -------------------------------------------------------------------------- */

const CHAVE_PLANILHA = 'investimento.planilha_url';
const CHAVE_ULTIMA_IMPORTACAO = 'investimento.ultima_importacao';

adminRouter.get(
  '/admin/investimento/planilha',
  exigirAdmin,
  asyncHandler(async (_req: Request, res: Response) => {
    const [url, ultima] = await Promise.all([
      repositorioDoPainel().lerConfiguracao(CHAVE_PLANILHA),
      repositorioDoPainel().lerConfiguracao(CHAVE_ULTIMA_IMPORTACAO),
    ]);
    res.json({ success: true, data: { url: url ?? '', ultimaImportacao: ultima ?? null } });
  }),
);

adminRouter.post(
  '/admin/investimento/planilha',
  exigirAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const url = String((req.body as { url?: unknown })?.url ?? '').trim();

    // Endereço vazio limpa a configuração: é como o dono desliga a importação.
    if (url === '') {
      await repositorioDoPainel().salvarConfiguracao(CHAVE_PLANILHA, '');
      res.json({ success: true, data: { url: '' } });
      return;
    }

    // Confere antes de guardar: endereço inválido salvo é um erro que só
    // aparece na próxima importação, longe da tela onde foi digitado.
    try {
      conferirEndereco(url);
    } catch (erro) {
      throw new ValidationError((erro as ImportacaoError).message, { field: 'url' });
    }

    await repositorioDoPainel().salvarConfiguracao(CHAVE_PLANILHA, url);
    logger.info('Painel: planilha de investimento configurada', { ip: ipDoCliente(req) });
    res.json({ success: true, data: { url } });
  }),
);

adminRouter.post(
  '/admin/investimento/importar',
  exigirAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const url = await repositorioDoPainel().lerConfiguracao(CHAVE_PLANILHA);
    if (!url) {
      throw new ValidationError('Configure o endereço da planilha antes de importar.', { field: 'url' });
    }

    let importado;
    try {
      importado = await buscarPlanilha(url);
    } catch (erro) {
      if (erro instanceof ImportacaoError) {
        res.status(400).json({ success: false, error: erro.codigo, message: erro.message });
        return;
      }
      throw erro;
    }

    await repositorioDoPainel().salvarInvestimentos(
      importado.linhas.map((linha) => ({
        chave: linha.chave,
        dia: linha.dia,
        centavos: linha.centavos,
        impressoes: linha.impressoes,
        cliques: linha.cliques,
      })),
    );

    const agora = new Date().toISOString();
    await repositorioDoPainel().salvarConfiguracao(CHAVE_ULTIMA_IMPORTACAO, agora);

    const total = importado.linhas.reduce((soma, linha) => soma + linha.centavos, 0);
    logger.info('Painel: investimento importado da planilha', {
      linhas: importado.linhas.length,
      ignoradas: importado.ignoradas.length,
      ip: ipDoCliente(req),
    });

    res.json({
      success: true,
      data: {
        linhas: importado.linhas.length,
        totalFormatado: formatBRL(total),
        ignoradas: importado.ignoradas,
        colunasEncontradas: importado.colunasEncontradas,
        ultimaImportacao: agora,
      },
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* Diagnóstico do envio ao Meta                                                */
/* -------------------------------------------------------------------------- */

adminRouter.get(
  '/admin/meta',
  exigirAdmin,
  asyncHandler(async (_req: Request, res: Response) => {
    const [ultimos, pendentes] = await Promise.all([
      repositorioDoPainel().listarEnviosMeta({ limite: 30 }),
      repositorioDoPainel().listarEnviosMeta({ limite: 100, sóPendentes: true }),
    ]);

    const credenciais = await credenciaisDoMeta();

    res.json({
      success: true,
      data: {
        ativo: credenciais.ligado,
        pixelConfigurado: Boolean(credenciais.pixelId),
        tokenConfigurado: Boolean(credenciais.token),
        modoTeste: Boolean(credenciais.testEventCode),
        pendentes: pendentes.length,
        ultimos,
      },
    });
  }),
);

/*
 * O reenvio de eventos pendentes ao Meta FOI REMOVIDO em 21/08/2026, junto com
 * todo o envio automático para plataformas de anúncio.
 *
 * A rota continua respondendo, e de propósito: o botão existe no painel, que é
 * HTML servido do disco e pode estar aberto num celular desde ontem. Um 404
 * apareceria como "erro de rede" — o dono ficaria tentando de novo sem entender.
 * Respondendo com a explicação, ele lê o motivo uma vez e para de clicar.
 */
adminRouter.post(
  '/admin/meta/reenviar',
  exigirAdmin,
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({
      success: true,
      data: {
        tentados: 0,
        enviados: 0,
        detalhe: 'O envio de eventos para o Meta foi removido. As vendas ficam no painel e saem por /admin/conversoes.csv.',
      },
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* Credenciais do Meta, editáveis pelo dono                                    */
/* -------------------------------------------------------------------------- */

adminRouter.get(
  '/admin/meta/credenciais',
  exigirAdmin,
  asyncHandler(async (_req: Request, res: Response) => {
    const credenciais = await credenciaisDoMeta();

    res.json({
      success: true,
      data: {
        pixelId: credenciais.pixelId,
        // Só a máscara. O token não volta inteiro nem para o dono logado: a tela
        // não precisa dele, e o que não trafega não vaza em log nem em print.
        tokenMascarado: mascararToken(credenciais.token),
        testEventCode: credenciais.testEventCode,
        ligado: credenciais.ligado,
        origemDoPixel: credenciais.origemDoPixel,
        origemDoToken: credenciais.origemDoToken,
        tokenIlegivel: credenciais.tokenIlegivel,
        // Sem chave mestra não há como cifrar: a tela desabilita o campo em vez
        // de aceitar um token que ficaria em texto puro no banco.
        podeGuardarToken: podeGuardarToken(),
      },
    });
  }),
);

adminRouter.post(
  '/admin/meta/credenciais',
  exigirAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const corpo = (req.body ?? {}) as {
      pixelId?: unknown;
      token?: unknown;
      testEventCode?: unknown;
      ligado?: unknown;
    };

    const pixelId = String(corpo.pixelId ?? '').trim();
    const token = String(corpo.token ?? '').trim();
    const testEventCode = String(corpo.testEventCode ?? '').trim();

    /*
     * O Pixel é numérico e tem cerca de 15 dígitos. Barrar aqui pega o erro mais
     * comum de todos — colar o ID da conta de anúncio (`act_...`) no lugar do
     * conjunto de dados. Os dois números convivem na mesma tela do Meta, e com o
     * errado o envio falha em silêncio a cada evento.
     */
    if (pixelId !== '' && !/^\d{8,20}$/.test(pixelId)) {
      throw new ValidationError(
        'O ID do Pixel é só de números (uns 15 dígitos). Confira se não colou o ID da conta de anúncio.',
        { field: 'pixelId' },
      );
    }
    if (testEventCode !== '' && !/^[A-Za-z0-9_-]{4,40}$/.test(testEventCode)) {
      throw new ValidationError('O código de teste tem o formato TESTxxxxx.', { field: 'testEventCode' });
    }
    if (token !== '' && !podeGuardarToken()) {
      throw new ValidationError(
        'Sem PAINEL_CHAVE_MESTRA configurada não há como guardar o token cifrado. ' +
          'Configure a chave mestra ou use a variável de ambiente META_CAPI_TOKEN.',
        { field: 'token' },
      );
    }

    const repo = repositorioDoPainel();
    await repo.salvarConfiguracao(CHAVE_PIXEL, pixelId);
    await repo.salvarConfiguracao(CHAVE_TEST_CODE, testEventCode);
    await repo.salvarConfiguracao(CHAVE_LIGADO, corpo.ligado === false ? 'nao' : 'sim');

    /*
     * Campo de token vazio NÃO apaga o que já está guardado.
     *
     * A tela mostra o token mascarado, então o dono que abre para mudar só o
     * Pixel deixaria o campo em branco sem querer apagar nada — e o rastreamento
     * morreria calado. Para remover de verdade existe a palavra `apagar`.
     */
    if (token === 'apagar') {
      await repo.salvarConfiguracao(CHAVE_TOKEN, '');
    } else if (token !== '') {
      await repo.salvarConfiguracao(CHAVE_TOKEN, cifrar(token));
    }

    invalidarCredenciaisDoMeta();
    const credenciais = await credenciaisDoMeta();

    logger.info('Painel: credenciais do Meta atualizadas', {
      pixelConfigurado: Boolean(credenciais.pixelId),
      tokenConfigurado: Boolean(credenciais.token),
      ligado: credenciais.ligado,
      ip: ipDoCliente(req),
    });

    res.json({
      success: true,
      data: {
        pixelId: credenciais.pixelId,
        tokenMascarado: mascararToken(credenciais.token),
        testEventCode: credenciais.testEventCode,
        ligado: credenciais.ligado,
        origemDoPixel: credenciais.origemDoPixel,
        origemDoToken: credenciais.origemDoToken,
      },
    });
  }),
);

/**
 * Testa o par pixel + token contra a Graph API sem registrar evento nenhum.
 *
 * Sem este botão, a única prova de que a credencial funciona seria a primeira
 * venda — e uma venda perdida no rastreamento não volta.
 */
/*
 * O teste de credencial batia em graph.facebook.com para saber se o token abria
 * o conjunto de dados. Saiu em 21/08/2026: com o envio removido, era a última
 * chamada do projeto para o domínio do Meta, e mantê-la deixaria a auditoria
 * "nenhuma chamada a graph.facebook.com" impossível de fechar.
 *
 * A rota responde em vez de sumir, pelo mesmo motivo da de reenvio: o botão
 * ainda existe num painel que pode estar aberto.
 */
adminRouter.post(
  '/admin/meta/testar',
  exigirAdmin,
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({
      success: true,
      data: {
        ok: false,
        detalhe: 'O envio de eventos para o Meta foi removido deste projeto. Não há mais credencial a testar.',
      },
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* Página de entrega assinada (pública, validada por HMAC)                     */
/* -------------------------------------------------------------------------- */

function escaparHtml(texto: string): string {
  return texto.replace(/[&<>"']/g, (caractere) => {
    const mapa: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return mapa[caractere];
  });
}

/**
 * A oferta que aparece embaixo dos acessos, para quem ainda não a tem.
 *
 * Este é o segundo — e último — encontro com quem já pagou. O primeiro é no
 * checkout, logo depois do PIX confirmar; parte das pessoas fecha a aba antes
 * de ele carregar, e outra parte recusa no susto de ter acabado de gastar. Aqui
 * a pessoa chega por vontade própria, com o produto na mão e a compra já
 * digerida — é o melhor momento que existe para uma segunda oferta, e hoje ele
 * é desperdiçado.
 *
 * O bloco fica DEPOIS dos acessos, nunca antes. Quem abriu este link veio
 * buscar o que comprou; empurrar venda na frente disso é fazer a pessoa caçar o
 * próprio produto no meio de um anúncio, e vira reclamação em vez de receita.
 *
 * O PIX nasce só no clique, e não junto com a página: gerar cobrança para todo
 * mundo que abre o e-mail encheria o gateway de cobranças mortas e sujaria a
 * conta de PIX abandonado — justamente o número que estamos tentando limpar.
 */
function blocoDeOferta(pedidoId: string): string {
  const item = CATALOG.upsell;
  const preco = formatBRL(item.priceCents);

  return `
<section class="oferta">
  <p class="etiqueta">Só para quem já tem a Oração</p>
  <h2>${escaparHtml(item.title)}</h2>
  <p class="venda">
    A sua Oração é o começo. O aplicativo é o que transforma ela em rotina:
    a oração certa para cada dia, na hora certa, com o vídeo mostrando como
    conduzir cada uma. Quem reza acompanhado não desiste na terceira semana.
  </p>
  <p class="preco">${preco}<span> à vista, no PIX</span></p>
  <button id="quero" type="button">QUERO O APLICATIVO</button>
  <p class="recusa" id="recusa">Não, obrigado. Já tenho o que vim buscar.</p>

  <div id="pagamento" hidden>
    <p class="instrucao">Copie o código abaixo e cole no seu banco, em <strong>PIX Copia e Cola</strong>:</p>
    <div class="codigo" id="codigo"></div>
    <button id="copiar" type="button" class="secundario">Copiar código</button>
    <p class="aviso">Assim que o pagamento cair, o acesso chega no seu e-mail. Pode fechar esta página.</p>
  </div>
  <p class="erro" id="erro" hidden></p>
</section>

<script>
  (function () {
    var quero = document.getElementById('quero');
    var recusa = document.getElementById('recusa');
    var pagamento = document.getElementById('pagamento');
    var campo = document.getElementById('codigo');
    var copiar = document.getElementById('copiar');
    var erro = document.getElementById('erro');

    recusa.addEventListener('click', function () {
      document.querySelector('.oferta').remove();
    });

    quero.addEventListener('click', function () {
      quero.disabled = true;
      quero.textContent = 'Gerando o seu PIX...';
      erro.hidden = true;

      fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offer: 'upsell', parentOrderId: ${JSON.stringify(pedidoId)} })
      })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) {
          // O código vive em data.pix.code — NÃO em data.qrCode, que não existe.
          var pix = res.j && res.j.data && res.j.data.pix;
          if (!res.ok || !pix || !pix.code) {
            throw new Error((res.j && res.j.message) || 'Não conseguimos gerar o PIX agora.');
          }
          campo.textContent = pix.code;
          pagamento.hidden = false;
          quero.hidden = true;
          recusa.hidden = true;
        })
        .catch(function (e) {
          erro.textContent = e.message + ' Tente de novo, ou responda o e-mail que a gente resolve.';
          erro.hidden = false;
          quero.disabled = false;
          quero.textContent = 'QUERO O APLICATIVO';
        });
    });

    copiar.addEventListener('click', function () {
      var texto = campo.textContent || '';
      function avisar() { copiar.textContent = 'Código copiado!'; }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(texto).then(avisar, avisar);
      } else {
        // Aparelho antigo sem clipboard: seleciona para o toque longo funcionar.
        var faixa = document.createRange();
        faixa.selectNodeContents(campo);
        var selecao = window.getSelection();
        selecao.removeAllRanges();
        selecao.addRange(faixa);
        avisar();
      }
    });
  })();
</script>`;
}

/**
 * O telefone como a pessoa lê, para ela conferir se acertou.
 *
 * A entrega vai por WhatsApp, então um dígito errado no checkout é a entrega
 * inteira perdida — e perdida em silêncio, porque ninguém reclama de uma
 * mensagem que nunca soube que ia receber. Mostrar o número devolve a chance
 * de ela avisar antes.
 */
function telefoneVisivel(bruto: string): string {
  const d = (bruto ?? '').replace(/\D/g, '').replace(/^55/, '');
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return bruto ?? '';
}

function paginaDeEntrega(
  nome: string,
  itens: { title: string; description: string; url: string | null; tipo: string }[],
  oferta: string,
  /* O endereço de entrega. Era o telefone até o WhatsApp da operação ser restringido. */
  email: string,
): string {
  const cartoes = itens
    .map((item) => {
      let acao: string;
      if (item.url) {
        const rotulo = item.tipo === 'acesso' ? 'Acessar' : 'Abrir';
        acao = `<a class="botao" href="${escaparHtml(item.url)}" target="_blank" rel="noopener">${rotulo}</a>`;
      } else if (item.tipo === 'servico') {
        // Serviço não tem arquivo: a confirmação é a própria entrega.
        acao = '<span class="confirmado">Confirmado. Nada para baixar aqui.</span>';
      } else {
        /*
         * Sem link, a pessoa via "não foi configurado. Fale com a gente" — uma
         * frase de sistema quebrado, logo depois de ela ter pago. E não é
         * verdade: a Oração é rezada e dedicada ao nome dela, o que leva tempo
         * de gente, não de servidor.
         *
         * Dizer o prazo real é o que impede o chamado no WhatsApp em vinte
         * minutos e o pedido de estorno em duas horas. Quem sabe que vai
         * receber espera; quem acha que foi enganado, reclama.
         */
        acao =
          '<span class="preparando">Sendo preparada para você. Chega no seu e-mail em até 72 horas.</span>';
      }
      return `<li><h2>${escaparHtml(item.title)}</h2><p>${escaparHtml(item.description)}</p>${acao}</li>`;
    })
    .join('');

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Seus acessos | Rezas Sagradas</title>
<style>
  :root { color-scheme: light; }
  body { margin:0; padding:32px 20px; font-family: system-ui, -apple-system, Segoe UI, sans-serif;
         background:#FDFCFB; color:#2D2926; }
  main { max-width:640px; margin:0 auto; }
  h1 { font-size:1.5rem; margin:0 0 4px; }
  .sub { color:#7A7570; margin:0 0 28px; }
  ul { list-style:none; padding:0; margin:0; display:grid; gap:14px; }
  li { background:#fff; border:1px solid #E8E4DF; border-radius:14px; padding:18px; }
  h2 { font-size:1rem; margin:0 0 6px; }
  p { margin:0 0 14px; color:#7A7570; font-size:.9rem; line-height:1.5; }
  .botao { display:inline-block; background:#A89060; color:#fff; text-decoration:none;
           padding:10px 18px; border-radius:9px; font-weight:600; font-size:.9rem; }
  .pendente { color:#B45309; font-size:.85rem; font-weight:600; }
  .confirmado { color:#157F3D; font-size:.85rem; font-weight:600; }
  .preparando { color:#8A6A22; font-size:.85rem; font-weight:600; }

  /*
   * O aviso do prazo, no topo e antes dos itens.
   *
   * Vem antes de propósito: a primeira pergunta de quem acabou de pagar é
   * "e agora, cadê?". Se a resposta estiver embaixo da lista, ela já
   * escreveu no WhatsApp antes de rolar a tela.
   */
  .preparo { background:#17150F; border-radius:14px; padding:20px 22px; margin:0 0 22px; }
  .preparo h2 { font-size:1.05rem; color:#F2CA50; margin:0 0 10px;
                font-family:Georgia,'Times New Roman',serif; }
  .preparo p { color:#BDB5A6; font-size:.92rem; line-height:1.65; margin:0 0 10px; }
  .preparo p:last-child { margin-bottom:0; }
  .preparo strong { color:#fff; }
  /* O número em destaque, para o olho bater nele e conferir sem procurar. */
  .preparo .numero { background:#0E0D09; border:1px solid #3A3529; border-radius:10px;
                     padding:12px 14px; margin:0 0 12px; }
  .preparo .numero span { display:block; font-size:.76rem; letter-spacing:.1em;
                          text-transform:uppercase; color:#8A8375; margin-bottom:2px; }
  .preparo .numero strong { font-size:1.15rem; letter-spacing:.02em; }

  /* A oferta. Fundo escuro para ela se separar dos acessos sem competir com eles. */
  .oferta { margin:34px 0 0; background:#17150F; border-radius:16px; padding:26px 22px; color:#E8E2D6; }
  .oferta .etiqueta { margin:0 0 10px; font-size:.7rem; letter-spacing:.16em; text-transform:uppercase;
                      color:#F2CA50; font-weight:700; }
  .oferta h2 { margin:0 0 12px; font-size:1.2rem; line-height:1.35; color:#fff;
               font-family:Georgia,'Times New Roman',serif; }
  .oferta .venda { margin:0 0 18px; color:#BDB5A6; font-size:.95rem; line-height:1.6; }
  .oferta .preco { margin:0 0 18px; font-size:1.9rem; font-weight:700; color:#F2CA50; }
  .oferta .preco span { font-size:.85rem; font-weight:400; color:#BDB5A6; margin-left:6px; }
  /* 54px de altura: é o mínimo confortável para toque, e este público tem 50+. */
  .oferta button { width:100%; min-height:54px; border:0; border-radius:12px; cursor:pointer;
                   background:linear-gradient(135deg,#d4af37,#f2ca50); color:#241a00;
                   font-size:1rem; font-weight:700; letter-spacing:.03em; }
  .oferta button.secundario { background:transparent; border:1px solid #4A4437; color:#E8E2D6;
                              font-size:.9rem; min-height:46px; margin-top:12px; }
  .oferta .recusa { margin:14px 0 0; text-align:center; font-size:.85rem; color:#8A8375;
                    cursor:pointer; text-decoration:underline; }
  .oferta .instrucao { margin:18px 0 10px; font-size:.9rem; color:#BDB5A6; line-height:1.5; }
  .oferta .codigo { background:#0E0D09; border:1px solid #3A362C; border-radius:10px; padding:14px;
                    font-family:'Courier New',monospace; font-size:.75rem; line-height:1.5;
                    word-break:break-all; color:#E8E2D6; user-select:all; }
  .oferta .aviso { margin:14px 0 0; font-size:.85rem; color:#8A8375; line-height:1.5; }
  .oferta .erro { margin:14px 0 0; font-size:.88rem; color:#F0A0A0; line-height:1.5; }
</style></head><body><main>
<h1>Olá, ${escaparHtml(nome)}</h1>
<p class="sub">Seu pagamento foi confirmado. Este endereço vale por ${HORAS_LINK_ENTREGA} horas.</p>

<section class="preparo">
  <h2>Sua Oração já está sendo preparada</h2>
  <p>
    O padre está rezando a Oração <strong>dedicada ao seu nome</strong>. Isso não é
    um arquivo pronto que sai na hora — é feito para você, um por um.
  </p>
  <!--
    O CANAL PROMETIDO PRECISA SER O QUE EXISTE.

    Aqui dizia WhatsApp, e o número da operação foi restringido em 13/08/2026.
    Uma promessa de entrega por um canal que não funciona não é detalhe de
    texto: é cada venda nova nascendo com uma dívida que ninguém tem como pagar,
    e o cliente esperando por um lugar onde nada vai chegar.

    Quando o WhatsApp voltar, o que muda é este bloco e o equivalente em
    server/email.ts — os dois juntos, sempre, senão a página promete uma coisa e
    o e-mail promete outra.
  -->
  <p>
    Assim que estiver concluída, ela chega <strong>no seu e-mail, em até 72 horas</strong>.
    Você não precisa fazer nada, nem responder, nem mandar comprovante.
  </p>
  <div class="numero">
    <span>Vamos enviar para este endereço:</span>
    <strong>${escaparHtml(email)}</strong>
  </div>
  <p>
    Se o endereço estiver errado, ou se passar do prazo e nada chegar, responda o
    e-mail da compra que a gente resolve na hora.
  </p>
</section>

<ul>${cartoes}</ul>
${oferta}
</main></body></html>`;
}

adminRouter.get(
  '/entrega/:id/:exp/:sig',
  asyncHandler(async (req: Request, res: Response) => {
    const { id, exp, sig } = req.params;
    const expiraEm = Number.parseInt(exp, 10);

    if (!Number.isFinite(expiraEm) || expiraEm <= Date.now()) {
      res.status(410).type('html').send('<h1>Link expirado</h1><p>Peça um link novo para a nossa equipe.</p>');
      return;
    }
    if (!entregaAssinaturaConfere(id, expiraEm, sig)) {
      res.status(403).type('html').send('<h1>Link inválido</h1>');
      return;
    }

    const order = await getOrder(id);
    if (!order || order.status !== 'completed') {
      res.status(403).type('html').send('<h1>Pedido sem pagamento confirmado</h1>');
      return;
    }

    const bundle = await buildAccessBundle(order);

    /*
     * A oferta só aparece para quem ainda não a tem.
     *
     * Três portas fechadas, e cada uma já custou dinheiro em algum lugar:
     * oferecer a quem comprou parece cobrança em duplicidade e gera pedido de
     * estorno; oferecer sobre um pedido que já é upsell criaria neto de pedido,
     * que o gateway aceita e ninguém sabe entregar; e um pedido filho ainda
     * pendente significa que a pessoa está com o PIX aberto neste instante —
     * mostrar o botão de novo geraria uma segunda cobrança para a mesma coisa.
     */
    const ehPedidoPrincipal = !order.parentOrderId;
    const filhos = ehPedidoPrincipal
      ? (await listOrders({ limite: 500 })).filter((candidato) => candidato.parentOrderId === order.id)
      : [];
    const jaTemOuEstaPagando = filhos.some(
      (filho) => filho.status === 'completed' || filho.status === 'pending',
    );
    const oferta = ehPedidoPrincipal && !jaTemOuEstaPagando ? blocoDeOferta(order.id) : '';

    // O contador de entregas mora no próprio pedido, então funciona igual no
    // arquivo e no Postgres, sem tabela extra.
    order.entregas = {
      total: (order.entregas?.total ?? 0) + 1,
      ultimoEm: new Date().toISOString(),
      ultimoIp: ipDoCliente(req),
    };
    await saveOrder(order);
    void auditar({
      papel: 'cliente',
      ip: ipDoCliente(req),
      acao: 'entrega.aberta',
      alvo: order.id,
      detalhe: `${order.customer.name} · ${order.customer.email ?? ''} · ${order.itemIds.join(', ')} · ${order.entregas.total}ª vez`,
      status: 200,
    });

    res
      .type('html')
      .send(paginaDeEntrega(order.customer.name.split(' ')[0] ?? 'você', bundle.contents, oferta, order.customer.email ?? ''));
  }),
);

/* ------------------------------------------------------------- TikTok -- */

/*
 * Pixel e parâmetros de rastreio do TikTok.
 *
 * Rota separada da do Meta, e não um campo a mais nela, porque as duas
 * plataformas divergem no que importa: o TikTok usa `__MACRO__` na URL, tem
 * lista própria de nomes de evento e o interruptor dele nasce ligado. Juntar as
 * duas numa tela só faria o dono editar o pixel de uma pensando que era da outra.
 */
adminRouter.get(
  '/admin/tiktok/credenciais',
  exigirAdmin,
  asyncHandler(async (_req: Request, res: Response) => {
    const c = await credenciaisDoTikTok();
    res.json({
      success: true,
      data: {
        pixelId: c.pixelId,
        // Só a máscara, mesma regra do Meta: o token não volta inteiro nem para
        // o dono logado. O que não trafega não vaza em log nem em print de tela.
        tokenMascarado: mascararTokenDoTikTok(c.token),
        ligado: c.ligado,
        parametros: c.parametros,
        parametrosPadrao: PARAMETROS_PADRAO_DO_TIKTOK,
        tokenIlegivel: c.tokenIlegivel,
        podeGuardarToken: c.podeGuardarToken,
      },
    });
  }),
);

adminRouter.post(
  '/admin/tiktok/credenciais',
  exigirAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const corpo = (req.body ?? {}) as {
      pixelId?: unknown;
      token?: unknown;
      ligado?: unknown;
      parametros?: unknown;
    };

    if (typeof corpo.pixelId === 'string') {
      const pixel = corpo.pixelId.trim();
      /*
       * O sdkid do TikTok é alfanumérico maiúsculo, ~20 caracteres. A validação
       * é frouxa de propósito (o formato já mudou de tamanho duas vezes), mas
       * recusa o erro que realmente acontece: colar o BLOCO DE SCRIPT inteiro no
       * campo em vez do ID. Sem isso, o `<script>` viraria o sdkid, a URL do SDK
       * nasceria inválida e o pixel simplesmente não subiria — sem nenhum aviso.
       */
      if (pixel !== '' && !/^[A-Za-z0-9_-]{6,64}$/.test(pixel)) {
        throw new ValidationError(
          'O pixel do TikTok deve ser só o identificador (algo como DA0HO4RC77U575JE9T2G), não o bloco de <script> inteiro.',
        );
      }
      await guardarPixelDoTikTok(pixel);
    }

    if (typeof corpo.token === 'string') {
      if (corpo.token.trim() !== '' && !podeGuardarToken()) {
        throw new ValidationError('Sem PAINEL_CHAVE_MESTRA não há como cifrar o token; ele não será guardado em texto puro.');
      }
      await guardarTokenDoTikTok(corpo.token);
    }

    if (typeof corpo.ligado === 'boolean') await guardarLigadoDoTikTok(corpo.ligado);

    let parametros: string[] | undefined;
    if (Array.isArray(corpo.parametros)) {
      parametros = await guardarParametrosDoTikTok(corpo.parametros as string[]);
    }

    /*
     * Não há chamada de auditoria aqui: `auditarEscritasDoPainel` é middleware e
     * já registra todo POST do painel. E é melhor assim — o token nunca chega ao
     * log, nem mascarado, porque log é o lugar de onde credencial mais escapa:
     * ninguém trata arquivo de log como dado sensível.
     */
    void parametros;

    const atual = await credenciaisDoTikTok();
    res.json({
      success: true,
      data: {
        pixelId: atual.pixelId,
        tokenMascarado: mascararTokenDoTikTok(atual.token),
        ligado: atual.ligado,
        parametros: atual.parametros,
        parametrosPadrao: PARAMETROS_PADRAO_DO_TIKTOK,
        tokenIlegivel: atual.tokenIlegivel,
        podeGuardarToken: atual.podeGuardarToken,
      },
    });
  }),
);

/* ----------------------------------------------------------------- BMs -- */

/*
 * A aba BMs: o cadastro de cada gerenciador e como cada um esta se saindo.
 *
 * Junta duas coisas que so fazem sentido lado a lado -- a configuracao (pixel,
 * conta de anuncios, token) e o RESULTADO. Separa-las obrigaria o dono a abrir
 * duas telas para responder "esta BM esta pagando?", e essa e a unica pergunta
 * que ele faz sobre uma BM.
 */
adminRouter.get(
  '/admin/bms',
  exigirAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const agoraMs = Date.now();
    const { dias: diasValidos, janela } = recortePedido(req, agoraMs);

    const [cadastradas, contagens, pedidos, investimentos, metaRoas] = await Promise.all([
      listarBmsCadastradas(),
      repositorioDoPainel().contarPorBm({ desde: janela.desde, ate: janela.ate }),
      listOrders({ desde: janela.desde, limite: LIMITE_PEDIDOS }),
      repositorioDoPainel().listarInvestimentos({ desde: janela.diaInicial, nivel: 'campanha' }),
      lerMetaDeRoas(),
    ]);
    const custos = await lerCustos();

    /*
     * Uma linha por BM, partindo do CADASTRO e nao dos numeros.
     *
     * A BM cadastrada que ainda nao recebeu visita precisa aparecer com zero --
     * some da tela justamente a que o dono acabou de configurar e quer conferir
     * se esta funcionando. Depois entram as BMs que apareceram nos dados sem
     * estar cadastradas, que sao carimbo digitado errado no anuncio.
     */
    interface LinhaDaBm {
      slug: string;
      nome: string;
      pixelId: string;
      contaAds: string;
      ativa: boolean;
      cadastrada: boolean;
      tokenMascarado: string;
      tokenAdsMascarado: string;
      visitas: number;
      quiz: number;
      vsl: number;
      checkout: number;
      pixGerados: number;
      vendas: number;
      receitaCentavos: number;
      devolucoes: number;
      devolvidoCentavos: number;
      investimentoCentavos: number;
      /* Anúncio + o imposto que a Meta cobra por fora dele. Ver server/custos.ts. */
      gastoTotalCentavos: number;
      lucroCentavos: number;
      /** Receita ÷ gasto do leilão, a mesma base do Gerenciador. */
      roas: number | null;
      /** Lucro ÷ gasto total. */
      roi: number | null;
    }

    const linhas = new Map<string, LinhaDaBm>();
    const vazia = (slug: string, cadastrada: boolean): LinhaDaBm => ({
      slug,
      nome: slug || '(sem BM)',
      pixelId: '',
      contaAds: '',
      ativa: true,
      cadastrada,
      tokenMascarado: '',
      tokenAdsMascarado: '',
      visitas: 0, quiz: 0, vsl: 0, checkout: 0,
      pixGerados: 0, vendas: 0, receitaCentavos: 0,
      devolucoes: 0, devolvidoCentavos: 0,
      investimentoCentavos: 0, gastoTotalCentavos: 0, lucroCentavos: 0,
      roas: null, roi: null,
    });

    for (const bm of cadastradas) {
      const linha = vazia(bm.slug, true);
      linha.nome = bm.nome;
      linha.pixelId = bm.pixelId;
      linha.contaAds = bm.contaAds;
      linha.ativa = bm.ativa;
      linha.tokenMascarado = mascararTokenDaBm(await tokenDaBm(bm.slug));
      /*
       * O de leitura vem da chave PRÓPRIA, sem a queda para o de Conversões.
       *
       * `tokenAdsDaBm` cai de propósito, para não quebrar quem já tinha colado um
       * token de escopo largo. Mas mostrar essa queda como se fosse um token de
       * leitura cadastrado esconderia do dono o campo que ele ainda precisa
       * preencher — e o campo em branco é justamente o aviso.
       */
      linha.tokenAdsMascarado = mascararTokenDaBm(await tokenAdsCadastradoDaBm(bm.slug));
      linhas.set(bm.slug, linha);
    }

    for (const c of contagens) {
      const linha = linhas.get(c.bm) ?? vazia(c.bm, false);
      linha.visitas += c.visitas;
      linha.quiz += c.quiz;
      linha.vsl += c.vsl;
      linha.checkout += c.checkout;
      linhas.set(c.bm, linha);
    }

    for (const order of pedidos) {
      const marca = (order.atribuicao?.bm ?? '').trim().toLowerCase();
      const linha = linhas.get(marca) ?? vazia(marca, false);
      /* PIX e venda contam so o pedido principal: upsell e downsell sao pedidos
         separados do MESMO cliente, e soma-los infla a contagem e destroi o
         ticket medio. Mesma regra da aba Anuncios. */
      const principal = order.parentOrderId === null;
      if (principal && order.qrCode) linha.pixGerados += 1;
      if (order.status === 'completed') {
        if (principal) linha.vendas += 1;
        /* A RECEITA soma o upsell: ele e dinheiro que entrou por causa desta BM,
           e ignora-lo faria o ROAS parecer pior do que e. */
        linha.receitaCentavos += order.amountCents;
      } else if (order.status === 'refunded') {
        /* Devolvido entra na conta da taxa: o gateway cobrou quando o dinheiro
           passou, e a BM que atrai comprador arrependido custa mais caro do que
           a receita bruta dela deixa ver. */
        linha.devolucoes += 1;
        linha.devolvidoCentavos += order.amountCents;
      }
      linhas.set(marca, linha);
    }

    /*
     * O gasto de cada gerenciador, vindo da conta de anúncios dela.
     *
     * O carimbo é gravado por `importarInvestimentoPorBm` (server/metaAnuncios.ts).
     * O gasto SEM carimbo — planilha, digitado à mão, ou importado pela conta
     * única antiga — cai na linha "(sem BM)", que é a verdade: existe, saiu do
     * caixa, e não se sabe de quem. Distribuí-lo entre as BMs seria inventar.
     */
    for (const inv of investimentos) {
      const marca = (inv.bm ?? '').trim().toLowerCase();
      const linha = linhas.get(marca) ?? vazia(marca, false);
      linha.investimentoCentavos += inv.centavos;
      linhas.set(marca, linha);
    }

    /*
     * Lucro por BM, pelo MESMO modelo de custo da aba Resumo.
     *
     * Não é `receita - anúncio`: passa por taxa do gateway, imposto sobre a
     * venda e imposto do anúncio (server/custos.ts). Duas telas do mesmo painel
     * dizendo lucros diferentes para a mesma BM é o defeito que faz o dono parar
     * de confiar nas duas.
     */
    for (const linha of linhas.values()) {
      const conta = repartir(
        {
          receitaBrutaCentavos: linha.receitaCentavos,
          vendas: linha.vendas,
          devolvidoCentavos: linha.devolvidoCentavos,
          devolucoes: linha.devolucoes,
          investimentoCentavos: linha.investimentoCentavos,
          despesasCentavos: 0,
        },
        custos,
      );
      linha.gastoTotalCentavos = conta.gastoTotalCentavos;
      linha.lucroCentavos = conta.lucroCentavos;
      linha.roas = conta.roas;
      linha.roi = conta.roi;
    }

    const lista = [...linhas.values()].sort((a, b) => b.receitaCentavos - a.receitaCentavos || b.visitas - a.visitas);

    const totais = lista.reduce(
      (t, l) => {
        t.visitas += l.visitas; t.quiz += l.quiz; t.vsl += l.vsl; t.checkout += l.checkout;
        t.pixGerados += l.pixGerados; t.vendas += l.vendas;
        t.receitaCentavos += l.receitaCentavos; t.investimentoCentavos += l.investimentoCentavos;
        t.gastoTotalCentavos += l.gastoTotalCentavos; t.lucroCentavos += l.lucroCentavos;
        return t;
      },
      {
        visitas: 0, quiz: 0, vsl: 0, checkout: 0, pixGerados: 0, vendas: 0,
        receitaCentavos: 0, investimentoCentavos: 0, gastoTotalCentavos: 0, lucroCentavos: 0,
      },
    );

    res.json({
      success: true,
      data: {
        dias: diasValidos,
        periodo: { diaInicial: janela.diaInicial, diaFinal: janela.diaFinal },
        metaRoas,
        /*
         * Se algum gasto chegou COM carimbo de BM. A tela usa isto para decidir
         * entre mostrar as colunas de dinheiro e explicar por que elas faltam --
         * uma coluna de ROAS sempre vazia parece defeito, e uma cheia de zeros
         * parece prejuízo.
         */
        temInvestimentoPorBm: investimentos.some((i) => (i.bm ?? '') !== ''),
        /* Sem o modelo preenchido o lucro ignora taxa e imposto: a tela avisa. */
        custosConfigurados: custos.configurado,
        bms: lista,
        totais,
        podeGuardarToken: podeGuardarToken(),
      },
    });
  }),
);

adminRouter.post(
  '/admin/bms',
  exigirAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const corpo = (req.body ?? {}) as { bms?: unknown; tokens?: unknown; tokensAds?: unknown };

    if (!Array.isArray(corpo.bms)) {
      throw new ValidationError('Mande `bms` como lista.');
    }
    const salvas = await guardarBms(corpo.bms);

    /*
     * Os tokens vem num objeto a parte, `{ slug: token }`, e so os que o dono
     * digitou nesta vez. Campo em branco NAO apaga o token guardado: quem so
     * quis renomear a BM perderia a credencial sem perceber.
     */
    if (corpo.tokens && typeof corpo.tokens === 'object') {
      for (const [slug, token] of Object.entries(corpo.tokens as Record<string, unknown>)) {
        if (typeof token !== 'string' || token.trim() === '') continue;
        if (!salvas.some((b) => b.slug === slug)) continue;
        await guardarTokenDaBm(slug, token);
      }
    }

    /*
     * O token de LEITURA DE ANÚNCIOS, num campo separado do de Conversões.
     *
     * São coisas diferentes: o de Conversões sai do Gerenciador de Eventos e tem
     * escopo do pixel; o de leitura precisa de `ads_read` sobre a CONTA. Um
     * token largo faz os dois, e é por isso que a confusão sobrevive semanas --
     * quem cola o do Gerenciador de Eventos vê o rastreamento funcionar e a
     * importação de gasto falhar com um erro que não menciona campo nenhum.
     */
    if (corpo.tokensAds && typeof corpo.tokensAds === 'object') {
      for (const [slug, token] of Object.entries(corpo.tokensAds as Record<string, unknown>)) {
        if (typeof token !== 'string' || token.trim() === '') continue;
        if (!salvas.some((b) => b.slug === slug)) continue;
        await guardarTokenAdsDaBm(slug, token);
      }
    }

    res.json({ success: true, data: { bms: salvas } });
  }),
);

/*
 * Importa o gasto de CADA BM, da conta de anuncios dela.
 *
 * Rota separada da importacao de conta unica (/admin/anuncios/importar-meta) em
 * vez de substitui-la: quem ainda opera com uma conta so continua funcionando
 * sem cadastrar BM nenhuma, e as duas gravam na mesma tabela sem se atropelar --
 * a gravacao sem carimbo nao apaga o carimbo de quem tem (ver o COALESCE em
 * server/painel/repositorio.ts).
 *
 * Uma conta que falha NAO derruba as outras: o resultado traz linha por linha,
 * com o motivo de cada falha. Abortar tudo por um token vencido zeraria a tela
 * inteira no dia em que o dono mais precisa dela.
 */
adminRouter.post(
  '/admin/bms/importar-gasto',
  exigirAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const bruto = Number.parseInt(String((req.body ?? {}).dias ?? '7'), 10);
    const dias = Number.isFinite(bruto) && bruto > 0 && bruto <= 90 ? bruto : 7;

    const resultado = await importarInvestimentoPorBm({ dias, hoje: diaLocal(Date.now()) });

    const falharam = resultado.contas.filter((c) => !c.ok);
    res.json({
      success: true,
      data: {
        ...resultado,
        /*
         * A mensagem sai pronta do servidor: e ela que o dono le para saber se
         * pode confiar no numero da tela, e monta-la no navegador espalharia a
         * regra de "importacao parcial" por dois lugares.
         */
        mensagem: resultado.contas.length === 0
          ? 'Nenhuma BM ativa tem conta de anúncios cadastrada. Preencha a conta e o token de cada uma abaixo.'
          : falharam.length === 0
            ? `Gasto importado de ${resultado.contas.length} conta(s), ${resultado.dias} dias.`
            : `Importei ${resultado.contas.length - falharam.length} de ${resultado.contas.length} contas. `
              + `Falharam: ${falharam.map((c) => `${c.nome} (${c.erro})`).join('; ')}`,
      },
    });
  }),
);



/* ------------------------------------------------------------ Discord --- */

/*
 * Os enderecos dos avisos. A URL nunca volta inteira -- so a mascara.
 *
 * Quem tem a URL escreve no canal do dono. E menos grave que um token de
 * pagamento, mas nao e coisa de devolver numa tela que fica aberta.
 */
adminRouter.get(
  '/admin/discord',
  exigirAdmin,
  asyncHandler(async (_req: Request, res: Response) => {
    const atual = await enderecosDoDiscord();
    res.json({
      success: true,
      data: {
        aprovadaMascarada: mascararEndereco(atual.aprovada),
        pendenteMascarada: mascararEndereco(atual.pendente),
        aprovadaLigada: atual.aprovada !== '',
        pendenteLigada: atual.pendente !== '',
      },
    });
  }),
);

adminRouter.post(
  '/admin/discord',
  exigirAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const corpo = (req.body ?? {}) as { aprovada?: unknown; pendente?: unknown };
    const texto = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

    try {
      await salvarEnderecos({ aprovada: texto(corpo.aprovada), pendente: texto(corpo.pendente) });
    } catch (erro) {
      throw new ValidationError((erro as Error).message, { field: 'aprovada' });
    }

    const atual = await enderecosDoDiscord();
    res.json({
      success: true,
      data: {
        aprovadaMascarada: mascararEndereco(atual.aprovada),
        pendenteMascarada: mascararEndereco(atual.pendente),
      },
    });
  }),
);

/* -------------------------------------------------------------- Resumo -- */

/*
 * A aba Resumo: receita, custo e o que sobrou, numa tela so.
 *
 * Os numeros ja existiam repartidos entre Relatorios (receita), Anuncios
 * (gasto) e Pedidos (pendentes), e em nenhuma delas passavam por taxa ou
 * imposto -- "Lucro" queria dizer apenas `receita - anuncio`. Aqui a conta
 * passa por server/custos.ts e o resultado fecha com o extrato.
 *
 * Aceita `?bm=`: desde que o gasto passou a ser importado da conta de anuncios
 * de cada gerenciador (importarInvestimentoPorBm), receita e custo podem ser
 * recortados juntos. Quando a BM escolhida ainda NAO tem gasto carimbado no
 * periodo, a resposta diz isso em `investimentoDaBmDisponivel` -- porque
 * demonstrativo sem o lado do custo mostra lucro que nao existe, e e melhor a
 * tela avisar do que o dono decidir em cima disso.
 */


/* -------------------------------------------------------------------------- */
/* Exportação para importação MANUAL no Meta                                   */
/* -------------------------------------------------------------------------- */

/**
 * SHA-256 hexadecimal minúsculo, do jeito que o Meta exige.
 *
 * A normalização vem ANTES do hash e não é detalhe: o hash de "  Maria@Gmail.com "
 * e o de "maria@gmail.com" são números completamente diferentes, e o Meta compara
 * hash com hash. Espaço sobrando ou uma maiúscula fazem a venda simplesmente não
 * casar com ninguém — e o erro é invisível, porque o arquivo sobe sem reclamar.
 */
function hashDoMeta(valor: string | null | undefined): string {
  const limpo = String(valor ?? '').trim().toLowerCase();
  if (limpo === '') return '';
  return crypto.createHash('sha256').update(limpo, 'utf8').digest('hex');
}

/**
 * Telefone em E.164 sem o `+`, como o Meta espera, e SÓ ENTÃO hasheado.
 *
 * O 55 é acrescentado quando falta porque todo cliente deste funil é brasileiro
 * e o número é digitado sem país. Sem o código, o hash não bate com o do
 * cadastro do Facebook e o telefone deixa de servir como chave — que é o
 * oposto de por que ele está no arquivo.
 */
function telefoneDoMeta(bruto: string | null | undefined): string {
  const digitos = String(bruto ?? '').replace(/\D/g, '');
  if (digitos.length < 10) return '';
  return hashDoMeta(digitos.startsWith('55') ? digitos : `55${digitos}`);
}

/**
 * As colunas do arquivo do Meta, com os NOMES DA DOCUMENTAÇÃO DELES.
 *
 * Conferido em 21/08/2026 na documentação da Conversions API para eventos
 * offline. O que está aqui é o que eles definem; nada foi inventado.
 *
 *   OBRIGATÓRIOS: event_name, event_time, e — para Purchase — value e currency.
 *   CHAVES DE CORRESPONDÊNCIA (todas hasheadas em SHA-256, menos as marcadas):
 *     em (e-mail), ph (telefone), fn (nome), ln (sobrenome), country,
 *     external_id (recomendado).
 *   custom_data: order_id, que é o identificador único da transação.
 *
 * O QUE NÃO ESTÁ AQUI, E POR QUÊ: `fbclid`, `fb_ad_id`, `fb_campaign_id` e os
 * `utm_*`. A documentação de eventos offline NÃO os lista como chave de
 * correspondência — quem casa a venda com a pessoa é o dado do CLIENTE, não o
 * parâmetro do clique. Pôr essas colunas aqui daria a impressão de que a
 * atribuição sai por elas, e a primeira campanha decidida com base nisso seria
 * decidida com base em nada. Elas continuam em /admin/conversoes.csv, que é a
 * exportação do analytics interno e existe para outra pergunta.
 */
const COLUNAS_META = [
  'event_name', 'event_time', 'value', 'currency', 'order_id',
  'em', 'ph', 'fn', 'ln', 'country', 'external_id',
] as const;

/** Uma linha pronta, ou o motivo de ela ter ficado de fora. */
interface LinhaDoMeta {
  orderId: string;
  colunas: string[];
}

interface MontagemDoMeta {
  linhas: LinhaDoMeta[];
  semCliente: number;
  semMatching: number;
  invalidas: number;
  totalCentavos: number;
  comEmail: number;
  comTelefone: number;
}

/**
 * Monta as linhas do arquivo do Meta a partir das conversões.
 *
 * Compartilhado entre o CSV e a pré-visualização de propósito: se o preview
 * contasse por uma regra e o arquivo saísse por outra, o dono planejaria o
 * upload por um número e subiria outro — e descobriria a diferença dentro do
 * Gerenciador, que é o pior lugar para descobrir.
 *
 * O QUE FICA DE FORA, e por quê. Cada exclusão é contada separadamente porque
 * elas pedem consertos diferentes:
 *
 *   semCliente  — a conversão existe mas o pedido sumiu da janela lida. Sem o
 *                 cliente não há chave nenhuma.
 *   semMatching — o pedido existe mas não tem e-mail NEM telefone. O Meta
 *                 precisa de pelo menos uma chave; uma linha só com valor e
 *                 data não casa com pessoa alguma e seria descartada lá,
 *                 depois de o dono achar que exportou.
 *   invalidas   — data que não é data, valor zero ou negativo, moeda vazia,
 *                 id vazio. São linhas que o Meta recusaria ou, pior,
 *                 aceitaria errado.
 */
function montarLinhasDoMeta(
  conversoes: Awaited<ReturnType<ReturnType<typeof repositorioDoPainel>['listarConversoes']>>,
  porId: Map<string, Order>,
): MontagemDoMeta {
  const saida: MontagemDoMeta = {
    linhas: [], semCliente: 0, semMatching: 0, invalidas: 0,
    totalCentavos: 0, comEmail: 0, comTelefone: 0,
  };

  for (const c of conversoes) {
    const pedido = porId.get(c.orderId);
    if (!pedido) { saida.semCliente += 1; continue; }

    const quandoMs = Date.parse(c.paidAt);
    const valido = Number.isFinite(quandoMs)
      && quandoMs > 0
      && Number.isFinite(c.valorCentavos)
      && c.valorCentavos > 0
      && String(c.moeda ?? '').trim() !== ''
      && String(c.orderId ?? '').trim() !== '';
    if (!valido) { saida.invalidas += 1; continue; }

    const em = hashDoMeta(pedido.customer.email);
    const ph = telefoneDoMeta(pedido.customer.phone);
    if (em === '' && ph === '') { saida.semMatching += 1; continue; }

    if (em !== '') saida.comEmail += 1;
    if (ph !== '') saida.comTelefone += 1;
    saida.totalCentavos += c.valorCentavos;

    const nome = String(pedido.customer.name ?? '').trim();
    const espaco = nome.indexOf(' ');
    const primeiro = espaco < 0 ? nome : nome.slice(0, espaco);
    const ultimo = espaco < 0 ? '' : nome.slice(espaco + 1);

    saida.linhas.push({
      orderId: c.orderId,
      colunas: [
        'Purchase',
        String(Math.floor(quandoMs / 1000)),
        (c.valorCentavos / 100).toFixed(2),
        c.moeda,
        c.orderId,
        em,
        ph,
        hashDoMeta(primeiro),
        hashDoMeta(ultimo),
        hashDoMeta('br'),
        hashDoMeta(c.orderId),
      ],
    });
  }

  return saida;
}

/**
 * A janela pedida, no fuso do painel.
 *
 * `2026-08-01` quer dizer a MADRUGADA DE BRASÍLIA daquele dia, não UTC. Sem
 * isso, um pedido pago às 22h de 31/07 entraria na exportação de agosto — e o
 * dono, que fecha o mês pelo horário daqui, veria a conta não bater por três
 * horas. `ate` é INCLUSIVO do dia inteiro: quem digita 21/08 espera as vendas
 * de 21/08, não até a meia-noite que o abre.
 */
function janelaDaExportacao(req: Request): { desde?: string; ate?: string } {
  const ler = (v: unknown): string | null => {
    const t = String(v ?? '').trim();
    return t === '' ? null : t;
  };
  const bruto = { desde: ler(req.query.desde), ate: ler(req.query.ate) };
  const resolver = (valor: string | null, fimDoDia: boolean): string | undefined => {
    if (!valor) return undefined;
    if (/^\d{4}-\d{2}-\d{2}$/.test(valor)) {
      return inicioDoDiaLocal(fimDoDia ? somarDias(valor, 1) : valor);
    }
    const quando = Date.parse(valor);
    return Number.isFinite(quando) ? new Date(quando).toISOString() : undefined;
  };
  return { desde: resolver(bruto.desde, false), ate: resolver(bruto.ate, true) };
}

/** Carrega as conversões da janela e os pedidos correspondentes, em duas idas. */
async function conversoesComPedidos(req: Request, apenasNovas: boolean) {
  const { desde, ate } = janelaDaExportacao(req);
  const conversoes = await repositorioDoPainel().listarConversoes({
    desde,
    ate,
    limite: Number.parseInt(String(req.query.limite ?? '5000'), 10) || 5000,
    apenasNaoExportadas: apenasNovas,
  });

  /*
   * Os pedidos em UMA leitura, e não um por conversão: são centenas numa
   * exportação de mês, e uma ida ao banco por linha estouraria o tempo da
   * Vercel. A folga de 45 dias para trás existe porque um pedido criado dia 1
   * pode ter sido pago dia 3 — sem ela, ele sairia do arquivo sem o cliente.
   */
  const maisAntiga = conversoes.reduce((menor, c) => Math.min(menor, Date.parse(c.paidAt)), Date.now());
  const pedidos = await listOrders({
    desde: new Date(maisAntiga - 45 * 86_400_000).toISOString(),
    limite: 20_000,
  });

  return { conversoes, porId: new Map(pedidos.map((p) => [p.id, p])), desde, ate };
}

/**
 * O que sairia num upload, ANTES de baixar o arquivo.
 *
 * Existe para o dono decidir com número na mão em vez de baixar, abrir no
 * Excel e contar linha. Usa o MESMO `montarLinhasDoMeta` do CSV: se o preview
 * contasse por uma regra e o arquivo saísse por outra, ele planejaria o upload
 * por um número e subiria outro — e descobriria a diferença dentro do
 * Gerenciador, que é o pior lugar para descobrir.
 *
 * NÃO DEVOLVE E-MAIL NEM TELEFONE, nem em texto nem em hash. Devolve QUANTOS
 * têm cada coisa, que é o que responde "vale a pena subir este lote?".
 */
adminRouter.get(
  '/admin/conversoes-meta/preview',
  exigirAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    /*
     * As duas leituras usam a MESMA janela. `todas` é o período inteiro e
     * `novas` só o que nunca foi confirmado — a diferença entre os dois é o que
     * já foi para o Meta, e é ela que o dono usa para não subir repetido.
     */
    const { conversoes, porId, desde, ate } = await conversoesComPedidos(req, false);
    const montagem = montarLinhasDoMeta(conversoes, porId);

    const novas = conversoes.filter((c) => !c.exportadoMetaEm);
    const montagemNovas = montarLinhasDoMeta(novas, porId);

    logger.info('Painel: preview da exportacao para o Meta', {
      periodo: `${desde ?? 'inicio'} .. ${ate ?? 'agora'}`,
      total: conversoes.length,
      papel: req.papelSessao ?? 'dono',
      ip: ipDoCliente(req),
    });

    res.json({
      success: true,
      data: {
        periodo: { desde: desde ?? null, ate: ate ?? null, fuso: FUSO_DO_PAINEL },
        /* Conversões confirmadas na janela, tenham elas dados de matching ou não. */
        totalNoPeriodo: conversoes.length,
        novas: novas.length,
        jaExportadas: conversoes.length - novas.length,
        /* Só as que de fato entrariam no arquivo. */
        exportaveis: montagem.linhas.length,
        exportaveisNovas: montagemNovas.linhas.length,
        valorTotalCentavos: montagem.totalCentavos,
        valorTotal: (montagem.totalCentavos / 100).toFixed(2),
        comEmail: montagem.comEmail,
        comTelefone: montagem.comTelefone,
        /*
         * Três motivos de exclusão, separados porque pedem consertos
         * diferentes: pedido fora da janela lida, cliente sem e-mail nem
         * telefone, e linha com data ou valor que não servem.
         */
        semCliente: montagem.semCliente,
        semMatching: montagem.semMatching,
        invalidas: montagem.invalidas,
      },
    });
  }),
);

/**
 * Marca um lote como REALMENTE carregado no Meta. Não envia nada.
 *
 * É o par do download, e a separação entre os dois é o ponto todo: gerar o
 * arquivo não prova que ele subiu. O dono baixa, sobe no Gerenciador, vê o
 * "carregamento concluído" na tela DELES, e só então confirma aqui. Enquanto
 * isso não acontece, as vendas continuam aparecendo em `?novas=1` — que é o
 * comportamento seguro: repetir um upload o Meta deduplica pelo `order_id`;
 * perder um upload ninguém percebe.
 *
 * Marca SOMENTE os `order_id` congelados no lote. Não é detalhe: confirmar "o
 * lote de ontem" recalculando a consulta hoje marcaria vendas que nunca
 * estiveram naquele arquivo, e elas sumiriam da fila sem terem ido a lugar
 * nenhum.
 */
adminRouter.post(
  '/admin/conversoes-meta/marcar',
  exigirAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const corpo = (req.body ?? {}) as { batchId?: unknown; batch_id?: unknown };
    /* Aceita as duas grafias: a resposta do CSV manda `X-Export-Batch-Id` e
     * quem chama de um script costuma escrever snake_case. */
    const batchId = String(corpo.batchId ?? corpo.batch_id ?? '').trim();

    if (batchId === '') {
      res.status(400).json({
        success: false,
        error: 'SEM_LOTE',
        message: 'Informe o batch_id do lote — ele vem no cabeçalho X-Export-Batch-Id do download.',
      });
      return;
    }

    const lote = await repositorioDoPainel().obterLoteDeExportacao(batchId);
    if (!lote) {
      res.status(404).json({
        success: false,
        error: 'LOTE_NAO_ENCONTRADO',
        message: 'Não achei esse lote. Confira o batch_id do arquivo que você subiu.',
      });
      return;
    }

    const jaEstavaConfirmado = Boolean(lote.confirmadoEm);

    /*
     * A ordem importa: marca as conversões ANTES de carimbar o lote.
     *
     * Se o processo morrer no meio, um lote sem carimbo com conversões já
     * marcadas é recuperável — basta confirmar de novo, e as duas operações são
     * idempotentes. O contrário (lote carimbado, conversões não) deixaria as
     * vendas na fila para sempre, com o lote dizendo que tudo já foi.
     */
    await repositorioDoPainel().marcarConversoesExportadas(lote.orderIds);
    const confirmado = await repositorioDoPainel().confirmarLoteDeExportacao(batchId, req.papelSessao ?? 'dono');

    await repositorioDoPainel().registrarAuditoria({
      papel: req.papelSessao ?? 'dono',
      ip: ipDoCliente(req),
      acao: jaEstavaConfirmado ? 'exportacao_meta_reconfirmada' : 'exportacao_meta_confirmada',
      alvo: batchId,
      detalhe: JSON.stringify({
        quantidade: lote.quantidade,
        confirmadoEm: confirmado?.confirmadoEm ?? null,
        jaEstavaConfirmado,
        orderIds: lote.orderIds,
      }).slice(0, 8000),
      status: 200,
    }).catch(() => { /* auditoria nunca derruba a confirmacao */ });

    logger.info('Painel: upload no Meta confirmado pelo dono', {
      batchId,
      quantidade: lote.quantidade,
      jaEstavaConfirmado,
      papel: req.papelSessao ?? 'dono',
      ip: ipDoCliente(req),
    });

    res.json({
      success: true,
      data: {
        batchId,
        quantidade: lote.quantidade,
        /* A data da PRIMEIRA confirmação. Reconfirmar não a reescreve. */
        confirmadoEm: confirmado?.confirmadoEm ?? lote.confirmadoEm,
        confirmadoPor: confirmado?.confirmadoPor ?? lote.confirmadoPor,
        jaEstavaConfirmado,
        message: jaEstavaConfirmado
          ? 'Este lote já tinha sido confirmado. Nada foi alterado.'
          : `${lote.quantidade} conversões marcadas como carregadas no Meta.`,
      },
    });
  }),
);

/**
 * O arquivo para subir à mão no Gerenciador de Eventos. NADA é enviado daqui.
 *
 * A rota monta e devolve um CSV. Não fala com o Meta, não agenda envio e não
 * guarda credencial — quem sobe o arquivo é o dono, quando ele quiser.
 *
 * DE ONDE VEM CADA COISA, e por que é assim:
 *
 * A venda vem de `conversoes`, que só recebe linha com pagamento confirmado.
 * O DADO DO CLIENTE vem de `orders`, e é hasheado AQUI, na hora de montar o
 * arquivo — nunca é gravado na tabela de mensuração. Foi decisão explícita de
 * 21/08/2026 manter `conversoes` sem nome, e-mail, telefone e CPF; o Meta
 * precisa desses campos para casar a venda com uma pessoa, e a única forma de
 * atender os dois é derivar o hash no momento da exportação e não persistir
 * nada. Um hash SHA-256 não volta a ser e-mail, e o arquivo só existe enquanto
 * o download acontece.
 *
 * `action_source` NÃO é uma coluna: o Gerenciador pede isso na tela do upload,
 * não no arquivo.
 */
adminRouter.get(
  '/admin/conversoes-meta.csv',
  exigirAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const janela = (v: unknown): string | undefined => {
      const t = String(v ?? '').trim();
      if (t === '') return undefined;
      const quando = Date.parse(t);
      return Number.isFinite(quando) ? new Date(quando).toISOString() : undefined;
    };

    const soNovas = String(req.query.novas ?? '') === '1';
    const { conversoes, porId, desde, ate } = await conversoesComPedidos(req, soNovas);
    const montagem = montarLinhasDoMeta(conversoes, porId);

    /*
     * Arquivo vazio é ERRO, e não um CSV com só o cabeçalho.
     *
     * O dono baixaria, subiria no Gerenciador e receberia lá a mensagem de que
     * não havia eventos — depois de ter atravessado cinco telas. Recusar aqui,
     * com o motivo em português, custa um segundo em vez de dez minutos.
     */
    if (montagem.linhas.length === 0) {
      res.status(400).json({
        success: false,
        error: 'SEM_CONVERSOES',
        message: conversoes.length === 0
          ? 'Nenhuma venda confirmada no período escolhido.'
          : `As ${conversoes.length} vendas do período ficaram de fora: `
            + `${montagem.semCliente} sem o pedido correspondente, `
            + `${montagem.semMatching} sem e-mail nem telefone, `
            + `${montagem.invalidas} com data ou valor inválidos.`,
      });
      return;
    }

    const linhas = [COLUNAS_META.join(',')];
    for (const linha of montagem.linhas) linhas.push(linha.colunas.map(celulaCsv).join(','));

    /*
     * O LOTE NASCE AQUI, E NADA É MARCADO COMO EXPORTADO.
     *
     * Baixar não é carregar. O dono pode ver um erro, fechar a aba e baixar de
     * novo amanhã — se o download marcasse, aquelas vendas sairiam da fila de
     * "ainda não mandei" sem nunca terem chegado ao Meta, e o número ficaria
     * menor para sempre sem ninguém descobrir. Quem marca é
     * POST /admin/conversoes-meta/marcar, depois de o dono confirmar o upload.
     */
    const batchId = `lote_${new Date().toISOString().slice(0, 10)}_${crypto.randomBytes(5).toString('hex')}`;
    await repositorioDoPainel().criarLoteDeExportacao({
      batchId,
      criadoPor: req.papelSessao ?? 'dono',
      desde: desde ?? null,
      ate: ate ?? null,
      apenasNovas: soNovas,
      orderIds: montagem.linhas.map((l) => l.orderId),
      quantidade: montagem.linhas.length,
    });

    /*
     * O log NÃO carrega dado pessoal: nem e-mail, nem telefone, nem hash. Os
     * `order_id` vão porque são identificadores nossos e são o que responde
     * "o que exatamente estava naquele arquivo" seis meses depois.
     */
    await repositorioDoPainel().registrarAuditoria({
      papel: req.papelSessao ?? 'dono',
      ip: ipDoCliente(req),
      acao: 'exportacao_meta_gerada',
      alvo: batchId,
      detalhe: JSON.stringify({
        quantidade: montagem.linhas.length,
        desde: desde ?? null,
        ate: ate ?? null,
        apenasNovas: soNovas,
        semCliente: montagem.semCliente,
        semMatching: montagem.semMatching,
        invalidas: montagem.invalidas,
        orderIds: montagem.linhas.map((l) => l.orderId),
      }).slice(0, 8000),
      status: 200,
    }).catch(() => { /* auditoria nunca derruba a exportacao */ });

    logger.info('Painel: CSV do Meta gerado (NADA foi marcado como exportado)', {
      batchId,
      linhas: montagem.linhas.length,
      semCliente: montagem.semCliente,
      semMatching: montagem.semMatching,
      invalidas: montagem.invalidas,
      soNovas,
      desde: desde ?? null,
      ate: ate ?? null,
      papel: req.papelSessao ?? 'dono',
      ip: ipDoCliente(req),
    });

    /*
     * As contagens vão em CABEÇALHO, e não numa linha do arquivo: uma linha a
     * mais quebraria a importação. O `batchId` volta aqui porque é ele que o
     * dono usa depois para confirmar o upload.
     */
    res.setHeader('X-Export-Batch-Id', batchId);
    res.setHeader('X-Conversoes-Exportadas', String(montagem.linhas.length));
    res.setHeader('X-Conversoes-Sem-Cliente', String(montagem.semCliente));
    res.setHeader('X-Conversoes-Sem-Matching', String(montagem.semMatching));
    res.setHeader('X-Conversoes-Invalidas', String(montagem.invalidas));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="meta-offline-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(`\uFEFF${linhas.join('\n')}`);
  }),
);

/* -------------------------------------------------------------------------- */
/* Exportação das conversões                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Uma célula de CSV, à prova das quatro coisas que estragam a planilha.
 *
 * 1. ASPAS SEMPRE. Um `utm_campaign` com vírgula — e eles têm, os nomes de
 *    campanha deste projeto usam "ESCALA-AVATAR-VSL-CBO-15/08 [Claude]" — sem
 *    aspas quebraria a linha em duas colunas e desalinharia o resto do arquivo.
 * 2. Aspas internas viram duplas, que é como o formato escapa a si mesmo.
 * 3. Quebra de linha vira espaço: um `referrer` com \n partiria a linha.
 * 4. O PREFIXO `'` em texto que começa com `= + - @`. É a injeção de fórmula:
 *    o Excel executa uma célula que começa com `=` ao abrir o arquivo, e um
 *    `utm_content` chamado `=HYPERLINK(...)` viraria código rodando na máquina
 *    de quem abriu a exportação. O valor vem de uma URL digitada por terceiros;
 *    é exatamente o tipo de campo em que isso acontece.
 */
function celulaCsv(valor: unknown): string {
  let texto = valor === null || valor === undefined ? '' : String(valor);
  texto = texto.replace(/[\r\n]+/g, ' ');
  if (/^[=+\-@\t]/.test(texto)) texto = `'${texto}`;
  return `"${texto.replace(/"/g, '""')}"`;
}

/*
 * As colunas, na ordem pedida pelo dono. A ordem é contrato: a planilha dele e
 * qualquer importação futura contam com ela, e reordenar aqui quebraria as duas
 * em silêncio.
 */
const COLUNAS_DA_EXPORTACAO = [
  'order_id', 'paid_at', 'value', 'currency',
  'fbclid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'fb_campaign_id', 'fb_adset_id', 'fb_ad_id', 'fb_placement',
  'gclid', 'ttclid', 'tt_campaign_id', 'tt_adgroup_id', 'tt_ad_id',
] as const;

/**
 * Exporta as conversões CONFIRMADAS em CSV.
 *
 * A tabela `conversoes` só recebe linha quando um pedido vira `completed`, e
 * `applyStatus` é o único caminho até lá — então "somente pagas" não é um
 * filtro desta rota, é uma propriedade da tabela. Um filtro aqui daria a
 * impressão errada de que a origem do dado é discutível.
 *
 * O valor sai em REAIS com duas casas (`47.00`), e não em centavos: quem abre
 * este arquivo é uma planilha, e 4700 numa coluna chamada `value` é o erro de
 * leitura mais fácil de cometer.
 *
 * NÃO SAI DAQUI: nome, e-mail, telefone, CPF, IP e qualquer resposta de quiz.
 * A tabela não guarda nada disso — ver server/mensuracao.ts.
 */
adminRouter.get(
  '/admin/conversoes.csv',
  exigirAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const janela = (v: unknown): string | undefined => {
      const t = String(v ?? '').trim();
      if (t === '') return undefined;
      const quando = Date.parse(t);
      return Number.isFinite(quando) ? new Date(quando).toISOString() : undefined;
    };

    const conversoes = await repositorioDoPainel().listarConversoes({
      desde: janela(req.query.desde),
      ate: janela(req.query.ate),
      limite: Number.parseInt(String(req.query.limite ?? '5000'), 10) || 5000,
    });

    const linhas = [COLUNAS_DA_EXPORTACAO.join(',')];
    for (const c of conversoes) {
      linhas.push([
        c.orderId,
        c.paidAt,
        (c.valorCentavos / 100).toFixed(2),
        c.moeda,
        c.fbclid, c.utmSource, c.utmMedium, c.utmCampaign, c.utmTerm, c.utmContent, c.utmId,
        c.fbCampaignId, c.fbAdsetId, c.fbAdId, c.fbPlacement,
        c.gclid, c.ttclid, c.ttCampaignId, c.ttAdgroupId, c.ttAdId,
      ].map(celulaCsv).join(','));
    }

    logger.info('Painel: exportacao de conversoes', { linhas: conversoes.length, ip: ipDoCliente(req) });

    /*
     * O BOM (\uFEFF) antes do conteúdo. Sem ele o Excel em português lê o
     * arquivo como ANSI e "Oração" vira "OraÃ§Ã£o" — e o dono conclui que a
     * exportação está quebrada.
     */
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="conversoes-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(`\uFEFF${linhas.join('\n')}`);
  }),
);

adminRouter.get(
  '/admin/resumo',
  exigirAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const agoraMs = Date.now();
    const { dias, janela } = recortePedido(req, agoraMs);

    /* Mesmo saneamento do `bm=` da URL do anuncio: alfabeto fechado. */
    const bmBruto = String(req.query.bm ?? '').trim().toLowerCase().slice(0, 64);
    const bmEscolhida = bmBruto !== '' && /^[a-z0-9_-]+$/.test(bmBruto) ? bmBruto : null;

    const [todosOsPedidos, investimentos, custos, despesas] = await Promise.all([
      listOrders({ desde: janela.desde, limite: LIMITE_PEDIDOS }),
      // So campanha: os tres niveis sao o mesmo dinheiro (ver NivelDeInvestimento).
      repositorioDoPainel().listarInvestimentos({
        desde: janela.diaInicial,
        nivel: 'campanha',
        bm: bmEscolhida,
      }),
      lerCustos(),
      listarDespesas(),
    ]);

    const pedidos = bmEscolhida === null
      ? todosOsPedidos
      : todosOsPedidos.filter((o) => (o.atribuicao?.bm ?? '').trim().toLowerCase() === bmEscolhida);

    /*
     * A despesa fixa NAO e rateada entre as BMs.
     *
     * Ela e do negocio, nao do gerenciador: dividir por tres faria cada BM
     * carregar um terco da assinatura e o lucro de cada uma ficaria menor que o
     * real, enquanto a soma continuaria certa. Filtrando por BM, a despesa sai
     * da conta e a tela mostra o resultado DAQUELE trafego -- que e a pergunta
     * que se faz ao filtrar.
     */
    const despesasCentavos = bmEscolhida === null
      ? despesasDaJanela(despesas, janela.diaInicial, janela.diaFinal)
      : 0;

    const resumo = montarResumo({ pedidos, investimentos, despesasCentavos, custos });

    res.json({
      success: true,
      data: {
        dias,
        periodo: { de: janela.diaInicial, ate: janela.diaFinal },
        bm: bmEscolhida,
        /*
         * Se ha gasto carimbado desta BM no periodo. Falso com filtro ligado
         * significa "o lucro abaixo ignora o anuncio" -- e a tela precisa dizer,
         * porque o numero fica ALTO e convincente.
         */
        investimentoDaBmDisponivel: bmEscolhida === null ? true : investimentos.length > 0,
        ...resumo,
        /*
         * O ROAS de empate, calculado dos custos reais. Substitui a meta de 2x
         * chutada: com ele a tela pode dizer "acima de 1,21x este anuncio paga",
         * em vez de mandar o dono adivinhar.
         */
        roasDeEquilibrio: roasDeEquilibrio(custos, resumo.ticketCentavos ?? 0),
      },
    });
  }),
);

/* --------------------------------------------------- Modelo de custos ---- */

adminRouter.get(
  '/admin/custos',
  exigirAdmin,
  asyncHandler(async (_req: Request, res: Response) => {
    const [custos, despesas] = await Promise.all([lerCustos(), listarDespesas()]);
    res.json({ success: true, data: { custos, despesas } });
  }),
);

/*
 * Grava o modelo de custos.
 *
 * Campo em branco NAO vira zero: `paraPercentual` devolve null e o valor
 * guardado fica como estava. Zero e um valor legitimo aqui ("nao pago imposto"),
 * entao um campo que o dono nao mexeu virando zero apagaria a taxa do gateway
 * em silencio e devolveria o lucro inflado que esta tela veio corrigir.
 */
adminRouter.post(
  '/admin/custos',
  exigirAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const corpo = (req.body ?? {}) as Record<string, unknown>;
    const parcial: Record<string, number> = {};

    for (const campo of ['gatewayPercentual', 'impostoSobreVendaPercentual', 'impostoMetaAdsPercentual'] as const) {
      if (!(campo in corpo)) continue;
      const valor = paraPercentual(corpo[campo]);
      if (valor === null) throw new ValidationError(`O campo ${campo} precisa ser um percentual entre 0 e 100.`);
      parcial[campo] = valor;
    }

    for (const campo of ['gatewayFixoCentavos', 'custoPorVendaCentavos'] as const) {
      if (!(campo in corpo)) continue;
      const n = Number(corpo[campo]);
      if (!Number.isFinite(n) || n < 0) throw new ValidationError(`O campo ${campo} precisa ser um valor em centavos.`);
      parcial[campo] = Math.round(n);
    }

    const custos = await salvarCustos(parcial);
    res.json({ success: true, data: { custos } });
  }),
);

/*
 * A lista de despesas, gravada inteira de uma vez.
 *
 * Mesma forma do cadastro de BMs: sao poucas linhas, editadas juntas na tela.
 * Um PUT por linha exigiria identificador estavel para algo que o dono trata
 * como uma listinha, e o ganho seria nenhum.
 */
adminRouter.post(
  '/admin/despesas',
  exigirAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const corpo = (req.body ?? {}) as { despesas?: unknown };
    if (!Array.isArray(corpo.despesas)) throw new ValidationError('Mande `despesas` como lista.');
    const despesas = await salvarDespesas(corpo.despesas);
    res.json({ success: true, data: { despesas } });
  }),
);
