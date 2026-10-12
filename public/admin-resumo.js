/*
 * Aba Resumo — o demonstrativo do negócio numa tela só.
 *
 * Até aqui "Lucro" no painel queria dizer `faturamento - anúncio`: sem taxa do
 * gateway, sem imposto sobre a venda e sem o imposto que a Meta cobra por fora
 * do gasto. Os três erram para o mesmo lado, para mais — e lucro inflado não é
 * relatório impreciso, é a ordem de escalar um anúncio que está empatando.
 *
 * Esta tela lê /admin/resumo, que já entrega a conta pronta (server/custos.ts +
 * server/resumo.ts), e edita o modelo de custo e as despesas ali mesmo. Junto,
 * e não numa aba de configuração separada, porque a pergunta "por que o lucro
 * está assim?" se responde olhando os custos que o produziram.
 *
 * Mesmo padrão do admin-relatorios.js: usa os ajudantes globais do admin.js.
 */
/* global estado, api, escapar, brl, pct, cartaoKpi, inteiro */

estado.resumo = { dados: null, custos: null, despesas: [], dias: 7, bm: null, bms: [], carregando: false };

/* ------------------------------------------------------------- leitura -- */

function carregarResumo() {
  var r = estado.resumo;
  if (r.carregando) return Promise.resolve();
  r.carregando = true;

  /*
   * `t=` porque esta tela é sobre dinheiro de agora: quem abre está decidindo
   * se aumenta a verba hoje, e uma resposta de cache de dez minutos atrás
   * responde a outra pergunta.
   */
  return Promise.all([
    api('/admin/resumo?dias=' + r.dias + (r.bm ? '&bm=' + encodeURIComponent(r.bm) : '') + '&t=' + Date.now()),
    api('/admin/custos?t=' + Date.now()),
    /* A lista de BMs vem da mesma fonte da aba BMs, para os dois filtros nunca
       oferecerem gerenciadores diferentes. Falhar aqui só tira os botões. */
    api('/admin/bms?dias=' + r.dias).catch(function () { return { bms: [] }; }),
  ])
    .then(function (respostas) {
      r.dados = respostas[0];
      r.custos = respostas[1].custos;
      r.despesas = respostas[1].despesas || [];
      r.bms = (respostas[2].bms || []).filter(function (b) { return b.slug; });
      desenharChipsDeBmNoResumo();
      desenharResumo();
      preencherCustos();
      desenharDespesas();
    })
    .catch(function (falha) {
      var frases = document.getElementById('frasesResumo');
      if (frases) frases.textContent = falha.message;
    })
    .then(function () { r.carregando = false; });
}

/**
 * Os botões de gerenciador, acima dos cartões.
 *
 * Filtrar o demonstrativo por BM é o que responde "esta conta está pagando?" —
 * a pergunta que se faz antes de mexer no orçamento dela.
 */
function desenharChipsDeBmNoResumo() {
  var alvo = document.getElementById('chipsBmResumo');
  if (!alvo) return;
  var r = estado.resumo;

  if (r.bms.length === 0) { alvo.innerHTML = ''; return; }

  alvo.innerHTML = '<button data-bm="" aria-pressed="' + (!r.bm) + '">Todas</button>' +
    r.bms.map(function (b) {
      return '<button data-bm="' + escapar(b.slug) + '" aria-pressed="' + (r.bm === b.slug) + '">' +
        escapar(b.nome || b.slug) + '</button>';
    }).join('');
}

/* ------------------------------------------------------------ cartões --- */

/** Percentual ou traço. Zero é um número; ausência de base não é. */
function pctOuTraco(valor) {
  return valor === null || valor === undefined ? '—' : pct(valor);
}

function vezes(valor) {
  return valor === null || valor === undefined
    ? '—'
    : valor.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + 'x';
}

