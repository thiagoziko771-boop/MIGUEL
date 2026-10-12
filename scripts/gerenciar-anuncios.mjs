#!/usr/bin/env node
/**
 * Operar a conta de anúncios do Meta pela linha de comando.
 *
 *   node scripts/gerenciar-anuncios.mjs listar
 *   node scripts/gerenciar-anuncios.mjs pausar <id> [<id>...]
 *   node scripts/gerenciar-anuncios.mjs ativar <id> [<id>...]
 *   node scripts/gerenciar-anuncios.mjs orcamento <adset_id> <reais_por_dia>
 *   node scripts/gerenciar-anuncios.mjs teto <reais>
 *   node scripts/gerenciar-anuncios.mjs duplicar-anuncio <ad_id> <adset_destino_id> [nome]
 *
 * POR QUE UM SCRIPT, E NÃO curl SOLTO: liberar `curl` no allowlist do Claude
 * Code libera qualquer chamada a qualquer lugar. Aqui a superfície é uma só —
 * a conta de anúncios deste projeto — e cada operação é nomeada, registrada e
 * legível depois. É a diferença entre dar a chave da casa e dar a chave de um
 * cômodo.
 *
 * TRÊS PROTEÇÕES QUE NÃO SÃO OPCIONAIS:
 *
 * 1. NUNCA APAGA. Só pausa. Anúncio pausado volta com um clique; anúncio
 *    apagado leva junto o histórico de aprendizado, que é o ativo mais caro de
 *    uma conta pequena. Não existe verbo de exclusão neste arquivo.
 * 2. TETO DE ORÇAMENTO. Nada acima de R$ 200/dia por conjunto sem edição
 *    manual deste arquivo — um zero a mais digitado por engano custaria um mês
 *    de faturamento numa conta que gasta R$ 40 por dia.
 * 3. O TOKEN NÃO VIAJA NA LINHA DE COMANDO. Sai do .env.local (que o
 *    .gitignore cobre) e vai no corpo do POST, não na URL — argumento de
 *    processo aparece em log de sistema e em `ps`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const RAIZ = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const API = 'https://graph.facebook.com/v25.0';
const TETO_DIARIO_CENTAVOS = 20000;

/**
 * Quanto um anúncio pode gastar sem vender antes de `zelar` pausá-lo.
 *
 * O padrão vale para a conta inteira. O mapa existe porque um teste de leque
 * — vários criativos disputando a mesma verba — precisa de gatilho mais curto
 * que um anúncio já validado rodando sozinho: ali o dinheiro serve para
 * ordenar as peças, não para dar chance a cada uma.
 */
const LIMITE_PADRAO_CENTAVOS = 2800;
const LIMITE_POR_CAMPANHA = {
  // TESTE-CRIATIVOS-MIGUEL-12-08-B — 5 estáticos dividindo R$ 50/dia [Claude 2026-08-12]
  '120251077012510047': 1500,
  // TESTE-VARIACOES-CTV2-15/08 — 5 variações do CTV-2 dividindo R$ 50/dia [Claude 2026-08-15]
  '120249593915550055': 1500,
  // ATENÇÃO — desde ~06h de 15/08/2026 o Meta BLOQUEIA o Purchase do site
  // (Events Manager: "Alguns dados do site foram bloqueados"). O robô lê
  // compras do Meta, então enxerga 0 venda em anúncio que vendeu 2x no painel
  // e pausaria os vencedores. Enquanto o bloqueio durar, as três campanhas
  // que vendem ficam com teto alto (R$ 300); a decisão de cortar é do dono,
  // lendo o painel. REMOVER estas três linhas quando a contestação passar.
  '120249575769470055': 30000, // ESTREIA-BM-NOVA (CTV-2 + AVATAR) [Claude 2026-08-16]
  '120249592641320055': 30000, // ESCALA-CTV2-CBO-15/08 [Claude 2026-08-16]
  '120249597087630055': 30000, // ESCALA-AVATAR-VSL-CBO-15/08 [Claude 2026-08-16]
};

/**
 * Um valor de configuração, do ambiente primeiro e do .env.local depois.
 *
 * A ordem importa: no GitHub Actions não existe .env.local — lá o valor chega
 * como secret, em variável de ambiente. Na máquina do dono é o contrário. Ler
 * as duas fontes deixa o mesmo arquivo servir aos dois lugares.
 */
function doAmbiente(nome) {
  const direto = (process.env[nome] ?? '').trim();
  if (direto) return direto;

  try {
    const env = readFileSync(path.join(RAIZ, '.env.local'), 'utf8');
    const linha = env.split(/\r?\n/).find((l) => l.startsWith(`${nome}=`));
    const valor = (linha ?? '').replace(new RegExp(`^${nome}=`), '').replace(/^"|"$/g, '').trim();
    if (valor) return valor;
  } catch {
    /* sem .env.local: o chamador decide o que fazer com o vazio */
  }
  return '';
}

function exigir(nome, comoObter) {
  const valor = doAmbiente(nome);
  if (valor) return valor;
  console.error(`${nome} não está no ambiente nem no .env.local.\n  → ${comoObter}`);
  process.exit(1);
}

function token() {
  return exigir('META_ADS_TOKEN', 'Gerenciador de Anúncios → Configurações → token com ads_management.');
}

/**
 * A conta de anúncios, com o `act_` na frente venha como vier.
 *
 * Também saiu de dentro do arquivo: era uma constante escrita no código, e
 * trocar de BM obrigava a editar o script. Aceitar tanto `act_123` quanto `123`
 * existe porque o Gerenciador mostra os dois formatos em telas diferentes, e
 * errar isso devolve um "conta não encontrada" que não explica nada.
 */
function conta() {
  const bruto = exigir('META_CONTA_ID', 'Gerenciador de Anúncios → o número da conta (act_...).');
  const digitos = bruto.replace(/\D/g, '');
  if (!digitos) {
    console.error(`META_CONTA_ID="${bruto}" não tem dígitos.`);
    process.exit(1);
  }
  return `act_${digitos}`;
}

async function pedir(caminho, { metodo = 'GET', campos = {}, corpo = null } = {}) {
  const url = new URL(`${API}/${caminho}`);
  const tk = token();

  if (metodo === 'GET') {
    for (const [k, v] of Object.entries(campos)) url.searchParams.set(k, v);
    url.searchParams.set('access_token', tk);
    const r = await fetch(url);
    const j = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(j.error ?? j).slice(0, 300));
    return j;
  }

  // Token no corpo: argumento de processo vaza em log de sistema.
  const forma = new URLSearchParams({ ...corpo, access_token: tk });
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: forma,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(j.error ?? j).slice(0, 300));
  return j;
}

const brl = (c) => 'R$ ' + (Number(c) / 100).toFixed(2).replace('.', ',');

/**
 * A assinatura que vai no nome de tudo que eu crio ou altero.
 *
 * Pedido do dono, e com razão: daqui a três meses, olhando uma lista de trinta
 * anúncios, ninguém lembra qual foi ele e qual fui eu — e sem isso não dá para
 * auditar uma decisão automática que gastou dinheiro. O nome do anúncio é o
 * único lugar que ele lê todo dia.
 */
function assinatura() {
  const agora = new Date();
  const dia = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(agora);
  return `[Claude ${dia}]`;
}

async function listar() {
  const j = await pedir(`${conta()}/ads`, {
    campos: {
      fields: 'id,name,effective_status,adset{id,name,effective_status,daily_budget},campaign{id,name,effective_status,daily_budget}',
      limit: '100',
    },
  });
  for (const a of j.data ?? []) {
    const orc = a.adset?.daily_budget ?? a.campaign?.daily_budget;
    console.log(
      [
        a.id.padEnd(18),
        a.name.slice(0, 24).padEnd(24),
        a.effective_status.padEnd(16),
        'conj:', (a.adset?.id ?? '').padEnd(18),
        (a.adset?.effective_status ?? '').padEnd(15),
        'orc:', orc ? brl(orc) : '—',
      ].join(' '),
    );
  }
  console.log(`\n${(j.data ?? []).length} anúncios.`);
}

