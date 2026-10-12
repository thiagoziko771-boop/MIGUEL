import { Router, type Request, type Response } from 'express';
import geradorDeQr from 'qrcode-generator';
import { asyncHandler } from './../asyncHandler.js';
import { CATALOG, CONTRIBUICOES_EXTRA } from './../catalog.js';
import { logger } from './../logger.js';
import { createOrder } from './../orders.js';
import { recuperacaoAssinaturaConfere } from './../painel/sessao.js';
import { getOrder, saveOrder, type Order } from './../store/index.js';
import { formatBRL } from './../utils.js';

/**
 * A página da campanha de recuperação.
 *
 * Quem gerou PIX e não pagou recebe um e-mail com UM link, assinado e com
 * prazo. O link abre esta página, onde a Oração aparece por R$ 27,99 no lugar
 * de R$ 47,00, com dois adicionais também mais baratos.
 *
 * A COBRANÇA NASCE NO CLIQUE, não no envio do e-mail. Gerar 20 cobranças de
 * uma vez encheria a conta da PixGo de PIX que ninguém vai pagar — exatamente
 * o número que esta campanha existe para reduzir. Além disso, o código nasce
 * novo no momento do interesse, e não vencido três dias depois.
 *
 * O PREÇO NÃO VEM DO NAVEGADOR. A página manda só quais adicionais foram
 * marcados; quem soma é o servidor, a partir do catálogo. Sem isso, bastaria
 * abrir o inspetor do navegador para comprar a Oração por um centavo.
 */
export const recuperacaoRouter = Router();

const BUMPS = ['recup_salmos', 'recup_vela'] as const;

/**
 * Quanto tempo ela tem para concluir, depois de abrir a página.
 *
 * O relógio começa na PRIMEIRA visita e nunca reinicia: `visitadoEm` é gravado
 * uma vez só, no servidor. Fechar a aba, limpar o navegador, abrir no
 * computador do filho — nada disso devolve tempo. Contagem que reinicia a cada
 * visita é a que todo mundo já viu e ninguém acredita mais; esta é real, e por
 * isso o preço realmente acaba quando ela zera.
 */
const MINUTOS_PARA_CONCLUIR = 15;

/** Instante em que a oferta desta pessoa termina, ou null se ela ainda não abriu. */
function prazoDe(pedido: Order): number | null {
  const visita = pedido.campanha?.visitadoEm;
  if (!visita) return null;
  const inicio = Date.parse(visita);
  return Number.isFinite(inicio) ? inicio + MINUTOS_PARA_CONCLUIR * 60_000 : null;
}

/**
 * O QR Code do PIX, desenhado aqui mesmo e embutido na página.
 *
 * Esta página é HTML puro servido pelo backend — não tem bundle, não pode
 * carregar biblioteca de fora (e não deve: script de terceiro na tela do
 * pagamento é risco que não se corre). A mesma `qrcode-generator` que o funil
 * usa no navegador roda igual no servidor, e a imagem sai como data URL dentro
 * do próprio HTML: nada a baixar, funciona com conexão ruim.
 *
 * Falhar aqui NÃO pode custar a página: sem QR, o copia e cola continua ali, e é
 * ele que fecha a venda para quem paga no mesmo celular — a maioria deste
 * público. Por isso o erro é engolido e devolve null.
 */
function qrEmDataUrl(codigo: string): string | null {
  try {
    // typeNumber 0 escolhe a versão pelo tamanho do conteúdo; 'M' é a correção
    // de erro padrão do BR Code.
    const qr = geradorDeQr(0, 'M');
    qr.addData(codigo);
    qr.make();
    // 6 px por módulo e margem de 2: no celular sai com uns 200 px de lado, que
    // é o tamanho em que outro aparelho lê sem esforço.
    return qr.createDataURL(6, 2);
  } catch {
    return null;
  }
}

function primeiroNome(completo: string): string {
  const primeiro = (completo ?? '').trim().split(/\s+/)[0] ?? '';
  if (!primeiro) return '';
  return primeiro.charAt(0).toUpperCase() + primeiro.slice(1).toLowerCase();
}

function escapar(texto: string): string {
  return texto.replace(/[&<>"']/g, (c) => {
    const mapa: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return mapa[c];
  });
}

/**
 * Confere o link e devolve o pedido de origem.
 *
 * O pedido precisa existir e NÃO estar pago: quem já comprou não pode cair numa
 * página que oferece de novo o que ela tem — parece cobrança em duplicidade e
 * vira pedido de estorno.
 */
type Recusa = 'expirado' | 'invalido' | 'ja_pago';
type ResultadoDoLink = { erro: Recusa; pedido?: undefined } | { erro?: undefined; pedido: Order };

async function pedidoDoLink(req: Request): Promise<ResultadoDoLink> {
  const { id, exp, sig } = req.params;
  const expiraEm = Number.parseInt(exp, 10);

  if (!Number.isFinite(expiraEm) || expiraEm <= Date.now()) return { erro: 'expirado' };
  if (!recuperacaoAssinaturaConfere(id, expiraEm, sig)) return { erro: 'invalido' };

  const pedido = await getOrder(id);
  if (!pedido) return { erro: 'invalido' };
  if (pedido.status === 'completed') return { erro: 'ja_pago' };

  return { pedido };
}

