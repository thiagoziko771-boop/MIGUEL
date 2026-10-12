/*
 * Aba Relatórios — fechamento diário (15/08/2026).
 *
 * Carrega /admin/relatorios uma vez por abertura da aba, desenha um bloco de
 * KPIs para o dia em foco (hoje, por padrão) e uma tabela dia a dia. Clicar
 * numa linha muda o dia em foco; "Copiar resumo" põe o texto do fechamento na
 * área de transferência, pronto para colar no WhatsApp/Telegram.
 *
 * Mesmo padrão do admin-crm.js: usa os ajudantes globais do admin.js.
 */
/* global estado, api, escapar, brl, pct, cartaoKpi, inteiro */

estado.relatorios = { dados: null, dias: 14, foco: null, carregando: false };

function carregarRelatorios() {
  var r = estado.relatorios;
  r.carregando = true;
  document.getElementById('resumoRelatorios').textContent = 'Carregando…';
  return api('/admin/relatorios?dias=' + r.dias + '&t=' + Date.now())
    .then(function (dados) {
      r.dados = dados;
      // O foco segue no mesmo dia se ele ainda existir; senão volta para hoje.
      if (!r.foco || !dados.dias.some(function (d) { return d.dia === r.foco; })) r.foco = dados.hoje;
      desenharRelatorios();
    })
    .catch(function (falha) {
      document.getElementById('resumoRelatorios').textContent = falha.message;
    })
    .then(function () { r.carregando = false; });
}

function diaBr(dia) {
  if (!dia) return '—';
  if (dia.indexOf('..') >= 0) {
    var p = dia.split('..');
    return diaBr(p[0]) + ' a ' + diaBr(p[1]);
  }
  var partes = dia.split('-');
  return partes[2] + '/' + partes[1];
}

function rotuloDoDia(linha, hoje) {
  if (linha.dia.indexOf('..') >= 0) return 'Período';
  if (linha.dia === hoje) return 'Hoje';
  var ontem = new Date(hoje + 'T12:00:00');
  ontem.setDate(ontem.getDate() - 1);
  var o = ontem.getFullYear() + '-' + String(ontem.getMonth() + 1).padStart(2, '0') + '-' + String(ontem.getDate()).padStart(2, '0');
  if (linha.dia === o) return 'Ontem';
  var d = new Date(linha.dia + 'T12:00:00');
  return ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'][d.getDay()] + ' ' + diaBr(linha.dia);
}

function roasFmt(v) {
  return v === null || v === undefined ? '—' : v.toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + 'x';
}

function tomDoLucro(linha) {
  if (!linha.temInvestimento && linha.receitaCentavos === 0) return '';
  return linha.lucroCentavos >= 0 ? 'sobe' : 'desce';
}

function linhaEmFoco() {
  var r = estado.relatorios;
  if (!r.dados) return null;
  if (r.foco === 'periodo') return r.dados.totais;
  if (r.foco === 'fechados') return r.dados.totaisFechados;
  return r.dados.dias.filter(function (d) { return d.dia === r.foco; })[0] || r.dados.dias[0];
}

