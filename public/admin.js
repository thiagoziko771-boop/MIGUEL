/* Painel do Rezas Sagradas. JS puro: sem framework e sem build, para o painel
   nunca depender do build do funil e abrir rápido no celular do dono. */

'use strict';

var CHAVE_TOKEN = 'painel.sessao';
var CHAVE_COBRADOS = 'painel.cobrados';
var INTERVALO_ATUALIZACAO = 30000;

var estado = {
  token: null,
  pedidos: [],
  meta: null,
  dias: 0,
  status: 'todos',
  busca: '',
  campoBusca: 'tudo',
  /** Filtro da coluna E-mail: todos | nao_enviado | enviado | aberto | clicou. */
  email: 'todos',
  entregas: null,
  campanha: null,
  filtroCampanha: 'todos',
  ordemCampanha: 'enviado',
  ordemCampanhaAsc: false,
  historicoEntregas: [],
  tiposEntrega: [],
  webhooks: [],
  filtroWebhook: 'todos',
  anuncios: null,
  /** Dados da aba BMs. `null` = ainda nao buscado. */
  bms: null,
  /** Rascunho do cadastro, enquanto o dono edita sem ter salvado. */
  rascunhoBms: null,
  diasBms: 7,
  /** BM escolhida na aba Anuncios. '' = todas. */
  bmAnuncios: '',
  /** Faixa de retorno: '' | 'acima' | 'abaixo' | 'sem'. */
  filtroRoas: '',
  /** Credenciais e parametros do TikTok. `null` = ainda nao buscado. */
  tiktok: null,
  agrupamento: 'campanha',
  paiAnuncios: null,
  nomeDoPai: '',
  diasAnuncios: 7,
  // Fim da janela: 'hoje' ou 'ontem'. Anda junto com o número de dias porque
  // "Ontem" não é um tamanho de período, é um dia fechado.
  ateAnuncios: 'hoje',
  soAtivos: false,
  colunasAnuncios: 'resultado',
  secaoAnuncios: 'desempenho',
  funil: null,
  diasFunil: 7,
  ateFunil: 'hoje',
  anunciosMeta: null,
  meta: null,
  plataformaParam: 'meta',
  formatoParam: 'completo',
  verFilhos: false,
  ordem: { campo: 'data', desc: true },
  aba: 'pedidos',
  cobrados: {},
  carregando: false,
};

/* ------------------------------------------------------------- Formato -- */