function paginaDeAviso(titulo: string, texto: string): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${escapar(titulo)} | Rezas Sagradas</title>
<style>
  body{margin:0;padding:60px 24px;background:#131313;color:#E8E2D6;
       font-family:system-ui,-apple-system,'Segoe UI',sans-serif;text-align:center}
  main{max-width:420px;margin:0 auto}
  h1{font-family:Georgia,serif;font-size:1.5rem;color:#F2CA50;margin:0 0 14px}
  p{color:#BDB5A6;line-height:1.6;margin:0 0 22px}
  a{display:inline-block;background:linear-gradient(135deg,#d4af37,#f2ca50);color:#241a00;
    text-decoration:none;padding:14px 26px;border-radius:12px;font-weight:700}
</style></head><body><main>
<h1>${escapar(titulo)}</h1><p>${escapar(texto)}</p>
<a href="https://rezassagradas.site/">Ir para o site</a>
</main></body></html>`;
}

/**
 * Uma tela só: o código, o botão que copia, e o que fazer em seguida.
 *
 * Nada mais entra aqui. Quem abriu está com o aplicativo do banco na outra mão
 * e vinte minutos no relógio; qualquer coisa a mais na tela é uma chance de ela
 * se distrair antes de colar.
 */
function paginaDoCodigo(
  nome: string,
  codigo: string,
  valor: string,
  expiraEmMs: number | null,
  caminhoBase: string,
  qrDataUrl: string | null,
): string {
  /*
   * A contagem é o tempo REAL da cobrança na PixGo.
   *
   * Não é urgência inventada: passado esse instante o código morre no banco, a
   * pessoa tenta pagar e o aplicativo recusa. Mostrar o relógio é o oposto de
   * pressionar — é avisar antes que ela descubra sozinha, no pior momento.
   */
  const restam = expiraEmMs === null ? null : Math.max(0, Math.floor((expiraEmMs - Date.now()) / 1000));
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Seu código PIX | Rezas Sagradas</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;padding:28px 20px 60px;background:#131313;color:#E8E2D6;
       font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;line-height:1.6}
  main{max-width:460px;margin:0 auto}
  .marca{text-align:center;font-size:.7rem;letter-spacing:.22em;text-transform:uppercase;
         color:rgba(242,202,80,.6);margin:0 0 22px}
  h1{font-family:Georgia,serif;font-size:1.4rem;color:#fff;margin:0 0 6px;text-align:center}
  .valor{text-align:center;font-family:Georgia,serif;font-size:2.4rem;color:#F2CA50;margin:0 0 4px}
  .sub{text-align:center;color:#8A8375;font-size:.85rem;margin:0 0 24px}
  .codigo{background:#0E0D09;border:1px solid #3A3529;border-radius:12px;padding:16px;
          font-family:'Courier New',monospace;font-size:.72rem;word-break:break-all;
          color:#E8E2D6;user-select:all;-webkit-user-select:all;line-height:1.6;margin:0 0 14px}
  /* 58px e largura cheia: é o alvo de toque, e a mão pode não ser firme. */
  button{width:100%;min-height:58px;border:0;border-radius:14px;cursor:pointer;
         background:linear-gradient(135deg,#d4af37,#f2ca50);color:#241a00;
         font-size:1.05rem;font-weight:700;letter-spacing:.02em;transition:background .2s}
  button.pronto{background:#1F7A45;color:#fff}
  ol{margin:0;padding-left:0;list-style:none;counter-reset:passo}
  ol li{counter-increment:passo;display:flex;gap:12px;align-items:flex-start;
        background:#1C1A14;border:1px solid #3A3529;border-radius:12px;padding:14px 16px;margin:0 0 10px}
  ol li::before{content:counter(passo);flex:0 0 26px;width:26px;height:26px;line-height:26px;
        border-radius:50%;background:#F2CA50;color:#241a00;font-weight:700;font-size:.85rem;text-align:center}
  ol li span{color:#BDB5A6;font-size:.93rem;line-height:1.5}
  ol li strong{color:#fff}
  .aviso{margin:22px 0 0;padding:14px 16px;background:#1C1A14;border-left:3px solid #F2CA50;
         border-radius:0 8px 8px 0;color:#BDB5A6;font-size:.88rem}
  /* O relógio: vermelho o tempo todo, porque aqui ele conta a morte do código. */
  .conta{background:#7A1F1F;border-radius:12px;padding:14px 16px;text-align:center;margin:0 0 20px}
  .conta .rotulo{font-size:.78rem;letter-spacing:.06em;color:#F5C6C6;text-transform:uppercase}
  .conta .tempo{font-family:'Courier New',monospace;font-size:2.6rem;font-weight:700;
                color:#fff;line-height:1.1;letter-spacing:.04em}
  .conta.pouco{animation:bater 1s ease-in-out infinite}
  .conta.morto{background:#2A2620}
  .conta.morto .tempo{font-size:1.1rem;font-family:inherit}
  @keyframes bater{0%,100%{transform:scale(1)}50%{transform:scale(1.03)}}
  @media (prefers-reduced-motion: reduce){.conta.pouco{animation:none}}
  .empurra{margin:0 0 18px;font-size:1rem;line-height:1.6;color:#E8E2D6;text-align:center}
  .empurra strong{color:#F2CA50}
  /*
   * O QR fica DEPOIS do copia e cola, e isso não é detalhe de gosto: quem chega
   * por WhatsApp está no celular e paga no MESMO aparelho, onde o QR é inútil
   * (não dá para apontar a câmera para a própria tela). Ele serve a quem abriu
   * no computador ou vai pagar pelo aparelho de outra pessoa.
   *
   * Fundo branco literal, e não a cor do tema: o desenho é preto sobre
   * transparente e, sobre o fundo escuro desta página, nenhum leitor de banco
   * acha os módulos.
   */
  .qr{margin:22px 0 0;text-align:center}
  .qr img{width:200px;height:200px;background:#fff;padding:10px;border-radius:12px;display:inline-block}
  .qr p{margin:10px 0 0;color:#8A8375;font-size:.85rem;line-height:1.5}
  .qr strong{color:#BDB5A6}
  /*
   * A semente: os botões de somar à contribuição, logo abaixo do botão de
   * copiar — posição decidida pelo dono em 17/08/2026. Fica no caminho do olho
   * de quem acabou de copiar o código, que é o instante em que a pessoa ainda
   * está decidindo o quanto vai dar.
   */
  .semear{margin:22px 0 0;padding:18px 16px;background:#1C1A14;border:1px solid #3A3529;border-radius:14px}
  .semear h2{font-family:Georgia,serif;font-size:1.05rem;color:#F2CA50;margin:0 0 8px;text-align:center}
  .semear p{margin:0 0 14px;color:#BDB5A6;font-size:.9rem;text-align:center;line-height:1.55}
  .valores{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
  /* Alvo de toque de 54px: a mão desta pessoa pode não ser firme. */
  .valores button{min-height:54px;font-size:1rem;background:#0E0D09;color:#E8E2D6;
                  border:2px solid #3A3529;border-radius:12px;font-weight:700}
  .valores button.ativo{background:#F2CA50;color:#241a00;border-color:#F2CA50}
  .valores button:disabled{opacity:.55}
  .semear .recibo{margin:12px 0 0;font-size:.88rem;color:#7FCF9F;text-align:center;min-height:1.2em}
</style></head><body><main>
  <p class="marca">Rezas Sagradas</p>
  <h1>${escapar(nome)}, falta só colar no seu banco</h1>
  <p class="valor">${valor}</p>
  <p class="sub">PIX &middot; sua Oração é liberada na hora</p>

  ${
    restam === null
      ? ''
      : `<div class="conta" id="conta">
    <div class="rotulo">Este código expira em</div>
    <div class="tempo" id="tempo">--:--</div>
  </div>`
  }

  <p class="empurra" id="empurra">
    Você já fez a parte difícil. <strong>Falta um toque.</strong>
  </p>

  <div class="codigo" id="codigo">${escapar(codigo)}</div>
  <button id="copiar" type="button">COPIAR O CÓDIGO</button>

  <div class="semear">
    <h2>Quer semear um pouco mais?</h2>
    <p>
      Quem contribui de coração colhe em abundância. A sua Oração é a mesma —
      o que cresce é a semente que vai junto com ela, e as bênçãos que Miguel
      derrama sobre a sua casa.
    </p>
    <div class="valores">
      ${CONTRIBUICOES_EXTRA.map((id) => {
        const item = CATALOG[id];
        return `<button type="button" data-semente="${escapar(id)}">+${escapar(formatBRL(item.priceCents))}</button>`;
      }).join('')}
    </div>
    <p class="recibo" id="recibo"></p>
  </div>

  ${
    qrDataUrl === null
      ? ''
      : `<div class="qr">
    <img id="qrimg" src="${qrDataUrl}" alt="QR Code do PIX de ${escapar(valor)}" width="200" height="200">
    <p>Está no computador ou quer pagar por outro aparelho? <strong>Aponte a câmera do app do banco</strong> para este QR Code.</p>
  </div>`
  }

  <p class="sub" style="margin:16px 0 12px;text-align:left;font-size:.72rem;letter-spacing:.14em;text-transform:uppercase;color:#8A8375">
    Como fazer a sua contribuição, em 3 passos
  </p>
  <ol>
    <li><span>Toque no botão dourado acima. O código é copiado sozinho — você não precisa selecionar nada.</span></li>
    <li><span>Abra o aplicativo do <strong>seu banco</strong> e procure a área de <strong>PIX</strong>. Em quase todos ela fica na tela inicial.</span></li>
    <li><span>Escolha <strong>PIX Copia e Cola</strong>, toque e segure no campo para <strong>colar</strong>, confira o valor e confirme.</span></li>
  </ol>

  <div class="aviso">
    Assim que a sua contribuição chegar, a sua Oração vai para o seu e-mail.
    Você não precisa fazer mais nada — nem avisar, nem mandar comprovante.
  </div>
</main>
<script>
(function(){
  /*
   * O relógio da cobrança.
   *
   * O tempo vem do servidor, do expiresAt que a PixGo devolveu — é o instante
   * real em que o código morre. Zerado, a tela não finge que ainda dá: diz que
   * venceu e manda pedir outro, porque insistir num código morto termina com a
   * pessoa achando que a loja é quebrada.
   */
  var restam = ${restam === null ? 'null' : restam};
  if (restam !== null) {
    var conta = document.getElementById('conta');
    var tempo = document.getElementById('tempo');
    var pintar = function () {
      if (restam <= 0) {
        /*
         * Venceu: em vez de mandar a pessoa refazer o pedido, troca o botão
         * por "quero um código novo". A PixGo só dá 20 minutos e ignora
         * qualquer prazo maior, então esse retorno é o que separa a venda
         * perdida da venda adiada.
         */
        conta.classList.remove('pouco');
        conta.classList.add('morto');
        tempo.textContent = 'Este código expirou';
        var b = document.getElementById('copiar');
        b.textContent = 'QUERO UM CÓDIGO NOVO';
        b.dataset.acao = 'renovar';
        var e = document.getElementById('empurra');
        if (e) e.innerHTML = 'Sem problema. <strong>Gere outro agora</strong> — leva um segundo e os seus dados já estão aqui.';
        return true;
      }
      var m = Math.floor(restam / 60), s = restam % 60;
      tempo.textContent = (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
      if (restam <= 300) conta.classList.add('pouco');
      return false;
    };
    if (!pintar()) {
      var relogio = setInterval(function () {
        restam -= 1;
        if (pintar()) clearInterval(relogio);
      }, 1000);
    }
  }

  var botao = document.getElementById('copiar');
  var campo = document.getElementById('codigo');

  /*
   * Somar à contribuição.
   *
   * Cada escolha pede ao SERVIDOR uma cobrança nova com o valor somado — o
   * navegador manda o ID do acréscimo e recebe de volta o código e o valor já
   * calculados. Nenhum número daqui entra na conta.
   *
   * Tocar de novo no mesmo valor desfaz e volta ao valor original: quem se
   * arrepende precisa de saída, e sem ela a única forma de voltar atrás seria
   * fechar a página — que é a saída que não volta.
   *
   * Alternar entre valores cria uma cobrança por valor distinto. Não vira
   * enxurrada: o servidor reaproveita a cobrança pendente idêntica dentro da
   * janela de reuso, então voltar a um valor já escolhido devolve o MESMO
   * código, e não um novo.
   */
  var sementeEscolhida = null;
  var recibo = document.getElementById('recibo');
  var valorNaTela = document.querySelector('.valor');
  var sementes = document.querySelectorAll('[data-semente]');

  function travarSementes(travado) {
    for (var i = 0; i < sementes.length; i++) sementes[i].disabled = travado;
  }

  for (var i = 0; i < sementes.length; i++) {
    (function (alvo) {
      alvo.addEventListener('click', function () {
        var id = alvo.dataset.semente;
        var tirando = sementeEscolhida === id;
        var anterior = sementeEscolhida;

        travarSementes(true);
        recibo.textContent = tirando ? 'Voltando ao valor original...' : 'Preparando o seu código...';

        fetch('${caminhoBase}/renovar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contribuicao: tirando ? null : id })
        })
          .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
          .then(function (res) {
            var d = res.j && res.j.data;
            var novo = d && d.pix && d.pix.code;
            if (!res.ok || !novo) throw new Error((res.j && res.j.message) || 'Não conseguimos gerar agora.');

            campo.textContent = novo;
            if (valorNaTela && d.amountFormatted) valorNaTela.textContent = d.amountFormatted;
            // O QR acompanha o código novo, ou some: imagem do valor antigo ao
            // lado de um código novo faria a pessoa pagar a quantia errada.
            var imgQr = document.getElementById('qrimg');
            if (imgQr) {
              if (d.pix && d.pix.qr) {
                imgQr.src = d.pix.qr;
                imgQr.alt = 'QR Code do PIX de ' + (d.amountFormatted || '');
                imgQr.style.display = '';
              } else {
                imgQr.style.display = 'none';
              }
            }

            for (var k = 0; k < sementes.length; k++) sementes[k].classList.remove('ativo');
            sementeEscolhida = tirando ? null : id;
            if (!tirando) alvo.classList.add('ativo');

            recibo.textContent = tirando
              ? 'Tudo bem. Voltamos ao valor da sua Oração.'
              : 'Que Deus te retribua. Toque de novo no valor para tirar.';

            /*
             * O código é OUTRO: o botão volta a "copiar" e o relógio recomeça.
             * Sem isto, a pessoa copiaria o código velho achando que estava
             * pagando o novo valor — e pagaria o valor antigo, ou nada.
             */
            botao.dataset.acao = '';
            botao.disabled = false;
            botao.classList.remove('pronto');
            botao.textContent = 'COPIAR O CÓDIGO';
            var contaNova = document.getElementById('conta');
            if (contaNova) {
              contaNova.classList.remove('morto');
              contaNova.classList.remove('pouco');
              document.getElementById('tempo').textContent = '20:00';
            }
            if (typeof restam !== 'undefined' && restam !== null) {
              restam = 20 * 60;
              if (typeof relogio !== 'undefined') clearInterval(relogio);
              relogio = setInterval(function () { restam -= 1; if (pintar()) clearInterval(relogio); }, 1000);
            }
            var empurraNovo = document.getElementById('empurra');
            if (empurraNovo) empurraNovo.innerHTML = 'Código pronto. <strong>Falta um toque.</strong>';
          })
          .catch(function (erro) {
            sementeEscolhida = anterior;
            recibo.textContent = erro.message + ' Tente de novo em instantes.';
          })
          .then(function () { travarSementes(false); });
      });
    })(sementes[i]);
  }

  botao.addEventListener('click', function(){
    // Depois do vencimento o mesmo botão muda de função: pede código novo.
    if (botao.dataset.acao === 'renovar') {
      botao.disabled = true;
      botao.textContent = 'Gerando o seu código...';
      fetch('${caminhoBase}/renovar', { method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}' })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) {
          var novo = res.j && res.j.data && res.j.data.pix && res.j.data.pix.code;
          if (!res.ok || !novo) throw new Error((res.j && res.j.message) || 'Não conseguimos gerar agora.');
          campo.textContent = novo;
          botao.dataset.acao = '';
          botao.disabled = false;
          botao.textContent = 'COPIAR O CÓDIGO';
          var conta2 = document.getElementById('conta');
          if (conta2) {
            conta2.classList.remove('morto');
            document.getElementById('tempo').textContent = '20:00';
          }
          // Reinicia o relógio com os 20 minutos da cobrança nova.
          restam = 20 * 60;
          setInterval(function () { restam -= 1; pintar(); }, 1000);
          var e2 = document.getElementById('empurra');
          if (e2) e2.innerHTML = 'Código novo pronto. <strong>Falta um toque.</strong>';
        })
        .catch(function (erro) {
          botao.disabled = false;
          botao.textContent = 'QUERO UM CÓDIGO NOVO';
          var e3 = document.getElementById('empurra');
          if (e3) e3.textContent = erro.message + ' Responda o e-mail que a gente resolve.';
        });
      return;
    }

    var texto = campo.textContent || '';
    function pronto(){
      botao.textContent = 'CÓDIGO COPIADO ✓';
      botao.classList.add('pronto');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(texto).then(pronto, selecionar);
    } else {
      selecionar();
    }
    // Navegador antigo sem clipboard: seleciona tudo para o "copiar" do
    // próprio aparelho pegar o código inteiro num toque.
    function selecionar(){
      var faixa = document.createRange();
      faixa.selectNodeContents(campo);
      var s = window.getSelection();
      s.removeAllRanges();
      s.addRange(faixa);
      try { document.execCommand('copy'); pronto(); }
      catch (e) { botao.textContent = 'CÓDIGO SELECIONADO — TOQUE EM COPIAR'; }
    }
  });
})();
</script>
</body></html>`;
}

function paginaDaOferta(nome: string, caminhoBase: string, restamMs: number): string {
  const principal = CATALOG.recup_main;
  const de = CATALOG.main.priceCents;

  const cartoesDeBump = BUMPS.map((id) => {
    const item = CATALOG[id];
    const cheio = id === 'recup_salmos' ? CATALOG.salmos_150.priceCents : CATALOG.vela_7dias.priceCents;
    const descricao =
      id === 'recup_salmos'
        ? 'Os 150 Salmos organizados por aflição: proteção, cura, libertação, prosperidade. Você abre na página certa no dia em que precisar.'
        : 'Seu nome é consagrado numa vela acesa por 7 dias seguidos. Você recebe a foto da vela com seu nome escrito.';
    return `
      <label class="bump" for="${id}">
        <input type="checkbox" id="${id}" value="${id}">
        <span class="marca" aria-hidden="true"></span>
        <span class="conteudo">
          <span class="titulo">${escapar(item.title)}</span>
          <span class="descricao">${escapar(descricao)}</span>
          <span class="valores">
            <s>${formatBRL(cheio)}</s>
            <strong>+ ${formatBRL(item.priceCents)}</strong>
          </span>
        </span>
      </label>`;
  }).join('');

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Sua Oração está reservada | Rezas Sagradas</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;padding:0;background:#131313;color:#E8E2D6;
       font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;line-height:1.6}
  main{max-width:520px;margin:0 auto;padding:0 0 60px}
  /*
   * O relógio fica grudado no topo enquanto ela rola.
   * Se saísse da tela junto com a capa, a urgência sumiria justamente na hora
   * em que ela está lendo os adicionais e decidindo.
   */
  .relogio{position:sticky;top:0;z-index:10;background:#7A1F1F;color:#fff;
           text-align:center;padding:11px 16px;font-size:.9rem;letter-spacing:.02em}
  .relogio strong{font-family:'Courier New',monospace;font-size:1.35rem;font-weight:700;
                  letter-spacing:.06em;margin-left:8px;vertical-align:middle}
  .relogio.pouco{background:#9B1C1C;animation:pulsar 1.1s ease-in-out infinite}
  /* Zerado: sai o vermelho de alarme, entra o dourado de acolhimento. */
  .relogio.acolhe{background:#1C1A14;color:#F2CA50;border-bottom:1px solid #3A3529}
  .relogio.acolhe strong{color:#fff;font-family:Georgia,serif;font-size:1rem;letter-spacing:0;margin-left:0}
  @keyframes pulsar{0%,100%{opacity:1}50%{opacity:.72}}
  @media (prefers-reduced-motion: reduce){.relogio.pouco{animation:none}}
  .capa{position:relative}
  .capa img{width:100%;display:block}
  .capa::after{content:'';position:absolute;inset:0;
               background:linear-gradient(to top,#131313 0%,rgba(19,19,19,.2) 60%,transparent 100%)}
  .corpo{padding:0 22px;margin-top:-40px;position:relative;z-index:1}
  h1{font-family:Georgia,'Times New Roman',serif;font-size:1.75rem;line-height:1.3;
     color:#fff;margin:0 0 14px}
  .intro{color:#BDB5A6;margin:0 0 24px}
  /* O preço em bloco escuro: é o que a pessoa veio conferir. */
  .preco{background:#1C1A14;border:1px solid #3A3529;border-radius:16px;padding:22px;text-align:center;margin:0 0 24px}
  .preco .etiqueta{font-size:.7rem;letter-spacing:.18em;text-transform:uppercase;color:#F2CA50;font-weight:700}
  .preco s{display:block;color:#8A8375;font-size:.95rem;margin:8px 0 2px}
  .preco .valor{font-family:Georgia,serif;font-size:2.9rem;color:#F2CA50;line-height:1}
  h2{font-size:.72rem;letter-spacing:.16em;text-transform:uppercase;color:#8A8375;
     margin:26px 0 12px;font-weight:700}
  /* Os adicionais. Caixa inteira clicável: dedo grande, tela pequena. */
  .bump{display:flex;gap:12px;align-items:flex-start;background:#1C1A14;border:1px solid #3A3529;
        border-radius:14px;padding:16px;margin:0 0 12px;cursor:pointer;transition:border-color .15s}
  .bump:has(input:checked){border-color:#F2CA50;background:#221F16}
  .bump input{position:absolute;opacity:0;width:0;height:0}
  .marca{flex:0 0 24px;width:24px;height:24px;border:2px solid #55503F;border-radius:7px;margin-top:2px;
         position:relative;transition:all .15s}
  .bump:has(input:checked) .marca{background:#F2CA50;border-color:#F2CA50}
  .bump:has(input:checked) .marca::after{content:'';position:absolute;left:7px;top:2px;width:6px;height:12px;
         border:solid #241a00;border-width:0 3px 3px 0;transform:rotate(45deg)}
  .conteudo{display:block}
  .titulo{display:block;font-weight:600;color:#fff;font-size:.98rem;margin-bottom:4px}
  .descricao{display:block;color:#8A8375;font-size:.86rem;line-height:1.5;margin-bottom:8px}
  .valores s{color:#6B6557;font-size:.85rem;margin-right:8px}
  .valores strong{color:#F2CA50;font-size:.98rem}
  .total{display:flex;justify-content:space-between;align-items:baseline;
         padding:18px 4px;border-top:1px solid #3A3529;margin:20px 0 0}
  .total span{color:#BDB5A6}
  .total strong{font-family:Georgia,serif;font-size:2rem;color:#F2CA50}
  /* 58px: alvo de toque confortável para mão de 60 anos. */
  button{width:100%;min-height:58px;border:0;border-radius:14px;cursor:pointer;margin-top:8px;
         background:linear-gradient(135deg,#d4af37,#f2ca50);color:#241a00;
         font-size:1.05rem;font-weight:700;letter-spacing:.02em}
  button:disabled{opacity:.6;cursor:wait}
  .selo{text-align:center;color:#6B6557;font-size:.8rem;margin:14px 0 0}
  #pagamento{margin-top:26px}
  .instrucao{color:#BDB5A6;font-size:.95rem;margin:0 0 12px}
  .codigo{background:#0E0D09;border:1px solid #3A3529;border-radius:12px;padding:16px;
          font-family:'Courier New',monospace;font-size:.72rem;word-break:break-all;
          color:#E8E2D6;user-select:all;line-height:1.6}
  .secundario{background:transparent;border:1px solid #4A4437;color:#E8E2D6;font-size:.92rem;min-height:48px}
  .aviso{color:#8A8375;font-size:.86rem;margin:16px 0 0}
  .erro{color:#F0A0A0;font-size:.9rem;margin:14px 0 0}
</style></head><body><main>
  <div class="relogio" id="relogio">Sua oferta termina em <strong id="tempo">--:--</strong></div>
  <div class="capa"><img src="/images/arcanjo-email.jpg" alt="São Miguel Arcanjo"></div>

  <div class="corpo">
    <h1>${escapar(nome)}, sua Oração continua reservada.</h1>
    <p class="intro">
      Você chegou até o fim e alguma coisa a fez parar. Miguel não foi embora —
      ele esperou. Hoje ela sai por um valor que não está em nenhum outro lugar.
    </p>

    <div class="preco">
      <p class="etiqueta" style="margin:0">Somente para você</p>
      <s>de ${formatBRL(de)}</s>
      <div class="valor">${formatBRL(principal.priceCents)}</div>
      <p style="margin:8px 0 0;color:#BDB5A6;font-size:.88rem">à vista, no PIX &middot; acesso imediato</p>
    </div>

    <!--
      O BOTÃO PRINCIPAL VEM ANTES DOS ADICIONAIS.

      Estava só embaixo, depois dos dois cartões de bump, a 1173 px do topo —
      uma tela e meia de rolagem num celular de 844 px. Quem decidia comprar ao
      ver o preço encontrava duas ofertas novas no caminho e não achava o botão.
      Uma cliente voltou SEIS VEZES a esta página sem gerar o código; de dez que
      clicavam no e-mail, uma pedia o PIX.

      Os adicionais continuam existindo e continuam vendendo — mas depois da
      decisão principal, nunca à frente dela. Quem quiser levar mais rola e
      escolhe; quem só quer a Oração já pode contribuir.
    -->
    <button id="gerarTopo" type="button">QUERO A MINHA ORAÇÃO POR ${formatBRL(principal.priceCents)}</button>
    <p class="selo">Contribuição pelo PIX &middot; sua Oração é liberada na hora</p>

    <h2>Leve junto, também com desconto</h2>
    ${cartoesDeBump}

    <div class="total">
      <span>Total</span>
      <strong id="total">${formatBRL(principal.priceCents)}</strong>
    </div>

    <button id="gerar" type="button">GERAR MEU PIX</button>
    <p class="selo">Contribuição pelo PIX &middot; sua Oração é liberada na hora</p>

    <div id="pagamento" hidden>
      <p class="instrucao">Copie o código e cole no seu banco, em <strong>PIX Copia e Cola</strong>:</p>
      <div class="codigo" id="codigo"></div>
      <button id="copiar" type="button" class="secundario">Copiar código</button>
      <p class="aviso">Assim que a sua contribuição chegar, a sua Oração vai para o seu e-mail. Pode fechar esta página.</p>
    </div>
    <p class="erro" id="erro" hidden></p>
  </div>
</main>
<script>
(function(){
  /*
   * O relógio.
   *
   * O tempo restante vem do SERVIDOR, calculado a partir da primeira visita
   * dela. O navegador só desenha a contagem — não decide nada. Assim, mexer no
   * relógio do aparelho, recarregar a página ou abrir em outro celular não
   * devolve um segundo, e o preço acaba de verdade quando chega a zero.
   */
  var restam = ${Math.max(0, Math.floor(restamMs / 1000))};
  var relogio = document.getElementById('relogio');
  var tempo = document.getElementById('tempo');

  function desenhar(){
    if (restam <= 0) {
      /*
       * Zerou: a urgência sai e entra o acolhimento. O botão continua
       * funcionando — quem voltou para pagar não pode ouvir "não".
       */
      relogio.innerHTML = 'O tempo passou, mas <strong>Miguel ainda espera por você</strong>';
      relogio.classList.remove('pouco');
      relogio.classList.add('acolhe');
      return true;
    }
    var m = Math.floor(restam / 60);
    var s = restam % 60;
    tempo.textContent = (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
    // Últimos três minutos: o aviso muda de tom e pulsa.
    if (restam <= 180) relogio.classList.add('pouco');
    return false;
  }

  if (!desenhar()) {
    var conta = setInterval(function(){
      restam -= 1;
      if (desenhar()) clearInterval(conta);
    }, 1000);
  }

  var PRINCIPAL = ${principal.priceCents};
  var PRECOS = ${JSON.stringify(Object.fromEntries(BUMPS.map((id) => [id, CATALOG[id].priceCents])))};
  var caixas = Array.prototype.slice.call(document.querySelectorAll('.bump input'));
  var total = document.getElementById('total');
  var gerar = document.getElementById('gerar');
  var pagamento = document.getElementById('pagamento');
  var campo = document.getElementById('codigo');
  var copiar = document.getElementById('copiar');
  var erro = document.getElementById('erro');

  function brl(centavos){
    return 'R$ ' + (centavos/100).toFixed(2).replace('.', ',');
  }
  function marcados(){
    return caixas.filter(function(c){ return c.checked; }).map(function(c){ return c.value; });
  }
  function recalcular(){
    var soma = PRINCIPAL;
    marcados().forEach(function(id){ soma += PRECOS[id] || 0; });
    total.textContent = brl(soma);
  }
  caixas.forEach(function(c){ c.addEventListener('change', recalcular); });

  /*
   * OS DOIS BOTÕES FAZEM A MESMA COISA — o de cima e o de baixo.
   *
   * O de cima existe para quem já decidiu ao ver o preço e não deveria ter que
   * rolar por duas ofertas adicionais para poder contribuir. Ele leva junto o
   * que estiver marcado nos adicionais (normalmente nada, porque vem antes
   * deles), então quem usa o de cima leva só a Oração — que é exatamente o que
   * essa pessoa quis.
   */
  var gerarTopo = document.getElementById('gerarTopo');
  var botoes = [gerar, gerarTopo].filter(Boolean);

  function pedirOCodigo(clicado){
    botoes.forEach(function(b){ b.disabled = true; });
    clicado.textContent = 'Gerando o seu PIX...';
    erro.hidden = true;

    fetch('${caminhoBase}/cobranca', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ bumps: marcados() })
    })
    .then(function(r){ return r.json().then(function(j){ return {ok:r.ok, j:j}; }); })
    .then(function(res){
      var codigo = res.j && res.j.data && res.j.data.pix && res.j.data.pix.code;
      if (!res.ok || !codigo) throw new Error((res.j && res.j.message) || 'Não conseguimos gerar o PIX agora.');
      campo.textContent = codigo;
      pagamento.hidden = false;
      botoes.forEach(function(b){ b.hidden = true; });
      caixas.forEach(function(c){ c.disabled = true; });
      // O código aparece onde o olho já está: quem clicou no botão de cima
      // ficaria olhando para um lugar vazio se a resposta nascesse embaixo.
      pagamento.scrollIntoView({ behavior: 'smooth', block: 'center' });
    })
    .catch(function(e){
      erro.textContent = e.message + ' Tente de novo, ou responda o e-mail que a gente resolve.';
      erro.hidden = false;
      botoes.forEach(function(b){ b.disabled = false; });
      gerar.textContent = 'GERAR MEU PIX';
      if (gerarTopo) gerarTopo.textContent = 'QUERO A MINHA ORAÇÃO POR ' + brl(PRINCIPAL);
    });
  }

  botoes.forEach(function(b){
    b.addEventListener('click', function(){ pedirOCodigo(b); });
  });

  copiar.addEventListener('click', function(){
    var texto = campo.textContent || '';
    function avisar(){ copiar.textContent = 'Código copiado!'; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(texto).then(avisar, avisar);
    } else {
      var faixa = document.createRange();
      faixa.selectNodeContents(campo);
      var s = window.getSelection();
      s.removeAllRanges();
      s.addRange(faixa);
      avisar();
    }
  });
})();
</script>
</body></html>`;
}

/**
 * A página que mostra o código PIX com um botão de copiar que funciona.
 *
 * Existe porque e-mail não executa JavaScript — nenhum cliente permite, por
 * segurança. Um "botão de copiar" dentro do e-mail seria um retângulo bonito
 * que não faz nada quando a pessoa toca, e falhar em silêncio no momento do
 * pagamento é pior do que não oferecer o botão.
 *
 * Aqui o botão é de verdade. E o desvio pela página paga por si: no celular,
 * tocar um botão é mais fácil do que segurar o dedo em cima de um bloco de
 * texto de 200 caracteres até a seleção pegar o pedaço certo — e este público
 * tem 50 anos ou mais.
 *
 * A mesma assinatura do link da campanha, com o mesmo prazo. O código não é
 * segredo (quem paga precisa dele), mas nome e valor são, e não podem ficar
 * atrás de um endereço adivinhável.
 */
/**
 * Gera uma cobrança NOVA a partir de um pedido cujo código venceu.
 *
 * A PixGo dá 20 minutos e ignora qualquer prazo que a gente peça — testei os
 * seis nomes de campo que a API poderia aceitar, e todos voltam com os mesmos
 * 20 minutos. Ou seja: quem gera o PIX às 22h e vai dormir perde a cobrança,
 * e hoje precisa refazer o pedido inteiro do zero para tentar de novo.
 *
 * É onde morre a maior parte do dinheiro desta operação: de 46 PIX gerados em
 * 30 dias, 37 nunca foram pagos. Nem todos são desistência — parte é código
 * que venceu antes de a pessoa abrir o aplicativo do banco.
 *
 * Aqui ela toca um botão e recebe outro código, com os mesmos dados e o mesmo
 * valor do pedido original. Sem digitar nome, e-mail ou CPF de novo.
 */
recuperacaoRouter.post(
  '/codigo/:id/:exp/:sig/renovar',
  asyncHandler(async (req: Request, res: Response) => {
    const resultado = await pedidoDoLink(req);
    if (resultado.erro) {
      res.status(resultado.erro === 'ja_pago' ? 409 : 403).json({
        success: false,
        error: resultado.erro.toUpperCase(),
        message: resultado.erro === 'ja_pago' ? 'Este pedido já foi pago.' : 'Link inválido ou vencido.',
      });
      return;
    }

    const antigo = resultado.pedido;

    /*
     * O acréscimo voluntário escolhido nesta página.
     *
     * Chega como ID (`semente_25`), nunca como valor: quem sabe quanto cada um
     * custa é o catálogo, e é isso que impede o valor a pagar de virar campo
     * editável no navegador. ID desconhecido é recusado em resolveOffer.
     *
     * O acréscimo SOMA ao pedido — nunca substitui. O valor original continua
     * inteiro embaixo, porque ninguém pode acabar pagando menos do que pediu por
     * ter tocado num botão que dizia "somar".
     */
    const contribuicaoBruta = (req.body ?? {}) as Record<string, unknown>;
    const contribuicaoId = typeof contribuicaoBruta.contribuicao === 'string' && contribuicaoBruta.contribuicao.trim() !== ''
      ? contribuicaoBruta.contribuicao.trim()
      : null;

    /*
     * A cobrança nova repete o pedido antigo item por item — mesma oferta,
     * mesmos adicionais, mesmo valor. O preço continua saindo do catálogo do
     * servidor: nada do que o navegador manda entra nessa conta.
     */
    const bumps = antigo.itemIds.filter((id) => CATALOG[id]?.kind === 'bump');
    const { order } = await createOrder({
      offer: antigo.offer,
      bumpIds: bumps,
      contribuicaoId,
      customer: antigo.customer,
      atribuicao: antigo.atribuicao,
    });

    logger.info('Código PIX renovado', {
      antigo: antigo.id,
      novo: order.id,
      centavos: order.amountCents,
      contribuicao: contribuicaoId ?? 'nenhuma',
    });

    res.status(201).json({
      success: true,
      data: {
        id: order.id,
        amountFormatted: formatBRL(order.amountCents),
        // O QR desenhado do código NOVO: sem ele a página trocaria o texto do
        // código e deixaria na tela a imagem do valor antigo — o pior dos dois
        // mundos, porque quem lê pelo QR pagaria outra quantia.
        pix: order.qrCode ? { code: order.qrCode, qr: qrEmDataUrl(order.qrCode) } : null,
        expiresAt: order.expiresAt,
      },
    });
  }),
);

recuperacaoRouter.get(
  '/codigo/:id/:exp/:sig',
  asyncHandler(async (req: Request, res: Response) => {
    const resultado = await pedidoDoLink(req);

    if (resultado.erro === 'expirado') {
      res.status(410).type('html').send(paginaDeAviso('Este endereço venceu', 'Peça um código novo pelo site.'));
      return;
    }
    if (resultado.erro === 'invalido') {
      res.status(403).type('html').send(paginaDeAviso('Link inválido', 'Não conseguimos reconhecer este endereço.'));
      return;
    }
    if (resultado.erro === 'ja_pago') {
      res
        .status(200)
        .type('html')
        .send(paginaDeAviso('Recebemos a sua contribuição', 'Que Miguel te cubra. A sua Oração já foi enviada para o seu e-mail.'));
      return;
    }

    const pedido = resultado.pedido;
    if (!pedido.qrCode) {
      res
        .status(410)
        .type('html')
        .send(paginaDeAviso('Este código venceu', 'A cobrança expirou. Faça um novo pedido no site.'));
      return;
    }

    /*
     * O clique do lembrete, no mesmo lugar onde mora o clique da campanha.
     *
     * Este é o sinal mais forte que o lembrete produz: abrir o e-mail pode ser
     * curiosidade, mas voltar para a página que só serve para copiar o código
     * de pagamento é intenção. Sem registrar aqui, o painel mostraria "abriu" e
     * nada mais para quem estava com o banco na mão — e o lembrete pareceria
     * menos eficaz do que é.
     *
     * Falha em gravar não impede a página de abrir: quem veio pagar, paga.
     */
    try {
      pedido.campanha = {
        // Espalha primeiro: campos que este ponto não conhece (linkGeradoEm,
        // por exemplo) sobrevivem à visita em vez de serem descartados.
        ...pedido.campanha,
        enviadoEm: pedido.campanha?.enviadoEm ?? null,
        visitadoEm: pedido.campanha?.visitadoEm ?? new Date().toISOString(),
        cliques: (pedido.campanha?.cliques ?? 0) + 1,
        cobrancaEm: pedido.campanha?.cobrancaEm ?? null,
        pedidoGerado: pedido.campanha?.pedidoGerado ?? null,
      };
      await saveOrder(pedido);
    } catch {
      /* medir é acessório; pagar não é */
    }

    const expira = pedido.expiresAt ? Date.parse(pedido.expiresAt) : NaN;
    const { id, exp, sig } = req.params;
    res
      .type('html')
      .send(
        paginaDoCodigo(
          primeiroNome(pedido.customer.name) || 'Você',
          pedido.qrCode,
          formatBRL(pedido.amountCents),
          Number.isFinite(expira) ? expira : null,
          `/api/codigo/${id}/${exp}/${sig}`,
          qrEmDataUrl(pedido.qrCode),
        ),
      );
  }),
);

recuperacaoRouter.get(
  '/recuperar/:id/:exp/:sig',
  asyncHandler(async (req: Request, res: Response) => {
    const resultado = await pedidoDoLink(req);

    if (resultado.erro === 'expirado') {
      res
        .status(410)
        .type('html')
        .send(paginaDeAviso('Este convite venceu', 'O prazo desta oferta terminou. A Oração continua disponível no site pelo valor normal.'));
      return;
    }
    if (resultado.erro === 'invalido') {
      res.status(403).type('html').send(paginaDeAviso('Link inválido', 'Não conseguimos reconhecer este endereço.'));
      return;
    }
    if (resultado.erro === 'ja_pago') {
      res
        .status(200)
        .type('html')
        .send(paginaDeAviso('Você já tem esta Oração', 'A sua contribuição foi recebida e a Oração foi enviada para o seu e-mail.'));
      return;
    }

    /*
     * O clique, registrado antes de responder.
     *
     * `visitadoEm` guarda o PRIMEIRO acesso e nunca é sobrescrito: o que
     * interessa medir é quanto tempo o e-mail levou para funcionar, e o último
     * acesso apagaria isso. O contador cresce sempre — quem volta três vezes
     * está decidindo, e isso é sinal diferente de quem abriu e sumiu.
     */
    const pedido = resultado.pedido;

    /*
     * O relógio zerado NÃO fecha a porta.
     *
     * Decisão do dono, e ela tem razão de negócio: recusar dinheiro de quem
     * voltou para pagar é o único erro que não tem conserto. Quando o tempo
     * acaba, a página troca a urgência por acolhimento — "Miguel ainda espera
     * por você" — e a oferta continua de pé.
     *
     * O que NÃO se faz é reiniciar a contagem a cada visita: quem abrisse duas
     * vezes veria o mesmo 15:00 e entenderia na hora que o relógio é enfeite.
     * Aqui ele conta de verdade, a partir da primeira visita, e simplesmente
     * chega a zero — a pessoa vê que o tempo passou e que mesmo assim pode.
     */
    pedido.campanha = {
      ...pedido.campanha,
      enviadoEm: pedido.campanha?.enviadoEm ?? null,
      visitadoEm: pedido.campanha?.visitadoEm ?? new Date().toISOString(),
      cliques: (pedido.campanha?.cliques ?? 0) + 1,
      cobrancaEm: pedido.campanha?.cobrancaEm ?? null,
      pedidoGerado: pedido.campanha?.pedidoGerado ?? null,
    };
    await saveOrder(pedido);

    const restam = (prazoDe(pedido) ?? Date.now()) - Date.now();
    const { id, exp, sig } = req.params;
    res
      .type('html')
      .send(paginaDaOferta(primeiroNome(pedido.customer.name) || 'Você', `/api/recuperar/${id}/${exp}/${sig}`, restam));
  }),
);

recuperacaoRouter.post(
  '/recuperar/:id/:exp/:sig/cobranca',
  asyncHandler(async (req: Request, res: Response) => {
    const resultado = await pedidoDoLink(req);
    if (resultado.erro) {
      res.status(resultado.erro === 'ja_pago' ? 409 : 403).json({
        success: false,
        error: resultado.erro.toUpperCase(),
        message:
          resultado.erro === 'expirado'
            ? 'O prazo desta oferta terminou.'
            : resultado.erro === 'ja_pago'
              ? 'Este pedido já foi pago.'
              : 'Link inválido.',
      });
      return;
    }

    /*
     * A cobrança continua nascendo depois do prazo, de propósito.
     *
     * O relógio serve para apressar quem está em dúvida, não para punir quem
     * demorou. Recusar aqui seria devolver "não" a uma pessoa que voltou com o
     * banco aberto — o único erro desta página que custa dinheiro de verdade.
     *
     * O que protege o preço não é o relógio: é o link. Ele é assinado, tem
     * prazo próprio de 48 horas e não existe caminho no site que chegue a
     * R$ 27,99. Fora dali, ninguém compra por este valor.
     */

    // Só os adicionais desta campanha entram. Qualquer outro ID é ignorado em
    // silêncio: o valor é somado pelo servidor, então mandar lixo não muda preço.
    const pedidos = Array.isArray((req.body as { bumps?: unknown })?.bumps)
      ? ((req.body as { bumps: unknown[] }).bumps.filter((b) => typeof b === 'string') as string[])
      : [];
    const bumps = pedidos.filter((b) => (BUMPS as readonly string[]).includes(b));

    /*
     * O cliente vem do pedido antigo, nunca do navegador: é a mesma pessoa que
     * recebeu o e-mail, e o link já provou isso pela assinatura. Aceitar dados
     * novos aqui deixaria qualquer um comprar no preço de campanha usando o
     * link de outra pessoa.
     */
    const { order } = await createOrder({
      offer: 'recuperacao',
      bumpIds: bumps,
      customer: resultado.pedido.customer,
      atribuicao: resultado.pedido.atribuicao,
    });

    // O terceiro degrau do funil: ela pediu o PIX. Se parar aqui sem pagar, o
    // problema é preço ou meio de pagamento — não é o e-mail nem a página.
    const origem = resultado.pedido;
    origem.campanha = {
      ...origem.campanha,
      enviadoEm: origem.campanha?.enviadoEm ?? null,
      visitadoEm: origem.campanha?.visitadoEm ?? null,
      cliques: origem.campanha?.cliques ?? 0,
      cobrancaEm: origem.campanha?.cobrancaEm ?? new Date().toISOString(),
      pedidoGerado: order.id,
    };
    await saveOrder(origem);

    logger.info('Recuperação: cobrança gerada', {
      origem: origem.id,
      novo: order.id,
      bumps: bumps.length,
      centavos: order.amountCents,
    });

    res.status(201).json({
      success: true,
      data: {
        id: order.id,
        amountFormatted: formatBRL(order.amountCents),
        pix: order.qrCode ? { code: order.qrCode } : null,
      },
    });
  }),
);
