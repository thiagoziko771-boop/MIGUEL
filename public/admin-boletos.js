/* ======================================================================== */
/* Boletos (17/08/2026)                                                      */
/*                                                                          */
/* Boleto neste funil é OFFLINE. O site registra quem pediu e foi para o     */
/* WhatsApp; alguém emite o documento à mão em outro gateway; e o desfecho   */
/* — gerado, pago, não pago — é digitado AQUI. Nenhum webhook avisa nada.    */
/*                                                                          */
/* Por isso esta tela não é um relatório: é o lugar onde o trabalho é feito. */
/* Cada cartão traz o que quem emite precisa ter na mão (nome, CPF, valor)   */
/* e os botões que movem o estado. Marcar como PAGO manda a compra ao Meta   */
/* com o carimbo do anúncio que trouxe a pessoa — ver                        */
/* server/pedidoDeBoleto.ts.                                                 */
/*                                                                          */
/* Carregado depois do admin.js, de onde reaproveita os helpers.             */
/* ======================================================================== */

/* global estado, api, escapar, brl, cpfFmt, telFmt, digitos, dataCurta, dataCompleta, haQuanto, primeiroNome, semAcento, cartaoKpi, copiar, trocarRotulo */

estado.boletos = {
  dias: 30,
  situacao: '',
  busca: '',
  lista: [],
  resumo: null,
  carregado: false,
  carregando: false,
};

var ROTULO_SITUACAO_BOLETO = {
  pedido: 'Pediu boleto',
  gerado: 'Boleto gerado',
  pago: 'Pagou',
  nao_pago: 'Não pagou',
};

/* A cor diz o que fazer sem ler: amarelo pede ação, verde acabou, cinza morreu. */
var CLASSE_SITUACAO_BOLETO = {
  pedido: 'aguardando',
  gerado: 'aguardando',
  pago: 'pago',
  nao_pago: 'morto',
};

function carregarBoletos() {
  if (estado.boletos.carregando) return Promise.resolve();
  estado.boletos.carregando = true;

  return api('/admin/boletos?dias=' + estado.boletos.dias + '&t=' + Date.now())
    .then(function (dados) {
      estado.boletos.lista = dados.pedidos || [];
      estado.boletos.resumo = dados.resumo || null;
      estado.boletos.carregado = true;
      desenharBoletos();
    })
    .catch(function (falha) {
      if (falha.message !== 'Sessão expirada.') console.error(falha);
    })
    .finally(function () { estado.boletos.carregando = false; });
}

function boletosVisiveis() {
  var termo = semAcento(estado.boletos.busca).trim();
  var termoDigitos = digitos(estado.boletos.busca);

  return estado.boletos.lista.filter(function (b) {
    if (estado.boletos.situacao && b.situacao !== estado.boletos.situacao) return false;
    if (!termo && !termoDigitos) return true;

    // Dígitos batem contra CPF e telefone; texto, contra nome e e-mail. Buscar
    // "319" tem de achar o telefone, não o nome de quem tem 319 no endereço.
    if (termoDigitos && (digitos(b.documento).indexOf(termoDigitos) >= 0 || digitos(b.telefone).indexOf(termoDigitos) >= 0)) {
      return true;
    }
    return semAcento(b.nome + ' ' + b.email).indexOf(termo) >= 0;
  });
}

