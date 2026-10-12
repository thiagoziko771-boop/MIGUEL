/**
 * CRM interno (15/08/2026) — uma CAMADA DE LEITURA sobre o que já existe.
 *
 * Não há tabela de "leads": o lead é a SESSÃO do funil (`session_id` em
 * `eventos_funil`), e ela se liga às compras por `orders.trackId`, com
 * e-mail e telefone como identificadores auxiliares (quem clica no e-mail
 * de recuperação em outro navegador vira sessão nova, mas é a mesma pessoa).
 * As únicas estruturas próprias do CRM são as notas e as marcações manuais
 * (`crm_notas`, `crm_marcacoes`), porque isso não cabe em nenhum registro
 * que já existia.
 *
 * Tudo aqui é CALCULADO na leitura, nunca gravado: status, segmento e destino
 * saem dos eventos e dos pedidos no instante da consulta. É o que garante a
 * regra mais importante do dono — comprador NUNCA fica na reciprocidade — sem
 * depender de rotina nenhuma para "mover" a pessoa: no segundo em que o PIX
 * confirma, a próxima leitura já a mostra como cliente.
 */

import { chaveDoGrupo, type Atribuicao } from './atribuicao.js';
import { CATALOG } from './catalog.js';
import { MINUTOS_PADRAO } from './recuperacao.js';
import { repositorioDoPainel, type EventoDaSessao, type MarcacaoCrm } from './painel/repositorio.js';
import type { Order } from './store/types.js';
import { ehPedidoDeOracao } from './pedidoDeOracao.js';

/* -------------------------------------------------------------------------- */
/* Vocabulário                                                                */
/* -------------------------------------------------------------------------- */

/** A etapa mais longe que a pessoa alcançou, no vocabulário do dono. */
export type EtapaCrm = 'pedido' | 'quiz' | 'analise' | 'oferta' | 'checkout' | 'pix' | 'compra';

/** Onde a pessoa está agora. */
export type StatusCrm =
  | 'novo'
  | 'pedido_recebido'
  | 'quiz_em_andamento'
  | 'oferta'
  | 'pix_gerado'
  | 'pix_pendente'
  | 'pago'
  | 'recuperacao'
  | 'reciprocidade'
  | 'finalizado'
  | 'opt_out';

/** O grupo de trabalho: quem cuida dessa pessoa e como. */
export type SegmentoCrm =
  | 'FLUXO_NORMAL'
  | 'RECUPERACAO_DE_COBRANCA'
  | 'RECUPERACAO_DE_INTERESSE'
  | 'RECIPROCIDADE'
  | 'CLIENTE'
  | 'CLIENTE_UPSELL'
  | 'NAO_CONTATAR'
  | 'SEM_CONTATO';

/**
 * Quanto tempo depois do último PIX não pago a pessoa deixa a recuperação de
 * cobrança e passa à reciprocidade. 24 h é a mesma régua da campanha de
 * R$ 27,99: até lá quem trabalha é o lembrete de preço cheio.
 */
const HORAS_DE_RECUPERACAO = 24;

/* -------------------------------------------------------------------------- */
/* Tipos de saída                                                             */
/* -------------------------------------------------------------------------- */

export interface ContatoDoLead {
  nome: string;
  email: string;
  telefone: string;
}

export interface RespostaDoLead {
  step: number | null;
  pergunta: string;
  resposta: string;
  quando: string;
}

export interface MomentoDaTimeline {
  quando: string;
  tipo: 'pedido' | 'lead' | 'quiz' | 'oferta' | 'pix' | 'pagamento' | 'contato' | 'segmento' | 'nota' | 'aviso';
  texto: string;
  ok?: boolean;
}

export interface LeadCrm {
  sessionId: string;
  contato: ContatoDoLead;
  pedidoDeOracao: string | null;
  pedidoEm: string | null;
  entradaEm: string;
  ultimoEventoEm: string;
  origem: {
    utm_source: string | null;
    utm_campaign: string | null;
    utm_content: string | null;
    anuncio: string | null;
    conjunto: string | null;
    campanha: string | null;
    capa: string | null;
  };
  etapaMaxima: EtapaCrm;
  stepMaximo: number;
  gerouPix: boolean;
  pagou: boolean;
  valorPagoCentavos: number;
  status: StatusCrm;
  segmento: SegmentoCrm;
  destino: 'fluxo-normal' | 'reciprocidade' | 'recuperacao' | 'nao-contatar';
  ultimoContatoEm: string | null;
  proximaAcao: string;
  marcacao: MarcacaoCrm | null;
}