function desenharResumo() {
  var d = estado.resumo.dados;
  if (!d) return;
  var c = d.custos;

  /*
   * O aviso é o cartão mais importante da tela quando aparece. Sem o modelo de
   * custo preenchido, "Taxas R$ 0,00" e "taxa de fato zero" são a mesma tela e
   * significados opostos — e a confusão entre os dois é justamente o defeito
   * que esta aba veio corrigir.
   */
  var aviso = document.getElementById('avisoCustos');
  /*
   * Filtrar por uma BM sem gasto carimbado é o pior caso desta tela: a receita
   * some para aquele gerenciador, o gasto vira zero e o Lucro aparece ALTO e
   * convincente. O aviso vem antes do de custos porque engana mais.
   */
  if (aviso && d.investimentoDaBmDisponivel === false) {
    aviso.hidden = false;
    aviso.textContent = 'Esta BM ainda não tem gasto importado no período: o Lucro abaixo ' +
      'ignora a mídia e está muito maior que o real. Vá em BMs → "Importar gasto de cada BM".';
  } else if (aviso) {
    aviso.hidden = d.custosConfigurados;
    aviso.textContent = d.custosConfigurados ? '' :
      'Os custos ainda não foram preenchidos: este Lucro desconta só o anúncio, ' +
      'sem taxa do gateway nem imposto. Ele está MAIOR que o real. Preencha em ' +
      '"Quanto custa vender", logo abaixo.';
  }

  /* Sem gasto anotado, ROAS e ROI não existem — e dizer "0" seria inventar. */
  var notaGasto = d.temInvestimento
    ? brl(d.investimentoCentavos) + ' no leilão + ' + brl(c.impostoMetaAdsCentavos) + ' de imposto'
    : 'nenhum gasto registrado no período';

  var tomLucro = c.lucroCentavos > 0 ? 'sobe' : (c.lucroCentavos < 0 ? 'desce' : '');

  document.getElementById('kpisResumo').innerHTML =
    cartaoKpi('Faturamento líquido', brl(c.receitaLiquidaCentavos),
      brl(d.receitaBrutaCentavos) + ' bruto em ' + inteiro(d.vendas) + ' vendas') +
    cartaoKpi('Gastos com anúncios', brl(c.gastoTotalCentavos), notaGasto) +
    cartaoKpi('Lucro', brl(c.lucroCentavos),
      c.lucroCentavos >= 0 ? 'sobrou depois de tudo' : 'faltou para pagar tudo', '', { tom: tomLucro }) +
    cartaoKpi('ROAS', vezes(c.roas),
      d.roasDeEquilibrio ? 'empata em ' + vezes(d.roasDeEquilibrio) : 'faturamento ÷ gasto') +

    cartaoKpi('ROI', pctOuTraco(c.roi), 'lucro ÷ gasto') +
    cartaoKpi('Margem', pctOuTraco(c.margem), 'lucro ÷ faturamento bruto') +
    cartaoKpi('Taxa de aprovação', pctOuTraco(d.taxaDeAprovacao),
      inteiro(d.pixGerados) + ' PIX gerados no período') +
    cartaoKpi('Ticket médio', d.ticketCentavos === null ? '—' : brl(d.ticketCentavos),
      'por cobrança paga', 'secundario') +

    cartaoKpi('Aguardando pagamento', brl(d.pendenteCentavos),
      inteiro(d.pendentes) + ' PIX esperando', 'secundario') +
    cartaoKpi('Taxas', brl(c.taxasCentavos), 'retido pelo gateway', 'secundario') +
    cartaoKpi('Imposto sobre vendas', brl(c.impostoSobreVendasCentavos), 'sobre o faturamento', 'secundario') +
    cartaoKpi('Imposto Meta Ads', brl(c.impostoMetaAdsCentavos), 'por fora do leilão', 'secundario') +

    cartaoKpi('Imposto total', brl(c.impostoTotalCentavos), 'venda + anúncio', 'secundario') +
    cartaoKpi('Custos de produto', brl(c.custosProdutoCentavos),
      inteiro(d.vendas) + ' vendas', 'secundario') +
    cartaoKpi('Despesas adicionais', brl(d.despesasCentavos), 'fora do anúncio', 'secundario') +
    cartaoKpi('Vendas reembolsadas', brl(d.devolvidoCentavos),
      inteiro(d.devolucoes) + ' devolvidas', 'secundario') +

    cartaoKpi('Reembolso', pctOuTraco(d.reembolsoPercentual), 'das transações liquidadas', 'secundario') +
    /*
     * Chargeback ganha cartão próprio, separado do reembolso, porque os dois
     * têm consequências diferentes: reembolso alto é margem ruim, chargeback
     * alto é conta cancelada pelo adquirente. Somados num número só, o segundo
     * fica invisível até a carta chegar.
     */
    cartaoKpi('Chargeback', pctOuTraco(d.chargebackPercentual),
      inteiro(d.contestacoes) + ' contestações', 'secundario');

  desenharFrases();
  desenharFatias('corpoFontes', d.vendasPorFonte, d.receitaBrutaCentavos);
  desenharFatias('corpoMetodos', d.formasDePagamento, d.receitaBrutaCentavos);
}