function desenharKpisBoletos() {
  var alvo = document.getElementById('kpisBoletos');
  var r = estado.boletos.resumo;
  if (!alvo) return;
  if (!r) { alvo.innerHTML = ''; return; }

  var emAberto = r.pedido + r.gerado;
  var decididos = r.pago + r.naoPago;
  var taxa = decididos > 0 ? Math.round((r.pago / decididos) * 100) : null;

  var cartoes = [
    cartaoKpi('Pediram boleto', String(r.total), 'no período escolhido'),
    cartaoKpi(
      'Esperando',
      String(emAberto),
      emAberto > 0 ? brl(r.emAbertoCentavos) + ' que ainda pode entrar' : 'nada parado',
      emAberto > 0 ? '' : 'secundario',
    ),
    cartaoKpi('Pagaram', String(r.pago), brl(r.receitaCentavos), 'secundario'),
    cartaoKpi(
      'Compensou',
      taxa === null ? '—' : taxa + '%',
      decididos > 0 ? 'de ' + decididos + ' com desfecho' : 'ninguém decidiu ainda',
      'secundario',
    ),
  ];

  /*
   * Este cartão só aparece quando há problema, e ele é o mais caro da tela:
   * cada boleto pago que não chegou ao Meta é uma venda que o anúncio fez e
   * não recebeu crédito por ter feito. Quem olha o Gerenciador vê um criativo
   * que não vende — e desliga o que estava vendendo.
   */
  if (r.pagosSemMeta > 0) {
    cartoes.push(
      cartaoKpi(
        'Fora do Meta',
        String(r.pagosSemMeta),
        'compras pagas que o anúncio não recebeu',
        '',
        { tom: 'desce' },
      ),
    );
  }

  alvo.innerHTML = cartoes.join('');
}

/** Origem em uma linha: nome do criativo quando existe, número quando não. */
function origemDoBoleto(b) {
  if (b.anuncioNome) return b.anuncioNome;
  if (b.criativo) return b.criativo;
  if (b.anuncioId) return 'anúncio ' + b.anuncioId;
  if (b.campanhaNome) return b.campanhaNome;
  if (b.plataforma === 'direto') return 'entrou direto';
  return b.plataforma;
}

/** O bloco que quem emite o boleto cola no painel do banco. */
function dadosDoPagador(b) {
  return (
    'Nome: ' + b.nome + '\n' +
    'CPF: ' + cpfFmt(b.documento) + '\n' +
    'E-mail: ' + b.email + '\n' +
    (b.telefone ? 'WhatsApp: ' + telFmt(b.telefone) + '\n' : '') +
    'Valor: ' + b.valorFormatado
  );
}

/*
 * A mensagem de volta. "Contribuição", nunca "pagamento" — é a mesma regra do
 * funil inteiro: quem entra aqui está retribuindo, e chamar isso de conta a
 * vencer transforma um gesto em cobrança. Conta atrasada dá vergonha, e quem
 * tem vergonha não responde.
 */
function mensagemDoBoleto(b) {
  var abre = 'Oi, ' + primeiroNome(b.nome) + '! Aqui é da equipe das Rezas Sagradas. ';
  if (b.situacao === 'pago') {
    return abre + 'Sua contribuição de ' + b.valorFormatado + ' foi confirmada e o acesso já está a caminho. ' +
      'Que o Arcanjo Miguel te cubra de bênçãos.';
  }
  if (b.situacao === 'gerado') {
    return abre + 'Seu boleto da Oração Sagrada do Arcanjo Miguel (' + b.valorFormatado + ') já foi enviado. ' +
      'Conseguiu receber?';
  }
  return abre + 'Recebi aqui o seu pedido de boleto da Oração Sagrada do Arcanjo Miguel (' + b.valorFormatado + '). ' +
    'Estou gerando e te mando em seguida.';
}

function linkZapBoleto(b) {
  var tel = digitos(b.telefone);
  if (!tel) return null;
  if (tel.length <= 11) tel = '55' + tel;
  return 'https://wa.me/' + tel + '?text=' + encodeURIComponent(mensagemDoBoleto(b));
}

function botaoSituacao(b, situacao, rotulo) {
  var atual = b.situacao === situacao;
  return (
    '<button class="botao-icone' + (atual ? ' marcado' : '') + '"' +
    ' data-boleto="' + escapar(b.id) + '" data-situacao="' + situacao + '"' +
    (atual ? ' disabled' : '') + '>' + escapar(rotulo) + '</button>'
  );
}

function linhaDoMeta(b) {
  if (b.situacao !== 'pago') return '';
  if (b.metaEnviadoEm) {
    return '<p class="meta-boleto ok">Compra enviada ao Meta ' + escapar(haQuanto(b.metaEnviadoEm)) + '.</p>';
  }
  return (
    '<p class="meta-boleto falta">Esta compra ainda não chegou ao Meta — o anúncio que a trouxe está sem o crédito dela. ' +
    '<button class="botao-icone" data-meta="' + escapar(b.id) + '">Enviar ao Meta</button></p>'
  );
}

