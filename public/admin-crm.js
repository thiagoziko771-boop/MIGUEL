/* ======================================================================== */
/* CRM (15/08/2026)                                                          */
/*                                                                          */
/* Camada de leitura sobre eventos + pedidos, servida por /admin/crm/*      */
/* (server/crm.ts). Uma pessoa = uma sessão do funil. Tudo que aparece aqui  */
/* já existia no banco; só nota e marcação manual são próprias do CRM.       */
/*                                                                          */
/* Arquivo separado do admin.js de propósito: ele reaproveita os helpers de  */
/* lá (api, escapar, brl, dataCurta, haQuanto, digitos, cartaoKpi,           */
/* fecharModal, estado) e é carregado DEPOIS dele pelo admin.html.           */
/* ======================================================================== */

/* global estado, api, escapar, brl, dataCurta, dataCompleta, haQuanto, digitos, cartaoKpi, fecharModal, trocarAba */

estado.crm = {
  secao: 'visao',
  periodo: '1|hoje',
  compra: '',
  segmento: '',
  busca: '',
  anuncio: '',
  soPedido: false,
  diasReciprocidade: '',
  resumo: null,
  leads: [],
  fila: [],
  carregado: false,
  carregando: false,
};

var ROTULO_STATUS_CRM = {
  novo: 'Novo',
  pedido_recebido: 'Pedido recebido',
  quiz_em_andamento: 'Quiz',
  oferta: 'Oferta',
  pix_gerado: 'PIX gerado',
  pix_pendente: 'PIX pendente',
  pago: 'Pago',
  recuperacao: 'Recuperação',
  reciprocidade: 'Reciprocidade',
  finalizado: 'Finalizado',
  opt_out: 'Opt-out',
};

var ROTULO_SEGMENTO_CRM = {
  FLUXO_NORMAL: 'Fluxo normal',
  RECUPERACAO_DE_COBRANCA: 'Recuperação de cobrança',
  RECUPERACAO_DE_INTERESSE: 'Pediu e parou',
  RECIPROCIDADE: 'Reciprocidade',
  CLIENTE: 'Cliente',
  CLIENTE_UPSELL: 'Cliente + upsell',
  NAO_CONTATAR: 'Não contatar',
  SEM_CONTATO: 'Sem contato',
};

var ROTULO_ETAPA_CRM = {
  pedido: 'Pedido',
  quiz: 'Quiz',
  analise: 'Análise',
  oferta: 'Oferta',
  checkout: 'Checkout',
  pix: 'PIX',
  compra: 'Compra',
};

function classeStatusCrm(status) {
  if (status === 'pago') return 'pago';
  if (status === 'opt_out') return 'cancelado';
  if (status === 'pix_pendente' || status === 'pix_gerado') return 'pendente';
  if (status === 'reciprocidade') return 'expirado';
  return '';
}

function badgeCrm(texto, classe) {
  return '<span class="badge ' + (classe || '') + '">' + escapar(texto) + '</span>';
}

function telefoneFmtCrm(t) {
  var d = digitos(t);
  if (d.length === 11) return '(' + d.slice(0, 2) + ') ' + d.slice(2, 7) + '-' + d.slice(7);
  if (d.length === 10) return '(' + d.slice(0, 2) + ') ' + d.slice(2, 6) + '-' + d.slice(6);
  return t || '';
}

function queryDoPeriodoCrm() {
  var partes = estado.crm.periodo.split('|');
  return 'dias=' + encodeURIComponent(partes[0]) + '&ate=' + encodeURIComponent(partes[1] || 'hoje');
}

function queryDosFiltrosCrm() {
  var c = estado.crm;
  var partes = [];
  if (c.compra) partes.push('compra=' + encodeURIComponent(c.compra));
  if (c.segmento) partes.push('segmento=' + encodeURIComponent(c.segmento));
  if (c.busca) partes.push('busca=' + encodeURIComponent(c.busca));
  if (c.anuncio) partes.push('anuncio=' + encodeURIComponent(c.anuncio));
  if (c.soPedido) partes.push('soComPedido=1');
  return partes.join('&');
}

