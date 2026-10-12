import { Router, type Request, type Response } from 'express';
import { asyncHandler } from './../asyncHandler.js';
import { CATALOG } from './../catalog.js';
import { logger } from './../logger.js';
import { createOrder } from './../orders.js';
import { recuperacaoAssinaturaConfere } from './../painel/sessao.js';
import { getOrder, type Order } from './../store/index.js';
import { formatBRL, ipDoCliente } from './../utils.js';
import { auditar } from './../auditoria.js';

/**
 * O link "escolha e pague" — PREÇO CHEIO, sem formulário.
 *
 * Nasceu em 15/08/2026 pelo caso do Ricardo: ele quer pagar a Oração e decidir
 * na hora se leva os bônus, mas já deixou nome, e-mail, telefone e CPF no
 * pedido que expirou. Fazê-lo preencher tudo de novo é atrito; mandá-lo à
 * página de recuperação é dar R$ 27,99 a quem se ofereceu a pagar R$ 47.
 *
 * Então esta página é a irmã da recuperação com uma diferença só: os preços
 * são os do catálogo NORMAL (`main`, `salmos_150`, `vela_7dias`) e o pedido
 * nasce como `offer: 'main'` — no painel ele é venda de funil, não campanha.
 * O resto é igual: link assinado com prazo, cliente vem do pedido de origem
 * (nunca do navegador), valor somado só no servidor.
 *
 * Endereço: /api/escolher/:id/:exp/:sig — a mesma assinatura da recuperação,
 * gerada pelo painel (rota /admin/pedidos/:id/link-escolha).
 */
export const escolherRouter: Router = Router();

const BUMPS = ['salmos_150', 'vela_7dias'] as const;

function escapar(texto: string): string {
  return texto.replace(/[&<>"']/g, (c) => {
    const mapa: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return mapa[c];
  });
}