function desenharRelatorios() {
  var r = estado.relatorios;
  var dados = r.dados;
  if (!dados) return;

  document.getElementById('periodoRelatorios').value = String(r.dias);
  document.getElementById('resumoRelatorios').textContent =
    'Últimos ' + r.dias + ' dias · ' + inteiro(dados.totais.vendas) + ' venda' + (dados.totais.vendas === 1 ? '' : 's') +
    ' · ' + brl(dados.totais.receitaCentavos) + (dados.totais.temInvestimento ? ' · lucro ' + brl(dados.totais.lucroCentavos) : '');

  var foco = linhaEmFoco();
  var titulo = document.getElementById('tituloFechamento');
  var nome = rotuloDoDia(foco, dados.hoje);
  titulo.textContent = 'Fechamento de ' + (nome === 'Hoje' ? 'hoje' : nome === 'Ontem' ? 'ontem' : nome === 'Período' ? 'todo o período' : nome) +
    (foco.parcial && foco.dia === dados.hoje ? ' (parcial — o dia ainda está correndo)' : '');

  var melhor = dados.melhorDia ? dados.dias.filter(function (d) { return d.dia === dados.melhorDia; })[0] : null;
  var notaLucro = melhor && melhor.dia !== foco.dia
    ? 'melhor dia fechado: ' + diaBr(melhor.dia) + ' com ' + brl(melhor.lucroCentavos)
    : (melhor && melhor.dia === foco.dia ? 'seu melhor dia fechado' : '');

  document.getElementById('kpisRelatorios').innerHTML =
    cartaoKpi('Investido', foco.temInvestimento ? brl(foco.investidoCentavos) : '—', foco.temInvestimento ? 'anúncio, nível campanha' : 'nenhum gasto registrado') +
    cartaoKpi('Receita', brl(foco.receitaCentavos), inteiro(foco.vendas) + ' venda' + (foco.vendas === 1 ? '' : 's') + (foco.upsellsPagos ? ' + ' + foco.upsellsPagos + ' upsell' : '')) +
    cartaoKpi('Lucro', foco.temInvestimento || foco.receitaCentavos ? brl(foco.lucroCentavos) : '—', notaLucro, '', { tom: tomDoLucro(foco) }) +
    cartaoKpi('ROAS', roasFmt(foco.roas), foco.roas === null ? 'precisa de gasto e receita' : (foco.roas >= 1 ? 'o dia pagou o anúncio' : 'o dia não pagou o anúncio'), '', { tom: foco.roas === null ? '' : (foco.roas >= 1 ? 'sobe' : 'desce') }) +
    cartaoKpi('Custo por venda', foco.cpaCentavos === null ? '—' : brl(foco.cpaCentavos), foco.ticketCentavos === null ? '' : 'ticket ' + brl(foco.ticketCentavos)) +
    cartaoKpi('Visitas', inteiro(foco.visitas), foco.cpvCentavos === null ? '' : brl(foco.cpvCentavos) + ' por visita') +
    cartaoKpi('PIX gerados', inteiro(foco.pixGerados), foco.taxaPix === null ? '' : pct(foco.taxaPix) + ' das visitas') +
    cartaoKpi('PIX → pago', foco.taxaPagamento === null ? '—' : pct(foco.taxaPagamento), foco.pendentes ? foco.pendentes + ' ainda aguardando' : '') +
    cartaoKpi('Conversão', foco.conversao === null ? '—' : pct(foco.conversao), 'visita → venda');

  document.getElementById('legendaRelatorios').textContent =
    'Caminho: ' + inteiro(foco.visitas) + ' visitas → ' + inteiro(foco.quiz) + ' iniciaram o quiz → ' + inteiro(foco.vsl) +
    ' chegaram à VSL → ' + inteiro(foco.checkout) + ' abriram o checkout → ' + inteiro(foco.pixGerados) + ' geraram PIX → ' + inteiro(foco.vendas) + ' pagaram.';

  var corpo = document.getElementById('corpoRelatorios');
  var temAlgo = dados.dias.some(function (d) { return d.visitas || d.pixGerados || d.temInvestimento; });
  document.getElementById('vazioRelatorios').hidden = temAlgo;

  corpo.innerHTML = dados.dias.map(function (d) {
    var selecionada = d.dia === r.foco;
    var apagada = !d.visitas && !d.pixGerados && !d.temInvestimento;
    return '<tr class="clicavel" data-dia="' + escapar(d.dia) + '" style="' + (selecionada ? 'background:var(--realce, rgba(168,144,96,.12));' : '') + (apagada ? 'opacity:.55' : '') + '">' +
      '<td>' + escapar(rotuloDoDia(d, dados.hoje)) + (d.parcial ? ' <span class="nota">parcial</span>' : '') + '</td>' +
      '<td class="num">' + (d.temInvestimento ? brl(d.investidoCentavos) : '—') + '</td>' +
      '<td class="num">' + inteiro(d.visitas) + '</td>' +
      '<td class="num">' + inteiro(d.quiz) + '</td>' +
      '<td class="num">' + inteiro(d.vsl) + '</td>' +
      '<td class="num">' + inteiro(d.checkout) + '</td>' +
      '<td class="num">' + inteiro(d.pixGerados) + (d.pendentes ? ' <span class="nota" title="aguardando pagamento">(' + d.pendentes + ')</span>' : '') + '</td>' +
      '<td class="num"><strong>' + inteiro(d.vendas) + '</strong>' + (d.upsellsPagos ? ' <span class="nota">+' + d.upsellsPagos + '</span>' : '') + '</td>' +
      '<td class="num">' + brl(d.receitaCentavos) + '</td>' +
      '<td class="num ' + (tomDoLucro(d) === 'sobe' ? 'ok' : tomDoLucro(d) === 'desce' ? 'erro' : '') + '" style="' + (tomDoLucro(d) === 'sobe' ? 'color:var(--ok)' : tomDoLucro(d) === 'desce' ? 'color:var(--erro)' : '') + '">' + (d.temInvestimento || d.receitaCentavos ? brl(d.lucroCentavos) : '—') + '</td>' +
      '<td class="num">' + roasFmt(d.roas) + '</td>' +
      '<td class="num">' + (d.cpaCentavos === null ? '—' : brl(d.cpaCentavos)) + '</td>' +
      '<td class="num">' + (d.taxaPix === null ? '—' : pct(d.taxaPix)) + '</td>' +
      '<td class="num">' + (d.taxaPagamento === null ? '—' : pct(d.taxaPagamento)) + '</td>' +
      '</tr>';
  }).join('');

  var t = dados.totais;
  var f = dados.totaisFechados;
  function linhaTotal(nome, l, chave) {
    return '<tr class="clicavel" data-dia="' + chave + '" style="' + (r.foco === chave ? 'background:var(--realce, rgba(168,144,96,.12));' : '') + '">' +
      '<td><strong>' + nome + '</strong></td>' +
      '<td class="num">' + (l.temInvestimento ? brl(l.investidoCentavos) : '—') + '</td>' +
      '<td class="num">' + inteiro(l.visitas) + '</td>' +
      '<td class="num">' + inteiro(l.quiz) + '</td>' +
      '<td class="num">' + inteiro(l.vsl) + '</td>' +
      '<td class="num">' + inteiro(l.checkout) + '</td>' +
      '<td class="num">' + inteiro(l.pixGerados) + '</td>' +
      '<td class="num"><strong>' + inteiro(l.vendas) + '</strong>' + (l.upsellsPagos ? ' <span class="nota">+' + l.upsellsPagos + '</span>' : '') + '</td>' +
      '<td class="num">' + brl(l.receitaCentavos) + '</td>' +
      '<td class="num" style="' + (tomDoLucro(l) === 'sobe' ? 'color:var(--ok)' : tomDoLucro(l) === 'desce' ? 'color:var(--erro)' : '') + '">' + (l.temInvestimento || l.receitaCentavos ? brl(l.lucroCentavos) : '—') + '</td>' +
      '<td class="num">' + roasFmt(l.roas) + '</td>' +
      '<td class="num">' + (l.cpaCentavos === null ? '—' : brl(l.cpaCentavos)) + '</td>' +
      '<td class="num">' + (l.taxaPix === null ? '—' : pct(l.taxaPix)) + '</td>' +
      '<td class="num">' + (l.taxaPagamento === null ? '—' : pct(l.taxaPagamento)) + '</td>' +
      '</tr>';
  }
  document.getElementById('rodapeRelatorios').innerHTML =
    linhaTotal('Dias fechados', f, 'fechados') +
    linhaTotal('Período todo', t, 'periodo');
}