function carregarCrm() {
  if (estado.crm.carregando) return Promise.resolve();
  estado.crm.carregando = true;
  var q = queryDoPeriodoCrm();
  var chamadas = [api('/admin/crm/resumo?' + q)];
  if (estado.crm.secao === 'leads') chamadas.push(api('/admin/crm/leads?' + q + '&' + queryDosFiltrosCrm()));
  if (estado.crm.secao === 'reciprocidade') chamadas.push(api('/admin/crm/reciprocidade?' + q));

  return Promise.all(chamadas)
    .then(function (respostas) {
      estado.crm.resumo = respostas[0];
      if (estado.crm.secao === 'leads') estado.crm.leads = respostas[1].leads;
      if (estado.crm.secao === 'reciprocidade') estado.crm.fila = respostas[1].fila;
      estado.crm.carregado = true;
      desenharCrm();
    })
    .catch(function (erro) {
      var r = document.getElementById('resumoCrm');
      if (r) r.textContent = 'Não consegui carregar o CRM: ' + erro.message;
    })
    .then(function () { estado.crm.carregando = false; });
}

function desenharCrm() {
  var r = estado.crm.resumo;
  document.getElementById('secaoCrmVisao').hidden = estado.crm.secao !== 'visao';
  document.getElementById('secaoCrmLeads').hidden = estado.crm.secao !== 'leads';
  document.getElementById('secaoCrmReciprocidade').hidden = estado.crm.secao !== 'reciprocidade';
  Array.prototype.forEach.call(document.querySelectorAll('#chipsSecaoCrm button'), function (b) {
    b.setAttribute('aria-pressed', String(b.dataset.secao === estado.crm.secao));
  });
  if (!r) return;

  document.getElementById('resumoCrm').textContent =
    'Período ' + r.periodo.diaInicial.split('-').reverse().join('/') + ' a ' + r.periodo.diaFinal.split('-').reverse().join('/') +
    ' · ' + r.cards.totalDeLeads + ' pessoas';

  var k = r.cards;
  document.getElementById('kpisCrm').innerHTML =
    cartaoKpi('Pessoas', String(k.totalDeLeads), 'passaram da capa ou pediram') +
    cartaoKpi('Pedidos de oração', String(k.pedidosDeOracao), '') +
    cartaoKpi('Quiz iniciado', String(k.quizIniciado), '') +
    cartaoKpi('Oferta vista', String(k.ofertaVisualizada), '') +
    cartaoKpi('PIX gerado', String(k.pixGerado), '') +
    cartaoKpi('PIX pendente', String(k.pixPendente), 'na recuperação de cobrança') +
    cartaoKpi('Compradores', String(k.compradores), '', 'positivo') +
    cartaoKpi('Não compraram', String(k.naoCompradores), '') +
    cartaoKpi('Em recuperação', String(k.emRecuperacao), 'PIX vivo ou < 24 h') +
    cartaoKpi('Em reciprocidade', String(k.emReciprocidade), 'pediram e não pagaram') +
    cartaoKpi('Receita', brl(k.receitaCentavos), '', 'positivo') +
    cartaoKpi('Ticket médio', brl(k.ticketMedioCentavos), 'por comprador') +
    cartaoKpi('Receita por pessoa', brl(k.receitaPorLeadCentavos), '') +
    cartaoKpi('Receita por visita', brl(k.receitaPorVisitanteCentavos), '');

  var f = r.funil;
  var topo = f[0] && f[0].quantidade ? f[0].quantidade : 0;
  document.getElementById('funilCrm').innerHTML = f.map(function (e, i) {
    var anterior = i > 0 ? f[i - 1].quantidade : null;
    var passagem = anterior ? Math.round((e.quantidade / anterior) * 100) : null;
    var largura = topo ? Math.max(3, Math.round((e.quantidade / topo) * 100)) : 0;
    return '<div style="display:grid;grid-template-columns:150px 1fr 160px;gap:10px;align-items:center;padding:6px 0">' +
      '<div>' + escapar(e.etapa) + '</div>' +
      '<div style="background:var(--color-sutil,#f2f2f2);border-radius:6px;height:14px;overflow:hidden"><div style="height:100%;width:' + largura + '%;background:var(--color-ouro,#A89060)"></div></div>' +
      '<div><strong>' + e.quantidade + '</strong>' + (passagem !== null ? ' <span class="nota">(' + passagem + '% da anterior)</span>' : '') + '</div>' +
      '</div>';
  }).join('');

  var s = r.porSegmento;
  document.getElementById('segmentosCrm').innerHTML =
    '<div class="kpis kpis-anuncios">' +
    Object.keys(s).map(function (chave) {
      return cartaoKpi(ROTULO_SEGMENTO_CRM[chave] || chave, String(s[chave]), '', chave === 'CLIENTE' || chave === 'CLIENTE_UPSELL' ? 'positivo' : '');
    }).join('') + '</div>';
  document.getElementById('regraCrm').textContent =
    'Regra: PIX gerado → lembrete em ' + r.regra.minutosAteLembrete + ' min (preço cheio) → após ' + r.regra.horasDeRecuperacaoAntesDaReciprocidade +
    ' h sem pagar, quem pediu oração vai para a reciprocidade. Quem paga sai de todos os grupos na hora.';

  if (estado.crm.secao === 'leads') desenharLeadsCrm();
  if (estado.crm.secao === 'reciprocidade') desenharReciprocidadeCrm();
}