function primeiroNome(nome: string): string {
  const p = nome.trim().split(/\s+/)[0] ?? '';
  return p ? p.charAt(0).toLocaleUpperCase('pt-BR') + p.slice(1).toLocaleLowerCase('pt-BR') : '';
}

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
  body{margin:0;padding:60px 24px;background:#131313;color:#E8E2D6;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;text-align:center}
  main{max-width:420px;margin:0 auto} h1{font-family:Georgia,serif;font-size:1.5rem;color:#F2CA50;margin:0 0 14px}
  p{color:#BDB5A6;line-height:1.6;margin:0 0 22px}
  a{display:inline-block;background:linear-gradient(135deg,#d4af37,#f2ca50);color:#241a00;text-decoration:none;padding:14px 26px;border-radius:12px;font-weight:700}
</style></head><body><main><h1>${escapar(titulo)}</h1><p>${escapar(texto)}</p><a href="https://rezassagradas.site/">Ir para o site</a></main></body></html>`;
}

function paginaDeEscolha(nome: string, caminhoBase: string): string {
  const principal = CATALOG.main;
  const cartoes = BUMPS.map((id) => {
    const item = CATALOG[id];
    const descricao =
      id === 'salmos_150'
        ? 'Livro digital com os 150 Salmos organizados por aflição: proteção, cura, libertação, prosperidade.'
        : 'Seu nome é consagrado numa vela acesa por 7 dias seguidos. Você recebe a foto da vela com seu nome.';
    return `
      <label class="bump" for="${id}">
        <input type="checkbox" id="${id}" value="${id}" data-preco="${item.priceCents}">
        <span class="marca" aria-hidden="true"></span>
        <span class="conteudo">
          <span class="titulo">${escapar(item.title)}</span>
          <span class="descricao">${escapar(descricao)}</span>
          <span class="preco">+ ${formatBRL(item.priceCents)}</span>
        </span>
      </label>`;
  }).join('');

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Sua Oração | Rezas Sagradas</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;background:#131313;color:#E8E2D6;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;line-height:1.5}
  main{max-width:460px;margin:0 auto;padding:28px 18px 60px}
  .selo{color:#F2CA50;font-size:.78rem;letter-spacing:.14em;text-transform:uppercase;font-weight:700}
  h1{font-family:Georgia,serif;font-size:1.55rem;margin:8px 0 6px;color:#fff}
  .sub{color:#BDB5A6;margin:0 0 20px;font-size:1.02rem}
  .cartao{background:#1c1b1b;border:1px solid #3d3930;border-radius:16px;padding:16px}
  .linha{display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid #2b2925;font-size:1.05rem}
  .linha strong{color:#fff}
  .bump{display:flex;gap:12px;align-items:flex-start;padding:14px 12px;margin-top:10px;border:1.5px solid #3d3930;border-radius:12px;cursor:pointer;background:#232221}
  .bump:has(input:checked){border-color:#F2CA50;background:#2a2716}
  .bump input{position:absolute;opacity:0;width:0;height:0}
  .marca{flex:0 0 22px;height:22px;border:2px solid #7a7367;border-radius:6px;margin-top:2px;position:relative}
  .bump:has(input:checked) .marca{background:#F2CA50;border-color:#F2CA50}
  .bump:has(input:checked) .marca::after{content:'';position:absolute;left:6px;top:2px;width:6px;height:11px;border:solid #241a00;border-width:0 3px 3px 0;transform:rotate(45deg)}
  .conteudo{display:flex;flex-direction:column;gap:2px}
  .titulo{font-weight:700;color:#fff;font-size:1rem}
  .descricao{color:#BDB5A6;font-size:.9rem}
  .preco{color:#F2CA50;font-weight:700;margin-top:4px}
  .total{display:flex;justify-content:space-between;align-items:center;margin-top:16px;padding-top:14px;border-top:1px solid #3d3930;font-size:1.05rem}
  .total b{font-size:1.5rem;color:#F2CA50}
  button{width:100%;margin-top:14px;min-height:58px;border:0;border-radius:999px;background:linear-gradient(135deg,#d4af37,#f2ca50);color:#241a00;font-weight:800;font-size:1rem;letter-spacing:.04em;text-transform:uppercase;cursor:pointer;box-shadow:0 0 0 6px rgba(242,202,80,.15)}
  button:disabled{opacity:.6;cursor:wait}
  .nota{color:#8f887c;font-size:.86rem;text-align:center;margin-top:12px}
  #pix{display:none;margin-top:18px}
  #pix.on{display:block}
  .codigo{background:#0f0f0f;border:1px solid #3d3930;border-radius:12px;padding:12px;font-family:ui-monospace,Menlo,monospace;font-size:.85rem;word-break:break-all;color:#BDB5A6;user-select:all}
  .copiar{background:#278647;color:#fff;box-shadow:none;margin-top:10px}
  .ok{color:#6ee7b7;text-align:center;margin-top:10px;font-weight:700}
  .erro{color:#ffb4a8;background:#3a1510;border:1px solid #7a2e22;border-radius:10px;padding:10px 12px;margin-top:12px;font-size:.95rem}
</style></head><body><main>
  <div class="selo">Sua Oração está separada ✝</div>
  <h1>${escapar(nome)}, escolha como quer receber.</h1>
  <p class="sub">A Oração é sua. Se quiser, leve também os bônus — é só marcar. O PIX sai na hora.</p>

  <div class="cartao">
    <div class="linha"><span>${escapar(principal.title)}</span><strong>${formatBRL(principal.priceCents)}</strong></div>
    ${cartoes}
    <div class="total"><span>Sua contribuição</span><b id="total">${formatBRL(principal.priceCents)}</b></div>
    <button id="gerar" type="button">Gerar meu PIX</button>
    <p class="nota">🔒 Seus dados já estão conosco — nada para preencher.</p>
    <div id="erro" class="erro" hidden></div>
    <div id="pix">
      <p style="margin:0 0 6px;font-weight:700;color:#fff">Pix Copia e Cola — <span id="valorPix"></span></p>
      <div class="codigo" id="codigo"></div>
      <button class="copiar" id="copiar" type="button">Copiar código</button>
      <p class="ok" id="okCopiado" hidden>Copiado! Agora cole no app do seu banco. 🙏</p>
      <p class="nota">Vale por 20 minutos. Assim que o banco confirmar, tudo chega no seu e-mail.</p>
    </div>
  </div>
</main>
<script>
(function(){
  var base=${JSON.stringify(principal.priceCents)};
  var caixas=[].slice.call(document.querySelectorAll('.bump input'));
  var total=document.getElementById('total');
  function brl(c){return (c/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}
  function recalcular(){var t=base;caixas.forEach(function(c){if(c.checked)t+=Number(c.dataset.preco)});total.textContent=brl(t)}
  caixas.forEach(function(c){c.addEventListener('change',recalcular)});
  var botao=document.getElementById('gerar'),erro=document.getElementById('erro'),pix=document.getElementById('pix');
  botao.addEventListener('click',function(){
    botao.disabled=true;botao.textContent='Gerando…';erro.hidden=true;
    var bumps=caixas.filter(function(c){return c.checked}).map(function(c){return c.value});
    fetch(${JSON.stringify(caminhoBase)},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({bumps:bumps})})
      .then(function(r){return r.json()})
      .then(function(j){
        if(!j.success||!j.data||!j.data.pix){throw new Error(j.message||'Não consegui gerar o PIX agora. Tente de novo.')}
        document.getElementById('codigo').textContent=j.data.pix.code;
        document.getElementById('valorPix').textContent=j.data.amountFormatted;
        pix.classList.add('on');botao.style.display='none';
        caixas.forEach(function(c){c.disabled=true});
        pix.scrollIntoView({behavior:'smooth',block:'start'});
      })
      .catch(function(e){erro.textContent=e.message;erro.hidden=false;botao.disabled=false;botao.textContent='Gerar meu PIX'});
  });
  document.getElementById('copiar').addEventListener('click',function(){
    var t=document.getElementById('codigo').textContent;var ok=document.getElementById('okCopiado');
    function pronto(){ok.hidden=false}
    if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(pronto,function(){selecionar()})}else{selecionar()}
    function selecionar(){var f=document.createRange();f.selectNodeContents(document.getElementById('codigo'));var s=window.getSelection();s.removeAllRanges();s.addRange(f);try{document.execCommand('copy');pronto()}catch(e){}}
  });
})();
</script>
</body></html>`;
}

escolherRouter.get(
  '/escolher/:id/:exp/:sig',
  asyncHandler(async (req: Request, res: Response) => {
    const r = await pedidoDoLink(req);
    if (r.erro === 'expirado') {
      res.status(410).type('html').send(paginaDeAviso('Este link venceu', 'Peça um novo pelo WhatsApp — a sua Oração continua separada.'));
      return;
    }
    if (r.erro === 'invalido') {
      res.status(403).type('html').send(paginaDeAviso('Link inválido', 'Não conseguimos reconhecer este endereço.'));
      return;
    }
    if (r.erro === 'ja_pago') {
      res.status(200).type('html').send(paginaDeAviso('Você já tem esta Oração', 'A sua contribuição foi recebida e a Oração foi enviada para o seu e-mail.'));
      return;
    }
    const { id, exp, sig } = req.params;
    void auditar({ papel: 'cliente', ip: ipDoCliente(req), acao: 'escolha.aberta', alvo: r.pedido.id, detalhe: `${r.pedido.customer.name} · ${r.pedido.customer.email ?? ''}`, status: 200 });
    res.status(200).type('html').send(paginaDeEscolha(primeiroNome(r.pedido.customer.name) || 'Você', `/api/escolher/${id}/${exp}/${sig}`));
  }),
);

escolherRouter.post(
  '/escolher/:id/:exp/:sig',
  asyncHandler(async (req: Request, res: Response) => {
    const r = await pedidoDoLink(req);
    if (r.erro) {
      res.status(r.erro === 'ja_pago' ? 409 : 403).json({ success: false, error: r.erro.toUpperCase() });
      return;
    }
    const pedidos = Array.isArray((req.body as { bumps?: unknown })?.bumps)
      ? ((req.body as { bumps: unknown[] }).bumps.filter((b) => typeof b === 'string') as string[])
      : [];
    const bumps = pedidos.filter((b) => (BUMPS as readonly string[]).includes(b));

    // Cliente e origem vêm do pedido de origem, nunca do navegador.
    const { order } = await createOrder({
      offer: 'main',
      bumpIds: bumps,
      customer: r.pedido.customer,
      atribuicao: r.pedido.atribuicao,
      sessionId: r.pedido.trackId ?? undefined,
    });

    logger.info('Link de escolha: cobrança gerada', { origem: r.pedido.id, novo: order.id, bumps: bumps.length, centavos: order.amountCents });
    void auditar({ papel: 'cliente', ip: ipDoCliente(req), acao: 'escolha.pix', alvo: order.id, detalhe: `${r.pedido.customer.name} · ${formatBRL(order.amountCents)}${bumps.length ? ' · ' + bumps.join(', ') : ''}`, status: 201 });

    res.status(201).json({
      success: true,
      data: { id: order.id, amountFormatted: formatBRL(order.amountCents), pix: order.qrCode ? { code: order.qrCode } : null },
    });
  }),
);