export interface PerfilCrm extends LeadCrm {
  respostas: RespostaDoLead[];
  perguntasRespondidas: number;
  percentualDoQuiz: number;
  timeline: MomentoDaTimeline[];
  pedidos: Array<{
    id: string;
    criadoEm: string;
    status: string;
    valorCentavos: number;
    itens: string[];
    principal: boolean;
    pagoEm: string | null;
    expiraEm: string | null;
  }>;
  contatos: Array<{ quando: string; canal: 'email' | 'whatsapp' | 'sistema'; texto: string; status: string | null }>;
  notas: Array<{ id: string; autor: string; texto: string; criadaEm: string }>;
}

/* -------------------------------------------------------------------------- */
/* Leitura dos eventos                                                        */
/* -------------------------------------------------------------------------- */

const TOTAL_DE_PERGUNTAS = 9;

function desempacotarPedido(resposta: string): { contato: ContatoDoLead; pedido: string } {
  try {
    const j = JSON.parse(resposta) as Record<string, unknown>;
    return {
      contato: {
        nome: typeof j.nome === 'string' ? j.nome : '',
        email: typeof j.email === 'string' ? j.email : '',
        telefone: typeof j.tel === 'string' ? j.tel : '',
      },
      pedido: typeof j.pedido === 'string' ? j.pedido : '',
    };
  } catch {
    return { contato: { nome: '', email: '', telefone: '' }, pedido: resposta };
  }
}

function etapaDoStep(step: number, gerouPix: boolean, pagou: boolean, temPedido: boolean): EtapaCrm {
  if (pagou) return 'compra';
  if (gerouPix) return 'pix';
  if (step >= 13) return 'oferta';
  if (step >= 12) return 'analise';
  if (step >= 1) return 'quiz';
  return temPedido ? 'pedido' : 'quiz';
}