function celulaPessoaCrm(l) {
  var nome = l.contato.nome || '(sem nome)';
  var sub = [l.contato.email, l.contato.telefone ? telefoneFmtCrm(l.contato.telefone) : ''].filter(Boolean).join(' · ');
  return '<div><strong>' + escapar(nome) + '</strong><div class="nota">' + escapar(sub || 'sem contato') + '</div></div>';
}

function desenharLeadsCrm() {
  var corpo = document.getElementById('corpoCrm');
  var leads = estado.crm.leads;
  document.getElementById('vazioCrm').hidden = leads.length > 0;
  corpo.innerHTML = leads.map(function (l) {
    var pedido = l.pedidoDeOracao ? (l.pedidoDeOracao.length > 70 ? l.pedidoDeOracao.slice(0, 70) + '…' : l.pedidoDeOracao) : '—';
    return '<tr class="clicavel" data-sessao="' + escapar(l.sessionId) + '" style="cursor:pointer">' +
      '<td>' + celulaPessoaCrm(l) + '</td>' +
      '<td title="' + escapar(l.pedidoDeOracao || '') + '">' + escapar(pedido) + '</td>' +
      '<td>' + escapar(dataCurta(l.entradaEm)) + '</td>' +
      '<td>' + escapar((l.origem.anuncio || l.origem.utm_source || 'direto').split(' [')[0]) + '</td>' +
      '<td>' + escapar(ROTULO_ETAPA_CRM[l.etapaMaxima] || l.etapaMaxima) + '</td>' +
      '<td>' + (l.gerouPix ? 'sim' : '—') + '</td>' +
      '<td>' + (l.pagou ? '<strong>' + brl(l.valorPagoCentavos) + '</strong>' : '—') + '</td>' +
      '<td>' + badgeCrm(ROTULO_STATUS_CRM[l.status] || l.status, classeStatusCrm(l.status)) + '</td>' +
      '<td>' + escapar(ROTULO_SEGMENTO_CRM[l.segmento] || l.segmento) + '</td>' +
      '<td>' + escapar(l.ultimoContatoEm ? haQuanto(l.ultimoContatoEm) : '—') + '</td>' +
      '<td class="nota">' + escapar(l.proximaAcao) + '</td>' +
      '</tr>';
  }).join('');
}