function textoDoFoco() {
  var r = estado.relatorios;
  var d = r.dados;
  if (!d) return '';
  if (r.foco === d.hoje) return d.textos.hoje;
  if (r.foco === 'periodo') return d.textos.periodo;
  var foco = linhaEmFoco();
  // Para os outros dias monta aqui, no mesmo formato do servidor.
  var pctT = function (v) { return v === null ? '—' : (v * 100).toFixed(1).replace('.', ',') + '%'; };
  var linhas = [
    '📊 Fechamento ' + (foco.dia.indexOf('..') >= 0 ? diaBr(foco.dia) : diaBr(foco.dia) + '/' + foco.dia.slice(0, 4)) + (foco.parcial ? ' (parcial)' : ''),
    '💸 Investido: ' + (foco.temInvestimento ? brl(foco.investidoCentavos) : 'não registrado'),
    '💰 Receita: ' + brl(foco.receitaCentavos) + ' · ' + foco.vendas + ' venda' + (foco.vendas === 1 ? '' : 's') + (foco.upsellsPagos ? ' (+' + foco.upsellsPagos + ' upsell)' : ''),
    '📈 Lucro: ' + brl(foco.lucroCentavos) + (foco.roas !== null ? ' · ROAS ' + foco.roas.toFixed(2).replace('.', ',') + 'x' : ''),
    '👣 Visitas ' + foco.visitas + ' → quiz ' + foco.quiz + ' → VSL ' + foco.vsl + ' → checkout ' + foco.checkout + ' → PIX ' + foco.pixGerados,
    '🎯 Visita→PIX ' + pctT(foco.taxaPix) + ' · PIX→pago ' + pctT(foco.taxaPagamento) + ' · conversão ' + pctT(foco.conversao),
  ];
  if (foco.cpaCentavos !== null) linhas.push('🧾 Custo por venda ' + brl(foco.cpaCentavos) + ' · ticket ' + brl(foco.ticketCentavos || 0));
  if (foco.pendentes) linhas.push('⏳ ' + foco.pendentes + ' PIX ainda aguardando');
  return linhas.join('\n');
}

