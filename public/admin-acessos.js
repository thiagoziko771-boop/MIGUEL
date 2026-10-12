/*
 * Aba Acessos — histórico de acessos + auditoria (15/08/2026).
 *
 * Três seções: entregas aos clientes (quem pagou abriu a página?), ações no
 * painel (auditoria de escrita) e entradas no painel (logins e senhas erradas).
 * Mesmo padrão do admin-crm.js: usa os ajudantes globais do admin.js.
 */
/* global estado, api, escapar, dataCurta, dataCompleta, haQuanto, telFmt, cartaoKpi, inteiro */

estado.acessos = { dados: null, dias: 7, secao: 'entregas', filtroEntregas: '' };

function carregarAcessos() {
  document.getElementById('resumoAcessos').textContent = 'Carregando…';
  return api('/admin/acessos?dias=' + estado.acessos.dias + '&t=' + Date.now())
    .then(function (dados) {
      estado.acessos.dados = dados;
      desenharAcessos();
    })
    .catch(function (falha) {
      document.getElementById('resumoAcessos').textContent = falha.message;
    });
}

function papelFmt(p) {
  return { dono: 'Dono', equipe: 'Equipe', cliente: 'Cliente', anonimo: '—' }[p] || p;
}

function desenharAcessos() {
  var a = estado.acessos;
  var d = a.dados;
  if (!d) return;

  document.getElementById('periodoAcessos').value = String(a.dias);
  var r = d.resumo;
  document.getElementById('resumoAcessos').textContent =
    (a.dias === 1 ? 'Hoje' : 'Últimos ' + a.dias + ' dias') + ' · ' + inteiro(r.loginsOk) + ' entrada' + (r.loginsOk === 1 ? '' : 's') +
    ' · ' + inteiro(r.acoesNoPainel) + ' aç' + (r.acoesNoPainel === 1 ? 'ão' : 'ões') + ' · ' + inteiro(r.entregasAbertas) + ' entrega' + (r.entregasAbertas === 1 ? '' : 's') + ' aberta' + (r.entregasAbertas === 1 ? '' : 's');

  document.getElementById('kpisAcessos').innerHTML =
    cartaoKpi('Entradas no painel', inteiro(r.loginsOk), r.ipsDistintos + ' IP' + (r.ipsDistintos === 1 ? '' : 's') + ' distinto' + (r.ipsDistintos === 1 ? '' : 's')) +
    cartaoKpi('Senhas erradas', inteiro(r.senhasErradas), r.senhasErradas ? 'confira o IP na lista' : 'nenhuma tentativa', '', { tom: r.senhasErradas ? 'desce' : '' }) +
    cartaoKpi('Ações no painel', inteiro(r.acoesNoPainel), 'gravadas na auditoria') +
    cartaoKpi('Pedidos pagos', inteiro(r.pagos), 'no período') +
    cartaoKpi('Abriram a entrega', inteiro(r.entregasAbertas), r.pagos ? Math.round((r.entregasAbertas / Math.max(1, r.pagos)) * 100) + '% dos pagos' : '', '', { tom: 'sobe' }) +
    cartaoKpi('Pagaram e nunca abriram', inteiro(r.pagosSemAbrir), r.pagosSemAbrir ? 'vale um WhatsApp com o link' : 'todo mundo recebeu', '', { tom: r.pagosSemAbrir ? 'desce' : 'sobe' });

  Array.prototype.forEach.call(document.querySelectorAll('#chipsAcessos button'), function (b) {
    b.setAttribute('aria-pressed', String(b.dataset.secao === a.secao));
  });
  document.getElementById('secaoEntregasAcessos').hidden = a.secao !== 'entregas';
  document.getElementById('secaoAcoesAcessos').hidden = a.secao !== 'acoes';
  document.getElementById('secaoLoginsAcessos').hidden = a.secao !== 'logins';

  /* Entregas */
  Array.prototype.forEach.call(document.querySelectorAll('#chipsEntregasAcessos button'), function (b) {
    b.setAttribute('aria-pressed', String(b.dataset.filtro === a.filtroEntregas));
  });
  var entregas = d.entregas.filter(function (e) {
    if (a.filtroEntregas === 'sem') return e.aberturas === 0;
    if (a.filtroEntregas === 'com') return e.aberturas > 0;
    return true;
  });
  document.getElementById('vazioEntregasAcessos').hidden = entregas.length > 0;
  document.getElementById('corpoEntregasAcessos').innerHTML = entregas.map(function (e) {
    var semAbrir = e.aberturas === 0;
    return '<tr' + (semAbrir && e.principal ? ' style="opacity:.85"' : '') + '>' +
      '<td>' + escapar(dataCurta(e.pagoEm)) + (e.principal ? '' : ' <span class="nota">upsell</span>') + '</td>' +
      '<td><strong>' + escapar(e.nome) + '</strong><div class="nota">' + escapar([e.email, e.telefone ? telFmt(e.telefone) : ''].filter(Boolean).join(' · ')) + '</div></td>' +
      '<td class="nota">' + escapar(e.itens.join(', ')) + '</td>' +
      '<td>' + (e.emailEnviadoEm ? '<span style="color:var(--ok)">enviado</span> <span class="nota">' + escapar(dataCurta(e.emailEnviadoEm)) + '</span>' : '<span style="color:var(--erro)">não enviado</span>') + '</td>' +
      '<td class="num">' + (semAbrir ? '<span style="color:var(--erro);font-weight:600">0</span>' : '<strong>' + e.aberturas + '</strong>') + '</td>' +
      '<td>' + (e.ultimaAberturaEm ? escapar(dataCurta(e.ultimaAberturaEm)) + ' <span class="nota">(' + escapar(haQuanto(e.ultimaAberturaEm)) + ')</span>' : '—') + '</td>' +
      '<td class="nota">' + escapar(e.ultimoIp || '—') + '</td>' +
      '</tr>';
  }).join('');

  /* Ações */
  var acoes = d.acoes.concat(d.clientes).sort(function (x, y) { return y.t.localeCompare(x.t); });
  document.getElementById('vazioAcoesAcessos').hidden = acoes.length > 0;
  document.getElementById('corpoAcoesAcessos').innerHTML = acoes.map(function (x) {
    var erro = x.status !== null && x.status >= 400;
    return '<tr>' +
      '<td title="' + escapar(dataCompleta(x.t)) + '">' + escapar(dataCurta(x.t)) + '</td>' +
      '<td>' + escapar(papelFmt(x.papel)) + '</td>' +
      '<td><strong>' + escapar(x.rotulo) + '</strong>' + (x.rotulo === x.acao ? '' : '<div class="nota">' + escapar(x.acao) + '</div>') + '</td>' +
      '<td class="nota">' + escapar(x.alvo ? x.alvo.slice(0, 12) : '—') + '</td>' +
      '<td class="nota">' + escapar(x.detalhe || '') + '</td>' +
      '<td class="nota">' + escapar(x.ip || '—') + '</td>' +
      '<td class="num" style="' + (erro ? 'color:var(--erro);font-weight:600' : '') + '">' + (x.status === null ? '—' : x.status) + '</td>' +
      '</tr>';
  }).join('');

  /* Logins */
  document.getElementById('vazioLoginsAcessos').hidden = d.logins.length > 0;
  document.getElementById('corpoLoginsAcessos').innerHTML = d.logins.map(function (x) {
    var ok = x.acao === 'login.ok';
    return '<tr>' +
      '<td title="' + escapar(dataCompleta(x.t)) + '">' + escapar(dataCurta(x.t)) + '</td>' +
      '<td style="color:var(' + (ok ? '--ok' : '--erro') + ');font-weight:600">' + escapar(x.rotulo) + (x.detalhe === 'bloqueou' ? ' → bloqueado' : '') + '</td>' +
      '<td>' + escapar(papelFmt(x.papel)) + '</td>' +
      '<td class="nota">' + escapar(x.ip || '—') + '</td>' +
      '<td class="nota">' + escapar(ok && x.detalhe ? x.detalhe.slice(0, 80) : '') + '</td>' +
      '</tr>';
  }).join('');
}

function ligarEventosAcessos() {
  var botaoAba = document.querySelector('.abas button[data-aba="acessos"]');
  if (botaoAba) {
    botaoAba.addEventListener('click', function () {
      // Sempre recarrega: quem abre esta aba quer saber o que acabou de acontecer.
      carregarAcessos();
    });
  }
  document.getElementById('recarregarAcessos').addEventListener('click', carregarAcessos);
  document.getElementById('periodoAcessos').addEventListener('change', function (e) {
    estado.acessos.dias = Number(e.target.value) || 7;
    carregarAcessos();
  });
  document.getElementById('chipsAcessos').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    estado.acessos.secao = b.dataset.secao;
    desenharAcessos();
  });
  document.getElementById('chipsEntregasAcessos').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    estado.acessos.filtroEntregas = b.dataset.filtro;
    desenharAcessos();
  });
}

ligarEventosAcessos();