function desenharFrases() {
  var d = estado.resumo.dados;
  var c = d.custos;
  var frases = [];

  if (!d.temInvestimento) {
    frases.push('Nenhum gasto de anúncio registrado neste período — importe na aba Anúncios para o lucro fechar.');
  } else if (c.lucroCentavos >= 0) {
    frases.push('Sobrou ' + brl(c.lucroCentavos) + ' depois de pagar anúncio, taxa, imposto e despesa.');
  } else {
    frases.push('Faltou ' + brl(Math.abs(c.lucroCentavos)) + ' para pagar anúncio, taxa, imposto e despesa.');
  }

  /* A distância entre o bruto e o líquido é o que ninguém enxerga sozinho. */
  var sumico = d.receitaBrutaCentavos - c.receitaLiquidaCentavos;
  if (sumico > 0) {
    frases.push('De cada venda, ' + pct(sumico / d.receitaBrutaCentavos) +
      ' fica no caminho entre o gateway e o imposto (' + brl(sumico) + ' no período).');
  }

  if (d.chargebackPercentual !== null && d.chargebackPercentual >= 0.01) {
    frases.push('Atenção: chargeback em ' + pct(d.chargebackPercentual) +
      '. Acima de 1% o adquirente costuma abrir procedimento.');
  }

  document.getElementById('frasesResumo').textContent = frases.join(' ');
}

function desenharFatias(alvo, fatias, total) {
  var corpo = document.getElementById(alvo);
  if (!corpo) return;
  if (!fatias || fatias.length === 0) {
    corpo.innerHTML = '<tr><td colspan="4">Nenhuma venda no período.</td></tr>';
    return;
  }
  corpo.innerHTML = fatias.map(function (f) {
    return '<tr>' +
      '<td>' + escapar(f.chave) + '</td>' +
      '<td>' + inteiro(f.vendas) + '</td>' +
      '<td>' + brl(f.centavos) + '</td>' +
      '<td>' + (total > 0 ? pct(f.centavos / total) : '—') + '</td>' +
      '</tr>';
  }).join('');
}

/* ------------------------------------------------------------- custos --- */

/** "12,34" -> 1234. Aceita o ponto também, porque teclado de celular varia. */
function centavosDoCampo(texto) {
  var limpo = String(texto || '').trim().replace(/[R$\s]/g, '').replace(',', '.');
  if (limpo === '') return 0;
  var n = Number.parseFloat(limpo);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : 0;
}

function reaisDoCampo(centavos) {
  return ((centavos || 0) / 100).toFixed(2).replace('.', ',');
}

function numeroBr(valor) {
  return String(valor === null || valor === undefined ? '' : valor).replace('.', ',');
}