function desenharReciprocidadeCrm() {
  var corpo = document.getElementById('corpoReciprocidade');
  var fila = estado.crm.fila.filter(function (l) {
    var d = estado.crm.diasReciprocidade;
    if (d === '') return true;
    if (d === 'sem') return !l.jaContatado;
    if (d === 'com') return l.jaContatado;
    var n = Number(d);
    if (n === 3) return (l.diasDesdeOPedido || 0) >= 3;
    return l.diasDesdeOPedido === n;
  });
  document.getElementById('vazioReciprocidade').hidden = fila.length > 0;
  corpo.innerHTML = fila.map(function (l) {
    var ped = l.pedidoDeOracao || '';
    return '<tr class="clicavel" data-sessao="' + escapar(l.sessionId) + '" style="cursor:pointer">' +
      '<td><strong>' + escapar(l.contato.nome || '(sem nome)') + '</strong><div class="nota">' + escapar(l.contato.email) + '</div></td>' +
      '<td>' + escapar(telefoneFmtCrm(l.contato.telefone) || '—') + '</td>' +
      '<td title="' + escapar(ped) + '">' + escapar(ped.slice(0, 60)) + (ped.length > 60 ? '…' : '') + '</td>' +
      '<td>' + escapar(dataCurta(l.pedidoEm)) + '</td>' +
      '<td>' + escapar((l.origem.anuncio || 'direto').split(' [')[0]) + '</td>' +
      '<td>' + escapar(ROTULO_ETAPA_CRM[l.etapaMaxima] || l.etapaMaxima) + '</td>' +
      '<td>' + escapar(l.ultimoContatoEm ? haQuanto(l.ultimoContatoEm) : 'nunca') + '</td>' +
      '<td>' + (l.diasDesdeOPedido === null ? '—' : l.diasDesdeOPedido) + '</td>' +
      '<td>' + badgeCrm(ROTULO_STATUS_CRM[l.status] || l.status, classeStatusCrm(l.status)) + '</td>' +
      '</tr>';
  }).join('');
}

/* ------------------------------------------------ Perfil da pessoa (modal) */

function abrirPerfilCrm(sessionId) {
  api('/admin/crm/lead/' + encodeURIComponent(sessionId))
    .then(function (p) { desenharPerfilCrm(p); })
    .catch(function (erro) { alert('Não consegui abrir: ' + erro.message); });
}

function iconeTimelineCrm(m) {
  if (m.tipo === 'pagamento') return '✓';
  if (m.tipo === 'aviso') return '✗';
  if (m.tipo === 'segmento') return '→';
  if (m.tipo === 'nota') return '✎';
  if (m.tipo === 'contato') return '✉';
  return '•';
}