/**
 * O criativo por trás de cada anúncio — o vídeo ou a imagem, não a caixa.
 *
 * A distinção não é acadêmica: o mesmo vídeo pode estar em vários anúncios, em
 * campanhas diferentes. Julgar anúncio por anúncio parte o desempenho de UMA
 * peça em pedaços pequenos demais para significar algo, e mata por "não vendeu"
 * um criativo que vendeu — só que na linha de baixo.
 */
async function criativos() {
  const j = await pedir(`${conta()}/ads`, {
    campos: {
      fields:
        'id,name,effective_status,url_tags,creative{id,name,video_id,image_hash,object_story_spec,effective_object_story_id,link_destination_display_url,template_url,object_url}',
      limit: '100',
    },
  });

  const porCriativo = new Map();
  for (const a of j.data ?? []) {
    const c = a.creative ?? {};
    // A peça é o vídeo/imagem. Sem eles, o próprio criativo vira a chave.
    const peca = c.video_id ? `video:${c.video_id}` : c.image_hash ? `img:${c.image_hash}` : `criativo:${c.id}`;
    if (!porCriativo.has(peca)) porCriativo.set(peca, { peca, nome: c.name ?? '', anuncios: [] });

    // O link de destino pode estar em vários lugares conforme o tipo do anúncio.
    const spec = c.object_story_spec ?? {};
    const link =
      spec.link_data?.link ||
      spec.video_data?.call_to_action?.value?.link ||
      c.template_url ||
      c.object_url ||
      '';

    porCriativo.get(peca).anuncios.push({ id: a.id, nome: a.name, status: a.effective_status, link });
  }

  for (const g of porCriativo.values()) {
    console.log(`\n${g.peca}`);
    for (const a of g.anuncios) {
      console.log(`   ${a.id.padEnd(18)} ${a.nome.slice(0, 24).padEnd(24)} ${a.status}`);
      if (a.link) console.log(`      destino: ${a.link}`);
    }
  }
  console.log(`\n${porCriativo.size} peça(s) distintas em ${(j.data ?? []).length} anúncios.`);
}

/**
 * Os parâmetros de URL de cada anúncio — o carimbo que diz de onde veio o clique.
 *
 * Sem `url_tags` o visitante chega ao site sem nada na URL, e o painel só pode
 * chamá-lo de "Direto". A venda acontece, entra no caixa, e não há como saber
 * qual criativo a trouxe. É o mesmo que anunciar com os olhos fechados: o
 * dinheiro sai identificado e volta anônimo.
 */
async function urltags() {
  /*
   * A verdade está no CRIATIVO, não no anúncio.
   *
   * `ads{url_tags}` volta vazio mesmo quando o carimbo existe — foi o que me
   * fez concluir errado uma vez que a gravação tinha falhado, quando na verdade
   * era a leitura que olhava o lugar errado.
   */
  const j = await pedir(`${conta()}/ads`, {
    campos: { fields: 'id,name,effective_status,creative{id,url_tags}', limit: '100' },
  });

  let comTag = 0;
  for (const a of j.data ?? []) {
    const tags = (a.creative?.url_tags ?? '').trim();
    const tem = Boolean(tags);
    if (tem) comTag += 1;
    console.log(
      `${tem ? 'OK  ' : 'SEM '} ${a.id.padEnd(18)} ${a.name.slice(0, 24).padEnd(24)} ${a.effective_status.padEnd(15)} ${tags.slice(0, 50)}`,
    );
  }
  console.log(`\n${comTag} de ${(j.data ?? []).length} anúncios carimbam a origem.`);
}

/**
 * Grava o carimbo de origem num anúncio, pela única via que funciona.
 *
 * `url_tags` no nível do anúncio é DERIVADO do criativo: um POST nele volta
 * 200 e não muda nada — o pior tipo de falha, a que parece sucesso. E criativo
 * no Meta é imutável, então carimbar exige criar outro.
 *
 * O QUE SALVA O ENGAJAMENTO: o criativo novo aponta para o MESMO post da
 * página (`object_story_id`). Curtidas, comentários e compartilhamentos vivem
 * no post, não no criativo — recriar apontando para outro lugar zeraria a prova
 * social, que num funil religioso é metade do convencimento.
 */
async function marcar(ids, tags) {
  if (!tags || !tags.includes('utm_')) {
    console.error('Passe a linha de parâmetros (precisa conter utm_).');
    process.exit(1);
  }

  for (const id of ids) {
    try {
      const ad = await pedir(id, {
        campos: { fields: 'name,creative{id,effective_object_story_id}' },
      });
      const post = ad.creative?.effective_object_story_id;
      if (!post) {
        console.error(`PULADO ${id}: sem post de origem; carimbar exigiria recriar o criativo do zero.`);
        process.exitCode = 1;
        continue;
      }

      const novo = await pedir(`${conta()}/adcreatives`, {
        metodo: 'POST',
        corpo: {
          object_story_id: post,
          url_tags: tags,
          name: `${(ad.name ?? 'anuncio').slice(0, 60)} — carimbado ${assinatura()}`,
        },
      });

      await pedir(id, { metodo: 'POST', corpo: { creative: JSON.stringify({ creative_id: novo.id }) } });
      console.log(`CARIMBADO: ${id} (criativo ${novo.id}, post ${post} preservado)`);
    } catch (erro) {
      console.error(`FALHOU ${id}: ${erro.message}`);
      process.exitCode = 1;
    }
  }
}

/**
 * A regra combinada: passou do limite sem nenhuma venda, pausa.
 *
 * Por que R$ 28 no caso geral: o ticket desta oferta fica entre R$ 47 e R$ 88,
 * e os anúncios que venderam converteram com R$ 16 a R$ 35 gastos. Um criativo
 * que passa de R$ 28 sem uma única compra já teve a chance que os vencedores
 * tiveram — o que vem depois é esperança, não teste.
 *
 * Por que R$ 15 na campanha de teste: ali são cinco criativos dividindo R$ 50
 * por dia. O objetivo não é dar chance cheia a cada peça, é descobrir depressa
 * qual delas merece a chance cheia. Deixar uma consumir R$ 28 é entregar metade
 * da verba do dia para um único palpite antes de olhar os outros quatro.
 *
 * SÓ PAUSA, NUNCA REATIVA. Religar é decisão de quem olha o criativo e o
 * contexto; desligar o que está sangrando pode ser mecânico. Assimetria de
 * propósito: o erro de pausar demais custa um anúncio parado, o de religar
 * sozinho custa dinheiro sem ninguém olhando.
 *
 * Sem `--aplicar` só mostra o que faria.
 */
/**
 * As vendas PAGAS por anúncio, lidas do nosso painel.
 *
 * Esta é a correção do erro que desligou anúncio que vendia: o Meta bloqueou o
 * Purchase deste site em 15/08/2026 e passou a reportar zero compra para todo
 * mundo. O robô acreditava, e pausava os vencedores de duas em duas horas.
 *
 * O painel não depende de pixel: ele conta pedido PAGO, com o carimbo do anúncio
 * que veio grudado desde a criação do pedido.
 *
 * Falhar aqui devolve `null`, e quem chama trata isso como "não sei" — nunca
 * como "não vendeu". A diferença é a que separa uma pausa correta de desligar a
 * campanha que sustenta a operação.
 */