function preencherCustos() {
  var c = estado.resumo.custos;
  if (!c) return;
  document.getElementById('custoGatewayPercentual').value = numeroBr(c.gatewayPercentual);
  document.getElementById('custoGatewayFixo').value = reaisDoCampo(c.gatewayFixoCentavos);
  document.getElementById('custoImpostoVenda').value = numeroBr(c.impostoSobreVendaPercentual);
  document.getElementById('custoImpostoMeta').value = numeroBr(c.impostoMetaAdsPercentual);
  document.getElementById('custoProduto').value = reaisDoCampo(c.custoPorVendaCentavos);

  var nota = document.getElementById('notaEquilibrio');
  var d = estado.resumo.dados;
  if (nota && d && d.roasDeEquilibrio) {
    nota.textContent = 'Com estes custos, o anúncio empata em ROAS ' + vezes(d.roasDeEquilibrio) +
      '. Abaixo disso ele consome caixa, mesmo faturando.';
  } else if (nota) {
    nota.textContent = '';
  }
}

function salvarCustos() {
  var aviso = document.getElementById('avisoSalvarCustos');
  aviso.textContent = 'Salvando…';

  return api('/admin/custos', {
    method: 'POST',
    body: {
      gatewayPercentual: document.getElementById('custoGatewayPercentual').value,
      impostoSobreVendaPercentual: document.getElementById('custoImpostoVenda').value,
      impostoMetaAdsPercentual: document.getElementById('custoImpostoMeta').value,
      gatewayFixoCentavos: centavosDoCampo(document.getElementById('custoGatewayFixo').value),
      custoPorVendaCentavos: centavosDoCampo(document.getElementById('custoProduto').value),
    },
  })
    .then(function () {
      aviso.textContent = 'Salvo.';
      // Recarrega inteiro: mudar um custo muda todos os cartões, não só o campo.
      return carregarResumo();
    })
    .catch(function (falha) { aviso.textContent = falha.message; });
}

/* ----------------------------------------------------------- despesas --- */

function desenharDespesas() {
  var corpo = document.getElementById('corpoDespesas');
  if (!corpo) return;

  var linhas = estado.resumo.despesas;
  if (linhas.length === 0) {
    corpo.innerHTML = '<tr><td colspan="5">Nenhuma despesa lançada.</td></tr>';
    return;
  }

  corpo.innerHTML = linhas.map(function (d, i) {
    return '<tr data-linha="' + i + '">' +
      '<td><input type="date" data-campo="dia" value="' + escapar(d.dia) + '"></td>' +
      '<td><input type="text" data-campo="descricao" value="' + escapar(d.descricao) + '"></td>' +
      '<td><input type="text" inputmode="decimal" data-campo="centavos" value="' + reaisDoCampo(d.centavos) + '"></td>' +
      '<td><input type="checkbox" data-campo="mensal"' + (d.mensal ? ' checked' : '') + '></td>' +
      '<td><button class="botao-secundario" data-remover="' + i + '">Remover</button></td>' +
      '</tr>';
  }).join('');
}

/** Lê a tabela de volta para objetos. A tela é a verdade enquanto não salva. */
function despesasDaTela() {
  var linhas = [];
  Array.prototype.forEach.call(document.querySelectorAll('#corpoDespesas tr[data-linha]'), function (tr) {
    var campo = function (nome) { return tr.querySelector('[data-campo="' + nome + '"]'); };
    linhas.push({
      dia: campo('dia').value,
      descricao: campo('descricao').value,
      centavos: centavosDoCampo(campo('centavos').value),
      mensal: campo('mensal').checked,
    });
  });
  return linhas;
}

function salvarDespesas() {
  var aviso = document.getElementById('avisoSalvarDespesas');
  var enviadas = despesasDaTela();
  aviso.textContent = 'Salvando…';

  return api('/admin/despesas', { method: 'POST', body: { despesas: enviadas } })
    .then(function (dados) {
      estado.resumo.despesas = dados.despesas;
      /*
       * O servidor descarta linha sem dia, sem descrição ou sem valor. Dizer
       * quantas sumiram evita o pior desfecho: o dono digitar cinco despesas,
       * ver "Salvo", e três nunca aparecerem no lucro.
       */
      var perdidas = enviadas.length - dados.despesas.length;
      aviso.textContent = perdidas > 0
        ? 'Salvo. ' + perdidas + (perdidas === 1 ? ' linha incompleta foi descartada.' : ' linhas incompletas foram descartadas.')
        : 'Salvo.';
      return carregarResumo();
    })
    .catch(function (falha) { aviso.textContent = falha.message; });
}