function desenharPerfilCrm(p) {
  var tel = digitos(p.contato.telefone);
  var zapHref = tel ? 'https://wa.me/55' + tel : '';

  var respostas = p.respostas.length
    ? p.respostas.map(function (r) {
        return '<div style="margin-bottom:8px"><div class="nota">' + escapar(r.pergunta) + '</div><div><strong>' + escapar(r.resposta) + '</strong> <span class="nota">' + escapar(dataCurta(r.quando)) + '</span></div></div>';
      }).join('')
    : '<p class="nota">Ainda não respondeu nenhuma pergunta.</p>';

  var timeline = p.timeline.map(function (m) {
    var cor = m.ok === false ? 'color:#c0392b' : m.tipo === 'pagamento' ? 'color:#278647;font-weight:700' : '';
    return '<div style="display:flex;gap:10px;padding:6px 0;border-bottom:1px solid var(--color-borda,#eee)">' +
      '<span class="nota" style="min-width:110px">' + escapar(dataCurta(m.quando)) + '</span>' +
      '<span style="min-width:16px">' + iconeTimelineCrm(m) + '</span>' +
      '<span style="' + cor + '">' + escapar(m.texto) + '</span></div>';
  }).join('');

  var contatos = p.contatos.length
    ? p.contatos.map(function (c) {
        return '<div style="display:flex;gap:10px;padding:4px 0"><span class="nota" style="min-width:110px">' + escapar(dataCurta(c.quando)) + '</span><span>' + escapar(c.canal) + '</span><span>' + escapar(c.texto) + '</span><span class="nota">' + escapar(c.status || '') + '</span></div>';
      }).join('')
    : '<p class="nota">Nenhum contato registrado.</p>';

  var pedidos = p.pedidos.length
    ? p.pedidos.map(function (o) {
        return '<div style="display:flex;gap:10px;padding:4px 0;flex-wrap:wrap"><span class="nota" style="min-width:110px">' + escapar(dataCurta(o.criadoEm)) + '</span><span>' + (o.principal ? 'PIX' : 'Adicional') + ' ' + brl(o.valorCentavos) + '</span>' + badgeCrm(o.status, o.status === 'completed' ? 'pago' : o.status === 'pending' ? 'pendente' : 'expirado') + '<span class="nota">' + escapar(o.itens.join(' + ')) + '</span></div>';
      }).join('')
    : '<p class="nota">Nunca gerou PIX.</p>';

  var notas = p.notas.length
    ? p.notas.map(function (n) { return '<div style="padding:4px 0"><span class="nota">' + escapar(dataCurta(n.criadaEm)) + ' · ' + escapar(n.autor) + '</span><div>' + escapar(n.texto) + '</div></div>'; }).join('')
    : '<p class="nota">Sem notas.</p>';

  var optOut = !!(p.marcacao && p.marcacao.optOut);

  var html =
    '<div class="fundo-modal" id="fundoModal">' +
      '<div class="modal" role="dialog" aria-modal="true" aria-label="Perfil da pessoa">' +
        '<header>' +
          '<div><h2>' + escapar(p.contato.nome || '(sem nome)') + '</h2>' +
          '<span class="id">' + escapar([p.contato.email, tel ? telefoneFmtCrm(tel) : ''].filter(Boolean).join(' · ') || 'sem contato') + '</span></div>' +
          '<span style="flex:1"></span>' + badgeCrm(ROTULO_STATUS_CRM[p.status] || p.status, classeStatusCrm(p.status)) +
          '<button class="botao-icone" id="fecharModal" aria-label="Fechar">X</button>' +
        '</header>' +
        '<div class="corpo">' +
          '<div class="chips" style="margin-bottom:10px">' +
            '<span class="badge">' + escapar(ROTULO_SEGMENTO_CRM[p.segmento] || p.segmento) + '</span>' +
            '<span class="badge">destino: ' + escapar(p.destino) + '</span>' +
            '<span class="badge">etapa: ' + escapar(ROTULO_ETAPA_CRM[p.etapaMaxima] || p.etapaMaxima) + '</span>' +
            '<span class="badge">entrou ' + escapar(dataCurta(p.entradaEm)) + '</span>' +
            (p.origem.anuncio ? '<span class="badge">anúncio: ' + escapar(String(p.origem.anuncio).split(' [')[0]) + '</span>' : '') +
            (p.origem.capa ? '<span class="badge">capa: ' + escapar(p.origem.capa) + '</span>' : '') +
          '</div>' +

          '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">' +
            (zapHref ? '<a class="botao-icone" target="_blank" rel="noopener" href="' + zapHref + '">Falar no WhatsApp</a>' : '<span class="nota">Sem WhatsApp</span>') +
            '<button class="botao-icone" id="crmContatado">Marcar como contatado</button>' +
            '<button class="botao-icone" id="crmOptOut">' + (optOut ? 'Voltar a contatar' : 'Marcar opt-out') + '</button>' +
          '</div>' +
          '<p class="nota" style="margin-bottom:12px"><strong>Próxima ação:</strong> ' + escapar(p.proximaAcao) + '</p>' +

          '<h3>Pedido de oração</h3>' +
          (p.pedidoDeOracao
            ? '<blockquote style="border-left:3px solid var(--color-ouro,#A89060);padding:8px 12px;margin:0 0 6px;white-space:pre-wrap">' + escapar(p.pedidoDeOracao) + '</blockquote><p class="nota" style="margin-bottom:12px">Enviado ' + escapar(dataCompleta(p.pedidoEm)) + '</p>'
            : '<p class="nota">Não fez pedido de oração (entrou pelo quiz direto).</p>') +

          '<h3>Respostas do quiz <span class="nota">(' + p.perguntasRespondidas + ' de 9 · ' + p.percentualDoQuiz + '%)</span></h3>' + respostas +
          '<h3>PIX e compras</h3>' + pedidos +
          '<h3>Histórico de contatos</h3>' + contatos +
          '<h3>Linha do tempo</h3><div style="margin-bottom:12px">' + timeline + '</div>' +

          '<h3>Notas internas</h3>' + notas +
          '<div style="display:flex;gap:8px;margin-top:8px"><input type="text" id="crmNota" placeholder="Escrever nota…" style="flex:1" /><button class="botao-icone" id="crmSalvarNota">Salvar</button></div>' +
        '</div>' +
      '</div>' +
    '</div>';

  var area = document.getElementById('areaModal');
  area.innerHTML = html;
  document.body.style.overflow = 'hidden';

  document.getElementById('fecharModal').addEventListener('click', fecharModal);
  document.getElementById('fundoModal').addEventListener('click', function (e) { if (e.target.id === 'fundoModal') fecharModal(); });

  document.getElementById('crmContatado').addEventListener('click', function () {
    api('/admin/crm/lead/' + encodeURIComponent(p.sessionId) + '/marcar', { method: 'POST', body: { contatado: true } })
      .then(function () { abrirPerfilCrm(p.sessionId); carregarCrm(); });
  });
  document.getElementById('crmOptOut').addEventListener('click', function () {
    var novo = !optOut;
    if (novo && !confirm('Marcar opt-out? A pessoa sai de todas as réguas e não será contatada.')) return;
    api('/admin/crm/lead/' + encodeURIComponent(p.sessionId) + '/marcar', { method: 'POST', body: { optOut: novo } })
      .then(function () { abrirPerfilCrm(p.sessionId); carregarCrm(); });
  });
  document.getElementById('crmSalvarNota').addEventListener('click', function () {
    var texto = document.getElementById('crmNota').value.trim();
    if (!texto) return;
    api('/admin/crm/lead/' + encodeURIComponent(p.sessionId) + '/nota', { method: 'POST', body: { texto: texto } })
      .then(function () { abrirPerfilCrm(p.sessionId); });
  });
}