function brl(centavos) {
  return (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function pct(valor) {
  return (valor * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%';
}

function digitos(texto) {
  return String(texto || '').replace(/\D+/g, '');
}

function cpfFmt(valor) {
  var d = digitos(valor);
  if (d.length !== 11) return d || '-';
  return d.slice(0, 3) + '.' + d.slice(3, 6) + '.' + d.slice(6, 9) + '-' + d.slice(9);
}

function telFmt(valor) {
  var d = digitos(valor);
  if (d.length < 10) return d || '-';
  var ddd = d.slice(0, 2);
  var resto = d.slice(2);
  var meio = resto.length === 9 ? 5 : 4;
  return '(' + ddd + ') ' + resto.slice(0, meio) + '-' + resto.slice(meio);
}

function primeiroNome(nome) {
  return String(nome || '').trim().split(/\s+/)[0] || 'tudo bem';
}

function meiaNoite(data) {
  var d = new Date(data);
  d.setHours(0, 0, 0, 0);
  return d;
}

function dataCurta(iso) {
  if (!iso) return '-';
  var d = new Date(iso);
  var hoje = meiaNoite(new Date());
  var dia = meiaNoite(d);
  var hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  var diff = Math.round((hoje - dia) / 86400000);
  if (diff === 0) return 'hoje ' + hora;
  if (diff === 1) return 'ontem ' + hora;
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' + hora;
}

function dataCompleta(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function haQuanto(iso) {
  if (!iso) return '-';
  var minutos = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutos < 1) return 'agora';
  if (minutos < 60) return 'há ' + minutos + ' min';
  var horas = Math.floor(minutos / 60);
  if (horas < 24) return 'há ' + horas + ' h';
  var dias = Math.floor(horas / 24);
  return dias === 1 ? 'ontem' : 'há ' + dias + ' dias';
}

function semAcento(texto) {
  return String(texto || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function escapar(texto) {
  return String(texto == null ? '' : texto).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/* ----------------------------------------------------------------- API -- */

function api(caminho, opcoes) {
  opcoes = opcoes || {};
  var cabecalhos = { Accept: 'application/json' };
  if (estado.token) cabecalhos['X-Admin-Sessao'] = estado.token;
  if (opcoes.body) cabecalhos['Content-Type'] = 'application/json';

  return fetch('/api' + caminho, {
    method: opcoes.method || 'GET',
    headers: cabecalhos,
    body: opcoes.body ? JSON.stringify(opcoes.body) : undefined,
  }).then(function (resposta) {
    // Qualquer 401, em qualquer chamada, derruba para o login.
    if (resposta.status === 401 && estado.token) {
      sair();
      throw new Error('Sessão expirada.');
    }
    return resposta.json().catch(function () { return {}; }).then(function (corpo) {
      if (!resposta.ok || corpo.success !== true) {
        var erro = new Error(corpo.message || 'Não foi possível concluir a operação.');
        erro.codigo = corpo.error;
        throw erro;
      }
      return corpo.data;
    });
  });
}

/* --------------------------------------------------------------- Login -- */

function entrar(evento) {
  evento.preventDefault();
  var campo = document.getElementById('senha');
  var botao = document.getElementById('botaoEntrar');
  var erro = document.getElementById('erroLogin');

  botao.disabled = true;
  botao.textContent = 'Entrando...';
  erro.hidden = true;

  api('/admin/login', { method: 'POST', body: { senha: campo.value } })
    .then(function (dados) {
      estado.token = dados.token;
      try { sessionStorage.setItem(CHAVE_TOKEN, dados.token); } catch (e) { /* aba privada */ }
      campo.value = '';
      abrirPainel();
    })
    .catch(function (falha) {
      erro.textContent = falha.message;
      erro.hidden = false;
    })
    .finally(function () {
      botao.disabled = false;
      botao.textContent = 'Entrar';
    });
}

function sair() {
  estado.token = null;
  estado.pedidos = [];
  try { sessionStorage.removeItem(CHAVE_TOKEN); } catch (e) { /* ignora */ }
  document.getElementById('painel').hidden = true;
  document.getElementById('login').hidden = false;
}

function abrirPainel() {
  document.getElementById('login').hidden = true;
  document.getElementById('painel').hidden = false;
  carregar();
}

/* ------------------------------------------------------------- Carga ---- */

function carregar() {
  if (estado.carregando || !estado.token) return Promise.resolve();
  estado.carregando = true;

  return api('/admin/pedidos?t=' + Date.now())
    .then(function (dados) {
      estado.pedidos = dados.pedidos || [];
      estado.meta = dados;
      document.getElementById('atualizado').textContent =
        'Atualizado às ' + new Date().toLocaleTimeString('pt-BR');
      desenhar();
    })
    .catch(function (falha) {
      if (falha.message !== 'Sessão expirada.') console.error(falha);
    })
    .finally(function () { estado.carregando = false; });
}

/* ------------------------------------------------------------- Recortes -- */

function inicioDoPeriodo(dias) {
  if (dias < 0) return 0;
  if (dias === 0) return meiaNoite(new Date()).getTime();
  return Date.now() - dias * 86400000;
}

function noPeriodo(iso, de, ate) {
  if (!iso) return false;
  var t = new Date(iso).getTime();
  return t >= de && (ate === undefined || t < ate);
}

function ehPrincipal(pedido) {
  return pedido.oferta === 'main' && !pedido.pedidoPaiId;
}

function pago(pedido) {
  return pedido.status === 'completed';
}

/** Números de uma janela. Receita conta pela data do PAGAMENTO; a taxa de
 *  pagamento conta pela data de CRIAÇÃO, senão o denominador muda sozinho. */
function calcular(de, ate) {
  var criados = estado.pedidos.filter(function (p) { return noPeriodo(p.criadoEm, de, ate); });
  var pagos = estado.pedidos.filter(function (p) { return noPeriodo(p.pagoEm, de, ate); });

  var faturamento = pagos.reduce(function (soma, p) { return soma + p.valor; }, 0);
  var clientes = pagos.filter(ehPrincipal).length;
  var principaisCriados = criados.filter(ehPrincipal);
  var principaisPagos = principaisCriados.filter(pago).length;

  var pendentes = criados.filter(function (p) { return p.status === 'pending'; });

  return {
    faturamento: faturamento,
    clientes: clientes,
    vendas: pagos.length,
    ticket: clientes > 0 ? Math.round(faturamento / clientes) : 0,
    pendentes: pendentes.length,
    valorPendente: pendentes.reduce(function (soma, p) { return soma + p.valor; }, 0),
    criados: principaisCriados.length,
    pagosDoCriado: principaisPagos,
    taxa: principaisCriados.length > 0 ? principaisPagos / principaisCriados.length : null,
    upsells: pagos.filter(function (p) { return p.oferta === 'upsell'; }).length,
    downsells: pagos.filter(function (p) { return p.oferta === 'downsell'; }).length,
    itens: pagos.reduce(function (mapa, p) {
      p.itens.forEach(function (item) {
        mapa[item.titulo] = (mapa[item.titulo] || 0) + item.valor;
      });
      return mapa;
    }, {}),
    anuncio: pagos.filter(function (p) { return p.origem === 'anuncio'; }),
    // MED conta pelo estado ATUAL, nao pela janela de pagamento: uma analise
    // aberta hoje sobre venda antiga continua sendo problema de hoje.
    emAnalise: criados.filter(function (p) { return p.emAnalise; }).length,
    encerrados: criados.filter(function (p) {
      return ['expired', 'cancelled', 'failed'].indexOf(p.status) !== -1;
    }).length,
  };
}

/* --------------------------------------------------------------- Telas -- */

function desenhar() {
  if (estado.aba === 'pedidos') {
    desenharLeitura();
    desenharKpis();
    desenharCobranca();
    desenharAvisoEntrega();
    desenharWidgets();
    desenharTabela();
    desenharConsultas();
  }
  if (estado.aba === 'cobranca') {
    desenharAgora();
    desenharCobrancaCompleta();
  }
  if (estado.aba === 'cobranca' && !estado.grupoCarregado) {
    estado.grupoCarregado = true;
    carregarGrupo();
  }
  if (estado.aba === 'entregas') desenharEntregas();
  if (estado.aba === 'webhooks') desenharWebhooks();
  if (estado.aba === 'pagamentos') desenharPagamentos();
  if (estado.aba === 'boletos') desenharBoletos();
  desenharAvisoModo();
}

function desenharAvisoModo() {
  var aviso = document.getElementById('avisoModo');
  if (!estado.meta) return;
  var problemas = [];
  if (estado.meta.modo === 'mock') {
    problemas.push('MODO DE TESTE: nenhuma cobrança real está sendo gerada.');
  }
  if (estado.meta.armazenamento === 'arquivo') {
    problemas.push('Os pedidos estão num arquivo local. Configure o banco antes de vender.');
  }
  aviso.textContent = problemas.join(' ');
  aviso.hidden = problemas.length === 0;
}

function desenharConsultas() {
  var alvo = document.getElementById('consultas');
  var c = estado.meta && estado.meta.consultas;
  if (!c) { alvo.textContent = ''; return; }
  alvo.textContent = 'Consultas ao Pix hoje: ' + c.count + ' de ' + c.budget;
}

function desenharLeitura() {
  var alvo = document.getElementById('leitura');
  var de = inicioDoPeriodo(estado.dias);
  var agora = calcular(de, undefined);

  if (estado.dias === 0) {
    var texto = 'Hoje até agora: ' + agora.clientes + (agora.clientes === 1 ? ' Oração vendida' : ' Orações vendidas') +
      ' (' + brl(agora.faturamento) + ') e ' + agora.pendentes +
      (agora.pendentes === 1 ? ' Pix esperando pagamento' : ' Pix esperando pagamento') +
      ' (' + brl(agora.valorPendente) + ').';
    alvo.innerHTML = escapar(texto) + ritmoDeHoje();
    return;
  }

  if (estado.dias < 0) {
    alvo.textContent = 'Desde o começo: ' + agora.clientes + ' clientes e ' + brl(agora.faturamento) + ' em vendas.';
    return;
  }

  var janela = estado.dias * 86400000;
  var anterior = calcular(de - janela, de);
  alvo.textContent = veredito(agora, anterior, estado.dias);
}

function ritmoDeHoje() {
  // Só compara com o mesmo horário dos 7 dias anteriores: dia parcial contra
  // dia inteiro faria o painel abrir no vermelho toda manhã.
  var maisAntigo = estado.pedidos.reduce(function (menor, p) {
    var t = new Date(p.criadoEm).getTime();
    return t < menor ? t : menor;
  }, Date.now());
  if (Date.now() - maisAntigo < 7 * 86400000) return '';

  var agoraDoDia = Date.now() - meiaNoite(new Date()).getTime();
  var soma = 0;
  for (var i = 1; i <= 7; i += 1) {
    var inicio = meiaNoite(new Date()).getTime() - i * 86400000;
    soma += calcular(inicio, inicio + agoraDoDia).clientes;
  }
  var media = soma / 7;
  var hoje = calcular(meiaNoite(new Date()).getTime(), undefined).clientes;
  if (media < 1) return '';

  if (hoje < media * 0.7) {
    return '<span class="ritmo alerta">Abaixo do ritmo para este horário (média de ' +
      media.toFixed(1) + ' vendas até agora).</span>';
  }
  return '<span class="ritmo">Ritmo normal pro seu horário.</span>';
}

function veredito(agora, anterior, dias) {
  var base = 'Nos últimos ' + dias + ' dias: ' + agora.clientes + ' clientes e ' + brl(agora.faturamento) + '. ';
  if (anterior.criados === 0) return base + 'Ainda não há período anterior para comparar.';

  if (agora.faturamento >= anterior.faturamento) {
    return base + 'Acima dos ' + dias + ' dias anteriores (' + brl(anterior.faturamento) + ').';
  }

  var causa;
  var menosPedidos = agora.criados < anterior.criados * 0.9;
  var taxaCaiu = agora.taxa !== null && anterior.taxa !== null && agora.taxa < anterior.taxa * 0.9;
  var ticketMenor = agora.ticket < anterior.ticket * 0.9;

  if (menosPedidos && taxaCaiu) causa = 'chegou menos gente e uma parcela menor pagou.';
  else if (menosPedidos) causa = 'chegou menos gente ao checkout.';
  else if (taxaCaiu) causa = 'chegou gente igual, mas uma parcela menor pagou.';
  else if (ticketMenor) causa = 'o valor médio por cliente caiu.';
  else causa = 'a diferença está espalhada, sem uma causa dominante.';

  return base + 'Abaixo dos ' + dias + ' dias anteriores (' + brl(anterior.faturamento) + '): ' + causa;
}

function cartaoKpi(rotulo, valor, nota, classe, opcoes) {
  opcoes = opcoes || {};
  return '<div class="kpi ' + (classe || '') + (opcoes.clicavel ? ' clicavel' : '') + '"' +
    (opcoes.clicavel ? ' tabindex="0" role="button" id="' + opcoes.id + '"' : '') + '>' +
    '<div class="rotulo">' + escapar(rotulo) + '</div>' +
    '<div class="valor">' + escapar(valor) + '</div>' +
    '<div class="nota ' + (opcoes.tom || '') + '">' + escapar(nota || '') + '</div>' +
    '</div>';
}

function desenharKpis() {
  var de = inicioDoPeriodo(estado.dias);
  var agora = calcular(de, undefined);
  var comparacao = '';
  var tom = '';

  if (estado.dias === 0) {
    // Regra de ouro: comparação NEUTRA no dia parcial, sem cor e sem direção.
    var ontem = calcular(de - 86400000, de);
    comparacao = 'ontem: ' + brl(ontem.faturamento);
  } else if (estado.dias > 0) {
    var janela = estado.dias * 86400000;
    var anterior = calcular(de - janela, de);
    if (anterior.faturamento > 0) {
      var variacao = (agora.faturamento - anterior.faturamento) / anterior.faturamento;
      comparacao = (variacao >= 0 ? '+' : '') + pct(variacao) + ' vs período anterior';
      tom = variacao >= 0 ? 'sobe' : 'desce';
    } else {
      comparacao = 'sem período anterior para comparar';
    }
  }

  document.getElementById('kpis').innerHTML =
    cartaoKpi('Faturamento', brl(agora.faturamento), comparacao, '', { tom: tom }) +
    cartaoKpi('Orações vendidas', String(agora.clientes), agora.vendas + ' cobranças pagas no total') +
    cartaoKpi('Aguardando Pix', String(agora.pendentes), brl(agora.valorPendente) + ' esperando', '',
      { clicavel: true, id: 'kpiPendentes' }) +
    cartaoKpi('Ticket médio', agora.clientes ? brl(agora.ticket) : '-', 'por cliente', 'secundario') +
    cartaoKpi('Taxa de pagamento', agora.taxa === null ? '-' : pct(agora.taxa),
      agora.pagosDoCriado + ' de ' + agora.criados + ' pagaram', 'secundario');

  var pendentesKpi = document.getElementById('kpiPendentes');
  if (pendentesKpi) {
    if (estado.status === 'pendentes') pendentesKpi.classList.add('ativo');
    pendentesKpi.addEventListener('click', filtrarPendentes);
    pendentesKpi.addEventListener('keydown', function (evento) {
      if (evento.key === 'Enter' || evento.key === ' ') { evento.preventDefault(); filtrarPendentes(); }
    });
  }

  var clientes = agora.clientes;
  var take = clientes > 0 ? ' Take rate do upsell: ' + pct(agora.upsells / clientes) + '.' : '';
  var alvoAdicionais = document.getElementById('adicionais');

  var linha = 'Adicionais pagos: ' + agora.upsells + ' app completo, ' + agora.downsells + ' app essencial.' + take +
    ' Aguardando: ' + agora.pendentes + '. Encerrados sem pagar: ' + agora.encerrados + '.';

  // MED é dinheiro que pode voltar: precisa saltar aos olhos, não virar mais um número.
  if (agora.emAnalise > 0) {
    alvoAdicionais.innerHTML = escapar(linha) +
      ' <strong style="color:var(--alerta)">' + agora.emAnalise +
      (agora.emAnalise === 1 ? ' em análise de devolução (MED).' : ' em análise de devolução (MED).') +
      '</strong>';
  } else {
    alvoAdicionais.textContent = linha + ' Nenhuma análise de devolução aberta.';
  }
}

function filtrarPendentes() {
  estado.status = estado.status === 'pendentes' ? 'todos' : 'pendentes';
  document.getElementById('filtroStatus').value = estado.status;
  desenhar();
}

/* ------------------------------------------------------------ Cobrança -- */

/*
 * Depois de quantos minutos sem contribuição vale a pena chamar.
 *
 * Cinco, e o número é do dono: quem gerou o PIX ainda está com o celular na
 * mão e o aplicativo do banco aberto. Chamar nessa janela é ajudar alguém que
 * está no meio de uma coisa; chamar duas horas depois é cobrar.
 *
 * Os quatro pagamentos mais rápidos do histórico saíram em 4, 4, 14 e 17
 * minutos — ou seja, aos cinco minutos ainda há gente pagando sozinha, e a
 * conversa entra como socorro, não como interrupção.
 */
var MINUTOS_ATE_CHAMAR = 5;

/** A janela do plantão: o que nasceu nas últimas horas ainda é "agora". */
var HORAS_DO_PLANTAO = 6;

/**
 * A tela de plantão: o que está acontecendo neste instante.
 *
 * Mostra TODOS os pedidos recentes, pagos e não pagos, porque a pergunta que
 * ela responde não é "quem devo cobrar" — é "o que está acontecendo com o
 * dinheiro que estou gastando agora". Uma venda entrando ao lado de três PIX
 * parados conta uma história que nenhuma das duas linhas conta sozinha.
 */
function pedidosDeAgora() {
  var limite = Date.now() - HORAS_DO_PLANTAO * 3600000;
  return estado.pedidos
    .filter(function (p) {
      return ehPrincipal(p) && new Date(p.criadoEm).getTime() >= limite;
    })
    .sort(function (a, b) { return new Date(b.criadoEm) - new Date(a.criadoEm); });
}

function minutosDesde(quando) {
  return Math.floor((Date.now() - new Date(quando).getTime()) / 60000);
}

function desenharAgora() {
  var alvo = document.getElementById('listaAgora');
  if (!alvo) return;

  var lista = pedidosDeAgora();
  var pagos = lista.filter(pago);
  var esperando = lista.filter(function (p) { return p.status === 'pending'; });
  var naHora = esperando.filter(function (p) { return minutosDesde(p.criadoEm) >= MINUTOS_ATE_CHAMAR; });

  document.getElementById('avisoAgora').innerHTML = lista.length === 0
    ? 'Nenhum pedido nas últimas ' + HORAS_DO_PLANTAO + ' horas. Enquanto o anúncio não roda, esta tela fica quieta.'
    : '<strong>' + lista.length + '</strong> pedido(s) nas últimas ' + HORAS_DO_PLANTAO + ' h · ' +
      '<strong>' + pagos.length + '</strong> contribuíram · ' +
      (naHora.length
        ? '<strong style="color:var(--alerta)">' + naHora.length + ' passou dos ' + MINUTOS_ATE_CHAMAR + ' min — chame agora</strong>'
        : esperando.length + ' aguardando, nenhum no ponto ainda');

  if (lista.length === 0) {
    alvo.innerHTML = '<p class="vazio">Assim que alguém gerar um Pix, ele aparece aqui na hora.</p>';
    return;
  }

  alvo.innerHTML = '<ul class="lista-abandono lista-plantao">' + lista.map(function (p) {
    var min = minutosDesde(p.criadoEm);
    var jaChamado = estado.cobrados[p.id];
    var estaPago = pago(p);
    var madura = !estaPago && p.status === 'pending' && min >= MINUTOS_ATE_CHAMAR;

    var estado_ = estaPago ? '<span class="badge pago">contribuiu</span>'
      : p.status === 'pending' ? '<span class="badge aguardando">aguardando</span>'
      : '<span class="badge morto">' + escapar(p.status === 'expired' ? 'venceu' : p.status) + '</span>';

    var acao;
    if (estaPago) {
      /*
       * Quem contribuiu vira trabalho de ENTREGA, não de cobrança. O botão
       * muda de função em vez de sumir: a Oração vai por WhatsApp em 72 h, e
       * essa é a promessa que está escrita na página que a pessoa acabou de
       * ver.
       */
      acao = digitos(p.cliente.telefone)
        ? '<button class="botao-zap entregar" data-entregar="' + escapar(p.id) + '">Entregar</button>'
        : '<span class="quando">sem telefone</span>';
    } else if (!digitos(p.cliente.telefone)) {
      acao = '<span class="quando">sem telefone</span>';
    } else if (jaChamado) {
      acao = '<span class="quando">chamado ' + escapar(haQuanto(jaChamado)) + '</span>';
    } else {
      acao = '<button class="botao-zap" data-cobrar="' + escapar(p.id) + '"' +
        (madura ? '' : ' style="opacity:.55"') + '>Chamar</button>';
    }

    return '<li' + (madura && !jaChamado ? ' class="na-hora"' : '') + '>' +
      '<span class="quando" style="min-width:74px">' + escapar(dataCurta(p.criadoEm).slice(-5)) +
        '<div class="secundario">' + (min < 60 ? min + ' min' : Math.floor(min / 60) + ' h') + '</div></span>' +
      '<span style="flex:1"><strong>' + escapar(p.cliente.nome || 'sem nome') + '</strong>' +
        '<div class="secundario">' + escapar(p.valorFormatado + ' · ' + (p.origem === 'anuncio' ? 'anúncio' : 'direto')) + '</div></span>' +
      '<span>' + estado_ + '</span>' +
      acao +
    '</li>';
  }).join('') + '</ul>';

  Array.prototype.forEach.call(alvo.querySelectorAll('[data-cobrar]'), function (botao) {
    botao.addEventListener('click', function () {
      var id = botao.dataset.cobrar;
      botao.disabled = true;
      botao.textContent = 'abrindo...';
      chamarNoWhatsApp(id).then(function () {
        estado.cobrados[id] = new Date().toISOString();
        salvarCobrados();
        desenharAgora();
      }).catch(function () {
        botao.disabled = false;
        botao.textContent = 'Chamar';
      });
    });
  });

  Array.prototype.forEach.call(alvo.querySelectorAll('[data-entregar]'), function (botao) {
    botao.addEventListener('click', function () {
      botao.disabled = true;
      botao.textContent = 'abrindo...';
      entregarNoWhatsApp(botao.dataset.entregar, function (texto) {
        document.getElementById('avisoAgora').innerHTML = escapar(texto);
      }).then(function () {
        botao.disabled = false;
        botao.textContent = 'Entregar';
      });
    });
  });
}

/* -------------------------------------------------- Convite do círculo -- */

function carregarGrupo() {
  api('/admin/grupo')
    .then(function (dados) {
      var campo = document.getElementById('linkGrupo');
      if (campo) campo.value = dados.url || '';
      document.getElementById('notaGrupo').textContent = dados.url
        ? 'O convite vai junto em toda entrega.'
        : 'Sem convite: as entregas saem sem o círculo.';
    })
    .catch(function () { /* a aba abre mesmo sem isto */ });
}

function salvarGrupo() {
  var botao = document.getElementById('salvarGrupo');
  var nota = document.getElementById('notaGrupo');
  var url = document.getElementById('linkGrupo').value.trim();

  botao.disabled = true;
  api('/admin/grupo', { method: 'POST', body: JSON.stringify({ url: url }) })
    .then(function (dados) {
      nota.textContent = dados.url
        ? 'Guardado. O convite vai junto em toda entrega.'
        : 'Convite removido. As entregas saem sem o círculo.';
    })
    .catch(function (falha) { nota.textContent = falha.message; })
    .finally(function () { botao.disabled = false; });
}

/**
 * Abre a conversa de ENTREGA — outro número, outra intenção.
 *
 * Sai pelo WhatsApp da entrega, não pelo da cobrança: o de cobrança é o número
 * que pode ser bloqueado, o da entrega é onde mora a base. A mensagem é montada
 * no servidor porque leva o convite do círculo diário, que fica guardado lá e
 * muda sem precisar publicar o site.
 *
 * ANTES DE ABRIR, TROQUE A SESSÃO: `wa.me` usa o WhatsApp que estiver logado
 * neste navegador. Com dois números, o certo é deixar cada um no seu lugar —
 * um no navegador, outro no aplicativo do celular — senão a cobrança sai pelo
 * número que não pode cair.
 */
function entregarNoWhatsApp(pedidoId, avisar) {
  var janela = window.open('', '_blank');

  return api('/admin/pedidos/' + pedidoId + '/whatsapp-entrega', { method: 'POST' })
    .then(function (dados) {
      if (janela) janela.location.href = dados.url;
      else window.location.href = dados.url;
      if (avisar) {
        avisar(dados.comGrupo
          ? 'Conversa de entrega aberta, com o convite do círculo.'
          : 'Conversa aberta. Sem convite: cole o link do grupo acima para incluí-lo.');
      }
    })
    .catch(function (falha) {
      if (janela) janela.close();
      if (avisar) avisar(falha.message);
    });
}

/*
 * Quantas conversas novas um número de WhatsApp aguenta por dia.
 *
 * NÃO É PALPITE CONSERVADOR, é o que separa uma operação de um número banido.
 * O WhatsApp vigia número novo que abre muitas conversas com gente que nunca
 * falou com ele — que é exatamente o que uma fila de cobrança faz. Um número
 * queimado leva junto o canal de entrega da Oração, que é a promessa escrita na
 * página de quem pagou.
 *
 * O teto sobe conforme o número envelhece e as pessoas respondem: quem responde
 * ensina ao WhatsApp que a conversa é desejada.
 */
var LIMITE_DIARIO_DE_COBRANCA = 25;

/**
 * A ordem da fila: quem já deu sinal de vida vem primeiro.
 *
 * Cobrar na ordem errada gasta o número com quem tinha menos chance. Quem
 * clicou no link do e-mail já voltou ao site uma vez — está a um toque de
 * concluir. Quem só recebeu vale menos que quem leu, e quem leu vale menos que
 * quem voltou.
 */
function pesoDaCobranca(pedido) {
  var e = pedido.email || {};
  var peso = 0;
  if (e.estado === 'clicou') peso += 1000;
  else if (e.estado === 'aberto') peso += 500;
  else if (e.estado === 'entregue') peso += 200;

  // Valor pesa, mas nunca mais que o sinal: R$ 88 de quem sumiu vale menos que
  // R$ 47 de quem voltou ao site ontem.
  peso += Math.min(pedido.valor / 100, 100);

  // Recência como desempate: memória fresca responde mais.
  var horas = (Date.now() - new Date(pedido.criadoEm).getTime()) / 3600000;
  peso += Math.max(0, 72 - horas);

  return peso;
}

function filaDeCobranca() {
  var limite = Date.now() - 30 * 24 * 3600000;
  return estado.pedidos
    .filter(function (p) {
      if (p.status !== 'pending' && p.status !== 'expired') return false;
      if (!ehPrincipal(p)) return false;
      if (new Date(p.criadoEm).getTime() < limite) return false;
      if (digitos(p.cliente.telefone).length < 10) return false;
      return true;
    })
    .sort(function (a, b) { return pesoDaCobranca(b) - pesoDaCobranca(a); });
}

/** Quantas conversas já foram abertas hoje, para respeitar o aquecimento. */
function cobradosHoje() {
  var hoje = new Date().toISOString().slice(0, 10);
  return Object.keys(estado.cobrados).filter(function (id) {
    return String(estado.cobrados[id]).slice(0, 10) === hoje;
  }).length;
}

function desenharCobrancaCompleta() {
  var alvo = document.getElementById('filaCobranca');
  if (!alvo) return;

  var fila = filaDeCobranca();
  var pendentes = fila.filter(function (p) { return !estado.cobrados[p.id]; });
  var feitosHoje = cobradosHoje();
  var restamHoje = Math.max(0, LIMITE_DIARIO_DE_COBRANCA - feitosHoje);
  var total = pendentes.reduce(function (s, p) { return s + p.valor; }, 0);

  document.getElementById('kpisCobranca').innerHTML = [
    { rotulo: 'Esperando contato', valor: inteiro(pendentes.length) },
    { rotulo: 'Parado nessa fila', valor: brl(total), forte: true },
    { rotulo: 'Já chamados hoje', valor: inteiro(feitosHoje) },
    { rotulo: 'Ainda dá para hoje', valor: inteiro(restamHoje) },
  ].map(function (k) {
    return '<div class="kpi"><span class="rotulo">' + k.rotulo + '</span>' +
      '<span class="valor' + (k.forte ? ' forte' : '') + '">' + escapar(k.valor) + '</span></div>';
  }).join('');

  document.getElementById('avisoCobranca').innerHTML = restamHoje > 0
    ? 'Chame de cima para baixo — a ordem já põe na frente quem leu a mensagem ou voltou ao site. ' +
      '<strong>' + restamHoje + ' conversa(s) ainda cabem hoje.</strong> O limite existe para o WhatsApp não ' +
      'derrubar o número: número novo que abre conversa demais com quem nunca falou com ele é bloqueado, ' +
      'e o número é por onde a Oração é entregue a quem pagou.'
    : '<strong>Você já chamou ' + feitosHoje + ' pessoas hoje.</strong> Pare por aqui e continue amanhã — ' +
      'insistir além disso é o caminho mais rápido para o número ser bloqueado.';

  if (pendentes.length === 0) {
    alvo.innerHTML = '<p class="vazio">Ninguém esperando contato. Toda a fila já foi chamada.</p>';
    return;
  }

  /*
   * Abrir várias conversas de uma vez economiza clique, NÃO envia sozinho.
   *
   * A diferença importa: o WhatsApp abre com o texto já escrito e o envio
   * continua sendo um gesto seu. Automatizar o envio — digitar e apertar
   * enviar por robô — é o padrão que faz número novo ser bloqueado, e é este
   * número que entrega a Oração de quem pagou.
   *
   * As janelas nascem TODAS no clique, ainda vazias, e só depois recebem o
   * endereço: navegador só permite abrir aba nova durante o gesto do usuário, e
   * abrir depois de esperar o servidor cairia no bloqueador de pop-up.
   */
  var deVez = Math.min(5, pendentes.length, restamHoje);

  alvo.innerHTML = (deVez > 1
    ? '<p style="margin:0 0 12px"><button class="botao-zap" id="abrirLote">Abrir as próximas ' + deVez +
      ' conversas</button> <span class="secundario">— o texto vai pronto; enviar continua sendo você. ' +
      'Se só abrir uma, libere as janelas deste site no navegador.</span></p>'
    : '') +
    '<ul class="lista-abandono">' + pendentes.slice(0, 60).map(function (p) {
    var e = p.email || {};
    var sinal = e.estado === 'clicou' ? '<span class="badge pago">voltou ao site</span>'
      : e.estado === 'aberto' ? '<span class="badge pago">leu o e-mail</span>'
      : e.estado === 'entregue' ? '<span class="badge aguardando">recebeu</span>'
      : '<span class="badge morto">sem contato</span>';

    return '<li>' +
      '<span style="flex:1"><strong>' + escapar(p.cliente.nome || 'sem nome') + '</strong>' +
        '<div class="secundario">' + escapar(haQuanto(p.criadoEm) + ' · ' + p.valorFormatado) + '</div></span>' +
      '<span>' + sinal + '</span>' +
      '<button class="botao-zap" data-cobrar="' + escapar(p.id) + '">Chamar</button>' +
    '</li>';
  }).join('') + '</ul>' +
  (pendentes.length > 60 ? '<p class="rodape">Mostrando os 60 primeiros de ' + pendentes.length + '.</p>' : '');

  Array.prototype.forEach.call(alvo.querySelectorAll('[data-cobrar]'), function (botao) {
    botao.addEventListener('click', function () {
      var id = botao.dataset.cobrar;
      botao.disabled = true;
      botao.textContent = 'abrindo...';
      chamarNoWhatsApp(id).then(function () {
        estado.cobrados[id] = new Date().toISOString();
        salvarCobrados();
        desenharCobrancaCompleta();
      }).catch(function () {
        botao.disabled = false;
        botao.textContent = 'Chamar';
      });
    });
  });

  var lote = document.getElementById('abrirLote');
  if (lote) {
    lote.addEventListener('click', function () {
      lote.disabled = true;
      lote.textContent = 'abrindo...';

      var alvos = pendentes.slice(0, deVez);
      // As janelas nascem aqui, dentro do clique. Ver o comentário acima.
      var janelas = alvos.map(function () { return window.open('', '_blank'); });

      Promise.all(alvos.map(function (p, i) {
        return api('/admin/pedidos/' + p.id + '/whatsapp', { method: 'POST' })
          .then(function (dados) {
            if (janelas[i]) janelas[i].location.href = dados.url;
            estado.cobrados[p.id] = new Date().toISOString();
          })
          .catch(function () {
            if (janelas[i]) janelas[i].close();
          });
      })).then(function () {
        salvarCobrados();
        return carregar();
      });
    });
  }
}

function pendentesRecentes() {
  var limite = Date.now() - 48 * 3600000;
  return estado.pedidos
    .filter(function (p) {
      return p.status === 'pending' && p.temPix && new Date(p.criadoEm).getTime() >= limite;
    })
    .sort(function (a, b) { return new Date(b.criadoEm) - new Date(a.criadoEm); });
}

function linkZap(pedido, mensagem) {
  var tel = digitos(pedido.cliente.telefone);
  if (!tel) return null;
  if (tel.length <= 11) tel = '55' + tel;
  return 'https://wa.me/' + tel + '?text=' + encodeURIComponent(mensagem);
}

function mensagemPendente(pedido) {
  return 'Oi, ' + primeiroNome(pedido.cliente.nome) + '! Aqui é da equipe das Rezas Sagradas. ' +
    'Vi que você gerou o Pix da ' + pedido.ofertaRotulo + ' (' + pedido.valorFormatado + ') ' +
    haQuanto(pedido.criadoEm) + ' e ele ainda está aberto. ' +
    'Precisa de ajuda pra pagar ou prefere que eu gere um código novo?';
}

/*
 * Abre a conversa de WhatsApp com o LINK DE PAGAMENTO dentro da mensagem.
 *
 * A mensagem antiga perguntava "precisa de ajuda pra pagar?" e parava aí: a
 * pessoa tinha que responder, alguém tinha que ver a resposta e gerar um código
 * à mão. Cada passo desses perde gente. Aqui ela recebe o endereço que gera o
 * código novo com um toque, e o preço — cheio nas primeiras 48 h, com desconto
 * depois — é decidido no servidor, que é onde a regra mora.
 *
 * A JANELA ABRE ANTES DA CHAMADA, de propósito. Navegador só permite abrir aba
 * nova durante o clique; abrir depois de esperar a resposta do servidor cai no
 * bloqueador de pop-up, e o dono ficaria olhando um botão que não faz nada.
 */
function chamarNoWhatsApp(pedidoId, avisar) {
  var janela = window.open('', '_blank');

  return api('/admin/pedidos/' + pedidoId + '/whatsapp', { method: 'POST' })
    .then(function (dados) {
      if (janela) janela.location.href = dados.url;
      else window.location.href = dados.url;
      if (avisar) avisar(dados.comDesconto ? 'Conversa aberta com a oferta de R$ 27,99.' : 'Conversa aberta com o preço cheio.');
      // O contato entra no funil da campanha, então a lista precisa se refazer.
      return carregar();
    })
    .catch(function (falha) {
      if (janela) janela.close();
      if (avisar) avisar(falha.message);
    });
}

function mensagemPago(pedido, link) {
  return 'Oi, ' + primeiroNome(pedido.cliente.nome) + '! Seu pagamento da ' + pedido.ofertaRotulo +
    ' foi confirmado e o acesso já está liberado' + (link ? ': ' + link : '.') +
    ' Consegue abrir aí?';
}

function desenharCobranca() {
  var area = document.getElementById('cobranca');
  var lista = pendentesRecentes();

  if (lista.length === 0) { area.hidden = true; return; }
  area.hidden = false;

  var total = lista.reduce(function (soma, p) { return soma + p.valor; }, 0);
  var mostrar = lista.slice(0, 6);

  var itens = mostrar.map(function (pedido) {
    var cobradoEm = estado.cobrados[pedido.id];
    /*
     * Botão, e não link pronto: a mensagem carrega o endereço de pagamento
     * assinado, que só o servidor sabe montar. Ver `chamarNoWhatsApp`.
     */
    var botao = digitos(pedido.cliente.telefone)
      ? '<button class="botao-zap' + (cobradoEm ? ' feito' : '') +
        '" data-cobrar="' + escapar(pedido.id) + '">' +
        (cobradoEm ? 'cobrado ' + haQuanto(cobradoEm) : 'Cobrar no WhatsApp') + '</button>'
      : '<span class="quando">sem telefone</span>';

    return '<li>' +
      '<span class="nome">' + escapar(pedido.cliente.nome) + '</span>' +
      '<span class="quando">' + escapar(haQuanto(pedido.criadoEm) + ', ' + pedido.ofertaRotulo) + '</span>' +
      '<span class="espaco"></span>' +
      '<span class="valor">' + escapar(pedido.valorFormatado) + '</span>' + botao +
      '</li>';
  }).join('');

  area.innerHTML = '<h2>Para cobrar agora</h2>' +
    '<p style="margin:0 0 10px;color:var(--texto-2);font-size:.85rem">' +
    lista.length + ' ' + (lista.length === 1 ? 'pessoa gerou o Pix' : 'pessoas geraram o Pix') +
    ' nas últimas 48h e ainda não pagaram: ' + brl(total) + ' esperando.</p>' +
    '<ul>' + itens + '</ul>' +
    (lista.length > 6 ? '<p class="rodape"><button class="botao-icone" id="verTodosPendentes">Ver todos na lista</button></p>' : '');

  Array.prototype.forEach.call(area.querySelectorAll('[data-cobrar]'), function (elemento) {
    elemento.addEventListener('click', function () {
      var id = elemento.dataset.cobrar;
      elemento.disabled = true;
      chamarNoWhatsApp(id).then(function () {
        // Marca só depois de a conversa abrir: um erro no meio não pode fazer
        // a pessoa parecer cobrada quando ninguém falou com ela.
        estado.cobrados[id] = new Date().toISOString();
        salvarCobrados();
        desenharCobranca();
      }).catch(function () { elemento.disabled = false; });
    });
  });

  var verTodos = document.getElementById('verTodosPendentes');
  if (verTodos) verTodos.addEventListener('click', filtrarPendentes);
}

function salvarCobrados() {
  try { localStorage.setItem(CHAVE_COBRADOS, JSON.stringify(estado.cobrados)); } catch (e) { /* ignora */ }
}

function desenharAvisoEntrega() {
  var botao = document.getElementById('avisoEntrega');
  var limite = Date.now() - 24 * 3600000;
  var semAbrir = estado.pedidos.filter(function (p) {
    return pago(p) && ehPrincipal(p) && p.entregas.total === 0 &&
      p.pagoEm && new Date(p.pagoEm).getTime() < limite;
  });

  if (semAbrir.length === 0) { botao.hidden = true; return; }
  botao.hidden = false;
  botao.textContent = semAbrir.length + (semAbrir.length === 1
    ? ' cliente pagou há mais de 24 h e ainda não abriu o link de entrega.'
    : ' clientes pagaram há mais de 24 h e ainda não abriram o link de entrega.');
  botao.onclick = function () {
    estado.dias = 30;
    estado.status = 'pagos';
    document.getElementById('filtroStatus').value = 'pagos';
    marcarChips();
    desenhar();
  };
}

/* ------------------------------------------------------------- Widgets -- */

function desenharWidgets() {
  var de = inicioDoPeriodo(estado.dias);
  var agora = calcular(de, undefined);
  document.getElementById('widgets').innerHTML =
    '<section class="painel">' + graficoDiario() + '</section>' +
    '<section class="painel">' + origemDosPedidos(agora, de) + '</section>' +
    '<section class="painel">' + oQueVende(agora) + '</section>';
}

function graficoDiario() {
  var dias = [];
  var base = meiaNoite(new Date()).getTime();
  for (var i = 29; i >= 0; i -= 1) {
    var inicio = base - i * 86400000;
    var recorte = calcular(inicio, inicio + 86400000);
    var criados = estado.pedidos.filter(function (p) {
      return noPeriodo(p.criadoEm, inicio, inicio + 86400000) && ehPrincipal(p);
    }).length;
    dias.push({ inicio: inicio, criados: criados, pagos: recorte.clientes });
  }

  var maximo = Math.max(1, dias.reduce(function (m, d) { return Math.max(m, d.criados, d.pagos); }, 0));
  var largura = 100 / dias.length;

  var barras = dias.map(function (d, indice) {
    var x = indice * largura;
    var alturaCriados = (d.criados / maximo) * 88;
    var alturaPagos = (d.pagos / maximo) * 88;
    var titulo = new Date(d.inicio).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) +
      ': ' + d.criados + ' criados, ' + d.pagos + ' pagos';
    return '<g><title>' + escapar(titulo) + '</title>' +
      '<rect x="' + (x + largura * 0.12) + '" y="' + (92 - alturaCriados) + '" width="' + (largura * 0.36) +
      '" height="' + Math.max(alturaCriados, 0.6) + '" fill="var(--borda-forte)"></rect>' +
      '<rect x="' + (x + largura * 0.52) + '" y="' + (92 - alturaPagos) + '" width="' + (largura * 0.36) +
      '" height="' + Math.max(alturaPagos, 0.6) + '" fill="var(--acento)"></rect></g>';
  }).join('');

  var semanaAtual = dias.slice(23).reduce(function (s, d) { return s + d.pagos; }, 0);
  var semanaAnterior = dias.slice(16, 23).reduce(function (s, d) { return s + d.pagos; }, 0);
  var rodape = semanaAnterior === 0
    ? 'Sem semana anterior para comparar.'
    : 'Última semana: ' + semanaAtual + ' vendas, contra ' + semanaAnterior + ' na anterior.';

  return '<h2>Vendas dia a dia (30 dias)</h2>' +
    '<svg viewBox="0 0 100 96" preserveAspectRatio="none" style="width:100%;height:130px">' + barras + '</svg>' +
    '<p class="rodape">Cinza: pedidos criados. Azul: pagos. ' + escapar(rodape) + '</p>';
}

function origemDosPedidos(agora, de) {
  var criados = estado.pedidos.filter(function (p) { return noPeriodo(p.criadoEm, de, undefined) && ehPrincipal(p); });
  var deAnuncio = criados.filter(function (p) { return p.origem === 'anuncio'; });
  var direto = criados.filter(function (p) { return p.origem === 'direto'; });

  function receita(lista) {
    return lista.filter(pago).reduce(function (s, p) { return s + p.valor; }, 0);
  }

  var comparacao = '';
  if (deAnuncio.length >= 5 && direto.length >= 5) {
    var taxaAnuncio = deAnuncio.filter(pago).length / deAnuncio.length;
    var taxaDireto = direto.filter(pago).length / direto.length;
    comparacao = 'Pagam: ' + pct(taxaAnuncio) + ' do anúncio, ' + pct(taxaDireto) + ' do direto.';
  } else {
    comparacao = 'Poucos pedidos de um dos lados para comparar as taxas.';
  }

  return '<h2>De onde vieram os pedidos</h2>' +
    barra('Anúncio', deAnuncio.length, criados.length, brl(receita(deAnuncio))) +
    barra('Direto', direto.length, criados.length, brl(receita(direto))) +
    '<p class="rodape">' + escapar(comparacao) + ' O rastreamento de anúncio começa a valer para os pedidos novos.</p>';
}

function oQueVende(agora) {
  var entradas = Object.keys(agora.itens).map(function (titulo) {
    return { titulo: titulo, valor: agora.itens[titulo] };
  }).sort(function (a, b) { return b.valor - a.valor; });

  if (entradas.length === 0) {
    return '<h2>O que está vendendo</h2><p class="rodape">Assim que houver vendas pagas, o ranking aparece aqui.</p>';
  }

  var total = entradas.reduce(function (s, e) { return s + e.valor; }, 0);
  var barras = entradas.map(function (e) {
    return barra(e.titulo, e.valor, total, brl(e.valor));
  }).join('');

  // Carro chefe só com liderança real: empate técnico não coroa ninguém.
  var frase = '';
  if (entradas.length > 1 && entradas[0].valor > entradas[1].valor * 1.3) {
    frase = escapar(entradas[0].titulo) + ' é o seu carro chefe.';
  }

  return '<h2>O que está vendendo</h2>' + barras + (frase ? '<p class="rodape">' + frase + '</p>' : '');
}

function barra(rotulo, valor, total, direita) {
  var porcento = total > 0 ? (valor / total) * 100 : 0;
  return '<div class="linha-barra">' +
    '<div class="topo"><span>' + escapar(rotulo) + '</span><span>' + escapar(direita) + '</span></div>' +
    '<div class="trilho"><div style="width:' + porcento.toFixed(1) + '%"></div></div></div>';
}

/* -------------------------------------------------------------- Tabela -- */

function filhosDe(pedidoId) {
  return estado.pedidos.filter(function (p) { return p.pedidoPaiId === pedidoId; });
}

/** Busca por campo. "Tudo" varre nome, e-mail, id, CPF, telefone e transacao. */
function bateBusca(pedido, termo, termoDigitos) {
  var campo = estado.campoBusca;

  if (campo === 'cpf') {
    return termoDigitos.length >= 3 && digitos(pedido.cliente.cpf).indexOf(termoDigitos) !== -1;
  }
  if (campo === 'email') {
    return semAcento(pedido.cliente.email).indexOf(termo) !== -1;
  }
  if (campo === 'transacao') {
    return String(pedido.cobrancaId || '').toLowerCase().indexOf(termo) !== -1;
  }

  var alvo = semAcento(pedido.cliente.nome + ' ' + pedido.cliente.email + ' ' + pedido.id + ' ' + (pedido.cobrancaId || ''));
  if (alvo.indexOf(termo) !== -1) return true;
  return termoDigitos.length >= 3 &&
    (digitos(pedido.cliente.cpf).indexOf(termoDigitos) !== -1 ||
     digitos(pedido.cliente.telefone).indexOf(termoDigitos) !== -1);
}

var PESO_DO_EMAIL = { sem_email: 0, nao_enviado: 1, enviado: 2, entregue: 3, aberto: 4, clicou: 5 };

function pesoDoEmail(pedido) {
  var situacao = (pedido.email && pedido.email.estado) || 'nao_enviado';
  return PESO_DO_EMAIL[situacao] || 0;
}

function pedidosVisiveis() {
  var de = inicioDoPeriodo(estado.dias);
  var termo = semAcento(estado.busca.trim());
  var termoDigitos = digitos(estado.busca);

  var lista = estado.pedidos.filter(function (p) {
    if (!noPeriodo(p.criadoEm, de, undefined)) return false;
    if (!estado.verFilhos && !ehPrincipal(p)) return false;
    if (estado.status === 'pagos' && !pago(p)) return false;
    if (estado.status === 'pendentes' && p.status !== 'pending') return false;
    if (estado.status === 'analise' && !p.emAnalise) return false;
    if (estado.status === 'encerrados' &&
        ['expired', 'cancelled', 'failed', 'refunded'].indexOf(p.status) === -1) return false;

    /*
     * O filtro de e-mail junta "não enviado" e "sem e-mail" em "Não avisados":
     * do ponto de vista de quem opera, os dois significam a mesma coisa —
     * ninguém falou com essa pessoa —, e separá-los só faria o dono conferir
     * duas listas para chegar à mesma conclusão.
     */
    if (estado.email !== 'todos') {
      var situacao = (p.email && p.email.estado) || 'nao_enviado';
      if (situacao === 'sem_email') situacao = 'nao_enviado';
      if (situacao !== estado.email) return false;
    }

    if (termo && !bateBusca(p, termo, termoDigitos)) return false;
    return true;
  });

  var campo = estado.ordem.campo;
  lista.sort(function (a, b) {
    var resultado;
    if (campo === 'valor') resultado = a.valor - b.valor;
    else if (campo === 'cliente') resultado = a.cliente.nome.localeCompare(b.cliente.nome, 'pt-BR');
    else if (campo === 'cpf') resultado = digitos(a.cliente.cpf).localeCompare(digitos(b.cliente.cpf));
    else if (campo === 'oferta') resultado = a.ofertaRotulo.localeCompare(b.ofertaRotulo, 'pt-BR');
    else if (campo === 'origem') resultado = a.origem.localeCompare(b.origem);
    // Do mais frio para o mais quente, para "ordenar por e-mail" trazer quem
    // voltou ao site para o topo quando a ordem estiver decrescente.
    else if (campo === 'email') resultado = pesoDoEmail(a) - pesoDoEmail(b);
    else if (campo === 'status') resultado = a.status.localeCompare(b.status);
    else resultado = new Date(a.criadoEm) - new Date(b.criadoEm);
    return estado.ordem.desc ? -resultado : resultado;
  });

  return lista;
}

function badgeStatus(pedido) {
  // MED é análise de devolução: o dinheiro pode voltar, e isso precisa aparecer
  // na linha, não só no detalhe.
  var analise = pedido.emAnalise ? ' <span class="badge analise">Em análise</span>' : '';
  /*
   * "Aguardando" quer dizer coisas diferentes em cada método, e a diferença
   * muda a atitude: PIX parado há uma hora é venda a recuperar; boleto parado
   * há um dia é o prazo do banco correndo, e cobrar essa pessoa é cobrar quem
   * talvez já tenha pagado. Por isso o método aparece na LINHA, e não só no
   * detalhe — é na lista que o dono decide quem abordar.
   */
  var porBoleto = pedido.metodo === 'boleto' ? ' <span class="badge metodo">Boleto</span>' : '';
  if (pago(pedido)) return '<span class="badge pago">Pago</span>' + porBoleto + analise;
  if (pedido.status === 'pending') return '<span class="badge aguardando">Aguardando</span>' + porBoleto + analise;
  if (pedido.status === 'refunded') return '<span class="badge estornado">Estornado</span>';
  var rotulos = { expired: 'Expirado', cancelled: 'Cancelado', failed: 'Falhou' };
  return '<span class="badge morto">' + (rotulos[pedido.status] || pedido.status) + '</span>';
}

/*
 * O e-mail desta pessoa, em uma etiqueta.
 *
 * A pergunta que esta coluna responde é "eu já falei com ela, e ela viu?".
 * Cinco respostas, e cada uma pede uma atitude diferente do dono: ninguém
 * avisou; avisou e a mensagem sumiu (endereço morto, spam); chegou e ninguém
 * leu (assunto fraco); leu (a mensagem funcionou, a oferta não); voltou ao site
 * (é aqui que nasce a venda recuperada).
 *
 * "ENTREGUE" E "ABRIU" SÃO COISAS DIFERENTES, e a distinção custou caro para
 * ser descoberta: o Gmail carrega a imagem do rodapé sozinho, de 3 a 7 segundos
 * depois do envio, sem ninguém abrir nada. Sem separar os dois, toda mensagem
 * entregue apareceria como lida e o painel mentiria com números bonitos.
 *
 * ABERTURA É PISO, NUNCA TETO: quem lê com imagens bloqueadas aparece como não
 * aberto, e agora quem lê nos dois primeiros minutos também. Serve para decidir
 * onde insistir, não para relatório.
 */
function badgeEmail(pedido) {
  var e = pedido.email;
  if (!e) return '<span class="badge morto">—</span>';

  if (e.estado === 'sem_email') {
    return '<span class="badge morto" title="O pedido nasceu sem endereço de e-mail válido">Sem e-mail</span>';
  }
  if (e.estado === 'nao_enviado') {
    return '<span class="badge morto" title="Nenhuma mensagem saiu para esta pessoa">Não enviado</span>';
  }

  var quando = e.enviadoEm ? dataCurta(e.enviadoEm) : '';
  var qual = e.marca === 'acesso' ? 'e-mail de acesso' : e.marca === 'recuperacao' ? 'lembrete do PIX' : 'e-mail';

  if (e.estado === 'clicou') {
    return '<span class="badge pago" title="Leu o ' + escapar(qual) + ' e voltou ao site">Clicou</span>' +
      '<div class="secundario">' + escapar(dataCurta(e.clicouEm)) + '</div>';
  }
  if (e.estado === 'aberto') {
    var vezes = e.aberturas > 1 ? ' · ' + e.aberturas + '×' : '';
    return '<span class="badge pago" title="Uma pessoa leu o ' + escapar(qual) + '">Leu</span>' +
      '<div class="secundario">' + escapar(dataCurta(e.abertoEm) + vezes) + '</div>';
  }
  if (e.estado === 'entregue') {
    return '<span class="badge aguardando" title="A caixa do destinatário buscou a mensagem, ' +
      'mas ninguém a abriu ainda. É prova de que o endereço existe.">Entregue</span>' +
      '<div class="secundario">' + escapar(dataCurta(e.entregueEm)) + '</div>';
  }
  return '<span class="badge morto" title="O provedor aceitou o ' + escapar(qual) +
    ', mas a mensagem não deu sinal de vida — pode ter caído em spam ou o endereço não existe">Sem sinal</span>' +
    '<div class="secundario">' + escapar(quando) + '</div>';
}

function desenharTabela() {
  var lista = pedidosVisiveis();
  var corpo = document.getElementById('corpoTabela');

  if (lista.length === 0) {
    corpo.innerHTML = '<tr><td colspan="9"><p class="vazio">' +
      (estado.pedidos.length === 0
        ? 'Nenhum pedido ainda. Assim que alguém gerar um Pix, ele aparece aqui.'
        : 'Nenhum pedido neste recorte. Troque o período ou limpe os filtros.') +
      '</p></td></tr>';
  } else {
    corpo.innerHTML = lista.map(function (pedido) {
      var filhos = estado.verFilhos ? [] : filhosDe(pedido.id);
      var extras = filhos.map(function (filho) {
        return '<span class="badge filho">' + escapar(filho.ofertaRotulo) + ' ' +
          escapar(filho.valorFormatado) + ' ' + (pago(filho) ? 'pago' : 'aguardando') + '</span>';
      }).join(' ');

      var adicionais = pedido.adicionais.length
        ? '<div class="secundario">+ ' + escapar(pedido.adicionais.length + ' adicional' +
          (pedido.adicionais.length > 1 ? 'is' : '')) + '</div>'
        : '';

      return '<tr data-id="' + escapar(pedido.id) + '">' +
        '<td data-rotulo="Data">' + escapar(dataCurta(pedido.criadoEm)) +
          '<div class="secundario">#' + escapar(pedido.id.slice(0, 8)) + '</div></td>' +
        '<td data-rotulo="Cliente"><strong>' + escapar(pedido.cliente.nome) + '</strong>' +
          '<div class="secundario">' + escapar(pedido.cliente.email) + '</div></td>' +
        '<td data-rotulo="CPF" class="num">' + escapar(cpfFmt(pedido.cliente.cpf)) + '</td>' +
        '<td data-rotulo="Oferta">' + escapar(pedido.ofertaRotulo) + adicionais + '</td>' +
        '<td data-rotulo="Valor" class="num">' + escapar(pedido.valorFormatado) + '</td>' +
        '<td data-rotulo="Origem">' + (pedido.origem === 'anuncio' ? 'Anúncio' : 'Direto') + '</td>' +
        '<td data-rotulo="E-mail">' + badgeEmail(pedido) + '</td>' +
        '<td data-rotulo="Situação">' + badgeStatus(pedido) + ' ' + extras + '</td>' +
        '<td><div class="acoes-linha">' +
          '<button data-acao="detalhes">Detalhes</button>' +
        '</div></td>' +
      '</tr>';
    }).join('');
  }

  Array.prototype.forEach.call(corpo.querySelectorAll('tr[data-id]'), function (linha) {
    linha.addEventListener('click', function () { abrirModal(linha.dataset.id); });
  });

  document.getElementById('contagem').textContent =
    lista.length + (lista.length === 1 ? ' pedido neste recorte, ' : ' pedidos neste recorte, ') +
    estado.pedidos.length + ' no total';
}

/* --------------------------------------------------------------- Modal -- */

function acharPedido(id) {
  return estado.pedidos.filter(function (p) { return p.id === id; })[0];
}

function abrirModal(id) {
  var pedido = acharPedido(id);
  if (!pedido) return;

  var filhos = filhosDe(pedido.id);
  var pai = pedido.pedidoPaiId ? acharPedido(pedido.pedidoPaiId) : null;
  var chips = [];

  if (pago(pedido) && pedido.pagoEm) {
    var minutos = Math.round((new Date(pedido.pagoEm) - new Date(pedido.criadoEm)) / 60000);
    chips.push({ tom: 'ok', texto: minutos < 1 ? 'Pagou na hora' : 'Pagou em ' + minutos + ' min' });
  } else if (pedido.status === 'pending') {
    chips.push({ tom: 'atencao', texto: 'Aguardando ' + haQuanto(pedido.criadoEm) });
    /*
     * No boleto, "aguardando há 2 dias" não é sinal de desistência — é o prazo
     * bancário. Sem esta etiqueta o dono lê a demora como abandono e vai cobrar
     * quem está dentro do prazo, ou pior, quem já pagou e espera a compensação.
     */
    if (pedido.metodo === 'boleto') {
      chips.push({
        tom: 'atencao',
        texto: pedido.boletoVenceEm
          ? 'Boleto — vence ' + new Date(pedido.boletoVenceEm).toLocaleDateString('pt-BR')
          : 'Boleto — compensa em até 3 dias úteis',
      });
    }
  }

  if (pago(pedido)) {
    chips.push(pedido.entregas.total > 0
      ? { tom: 'ok', texto: 'Abriu o link de entrega' }
      : { tom: 'atencao', texto: 'Ainda não abriu o link' });
  }
  if (filhos.some(function (f) { return pago(f) && f.oferta === 'upsell'; })) {
    chips.push({ tom: 'ok', texto: 'Comprou o app completo' });
  }
  /*
   * A linha do tempo do e-mail, em um chip.
   *
   * No detalhe cabe mais que na tabela, e o que cabe é justamente o que decide
   * a próxima ação: "enviado às 12:59, não abriu" pede WhatsApp; "abriu 3×"
   * pede ligação, porque a pessoa está lendo e não está pagando.
   */
  var email = pedido.email;
  if (email && email.estado === 'clicou') {
    chips.push({ tom: 'ok', texto: 'Leu o e-mail e voltou ao site ' + haQuanto(email.clicouEm) });
  } else if (email && email.estado === 'aberto') {
    chips.push({
      tom: 'ok',
      texto: 'Leu o e-mail ' + haQuanto(email.abertoEm) + (email.aberturas > 1 ? ' · ' + email.aberturas + ' leituras' : ''),
    });
  } else if (email && email.estado === 'entregue') {
    chips.push({ tom: 'atencao', texto: 'E-mail entregue ' + haQuanto(email.entregueEm) + ', ninguém leu' });
  } else if (email && email.estado === 'enviado') {
    chips.push({ tom: 'atencao', texto: 'E-mail enviado ' + haQuanto(email.enviadoEm) + ', sem sinal de entrega' });
  } else if (email && email.estado === 'sem_email') {
    chips.push({ tom: 'atencao', texto: 'Pedido sem e-mail válido' });
  } else if (pedido.status === 'pending') {
    chips.push({ tom: 'atencao', texto: 'Nenhum e-mail enviado' });
  }

  if (pedido.emAnalise) {
    chips.push({ tom: 'atencao', texto: 'Em análise de devolução (MED)' });
  }
  chips.push({ tom: '', texto: pedido.origem === 'anuncio' ? 'Veio de anúncio' : 'Entrou direto' });

  var aparelho = pedido.aparelho
    ? pedido.aparelho.so + ', ' + pedido.aparelho.nav + ' (' + pedido.aparelho.tipo + ')'
    : 'não registrado';

  var ligados = [pai].concat(filhos).filter(Boolean).map(function (outro) {
    return '<dt>' + escapar(outro.ofertaRotulo) + '</dt><dd>' + escapar(outro.valorFormatado) + ', ' +
      (pago(outro) ? 'pago' : 'aguardando') + '</dd>';
  }).join('');

  var html =
    '<div class="fundo-modal" id="fundoModal">' +
      '<div class="modal" role="dialog" aria-modal="true" aria-label="Detalhes do pedido">' +
        '<header>' +
          '<div><h2>' + escapar(pedido.cliente.nome) + '</h2>' +
          '<span class="id">#' + escapar(pedido.id) + '</span></div>' +
          '<span style="flex:1"></span>' + badgeStatus(pedido) +
          '<button class="botao-icone" id="fecharModal" aria-label="Fechar">X</button>' +
        '</header>' +
        '<div class="corpo">' +
          '<div class="chips-leitura">' + chips.map(function (c) {
            return '<span class="chip-leitura ' + c.tom + '">' + escapar(c.texto) + '</span>';
          }).join('') + '</div>' +

          '<div class="grupo"><h3>Pedido</h3><dl>' +
            '<dt>Criado</dt><dd>' + escapar(dataCompleta(pedido.criadoEm)) + '</dd>' +
            '<dt>Pago</dt><dd>' + escapar(pedido.pagoEm ? dataCompleta(pedido.pagoEm) : '-') + '</dd>' +
            '<dt>Oferta</dt><dd>' + escapar(pedido.itens.map(function (i) { return i.titulo; }).join(', ')) + '</dd>' +
            '<dt>Valor</dt><dd>' + escapar(pedido.valorFormatado) + '</dd>' +
            '<dt>Origem</dt><dd>' + (pedido.origem === 'anuncio' ? 'Anúncio' : 'Direto') + '</dd>' +
            '<dt>Aparelho</dt><dd>' + escapar(aparelho) + '</dd>' +
            '<dt>Situação no gateway</dt><dd>' + escapar(pedido.statusGateway || '-') + '</dd>' +
            '<dt>Cobrança</dt><dd>' + escapar(pedido.cobrancaId || '-') +
              '<div class="secundario">use este número para achar o pagamento no painel do gateway</div></dd>' +
          '</dl></div>' +

          (pago(pedido) ? '<div class="grupo"><h3>Entrega</h3><dl>' +
            '<dt>Aberturas</dt><dd>' + pedido.entregas.total + '</dd>' +
            '<dt>Última</dt><dd>' + escapar(pedido.entregas.ultimoEm ? dataCompleta(pedido.entregas.ultimoEm) : '-') + '</dd>' +
          '</dl></div>' : '') +

          '<div class="grupo"><h3>Cliente</h3><dl>' +
            '<dt>Nome</dt><dd>' + escapar(pedido.cliente.nome) + '</dd>' +
            '<dt>E-mail</dt><dd>' + escapar(pedido.cliente.email) + '</dd>' +
            '<dt>Telefone</dt><dd>' + escapar(telFmt(pedido.cliente.telefone)) + '</dd>' +
            '<dt>CPF</dt><dd>' + escapar(cpfFmt(pedido.cliente.cpf)) + '</dd>' +
          '</dl></div>' +

          (ligados ? '<div class="grupo"><h3>Compras ligadas</h3><dl>' + ligados + '</dl></div>' : '') +

          historicoDeMensagens(pedido) +

          '<div class="acoes-modal">' +
            (pago(pedido) ? '<button class="destaque" data-acao="link">Gerar link de entrega 72 h</button>' : '') +
            (pago(pedido) ? '<button data-acao="reenviar">Reenviar entrega</button>' : '') +
            (pago(pedido) ? '<button disabled title="Configure o envio de e-mail para usar isto">Reenviar e-mail</button>' : '') +
            '<a class="zap" id="zapModal" target="_blank" rel="noopener">WhatsApp</a>' +
            /*
             * "Copiar só o link" vem ANTES de "Copiar mensagem" porque é o caso
             * mais comum de verdade: o dono já abriu a conversa à mão, já falou
             * com a pessoa, e o que falta é o endereço de pagamento. A mensagem
             * inteira serve para quem ainda não disse nada.
             */
            (!pago(pedido) ? '<button class="destaque" id="copiarLink">Copiar só o link</button>' : '') +
            (!pago(pedido) ? '<button id="copiarCobranca">Copiar mensagem</button>' : '') +
            /*
             * O lembrete NAO COBRA: nao gera pagamento, nao aplica desconto e
             * nao mexe no status. So abre a conversa com o texto pronto.
             *
             * Fica LONGE de "Marcar como pago" e sem a classe `destaque`, que a
             * tela usa para as acoes de dinheiro. Dois botoes de aparencia igual
             * ao lado um do outro, um que so escreve e outro que confirma
             * pagamento, e um erro esperando o dedo errado num dia corrido.
             */
            (pedido.cabeLembrete ? '<button class="lembrete" data-acao="lembrete">Enviar lembrete no WhatsApp</button>' : '') +
            (pedido.status === 'pending' ? '<button data-acao="marcar">Marcar como pago</button>' : '') +
            '<button data-acao="copiar">Copiar pedido</button>' +
          '</div>' +
          /*
           * O link fica À VISTA depois de copiado, e não só na área de
           * transferência. Duas razões: o dono confere para onde está mandando a
           * pessoa antes de colar, e quando a cópia automática falha (acontece)
           * ele ainda tem o endereço na tela para selecionar à mão.
           *
           * Nasce escondido porque buscá-lo exige uma chamada que MARCA o pedido
           * como abordado — abrir o pedido para olhar não pode ter esse efeito.
           */
          '<div class="link-pagamento" id="areaLinkPagamento" hidden>' +
            '<label for="campoLinkPagamento">Link de pagamento deste pedido</label>' +
            '<input id="campoLinkPagamento" readonly spellcheck="false">' +
            '<p class="nota-link" id="notaLinkPagamento"></p>' +
          '</div>' +
          /*
           * O contador so aparece depois do primeiro envio. "Lembretes
           * enviados: 0" em todo pedido seria uma linha que nao informa nada e
           * que se aprende a nao ler -- e ai o numero deixa de ser visto
           * justamente quando passa de zero.
           */
          (pedido.lembretesEnviados > 0
            ? '<p class="nota-lembrete" id="notaLembrete">Lembretes enviados: ' + pedido.lembretesEnviados +
              (pedido.ultimoLembreteEm ? ' · último em ' + dataCompleta(pedido.ultimoLembreteEm) : '') + '</p>'
            : '<p class="nota-lembrete" id="notaLembrete" hidden></p>') +
          '<p class="nota-acao" id="notaAcao"></p>' +
        '</div>' +
      '</div>' +
    '</div>';

  var area = document.getElementById('areaModal');
  area.innerHTML = html;
  document.body.style.overflow = 'hidden';

  var zap = document.getElementById('zapModal');
  if (!digitos(pedido.cliente.telefone)) {
    zap.removeAttribute('href');
    zap.textContent = 'Sem telefone';
  } else if (pago(pedido)) {
    zap.href = linkZap(pedido, mensagemPago(pedido, ''));
  } else {
    /*
     * Quem não pagou recebe a mensagem COM o link de pagamento, montada pelo
     * servidor — por isso é clique com chamada, e não um href pronto.
     */
    zap.textContent = 'Cobrar no WhatsApp';
    zap.href = '#';
    zap.addEventListener('click', function (evento) {
      evento.preventDefault();
      chamarNoWhatsApp(pedido.id, function (texto) {
        document.getElementById('notaAcao').textContent = texto;
      });
    });
  }

  /*
   * "Copiar mensagem": o caminho que NÃO passa pela URL do wa.me.
   *
   * O botão de cima abre o WhatsApp com o texto dentro do endereço, e o handler
   * do WhatsApp no Windows corrompe qualquer caractere fora do ASCII nesse
   * trajeto — os emojis chegam como losango com interrogação, visto na tela do
   * dono em 14/08/2026 (e não era a primeira vez: já se tinha trocado os emojis
   * por versões "simples" achando que era o caractere, e quebrou igual). O
   * clipboard leva o texto em UTF-16 nativo e entrega inteiro, sempre.
   *
   * O fluxo do dono passa a ser: Copiar mensagem → abrir a conversa → colar.
   * Um passo a mais, emoji inteiro em todos.
   */
  var copiarCobranca = document.getElementById('copiarCobranca');
  if (copiarCobranca) {
    copiarCobranca.addEventListener('click', function () {
      copiarCobranca.disabled = true;
      copiarCobranca.textContent = 'Buscando...';
      api('/admin/pedidos/' + pedido.id + '/whatsapp', { method: 'POST' })
        .then(function (dados) {
          return navigator.clipboard.writeText(dados.mensagem).then(function () {
            copiarCobranca.textContent = 'Copiada!';
            document.getElementById('notaAcao').textContent = dados.comDesconto
              ? 'Mensagem com a oferta de R$ 27,99 copiada. Cole na conversa do WhatsApp.'
              : 'Mensagem de preço cheio copiada. Cole na conversa do WhatsApp.';
          });
        })
        .catch(function (falha) {
          copiarCobranca.textContent = 'Copiar mensagem';
          document.getElementById('notaAcao').textContent = falha.message;
        })
        .finally(function () {
          copiarCobranca.disabled = false;
          setTimeout(function () { copiarCobranca.textContent = 'Copiar mensagem'; }, 4000);
        });
    });
  }

  /*
   * "Copiar só o link": o endereço de pagamento, sem texto em volta.
   *
   * Serve à conversa que JÁ existe. O dono pergunta "posso mandar o link do
   * pix?", a pessoa responde que sim, e a essa altura colar a mensagem pronta
   * repetiria o que ele acabou de escrever — depois de a pessoa ter respondido a
   * um ser humano. Aqui vai só o endereço.
   *
   * É a MESMA rota do botão de mensagem, de propósito: quem assina o link é o
   * servidor (a chave mestra não sai de lá) e a escolha entre preço cheio e
   * desconto é regra de negócio. O efeito de marcar o pedido como abordado
   * também é o mesmo, e correto — copiar o link é o passo imediatamente anterior
   * a enviá-lo.
   */
  var copiarLink = document.getElementById('copiarLink');
  if (copiarLink) {
    copiarLink.addEventListener('click', function () {
      var rotulo = 'Copiar só o link';
      copiarLink.disabled = true;
      copiarLink.textContent = 'Gerando...';
      api('/admin/pedidos/' + pedido.id + '/whatsapp', { method: 'POST' })
        .then(function (dados) {
          var campo = document.getElementById('campoLinkPagamento');
          var nota = document.getElementById('notaLinkPagamento');
          campo.value = dados.linkPagamento;
          document.getElementById('areaLinkPagamento').hidden = false;

          /*
           * O preço e o prazo, escritos. A pergunta "por que saiu R$ 74 e não
           * R$ 27,99?" já custou uma tarde ao dono, e a resposta é uma data: nas
           * primeiras 48 h a cobrança é cheia, por decisão dele.
           */
          nota.textContent = dados.comDesconto
            ? 'Oferta de recuperação — R$ 27,99. Link válido até ' + dataCompleta(dados.linkExpiraEm) + '.'
            : 'Preço cheio — ' + dados.valorFormatado + '. O desconto de R$ 27,99 só entra em '
              + dataCompleta(dados.descontoLiberadoEm) + '. Link válido até ' + dataCompleta(dados.linkExpiraEm) + '.';

          // Selecionado: se a cópia automática falhar, o dono ainda copia à mão.
          campo.focus();
          campo.select();

          return navigator.clipboard.writeText(dados.linkPagamento).then(function () {
            copiarLink.textContent = 'Link copiado!';
            document.getElementById('notaAcao').textContent = 'Link copiado. Cole na conversa que você já abriu.';
          }, function () {
            // Cópia recusada pelo navegador: o link está na tela e selecionado.
            copiarLink.textContent = rotulo;
            document.getElementById('notaAcao').textContent =
              'Não deu para copiar sozinho. O link está aí em cima, já selecionado — use Ctrl+C.';
          });
        })
        .catch(function (falha) {
          copiarLink.textContent = rotulo;
          document.getElementById('notaAcao').textContent = falha.message;
        })
        .finally(function () {
          copiarLink.disabled = false;
          setTimeout(function () { copiarLink.textContent = rotulo; }, 4000);
        });
    });
  }

  document.getElementById('fecharModal').addEventListener('click', fecharModal);
  document.getElementById('fundoModal').addEventListener('click', function (evento) {
    if (evento.target.id === 'fundoModal') fecharModal();
  });

  Array.prototype.forEach.call(area.querySelectorAll('[data-acao]'), function (botao) {
    botao.addEventListener('click', function () { acaoDoModal(botao, pedido); });
  });
}

/*
 * Tudo que já foi dito a esta PESSOA, e não só neste pedido.
 *
 * Junta as mensagens de todos os pedidos do mesmo e-mail porque é assim que a
 * pergunta nasce na cabeça de quem opera: "o que essa mulher já recebeu da
 * gente?". Ela pode ter três pedidos parados e ter ouvido três coisas
 * diferentes — e é o conjunto que diz se cabe mandar mais uma.
 *
 * O QUE ISTO EVITA: oferecer a promoção de R$ 27,99 a quem recebeu o lembrete
 * de preço cheio há duas horas. Quem vê os dois aprende que basta esperar para
 * o preço cair, e passa a esperar sempre.
 */
function historicoDeMensagens(pedido) {
  var email = (pedido.cliente.email || '').toLowerCase();
  if (!email) return '';

  var mensagens = [];
  estado.pedidos.forEach(function (p) {
    if ((p.cliente.email || '').toLowerCase() !== email) return;
    (p.mensagens || []).forEach(function (m) { mensagens.push(m); });
  });

  if (mensagens.length === 0) {
    return '<div class="grupo"><h3>Mensagens enviadas</h3>' +
      '<p class="secundario" style="margin:6px 0 0">Nenhuma mensagem foi enviada para esta pessoa ainda.</p></div>';
  }

  mensagens.sort(function (a, b) { return (b.enviadoEm || '').localeCompare(a.enviadoEm || ''); });

  var linhas = mensagens.map(function (m) {
    /*
     * O estado é contado do sinal mais forte para o mais fraco: clicou vence
     * leu, que vence entregue. É a ordem em que eles valem dinheiro.
     */
    var estado_ = m.clicouEm ? '<span class="badge pago">clicou</span>'
      : m.abertoEm ? '<span class="badge pago">leu' + (m.aberturas > 1 ? ' ' + m.aberturas + '×' : '') + '</span>'
      : m.entregueEm ? '<span class="badge aguardando">entregue</span>'
      : '<span class="badge morto">sem sinal</span>';

    return '<li><span style="flex:1"><strong>' + escapar(m.rotulo) + '</strong>' +
      '<div class="secundario">' + escapar(dataCurta(m.enviadoEm)) + '</div></span>' + estado_ + '</li>';
  }).join('');

  return '<div class="grupo"><h3>Mensagens enviadas (' + mensagens.length + ')</h3>' +
    '<ul class="lista-abandono">' + linhas + '</ul></div>';
}

function fecharModal() {
  document.getElementById('areaModal').innerHTML = '';
  document.body.style.overflow = '';
}

function trocarRotulo(botao, texto, milissegundos) {
  var original = botao.textContent;
  botao.textContent = texto;
  setTimeout(function () { botao.textContent = original; }, milissegundos || 2500);
}

function acaoDoModal(botao, pedido) {
  var nota = document.getElementById('notaAcao');

  if (botao.dataset.acao === 'link') {
    botao.disabled = true;
    api('/admin/pedidos/' + pedido.id + '/link', { method: 'POST' })
      .then(function (dados) {
        return copiar(dados.url).then(function () {
          trocarRotulo(botao, 'Link copiado!', 3000);
          nota.textContent = dados.url;
        });
      })
      .catch(function (falha) { nota.textContent = falha.message; })
      .finally(function () { botao.disabled = false; });
    return;
  }

  if (botao.dataset.acao === 'lembrete') {
    /*
     * A janela e aberta ANTES da chamada, e nao depois.
     *
     * `window.open` fora do gesto do usuario e bloqueado como pop-up por todo
     * navegador. Abrir vazia agora e so trocar o endereco quando a resposta
     * chega e o mesmo caminho que `chamarNoWhatsApp` ja usa, e e o que faz o
     * botao funcionar no celular do dono.
     */
    var janela = window.open('', '_blank');
    botao.disabled = true;
    var rotuloAntigo = botao.textContent;
    botao.textContent = 'Abrindo...';

    api('/admin/pedidos/' + pedido.id + '/lembrete-whatsapp', { method: 'POST' })
      .then(function (dados) {
        if (janela) janela.location.href = dados.url;
        else window.location.href = dados.url;

        var contador = document.getElementById('notaLembrete');
        if (contador) {
          contador.hidden = false;
          contador.textContent = 'Lembretes enviados: ' + dados.lembretesEnviados +
            (dados.registrado ? '' : ' (este nao ficou registrado)');
        }
        /*
         * A lista se refaz para o contador valer tambem fora do modal. NAO
         * fecha o modal: o dono acabou de mandar e costuma querer conferir o
         * telefone ou copiar o link em seguida.
         */
        return carregar();
      })
      .catch(function (falha) {
        if (janela) janela.close();
        nota.textContent = falha.message;
      })
      .finally(function () {
        botao.disabled = false;
        botao.textContent = rotuloAntigo;
      });
    return;
  }

  if (botao.dataset.acao === 'marcar') {
    if (!confirm('Marcar como pago? Use apenas se você confirmou o pagamento no gateway.')) return;
    botao.disabled = true;
    botao.textContent = 'Marcando...';
    api('/admin/pedidos/' + pedido.id + '/marcar-pago', { method: 'POST' })
      .then(function () { fecharModal(); return carregar(); })
      .catch(function (falha) {
        nota.textContent = falha.message;
        botao.disabled = false;
        botao.textContent = 'Marcar como pago';
      });
    return;
  }

  if (botao.dataset.acao === 'reenviar') {
    botao.disabled = true;
    botao.textContent = 'Preparando...';
    api('/admin/pedidos/' + pedido.id + '/reenviar-entrega', { method: 'POST' })
      .then(function (dados) {
        return copiar(dados.url).then(function () {
          trocarRotulo(botao, 'Link copiado!', 3000);
          var texto = 'Link de ' + dados.horas + ' h copiado. Itens: ' +
            dados.itens.map(function (i) { return i.titulo; }).join(', ') + '.';
          // O dono precisa saber ANTES de mandar que o cliente vai receber vazio.
          if (dados.avisoSemLink.length > 0) {
            nota.innerHTML = escapar(texto) + ' <strong style="color:var(--erro)">Atenção: ' +
              escapar(dados.avisoSemLink.join(', ')) +
              ' ainda está sem link e vai chegar vazio. Configure na aba Entregas antes de enviar.</strong>';
          } else {
            nota.textContent = texto;
          }
          var zap = document.getElementById('zapModal');
          if (zap && zap.href) zap.href = linkZap(pedido, mensagemPago(pedido, dados.url)) || zap.href;
        });
      })
      .catch(function (falha) { nota.textContent = falha.message; })
      .finally(function () {
        botao.disabled = false;
        setTimeout(function () { botao.textContent = 'Reenviar entrega'; }, 3000);
      });
    return;
  }

  if (botao.dataset.acao === 'copiar') {
    copiar(textoDoPedido(pedido)).then(function () { trocarRotulo(botao, 'Copiado!'); });
  }
}

function textoDoPedido(pedido) {
  return [
    'PEDIDO',
    'ID: ' + pedido.id,
    'Situação: ' + (pago(pedido) ? 'Pago' : 'Aguardando'),
    'Criado: ' + dataCompleta(pedido.criadoEm),
    'Pago: ' + (pedido.pagoEm ? dataCompleta(pedido.pagoEm) : '-'),
    'Valor: ' + pedido.valorFormatado,
    '',
    'CLIENTE',
    'Nome: ' + pedido.cliente.nome,
    'E-mail: ' + pedido.cliente.email,
    'Telefone: ' + digitos(pedido.cliente.telefone),
    'CPF: ' + digitos(pedido.cliente.cpf),
    '',
    'OFERTAS',
  ].concat(pedido.itens.map(function (item) {
    return '- ' + item.titulo + ' (' + brl(item.valor) + ')';
  })).join('\n');
}

function copiar(texto) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(texto);
  }
  return new Promise(function (resolver) {
    var area = document.createElement('textarea');
    area.value = texto;
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); } catch (e) { /* ignora */ }
    document.body.removeChild(area);
    resolver();
  });
}


/* ------------------------------------------------------------- Entregas -- */

function carregarEntregas() {
  return api('/admin/entregas?t=' + Date.now())
    .then(function (dados) {
      estado.entregas = dados.entregas;
      estado.historicoEntregas = dados.historico || [];
      estado.tiposEntrega = dados.tipos || [];
      desenharEntregas();
    })
    .catch(function (falha) {
      document.getElementById('resumoEntregas').textContent = falha.message;
    });
}

function desenharEntregas() {
  var lista = estado.entregas || [];
  var alvo = document.getElementById('listaEntregas');
  var resumo = document.getElementById('resumoEntregas');

  var faltando = lista.filter(function (e) { return e.ativo && !e.url && e.tipo !== 'servico'; });

  if (faltando.length > 0) {
    resumo.innerHTML = '<strong style="color:var(--erro)">' + faltando.length +
      (faltando.length === 1 ? ' produto ativo esta sem link' : ' produtos ativos estao sem link') +
      '.</strong> Quem pagar por ' + (faltando.length === 1 ? 'ele' : 'eles') +
      ' nao recebe nada. O que voce salvar aqui vale na hora, sem publicar de novo.';
  } else {
    resumo.textContent = 'Todos os produtos ativos tem entrega configurada. ' +
      'O que voce salvar aqui vale na hora, sem publicar de novo.';
  }

  alvo.innerHTML = lista.map(cartaoDeEntrega).join('');

  Array.prototype.forEach.call(alvo.querySelectorAll('[data-salvar]'), function (botao) {
    botao.addEventListener('click', function () { salvarEntrega(botao.dataset.salvar, botao); });
  });
  Array.prototype.forEach.call(alvo.querySelectorAll('[data-testar]'), function (botao) {
    botao.addEventListener('click', function () { testarEntrega(botao.dataset.testar, botao); });
  });

  desenharHistoricoEntregas();
}

function cartaoDeEntrega(entrega) {
  var semLink = entrega.ativo && !entrega.url && entrega.tipo !== 'servico';
  var classes = 'cartao-entrega' + (semLink ? ' sem-link' : '') + (entrega.ativo ? '' : ' inativo');

  var opcoes = estado.tiposEntrega.map(function (tipo) {
    return '<option value="' + escapar(tipo.valor) + '"' +
      (tipo.valor === entrega.tipo ? ' selected' : '') + '>' + escapar(tipo.rotulo) + '</option>';
  }).join('');

  var aviso = '';
  if (semLink) {
    aviso = '<p class="alerta-sem-link">Sem link: quem pagar nao recebe este produto.</p>';
  } else if (entrega.tipo === 'servico') {
    aviso = '<p class="aviso-servico">Servico: a confirmacao e a entrega, nao precisa de link.</p>';
  }

  var origem = entrega.origem === 'painel' ? 'valor definido aqui no painel'
    : entrega.origem === 'ambiente' ? 'valor herdado da variavel de ambiente, salve para trazer para o painel'
    : 'nenhum valor definido';

  var alterado = entrega.atualizadoEm
    ? 'alterado ' + haQuanto(entrega.atualizadoEm) + ' por ' + escapar(entrega.atualizadoPor || 'alguem')
    : 'nunca alterado pelo painel';

  return '<article class="' + classes + '" data-item="' + escapar(entrega.itemId) + '">' +
    '<header><div style="flex:1">' +
      '<h3>' + escapar(entrega.nome) + '</h3>' +
      '<span class="id-produto">' + escapar(entrega.itemId) + '</span>' +
    '</div>' +
    '<label style="display:flex;gap:5px;align-items:center;font-size:.78rem;white-space:nowrap">' +
      '<input type="checkbox" data-campo="ativo" style="width:auto"' + (entrega.ativo ? ' checked' : '') + '> Ativo' +
    '</label></header>' +

    aviso +

    '<div class="campo"><label>Nome mostrado ao cliente</label>' +
      '<input type="text" data-campo="nome" value="' + escapar(entrega.nome) + '" maxlength="160"></div>' +

    '<div class="campo"><label>Link de entrega</label>' +
      '<input type="text" data-campo="url" value="' + escapar(entrega.url) +
      '" placeholder="https://..." spellcheck="false"></div>' +

    '<div class="campo"><label>Tipo de produto</label>' +
      '<div class="linha"><select data-campo="tipo">' + opcoes + '</select>' +
      '<button class="botao-icone" data-testar="' + escapar(entrega.itemId) + '">Testar link</button>' +
      '<button class="botao-principal" style="width:auto;margin:0;padding:8px 16px" data-salvar="' +
        escapar(entrega.itemId) + '">Salvar</button></div></div>' +

    '<p class="resultado-teste" data-resultado></p>' +
    '<p class="origem-valor">' + escapar(origem) + ' | ' + alterado + '</p>' +
  '</article>';
}

function lerCartao(itemId) {
  var cartao = document.querySelector('[data-item="' + itemId + '"]');
  if (!cartao) return null;
  return {
    nome: cartao.querySelector('[data-campo="nome"]').value.trim(),
    url: cartao.querySelector('[data-campo="url"]').value.trim(),
    ativo: cartao.querySelector('[data-campo="ativo"]').checked,
    tipo: cartao.querySelector('[data-campo="tipo"]').value,
  };
}

function salvarEntrega(itemId, botao) {
  var valores = lerCartao(itemId);
  if (!valores) return;

  var nota = document.querySelector('[data-item="' + itemId + '"] [data-resultado]');
  botao.disabled = true;
  botao.textContent = 'Salvando...';

  api('/admin/entregas/' + encodeURIComponent(itemId), { method: 'POST', body: valores })
    .then(function () {
      botao.textContent = 'Salvo!';
      nota.textContent = '';
      nota.className = 'resultado-teste';
      return carregarEntregas();
    })
    .catch(function (falha) {
      nota.textContent = falha.message;
      nota.className = 'resultado-teste falhou';
    })
    .finally(function () {
      setTimeout(function () { botao.disabled = false; botao.textContent = 'Salvar'; }, 1800);
    });
}

function testarEntrega(itemId, botao) {
  var nota = document.querySelector('[data-item="' + itemId + '"] [data-resultado]');
  botao.disabled = true;
  botao.textContent = 'Testando...';

  api('/admin/entregas/' + encodeURIComponent(itemId) + '/testar', { method: 'POST' })
    .then(function (r) {
      nota.textContent = r.mensagem + ' (' + r.levouMs + ' ms)';
      nota.className = 'resultado-teste ' + (r.ok ? 'ok' : 'falhou');
    })
    .catch(function (falha) {
      nota.textContent = falha.message;
      nota.className = 'resultado-teste falhou';
    })
    .finally(function () {
      botao.disabled = false;
      botao.textContent = 'Testar link';
    });
}

var ROTULO_CAMPO = { url: 'link', nome: 'nome', ativo: 'situacao', tipo: 'tipo' };

function encurtarTexto(texto) {
  var t = String(texto || '');
  return t.length > 46 ? t.slice(0, 46) + '...' : t;
}

function desenharHistoricoEntregas() {
  var alvo = document.getElementById('historicoEntregas');
  var lista = estado.historicoEntregas || [];

  if (lista.length === 0) {
    alvo.innerHTML = '<p class="rodape">Nenhuma alteracao ainda. ' +
      'Toda mudanca de link fica registrada aqui, com data e autor.</p>';
    return;
  }

  alvo.innerHTML = '<ul class="historico-lista">' + lista.slice(0, 60).map(function (m) {
    var de = m.campo === 'ativo' ? (m.de === 'true' ? 'ativo' : 'inativo') : (m.de || 'vazio');
    var para = m.campo === 'ativo' ? (m.para === 'true' ? 'ativo' : 'inativo') : (m.para || 'vazio');
    return '<li><span class="quando">' + escapar(dataCurta(m.t)) + '</span>' +
      '<span><strong>' + escapar(m.itemId) + '</strong> ' + escapar(ROTULO_CAMPO[m.campo] || m.campo) + '</span>' +
      '<span class="de-para">' + escapar(encurtarTexto(de)) + ' para ' + escapar(encurtarTexto(para)) + '</span>' +
      '<span class="quando">' + escapar(m.por) + '</span></li>';
  }).join('') + '</ul>';
}

/* ------------------------------------------------------------- Webhooks -- */

function carregarWebhooks() {
  return api('/admin/webhooks?t=' + Date.now())
    .then(function (dados) {
      estado.webhooks = dados.recebidos || [];
      desenharWebhooks();
    })
    .catch(function (falha) {
      document.getElementById('resumoWebhooks').textContent = falha.message;
    });
}

function desenharWebhooks() {
  var todos = estado.webhooks || [];
  var lista = estado.filtroWebhook === 'todos'
    ? todos
    : todos.filter(function (w) { return w.resultado === estado.filtroWebhook; });

  var erros = todos.filter(function (w) { return w.resultado === 'erro'; }).length;
  var resumo = document.getElementById('resumoWebhooks');

  if (todos.length === 0) {
    resumo.textContent = 'Nenhum aviso recebido ainda. ' +
      'Quando o gateway avisar sobre um pagamento, ele aparece aqui.';
  } else if (erros > 0) {
    resumo.innerHTML = todos.length + ' avisos recebidos. <strong style="color:var(--erro)">' + erros +
      ' com erro</strong>, vale conferir os pedidos envolvidos.';
  } else {
    resumo.textContent = todos.length + ' avisos recebidos, nenhum com erro.';
  }

  var corpo = document.getElementById('corpoWebhooks');
  if (lista.length === 0) {
    corpo.innerHTML = '<tr><td colspan="7"><p class="vazio">Nada neste filtro.</p></td></tr>';
    return;
  }

  corpo.innerHTML = lista.map(function (w) {
    return '<tr>' +
      '<td data-rotulo="Quando">' + escapar(dataCurta(w.t)) + '</td>' +
      '<td data-rotulo="Evento">' + escapar(w.evento || '-') + '</td>' +
      '<td data-rotulo="Cobranca" class="num">' + escapar(w.cobrancaId || '-') + '</td>' +
      '<td data-rotulo="Pedido" class="num">' + escapar(w.pedidoId ? w.pedidoId.slice(0, 8) : '-') + '</td>' +
      '<td data-rotulo="Informado">' + escapar(w.statusInformado || '-') + '</td>' +
      '<td data-rotulo="Confirmado"><strong>' + escapar(w.statusConfirmado || '-') + '</strong></td>' +
      '<td data-rotulo="Resultado"><span class="badge ' + escapar(w.resultado) + '">' + escapar(w.resultado) + '</span>' +
        (w.detalhe ? '<div class="secundario">' + escapar(w.detalhe) + '</div>' : '') + '</td>' +
    '</tr>';
  }).join('');
}

/* ----------------------------------------------------------- Pagamentos -- */

function desenharPagamentos() {
  var alvo = document.getElementById('painelPagamentos');
  if (!estado.meta) { alvo.innerHTML = ''; return; }

  var consultas = estado.meta.consultas || { count: 0, budget: 0 };
  var usado = consultas.budget > 0 ? consultas.count / consultas.budget : 0;
  var pagos = estado.pedidos.filter(pago).length;
  var criados = estado.pedidos.filter(ehPrincipal).length;

  alvo.innerHTML = '<h2>Saúde do Pix</h2>' +
    '<div class="grupo"><dl>' +
      '<dt>Cobranças</dt><dd>' + (estado.meta.modo === 'mock'
        ? '<strong style="color:var(--erro)">MODO DE TESTE, nada é cobrado de verdade</strong>'
        : 'Reais (produção)') + '</dd>' +
      '<dt>Armazenamento</dt><dd>' + (estado.meta.armazenamento === 'postgres'
        ? 'Banco de dados'
        : '<strong style="color:var(--erro)">Arquivo local, os pedidos somem no próximo deploy</strong>') + '</dd>' +
      '<dt>Consultas hoje</dt><dd>' + consultas.count + ' de ' + consultas.budget +
        (usado > 0.8 ? ' <strong style="color:var(--alerta)">(perto do limite diário)</strong>' : '') + '</dd>' +
      '<dt>Pedidos pagos</dt><dd>' + pagos + ' de ' + criados + ' pedidos principais</dd>' +
    '</dl></div>' +
    '<p class="rodape">A conversão por dia e o histórico de falhas entram na próxima etapa da construção.</p>';
}

/* ----------------------------------------------------------------- UI --- */

function marcarChips() {
  Array.prototype.forEach.call(document.querySelectorAll('#chipsPeriodo button'), function (botao) {
    botao.setAttribute('aria-pressed', String(Number(botao.dataset.dias) === estado.dias));
  });
}

/* ------------------------------------------------------------ Anúncios -- */

/*
 * Qual campanha, qual conjunto e qual anúncio trouxeram dinheiro.
 *
 * As primeiras colunas (visitas, quiz, VSL, checkout) vêm dos eventos do funil:
 * são elas que mostram quem chegou e NÃO comprou, que é justamente quem o
 * pedido nunca registra. Vendas e receita vêm dos pedidos, porque o pagamento
 * é confirmado pelo servidor e sobrevive ao cliente fechar a aba para pagar no
 * banco.
 */

/**
 * Lê o valor composto do seletor de período: "7|hoje", "1|ontem".
 *
 * O fim da janela viaja junto com o tamanho porque "Ontem" não é um número de
 * dias — é um dia fechado. Guardar só o número faria Hoje e Ontem virarem a
 * mesma coisa (dias = 1) e o painel mostraria um no lugar do outro.
 */
function lerPeriodo(valor) {
  var partes = String(valor || '7|hoje').split('|');
  var dias = Number(partes[0]);
  return {
    dias: isFinite(dias) && dias > 0 ? dias : 7,
    ate: partes[1] === 'ontem' ? 'ontem' : 'hoje'
  };
}

function carregarAnuncios() {
  var caminho = '/admin/anuncios?dias=' + estado.diasAnuncios +
    '&ate=' + estado.ateAnuncios +
    '&agrupamento=' + estado.agrupamento +
    /* A BM vai ao SERVIDOR porque ela filtra visita e venda no banco. O
       filtro de retorno nao vai: ele e recorte sobre linhas ja carregadas, e
       mandar ao servidor custaria uma ida a rede por clique sem mudar numero
       nenhum. */
    (estado.bmAnuncios ? '&bm=' + encodeURIComponent(estado.bmAnuncios) : '') +
    '&t=' + Date.now();

  return api(caminho)
    .then(function (dados) {
      estado.anuncios = dados;

      // Não sobrescreve enquanto o dono digita: recarregar a tabela no meio da
      // edição apagaria o número que ele acabou de escrever.
      var campoMeta = document.getElementById('campoMetaRoas');
      if (campoMeta && document.activeElement !== campoMeta) {
        campoMeta.value = String(dados.metaRoas).replace('.', ',');
      }

      desenharAnuncios();
    })
    .catch(function (falha) {
      document.getElementById('resumoAnuncios').textContent = falha.message;
    });
}

function carregarMeta() {
  return api('/admin/meta?t=' + Date.now())
    .then(function (dados) {
      estado.meta = dados;
      desenharMeta();
    })
    .catch(function () { /* o diagnóstico é acessório: a tabela acima é o que importa */ });
}

/** Nome que o dono reconhece. O ID sozinho não diz nada para ninguém. */
function rotuloDoAnuncio(linha) {
  if (linha.rotulo) return linha.rotulo;
  if (linha.chave) return linha.chave;
  return '(sem origem)';
}

/* ------------------------------------------------- Formato das medidas -- */

/*
 * Nada aqui inventa número quando não há base.
 *
 * O servidor manda `null` para toda conta que dependeria de dividir por zero, e
 * estas funções mostram "—". Escrever "R$ 0,00" num CPA sem venda nenhuma faria
 * o anúncio mais caro da conta parecer o mais barato.
 */
function vazio() { return '<span class="sem-base">—</span>'; }

function moeda(centavos) {
  return centavos === null || centavos === undefined ? vazio() : brl(centavos);
}

function porcento(valor) {
  return valor === null || valor === undefined ? vazio() : pct(valor);
}

function vezes(valor) {
  if (valor === null || valor === undefined) return vazio();
  return valor.toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + 'x';
}

function inteiro(valor) {
  return (valor || 0).toLocaleString('pt-BR');
}

/**
 * Conjuntos de colunas, no espírito do Gerenciador de Anúncios.
 *
 * Doze colunas numa tela de celular não são doze informações, são zero: nada
 * cabe e tudo vira rolagem lateral. Três conjuntos respondem três perguntas
 * diferentes — "estou lucrando?", "o anúncio está sendo clicado?", "onde as
 * pessoas desistem?" — e cada uma tem a sua hora.
 */
var COLUNAS = {
  resultado: [
    { chave: 'investimentoCentavos', titulo: 'Investido', formato: moeda, anota: 'valor' },
    { chave: 'receitaCentavos', titulo: 'Receita', formato: moeda },
    { chave: 'lucroCentavos', titulo: 'Lucro', formato: moeda, sinal: true },
    { chave: 'roas', titulo: 'ROAS', formato: vezes, semaforo: true },
    { chave: 'vendas', titulo: 'Vendas', formato: inteiro, forte: true },
    { chave: 'cpaCentavos', titulo: 'Custo/venda', formato: moeda },
    { chave: 'ticketCentavos', titulo: 'Ticket', formato: moeda },
    { chave: 'margem', titulo: 'Margem', formato: porcento, sinal: true },
  ],
  trafego: [
    { chave: 'investimentoCentavos', titulo: 'Investido', formato: moeda, anota: 'valor' },
    { chave: 'impressoes', titulo: 'Impressões', formato: inteiro, anota: 'impressoes' },
    { chave: 'cliques', titulo: 'Cliques', formato: inteiro, anota: 'cliques' },
    { chave: 'ctr', titulo: 'CTR', formato: porcento },
    { chave: 'cpcCentavos', titulo: 'CPC', formato: moeda },
    { chave: 'cpmCentavos', titulo: 'CPM', formato: moeda },
    { chave: 'visitas', titulo: 'Visitas', formato: inteiro },
    { chave: 'custoPorVisitaCentavos', titulo: 'Custo/visita', formato: moeda },
  ],
  funil: [
    { chave: 'visitas', titulo: 'Visitas', formato: inteiro },
    { chave: 'quiz', titulo: 'Quiz', formato: inteiro, passagem: 'visitas' },
    { chave: 'vsl', titulo: 'VSL', formato: inteiro, passagem: 'quiz' },
    { chave: 'checkout', titulo: 'Checkout', formato: inteiro, passagem: 'vsl' },
    { chave: 'pixGerados', titulo: 'Pix', formato: inteiro, passagem: 'checkout' },
    { chave: 'vendas', titulo: 'Vendas', formato: inteiro, passagem: 'pixGerados', forte: true },
    { chave: 'conversao', titulo: 'Visita→venda', formato: porcento },
  ],
};

/**
 * Os oito números que respondem "posso aumentar o investimento?".
 *
 * `bomSubir: null` para o investido de propósito: gastar mais não é bom nem
 * ruim por si só — pintar de verde faria a tela parabenizar quem só torrou
 * orçamento. O que decide é o ROAS logo ao lado.
 */
var KPIS_DE_ANUNCIO = [
  { chave: 'investimentoCentavos', rotulo: 'Investido', formato: moeda, bomSubir: null },
  { chave: 'receitaCentavos', rotulo: 'Receita', formato: moeda, bomSubir: true },
  { chave: 'lucroCentavos', rotulo: 'Lucro', formato: moeda, bomSubir: true },
  { chave: 'roas', rotulo: 'ROAS', formato: vezes, bomSubir: true, semaforo: true },
  { chave: 'vendas', rotulo: 'Vendas', formato: inteiro, bomSubir: true },
  { chave: 'cpaCentavos', rotulo: 'Custo por venda', formato: moeda, bomSubir: false },
  { chave: 'ticketCentavos', rotulo: 'Ticket médio', formato: moeda, bomSubir: true },
  { chave: 'ctr', rotulo: 'CTR', formato: porcento, bomSubir: true },
];

/** Verde passou da meta, amarelo pagou o próprio custo, vermelho deu prejuízo. */
function classeDoRoas(roas, metaRoas) {
  if (roas === null || roas === undefined) return '';
  if (roas >= metaRoas) return 'sobe';
  if (roas >= 1) return 'atencao';
  return 'desce';
}


/*
 * Os chips de BM da aba Anuncios.
 *
 * Desenhados a partir do que o servidor achou no periodo, e nao de uma lista
 * fixa: BM nova aparece sozinha assim que a primeira visita dela chega, e BM
 * que parou continua aparecendo enquanto houver dado na janela -- que e quando
 * ainda se quer compara-la com as outras.
 *
 * Some inteiro quando so existe uma BM (ou nenhuma). Um seletor com uma opcao
 * so nao e escolha, e ocupa a mesma linha que os filtros que importam.
 */
function desenharChipsDeBm(dados) {
  var caixa = document.getElementById('chipsBm');
  if (!caixa) return;

  var lista = dados.bmsDisponiveis || [];
  if (lista.length < 2) {
    caixa.innerHTML = '';
    caixa.hidden = true;
    return;
  }
  caixa.hidden = false;

  var html = '<button data-bm="" aria-pressed="' + (estado.bmAnuncios === '' ? 'true' : 'false') +
    '">Todas as BMs</button>';
  lista.forEach(function (nome) {
    html += '<button data-bm="' + escapar(nome) + '" aria-pressed="' +
      (estado.bmAnuncios === nome ? 'true' : 'false') + '">' + escapar(nome) + '</button>';
  });
  caixa.innerHTML = html;
}

function desenharAnuncios() {
  var dados = estado.anuncios;
  var corpo = document.getElementById('corpoAnuncios');
  var resumo = document.getElementById('resumoAnuncios');
  if (!dados) return;

  Array.prototype.forEach.call(document.querySelectorAll('#chipsAnuncios button'), function (botao) {
    botao.setAttribute('aria-pressed', String(botao.dataset.agrupamento === estado.agrupamento));
  });

  // Antes de qualquer número: o rastreamento está ligado? Uma tabela vazia com
  // o Pixel desligado parece "não vendi nada", e é outra coisa.
  var avisos = [];
  if (!dados.rastreamento.pixelConfigurado) {
    avisos.push('O Pixel do Facebook ainda não foi configurado: nenhuma origem está sendo registrada.');
  } else if (!dados.rastreamento.capiAtiva) {
    avisos.push('Falta o token da API de Conversões: as compras não estão sendo enviadas ao Facebook.');
  }
  if (dados.rastreamento.modoTeste) {
    avisos.push('Modo de teste ligado: os eventos NÃO contam como conversão real.');
  }

  /*
   * A pergunta que esta tela mais recebe e' "publiquei o anuncio e nao aparece
   * nada". Sao duas causas MUITO diferentes e a tabela sozinha nao separa:
   *
   *  - ninguem clicou ainda (anuncio em analise, ou sem entrega);
   *  - gente chegou, mas SEM os parametros de URL, entao nao da para saber de
   *    qual anuncio veio -- e tudo cai numa linha unica "(sem origem)".
   *
   * A segunda e' erro de configuracao e some sozinha em minutos assim que os
   * parametros forem colados; a primeira e' so esperar. Dizer qual das duas e'
   * o unico jeito de o dono nao ficar procurando defeito onde nao ha.
   */
  var visitasIdentificadas = 0;
  var visitasSemOrigem = 0;
  dados.linhas.forEach(function (linha) {
    if (linha.chave) visitasIdentificadas += linha.visitas;
    else visitasSemOrigem += linha.visitas;
  });

  if (visitasSemOrigem > 0 && visitasIdentificadas === 0) {
    avisos.push(
      visitasSemOrigem + ' visita(s) chegaram SEM identificação de anúncio. Se você já publicou e o anúncio ' +
      'está entregando, provavelmente faltou colar os parâmetros de URL no anúncio — o campo está logo abaixo, ' +
      'em "Parâmetros para colar no anúncio". Sem eles a plataforma não diz de onde veio o clique.'
    );
  }

  desenharChipsDeBm(dados);
  desenharKpisAnuncios(dados);

  var colunas = COLUNAS[estado.colunasAnuncios] || COLUNAS.resultado;
  var cabecalho = document.getElementById('cabecalhoAnuncios');
  var rodape = document.getElementById('rodapeAnuncios');

  cabecalho.innerHTML = '<th>' + rotuloDoAgrupamento() + '</th>' +
    colunas.map(function (coluna) { return '<th class="num">' + escapar(coluna.titulo) + '</th>'; }).join('');

  if (!dados.linhas.length) {
    corpo.innerHTML = '<tr><td colspan="' + (colunas.length + 1) + '" class="vazio">' +
      'Nenhuma visita registrada neste período.</td></tr>';
    rodape.innerHTML = '';
    // Sem nenhuma visita, o problema nao e' de parametro: e' que ninguem entrou.
    // Anuncio recem-publicado fica em analise antes de comecar a entregar.
    resumo.innerHTML = 'Ninguém entrou no site neste período. Anúncio recém-publicado costuma ficar em análise ' +
      'antes de começar a entregar; a primeira linha aparece aqui no primeiro clique.' +
      (avisos.length ? '<span class="ritmo alerta">' + escapar(avisos.join(' ')) + '</span>' : '');
    document.getElementById('legendaAnuncios').textContent = '';
    return;
  }

  // Anotar gasto à mão só no dia de hoje. "Ontem" também é um dia só, mas é um
  // dia fechado: o campo gravaria a despesa na data de hoje e o número
  // apareceria no período errado, sem aviso nenhum.
  var podeAnotar = estado.diasAnuncios === 1 && estado.ateAnuncios === 'hoje';

  function linhaDeAnuncio(linha) {
    /*
     * Campanha e conjunto descem um nível ao serem clicados; anúncio é o fim
     * da linha e continua inerte. O `data-descer` guarda a chave do pai que o
     * próximo nível vai usar como filtro.
     */
    var desce = estado.agrupamento !== 'anuncio' && linha.chave;
    return '<tr' + (desce ? ' class="clicavel" data-descer="' + escapar(linha.chave) + '" title="Ver o nível abaixo"' : '') + '>' +
      '<td><span class="rotulo-anuncio">' + escapar(rotuloDoAnuncio(linha)) + (desce ? ' <span class="seta">›</span>' : '') + '</span>' +
        '<span class="secundario">' + escapar(linha.plataforma) + '</span></td>' +
      colunas.map(function (coluna) {
        return celulaDeAnuncio(linha, coluna, dados.metaRoas, podeAnotar);
      }).join('') +
    '</tr>';
  }

  /*
   * Duas seções na mesma tabela: o que está rodando agora, e o resto.
   *
   * `ativo` vem do cadastro do Meta e pode ser nulo — conta sem situação
   * importada, ou anúncio que já foi apagado lá e cuja venda continua aqui.
   * Nulo entra num grupo próprio em vez de virar "parado": chamar de parado o
   * que o painel apenas não conhece seria mentir com cara de informação.
   *
   * Sem situação nenhuma conhecida, a tabela volta a ser uma lista só — é
   * exatamente como ela era antes disto existir, e não há por que inventar
   * cabeçalho de seção para separar nada de nada.
   */
  var ativos = [];
  var parados = [];
  var semSituacao = [];
  /*
   * O filtro que veio do nível de cima: mostrando conjuntos depois de clicar
   * numa campanha, só entram os conjuntos daquela campanha.
   *
   * A linha "(sem origem)" fica de fora do filtro de propósito — ela não tem
   * pai, e some sozinha quando o recorte é de uma campanha específica.
   */
  var soDoPai = estado.paiAnuncios;
  var visiveis = soDoPai
    ? dados.linhas.filter(function (l) { return l.pai === soDoPai; })
    : dados.linhas;

  /*
   * Filtro de retorno, sobre a meta que o dono configurou.
   *
   * "sem venda" e uma faixa PROPRIA, e nao um caso de "abaixo da meta". Um
   * anuncio que gastou R$ 80 e vendeu zero e um problema diferente de um que
   * vendeu abaixo do alvo: o primeiro se corta, o segundo se ajusta. Jogar os
   * dois no mesmo balde esconde exatamente a linha que precisa de decisao hoje.
   */
  if (estado.filtroRoas) {
    var meta = Number(dados.metaRoas || 0) / 100;
    visiveis = visiveis.filter(function (l) {
      var investido = Number(l.investimentoCentavos || 0);
      var receita = Number(l.receitaCentavos || 0);
      if (estado.filtroRoas === 'sem') return Number(l.vendas || 0) === 0 && investido > 0;
      /* Sem investimento anotado nao ha retorno que calcular: a linha fica de
         fora das duas faixas em vez de fingir um ROAS infinito. */
      if (!investido) return false;
      var roas = receita / investido;
      return estado.filtroRoas === 'acima' ? roas >= meta : roas < meta;
    });
  }
  visiveis.forEach(function (linha) {
    if (linha.ativo === true) ativos.push(linha);
    else if (linha.ativo === false) parados.push(linha);
    else semSituacao.push(linha);
  });

  function secao(titulo, itens, classe) {
    if (!itens.length) return '';
    return '<tr class="secao-anuncios ' + classe + '">' +
      '<td colspan="' + (colunas.length + 1) + '">' + escapar(titulo) + ' · ' + itens.length + '</td>' +
    '</tr>' + itens.map(linhaDeAnuncio).join('');
  }

  corpo.innerHTML = (ativos.length || parados.length)
    ? secao('Rodando agora', ativos, 'ligada') +
      secao('Parados', parados, 'parada') +
      secao('Sem situação no Meta', semSituacao, 'parada')
    : (visiveis.length
        ? visiveis.map(linhaDeAnuncio).join('')
        : '<tr><td colspan="' + (colunas.length + 1) + '" class="vazio">' +
          'Nenhum item deste nível para o recorte escolhido.</td></tr>');

  // O rodapé some quando há uma linha só: repetir o mesmo número logo abaixo
  // dele não soma nada e ainda parece que existem dois valores diferentes.
  rodape.innerHTML = dados.linhas.length > 1
    ? '<td>Total</td>' + colunas.map(function (coluna) {
        return celulaDeAnuncio(dados.totais, coluna, dados.metaRoas, false);
      }).join('')
    : '';

  /*
   * A faixa do recorte. Sem ela, uma tabela filtrada é indistinguível de uma
   * conta que ficou vazia — e o dono conclui que perdeu os anúncios.
   */
  var trilha = document.getElementById('trilhaAnuncios');
  if (trilha) {
    if (estado.paiAnuncios) {
      trilha.hidden = false;
      trilha.innerHTML = 'Mostrando o que está dentro de <strong>' + escapar(estado.nomeDoPai || 'um item') +
        '</strong> <button type="button" id="limparPai">ver todos</button>';
      document.getElementById('limparPai').addEventListener('click', function () {
        estado.paiAnuncios = null;
        estado.nomeDoPai = '';
        carregarAnuncios();
      });
    } else {
      trilha.hidden = true;
      trilha.innerHTML = '';
    }
  }

  resumo.innerHTML = escapar(resumoDoPeriodo(dados, podeAnotar)) +
    (avisos.length ? '<span class="ritmo alerta">' + escapar(avisos.join(' ')) + '</span>' : '');

  document.getElementById('legendaAnuncios').innerHTML = legendaDasColunas(dados);

  Array.prototype.forEach.call(document.querySelectorAll('.entrada-investimento'), function (campo) {
    campo.addEventListener('change', function () { salvarInvestimento(campo.dataset.chave); });
  });
}

function rotuloDoAgrupamento() {
  if (estado.agrupamento === 'conjunto') return 'Conjunto';
  if (estado.agrupamento === 'anuncio') return 'Anúncio';
  return 'Campanha';
}

/**
 * Uma célula da tabela: o número, a cor que ele merece e, às vezes, um campo.
 *
 * `data-rotulo` em toda célula porque no celular o CSS desmonta a tabela em
 * cartões e esconde o cabeçalho — sem ele, a tela do dono vira uma pilha de
 * números soltos ("R$ 91,00 / R$ 73,00 / 5,06x / 3") sem dizer qual é qual. E é
 * no celular que ele olha isso.
 */
function celulaDeAnuncio(linha, coluna, metaRoas, podeAnotar) {
  var valor = linha[coluna.chave];
  var rotulo = ' data-rotulo="' + escapar(coluna.titulo) + '"';

  if (coluna.anota && podeAnotar) {
    // Vírgula, não ponto: é assim que o dono escreve dinheiro, e é o que ele vai
    // digitar por cima quando corrigir o valor.
    var mostrado = coluna.anota === 'valor'
      ? (valor ? (valor / 100).toFixed(2).replace('.', ',') : '')
      : (valor || '');
    return '<td class="num"' + rotulo + '><input class="entrada-investimento" inputmode="' +
      (coluna.anota === 'valor' ? 'decimal' : 'numeric') +
      '" data-chave="' + escapar(linha.chave) + '" data-campo="' + coluna.anota +
      '" value="' + escapar(mostrado) + '" placeholder="0" aria-label="' +
      escapar(coluna.titulo) + ' de hoje"></td>';
  }

  var classe = '';
  if (coluna.semaforo) classe = classeDoRoas(valor, metaRoas);
  else if (coluna.sinal && valor !== null && valor !== undefined) classe = valor >= 0 ? 'sobe' : 'desce';

  var conteudo = coluna.formato(valor);
  if (coluna.forte) conteudo = '<strong>' + conteudo + '</strong>';

  /*
   * Na visão Funil, cada etapa mostra quantos passaram da anterior.
   *
   * "18 visitas, 1 no quiz" só vira informação quando se lê "5,6% passaram" —
   * é a taxa, não a contagem, que diz em qual tela o dinheiro está vazando.
   */
  if (coluna.passagem) {
    var base = linha[coluna.passagem];
    if (base > 0) {
      conteudo += '<span class="passagem">' + pct(valor / base) + '</span>';
    }
  }

  return '<td class="num ' + classe + '"' + rotulo + '>' + conteudo + '</td>';
}

/**
 * Qual intervalo a tabela está mostrando, em dia de calendário.
 *
 * O dono precisa ver isso escrito: "Hoje" é a meia-noite de São Paulo até
 * agora, e sem a data na tela não há como perceber que o painel e o
 * Gerenciador de Anúncios estão olhando para o mesmo dia.
 */
function intervaloDoPeriodo(dados) {
  var periodo = dados.periodo;
  if (!periodo) return '';

  var curto = function (dia) { return dia.slice(8, 10) + '/' + dia.slice(5, 7); };
  if (periodo.diaInicial === periodo.diaFinal) {
    return 'Hoje, ' + curto(periodo.diaFinal) + ', da meia-noite até agora. ';
  }
  return 'De ' + curto(periodo.diaInicial) + ' a ' + curto(periodo.diaFinal) + '. ';
}

function resumoDoPeriodo(dados, podeAnotar) {
  var totais = dados.totais;
  var frases = [intervaloDoPeriodo(dados) + totais.vendas + ' venda(s) e ' + brl(totais.receitaCentavos) + ' no período.'];

  if (totais.investimentoCentavos > 0) {
    frases.push(
      'Investido ' + brl(totais.investimentoCentavos) + ', retorno de ' +
      totais.roas.toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + 'x' +
      ' (meta: ' + dados.metaRoas.toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + 'x).'
    );
    if (totais.lucroCentavos !== null) {
      frases.push(totais.lucroCentavos >= 0
        ? 'Sobrou ' + brl(totais.lucroCentavos) + ' depois de pagar os anúncios.'
        : 'Faltou ' + brl(Math.abs(totais.lucroCentavos)) + ' para pagar os anúncios.');
    }
  } else {
    frases.push(podeAnotar
      ? 'Anote quanto gastou na coluna Investido para ver o retorno.'
      : 'Para anotar quanto gastou, escolha o período "Hoje" — ou ligue a planilha, em Configuração.');
  }

  return frases.join(' ');
}

/** O que explicar embaixo da tabela depende de qual visão está aberta. */
function legendaDasColunas(dados) {
  if (estado.colunasAnuncios === 'trafego') {
    if (dados.totais.impressoes > 0) {
      return 'CTR, CPC e CPM vêm das impressões e cliques da plataforma. ' +
        '<strong>Custo/visita</strong> é o nosso: quanto custou cada pessoa que realmente abriu o site — ' +
        'a diferença para o CPC é quem clicou e desistiu antes de a página carregar.';
    }
    return 'Sem impressões e cliques não há CTR, CPC nem CPM. Eles entram sozinhos se a sua planilha ' +
      'tiver essas colunas (Configuração → Investimento automático), ou à mão no período "Hoje".';
  }

  if (estado.colunasAnuncios === 'funil') {
    return 'A porcentagem em cada etapa é quanto passou da etapa anterior. A queda maior é onde ' +
      'está o problema — e é a tela que vale mexer primeiro. ' +
      'Cada pessoa é contada em todas as etapas até onde chegou: quem abriu o checkout aparece ' +
      'também em Visitas, Quiz e VSL, mesmo que algum aviso do celular dela tenha se perdido no caminho. ' +
      'Por isso a passagem nunca passa de 100%.';
  }

  return 'Verde: passou da meta de ' +
    dados.metaRoas.toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + 'x. ' +
    'Amarelo: entre 1x e a meta — pagou o anúncio e pouco mais. Vermelho: gastou mais do que voltou. ' +
    'A meta se muda em Configuração.';
}

function desenharKpisAnuncios(dados) {
  var alvo = document.getElementById('kpisAnuncios');
  var totais = dados.totais;
  var anterior = dados.anterior;

  alvo.innerHTML = KPIS_DE_ANUNCIO.map(function (kpi) {
    var valor = totais[kpi.chave];
    var antes = anterior[kpi.chave];

    var classeValor = kpi.semaforo ? classeDoRoas(valor, dados.metaRoas) : '';

    /*
     * A comparação só aparece quando existe passado com o que comparar.
     *
     * Variação a partir de zero é sempre "infinito por cento" — um número que
     * não ajuda ninguém a decidir nada e ainda ocupa a linha que poderia estar
     * dizendo que ontem não houve venda.
     */
    var nota = '<span class="nota">vs. período anterior</span>';
    if (antes !== null && antes !== undefined && antes > 0 && valor !== null && valor !== undefined) {
      var variacao = (valor - antes) / antes;
      var subiu = variacao > 0;
      var classe = kpi.bomSubir === null || Math.abs(variacao) < 0.005
        ? ''
        : (subiu === kpi.bomSubir ? 'sobe' : 'desce');
      nota = '<span class="nota ' + classe + '">' +
        (subiu ? '+' : '') + (variacao * 100).toLocaleString('pt-BR', { maximumFractionDigits: 0 }) +
        '% vs. anterior</span>';
    }

    return '<div class="kpi">' +
      '<div class="rotulo">' + escapar(kpi.rotulo) + '</div>' +
      '<div class="valor ' + classeValor + '">' + kpi.formato(valor) + '</div>' +
      nota +
    '</div>';
  }).join('');
}

/**
 * Salva a linha inteira, e não só o campo que mudou.
 *
 * Gasto, impressões e cliques ocupam a mesma linha no banco: mandar só o campo
 * editado zeraria os outros dois. Os valores vêm do estado e são sobrescritos
 * pelo que estiver na tela, porque a coluna pode nem estar visível na visão
 * aberta no momento.
 */
function salvarInvestimento(chave) {
  /*
   * O dia vem do SERVIDOR, não do relógio deste aparelho.
   *
   * É o servidor que decide qual dia é "hoje" ao montar a tabela (meia-noite em
   * São Paulo). Calcular a data aqui fazia o gasto ser gravado num dia que a
   * tela não estava mostrando sempre que o relógio do celular estivesse fora de
   * hora ou o dono abrisse o painel de outro fuso — o valor era aceito e sumia
   * no recarregamento seguinte.
   */
  var periodo = estado.anuncios && estado.anuncios.periodo;
  var dia = periodo && periodo.diaDeHoje;
  if (!dia) {
    var agora = new Date();
    dia = agora.getFullYear() + '-' +
      String(agora.getMonth() + 1).padStart(2, '0') + '-' +
      String(agora.getDate()).padStart(2, '0');
  }

  var linha = null;
  (estado.anuncios ? estado.anuncios.linhas : []).forEach(function (item) {
    if (item.chave === chave) linha = item;
  });

  var corpo = {
    chave: chave,
    dia: dia,
    // O gasto pertence ao nível que está na tela: campanha, conjunto ou anúncio
    // são o mesmo dinheiro visto de alturas diferentes, e guardá-los juntos
    // faria o total somar três vezes.
    nivel: estado.agrupamento,
    /*
     * A BM vem do filtro aberto na tela. Digitar o gasto com um gerenciador
     * filtrado grava nele; com "Todas as BMs" grava sem carimbo, porque aí
     * realmente não se sabe de quem é.
     */
    bm: estado.bmAnuncios || '',
    valor: linha ? String(linha.investimentoCentavos / 100) : '0',
    impressoes: linha ? linha.impressoes : 0,
    cliques: linha ? linha.cliques : 0,
  };

  var campos = document.querySelectorAll('.entrada-investimento[data-chave="' + chave.replace(/"/g, '\\"') + '"]');
  Array.prototype.forEach.call(campos, function (campo) {
    if (campo.dataset.campo === 'valor') corpo.valor = campo.value || '0';
    else corpo[campo.dataset.campo] = campo.value || '0';
    campo.disabled = true;
  });

  api('/admin/investimento', { method: 'POST', body: corpo })
    .then(function () { return carregarAnuncios(); })
    .catch(function (falha) {
      alert(falha.message);
      Array.prototype.forEach.call(campos, function (campo) { campo.disabled = false; });
    });
}

function salvarMetaRoas() {
  var campo = document.getElementById('campoMetaRoas');
  var status = document.getElementById('statusMetaRoas');

  api('/admin/anuncios/meta-roas', { method: 'POST', body: { valor: campo.value } })
    .then(function (dados) {
      status.textContent = 'Meta salva: ' +
        dados.metaRoas.toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + 'x o investido.';
      return carregarAnuncios();
    })
    .catch(function (falha) { status.textContent = falha.message; });
}

/* ---------------------------------------------------------------- Funil -- */

/*
 * Onde as pessoas param antes de comprar.
 *
 * A aba Anúncios responde "qual anúncio traz gente que compra". Esta responde
 * a pergunta seguinte, e ela é de tela, não de mídia: das pessoas que chegaram,
 * onde elas desistem. As duas leem os mesmos eventos; a diferença é o corte —
 * lá por origem, aqui por etapa.
 *
 * O que se faz com isto: a maior queda é a tela que vale mexer primeiro. Não
 * adianta trocar criativo se metade some na pergunta 4.
 */

/**
 * Os números da campanha de e-mail.
 *
 * Carregado só quando a aba é aberta, como o funil: são dados que só interessam
 * a quem foi olhar, e puxar no login atrasaria a tela de todo dia por causa de
 * uma que se consulta uma vez por semana.
 */
function carregarCampanha() {
  return api('/admin/campanha?t=' + Date.now())
    .then(function (dados) {
      estado.campanha = dados;
      desenharCampanha();
    })
    .catch(function (falha) {
      document.getElementById('cartoesCampanha').innerHTML =
        '<p class="vazio">' + escapar(falha.message) + '</p>';
    });
}

function desenharCampanha() {
  var dados = estado.campanha;
  var cartoes = document.getElementById('cartoesCampanha');
  var corpo = document.getElementById('tabelaCampanha');
  var vazio = document.getElementById('vazioCampanha');
  if (!dados) return;

  var taxa = function (v) { return v === null || v === undefined ? '—' : Math.round(v * 100) + '%'; };

  /*
   * Cada cartão mostra o número E a passagem desde o degrau anterior. O total
   * sozinho engana: 2 vendas em 8 envios e 2 em 800 são campanhas opostas.
   */
  cartoes.innerHTML = [
    ['E-mails enviados', dados.enviados, ''],
    ['Abriram o link', dados.clicaram, taxa(dados.taxaDeClique) + ' de quem recebeu'],
    ['Pediram o PIX', dados.pediramPix, taxa(dados.taxaDePix) + ' de quem abriu'],
    ['Contribuíram', dados.pagaram, taxa(dados.taxaDePagamento) + ' de quem pediu'],
    ['Receita', brl(dados.receitaCentavos), taxa(dados.conversaoTotal) + ' do total enviado'],
  ]
    .concat(
      /*
       * O aviso de que há linhas fora da conta.
       *
       * Um relatório que esconde dado sem dizer é um relatório em que não se
       * pode confiar. Aqui as mensagens para o dono e para as baterias saem das
       * porcentagens — eram um quinto das linhas —, e a tela diz quantas foram.
       */
      dados.ocultosDaCasa
        ? [['Testes fora da conta', dados.ocultosDaCasa, 'mensagens suas e das baterias']]
        : [],
    )
    .map(function (linha) {
      return (
        '<div class="kpi"><span class="rotulo">' + linha[0] + '</span>' +
        '<span class="valor">' + linha[1] + '</span>' +
        (linha[2] ? '<span class="nota">' + linha[2] + '</span>' : '') +
        '</div>'
      );
    })
    .join('');

  /*
   * Filtro e ordenação acontecem aqui, sobre a lista já carregada: são 20
   * linhas, e ir ao servidor a cada clique só acrescentaria espera.
   */
  var linhas = (dados.linhas || []).slice();

  var filtros = {
    todos: function () { return true; },
    abriram: function (l) { return Boolean(l.visitadoEm); },
    'nao-abriram': function (l) { return !l.visitadoEm; },
    // O recorte que vale dinheiro: interesse demonstrado, compra não feita.
    quentes: function (l) { return Boolean(l.visitadoEm) && !l.cobrancaEm; },
    pagaram: function (l) { return Boolean(l.pago); },
  };
  linhas = linhas.filter(filtros[estado.filtroCampanha] || filtros.todos);

  var chaves = {
    nome: function (l) { return (l.nome || '').toLowerCase(); },
    enviado: function (l) { return l.enviadoEm || ''; },
    abriu: function (l) { return l.visitadoEm || ''; },
    cliques: function (l) { return l.cliques || 0; },
    pix: function (l) { return l.cobrancaEm || ''; },
    pago: function (l) { return l.pago ? (l.valorCentavos || 1) : 0; },
  };
  var chave = chaves[estado.ordemCampanha] || chaves.enviado;
  linhas.sort(function (a, b) {
    var x = chave(a), y = chave(b);
    if (x < y) return estado.ordemCampanhaAsc ? -1 : 1;
    if (x > y) return estado.ordemCampanhaAsc ? 1 : -1;
    return 0;
  });

  var contagem = document.getElementById('contagemCampanha');
  if (contagem) {
    contagem.textContent = linhas.length + ' de ' + (dados.linhas || []).length + ' pessoas';
  }
  vazio.hidden = linhas.length > 0;

  corpo.innerHTML = linhas
    .map(function (l) {
      var quando = function (iso) { return iso ? dataCurta(iso) : '<span class="fraco">—</span>'; };
      return (
        '<tr>' +
        '<td><strong>' + escapar(l.nome || '—') + '</strong><br><span class="fraco">' + escapar(l.email || '') + '</span></td>' +
        '<td>' + quando(l.enviadoEm) + '</td>' +
        '<td>' + quando(l.visitadoEm) + '</td>' +
        '<td class="num">' + (l.cliques || 0) + '</td>' +
        '<td>' + quando(l.cobrancaEm) + '</td>' +
        '<td>' + (l.pago ? '<strong>' + brl(l.valorCentavos) + '</strong>' : '<span class="fraco">—</span>') + '</td>' +
        '</tr>'
      );
    })
    .join('');
}

function carregarFunil() {
  return api('/admin/funil?dias=' + estado.diasFunil + '&ate=' + estado.ateFunil + '&t=' + Date.now())
    .then(function (dados) {
      estado.funil = dados;
      desenharFunil();
    })
    .catch(function (falha) {
      document.getElementById('resumoFunil').textContent = falha.message;
    });
}

/** Minutos e segundos, como se fala: "2 min", "45 s", "1 h 10 min". */
function duracao(segundos) {
  if (segundos === null || segundos === undefined) return '—';
  if (segundos < 60) return Math.round(segundos) + ' s';
  var minutos = Math.round(segundos / 60);
  if (minutos < 60) return minutos + ' min';
  var horas = Math.floor(minutos / 60);
  return horas + ' h ' + (minutos % 60) + ' min';
}

/**
 * Uma linha do funil: nome, quantos chegaram, a barra e quanto passou.
 *
 * A barra é proporcional ao TOPO do funil, e não à etapa anterior. Comparar
 * cada tela com a anterior faria todas as barras parecerem quase cheias — a
 * queda de 100 para 90 e a de 10 para 9 desenhariam a mesma figura, e é
 * justamente o encolhimento ao longo do caminho que precisa saltar aos olhos.
 */
function linhaDeEtapa(etapa, topo, ehMaiorPerda) {
  var largura = topo > 0 ? Math.max(1, (etapa.alcancaram / topo) * 100) : 0;
  var passagem = etapa.passagem === null || etapa.passagem === undefined
    ? ''
    : '<span class="passagem-etapa' + (ehMaiorPerda ? ' desce' : '') + '">' + pct(etapa.passagem) + '</span>';

  return '<div class="etapa-funil' + (ehMaiorPerda ? ' maior-perda' : '') + '">' +
    '<div class="etapa-cabecalho">' +
      '<span class="etapa-nome">' + escapar(etapa.nome) + '</span>' +
      '<span class="etapa-numeros">' + inteiro(etapa.alcancaram) + passagem + '</span>' +
    '</div>' +
    '<div class="etapa-trilho"><div class="etapa-barra" style="width:' + largura.toFixed(1) + '%"></div></div>' +
    (ehMaiorPerda
      ? '<span class="etapa-aviso">maior queda — é aqui que vale mexer primeiro</span>'
      : '') +
  '</div>';
}

function desenharFunil() {
  var dados = estado.funil;
  if (!dados) return;

  Array.prototype.forEach.call(document.querySelectorAll('#periodoFunil option'), function (opcao) {
    var periodo = lerPeriodo(opcao.value);
    opcao.selected = periodo.dias === estado.diasFunil && periodo.ate === estado.ateFunil;
  });

  var etapas = dados.etapas || [];
  var topo = etapas.length ? etapas[0].alcancaram : 0;

  /*
   * Sem ninguém no período não há funil para desenhar, e uma pilha de barras
   * zeradas parece defeito. O texto diz o que fazer em vez de mostrar o vazio.
   */
  if (!dados.sessoes) {
    document.getElementById('resumoFunil').textContent = '';
    document.getElementById('kpisFunil').innerHTML = '';
    document.getElementById('etapasFunil').innerHTML =
      '<p class="vazio">Ninguém entrou no site neste período. Assim que a primeira pessoa abrir a página, ' +
      'o caminho dela aparece aqui, tela por tela.</p>';
    document.getElementById('checkoutFunil').innerHTML = '';
    document.getElementById('abandonoFunil').innerHTML = '';
    document.getElementById('legendaFunil').textContent = '';
    return;
  }

  /* Qual etapa perdeu mais gente, em número absoluto de pessoas. */
  var maiorPerda = -1;
  var perdaMaxima = 0;
  for (var i = 1; i < etapas.length; i += 1) {
    var perdeu = etapas[i - 1].alcancaram - etapas[i].alcancaram;
    if (perdeu > perdaMaxima) {
      perdaMaxima = perdeu;
      maiorPerda = etapas[i].step;
    }
  }

  var checkout = dados.checkout || {};
  var conversao = dados.conversao || {};

  document.getElementById('kpisFunil').innerHTML = [
    { rotulo: 'Pessoas no site', valor: inteiro(dados.sessoes) },
    { rotulo: 'Chegaram na oferta', valor: inteiro(checkout.chegaramNaOferta) },
    { rotulo: 'Geraram o Pix', valor: inteiro(checkout.pixGerados) },
    { rotulo: 'Pagaram', valor: inteiro(checkout.pagos), forte: true },
    { rotulo: 'Visita → venda', valor: porcento(conversao.visitaAteVenda) },
    { rotulo: 'Do Pix ao pagamento', valor: porcento(checkout.doPixAoPagamento) },
    { rotulo: 'Até chegar na oferta', valor: duracao(dados.tempos ? dados.tempos.ateAOfertaS : null) },
    { rotulo: 'Até gerar o Pix', valor: duracao(dados.tempos ? dados.tempos.ateOPixS : null) },
  ].map(function (kpi) {
    return '<div class="kpi">' +
      '<div class="rotulo">' + escapar(kpi.rotulo) + '</div>' +
      '<div class="valor">' + kpi.valor + '</div>' +
    '</div>';
  }).join('');

  /*
   * O aviso vem ANTES das barras, e não no rodapé.
   *
   * Quando o período é anterior à medição das telas do meio, o desenho mostra
   * as nove perguntas com o mesmo número. Isso lê como "o quiz não perde
   * ninguém" — uma afirmação forte, e falsa. Quem olha o gráfico antes de ler a
   * ressalva já tirou a conclusão errada; por isso a ressalva vem primeiro.
   */
  var aviso = dados.quizSemMedicao
    ? '<p class="acionavel">As telas do meio do quiz passaram a ser medidas agora, e a maior parte deste ' +
      'período é anterior a isso. Por enquanto elas aparecem com o mesmo número — não é que ninguém desista ' +
      'no quiz, é que ainda não dava para saber. Só ' + inteiro(dados.sessoesComTelasDoMeio) + ' das ' +
      inteiro(dados.sessoes) + ' pessoas deste período foram medidas tela a tela. ' +
      'Escolha um período mais curto daqui a alguns dias para ver o quiz de verdade.</p>'
    : '';

  document.getElementById('etapasFunil').innerHTML = aviso + etapas.map(function (etapa) {
    return linhaDeEtapa(etapa, topo, etapa.step === maiorPerda);
  }).join('');

  /*
   * O checkout em texto, e não em barras: são quatro números e uma conta que o
   * dono precisa ler, não comparar visualmente.
   */
  var naoPagaram = checkout.naoPagaramOPix || 0;
  document.getElementById('checkoutFunil').innerHTML =
    '<div class="checkout-fluxo">' +
      '<span><strong>' + inteiro(checkout.chegaramNaOferta) + '</strong> viram a oferta</span>' +
      '<span class="seta">→</span>' +
      '<span><strong>' + inteiro(checkout.pixGerados) + '</strong> geraram o Pix</span>' +
      '<span class="seta">→</span>' +
      '<span><strong>' + inteiro(checkout.pagos) + '</strong> pagaram</span>' +
    '</div>' +
    /*
     * Três desfechos, e o terceiro existe porque a tela já mentiu aqui: sem
     * nenhum Pix gerado ela dizia "todo Pix gerado foi pago", que é
     * tecnicamente verdade sobre um conjunto vazio e uma bobagem para quem lê.
     */
    (naoPagaram > 0
      ? '<p class="acionavel"><strong>' + inteiro(naoPagaram) + ' pessoa(s) geraram o Pix e não pagaram.</strong> ' +
        'São as mais fáceis de recuperar: elas já escolheram o produto e digitaram o CPF. ' +
        'Os pedidos estão na aba Pedidos, como “Aguardando”.</p>'
      : checkout.pixGerados > 0
        ? '<p class="rodape">Todo Pix gerado neste período foi pago.</p>'
        : '<p class="rodape">Ninguém chegou a gerar um Pix neste período.</p>') +
    (checkout.upsellsPagos
      ? '<p class="rodape">' + inteiro(checkout.upsellsPagos) + ' pagaram também uma oferta adicional.</p>'
      : '');

  var abandono = dados.abandono || [];
  document.getElementById('abandonoFunil').innerHTML = abandono.length
    ? '<p class="rodape">Sessões sem nenhum sinal há mais de 30 minutos e sem pedido pago. ' +
      'Quem parou agora há pouco pode estar respondendo neste instante, então não entra na conta.</p>' +
      '<ul class="lista-abandono">' + abandono.map(function (linha) {
        return '<li><span>' + escapar(linha.nome) + '</span><strong>' + inteiro(linha.sessoes) + '</strong></li>';
      }).join('') + '</ul>'
    : '<p class="rodape">Ninguém parou no meio do caminho neste período.</p>';

  desenharVsl(dados.vsl || []);
  desenharQuiz(dados.quiz || []);

  document.getElementById('resumoFunil').textContent =
    dados.sessoes + ' pessoa(s) no período' + (dados.amostraPequena ? ' — amostra pequena' : '');

  document.getElementById('legendaFunil').innerHTML = dados.amostraPequena
    ? '<strong>Amostra pequena:</strong> com menos de 20 pessoas as porcentagens oscilam muito — ' +
      'uma pessoa a mais muda tudo. Olhe os números absolutos e espere mais tráfego antes de decidir.'
    : 'A porcentagem em cada linha é quanto passou da tela anterior. A barra é proporcional a quem abriu o site.';
}

/*
 * A retenção da VSL, minuto a minuto.
 *
 * O degrau de 4:02 é o que decide tudo: é ali que o vídeo diz o preço e o botão
 * de compra nasce. Quem não chega até lá NUNCA VIU A OFERTA — e contar essa
 * pessoa como "viu e não quis" leva a mexer na oferta quando o problema está no
 * vídeo, ou o contrário.
 */
function desenharVsl(marcos) {
  var alvo = document.getElementById('vslFunil');
  if (!alvo) return;

  if (!marcos.length) {
    alvo.innerHTML = '<p class="vazio">Ainda sem medição. A retenção do vídeo passou a ser gravada em 13/08 — ' +
      'escolha um período que comece depois disso, e espere as primeiras visitas.</p>';
    return;
  }

  var maior = marcos.reduce(function (m, x) { return Math.max(m, x.pessoas); }, 0) || 1;
  var primeiro = marcos[0].pessoas || 1;

  alvo.innerHTML = '<p class="rodape">Aos <strong>4:02</strong> o vídeo diz o preço e o botão de compra aparece. ' +
    'Quem sai antes desse degrau não chegou a ver a oferta.</p>' +
    '<ul class="lista-abandono">' + marcos.map(function (m) {
      var minutos = Math.floor(m.segundos / 60);
      var resto = m.segundos % 60;
      var rotulo = minutos + ':' + (resto < 10 ? '0' : '') + resto;
      var largura = Math.round((m.pessoas / maior) * 100);
      var sobrou = Math.round((m.pessoas / primeiro) * 100);

      return '<li' + (m.ondeOBotaoNasce ? ' style="border-top:2px solid var(--ok)"' : '') + '>' +
        '<span>' + (m.ondeOBotaoNasce ? '<strong>' + rotulo + ' — o preço é dito aqui</strong>' : rotulo) + '</span>' +
        '<span class="secundario" style="flex:1;margin:0 10px">' +
          '<span style="display:block;height:6px;border-radius:3px;background:var(--ok-fundo);width:' + largura + '%"></span>' +
        '</span>' +
        '<span class="secundario">' + inteiro(m.pessoas) + ' · ' + sobrou + '%</span>' +
        '<strong>' + inteiro(m.compraram) + ' venda(s)</strong>' +
      '</li>';
    }).join('') + '</ul>';
}

/*
 * As respostas do quiz, pergunta por pergunta.
 *
 * DUAS COLUNAS QUE CONTAM HISTÓRIAS DIFERENTES: quantas pessoas escolheram
 * aquela opção, e quantas dessas compraram. A mais escolhida quase nunca é a
 * que mais compra — e é a segunda que decide onde colocar dinheiro. Uma dor que
 * um décimo do público sente e um quinto desses paga para resolver vale mais
 * que uma que metade sente e ninguém compra.
 *
 * Abaixo de cinco pessoas a taxa não é mostrada: "0%" com três respostas leria
 * como "essa dor não vende", quando o certo é "ainda não dá para saber".
 */
function desenharQuiz(perguntas) {
  var alvo = document.getElementById('quizFunil');
  if (!alvo) return;

  if (!perguntas.length) {
    alvo.innerHTML = '<p class="vazio">Nenhuma resposta registrada neste período. ' +
      'As escolhas do quiz passaram a ser gravadas em 12/08 — escolha um período que comece depois disso.</p>';
    return;
  }

  alvo.innerHTML = '<p class="rodape">A porcentagem à direita é quanto daquele grupo COMPROU. ' +
    'É ela que diz qual dor paga, e não a mais escolhida.</p>' +
    perguntas.map(function (p) {
      return '<div class="pergunta-quiz">' +
        '<h3>' + escapar(p.pergunta) + '</h3>' +
        '<ul class="lista-abandono">' + p.opcoes.map(function (o) {
          var taxa = o.conversao === null
            ? '<span class="secundario" title="Menos de 5 pessoas: amostra pequena demais para uma taxa">—</span>'
            : '<strong>' + porcento(o.conversao) + '</strong>';
          return '<li><span>' + escapar(o.resposta) + '</span>' +
            '<span class="secundario">' + inteiro(o.pessoas) + ' pessoa(s) · ' + porcento(o.fatia) + '</span>' +
            taxa + '</li>';
        }).join('') + '</ul>' +
      '</div>';
    }).join('');
}

/** Alterna entre a tela de números e a de ajustes. */
function trocarSecaoDeAnuncios(secao) {
  estado.secaoAnuncios = secao;

  document.getElementById('secaoDesempenho').hidden = secao !== 'desempenho';
  document.getElementById('secaoConfigAnuncios').hidden = secao !== 'config';

  Array.prototype.forEach.call(document.querySelectorAll('#chipsSecaoAnuncios button'), function (botao) {
    botao.setAttribute('aria-pressed', String(botao.dataset.secao === secao));
  });

  // Período e "Atualizar" não têm o que fazer na tela de ajustes.
  document.getElementById('periodoAnuncios').hidden = secao !== 'desempenho';
  document.getElementById('recarregarAnuncios').hidden = secao !== 'desempenho';
}

function desenharMeta() {
  var dados = estado.meta;
  var alvo = document.getElementById('painelMeta');
  if (!dados) return;

  if (!dados.ativo) {
    var motivo = !dados.pixelConfigurado
      ? 'Falta o ID do Pixel (META_PIXEL_ID).'
      : !dados.tokenConfigurado
        ? 'Falta o token da API de Conversões (META_CAPI_TOKEN).'
        : 'O envio está desligado por configuração (META_TRACKING_ENABLED).';
    alvo.innerHTML = '<p class="rodape">' + escapar(motivo) +
      ' Enquanto isso, as vendas continuam sendo registradas aqui — só não chegam ao Facebook.</p>';
    return;
  }

  /*
   * O que importa em cada linha, além de "enviado": COM QUE o evento saiu.
   * "fbc" é o clique no anúncio, "fbp"/"ip"/"ua" são o navegador do comprador
   * — sem eles a compra chega ao Facebook mas não volta atribuída a anúncio
   * nenhum. Um "enviado" sem fbc é o primeiro lugar a olhar quando a venda
   * está no painel e não está no Gerenciador. Os avisos que o Facebook devolve
   * junto do 200 ("fbc inválido" etc.) aparecem no title.
   */
  var linhas = (dados.ultimos || []).slice(0, 10).map(function (envio) {
    var chaves = Array.isArray(envio.chaves) ? envio.chaves : null;
    var faltaClique = chaves && chaves.indexOf('fbc') === -1;
    var resumoChaves = chaves
      ? (chaves.join(' ') + (faltaClique ? ' — SEM fbc' : ''))
      : '';
    var avisos = envio.resposta && envio.resposta.indexOf('avisos:') !== -1 ? envio.resposta : '';
    return '<li title="' + escapar((envio.resposta || '') + (chaves ? ' | chaves: ' + chaves.join(',') : '')) + '">' +
      '<span class="quando">' + escapar(dataCurta(envio.t)) + '</span>' +
      '<span>' + escapar(envio.evento) + (avisos ? ' ⚠' : '') + '</span>' +
      '<span class="secundario">' + escapar(envio.sucesso ? 'enviado' : (envio.resposta || 'pendente')) +
        (resumoChaves ? ' · ' + escapar(resumoChaves) : '') + '</span></li>';
  }).join('');

  alvo.innerHTML =
    '<p class="rodape">' +
      (dados.pendentes > 0
        ? escapar(dados.pendentes + ' evento(s) ainda não confirmados pelo Facebook.')
        : 'Todos os eventos foram confirmados.') +
      (dados.modoTeste ? ' <strong>Modo de teste ligado: nada conta como conversão real.</strong>' : '') +
    '</p>' +
    (dados.pendentes > 0 ? '<button class="botao-icone" id="reenviarMeta">Reenviar pendentes</button>' : '') +
    '<ul class="historico-lista">' + linhas + '</ul>';

  var botao = document.getElementById('reenviarMeta');
  if (botao) {
    botao.addEventListener('click', function () {
      botao.disabled = true;
      botao.textContent = 'Reenviando...';
      api('/admin/meta/reenviar', { method: 'POST' })
        .then(function (resultado) {
          botao.textContent = resultado.enviados + ' de ' + resultado.tentados + ' enviados';
          return carregarMeta();
        })
        .catch(function (falha) { botao.textContent = falha.message.slice(0, 40); });
    });
  }
}

/* ------------------------------------------------- Credenciais do Meta -- */

/*
 * Pixel e token editaveis pelo dono.
 *
 * Antes eles so existiam como variavel de ambiente na Vercel, e trocar um numero
 * exigia deploy — que o dono nao faz. O token nunca volta inteiro do servidor:
 * a tela mostra so a mascara, e campo em branco significa "mantenha o que esta
 * la", nao "apague".
 */

function textoDaOrigem(origem) {
  if (origem === 'painel') return 'salvo aqui no painel';
  if (origem === 'ambiente') return 'vindo da variável de ambiente';
  return 'não configurado';
}

function pintarEstadoDasCredenciais(dados) {
  var aviso = document.getElementById('estadoCredenciais');
  var linhas = [];

  /*
   * O código de teste salvo VENCE o "tudo certo" — por isso é decidido antes.
   *
   * Com ele salvo, cada evento sai com test_event_code: aparece na aba "Testar
   * eventos" do Meta e NÃO conta como conversão de verdade. O funil parece
   * saudável, o anúncio roda, e o robô otimiza no escuro. A versão anterior
   * mencionava isso numa frase perdida dentro do quadro VERDE de "Rastreamento
   * ativo" — quem bate o olho lê "ativo" e segue. Perigo assim muda a cor do
   * quadro inteiro, não ganha uma nota de rodapé.
   */
  if (dados.modoTeste || dados.testEventCode) {
    aviso.className = 'aviso-credencial alerta';
    linhas.push('MODO DE TESTE: há um código de teste salvo (' + (dados.testEventCode || 'ativo') + '). NENHUM evento está contando como conversão real — o Purchase das vendas não chega ao robô. Apague o campo e salve para voltar ao normal.');
  } else if (dados.ligado) {
    aviso.className = 'aviso-credencial ok';
    linhas.push('Rastreamento ativo.');
  } else {
    aviso.className = 'aviso-credencial alerta';
    linhas.push('Rastreamento desligado — nenhum evento está sendo enviado ao Meta.');
  }

  linhas.push('Pixel: ' + textoDaOrigem(dados.origemDoPixel) + '.');
  linhas.push('Token: ' + (dados.tokenMascarado ? dados.tokenMascarado + ' (' + textoDaOrigem(dados.origemDoToken) + ')' : 'não configurado') + '.');

  // Chave mestra trocada deixa o token guardado ilegivel. Sem este aviso, o
  // rastreamento cairia calado e o dono so descobriria contando venda perdida.
  if (dados.tokenIlegivel) {
    linhas.push('Atenção: há um token salvo que a chave mestra atual não abre. Cole o token de novo.');
  }

  aviso.textContent = linhas.join(' ');
}

function carregarCredenciais() {
  return api('/admin/meta/credenciais?t=' + Date.now())
    .then(function (dados) {
      document.getElementById('metaPixelId').value = dados.pixelId || '';
      document.getElementById('metaTestCode').value = dados.testEventCode || '';
      document.getElementById('metaLigado').checked = dados.ligado || dados.origemDoPixel !== 'nenhuma';

      var campoToken = document.getElementById('metaToken');
      if (!dados.podeGuardarToken) {
        campoToken.disabled = true;
        campoToken.placeholder = 'sem PAINEL_CHAVE_MESTRA não dá para guardar token aqui';
      }

      pintarEstadoDasCredenciais(dados);
    })
    .catch(function () { /* a aba abre mesmo sem isso */ });
}

function salvarCredenciais() {
  var status = document.getElementById('statusCredenciais');
  var botao = document.getElementById('salvarCredenciais');
  var campoToken = document.getElementById('metaToken');

  /*
   * Salvar um código de teste pede confirmação POR EXTENSO, porque o estrago é
   * mudo: com ele salvo, o Purchase de cada venda vira evento de teste e o
   * robô do Meta otimiza sem enxergar venda nenhuma. Em 14/08/2026 o campo
   * estava preenchido na tela do dono por engano — um clique em Salvar e a
   * campanha inteira ficaria cega, sem nenhum erro em lugar nenhum.
   */
  var codigoDeTeste = document.getElementById('metaTestCode').value.trim();
  if (codigoDeTeste) {
    var confirmou = window.confirm(
      'O campo "Código de teste" está preenchido (' + codigoDeTeste + ').\n\n' +
      'Com ele salvo, NENHUMA venda conta como conversão de verdade no Meta — ' +
      'os eventos vão todos para a aba "Testar eventos" e o robô fica cego.\n\n' +
      'Isso é só para conferir a conexão durante uns minutos, nunca para deixar salvo.\n\n' +
      'Salvar mesmo assim?'
    );
    if (!confirmou) {
      status.textContent = 'Nada foi salvo. Apague o código de teste e salve de novo.';
      return;
    }
  }

  botao.disabled = true;
  status.textContent = '';

  api('/admin/meta/credenciais', {
    method: 'POST',
    body: {
      pixelId: document.getElementById('metaPixelId').value.trim(),
      token: campoToken.value.trim(),
      testEventCode: document.getElementById('metaTestCode').value.trim(),
      ligado: document.getElementById('metaLigado').checked,
    },
  })
    .then(function (dados) {
      // O campo e limpo assim que salva: token digitado que fica na tela acaba
      // em print de tela e em gravacao de suporte.
      campoToken.value = '';
      pintarEstadoDasCredenciais(dados);
      status.textContent = dados.ligado
        ? 'Salvo. Vale a partir de agora, sem publicar o site de novo.'
        : 'Salvo, mas o rastreamento continua desligado: falta pixel ou token.';
      return carregarAnuncios();
    })
    .catch(function (falha) { status.textContent = falha.message; })
    .finally(function () { botao.disabled = false; });
}

function testarCredenciais() {
  var status = document.getElementById('statusCredenciais');
  var botao = document.getElementById('testarCredenciais');

  botao.disabled = true;
  botao.textContent = 'Testando...';

  api('/admin/meta/testar', { method: 'POST' })
    .then(function (dados) {
      status.textContent = dados.ok
        ? 'Conexão com o Meta funcionando (' + dados.detalhe + '). Nenhum evento foi registrado.'
        : 'O Meta recusou: ' + dados.detalhe;
    })
    .catch(function (falha) { status.textContent = falha.message; })
    .finally(function () {
      botao.disabled = false;
      botao.textContent = 'Testar conexão';
    });
}

/* --------------------------------------- Investimento vindo de uma planilha -- */

/*
 * O gasto vive no Gerenciador de Anuncios, nao aqui. Ferramentas como a Stract
 * extraem esse numero para uma Google Sheet; o servidor le a planilha publicada
 * em CSV e preenche a coluna Investido, que antes era digitada a mao todo dia.
 */

/* ------------------------------------- Investimento direto do Meta ------ */

/*
 * A ligação com a conta de anúncios.
 *
 * O gasto é a metade que falta na aba Anúncios: sem ele a tela mostra
 * faturamento e nunca retorno, e faturamento sozinho manda escalar anúncio que
 * dá prejuízo. Até aqui esse número entrava à mão ou por planilha; ligado, ele
 * chega sozinho todo dia de madrugada.
 */

function carregarAnunciosMeta() {
  return api('/admin/meta/anuncios?t=' + Date.now())
    .then(function (dados) {
      estado.anunciosMeta = dados;
      var campoConta = document.getElementById('contaAnuncios');
      if (campoConta && document.activeElement !== campoConta) campoConta.value = dados.contaId || '';
      desenharStatusAnunciosMeta();
    })
    .catch(function () { /* a aba abre mesmo sem isso */ });
}

function desenharStatusAnunciosMeta(mensagem) {
  var dados = estado.anunciosMeta || {};
  var alvo = document.getElementById('statusAnuncios');
  if (!alvo) return;

  if (mensagem) {
    alvo.textContent = mensagem;
    return;
  }

  var frases = [];
  if (dados.tokenIlegivel) {
    frases.push('O token guardado não abre com a chave mestra atual. Cole o token de novo.');
  } else if (!dados.podeGuardarToken) {
    frases.push('Sem a chave mestra do painel (PAINEL_CHAVE_MESTRA) não dá para guardar o token com segurança.');
  } else if (dados.ligado) {
    frases.push('Ligado na conta ' + dados.contaId + '.');
    frases.push(dados.ultimaImportacao
      ? 'Última importação: ' + dataCompleta(dados.ultimaImportacao) + '.'
      : 'Ainda não importou. Clique em "Importar agora".');
    frases.push('Daqui em diante roda sozinho todo dia, às 3h10.');
  } else if (dados.contaId && !dados.temToken) {
    frases.push('Falta o token de leitura (ads_read).');
  } else if (!dados.contaId && dados.temToken) {
    frases.push('Falta o número da conta de anúncios.');
  } else {
    frases.push('Não configurado: o gasto continua entrando à mão ou por planilha.');
  }

  alvo.textContent = frases.join(' ');
}

function salvarAnunciosMeta() {
  var conta = document.getElementById('contaAnuncios');
  var token = document.getElementById('tokenAnuncios');
  var botao = document.getElementById('salvarAnuncios');

  var corpo = { contaId: conta.value.trim() };
  // Campo de token em branco não apaga o que já existe: só é enviado quando o
  // dono digitou algo. Para desligar, ele salva com o campo preenchido em
  // branco de propósito -- ver o texto da tela.
  if (token.value !== '') corpo.token = token.value.trim();

  botao.disabled = true;
  api('/admin/meta/anuncios', { method: 'POST', body: corpo })
    .then(function () {
      // O token some da tela assim que sai daqui: ele nunca volta do servidor,
      // e deixá-lo no campo é uma cópia a mais no navegador.
      token.value = '';
      return carregarAnunciosMeta();
    })
    .catch(function (falha) { desenharStatusAnunciosMeta(falha.message); })
    .finally(function () { botao.disabled = false; });
}

function testarAnunciosMeta() {
  var botao = document.getElementById('testarAnuncios');
  botao.disabled = true;
  desenharStatusAnunciosMeta('Falando com o Meta...');

  api('/admin/meta/anuncios/testar', { method: 'POST' })
    .then(function (dados) {
      desenharStatusAnunciosMeta('Funcionou: o token lê a conta ' + dados.conta + '.');
    })
    .catch(function (falha) { desenharStatusAnunciosMeta(falha.message); })
    .finally(function () { botao.disabled = false; });
}

function importarAnunciosMeta() {
  var botao = document.getElementById('importarAnuncios');
  botao.disabled = true;
  botao.textContent = 'Importando...';
  desenharStatusAnunciosMeta('Buscando o gasto no Meta...');

  api('/admin/meta/anuncios/importar', { method: 'POST', body: { dias: 7 } })
    .then(function (dados) {
      desenharStatusAnunciosMeta(
        'Importados ' + dados.dias + ' dia(s), somando ' + dados.totalFormatado + ' em anúncios. ' +
        'A coluna Investido já está preenchida.',
      );
      return carregarAnuncios();
    })
    .catch(function (falha) { desenharStatusAnunciosMeta(falha.message); })
    .finally(function () {
      botao.disabled = false;
      botao.textContent = 'Importar agora';
    });
}

function carregarPlanilha() {
  return api('/admin/investimento/planilha?t=' + Date.now())
    .then(function (dados) {
      document.getElementById('urlPlanilha').value = dados.url || '';
      var status = document.getElementById('statusPlanilha');
      status.textContent = dados.ultimaImportacao
        ? 'Última importação: ' + dataCompleta(dados.ultimaImportacao) + '.'
        : (dados.url ? 'Planilha configurada. Clique em "Importar agora".' : '');
    })
    .catch(function () { /* aba abre mesmo sem isso */ });
}

function salvarPlanilha() {
  var campo = document.getElementById('urlPlanilha');
  var status = document.getElementById('statusPlanilha');
  var botao = document.getElementById('salvarPlanilha');

  botao.disabled = true;
  api('/admin/investimento/planilha', { method: 'POST', body: { url: campo.value.trim() } })
    .then(function (dados) {
      status.textContent = dados.url
        ? 'Endereço salvo. Clique em "Importar agora".'
        : 'Importação desligada.';
    })
    .catch(function (falha) { status.textContent = falha.message; })
    .finally(function () { botao.disabled = false; });
}

function importarPlanilha() {
  var status = document.getElementById('statusPlanilha');
  var botao = document.getElementById('importarPlanilha');

  botao.disabled = true;
  botao.textContent = 'Importando...';
  status.textContent = '';

  api('/admin/investimento/importar', { method: 'POST' })
    .then(function (dados) {
      var frases = [
        dados.linhas + ' dia(s) de campanha importados, somando ' + dados.totalFormatado + '.',
        'Colunas lidas: ' + dados.colunasEncontradas.dia + ', ' +
          dados.colunasEncontradas.chave + ', ' + dados.colunasEncontradas.valor + '.',
      ];
      // O que ficou de fora aparece: importacao silenciosa que engole linha e
      // mostra numero menor do que foi gasto e pior que nao importar nada.
      if (dados.ignoradas && dados.ignoradas.length) {
        frases.push(dados.ignoradas.length + ' linha(s) ignorada(s): ' + dados.ignoradas.slice(0, 3).join('; ') + '.');
      }
      status.textContent = frases.join(' ');
      return carregarAnuncios();
    })
    .catch(function (falha) { status.textContent = falha.message; })
    .finally(function () {
      botao.disabled = false;
      botao.textContent = 'Importar agora';
    });
}

/* ------------------------------------------- Gerador de parametros de URL -- */

/*
 * A linha que o dono cola no anuncio.
 *
 * Ela e FIXA: as chaves duplas sao variaveis da plataforma, trocadas pelo nome
 * e pelo ID reais no instante do clique. Por isso o mesmo texto serve para
 * todos os anuncios, e nao ha nada para personalizar campanha a campanha.
 *
 * Dois formatos, porque existem dois mundos:
 *
 *  - COMPLETO: cada informacao no seu proprio campo (fb_ad_id e companhia). E o
 *    que este funil le nativamente, e o unico que nao se perde quando o nome da
 *    campanha tem "|" no meio.
 *  - EMPACOTADO: nome e ID espremidos dentro dos cinco campos UTM padrao, no
 *    formato "nome|id". E o que UTMify e ferramentas parecidas usam, porque
 *    precisam funcionar com checkouts de terceiros que so repassam UTM. Fica
 *    aqui para quem ja usa uma dessas em paralelo -- src/lib/attribution.ts
 *    entende os dois.
 */
var PARAMETROS = {
  meta: {
    completo: [
      'utm_source=facebook',
      'utm_medium=paid',
      'utm_campaign={{campaign.name}}',
      'utm_id={{campaign.id}}',
      'utm_term={{adset.name}}',
      'utm_content={{ad.name}}',
      'fb_campaign_id={{campaign.id}}',
      'fb_adset_id={{adset.id}}',
      'fb_ad_id={{ad.id}}',
      'fb_placement={{placement}}',
      'fb_source={{site_source_name}}',
    ].join('&'),
    empacotado: [
      'utm_source=facebook',
      'utm_campaign={{campaign.name}}|{{campaign.id}}',
      'utm_medium={{adset.name}}|{{adset.id}}',
      'utm_content={{ad.name}}|{{ad.id}}',
      'utm_term={{placement}}',
    ].join('&'),
    exemplo: {
      completo: 'https://seudominio.com.br/?utm_source=facebook&utm_medium=paid&utm_campaign=RS_frio_video01&fb_ad_id=120410000001&fbclid=IwAR2x...',
      empacotado: 'https://seudominio.com.br/?utm_source=facebook&utm_campaign=RS_frio_video01|120210000001&utm_content=criativo_02|120410000001&fbclid=IwAR2x...',
    },
  },
  google: {
    // O Google usa chaves simples e nomes proprios. gclid vem sozinho no clique,
    // mas pedimos explicitamente porque nem todo tipo de campanha o acrescenta.
    completo: [
      'utm_source=google',
      'utm_medium=cpc',
      'utm_campaign={campaignid}',
      'utm_content={creative}',
      'utm_term={keyword}',
      'gclid={gclid}',
    ].join('&'),
    empacotado: [
      'utm_source=google',
      'utm_campaign={campaignname}|{campaignid}',
      'utm_content={creative}',
      'utm_term={keyword}',
      'gclid={gclid}',
    ].join('&'),
    exemplo: {
      completo: 'https://seudominio.com.br/?utm_source=google&utm_medium=cpc&utm_campaign=21345678&gclid=Cj0KCQ...',
      empacotado: 'https://seudominio.com.br/?utm_source=google&utm_campaign=Rezas_Busca|21345678&gclid=Cj0KCQ...',
    },
  },
};

var EXPLICACAO = {
  completo:
    'Cada informação vai no seu próprio campo. É o formato que este funil lê ' +
    'nativamente e o único que não se perde se o nome da campanha tiver "|".',
  empacotado:
    'Nome e ID espremidos dentro dos campos UTM, no formato "nome|id" — é o que ' +
    'a UTMify e ferramentas parecidas usam. Escolha este só se você já usa uma ' +
    'delas em paralelo; o funil entende os dois.',
};

function desenharParametros() {
  var plataforma = estado.plataformaParam;
  var formato = estado.formatoParam;
  var conjunto = PARAMETROS[plataforma];

  Array.prototype.forEach.call(document.querySelectorAll('#chipsPlataforma button'), function (botao) {
    botao.setAttribute('aria-pressed', String(botao.dataset.plataforma === plataforma));
  });
  Array.prototype.forEach.call(document.querySelectorAll('#chipsFormato button'), function (botao) {
    botao.setAttribute('aria-pressed', String(botao.dataset.formato === formato));
  });

  document.getElementById('saidaParametros').value = conjunto[formato];
  document.getElementById('explicacaoParametros').textContent = EXPLICACAO[formato];
  document.getElementById('exemploClique').textContent = conjunto.exemplo[formato];
  document.getElementById('avisoParametros').textContent = '';
}

function copiarParametros() {
  var campo = document.getElementById('saidaParametros');
  var aviso = document.getElementById('avisoParametros');

  // select() + execCommand como reserva: o clipboard moderno exige contexto
  // seguro, e o painel roda em http://localhost no desenvolvimento.
  campo.select();
  campo.setSelectionRange(0, campo.value.length);

  var copiado = false;
  try {
    copiado = document.execCommand('copy');
  } catch (e) {
    copiado = false;
  }

  if (!copiado && navigator.clipboard) {
    navigator.clipboard.writeText(campo.value).then(function () {
      aviso.textContent = 'Copiado. Cole no campo "Parâmetros de URL" do anúncio.';
    }).catch(function () {
      aviso.textContent = 'Não consegui copiar. Selecione o texto acima e copie à mão.';
    });
    return;
  }

  aviso.textContent = copiado
    ? 'Copiado. Cole no campo "Parâmetros de URL" do anúncio.'
    : 'Não consegui copiar. Selecione o texto acima e copie à mão.';
}

function trocarAba(nome) {
  estado.aba = nome;

  // Busca só na primeira abertura: quem nunca abre a aba não paga por ela.
  if (nome === 'entregas' && !estado.entregas) carregarEntregas();
  if (nome === 'webhooks' && estado.webhooks.length === 0) carregarWebhooks();
  if (nome === 'anuncios' && !estado.anuncios) {
    carregarAnuncios();
    carregarMeta();
    carregarPlanilha();
    carregarCredenciais();
    carregarAnunciosMeta();
  }
  // O gerador é só texto: nada a buscar, então desenha toda vez que a aba abre.
  if (nome === 'anuncios') desenharParametros();
  if (nome === 'funil' && !estado.funil) carregarFunil();
  // Sempre recarrega: quem abre esta aba está acompanhando um disparo em
  // andamento, e cache aqui mostraria o número de dez minutos atrás.
  if (nome === 'emails') carregarCampanha();
  // Também sempre: quem abre esta aba vai emitir ou conferir um boleto agora, e
  // uma linha velha aqui é boleto emitido duas vezes.
  if (nome === 'boletos') carregarBoletos();
  if (nome === 'tiktok' && !estado.tiktok) carregarTiktok();
  /* Sempre recarrega: quem abre esta aba esta decidindo onde por verba agora,
     e um numero de dez minutos atras e pior que nenhum. */
  if (nome === 'bms') carregarBms();

  Array.prototype.forEach.call(document.querySelectorAll('.abas button'), function (botao) {
    botao.setAttribute('aria-selected', String(botao.dataset.aba === nome));
  });
  ['resumo', 'pedidos', 'cobranca', 'entregas', 'webhooks', 'anuncios', 'bms', 'relatorios', 'funil', 'pagamentos', 'acessos', 'emails', 'boletos', 'crm', 'tiktok'].forEach(function (chave) {
    var secao = document.getElementById('aba' + chave.charAt(0).toUpperCase() + chave.slice(1));
    if (secao) secao.hidden = chave !== nome;
  });
  desenhar();
}

function ligarEventos() {
  document.getElementById('formLogin').addEventListener('submit', entrar);
  document.getElementById('botaoSair').addEventListener('click', sair);
  document.getElementById('botaoRecarregar').addEventListener('click', carregar);

  document.getElementById('botaoTema').addEventListener('click', function () {
    var escuro = document.documentElement.dataset.tema === 'escuro';
    document.documentElement.dataset.tema = escuro ? 'claro' : 'escuro';
    try { localStorage.setItem('painel.tema', escuro ? 'claro' : 'escuro'); } catch (e) { /* ignora */ }
    desenhar();
  });

  document.getElementById('chipsPeriodo').addEventListener('click', function (evento) {
    var botao = evento.target.closest('button');
    if (!botao) return;
    estado.dias = Number(botao.dataset.dias);
    marcarChips();
    desenhar();
  });

  Array.prototype.forEach.call(document.querySelectorAll('.abas button'), function (botao) {
    botao.addEventListener('click', function () { trocarAba(botao.dataset.aba); });
  });

  /* Filtros da aba E-mails. */
  var chipsCampanha = document.getElementById('filtroCampanha');
  if (chipsCampanha) {
    chipsCampanha.addEventListener('click', function (evento) {
      var botao = evento.target.closest('button');
      if (!botao) return;
      estado.filtroCampanha = botao.dataset.filtro;
      Array.prototype.forEach.call(chipsCampanha.querySelectorAll('button'), function (b) {
        b.setAttribute('aria-pressed', String(b === botao));
      });
      desenharCampanha();
    });
  }

  /* Ordenação: clicar de novo na mesma coluna inverte o sentido. */
  Array.prototype.forEach.call(document.querySelectorAll('[data-ordem-campanha]'), function (celula) {
    celula.style.cursor = 'pointer';
    celula.addEventListener('click', function () {
      var alvo = celula.dataset.ordemCampanha;
      if (estado.ordemCampanha === alvo) estado.ordemCampanhaAsc = !estado.ordemCampanhaAsc;
      else { estado.ordemCampanha = alvo; estado.ordemCampanhaAsc = false; }
      desenharCampanha();
    });
  });

  document.getElementById('campoBusca').addEventListener('change', function (evento) {
    estado.campoBusca = evento.target.value;
    desenharTabela();
  });

  document.getElementById('filtroWebhook').addEventListener('change', function (evento) {
    estado.filtroWebhook = evento.target.value;
    desenharWebhooks();
  });

  document.getElementById('recarregarWebhooks').addEventListener('click', carregarWebhooks);

  document.getElementById('chipsAnuncios').addEventListener('click', function (evento) {
    var botao = evento.target.closest('button');
    if (!botao) return;
    estado.agrupamento = botao.dataset.agrupamento;
    // Trocar de nível pelo chip é começar de novo: o recorte antigo não vale.
    estado.paiAnuncios = null;
    estado.nomeDoPai = '';
    carregarAnuncios();
  });

  /*
   * Clicar numa linha desce um nível, levando o recorte junto.
   *
   * Campanha -> conjuntos daquela campanha -> anúncios daquele conjunto. Era
   * preciso trocar o chip e reconhecer o filho pelo nome no meio de todos os
   * outros; agora o caminho é o mesmo que a pessoa já faz no Gerenciador.
   */
  document.getElementById('corpoAnuncios').addEventListener('click', function (evento) {
    var linha = evento.target.closest('tr[data-descer]');
    if (!linha) return;
    // Clicar no campo de investimento não pode navegar: a pessoa está digitando.
    if (evento.target.closest('input, button, a')) return;

    var chave = linha.dataset.descer;
    var nome = linha.querySelector('.rotulo-anuncio');
    estado.paiAnuncios = chave;
    estado.nomeDoPai = nome ? nome.textContent.replace('›', '').trim() : '';
    estado.agrupamento = estado.agrupamento === 'campanha' ? 'conjunto' : 'anuncio';
    carregarAnuncios();
  });

  document.getElementById('chipsSecaoAnuncios').addEventListener('click', function (evento) {
    var botao = evento.target.closest('button');
    if (!botao) return;
    trocarSecaoDeAnuncios(botao.dataset.secao);
  });

  // Trocar de conjunto de colunas não busca nada: os dados já vieram todos.
  document.getElementById('chipsColunas').addEventListener('click', function (evento) {
    var botao = evento.target.closest('button');
    if (!botao) return;
    estado.colunasAnuncios = botao.dataset.colunas;
    Array.prototype.forEach.call(document.querySelectorAll('#chipsColunas button'), function (item) {
      item.setAttribute('aria-pressed', String(item.dataset.colunas === estado.colunasAnuncios));
    });
    desenharAnuncios();
  });

  document.getElementById('salvarMetaRoas').addEventListener('click', salvarMetaRoas);

  document.getElementById('periodoAnuncios').addEventListener('change', function (evento) {
    var periodo = lerPeriodo(evento.target.value);
    estado.diasAnuncios = periodo.dias;
    estado.ateAnuncios = periodo.ate;
    carregarAnuncios();
  });

  document.getElementById('recarregarAnuncios').addEventListener('click', function () {
    carregarAnuncios();
    carregarMeta();
  });

  document.getElementById('salvarAnuncios').addEventListener('click', salvarAnunciosMeta);
  document.getElementById('testarAnuncios').addEventListener('click', testarAnunciosMeta);
  document.getElementById('importarAnuncios').addEventListener('click', importarAnunciosMeta);

  document.getElementById('periodoFunil').addEventListener('change', function (evento) {
    var periodo = lerPeriodo(evento.target.value);
    estado.diasFunil = periodo.dias;
    estado.ateFunil = periodo.ate;
    carregarFunil();
  });

  document.getElementById('recarregarFunil').addEventListener('click', carregarFunil);

  document.getElementById('chipsPlataforma').addEventListener('click', function (evento) {
    var botao = evento.target.closest('button');
    if (!botao) return;
    estado.plataformaParam = botao.dataset.plataforma;
    desenharParametros();
  });

  document.getElementById('chipsFormato').addEventListener('click', function (evento) {
    var botao = evento.target.closest('button');
    if (!botao) return;
    estado.formatoParam = botao.dataset.formato;
    desenharParametros();
  });

  document.getElementById('copiarParametros').addEventListener('click', copiarParametros);
  document.getElementById('salvarPlanilha').addEventListener('click', salvarPlanilha);
  document.getElementById('salvarGrupo').addEventListener('click', salvarGrupo);
  document.getElementById('importarPlanilha').addEventListener('click', importarPlanilha);
  document.getElementById('salvarCredenciais').addEventListener('click', salvarCredenciais);
  document.getElementById('testarCredenciais').addEventListener('click', testarCredenciais);

  document.getElementById('filtroStatus').addEventListener('change', function (evento) {
    estado.status = evento.target.value;
    desenhar();
  });

  document.getElementById('filtroEmail').addEventListener('change', function (evento) {
    estado.email = evento.target.value;
    desenharTabela();
  });

  var temporizadorBusca;
  document.getElementById('busca').addEventListener('input', function (evento) {
    clearTimeout(temporizadorBusca);
    var valor = evento.target.value;
    temporizadorBusca = setTimeout(function () { estado.busca = valor; desenharTabela(); }, 150);
  });

  document.getElementById('botaoLimpar').addEventListener('click', function () {
    estado.busca = '';
    estado.status = 'todos';
    estado.campoBusca = 'tudo';
    estado.email = 'todos';
    document.getElementById('busca').value = '';
    document.getElementById('filtroStatus').value = 'todos';
    document.getElementById('campoBusca').value = 'tudo';
    document.getElementById('filtroEmail').value = 'todos';
    desenhar();
  });

  document.getElementById('verFilhos').addEventListener('change', function (evento) {
    estado.verFilhos = evento.target.checked;
    desenharTabela();
  });

  Array.prototype.forEach.call(document.querySelectorAll('th[data-ordem]'), function (coluna) {
    coluna.addEventListener('click', function () {
      var campo = coluna.dataset.ordem;
      if (estado.ordem.campo === campo) estado.ordem.desc = !estado.ordem.desc;
      else estado.ordem = { campo: campo, desc: campo === 'data' || campo === 'valor' };
      desenharTabela();
    });
  });

  document.getElementById('botaoVerificar').addEventListener('click', function () {
    var botao = this;
    botao.disabled = true;
    botao.textContent = 'Verificando...';
    api('/admin/verificar-pendentes', { method: 'POST' })
      .then(function (dados) {
        botao.textContent = dados.pagosNovos > 0
          ? dados.pagosNovos + ' novos pagos!'
          : 'Nenhum novo pagamento';
        return carregar();
      })
      .catch(function (falha) { botao.textContent = falha.message.slice(0, 40); })
      .finally(function () {
        setTimeout(function () {
          botao.disabled = false;
          botao.textContent = 'Verificar pendentes';
        }, 3500);
      });
  });

  document.addEventListener('keydown', function (evento) {
    if (evento.key === 'Escape' && document.getElementById('fundoModal')) fecharModal();
  });

  // Só atualiza sozinho com a aba visível: nada de gastar bateria em segundo plano.
  setInterval(function () {
    if (!document.hidden && estado.token && !document.getElementById('fundoModal')) carregar();
  }, INTERVALO_ATUALIZACAO);

  /*
   * O relógio do plantão, separado da busca de dados.
   *
   * Os minutos precisam correr na tela mesmo entre uma atualização e outra:
   * quem está de plantão espera justamente o pedido cruzar os cinco minutos, e
   * um contador que só anda de trinta em trinta segundos faz a linha acender
   * tarde. Redesenhar é barato — os dados já estão na memória.
   */
  setInterval(function () {
    if (document.hidden || !estado.token || estado.aba !== 'cobranca') return;
    if (document.getElementById('fundoModal')) return;
    desenharAgora();
  }, 10000);
}


/* --------------------------------------------------------------- TikTok -- */

/*
 * A aba TikTok: pixel, token da API de Eventos e os parâmetros aceitos da URL.
 *
 * Separada da aba Anúncios (que é do Meta) porque as duas plataformas divergem
 * no que importa — sintaxe de macro, lista de eventos e o padrão do interruptor.
 * Numa tela só, o dono editaria o pixel de uma achando que era o da outra.
 */
function carregarTiktok() {
  api('/admin/tiktok/credenciais')
    .then(function (dados) {
      estado.tiktok = dados;
      desenharTiktok();
    })
    .catch(function () {
      /* Calado de propósito, igual ao carregarCredenciais do Meta: a aba abre
         mesmo sem o dado, e um alerta na abertura de aba treina o dono a fechar
         alerta sem ler. O aviso que importa aparece no salvar. */
    });
}

function desenharTiktok() {
  var d = estado.tiktok;
  if (!d) return;

  document.getElementById('tiktokPixel').value = d.pixelId || '';
  document.getElementById('tiktokLigado').checked = Boolean(d.ligado);
  document.getElementById('tiktokParametros').value = (d.parametros || []).join('\n');

  var estadoToken = document.getElementById('tiktokTokenEstado');
  var campoToken = document.getElementById('tiktokToken');
  if (!d.podeGuardarToken) {
    /* Sem PAINEL_CHAVE_MESTRA não há como cifrar. Desabilitar é melhor que
       aceitar: token em texto puro no banco vaza junto no primeiro dump. */
    campoToken.disabled = true;
    estadoToken.textContent = 'Sem PAINEL_CHAVE_MESTRA no servidor não há como cifrar o token, então o campo fica travado.';
  } else if (d.tokenIlegivel) {
    /* Havia token guardado e ele não abriu: a chave mestra mudou. Só dizer
       "erro" faria o dono procurar defeito no TikTok, que está inteiro. */
    estadoToken.textContent = 'Há um token guardado que não abre — a PAINEL_CHAVE_MESTRA mudou desde que ele foi salvo. Cole o token de novo.';
  } else if (d.tokenMascarado) {
    estadoToken.textContent = 'Guardado: ' + d.tokenMascarado;
  } else {
    estadoToken.textContent = 'Nenhum token guardado. O pixel do navegador funciona sem ele; o token serve para a API de Eventos, pelo servidor.';
  }

  var aviso = document.getElementById('tiktokAviso');
  if (!d.pixelId) {
    aviso.hidden = false;
    aviso.textContent = 'Nenhum pixel configurado: o TikTok não recebe evento nenhum.';
  } else if (!d.ligado) {
    aviso.hidden = false;
    aviso.textContent = 'Pixel cadastrado mas DESLIGADO: nada está sendo enviado ao TikTok.';
  } else {
    aviso.hidden = true;
  }

  desenharUrlDoTiktok();
}

/*
 * As macros que o TikTok Ads Manager substitui na URL de destino.
 *
 * O mapa é explícito, e não derivado do nome do parâmetro, porque as macros do
 * TikTok não seguem padrão nenhum: o id do grupo de anúncios é `__AID__` e o do
 * anúncio é `__CID__` — as letras não batem com os nomes. Adivinhar aqui gera
 * URL que parece certa e chega vazia no relatório.
 */
var MACRO_DO_TIKTOK = {
  tt_campaign_id: '__CAMPAIGN_ID__',
  tt_adgroup_id: '__AID__',
  tt_ad_id: '__CID__',
  tt_placement: '__PLACEMENT__',
  tt_source: '__CID_NAME__',
};

function desenharUrlDoTiktok() {
  var d = estado.tiktok;
  if (!d) return;
  var partes = ['utm_source=tiktok', 'utm_medium=paid'];
  (d.parametros || []).forEach(function (nome) {
    /* O `ttclid` NÃO entra: o TikTok o acrescenta sozinho no clique, e escrevê-lo
       na URL sobrescreve o valor real por um literal inútil. Igual ao fbclid. */
    if (nome === 'ttclid') return;
    if (MACRO_DO_TIKTOK[nome]) partes.push(nome + '=' + MACRO_DO_TIKTOK[nome]);
  });
  document.getElementById('tiktokUrlExemplo').textContent = partes.join('&');
}

function salvarTiktok() {
  var pixel = document.getElementById('tiktokPixel').value.trim();
  var token = document.getElementById('tiktokToken').value;
  var ligado = document.getElementById('tiktokLigado').checked;
  var parametros = document.getElementById('tiktokParametros').value
    .split('\n')
    .map(function (l) { return l.trim().toLowerCase(); })
    .filter(function (l) { return l !== ''; });

  var corpo = { pixelId: pixel, ligado: ligado, parametros: parametros };
  /* Campo de token vazio NÃO apaga o que está guardado: quem só quis mexer no
     interruptor perderia a credencial sem perceber. */
  if (token !== '') corpo.token = token;

  var botao = document.getElementById('botaoSalvarTiktok');
  botao.disabled = true;
  api('/admin/tiktok/credenciais', { method: 'POST', body: corpo })
    .then(function (dados) {
      estado.tiktok = dados;
      document.getElementById('tiktokToken').value = '';
      document.getElementById('tiktokSalvo').textContent = 'Salvo.';
      desenharTiktok();
      setTimeout(function () { document.getElementById('tiktokSalvo').textContent = ''; }, 4000);
    })
    .catch(function (erro) {
      document.getElementById('tiktokSalvo').textContent = erro.message || 'Não consegui salvar.';
    })
    .finally(function () { botao.disabled = false; });
}

function ligarEventosDoTiktok() {
  var salvar = document.getElementById('botaoSalvarTiktok');
  if (salvar) salvar.addEventListener('click', salvarTiktok);

  var padrao = document.getElementById('botaoParametrosPadrao');
  if (padrao) padrao.addEventListener('click', function () {
    var d = estado.tiktok;
    if (!d) return;
    document.getElementById('tiktokParametros').value = (d.parametrosPadrao || []).join('\n');
    d.parametros = (d.parametrosPadrao || []).slice();
    desenharUrlDoTiktok();
  });

  var campoParams = document.getElementById('tiktokParametros');
  if (campoParams) campoParams.addEventListener('input', function () {
    /* Redesenha a URL enquanto o dono digita: ver o resultado na hora é o que
       evita salvar uma lista e só descobrir depois que faltava um parâmetro. */
    if (!estado.tiktok) return;
    estado.tiktok.parametros = campoParams.value.split('\n')
      .map(function (l) { return l.trim().toLowerCase(); })
      .filter(function (l) { return l !== ''; });
    desenharUrlDoTiktok();
  });

  var copiar = document.getElementById('botaoCopiarUrlTiktok');
  if (copiar) copiar.addEventListener('click', function () {
    var texto = document.getElementById('tiktokUrlExemplo').textContent || '';
    copiar(texto).then(function () {
      document.getElementById('tiktokUrlCopiada').textContent = 'Copiado.';
      setTimeout(function () { document.getElementById('tiktokUrlCopiada').textContent = ''; }, 3000);
    });
  });
}


function ligarFiltrosDeAnuncios() {
  var chips = document.getElementById('chipsBm');
  if (chips) chips.addEventListener('click', function (evento) {
    var botao = evento.target.closest('button[data-bm]');
    if (!botao) return;
    estado.bmAnuncios = botao.dataset.bm || '';
    /* Recarrega: a BM filtra no BANCO, entao os numeros mudam de verdade --
       nao da para so esconder linhas na tela. */
    carregarAnuncios();
  });

  var roas = document.getElementById('filtroRoas');
  if (roas) roas.addEventListener('change', function () {
    estado.filtroRoas = roas.value;
    /* Nao recarrega: as linhas ja estao na memoria e o recorte e local. */
    desenharAnuncios();
  });
}


/* ------------------------------------------------------------------ BMs -- */

/*
 * A aba BMs: como cada gerenciador esta se saindo, e o cadastro de cada um.
 *
 * As duas coisas na MESMA tela de proposito. A unica pergunta que o dono faz
 * sobre uma BM e "esta pagando?", e responde-la olhando resultado numa tela e
 * configuracao noutra e o tipo de atrito que faz o painel deixar de ser aberto.
 */
function carregarBms() {
  return api('/admin/bms?dias=' + estado.diasBms + '&t=' + Date.now())
    .then(function (dados) {
      estado.bms = dados;
      /* O rascunho so nasce da primeira carga. Recarregar por cima do que o dono
         esta digitando apagaria a BM que ele acabou de acrescentar. */
      if (!estado.rascunhoBms) {
        estado.rascunhoBms = dados.bms
          .filter(function (b) { return b.cadastrada; })
          .map(function (b) {
            return { slug: b.slug, nome: b.nome, pixelId: b.pixelId, contaAds: b.contaAds, ativa: b.ativa, token: '' };
          });
      }
      desenharBms();
    })
    .catch(function () {
      /* Calado, como as outras abas: a tela abre mesmo sem o dado. */
    });
}

function desenharBms() {
  var d = estado.bms;
  if (!d) return;

  Array.prototype.forEach.call(document.querySelectorAll('#chipsPeriodoBms button'), function (b) {
    b.setAttribute('aria-pressed', String(Number(b.dataset.dias) === estado.diasBms));
  });

  /*
   * As colunas de dinheiro só aparecem quando existe gasto carimbado.
   *
   * Uma coluna de ROAS sempre vazia parece importação falhada; uma cheia de
   * zeros parece prejuízo. Enquanto nenhum gasto tiver o carimbo da BM, a
   * tabela fica com as colunas de tráfego e o aviso explica o resto.
   */
  var temDinheiro = d.temInvestimentoPorBm;
  var colunas = ['Gerenciador', 'Visitas', 'Quiz', 'VSL', 'Checkout', 'PIX', 'Vendas', 'Receita']
    .concat(temDinheiro ? ['Investido', 'ROAS', 'Lucro'] : [])
    .concat(['Conv.']);
  document.getElementById('cabecalhoBms').innerHTML =
    colunas.map(function (c, i) { return '<th' + (i ? ' class="num"' : '') + '>' + c + '</th>'; }).join('');

  var corpo = document.getElementById('corpoBms');
  if (!d.bms.length) {
    corpo.innerHTML = '<tr><td colspan="9" class="vazio">Nenhuma visita no período.</td></tr>';
  } else {
    corpo.innerHTML = d.bms.map(function (b) {
      /* Conversao de VISITA em venda -- e nao de checkout em venda. E a taxa que
         compara BMs de forma justa: uma BM que traz trafego ruim tem checkout
         bonito e visita horrivel, e olhar so o checkout premiaria ela. */
      var conv = b.visitas ? (b.vendas / b.visitas) : null;
      var rotulo = escapar(b.nome || b.slug || '(sem BM)');
      /* BM que aparece nos dados sem estar cadastrada quase sempre e carimbo
         digitado errado no anuncio. Dizer isso na hora poupa a caçada. */
      var alerta = b.cadastrada || !b.slug ? '' :
        ' <span class="selo-alerta" title="Aparece nos anúncios mas não está cadastrada abaixo — confira se o bm= do anúncio está escrito certo">não cadastrada</span>';
      var apagada = b.cadastrada && !b.ativa ? ' style="opacity:.55"' : '';

      return '<tr class="clicavel" data-bm="' + escapar(b.slug) + '"' + apagada + '>' +
        '<td>' + rotulo + alerta + '</td>' +
        '<td class="num">' + b.visitas + '</td>' +
        '<td class="num">' + b.quiz + '</td>' +
        '<td class="num">' + b.vsl + '</td>' +
        '<td class="num">' + b.checkout + '</td>' +
        '<td class="num">' + b.pixGerados + '</td>' +
        '<td class="num">' + b.vendas + '</td>' +
        '<td class="num">' + brl(b.receitaCentavos) + '</td>' +
        (temDinheiro
          ? '<td class="num">' + brl(b.investimentoCentavos) + '</td>' +
            /* Abaixo da meta de ROAS o número fica vermelho: é o corte que decide
               se a verba continua nesta conta amanhã. */
            '<td class="num' + (b.roas !== null && b.roas < d.metaRoas ? ' ruim' : '') + '">' +
              (b.roas === null ? '—' : b.roas.toFixed(2).replace('.', ',') + 'x') + '</td>' +
            '<td class="num' + (b.lucroCentavos < 0 ? ' ruim' : '') + '">' + brl(b.lucroCentavos) + '</td>'
          : '') +
        '<td class="num">' + (conv === null ? '—' : (conv * 100).toFixed(2) + '%') + '</td>' +
        '</tr>';
    }).join('');
  }

  var t = d.totais;
  document.getElementById('rodapeBms').innerHTML =
    '<th>Todas</th>' +
    ['visitas', 'quiz', 'vsl', 'checkout', 'pixGerados', 'vendas'].map(function (k) {
      return '<th class="num">' + t[k] + '</th>';
    }).join('') +
    '<th class="num">' + brl(t.receitaCentavos) + '</th>' +
    (temDinheiro
      ? '<th class="num">' + brl(t.investimentoCentavos) + '</th>' +
        '<th class="num">' + (t.investimentoCentavos > 0
          ? (t.receitaCentavos / t.investimentoCentavos).toFixed(2).replace('.', ',') + 'x' : '—') + '</th>' +
        '<th class="num">' + brl(t.lucroCentavos) + '</th>'
      : '') +
    '<th class="num">' + (t.visitas ? (t.vendas / t.visitas * 100).toFixed(2) + '%' : '—') + '</th>';

  /*
   * O aviso sobre o investimento existe para a tela nao mentir por omissao.
   *
   * O gasto importado do Meta vem por CAMPANHA e nao carrega a BM, entao nao ha
   * como reparti-lo entre gerenciadores hoje. Mostrar uma coluna de ROAS vazia
   * faria o dono achar que faltou importar; nao dizer nada faria ele achar que
   * a receita ja esta liquida. A frase resolve os dois.
   */
  document.getElementById('avisoBms').textContent = !d.temInvestimentoPorBm
    ? 'Nenhum gasto carimbado ainda: os valores acima são receita bruta, sem descontar mídia. '
      + 'Cadastre a conta de anúncios e o token de cada BM abaixo e clique em "Importar gasto de cada BM".'
    : d.custosConfigurados
      ? ''
      : 'O Lucro acima desconta só a mídia: taxa do gateway e imposto ainda não foram preenchidos '
        + 'em Resumo → "Quanto custa vender". Ele está MAIOR que o real.';

  desenharCadastroBms();
}

function desenharCadastroBms() {
  var lista = estado.rascunhoBms || [];
  var podeToken = estado.bms ? estado.bms.podeGuardarToken : false;

  document.getElementById('corpoCadastroBms').innerHTML = lista.map(function (b, i) {
    var salva = estado.bms.bms.find(function (x) { return x.slug === b.slug; }) || {};
    var guardado = salva.tokenMascarado || '';
    var guardadoAds = salva.tokenAdsMascarado || '';
    return '<tr>' +
      '<td><input data-campo="slug" data-i="' + i + '" value="' + escapar(b.slug) + '" placeholder="bm1" style="width:90px"></td>' +
      '<td><input data-campo="nome" data-i="' + i + '" value="' + escapar(b.nome) + '" placeholder="Escala" style="width:120px"></td>' +
      '<td><input data-campo="pixelId" data-i="' + i + '" value="' + escapar(b.pixelId) + '" placeholder="só números" style="width:150px"></td>' +
      '<td><input data-campo="contaAds" data-i="' + i + '" value="' + escapar(b.contaAds) + '" placeholder="act_123" style="width:130px"></td>' +
      '<td><input data-campo="token" data-i="' + i + '" type="password" value="" placeholder="' +
        (podeToken ? (guardado ? escapar(guardado) : 'do Ger. de Eventos') : 'sem chave mestra') + '"' +
        (podeToken ? '' : ' disabled') + ' style="width:130px"></td>' +
      '<td><input data-campo="tokenAds" data-i="' + i + '" type="password" value="" placeholder="' +
        (podeToken ? (guardadoAds ? escapar(guardadoAds) : 'com ads_read') : 'sem chave mestra') + '"' +
        (podeToken ? '' : ' disabled') + ' style="width:130px"></td>' +
      '<td><input data-campo="ativa" data-i="' + i + '" type="checkbox"' + (b.ativa ? ' checked' : '') + '></td>' +
      '<td><button class="botao-icone" data-remover="' + i + '">remover</button></td>' +
      '</tr>';
  }).join('') || '<tr><td colspan="8" class="vazio">Nenhuma BM cadastrada. Clique em "Adicionar BM".</td></tr>';

  var seletor = document.getElementById('bmParaUrl');
  seletor.innerHTML = lista.map(function (b) {
    return '<option value="' + escapar(b.slug) + '">' + escapar(b.nome || b.slug) + '</option>';
  }).join('');
  desenharUrlDaBm();
}

/*
 * A URL de parâmetros da BM escolhida.
 *
 * As macros são as do Meta (`{{campaign.id}}`), não as do TikTok (`__CID__`) —
 * esta aba é de gerenciadores do Meta. Misturar as duas sintaxes faz o parâmetro
 * chegar literal e o relatório encher de linhas sem sentido, sem nada acusar erro.
 */
function desenharUrlDaBm() {
  var seletor = document.getElementById('bmParaUrl');
  var slug = seletor && seletor.value ? seletor.value : 'bm1';
  document.getElementById('urlDaBm').textContent =
    'bm=' + slug +
    '&utm_source=facebook&utm_medium=paid' +
    '&utm_campaign={{campaign.name}}&utm_term={{adset.name}}&utm_content={{ad.name}}' +
    '&fb_campaign_id={{campaign.id}}&fb_adset_id={{adset.id}}&fb_ad_id={{ad.id}}' +
    '&fb_placement={{placement}}&fb_source={{site_source_name}}';
}

function salvarBms() {
  var lista = estado.rascunhoBms || [];
  var tokens = {};
  var tokensAds = {};
  lista.forEach(function (b) {
    if (b.token) tokens[b.slug] = b.token;
    if (b.tokenAds) tokensAds[b.slug] = b.tokenAds;
  });

  var botao = document.getElementById('botaoSalvarBms');
  botao.disabled = true;
  api('/admin/bms', {
    method: 'POST',
    body: {
      bms: lista.map(function (b) {
        return { slug: b.slug, nome: b.nome, pixelId: b.pixelId, contaAds: b.contaAds, ativa: b.ativa };
      }),
      tokensAds: tokensAds,
      tokens: tokens,
    },
  })
    .then(function () {
      /* Limpa o rascunho para a proxima carga vir do servidor -- e so assim o
         dono ve o que o saneamento fez com o que ele digitou. */
      estado.rascunhoBms = null;
      document.getElementById('bmsSalvo').textContent = 'Salvo.';
      setTimeout(function () { document.getElementById('bmsSalvo').textContent = ''; }, 4000);
      return carregarBms();
    })
    .catch(function (erro) {
      document.getElementById('bmsSalvo').textContent = erro.message || 'Não consegui salvar.';
    })
    .finally(function () { botao.disabled = false; });
}

function ligarEventosDeBms() {
  var chips = document.getElementById('chipsPeriodoBms');
  if (chips) chips.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-dias]');
    if (!b) return;
    estado.diasBms = Number(b.dataset.dias);
    carregarBms();
  });

  var atualizar = document.getElementById('recarregarBms');
  if (atualizar) atualizar.addEventListener('click', function () { carregarBms(); });

  var importar = document.getElementById('importarGastoBms');
  if (importar) importar.addEventListener('click', function () {
    var aviso = document.getElementById('avisoImportacaoBms');
    importar.disabled = true;
    aviso.textContent = 'Falando com o Meta, conta por conta…';
    api('/admin/bms/importar-gasto', { method: 'POST', body: { dias: estado.diasBms || 7 } })
      .then(function (dados) {
        /*
         * A mensagem vem PRONTA do servidor, inclusive quando só parte das
         * contas respondeu. Remontá-la aqui espalharia a regra de "importação
         * parcial" por dois lugares, e um deles ficaria para trás.
         */
        aviso.textContent = dados.mensagem;
        return carregarBms();
      })
      .catch(function (falha) { aviso.textContent = falha.message; })
      .then(function () { importar.disabled = false; });
  });

  /* Clicar na linha leva para a aba Anuncios ja filtrada naquela BM: e o
     caminho que o dono percorre depois de ver qual BM esta ruim. */
  var corpo = document.getElementById('corpoBms');
  if (corpo) corpo.addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-bm]');
    if (!tr || !tr.dataset.bm) return;
    estado.bmAnuncios = tr.dataset.bm;
    estado.paiAnuncios = null;
    trocarAba('anuncios');
    carregarAnuncios();
  });

  var cadastro = document.getElementById('corpoCadastroBms');
  if (cadastro) {
    cadastro.addEventListener('input', function (e) {
      var campo = e.target.dataset.campo;
      if (!campo) return;
      var linha = estado.rascunhoBms[Number(e.target.dataset.i)];
      if (!linha) return;
      linha[campo] = campo === 'ativa' ? e.target.checked : e.target.value;
    });
    cadastro.addEventListener('change', function (e) {
      if (e.target.dataset.campo !== 'ativa') return;
      var linha = estado.rascunhoBms[Number(e.target.dataset.i)];
      if (linha) linha.ativa = e.target.checked;
    });
    cadastro.addEventListener('click', function (e) {
      var botao = e.target.closest('button[data-remover]');
      if (!botao) return;
      estado.rascunhoBms.splice(Number(botao.dataset.remover), 1);
      desenharCadastroBms();
    });
  }

  var nova = document.getElementById('botaoNovaBm');
  if (nova) nova.addEventListener('click', function () {
    if (!estado.rascunhoBms) estado.rascunhoBms = [];
    estado.rascunhoBms.push({
      slug: 'bm' + (estado.rascunhoBms.length + 1),
      nome: '', pixelId: '', contaAds: '', ativa: true, token: '',
    });
    desenharCadastroBms();
  });

  var salvar = document.getElementById('botaoSalvarBms');
  if (salvar) salvar.addEventListener('click', salvarBms);

  var seletor = document.getElementById('bmParaUrl');
  if (seletor) seletor.addEventListener('change', desenharUrlDaBm);

  var copiar = document.getElementById('botaoCopiarUrlBm');
  if (copiar) copiar.addEventListener('click', function () {
    copiar_(document.getElementById('urlDaBm').textContent || '');
  });
}

function copiar_(texto) {
  copiar(texto).then(function () {
    document.getElementById('urlBmCopiada').textContent = 'Copiado.';
    setTimeout(function () { document.getElementById('urlBmCopiada').textContent = ''; }, 3000);
  });
}

function iniciar() {
  try {
    estado.token = sessionStorage.getItem(CHAVE_TOKEN);
    estado.cobrados = JSON.parse(localStorage.getItem(CHAVE_COBRADOS) || '{}');
  } catch (e) {
    estado.cobrados = {};
  }

  ligarEventos();
  ligarEventosDoTiktok();
  ligarFiltrosDeAnuncios();
  ligarEventosDeBms();
  marcarChips();

  if (estado.token) abrirPainel();
  else document.getElementById('senha').focus();
}

iniciar();