/* ------------------------------------------------------------ eventos --- */

function ligarEventosResumo() {
  var botaoAba = document.querySelector('.abas button[data-aba="resumo"]');
  if (botaoAba) botaoAba.addEventListener('click', function () { carregarResumo(); });

  var recarregar = document.getElementById('recarregarResumo');
  if (recarregar) recarregar.addEventListener('click', function () { carregarResumo(); });

  var chipsBm = document.getElementById('chipsBmResumo');
  if (chipsBm) {
    chipsBm.addEventListener('click', function (evento) {
      var botao = evento.target.closest('button[data-bm]');
      if (!botao) return;
      estado.resumo.bm = botao.dataset.bm || null;
      carregarResumo();
    });
  }

  var chips = document.getElementById('chipsPeriodoResumo');
  if (chips) {
    chips.addEventListener('click', function (evento) {
      var botao = evento.target.closest('button[data-dias]');
      if (!botao) return;
      estado.resumo.dias = Number(botao.dataset.dias) || 7;
      Array.prototype.forEach.call(chips.querySelectorAll('button'), function (b) {
        b.setAttribute('aria-pressed', String(b === botao));
      });
      carregarResumo();
    });
  }

  var salvar = document.getElementById('salvarCustos');
  if (salvar) salvar.addEventListener('click', salvarCustos);

  var salvarD = document.getElementById('salvarDespesas');
  if (salvarD) salvarD.addEventListener('click', salvarDespesas);

  var nova = document.getElementById('novaDespesa');
  if (nova) {
    nova.addEventListener('click', function () {
      /*
       * A linha nova entra com o que está na tela, não com o que está salvo:
       * senão quem digitou três linhas e clicou "Adicionar" perderia as três.
       */
      var atuais = document.querySelector('#corpoDespesas tr[data-linha]') ? despesasDaTela() : [];
      var hoje = new Date().toISOString().slice(0, 10);
      atuais.push({ dia: hoje, descricao: '', centavos: 0, mensal: false });
      estado.resumo.despesas = atuais;
      desenharDespesas();
    });
  }

  var corpo = document.getElementById('corpoDespesas');
  if (corpo) {
    corpo.addEventListener('click', function (evento) {
      var botao = evento.target.closest('button[data-remover]');
      if (!botao) return;
      var atuais = despesasDaTela();
      atuais.splice(Number(botao.dataset.remover), 1);
      estado.resumo.despesas = atuais;
      desenharDespesas();
    });
  }
}

/* ------------------------------------------- exportacao para o Meta -- */

/*
 * Duas etapas, e a separacao entre elas e o ponto todo desta tela.
 *
 * Baixar o arquivo NAO marca nada. So o botao "Confirmei o upload" marca. Se o
 * download marcasse, o dono que baixasse, visse um erro e fechasse a aba
 * perderia aquelas vendas da fila para sempre — elas nunca teriam chegado ao
 * Meta e ninguem descobriria.
 */

/** A janela escolhida na tela, como query string. Vazio = tudo. */
function janelaDaExportacao() {
  var partes = [];
  var desde = (document.getElementById('expDesde') || {}).value;
  var ate = (document.getElementById('expAte') || {}).value;
  var novas = (document.getElementById('expNovas') || {}).checked;
  if (desde) partes.push('desde=' + encodeURIComponent(desde));
  if (ate) partes.push('ate=' + encodeURIComponent(ate));
  if (novas) partes.push('novas=1');
  return partes.length ? '?' + partes.join('&') : '';
}

