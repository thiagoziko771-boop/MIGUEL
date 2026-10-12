/**
 * Ponto único de disparo de evento no navegador.
 *
 * Cada chamada faz duas coisas com o MESMO `event_id`: manda o evento pelo
 * Pixel e manda pelo nosso servidor (`POST /api/track`), que repassa ao Meta
 * pela API de Conversões. O identificador igual é o que impede a mesma ação de
 * virar duas conversões.
 *
 * O navegador nunca manda valor em dinheiro — só o nome do evento e IDs de
 * produto. Preço só existe em server/catalog.ts, mesma regra que já vale no
 * checkout: o que vem do navegador pode ser adulterado.
 */
import { getAttribution, getSessionId, novoEventId } from './attribution';

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '/api').replace(/\/+$/, '');

/** Eventos que o funil dispara. A mesma lista existe no servidor. */
export type EventoDoFunil =
  | 'PageView'
  | 'ViewContent'
  | 'CompleteRegistration'
  | 'InitiateCheckout'
  | 'Lead'
  | 'AddPaymentInfo'
  /* Só nossos — ver SO_NOSSOS logo abaixo. */
  | 'EtapaDoFunil'
  | 'RecuperacaoVista'
  | 'RecuperacaoClique'
  /* Escolheu boleto e foi para o WhatsApp: a unica prova de que o pedido
     existiu, ja que dali a pessoa sai do site. Ver server/routes/track.ts. */
  | 'PedidoDeBoleto'
  | 'MarcoDaVSL';

/*
 * AQUI MORAVAM `SO_NOSSOS` e `PIXEL_DISPARA_NAVEGACAO`.
 *
 * Os dois existiam para decidir QUAIS eventos vazavam para o Meta e o TikTok.
 * Com a remoção do rastreamento de terceiros em 21/08/2026 a pergunta deixou de
 * existir: TODO evento é só nosso, e a lista de exceções virou a regra.
 *
 * Deixar as constantes de pé "por via das dúvidas" seria pior que apagá-las —
 * um `SO_NOSSOS` sem ninguém lendo é um convite para alguém religar metade do
 * caminho daqui a seis meses e mandar evento para fora sem perceber.
 */

interface OpcoesDeEvento {
  /** Etapa do funil (0 a 13), para o painel montar o caminho de quem desistiu. */
  step?: number;
  /** IDs de produto, nunca preço. */
  contentIds?: string[];
  /** Contato, quando o cliente já digitou. Melhora a correspondência do Meta. */
  contato?: { nome?: string; email?: string; telefone?: string };
  orderId?: string;
  /**
   * A resposta escolhida no quiz — o texto que a pessoa marcou, não o código.
   *
   * É o que transforma o remarketing em conversa: quem respondeu "estou
   * afogado em dívidas" precisa ouvir coisa diferente de quem respondeu "temo
   * pelos meus filhos". Até aqui essas escolhas viviam só na memória do
   * navegador e sumiam quando a aba fechava; o servidor recebia apenas "passou
   * pela pergunta 4", que não serve para escrever nada.
   *
   * Vai junto do `EtapaDoFunil`, que já é disparado a cada tela, em vez de um
   * evento novo: menos requisição no celular de quem tem sinal ruim, e nenhum
   * nome estranho aparecendo no Gerenciador do Meta.
   */
  /**
   * Rótulo estrutural do evento — NUNCA conteúdo de resposta do quiz.
   *
   * Sobrou para três usos, e só três: o marco da VSL ('VSL' + segundos), a
   * marcação de tela ('Tela'/'Capa') e o PEDIDO DE ORAÇÃO, que é fluxo
   * funcional e não medição — a pessoa escreve para receber uma oração, e o
   * dono precisa ler o que ela escreveu.
   *
   * O TEXTO DAS RESPOSTAS DO QUIZ SAIU DAQUI em 21/08/2026. Ele guardava o que
   * a pessoa respondeu sobre medo, dinheiro, inveja e fé, amarrado a nome,
   * e-mail, telefone e IP — dado sensível dentro da tabela de analytics, sem
   * necessidade de medição. O que o funil precisa saber é em QUE ETAPA a pessoa
   * parou, e isso a coluna `step` já responde.
   */
  resposta?: { pergunta: string; escolha: string };
  /**
   * Até onde a pessoa assistiu a VSL, em segundos inteiros.
   *
   * Existe porque a maior perda do funil acontece aqui e era cega: 87% de quem
   * chega na oferta não gera PIX, e ninguém sabia se elas saíam nos primeiros
   * quinze segundos ou já quase no fim. As duas coisas pedem consertos opostos
   * — uma é o gancho do vídeo, a outra é a oferta.
   *
   * O marco que mais importa é 242 s: é quando o vídeo diz o preço e o botão de
   * compra nasce. Quem não chega lá nunca viu a oferta.
   */
  segundosDaVSL?: number;
}

/**
 * Envia ao nosso servidor.
 *
 * `keepalive` faz a requisição sobreviver à troca de página — sem ele, o evento
 * disparado junto de uma navegação (o "ir para /obg", por exemplo) seria
 * cancelado no meio pelo navegador.
 */
function enviarAoServidor(corpo: unknown): void {
  try {
    void fetch(`${API_BASE_URL}/track`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo),
      keepalive: true,
    }).catch(() => {
      // Rastreamento é acessório: falhar aqui não pode afetar a venda.
    });
  } catch {
    // idem
  }
}

export function rastrear(evento: EventoDoFunil, opcoes: OpcoesDeEvento = {}): string {
  const eventId = novoEventId();

  const parametros: Record<string, unknown> = {};
  if (opcoes.contentIds?.length) {
    parametros.content_ids = opcoes.contentIds;
    parametros.content_type = 'product';
  }

  /*
   * AQUI DISPARAVAM O PIXEL DO META E O DO TIKTOK. Removidos em 21/08/2026.
   *
   * O evento continua nascendo com `event_id` e com os mesmos parâmetros — o
   * que mudou é que ele vai SÓ para o nosso servidor, logo abaixo. Nenhuma
   * plataforma de anúncio recebe nada do navegador.
   *
   * `parametros` continua sendo montado porque é ele que carrega `content_ids`
   * para o nosso próprio registro: o painel usa isso para saber quais produtos
   * a pessoa estava vendo quando o evento saiu.
   */

  enviarAoServidor({
    evento,
    event_id: eventId,
    session_id: getSessionId(),
    step: opcoes.step,
    url: window.location.href.slice(0, 500),
    attrib: getAttribution(),
    contato: opcoes.contato,
    order_id: opcoes.orderId,
    content_ids: opcoes.contentIds,
    resposta: opcoes.resposta,
    /*
     * O marco da VSL viaja no mesmo campo `resposta` que o quiz usa.
     *
     * Reaproveitar as colunas que já existem evita uma migração de banco para
     * guardar dois números, e a leitura continua clara: a "pergunta" é o vídeo,
     * a "escolha" é o segundo alcançado.
     */
    ...(opcoes.segundosDaVSL === undefined
      ? {}
      : { resposta: { pergunta: 'VSL', escolha: String(opcoes.segundosDaVSL) } }),
  });

  return eventId;
}