function primeiroValor(...valores: Array<string | null | undefined>): string | null {
  for (const v of valores) {
    const t = (v ?? '').trim();
    if (t !== '') return t;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* A regra de negócio: status, segmento e destino                             */
/* -------------------------------------------------------------------------- */

interface Sinais {
  temPedido: boolean;
  stepMaximo: number;
  pedidosDaPessoa: Order[];
  agoraMs: number;
  marcacao: MarcacaoCrm | null;
}

function classificar(s: Sinais): { status: StatusCrm; segmento: SegmentoCrm; destino: LeadCrm['destino']; proximaAcao: string } {
  const principais = s.pedidosDaPessoa.filter((o) => o.parentOrderId === null);
  const filhos = s.pedidosDaPessoa.filter((o) => o.parentOrderId !== null);
  const pagou = principais.some((o) => o.status === 'completed');
  const upsellPago = filhos.some((o) => o.status === 'completed');

  if (s.marcacao?.optOut) {
    return { status: 'opt_out', segmento: 'NAO_CONTATAR', destino: 'nao-contatar', proximaAcao: 'Não contatar (opt-out)' };
  }

  // Comprou: sai de tudo. Sempre, imediatamente, sem rotina.
  if (pagou) {
    return {
      status: 'pago',
      segmento: upsellPago ? 'CLIENTE_UPSELL' : 'CLIENTE',
      destino: 'fluxo-normal',
      proximaAcao: upsellPago ? 'Cliente completo — nada a fazer' : 'Cliente — acompanhar entrega',
    };
  }

  const ultimoPix = principais
    .filter((o) => o.qrCode)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

  if (ultimoPix) {
    const vivo = ultimoPix.status === 'pending' && ultimoPix.expiresAt && Date.parse(ultimoPix.expiresAt) > s.agoraMs;
    const idadeH = (s.agoraMs - Date.parse(ultimoPix.createdAt)) / 3_600_000;
    if (vivo) {
      return { status: 'pix_gerado', segmento: 'RECUPERACAO_DE_COBRANCA', destino: 'recuperacao', proximaAcao: 'PIX vivo — aguardar; lembrete automático em 15 min' };
    }
    if (idadeH < HORAS_DE_RECUPERACAO) {
      return {
        status: 'pix_pendente',
        segmento: 'RECUPERACAO_DE_COBRANCA',
        destino: 'recuperacao',
        proximaAcao: `Recuperação de cobrança em curso (${Math.round(HORAS_DE_RECUPERACAO - idadeH)} h até a reciprocidade) — WhatsApp preço cheio`,
      };
    }
    // Passou da janela de recuperação sem pagar.
    if (s.temPedido) {
      return { status: 'reciprocidade', segmento: 'RECIPROCIDADE', destino: 'reciprocidade', proximaAcao: 'Reciprocidade — e-mail/WhatsApp em cima do pedido de oração' };
    }
    return { status: 'recuperacao', segmento: 'RECUPERACAO_DE_COBRANCA', destino: 'recuperacao', proximaAcao: 'Elegível à promoção R$ 27,99 (sem pedido de oração)' };
  }

  // Nunca gerou PIX.
  if (s.temPedido) {
    if (s.stepMaximo >= 13) {
      return { status: 'oferta', segmento: 'RECUPERACAO_DE_INTERESSE', destino: 'reciprocidade', proximaAcao: 'Viu a oferta e não gerou PIX — reciprocidade leve' };
    }
    if (s.stepMaximo >= 1) {
      return { status: 'quiz_em_andamento', segmento: 'RECUPERACAO_DE_INTERESSE', destino: 'reciprocidade', proximaAcao: 'Parou no quiz — convite para continuar' };
    }
    return { status: 'pedido_recebido', segmento: 'RECUPERACAO_DE_INTERESSE', destino: 'reciprocidade', proximaAcao: 'Pediu e não seguiu — convite para continuar' };
  }
  if (s.stepMaximo >= 13) return { status: 'oferta', segmento: 'SEM_CONTATO', destino: 'reciprocidade', proximaAcao: 'Viu a oferta; sem contato (não deixou e-mail)' };
  if (s.stepMaximo >= 1) return { status: 'quiz_em_andamento', segmento: 'SEM_CONTATO', destino: 'reciprocidade', proximaAcao: 'No quiz; sem contato' };
  return { status: 'novo', segmento: 'SEM_CONTATO', destino: 'reciprocidade', proximaAcao: 'Só abriu a página' };
}

/* -------------------------------------------------------------------------- */
/* Montagem                                                                   */
/* -------------------------------------------------------------------------- */

function chaveDePessoa(email: string, telefone: string): string[] {
  const chaves: string[] = [];
  const e = email.trim().toLowerCase();
  const t = telefone.replace(/\D/g, '');
  if (e) chaves.push(`e:${e}`);
  if (t.length >= 10) chaves.push(`t:${t.slice(-11)}`);
  return chaves;
}

/**
 * Índice de pedidos por sessão E por pessoa (e-mail/telefone). O `trackId`
 * é o fio principal; e-mail/telefone pegam quem voltou por outro navegador.
 */
function indexarPedidos(pedidos: Order[]): { porSessao: Map<string, Order[]>; porPessoa: Map<string, Order[]> } {
  const porSessao = new Map<string, Order[]>();
  const porPessoa = new Map<string, Order[]>();
  for (const o of pedidos) {
    if (o.trackId) {
      const lista = porSessao.get(o.trackId) ?? [];
      lista.push(o);
      porSessao.set(o.trackId, lista);
    }
    for (const k of chaveDePessoa(o.customer.email, o.customer.phone)) {
      const lista = porPessoa.get(k) ?? [];
      lista.push(o);
      porPessoa.set(k, lista);
    }
  }
  return { porSessao, porPessoa };
}

function pedidosDaPessoa(
  sessionId: string,
  contato: ContatoDoLead,
  indice: ReturnType<typeof indexarPedidos>,
): Order[] {
  const vistos = new Set<string>();
  const saida: Order[] = [];
  const junta = (lista: Order[] | undefined) => {
    for (const o of lista ?? []) {
      if (vistos.has(o.id)) continue;
      vistos.add(o.id);
      saida.push(o);
    }
  };
  junta(indice.porSessao.get(sessionId));
  for (const k of chaveDePessoa(contato.email, contato.telefone)) junta(indice.porPessoa.get(k));
  return saida.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function ultimoContato(pedidos: Order[], marcacao: MarcacaoCrm | null): string | null {
  const datas: string[] = [];
  for (const o of pedidos) {
    for (const marca of Object.values(o.emails ?? {})) if (marca?.enviadoEm) datas.push(marca.enviadoEm);
    if (o.campanha?.enviadoEm) datas.push(o.campanha.enviadoEm);
    if (o.recoveryEmailSentAt) datas.push(o.recoveryEmailSentAt);
  }
  if (marcacao?.contatadoEm) datas.push(marcacao.contatadoEm);
  return datas.sort().at(-1) ?? null;
}

/**
 * Monta o lead a partir dos eventos da sessão + pedidos + marcação. É a
 * função central: a lista e o perfil passam por aqui.
 */
function montarLead(
  sessionId: string,
  eventos: EventoDaSessao[],
  indice: ReturnType<typeof indexarPedidos>,
  marcacao: MarcacaoCrm | null,
  agoraMs: number,
): { lead: LeadCrm; pedidos: Order[]; eventos: EventoDaSessao[] } {
  const ordenados = [...eventos].sort((a, b) => a.t.localeCompare(b.t));
  const doPedido = ordenados.filter((e) => ehPedidoDeOracao(e.pergunta) && e.resposta).at(-1);
  const { contato: contatoDoPedido, pedido } = doPedido ? desempacotarPedido(doPedido.resposta as string) : { contato: { nome: '', email: '', telefone: '' }, pedido: '' };

  // Se não há pedido, o contato pode vir do pedido de PIX (checkout).
  let contato = contatoDoPedido;
  const pedidosSessao = indice.porSessao.get(sessionId) ?? [];
  if (!contato.email && pedidosSessao.length > 0) {
    const o = pedidosSessao[pedidosSessao.length - 1];
    contato = { nome: o.customer.name, email: o.customer.email, telefone: o.customer.phone };
  }

  const pedidos = pedidosDaPessoa(sessionId, contato, indice);
  const principais = pedidos.filter((o) => o.parentOrderId === null);
  const gerouPix = principais.some((o) => Boolean(o.qrCode));
  const pagou = principais.some((o) => o.status === 'completed');
  const valorPago = pedidos.filter((o) => o.status === 'completed').reduce((s, o) => s + o.amountCents, 0);
  const stepMaximo = ordenados.reduce((m, e) => Math.max(m, e.step ?? 0), 0);

  const primeiroComOrigem = ordenados.find((e) => chaveDoGrupo(e.atribuicao ?? {}, 'anuncio') !== '' || e.atribuicao?.utm_source);
  const a: Atribuicao = primeiroComOrigem?.atribuicao ?? pedidos[0]?.atribuicao ?? {};
  const capaEvento = ordenados.find((e) => e.pergunta === 'Capa');

  const classe = classificar({ temPedido: Boolean(doPedido), stepMaximo, pedidosDaPessoa: pedidos, agoraMs, marcacao });
  const statusFinal: StatusCrm = (marcacao?.statusManual as StatusCrm | undefined) ?? classe.status;

  const lead: LeadCrm = {
    sessionId,
    contato,
    pedidoDeOracao: pedido || null,
    pedidoEm: doPedido?.t ?? null,
    entradaEm: ordenados[0]?.t ?? new Date(agoraMs).toISOString(),
    ultimoEventoEm: ordenados.at(-1)?.t ?? new Date(agoraMs).toISOString(),
    origem: {
      utm_source: primeiroValor(a.utm_source),
      utm_campaign: primeiroValor(a.utm_campaign),
      utm_content: primeiroValor(a.utm_content),
      anuncio: primeiroValor(a.utm_content, a.fb_ad_id),
      conjunto: primeiroValor(a.utm_term, a.fb_adset_id),
      campanha: primeiroValor(a.utm_campaign, a.fb_campaign_id),
      capa: capaEvento?.resposta ?? null,
    },
    etapaMaxima: etapaDoStep(stepMaximo, gerouPix, pagou, Boolean(doPedido)),
    stepMaximo,
    gerouPix,
    pagou,
    valorPagoCentavos: valorPago,
    status: statusFinal,
    segmento: classe.segmento,
    destino: classe.destino,
    ultimoContatoEm: ultimoContato(pedidos, marcacao),
    proximaAcao: classe.proximaAcao,
    marcacao,
  };
  return { lead, pedidos, eventos: ordenados };
}

/* -------------------------------------------------------------------------- */
/* API do módulo                                                              */
/* -------------------------------------------------------------------------- */

export interface FiltrosDeLeads {
  status?: string | null;
  compra?: 'comprou' | 'nao_comprou' | 'pix_pendente' | null;
  segmento?: string | null;
  anuncio?: string | null;
  etapa?: EtapaCrm | null;
  busca?: string | null;
  soComPedido?: boolean;
}

export async function listarLeads(opcoes: {
  desde: string;
  ate: string;
  pedidos: Order[];
  agoraMs: number;
  filtros?: FiltrosDeLeads;
  limite?: number;
}): Promise<{ leads: LeadCrm[]; total: number }> {
  const repo = repositorioDoPainel();
  const sessoes = await repo.sessoesDaJanela({ desde: opcoes.desde, ate: opcoes.ate, limite: 2000 });
  if (sessoes.length === 0) return { leads: [], total: 0 };

  const ids = sessoes.map((s) => s.sessionId);
  const [eventos, marcacoes] = await Promise.all([repo.eventosDasSessoes({ sessoes: ids }), repo.listarMarcacoesCrm(ids)]);
  const porSessao = new Map<string, EventoDaSessao[]>();
  for (const e of eventos) {
    const lista = porSessao.get(e.sessionId) ?? [];
    lista.push(e);
    porSessao.set(e.sessionId, lista);
  }
  const indice = indexarPedidos(opcoes.pedidos);

  let leads = ids.map((id) => montarLead(id, porSessao.get(id) ?? [], indice, marcacoes.get(id) ?? null, opcoes.agoraMs).lead);

  const f = opcoes.filtros ?? {};
  if (f.soComPedido) leads = leads.filter((l) => l.pedidoDeOracao !== null);
  if (f.status && f.status !== 'todos') leads = leads.filter((l) => l.status === f.status);
  if (f.segmento && f.segmento !== 'todos') leads = leads.filter((l) => l.segmento === f.segmento);
  if (f.compra === 'comprou') leads = leads.filter((l) => l.pagou);
  if (f.compra === 'nao_comprou') leads = leads.filter((l) => !l.pagou);
  if (f.compra === 'pix_pendente') leads = leads.filter((l) => l.status === 'pix_pendente' || l.status === 'pix_gerado');
  if (f.anuncio) {
    const alvo = f.anuncio.toLowerCase();
    leads = leads.filter((l) => (l.origem.anuncio ?? '').toLowerCase().includes(alvo));
  }
  if (f.etapa) leads = leads.filter((l) => l.etapaMaxima === f.etapa);
  if (f.busca) {
    const b = f.busca.trim().toLowerCase();
    const digitos = b.replace(/\D/g, '');
    leads = leads.filter(
      (l) =>
        l.contato.nome.toLowerCase().includes(b) ||
        l.contato.email.toLowerCase().includes(b) ||
        (digitos.length >= 4 && l.contato.telefone.replace(/\D/g, '').includes(digitos)) ||
        (l.pedidoDeOracao ?? '').toLowerCase().includes(b),
    );
  }

  const total = leads.length;
  return { leads: leads.slice(0, opcoes.limite ?? 300), total };
}

export interface MensagemDoPedido {
  tipo: string;
  rotulo: string;
  enviadoEm: string;
  entregueEm: string | null;
  abertoEm: string | null;
  clicouEm: string | null;
}

export async function perfilDoLead(opcoes: {
  sessionId: string;
  pedidos: Order[];
  agoraMs: number;
  mensagensDoPedido: (o: Order) => MensagemDoPedido[];
}): Promise<PerfilCrm | null> {
  const repo = repositorioDoPainel();
  const [eventos, marcacoes, notas] = await Promise.all([
    repo.eventosDasSessoes({ sessoes: [opcoes.sessionId] }),
    repo.listarMarcacoesCrm([opcoes.sessionId]),
    repo.listarNotasCrm(opcoes.sessionId),
  ]);
  if (eventos.length === 0) return null;

  const indice = indexarPedidos(opcoes.pedidos);
  const { lead, pedidos, eventos: ordenados } = montarLead(opcoes.sessionId, eventos, indice, marcacoes.get(opcoes.sessionId) ?? null, opcoes.agoraMs);

  const respostas: RespostaDoLead[] = ordenados
    .filter((e) => e.pergunta && e.resposta && !ehPedidoDeOracao(e.pergunta) && e.pergunta !== 'Tela' && e.pergunta !== 'Capa' && e.pergunta !== 'VSL')
    .map((e) => ({ step: e.step, pergunta: e.pergunta as string, resposta: e.resposta as string, quando: e.t }));
  // Uma por pergunta: quem volta e responde de novo fica com a última.
  const ultimaPorPergunta = new Map<string, RespostaDoLead>();
  for (const r of respostas) ultimaPorPergunta.set(r.pergunta, r);
  const respostasFinais = [...ultimaPorPergunta.values()].sort((a, b) => (a.step ?? 0) - (b.step ?? 0));

  const timeline: MomentoDaTimeline[] = [];
  const contatos: PerfilCrm['contatos'] = [];

  if (lead.pedidoEm) timeline.push({ quando: lead.pedidoEm, tipo: 'pedido', texto: 'Pedido de oração enviado', ok: true });
  const leadEvt = ordenados.find((e) => e.evento === 'Lead');
  if (leadEvt) timeline.push({ quando: leadEvt.t, tipo: 'lead', texto: 'Contato registrado (Lead)', ok: true });
  const primeiroQuiz = ordenados.find((e) => (e.step ?? 0) >= 1 && (e.step ?? 0) <= 10 && e.evento === 'EtapaDoFunil');
  if (primeiroQuiz) timeline.push({ quando: primeiroQuiz.t, tipo: 'quiz', texto: 'Quiz iniciado', ok: true });
  const fimQuiz = ordenados.find((e) => (e.step ?? 0) >= 12);
  if (fimQuiz) timeline.push({ quando: fimQuiz.t, tipo: 'quiz', texto: 'Quiz concluído', ok: true });
  const oferta = ordenados.find((e) => (e.step ?? 0) >= 13);
  if (oferta) timeline.push({ quando: oferta.t, tipo: 'oferta', texto: 'Oferta visualizada', ok: true });

  for (const o of pedidos) {
    const rotulo = o.parentOrderId ? (o.offer === 'downsell' ? 'Versão essencial' : 'Aplicativo (upsell)') : 'PIX';
    const valor = `R$ ${(o.amountCents / 100).toFixed(2).replace('.', ',')}`;
    if (o.qrCode) timeline.push({ quando: o.createdAt, tipo: 'pix', texto: `${rotulo} gerado — ${valor}`, ok: true });
    if (o.status === 'completed' && o.paidAt) {
      timeline.push({ quando: o.paidAt, tipo: 'pagamento', texto: `PAGAMENTO CONFIRMADO — ${valor}${o.parentOrderId ? ` (${rotulo})` : ''}`, ok: true });
    } else if (o.status === 'expired') {
      timeline.push({ quando: o.expiresAt ?? o.createdAt, tipo: 'aviso', texto: `${rotulo} expirou sem pagamento`, ok: false });
    }
    /*
     * O histórico de contatos vem da MESMA função que a aba Pedidos usa
     * (`mensagensDoPedido`, injetada para não criar dependência circular com
     * as rotas). Um lugar só decide o rótulo de cada mensagem — o CRM não
     * pode dizer "promoção" onde a lista de pedidos diz "preço cheio".
     */
    for (const msg of opcoes.mensagensDoPedido(o)) {
      const canal: 'email' | 'whatsapp' | 'sistema' = /whatsapp/i.test(msg.rotulo) ? 'whatsapp' : /e-mail|email|lembrete|promo|acesso|campanha/i.test(msg.rotulo + msg.tipo) ? 'email' : 'sistema';
      const st = msg.clicouEm ? 'clicou' : msg.abertoEm ? 'abriu' : msg.entregueEm ? 'entregue' : 'enviado';
      timeline.push({ quando: msg.enviadoEm, tipo: 'contato', texto: msg.rotulo, ok: true });
      contatos.push({ quando: msg.enviadoEm, canal, texto: msg.rotulo, status: st });
    }
  }
  if (lead.marcacao?.contatadoEm) {
    timeline.push({ quando: lead.marcacao.contatadoEm, tipo: 'contato', texto: 'Contato manual registrado', ok: true });
    contatos.push({ quando: lead.marcacao.contatadoEm, canal: 'whatsapp', texto: 'Contato manual', status: null });
  }
  for (const n of notas) timeline.push({ quando: n.criadaEm, tipo: 'nota', texto: `Nota (${n.autor}): ${n.texto}` });

  // O veredito atual, no fim.
  timeline.push({
    quando: new Date(opcoes.agoraMs).toISOString(),
    tipo: 'segmento',
    texto: `Segmento atual: ${lead.segmento.replace(/_/g, ' ')} → ${lead.destino}`,
    ok: lead.pagou,
  });
  timeline.sort((a, b) => a.quando.localeCompare(b.quando));
  contatos.sort((a, b) => b.quando.localeCompare(a.quando));

  return {
    ...lead,
    respostas: respostasFinais,
    perguntasRespondidas: respostasFinais.length,
    percentualDoQuiz: Math.min(100, Math.round((respostasFinais.length / TOTAL_DE_PERGUNTAS) * 100)),
    timeline,
    pedidos: pedidos.map((o) => ({
      id: o.id,
      criadoEm: o.createdAt,
      status: o.status,
      valorCentavos: o.amountCents,
      itens: o.itemIds.map((i) => CATALOG[i]?.title ?? i),
      principal: o.parentOrderId === null,
      pagoEm: o.paidAt,
      expiraEm: o.expiresAt,
    })),
    contatos,
    notas: notas.map((n) => ({ id: n.id, autor: n.autor, texto: n.texto, criadaEm: n.criadaEm })),
  };
}

/** Os cards e o funil do topo do CRM. */
export async function resumoDoCrm(opcoes: { desde: string; ate: string; pedidos: Order[]; agoraMs: number; visitantes: number }) {
  const { leads } = await listarLeads({ ...opcoes, limite: 5000 });
  const cont = (f: (l: LeadCrm) => boolean) => leads.filter(f).length;
  const receita = leads.reduce((s, l) => s + l.valorPagoCentavos, 0);
  const compradores = cont((l) => l.pagou);
  return {
    cards: {
      totalDeLeads: leads.length,
      pedidosDeOracao: cont((l) => l.pedidoDeOracao !== null),
      quizIniciado: cont((l) => l.stepMaximo >= 1),
      ofertaVisualizada: cont((l) => l.stepMaximo >= 13),
      pixGerado: cont((l) => l.gerouPix),
      pixPendente: cont((l) => l.status === 'pix_pendente' || l.status === 'pix_gerado'),
      compradores,
      naoCompradores: cont((l) => !l.pagou),
      emRecuperacao: cont((l) => l.segmento === 'RECUPERACAO_DE_COBRANCA'),
      emReciprocidade: cont((l) => l.segmento === 'RECIPROCIDADE' || l.segmento === 'RECUPERACAO_DE_INTERESSE'),
      receitaCentavos: receita,
      ticketMedioCentavos: compradores > 0 ? Math.round(receita / compradores) : 0,
      receitaPorLeadCentavos: leads.length > 0 ? Math.round(receita / leads.length) : 0,
      receitaPorVisitanteCentavos: opcoes.visitantes > 0 ? Math.round(receita / opcoes.visitantes) : 0,
    },
    funil: [
      { etapa: 'Visitantes', quantidade: opcoes.visitantes },
      { etapa: 'Pedidos de oração', quantidade: cont((l) => l.pedidoDeOracao !== null) },
      { etapa: 'Quiz', quantidade: cont((l) => l.stepMaximo >= 1) },
      { etapa: 'Análise', quantidade: cont((l) => l.stepMaximo >= 12) },
      { etapa: 'Oferta', quantidade: cont((l) => l.stepMaximo >= 13) },
      { etapa: 'PIX', quantidade: cont((l) => l.gerouPix) },
      { etapa: 'Pagamento', quantidade: compradores },
    ],
    porSegmento: {
      FLUXO_NORMAL: cont((l) => l.destino === 'fluxo-normal'),
      RECUPERACAO_DE_COBRANCA: cont((l) => l.segmento === 'RECUPERACAO_DE_COBRANCA'),
      RECUPERACAO_DE_INTERESSE: cont((l) => l.segmento === 'RECUPERACAO_DE_INTERESSE'),
      RECIPROCIDADE: cont((l) => l.segmento === 'RECIPROCIDADE'),
      CLIENTE: cont((l) => l.segmento === 'CLIENTE'),
      CLIENTE_UPSELL: cont((l) => l.segmento === 'CLIENTE_UPSELL'),
      NAO_CONTATAR: cont((l) => l.segmento === 'NAO_CONTATAR'),
      SEM_CONTATO: cont((l) => l.segmento === 'SEM_CONTATO'),
    },
  };
}

/** Recuperação de PIX usa esta janela; exportada para o painel explicar a regra. */
export const REGRA_DO_CRM = {
  minutosAteLembrete: MINUTOS_PADRAO,
  horasDeRecuperacaoAntesDaReciprocidade: HORAS_DE_RECUPERACAO,
};