function verPreviaDaExportacao() {
  var nota = document.getElementById('expResultado');
  nota.textContent = 'Consultando...';

  /*
   * O preview NAO usa a janela com `novas=1`: ele mostra o periodo inteiro e
   * separa quantas sao novas. E a unica tela em que o dono ve os dois numeros
   * lado a lado, que e o que responde "vale a pena subir agora?".
   */
  var partes = [];
  var desde = (document.getElementById('expDesde') || {}).value;
  var ate = (document.getElementById('expAte') || {}).value;
  if (desde) partes.push('desde=' + encodeURIComponent(desde));
  if (ate) partes.push('ate=' + encodeURIComponent(ate));

  return api('/admin/conversoes-meta/preview' + (partes.length ? '?' + partes.join('&') : ''))
    .then(function (d) {
      nota.textContent =
        d.totalNoPeriodo + ' venda(s) no periodo · ' +
        d.novas + ' ainda nao subiram · ' +
        d.jaExportadas + ' ja subiram · ' +
        'R$ ' + d.valorTotal + ' · ' +
        d.comEmail + ' com e-mail, ' + d.comTelefone + ' com telefone' +
        (d.semMatching ? ' · ' + d.semMatching + ' sem e-mail nem telefone (ficam de fora)' : '') +
        (d.semCliente ? ' · ' + d.semCliente + ' sem o pedido' : '') +
        (d.invalidas ? ' · ' + d.invalidas + ' com data ou valor invalidos' : '');
    })
    .catch(function (erro) { nota.textContent = erro.message; });
}

function baixarArquivoDoMeta() {
  var nota = document.getElementById('expResultado');
  nota.textContent = 'Gerando...';

  /*
   * `fetch` cru e nao o ajudante `api`: a resposta e um CSV, nao JSON, e o que
   * interessa vem no CABECALHO (o batch_id). O ajudante leria o corpo como
   * JSON e perderia os dois.
   */
  return fetch('/api/admin/conversoes-meta.csv' + janelaDaExportacao(), {
    headers: { 'X-Admin-Sessao': estado.token },
  }).then(function (resposta) {
    if (!resposta.ok) {
      return resposta.json().catch(function () { return {}; }).then(function (corpo) {
        nota.textContent = corpo.message || 'Nao foi possivel gerar o arquivo.';
      });
    }

    var lote = resposta.headers.get('X-Export-Batch-Id') || '';
    var quantas = resposta.headers.get('X-Conversoes-Exportadas') || '0';

    return resposta.blob().then(function (arquivo) {
      var url = URL.createObjectURL(arquivo);
      var link = document.createElement('a');
      link.href = url;
      link.download = 'meta-offline-' + new Date().toISOString().slice(0, 10) + '.csv';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      /* Solta a memoria do blob: sem isto o arquivo fica preso ate a aba fechar. */
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);

      estado.resumo.loteDoMeta = lote;
      nota.textContent = quantas + ' venda(s) no arquivo. NADA foi marcado ainda — suba no Meta e confirme abaixo.';
      document.getElementById('expConfirmacao').hidden = false;
      document.getElementById('expLote').textContent = 'Lote ' + lote;
    });
  }).catch(function (erro) { nota.textContent = erro.message; });
}

function confirmarUploadNoMeta() {
  var lote = estado.resumo.loteDoMeta;
  var nota = document.getElementById('expLote');
  if (!lote) { nota.textContent = 'Baixe o arquivo primeiro.'; return Promise.resolve(); }

  nota.textContent = 'Confirmando...';
  return api('/admin/conversoes-meta/marcar', { method: 'POST', body: { batchId: lote } })
    .then(function (d) {
      nota.textContent = d.message;
      return carregarResumo();
    })
    .catch(function (erro) { nota.textContent = erro.message; });
}

ligarEventosResumo();

(function ligarExportacao() {
  var previa = document.getElementById('expPreview');
  if (previa) previa.addEventListener('click', verPreviaDaExportacao);
  var baixar = document.getElementById('expBaixar');
  if (baixar) baixar.addEventListener('click', baixarArquivoDoMeta);
  var confirmar = document.getElementById('expConfirmar');
  if (confirmar) confirmar.addEventListener('click', confirmarUploadNoMeta);
})();