/* ------------------------------------------------------------ Eventos */

function ligarEventosCrm() {
  var periodo = document.getElementById('periodoCrm');
  if (!periodo) return;
  periodo.addEventListener('change', function () { estado.crm.periodo = periodo.value; carregarCrm(); });
  document.getElementById('recarregarCrm').addEventListener('click', function () { carregarCrm(); });

  document.getElementById('chipsSecaoCrm').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    estado.crm.secao = b.dataset.secao;
    carregarCrm();
  });
  function chips(id, campo, redesenhar) {
    document.getElementById(id).addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      estado.crm[campo] = b.dataset[Object.keys(b.dataset)[0]];
      Array.prototype.forEach.call(e.currentTarget.querySelectorAll('button'), function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      redesenhar ? redesenhar() : carregarCrm();
    });
  }
  chips('chipsCompraCrm', 'compra');
  chips('chipsSegmentoCrm', 'segmento');
  chips('chipsDiasReciprocidade', 'diasReciprocidade', desenharReciprocidadeCrm);

  var relogioBusca = null;
  document.getElementById('buscaCrm').addEventListener('input', function (e) {
    clearTimeout(relogioBusca);
    relogioBusca = setTimeout(function () { estado.crm.busca = e.target.value; carregarCrm(); }, 350);
  });
  document.getElementById('anuncioCrm').addEventListener('input', function (e) {
    clearTimeout(relogioBusca);
    relogioBusca = setTimeout(function () { estado.crm.anuncio = e.target.value; carregarCrm(); }, 350);
  });
  document.getElementById('soPedidoCrm').addEventListener('change', function (e) { estado.crm.soPedido = e.target.checked; carregarCrm(); });

  function abrirDaTabela(e) {
    var tr = e.target.closest('tr[data-sessao]');
    if (tr) abrirPerfilCrm(tr.dataset.sessao);
  }
  document.getElementById('corpoCrm').addEventListener('click', abrirDaTabela);
  document.getElementById('corpoReciprocidade').addEventListener('click', abrirDaTabela);

  /*
   * O admin.js troca de aba por trocarAba(nome) e só conhece as abas dele.
   * Em vez de editar a lista lá, escutamos o clique no botão da aba CRM e
   * carregamos na primeira abertura — o admin.js já esconde/mostra a seção
   * pelo id "abaCrm" porque a lista de ids inclui... não inclui. Então
   * fazemos a exibição aqui também.
   */
  var botaoAba = document.querySelector('.abas button[data-aba="crm"]');
  if (botaoAba) {
    botaoAba.addEventListener('click', function () {
      if (!estado.crm.carregado) carregarCrm();
      else desenharCrm();
    });
  }
}

ligarEventosCrm();