function cartaoDeBoleto(b) {
  var zap = linkZapBoleto(b);

  return (
    '<article class="boleto" data-cartao="' + escapar(b.id) + '">' +
      '<header>' +
        '<div class="quem">' +
          '<strong>' + escapar(b.nome) + '</strong>' +
          '<span class="badge ' + CLASSE_SITUACAO_BOLETO[b.situacao] + '">' + escapar(ROTULO_SITUACAO_BOLETO[b.situacao]) + '</span>' +
        '</div>' +
        '<div class="valor">' + escapar(b.valorFormatado) + '</div>' +
      '</header>' +

      '<dl class="dados">' +
        '<div><dt>CPF</dt><dd>' + escapar(cpfFmt(b.documento)) + '</dd></div>' +
        '<div><dt>E-mail</dt><dd>' + escapar(b.email) + '</dd></div>' +
        '<div><dt>WhatsApp</dt><dd>' + escapar(b.telefone ? telFmt(b.telefone) : 'não deixou') + '</dd></div>' +
        '<div><dt>Veio de</dt><dd>' + escapar(origemDoBoleto(b)) + '</dd></div>' +
      '</dl>' +

      '<p class="itens">' + escapar(b.itens.join(' + ')) + '</p>' +

      '<p class="quando">' +
        'Pediu ' + escapar(dataCurta(b.criadoEm)) + ' (' + escapar(haQuanto(b.criadoEm)) + ')' +
        (b.geradoEm ? ' · gerado ' + escapar(dataCurta(b.geradoEm)) : '') +
        (b.pagoEm ? ' · pagou ' + escapar(dataCurta(b.pagoEm)) : '') +
        (b.naoPagoEm ? ' · não pagou ' + escapar(dataCurta(b.naoPagoEm)) : '') +
      '</p>' +

      '<div class="acoes">' +
        botaoSituacao(b, 'gerado', 'Boleto gerado') +
        botaoSituacao(b, 'pago', 'Pagou') +
        botaoSituacao(b, 'nao_pago', 'Não pagou') +
        (b.situacao === 'pedido' ? '' : botaoSituacao(b, 'pedido', 'Voltar para pedido')) +
        '<span class="espaco"></span>' +
        '<button class="botao-icone" data-copiar="' + escapar(b.id) + '">Copiar dados</button>' +
        (zap ? '<a class="botao-zap" href="' + escapar(zap) + '" target="_blank" rel="noopener">Chamar</a>' : '') +
      '</div>' +

      /*
       * A anotação é onde vai o número do boleto emitido lá fora. É o único
       * elo entre esta linha e o documento que existe no outro gateway —
       * sem ele, conferir um pagamento vira procurar um CPF na mão.
       */
      '<input class="anotacao" type="text" data-anotacao="' + escapar(b.id) + '"' +
        ' value="' + escapar(b.observacao || '') + '"' +
        ' placeholder="Anotação: número do boleto, o que combinaram, por que não pagou" />' +

      linhaDoMeta(b) +
    '</article>'
  );
}

function desenharBoletos() {
  if (estado.aba !== 'boletos') return;

  desenharKpisBoletos();

  var lista = document.getElementById('listaBoletos');
  var vazio = document.getElementById('vazioBoletos');
  var resumo = document.getElementById('resumoBoletos');
  if (!lista) return;

  var visiveis = boletosVisiveis();
  lista.innerHTML = visiveis.map(cartaoDeBoleto).join('');
  if (vazio) vazio.hidden = visiveis.length > 0 || !estado.boletos.carregado;

  if (resumo) {
    resumo.textContent = estado.boletos.carregado
      ? visiveis.length + ' de ' + estado.boletos.lista.length + ' pedidos de boleto'
      : 'Carregando...';
  }
}