async function vendasDoPainel(dias) {
  const base = (doAmbiente('PUBLIC_BASE_URL') || 'https://rezassagradas.site').replace(/\/+$/, '');
  const senha = doAmbiente('ADMIN_SENHA');
  if (!senha) {
    console.warn('AVISO: sem ADMIN_SENHA nao da para ler as vendas do painel.');
    return null;
  }

  try {
    const entrada = await fetch(`${base}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ senha }),
    });
    const dadosEntrada = await entrada.json();
    const token = dadosEntrada?.data?.token;
    if (!token) {
      console.warn('AVISO: o painel recusou a senha; nao da para conferir as vendas.');
      return null;
    }

    const resposta = await fetch(`${base}/api/admin/anuncios/vendas?dias=${dias}`, {
      headers: { 'X-Admin-Sessao': token },
    });
    const corpo = await resposta.json();
    if (!corpo?.success) return null;
    return corpo.data.porAnuncio ?? {};
  } catch (erro) {
    console.warn('AVISO: falha ao ler as vendas do painel:', erro.message);
    return null;
  }
}

async function zelar(aplicar, dias = 30) {
  const j = await pedir(`${conta()}/insights`, {
    campos: {
      level: 'ad',
      fields: 'ad_id,ad_name,campaign_id,spend,actions',
      date_preset: dias >= 30 ? 'last_30d' : 'last_7d',
      limit: '200',
    },
  });

  const situacao = await pedir(`${conta()}/ads`, {
    campos: { fields: 'id,effective_status', limit: '100' },
  });
  const status = new Map((situacao.data ?? []).map((a) => [a.id, a.effective_status]));

  /*
   * A VERDADE SOBRE VENDA VEM DO PAINEL, não do Meta.
   *
   * `null` significa que não deu para consultar — e aí NADA é pausado. Antes de
   * existir esta linha, "não sei se vendeu" e "não vendeu" eram a mesma coisa
   * para o robô, e foi assim que ele desligou o D-AVATAR-VSL-9x16-CBO com
   * R$ 60,50 gastos e vendas registradas no painel.
   */
  const vendas = await vendasDoPainel(dias);
  if (vendas === null) {
    console.log('Nao consegui conferir as vendas no painel. Nada sera pausado — decidir no escuro e o erro caro.');
    return;
  }

  const condenados = [];
  for (const linha of j.data ?? []) {
    const gastoCentavos = Math.round(Number(linha.spend ?? '0') * 100);
    // O MAIOR dos dois, nunca a soma: `purchase` e
    // `offsite_conversion.fb_pixel_purchase` são dois nomes que o Meta dá à
    // MESMA venda, e vêm os dois na mesma resposta. Somar dobrava a contagem.
    // A regra `compras > 0` sobrevivia ao engano, mas quem lesse o número via
    // o dobro do que existe — e um dia alguém decide com ele.
    const comprasNoMeta = (linha.actions ?? [])
      .filter((a) => a.action_type === 'purchase' || a.action_type === 'offsite_conversion.fb_pixel_purchase')
      .reduce((maior, a) => Math.max(maior, Number(a.value ?? 0)), 0);

    /*
     * O MAIOR entre o painel e o Meta, e não só o painel.
     *
     * O painel é a fonte confiável, mas ele só enxerga a venda que carregava o
     * id do anúncio; um clique cujo carimbo se perdeu no caminho aparece lá sem
     * anúncio. Se o Meta souber de uma compra que o painel não ligou a este
     * anúncio, ela conta do mesmo jeito — em dúvida, o anúncio fica no ar.
     * Pausar quem vende custa muito mais que deixar rodando quem não vende.
     */
    const comprasNoPainel = vendas[linha.ad_id]?.pagos ?? 0;
    const compras = Math.max(comprasNoMeta, comprasNoPainel);

    const limite = LIMITE_POR_CAMPANHA[linha.campaign_id] ?? LIMITE_PADRAO_CENTAVOS;

    // Só mexe no que está entregando: pausar o que já está parado é ruído.
    if (status.get(linha.ad_id) !== 'ACTIVE') continue;
    if (gastoCentavos <= limite || compras > 0) continue;

    condenados.push({ id: linha.ad_id, nome: linha.ad_name, gasto: gastoCentavos, limite });
  }

  if (condenados.length === 0) {
    console.log('Nenhum anúncio ativo passou do limite sem venda. Nada a fazer.');
    return;
  }

  for (const c of condenados) {
    console.log(
      `${aplicar ? 'PAUSANDO' : 'PAUSARIA'}: ${c.nome} (${c.id}) — ${brl(c.gasto)} sem nenhuma venda (limite ${brl(c.limite)})`,
    );
  }
  if (aplicar) await mudarStatus(condenados.map((c) => c.id), 'PAUSED');
  else console.log('\n(nada foi alterado — rode com --aplicar para valer)');
}

/**
 * O funil visto pelo lado do Meta, anúncio por anúncio.
 *
 * POR QUE NÃO BASTA O PAINEL /admin: ele enxerga quem CHEGOU no site. O trecho
 * caro do funil pago acontece antes disso — quantos viram, quantos clicaram e
 * quantos aguentaram o carregamento da página. Um criativo pode estar vendendo
 * mal por três motivos completamente diferentes (ninguém vê, veem e não clicam,
 * clicam e não chegam), e cada um pede um conserto distinto. Sem estas colunas a
 * conversa vira palpite.
 *
 * O `lpv` (visualização de página de destino) é a coluna que mais surpreende:
 * ele conta quem esperou a página abrir. Muito clique com pouco lpv é problema
 * de velocidade ou de destino quebrado, e não de criativo.
 *
 * ATENÇÃO À COLUNA DE COMPRAS enquanto durar o bloqueio de 15/08/2026: o Meta
 * está removendo os parâmetros dos eventos deste site, então `purchase` aqui
 * pode vir zerado mesmo com venda registrada no painel. A verdade financeira é
 * a do /admin — esta tabela serve para explicar a ENTREGA, não para contar
 * dinheiro.
 */
async function desempenho(dias = 7, porPosicionamento = false) {
  const janela = Number(dias) >= 30 ? 'last_30d' : Number(dias) <= 1 ? 'today' : 'last_7d';
  const j = await pedir(`${conta()}/insights`, {
    campos: {
      level: porPosicionamento ? 'account' : 'ad',
      fields:
        'ad_id,ad_name,campaign_name,spend,impressions,reach,frequency,clicks,inline_link_clicks,ctr,cpc,cpm,actions',
      date_preset: janela,
      limit: '200',
      /*
       * O posicionamento é onde o CPM se decide. Um criativo idêntico custa três
       * vezes mais em Reels do que em Feed, e a Audience Network entrega clique
       * acidental barato que enche o relatório e não chega no site. Sem esta
       * quebra, um CPM médio alto parece problema de criativo quando é problema
       * de onde o anúncio está sendo servido.
       */
      ...(porPosicionamento ? { breakdowns: 'publisher_platform,platform_position' } : {}),
    },
  });

  if (porPosicionamento) {
    console.log(['ONDE'.padEnd(28), 'GASTO'.padStart(8), 'IMPR'.padStart(7), 'CPM'.padStart(8), 'CLIQ'.padStart(6), 'CTR%'.padStart(6), 'LPV'.padStart(5)].join(' '));
    const linhas = (j.data ?? []).sort((a, b) => Number(b.spend ?? 0) - Number(a.spend ?? 0));
    for (const l of linhas) {
      const lpv = (l.actions ?? []).filter((a) => a.action_type === 'landing_page_view').reduce((m, a) => Math.max(m, Number(a.value ?? 0)), 0);
      console.log(
        [`${l.publisher_platform ?? '?'} / ${l.platform_position ?? '?'}`.slice(0, 28).padEnd(28),
          Number(l.spend ?? 0).toFixed(2).padStart(8), String(l.impressions ?? 0).padStart(7),
          Number(l.cpm ?? 0).toFixed(2).padStart(8), String(l.inline_link_clicks ?? l.clicks ?? 0).padStart(6),
          Number(l.ctr ?? 0).toFixed(2).padStart(6), String(lpv).padStart(5)].join(' '),
      );
    }
    return;
  }

  const conta1 = (acoes, ...tipos) =>
    (acoes ?? [])
      .filter((a) => tipos.includes(a.action_type))
      .reduce((maior, a) => Math.max(maior, Number(a.value ?? 0)), 0);

  const linhas = (j.data ?? []).map((l) => ({
    nome: l.ad_name ?? '',
    campanha: l.campanha_name ?? l.campaign_name ?? '',
    gasto: Number(l.spend ?? 0),
    impressoes: Number(l.impressions ?? 0),
    alcance: Number(l.reach ?? 0),
    frequencia: Number(l.frequency ?? 0),
    cliques: Number(l.inline_link_clicks ?? l.clicks ?? 0),
    ctr: Number(l.ctr ?? 0),
    cpc: Number(l.cpc ?? 0),
    cpm: Number(l.cpm ?? 0),
    lpv: conta1(l.actions, 'landing_page_view'),
    ic: conta1(l.actions, 'initiate_checkout', 'offsite_conversion.fb_pixel_initiate_checkout'),
    compras: conta1(l.actions, 'purchase', 'offsite_conversion.fb_pixel_purchase'),
  }));

  linhas.sort((a, b) => b.gasto - a.gasto);

  const num = (v, casas = 0) => (Number.isFinite(v) ? v.toFixed(casas) : '—');
  console.log(
    ['ANÚNCIO'.padEnd(30), 'GASTO'.padStart(8), 'IMPR'.padStart(7), 'FREQ'.padStart(5), 'CLIQ'.padStart(5),
      'CTR%'.padStart(6), 'CPC'.padStart(6), 'CPM'.padStart(7), 'LPV'.padStart(5), 'IC'.padStart(4), 'COMPR'.padStart(6)].join(' '),
  );

  const total = { gasto: 0, impressoes: 0, cliques: 0, lpv: 0, ic: 0, compras: 0 };
  for (const l of linhas) {
    for (const k of Object.keys(total)) total[k] += l[k] ?? 0;
    console.log(
      [l.nome.slice(0, 30).padEnd(30), num(l.gasto, 2).padStart(8), String(l.impressoes).padStart(7),
        num(l.frequencia, 2).padStart(5), String(l.cliques).padStart(5), num(l.ctr, 2).padStart(6),
        num(l.cpc, 2).padStart(6), num(l.cpm, 2).padStart(7), String(l.lpv).padStart(5),
        String(l.ic).padStart(4), String(l.compras).padStart(6)].join(' '),
    );
  }

  const taxa = (parte, todo) => (todo > 0 ? `${((parte / todo) * 100).toFixed(1)}%` : '—');
  console.log(
    `\nTOTAL (${janela}): R$ ${total.gasto.toFixed(2)} · ${total.impressoes} impressões · ${total.cliques} cliques` +
      ` · ${total.lpv} chegaram na página · ${total.ic} checkouts · ${total.compras} compras`,
  );
  console.log(
    `  clique -> página ${taxa(total.lpv, total.cliques)} · página -> checkout ${taxa(total.ic, total.lpv)}` +
      ` · checkout -> compra ${taxa(total.compras, total.ic)}`,
  );

  /*
   * O funil inteiro, degrau por degrau, na ordem em que o site dispara os
   * eventos (src/App.tsx e InlineCheckout.tsx):
   *
   *   chegou na página -> terminou o quiz -> viu a VSL -> abriu o checkout
   *   -> preencheu os dados -> viu o QR -> pagou
   *
   * É esta lista, e não o total de vendas, que diz ONDE o dinheiro morre. Duas
   * quedas têm consertos opostos: perder gente entre a página e o fim do quiz é
   * problema de promessa do anúncio; perder entre o QR e a compra é problema de
   * pagamento — e o segundo custa muito mais, porque a pessoa já escolheu.
   */
  const somaDe = (...tipos) =>
    (j.data ?? []).reduce(
      (soma, l) =>
        soma +
        (l.actions ?? [])
          .filter((a) => tipos.includes(a.action_type))
          .reduce((maior, a) => Math.max(maior, Number(a.value ?? 0)), 0),
      0,
    );

  const degraus = [
    ['chegou na página', total.lpv],
    ['terminou o quiz', somaDe('complete_registration', 'offsite_conversion.fb_pixel_complete_registration')],
    ['viu a VSL', somaDe('view_content', 'offsite_conversion.fb_pixel_view_content')],
    ['abriu o checkout', total.ic],
    ['preencheu os dados', somaDe('lead', 'offsite_conversion.fb_pixel_lead')],
    ['viu o QR do Pix', somaDe('add_payment_info', 'offsite_conversion.fb_pixel_add_payment_info')],
    ['pagou', total.compras],
  ];

  console.log('\nFUNIL PELO LADO DO META');
  let anterior = null;
  for (const [nome, valor] of degraus) {
    const passagem = anterior === null ? '' : `  (${taxa(valor, anterior)} do degrau acima)`;
    console.log(`  ${nome.padEnd(20)} ${String(valor).padStart(5)}${passagem}`);
    anterior = valor;
  }
  if (total.lpv > 0) {
    console.log(`\n  custo por visita R$ ${(total.gasto / total.lpv).toFixed(2)}`);
  }
}

/**
 * Baixa a arte de um anúncio para o disco.
 *
 * Existe para que a peça possa ser OLHADA antes de alguém propor variação dela.
 * Decidir "faça mais parecido com o que vendeu" sem ver o que vendeu é chutar
 * com vocabulário de dado.
 */
/**
 * Traz o arquivo do criativo de volta para o disco.
 *
 * Serve para levar o que já vende para outra conta de anúncios: criativo
 * validado é o ativo mais caro que uma conta pequena tem, e recomeçar do zero
 * numa BM nova sem ele é jogar fora semanas de teste pago.
 *
 * VÍDEO E IMAGEM SÃO CAMINHOS DIFERENTES, e essa distinção já custou caro: a
 * versão anterior tratava tudo como imagem e, ao topar com um vídeo, caía no
 * `thumbnail_url` e gravava uma miniatura de 64×64 com nome `.mp4`. O arquivo
 * existia, tinha 2 KB, e só se descobria que era inútil na hora de subir. Aqui
 * o vídeo tem busca própria, e quando ela falha o erro é alto — melhor não ter
 * arquivo do que ter um que engana.
 */
async function baixarCriativo(adId, destino) {
  const ad = await pedir(adId, {
    campos: { fields: 'name,creative{id,image_hash,image_url,thumbnail_url,video_id,object_story_spec}' },
  });

  const c = ad.creative ?? {};
  const spec = c.object_story_spec ?? {};
  const videoId = c.video_id || spec.video_data?.video_id || '';

  let url = '';
  let tipo = 'imagem';

  if (videoId) {
    tipo = 'vídeo';
    /*
     * `source` é o arquivo original. O Meta só o entrega a quem tem direito
     * sobre o vídeo, e devolve o campo vazio — sem erro — quando não tem.
     */
    const video = await pedir(videoId, { campos: { fields: 'source,permalink_url' } }).catch(() => ({}));
    url = video.source ?? '';
    if (!url) {
      throw new Error(
        `O vídeo ${videoId} não expôs o arquivo original (o token não tem direito sobre ele). ` +
          'Baixe pelo gerenciador, em Biblioteca de mídia, ou use o arquivo de origem.',
      );
    }
  } else {
    url = c.image_url || spec.link_data?.picture || '';

    // O hash dá a imagem em resolução cheia; o thumbnail é o último recurso.
    if (!url && c.image_hash) {
      const imgs = await pedir(`${conta()}/adimages`, {
        campos: { hashes: JSON.stringify([c.image_hash]), fields: 'hash,url,permalink_url,width,height' },
      });
      url = imgs.data?.[0]?.url ?? '';
    }
    if (!url) url = c.thumbnail_url ?? '';
    if (!url) throw new Error('Não achei nem imagem nem vídeo neste anúncio.');
  }

  const r = await fetch(url);
  if (!r.ok) throw new Error(`Falha ao baixar: HTTP ${r.status}`);
  const bytes = Buffer.from(await r.arrayBuffer());

  /*
   * Miniatura disfarçada é o defeito que este aviso persegue: qualquer coisa
   * abaixo de 20 KB não é um criativo de feed, é um placeholder.
   */
  if (bytes.length < 20 * 1024) {
    console.error(`AVISO: ${ad.name} veio com ${Math.round(bytes.length / 1024)} KB — pequeno demais para ser o criativo.`);
  }

  writeFileSync(destino, bytes);
  console.log(`BAIXADO (${tipo}): ${ad.name} -> ${destino} (${Math.round(bytes.length / 1024)} KB)`);
}

/** Renomeia, para carimbar quem mexeu e quando. */
async function renomear(id, nome) {
  await pedir(id, { metodo: 'POST', corpo: { name: `${nome} ${assinatura()}` } });
  console.log(`RENOMEADO: ${id} -> ${nome} ${assinatura()}`);
}

/* -------------------------------------------------------------------------- */
/* Subir criativo novo, no formato 1-1-1                                       */
/* -------------------------------------------------------------------------- */

/*
 * OS QUATRO IDENTIFICADORES DA CONTA VÊM DE FORA, e não mais escritos aqui.
 *
 * Estavam fixos no arquivo, e trocar de BM significava editar código com o dono
 * esperando — no pior momento possível, que é a hora de subir campanha. Agora
 * moram no .env.local e a troca é colar quatro linhas.
 *
 * São lidos por função, e não em constante, porque o script inteiro é carregado
 * mesmo para comandos que não falam com o Meta: `exigir` no topo do arquivo
 * mataria `--help` por falta de configuração.
 */
const PAGINA = () => exigir('META_PAGINA_ID', 'Configurações do Negócio → Páginas → o número da página.');
const INSTAGRAM = () => doAmbiente('META_INSTAGRAM_ID');
const PIXEL = () => exigir('META_PIXEL_ID', 'Gerenciador de Eventos → o conjunto de dados (só números).');
const DESTINO = doAmbiente('META_DESTINO') || 'https://rezassagradas.site/';

/**
 * Destino de UMA peça. Por padrão é o DESTINO global; a peça pode trazer
 * `destino` próprio (ex.: 'https://rezassagradas.site/?capa=pedido') para cair
 * numa capa específica. Existe desde 15/08/2026, quando os criativos do fluxo
 * de PEDIDO DE ORAÇÃO precisaram apontar para `?capa=pedido` sem tocar nos
 * anúncios que já rodam com o destino padrão.
 */
const destinoDaPeca = (peca) => (peca && typeof peca.destino === 'string' && peca.destino.trim() !== '' ? peca.destino.trim() : DESTINO);
const CARIMBO =
  'utm_source=facebook&utm_medium=paid&utm_campaign={{campaign.name}}&utm_id={{campaign.id}}' +
  '&utm_term={{adset.name}}&utm_content={{ad.name}}&fb_campaign_id={{campaign.id}}' +
  '&fb_adset_id={{adset.id}}&fb_ad_id={{ad.id}}&fb_placement={{placement}}&fb_source={{site_source_name}}';

const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));

/**
 * O Meta não aceita anúncio com vídeo que ainda está sendo processado.
 *
 * Criar o anúncio cedo demais devolve erro de mídia inválida — e o erro não diz
 * "espere", diz que o vídeo não existe. Daí a espera explícita aqui.
 */
async function esperarVideo(videoId, tentativas = 40) {
  for (let i = 0; i < tentativas; i += 1) {
    const v = await pedir(videoId, { campos: { fields: 'status,thumbnails{uri,is_preferred}' } });
    const fase = v.status?.video_status ?? v.status?.processing_progress ?? '';
    if (fase === 'ready') {
      const capas = v.thumbnails?.data ?? [];
      const preferida = capas.find((t) => t.is_preferred) ?? capas[0];
      return preferida?.uri ?? '';
    }
    if (fase === 'error') throw new Error('O Meta recusou o vídeo no processamento.');
    await espera(6000);
  }
  throw new Error('O vídeo não ficou pronto a tempo.');
}

/**
 * Sobe um criativo novo como campanha própria: uma campanha, um conjunto, um
 * anúncio.
 *
 * O 1-1-1 é escolha do dono e vai contra o que a documentação recomenda para
 * orçamento pequeno (consolidar em 2–3 conjuntos, ver .claude/TRAFEGO-2026.md).
 * A vantagem é isolar o teste: cada peça tem seu próprio orçamento e nenhuma
 * rouba entrega da outra. O custo é que nenhuma junta sinal para sair do
 * aprendizado. Vale para TESTAR criativo, não para escalar.
 *
 * `inicioEm` é ISO com fuso (ex.: 2026-08-12T04:00:00-03:00). O conjunto nasce
 * ATIVO com início no futuro — quem liga no horário é o Meta, não um cron que
 * pode falhar de madrugada.
 */
async function subirVideo({ url, nome, reais, inicioEm, mensagem, titulo }) {
  const centavos = Math.round(Number(String(reais).replace(',', '.')) * 100);
  if (!Number.isFinite(centavos) || centavos <= 0 || centavos > TETO_DIARIO_CENTAVOS) {
    throw new Error(`Orçamento inválido ou acima do teto de ${brl(TETO_DIARIO_CENTAVOS)}.`);
  }

  const marca = assinatura();
  console.log(`[1/5] enviando o vídeo ao Meta...`);
  const video = await pedir(`${conta()}/advideos`, { metodo: 'POST', corpo: { file_url: url, name: `${nome} ${marca}` } });

  console.log(`[2/5] aguardando o Meta processar (id ${video.id})...`);
  const capa = await esperarVideo(video.id);

  console.log(`[3/5] criando a campanha...`);
  const campanha = await pedir(`${conta()}/campaigns`, {
    metodo: 'POST',
    corpo: {
      name: `${nome} ${marca}`,
      objective: 'OUTCOME_SALES',
      status: 'ACTIVE',
      special_ad_categories: JSON.stringify([]),
      /*
       * `false` = o orçamento fica no CONJUNTO, não na campanha.
       *
       * A Meta passou a exigir a declaração explícita e recusa a criação sem
       * ela. Aqui tem que ser no conjunto mesmo: no formato 1-1-1 cada criativo
       * é testado com a sua própria verba, e orçamento de campanha remanejaria
       * dinheiro entre eles — que é justamente o que o teste não quer.
       */
      is_adset_budget_sharing_enabled: 'false',
    },
  });

  console.log(`[4/5] criando o conjunto (início ${inicioEm})...`);
  const conjunto = await pedir(`${conta()}/adsets`, {
    metodo: 'POST',
    corpo: {
      name: `${nome} — conjunto ${marca}`,
      campaign_id: campanha.id,
      daily_budget: String(centavos),
      billing_event: 'IMPRESSIONS',
      optimization_goal: 'OFFSITE_CONVERSIONS',
      /*
       * Menor custo, sem teto de lance.
       *
       * A Meta exige a estratégia declarada; as com limite (`COST_CAP`,
       * `LOWEST_COST_WITH_BID_CAP`) ainda pedem um valor. Teto de lance numa
       * conta que ainda não sabe seu CPA real trava a entrega antes de haver
       * dado para calibrar o teto — primeiro se descobre o custo, depois se
       * limita.
       */
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      promoted_object: JSON.stringify({ pixel_id: PIXEL(), custom_event_type: 'PURCHASE' }),
      // Mesmo recorte dos conjuntos que já vendem nesta conta.
      targeting: JSON.stringify({
        age_min: 18,
        age_max: 65,
        geo_locations: { countries: ['BR'] },
        targeting_automation: { advantage_audience: 0 },
      }),
      start_time: inicioEm,
      status: 'ACTIVE',
    },
  });

  console.log(`[5/5] criando o anúncio...`);
  const criativo = await pedir(`${conta()}/adcreatives`, {
    metodo: 'POST',
    corpo: {
      name: `${nome} — criativo ${marca}`,
      object_story_spec: JSON.stringify({
        page_id: PAGINA(),
        instagram_user_id: INSTAGRAM(),
        video_data: {
          video_id: video.id,
          image_url: capa,
          message: mensagem,
          title: titulo,
          call_to_action: { type: 'LEARN_MORE', value: { link: DESTINO } },
        },
      }),
      url_tags: CARIMBO,
    },
  });

  const anuncio = await pedir(`${conta()}/ads`, {
    metodo: 'POST',
    corpo: {
      name: `${nome} ${marca}`,
      adset_id: conjunto.id,
      creative: JSON.stringify({ creative_id: criativo.id }),
      status: 'ACTIVE',
    },
  });

  console.log(
    `NO AR ÀS ${inicioEm.slice(11, 16)}: "${nome}" — campanha ${campanha.id}, conjunto ${conjunto.id}, anúncio ${anuncio.id}, ${brl(centavos)}/dia`,
  );
}

/**
 * Sobe um criativo ESTÁTICO como campanha própria (1-1-1).
 *
 * Imagem não vai por URL: a API de `adimages` recebe os bytes. O arquivo é
 * lido do disco e enviado em base64, e o que volta é um `hash` — é ele, e não
 * a imagem, que o criativo referencia depois.
 */
async function subirImagem({ arquivo, nome, reais, inicioEm, mensagem, titulo, idadeMin }) {
  const centavos = Math.round(Number(String(reais).replace(',', '.')) * 100);
  if (!Number.isFinite(centavos) || centavos <= 0 || centavos > TETO_DIARIO_CENTAVOS) {
    throw new Error(`Orçamento inválido ou acima do teto de ${brl(TETO_DIARIO_CENTAVOS)}.`);
  }
  const idade = Number.isFinite(Number(idadeMin)) ? Number(idadeMin) : 45;
  const marca = assinatura();

  console.log(`[1/4] enviando a imagem...`);
  const bytes = readFileSync(arquivo).toString('base64');
  const envio = await pedir(`${conta()}/adimages`, { metodo: 'POST', corpo: { bytes } });
  const hash = Object.values(envio.images ?? {})[0]?.hash;
  if (!hash) throw new Error('O Meta não devolveu o hash da imagem.');

  console.log(`[2/4] criando a campanha...`);
  const campanha = await pedir(`${conta()}/campaigns`, {
    metodo: 'POST',
    corpo: {
      name: `${nome} ${marca}`,
      objective: 'OUTCOME_SALES',
      status: 'ACTIVE',
      special_ad_categories: JSON.stringify([]),
      is_adset_budget_sharing_enabled: 'false',
    },
  });

  console.log(`[3/4] criando o conjunto (${idade}+, início ${inicioEm})...`);
  const conjunto = await pedir(`${conta()}/adsets`, {
    metodo: 'POST',
    corpo: {
      name: `${nome} — conjunto ${marca}`,
      campaign_id: campanha.id,
      daily_budget: String(centavos),
      billing_event: 'IMPRESSIONS',
      optimization_goal: 'OFFSITE_CONVERSIONS',
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      promoted_object: JSON.stringify({ pixel_id: PIXEL(), custom_event_type: 'PURCHASE' }),
      targeting: JSON.stringify({
        age_min: idade,
        age_max: 65,
        geo_locations: { countries: ['BR'] },
        targeting_automation: { advantage_audience: 0 },
      }),
      start_time: inicioEm,
      status: 'ACTIVE',
    },
  });

  console.log(`[4/4] criando o anúncio...`);
  const criativo = await pedir(`${conta()}/adcreatives`, {
    metodo: 'POST',
    corpo: {
      name: `${nome} — criativo ${marca}`,
      object_story_spec: JSON.stringify({
        page_id: PAGINA(),
        instagram_user_id: INSTAGRAM(),
        link_data: {
          link: DESTINO,
          image_hash: hash,
          message: mensagem,
          name: titulo,
          call_to_action: { type: 'LEARN_MORE', value: { link: DESTINO } },
        },
      }),
      url_tags: CARIMBO,
    },
  });

  const anuncio = await pedir(`${conta()}/ads`, {
    metodo: 'POST',
    corpo: {
      name: `${nome} ${marca}`,
      adset_id: conjunto.id,
      creative: JSON.stringify({ creative_id: criativo.id }),
      status: 'ACTIVE',
    },
  });

  console.log(`NO AR ÀS ${inicioEm.slice(11, 16)}: "${nome}" — anúncio ${anuncio.id}, ${brl(centavos)}/dia, ${idade}+`);
}

/**
 * Sobe VÁRIOS criativos disputando dentro do MESMO conjunto.
 *
 * É a estrutura certa para testar peça nova com orçamento curto, e a diferença
 * para o 1-1-1 é dinheiro concreto: com uma campanha por criativo, cada peça
 * ruim gasta até o limite da regra de corte antes de alguém desligá-la — cinco
 * peças, cinco vezes o desperdício. Aqui os cinco competem pela mesma verba, e
 * o algoritmo para de servir o que não engaja em poucas horas, sozinho.
 *
 * O preço disso é conhecido e aceito: a entrega tende a se concentrar em dois
 * ou três criativos, e os últimos podem terminar o teste com dados fracos
 * demais para julgar. Para ACHAR vencedor com pouco dinheiro, vale; para dar
 * chance igual a todos, não é a estrutura.
 *
 * Recebe um JSON: { campanha, reais, inicioEm, idadeMin, evento?, cbo?, pecas: [...] }
 */
async function subirLote(caminhoDoPlano) {
  const plano = JSON.parse(readFileSync(caminhoDoPlano, 'utf8'));
  const centavos = Math.round(Number(plano.reais) * 100);
  if (!Number.isFinite(centavos) || centavos <= 0 || centavos > TETO_DIARIO_CENTAVOS) {
    throw new Error(`Orçamento inválido ou acima do teto de ${brl(TETO_DIARIO_CENTAVOS)}.`);
  }
  const idade = Number(plano.idadeMin) || 45;
  // Evento de otimização do conjunto. Padrão PURCHASE (escala). Campanha de
  // TESTE de criativo pode pedir INITIATED_CHECKOUT no plano: com R$ 50/dia,
  // 20+ checkouts/dia ensinam o algoritmo mais rápido que 1-2 compras.
  const evento = String(plano.evento || 'PURCHASE').toUpperCase();
  if (!['PURCHASE', 'INITIATED_CHECKOUT'].includes(evento)) {
    throw new Error(`evento inválido no plano: ${evento} (use PURCHASE ou INITIATED_CHECKOUT)`);
  }
  const marca = assinatura();

  /*
   * `"cbo": true` no plano põe o orçamento na CAMPANHA, e não no conjunto.
   *
   * A diferença não é de organização, é de para onde o dinheiro corre. Com a
   * verba no conjunto, cada conjunto gasta a sua até o fim, dê ou não resultado.
   * Com a verba na campanha, o Meta remaneja entre os conjuntos ao longo do dia
   * e concentra no que converte — o que serve quando se quer ESCALAR o que já
   * funciona. Para um teste de leque (várias peças no mesmo conjunto) tanto faz,
   * porque a disputa já acontece entre criativos.
   *
   * O QUE MUDA NA API, e é onde erra quem tenta na mão: com orçamento na
   * campanha, `daily_budget` E `bid_strategy` moram na campanha. Repetir
   * qualquer um dos dois no conjunto faz a Meta recusar a criação — e como a
   * campanha já foi criada no passo anterior, o erro deixa uma campanha órfã,
   * sem conjunto e sem anúncio, que ninguém vê porque não gasta nada.
   *
   * `is_adset_budget_sharing_enabled` CONTINUA 'false' NOS DOIS MODOS, e o nome
   * engana: ele não é o interruptor do CBO. É o compartilhamento de orçamento
   * ENTRE CONJUNTOS que têm verba própria, e por isso é mutuamente exclusivo com
   * orçamento de campanha — mandar 'true' junto com `daily_budget` na campanha
   * devolve erro 100/4834002 ("não é possível usar o compartilhamento de
   * orçamento do conjunto de anúncios com orçamento da campanha"). Descoberto na
   * primeira tentativa de subir a TESTE-CTV-JESUS em 16/08/2026. O que decide se
   * a campanha é CBO é só ONDE o `daily_budget` está.
   */
  const cbo = plano.cbo === true;

  /*
   * `"bidCapReais": 32` diz ao Meta o MÁXIMO que aceitamos pagar por conversão.
   *
   * O QUE ELE FAZ DE VERDADE: não é desconto, é recusa. O Meta deixa de
   * participar de todo leilão em que a conversão sairia mais cara que o teto —
   * e se o custo real do público estiver acima dele, a entrega simplesmente não
   * acontece. Nesta conta já houve um caso: o A-OUCA-MIGUEL-4x5-BIDCAP tinha
   * R$ 60/dia de orçamento e não aparece em NENHUM relatório de gasto de 30
   * dias. Não foi pausado por gastar mal; foi pausado por nunca ter entregue.
   *
   * Por isso o teto precisa ser maior que o custo real, e não igual ao desejado.
   * Se a campanha nascer e não gastar em algumas horas, o teto é o suspeito —
   * subi-lo é um POST, e não exige refazer nada.
   *
   * ONDE CADA COISA MORA: com orçamento na campanha (CBO), `bid_strategy` é da
   * CAMPANHA e `bid_amount` é do CONJUNTO. Trocar isso de lugar devolve erro.
   */
  const bidCapCentavos = plano.bidCapReais
    ? Math.round(Number(String(plano.bidCapReais).replace(',', '.')) * 100)
    : 0;
  if (plano.bidCapReais && (!Number.isFinite(bidCapCentavos) || bidCapCentavos <= 0)) {
    throw new Error(`bidCapReais inválido no plano: ${plano.bidCapReais}`);
  }
  const estrategia = bidCapCentavos > 0 ? 'LOWEST_COST_WITH_BID_CAP' : 'LOWEST_COST_WITHOUT_CAP';

  console.log(
    `[1/3] criando a campanha "${plano.campanha}"${cbo ? ` (CBO, ${brl(centavos)}/dia` : ''}` +
      `${bidCapCentavos > 0 ? `, teto de lance ${brl(bidCapCentavos)} por compra` : ''}${cbo ? ')' : ''}...`,
  );
  const campanha = await pedir(`${conta()}/campaigns`, {
    metodo: 'POST',
    corpo: {
      name: `${plano.campanha} ${marca}`,
      objective: 'OUTCOME_SALES',
      status: 'ACTIVE',
      special_ad_categories: JSON.stringify([]),
      is_adset_budget_sharing_enabled: 'false',
      ...(cbo ? { daily_budget: String(centavos), bid_strategy: estrategia } : {}),
    },
  });

  console.log(
    `[2/3] criando o conjunto (${cbo ? 'orçamento na campanha' : `${brl(centavos)}/dia`}, ${idade}+, otimiza ${evento}, início ${plano.inicioEm})...`,
  );
  const conjunto = await pedir(`${conta()}/adsets`, {
    metodo: 'POST',
    corpo: {
      name: `${plano.campanha} — conjunto ${marca}`,
      campaign_id: campanha.id,
      ...(cbo ? {} : { daily_budget: String(centavos), bid_strategy: estrategia }),
      ...(bidCapCentavos > 0 ? { bid_amount: String(bidCapCentavos) } : {}),
      billing_event: 'IMPRESSIONS',
      optimization_goal: 'OFFSITE_CONVERSIONS',
      promoted_object: JSON.stringify({ pixel_id: PIXEL(), custom_event_type: evento }),
      targeting: JSON.stringify({
        age_min: idade,
        age_max: 65,
        geo_locations: { countries: ['BR'] },
        targeting_automation: { advantage_audience: 0 },
      }),
      start_time: plano.inicioEm,
      status: 'ACTIVE',
    },
  });

  console.log('[3/3]');
  await subirPecas(plano, conjunto.id);

  console.log(
    `\nNO AR ÀS ${String(plano.inicioEm).slice(11, 16)} — campanha ${campanha.id}, conjunto ${conjunto.id}, ${brl(centavos)}/dia${cbo ? ' na campanha (CBO)' : ''}, ${idade}+`,
  );
}

const ehVideo = (arquivo) => /\.(mp4|mov|m4v|webm)$/i.test(String(arquivo));

/**
 * O miolo do criativo quando a peça é uma IMAGEM.
 *
 * `bytes` em base64 no corpo do POST, e não upload multipart, porque é o que
 * `pedir()` sabe montar — e imagem de feed cabe folgado nesse formato.
 */
async function contarComImagem(peca) {
  const bytes = readFileSync(peca.arquivo).toString('base64');
  const envio = await pedir(`${conta()}/adimages`, { metodo: 'POST', corpo: { bytes } });
  const hash = Object.values(envio.images ?? {})[0]?.hash;
  if (!hash) throw new Error('sem hash da imagem');

  return {
    link_data: {
      link: destinoDaPeca(peca),
      image_hash: hash,
      message: peca.mensagem,
      name: peca.titulo,
      call_to_action: { type: 'LEARN_MORE', value: { link: destinoDaPeca(peca) } },
    },
  };
}

/**
 * O miolo do criativo quando a peça é um VÍDEO.
 *
 * TRÊS DIFERENÇAS que não dá para adivinhar lendo o caminho da imagem:
 *
 * 1. VAI EM MULTIPART, não em base64. O `/advideos` recusa `bytes`, e um vídeo
 *    de feed em base64 cresce um terço e estoura o limite do corpo. Por isso a
 *    chamada é `fetch` cru com `FormData`, fora de `pedir()`.
 * 2. O META PROCESSA DEPOIS DE RECEBER, e criar o anúncio antes disso devolve
 *    "mídia inválida" — um erro que não diz "espere", diz que o vídeo não
 *    existe. `esperarVideo` segura até ficar `ready`.
 * 3. A CAPA É OBRIGATÓRIA. Sem `image_url` o anúncio sobe com quadro preto no
 *    feed de quem tem reprodução automática desligada, que é boa parte deste
 *    público. Usamos a miniatura que o próprio Meta marca como preferida.
 */
async function contarComVideo(peca, marca) {
  const caminho = peca.arquivo;
  const bytes = readFileSync(caminho);
  console.log(`   enviando o vídeo ${peca.nome} (${Math.round(bytes.length / 1024)} KB)...`);

  const forma = new FormData();
  forma.append('name', `${peca.nome} ${marca}`);
  forma.append('source', new Blob([bytes]), path.basename(caminho));
  forma.append('access_token', token());

  const resposta = await fetch(`${API}/${conta()}/advideos`, { method: 'POST', body: forma });
  const video = await resposta.json();
  if (!resposta.ok) throw new Error(JSON.stringify(video.error ?? video).slice(0, 300));

  console.log(`   aguardando o Meta processar (id ${video.id})...`);
  const capa = await esperarVideo(video.id);

  return {
    video_data: {
      video_id: video.id,
      image_url: capa,
      message: peca.mensagem,
      title: peca.titulo,
      call_to_action: { type: 'LEARN_MORE', value: { link: destinoDaPeca(peca) } },
    },
  };
}

/**
 * Sobe as peças de um plano num conjunto que JÁ EXISTE. Aceita imagem e vídeo
 * na mesma lista — decide pela extensão do arquivo.
 *
 * Nasceu de um lote que morreu pela metade: campanha e conjunto criados, e as
 * três peças recusadas de uma vez (o app estava em modo de desenvolvimento, e o
 * Meta não deixa app assim publicar post que vá ao público). Sem este verbo, a
 * única saída seria rodar `subir-lote` de novo — o que criaria uma SEGUNDA
 * campanha e um SEGUNDO conjunto, e deixaria os dois brigando pela mesma verba.
 *
 * POR QUE ISTO IMPORTA MAIS QUE PARECE: testar criativo novo abrindo campanha
 * nova é o formato 1-1-1 de `subir-video`, e ele custa caro com verba pequena —
 * cada campanha recomeça o aprendizado do zero e nenhuma junta conversão
 * suficiente para sair dele. Em 12/08/2026 foram sete campanhas dividindo
 * R$ 134, e nenhuma acumulou sinal. Peça nova num conjunto que já roda disputa
 * a entrega com as irmãs e o Meta desloca a verba para a que converte, sem
 * recomeçar nada.
 *
 * Isto NÃO fere a regra de "criativo novo vai em campanha nova": a regra existe
 * para ninguém TROCAR a arte de um anúncio que já roda, o que ressuscita peça
 * pausada e joga fora o aprendizado dela. Aqui nenhum anúncio existente é
 * tocado — nasce um do lado.
 *
 * Roda quantas vezes for preciso: peça cujo anúncio já existe no conjunto é
 * pulada pelo nome, então retomar depois de meia falha não duplica nada.
 */
async function subirPecas(plano, adsetId) {
  const marca = assinatura();

  const jaLa = await pedir(`${adsetId}/ads`, {
    campos: { fields: 'id,name', limit: '100' },
  });
  const nomes = new Set((jaLa.data ?? []).map((a) => a.name));

  console.log(`subindo ${plano.pecas.length} criativos no conjunto ${adsetId}...`);
  let subiram = 0;
  for (const peca of plano.pecas) {
    const nomeFinal = `${peca.nome} ${marca}`;
    if (nomes.has(nomeFinal)) {
      console.log(`   PULOU ${peca.nome}: já está no conjunto`);
      continue;
    }
    try {
      const historia = ehVideo(peca.arquivo)
        ? await contarComVideo(peca, marca)
        : await contarComImagem(peca);

      const criativo = await pedir(`${conta()}/adcreatives`, {
        metodo: 'POST',
        corpo: {
          name: `${peca.nome} — criativo ${marca}`,
          object_story_spec: JSON.stringify({
            page_id: PAGINA(),
            instagram_user_id: INSTAGRAM(),
            ...historia,
          }),
          url_tags: CARIMBO,
        },
      });

      const anuncio = await pedir(`${conta()}/ads`, {
        metodo: 'POST',
        corpo: {
          name: nomeFinal,
          adset_id: adsetId,
          creative: JSON.stringify({ creative_id: criativo.id }),
          status: 'ACTIVE',
        },
      });
      console.log(`   OK  ${peca.nome} -> ${anuncio.id}`);
      subiram += 1;
    } catch (erro) {
      // Uma peça problemática não pode derrubar as outras quatro.
      console.error(`   FALHOU ${peca.nome}: ${erro.message}`);
      process.exitCode = 1;
    }
  }
  return subiram;
}

async function mudarStatus(ids, status) {
  for (const id of ids) {
    try {
      await pedir(id, { metodo: 'POST', corpo: { status } });
      console.log(`${status === 'PAUSED' ? 'PAUSADO' : 'ATIVADO'}: ${id}`);
    } catch (erro) {
      console.error(`FALHOU ${id}: ${erro.message}`);
      process.exitCode = 1;
    }
  }
}

/**
 * O teto de gasto da conta inteira.
 *
 * DUAS ARMADILHAS, e as duas já morderam:
 *
 * 1. O VALOR VAI EM REAIS INTEIROS, ao contrário de `daily_budget`, que vai em
 *    centavos. Mandar 9400 querendo R$ 94 grava R$ 9.400 e o teto deixa de
 *    existir. O POST devolve `success: true` nos dois casos, então o GET de
 *    conferência abaixo não é zelo: é a única forma de saber o que foi gravado.
 *
 * 2. O TETO É ABSOLUTO E ACUMULADO, não uma verba que renasce todo dia. Ele é
 *    comparado com `amount_spent`, que segue correndo, e por isso o Meta RECUSA
 *    qualquer teto menor que o já gasto ("O limite é muito baixo"). O número a
 *    enviar é `gasto atual + quanto ainda pode ser gasto`, e não o quanto se
 *    quer liberar — pedir 80 com R$ 82,91 já gastos é um erro, não um teto de
 *    oitenta reais.
 *
 *    O contador só volta a zero se alguém redefinir o gasto pelo gerenciador,
 *    à mão. Como o teto não reinicia à meia-noite, gastá-lo todo hoje deixa a
 *    conta parada amanhã até que ele seja levantado de novo.
 *
 * Quando o teto é atingido, a conta INTEIRA para de entregar, inclusive o
 * anúncio que está dando lucro. Por isso ele é o primeiro número a olhar num
 * dia que parou de vender sem explicação.
 */
const TETO_MAXIMO_REAIS = 500;

async function teto(reais) {
  const valor = Math.round(Number(String(reais).replace(',', '.')));
  if (!Number.isFinite(valor) || valor <= 0) {
    console.error('Valor inválido. Use reais inteiros: teto 80');
    process.exit(1);
  }
  if (valor > TETO_MAXIMO_REAIS) {
    console.error(`Recusado: R$ ${valor} passa do limite de R$ ${TETO_MAXIMO_REAIS} deste script.`);
    process.exit(1);
  }

  const antes = await pedir(conta(), { campos: { fields: 'spend_cap,amount_spent' } });
  console.log(`antes:  teto ${brl(antes.spend_cap)} | gasto ${brl(antes.amount_spent)}`);

  await pedir(conta(), { metodo: 'POST', corpo: { spend_cap: String(valor) } });

  const depois = await pedir(conta(), { campos: { fields: 'spend_cap,amount_spent' } });
  const disponivel = Number(depois.spend_cap) - Number(depois.amount_spent);
  console.log(`depois: teto ${brl(depois.spend_cap)} | gasto ${brl(depois.amount_spent)}`);
  console.log(`DISPONÍVEL: ${brl(disponivel)}`);

  // Cem vezes o pretendido é exatamente o erro de centavos: avisa alto.
  if (Number(depois.spend_cap) > valor * 100) {
    console.error('ATENÇÃO: o teto gravado é 100x o pedido. Foi enviado em centavos por engano.');
    process.exit(1);
  }
}

async function orcamento(adsetId, reais) {
  const centavos = Math.round(Number(String(reais).replace(',', '.')) * 100);
  if (!Number.isFinite(centavos) || centavos <= 0) {
    console.error('Valor inválido.');
    process.exit(1);
  }
  if (centavos > TETO_DIARIO_CENTAVOS) {
    console.error(`Recusado: ${brl(centavos)}/dia passa do teto de ${brl(TETO_DIARIO_CENTAVOS)} deste script.`);
    process.exit(1);
  }
  await pedir(adsetId, { metodo: 'POST', corpo: { daily_budget: String(centavos) } });
  console.log(`ORÇAMENTO de ${adsetId} agora é ${brl(centavos)}/dia.`);
}

/**
 * Duplica um anúncio dentro de um conjunto — o mesmo criativo, outra vez.
 *
 * Nasce PAUSADO de propósito: duplicata que já sobe entregando começa a gastar
 * antes de alguém conferir se foi para o conjunto certo.
 */
async function duplicarAnuncio(adId, adsetDestino, nome) {
  const original = await pedir(adId, { campos: { fields: 'name,creative{id}' } });
  const criativo = original.creative?.id;
  if (!criativo) throw new Error('O anúncio original não expôs o criativo.');

  const criado = await pedir(`${conta()}/ads`, {
    metodo: 'POST',
    corpo: {
      name: `${nome || `${original.name} (copia)`} ${assinatura()}`,
      adset_id: adsetDestino,
      creative: JSON.stringify({ creative_id: criativo }),
      status: 'PAUSED',
    },
  });
  console.log(`DUPLICADO: ${adId} -> ${criado.id} (no conjunto ${adsetDestino}, PAUSADO)`);
}

const [verbo, ...args] = process.argv.slice(2);

try {
  if (verbo === 'listar') await listar();
  else if (verbo === 'criativos') await criativos();
  else if (verbo === 'urltags') await urltags();
  else if (verbo === 'zelar') await zelar(args.includes('--aplicar'));
  else if (verbo === 'desempenho') await desempenho(args[0] ?? 7, args.includes('--posicionamento'));
  else if (verbo === 'baixar-criativo') await baixarCriativo(args[0], args[1]);
  else if (verbo === 'subir-video')
    await subirVideo({
      url: args[0],
      nome: args[1],
      reais: args[2],
      inicioEm: args[3],
      mensagem: args[4] ?? '',
      titulo: args[5] ?? '',
    });
  else if (verbo === 'subir-imagem')
    await subirImagem({ arquivo: args[0], nome: args[1], reais: args[2], inicioEm: args[3], mensagem: args[4] ?? '', titulo: args[5] ?? '', idadeMin: args[6] });
  else if (verbo === 'subir-lote') await subirLote(args[0]);
  else if (verbo === 'subir-pecas') {
    if (!args[0] || !args[1]) throw new Error('use: subir-pecas <plano.json> <adset_id>');
    const plano = JSON.parse(readFileSync(args[0], 'utf8'));
    const n = await subirPecas(plano, args[1]);
    console.log(`
${n} peça(s) nova(s) no conjunto ${args[1]}.`);
  }
  else if (verbo === 'renomear') await renomear(args[0], args.slice(1).join(' '));
  else if (verbo === 'marcar') await marcar(args.slice(0, -1), args[args.length - 1]);
  else if (verbo === 'pausar') await mudarStatus(args, 'PAUSED');
  else if (verbo === 'ativar') await mudarStatus(args, 'ACTIVE');
  else if (verbo === 'orcamento') await orcamento(args[0], args[1]);
  else if (verbo === 'teto') await teto(args[0]);
  else if (verbo === 'duplicar-anuncio') await duplicarAnuncio(args[0], args[1], args.slice(2).join(' '));
  else {
    console.error(
      [
        'Ler:     listar | criativos | urltags | baixar-criativo <ad_id> <caminho>',
        '         desempenho [dias]  (entrega e funil pelo lado do Meta)',
        'Zelar:   zelar [--aplicar]',
        'Mexer:   pausar <id>... | ativar <id>... | orcamento <adset_id> <reais>',
        '         renomear <id> <nome> | marcar <ad_id>... <url_tags>',
        'Criar:   subir-imagem | subir-video | subir-lote <plano.json>',
        '         subir-pecas <plano.json> <adset_id>  (retoma lote que falhou)',
        '         duplicar-anuncio <ad_id> <adset_id> [nome]',
      ].join('\n'),
    );
    process.exit(1);
  }
} catch (erro) {
  console.error('ERRO:', erro.message);
  process.exit(1);
}