function copiarFechamento() {
  var texto = textoDoFoco();
  var botao = document.getElementById('copiarFechamento');
  if (!texto) return;
  function pronto(ok) {
    botao.textContent = ok ? 'Copiado ✓' : 'Não consegui copiar';
    setTimeout(function () { botao.textContent = 'Copiar resumo'; }, 2000);
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(texto).then(function () { pronto(true); }, function () { pronto(false); });
  } else {
    var area = document.createElement('textarea');
    area.value = texto;
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(area);
    pronto(ok);
  }
}

function ligarEventosRelatorios() {
  var botaoAba = document.querySelector('.abas button[data-aba="relatorios"]');
  if (botaoAba) {
    botaoAba.addEventListener('click', function () {
      if (!estado.relatorios.dados) carregarRelatorios();
      else desenharRelatorios();
    });
  }
  document.getElementById('recarregarRelatorios').addEventListener('click', carregarRelatorios);
  document.getElementById('periodoRelatorios').addEventListener('change', function (e) {
    estado.relatorios.dias = Number(e.target.value) || 14;
    carregarRelatorios();
  });
  document.getElementById('copiarFechamento').addEventListener('click', copiarFechamento);

  function focar(e) {
    var tr = e.target.closest('tr[data-dia]');
    if (!tr) return;
    estado.relatorios.foco = tr.dataset.dia;
    desenharRelatorios();
    document.getElementById('tituloFechamento').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  document.getElementById('corpoRelatorios').addEventListener('click', focar);
  document.getElementById('rodapeRelatorios').addEventListener('click', focar);
}

ligarEventosRelatorios();