function marcarBoleto(id, situacao, botao) {
  botao.disabled = true;
  api('/admin/boletos/' + encodeURIComponent(id) + '/situacao', { method: 'POST', body: { situacao: situacao } })
    .then(function (dados) {
      /*
       * O aviso do Meta é dado em voz alta e só quando ele tem conteúdo: marcar
       * como pago é o momento em que a venda offline vira — ou não vira —
       * crédito para o anúncio, e falhar em silêncio aqui é o pior desfecho
       * possível desta tela.
       */
      if (dados.meta && !dados.meta.enviado) window.alert(dados.meta.detalhe);
      return carregarBoletos();
    })
    .catch(function (falha) {
      botao.disabled = false;
      window.alert(falha.message);
    });
}

function salvarAnotacaoDoBoleto(id, texto, campo) {
  var boleto = acharBoleto(id);
  if (!boleto) return;

  campo.disabled = true;
  api('/admin/boletos/' + encodeURIComponent(id) + '/situacao', {
    method: 'POST',
    // A situação vai junto porque a rota é uma só; o que muda aqui é a anotação.
    body: { situacao: boleto.situacao, observacao: texto },
  })
    .then(function () {
      boleto.observacao = texto;
      campo.classList.add('salvo');
      setTimeout(function () { campo.classList.remove('salvo'); }, 1500);
    })
    .catch(function (falha) { window.alert(falha.message); })
    .finally(function () { campo.disabled = false; });
}

function acharBoleto(id) {
  return estado.boletos.lista.filter(function (b) { return b.id === id; })[0];
}

function ligarEventosBoletos() {
  var lista = document.getElementById('listaBoletos');
  if (!lista) return;

  lista.addEventListener('click', function (evento) {
    var marcar = evento.target.closest('button[data-situacao]');
    if (marcar) {
      marcarBoleto(marcar.dataset.boleto, marcar.dataset.situacao, marcar);
      return;
    }

    var copiarDados = evento.target.closest('button[data-copiar]');
    if (copiarDados) {
      var boleto = acharBoleto(copiarDados.dataset.copiar);
      if (!boleto) return;
      copiar(dadosDoPagador(boleto)).then(function () { trocarRotulo(copiarDados, 'Copiado!'); });
      return;
    }

    var aoMeta = evento.target.closest('button[data-meta]');
    if (aoMeta) {
      aoMeta.disabled = true;
      api('/admin/boletos/' + encodeURIComponent(aoMeta.dataset.meta) + '/meta', { method: 'POST' })
        .then(function (dados) {
          if (dados.meta && dados.meta.detalhe) window.alert(dados.meta.detalhe);
          return carregarBoletos();
        })
        .catch(function (falha) {
          aoMeta.disabled = false;
          window.alert(falha.message);
        });
    }
  });

  // 'change' e não 'input': salva quando a pessoa sai do campo, não a cada tecla.
  lista.addEventListener('change', function (evento) {
    var campo = evento.target.closest('input[data-anotacao]');
    if (campo) salvarAnotacaoDoBoleto(campo.dataset.anotacao, campo.value.trim(), campo);
  });

  var periodo = document.getElementById('periodoBoletos');
  if (periodo) {
    periodo.addEventListener('change', function () {
      estado.boletos.dias = Number(periodo.value);
      carregarBoletos();
    });
  }

  var atualizar = document.getElementById('recarregarBoletos');
  if (atualizar) atualizar.addEventListener('click', carregarBoletos);

  var chips = document.getElementById('chipsSituacaoBoletos');
  if (chips) {
    chips.addEventListener('click', function (evento) {
      var botao = evento.target.closest('button');
      if (!botao) return;
      estado.boletos.situacao = botao.dataset.situacao;
      Array.prototype.forEach.call(chips.querySelectorAll('button'), function (b) {
        b.setAttribute('aria-pressed', String(b === botao));
      });
      desenharBoletos();
    });
  }

  var busca = document.getElementById('buscaBoletos');
  if (busca) {
    busca.addEventListener('input', function () {
      estado.boletos.busca = busca.value;
      desenharBoletos();
    });
  }
}

/* Como os outros módulos do painel: o HTML já está no ar quando este script roda. */
ligarEventosBoletos();
