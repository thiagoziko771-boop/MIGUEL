import React, { useCallback, useEffect, useState } from 'react';
import * as m from 'motion/react-m';
import { AlertCircle, ArrowRight, Barcode, Check, CheckCircle2, ExternalLink, Heart, Lock, MessageCircle, QrCode, ShieldCheck, Sparkles } from 'lucide-react';
import { BarraDoCheckout } from './BarraDoCheckout';
import { Button } from './Button';
import { BoletoPanel, ID_DA_AREA_DO_BOLETO } from './BoletoPanel';
import { ConviteDeRetomada, ID_DO_CONVITE_DE_RETOMADA } from './ConviteDeRetomada';
import { ID_DA_AREA_DE_PAGAMENTO, PixPanel } from './PixPanel';
import { UPSELL_DATA, DOWNSELL_DATA } from '../data/funnelData';
import { api, ApiError, type AccessBundle, type MetodoPagamento, type OfferId, type Order } from '../lib/api';
import { lerCadastroRapido } from '../lib/cadastroRapido';
import { emailPlausivel, sugestaoDeEmail } from '../lib/emailPlausivel';
import { getAttribution, getSessionId } from '../lib/attribution';
import { gravarPedidoGuardado, lerPedidoGuardado } from '../lib/pedidoGuardado';
import { rastrear } from '../lib/rastreio';
import { formatBRL, isValidCPF, maskCPF, maskPhone, onlyDigits } from '../lib/format';
import { useOrderStatus } from '../hooks/useOrderStatus';

interface OrderBump {
  id: string;
  title: string;
  subtitle: string;
  price: number;
  priceFormatted: string;
  tag: string;
  icon: string;
}

/**
 * Espelho de exibição do catálogo do servidor (server/catalog.ts), que é a
 * fonte da verdade dos preços: o total cobrado é sempre recalculado lá.
 */
const ORDER_BUMPS: OrderBump[] = [
  {
    id: 'salmos_150',
    title: 'Guia Sagrado dos 150 Salmos de Proteção & Libertação',
    subtitle: 'Livro digital com as rezas e versículos mais poderosos da Bíblia para afastar todo mal e abrir caminhos.',
    price: 27,
    priceFormatted: 'R$ 27,00',
    tag: 'MAIS POPULAR',
    icon: '📖',
  },
  {
    id: 'vela_7dias',
    title: 'Consagração do Seu Nome na Vela Sagrada de 7 Dias',
    subtitle: 'Acenderemos uma vela no altar em intenção ao seu nome e da sua família durante 7 dias seguidos.',
    price: 14.9,
    priceFormatted: 'R$ 14,90',
    tag: 'RECOMENDADO',
    icon: '🕯️',
  },
];

/**
 * `boleto` é irmão de `pix`: o mesmo momento do funil, com o painel trocado.
 *
 * Os passos do upsell e do downsell continuam só com PIX, e isso é regra de
 * negócio, não esquecimento — eles só aparecem depois do pagamento confirmado,
 * dentro da mesma visita, e um boleto que compensa três dias depois não pertence
 * a esse momento. O servidor recusa boleto nessas ofertas (server/orders.ts).
 */
/**
 * Os acréscimos voluntários, espelho de exibição do catálogo do servidor
 * (server/catalog.ts, CONTRIBUICOES_EXTRA), que é quem soma o total.
 *
 * Nasceu de um pedido de comprador em 17/08/2026: ele quis contribuir acima do
 * valor do pedido e disse que a tela deveria oferecer isso. Valores fixos, e não
 * campo aberto, para o navegador continuar mandando só um ID.
 */
const CONTRIBUICOES: { id: string; valor: number; rotulo: string }[] = [
  { id: 'semente_10', valor: 10, rotulo: '+R$ 10' },
  { id: 'semente_25', valor: 25, rotulo: '+R$ 25' },
  { id: 'semente_50', valor: 50, rotulo: '+R$ 50' },
];


type CheckoutStep = 'form' | 'pix' | 'boleto' | 'whatsapp' | 'upsell' | 'upsell_pix' | 'downsell' | 'downsell_pix' | 'completed';

/**
 * Aparência dos campos do formulário, num lugar só.
 *
 * O `text-base` (17px na nossa escala, ver src/index.css) não é escolha
 * estética: abaixo de 16px o Safari do iPhone dá zoom sozinho quando o campo
 * recebe foco, e a tela inteira salta de lugar. Isso acontece no formulário de
 * pagamento, com o cliente já decidido a comprar — o pior momento possível para
 * a página parecer quebrada. Se um dia a escala encolher, este campo precisa
 * continuar em 16px ou mais.
 */
const CLASSE_CAMPO =
  'w-full px-3.5 py-3 rounded-xl border border-borda bg-sutil text-base text-texto ' +
  'placeholder-suave/60 focus:outline-none focus:border-ouro focus:bg-superficie transition-all';

/*
 * A memória do pedido em aberto mora em src/lib/pedidoGuardado.ts: o App e a
 * tela da oferta também a consultam, para devolver quem voltou direto ao
 * pagamento em vez da primeira pergunta do quiz.
 */
const readStoredOrder = lerPedidoGuardado;
const writeStoredOrder = gravarPedidoGuardado;

interface InlineCheckoutProps {
  basePrice?: number;
  onPaymentSuccess?: () => void;
}

/*
 * Preço do produto principal, só para exibição — o total cobrado sai de
 * server/catalog.ts. Fica aqui, junto do espelho dos bumps acima, para existir
 * num lugar só no frontend: já esteve fixo também na chamada em OfferScreen e
 * as duas cópias saíram de sincronia numa troca de preço, fazendo a tela
 * mostrar R$ 47,00 enquanto o servidor cobrava R$ 27,00.
 */
const PRECO_BASE = 47.0;

export const InlineCheckout: React.FC<InlineCheckoutProps> = ({ basePrice = PRECO_BASE, onPaymentSuccess }) => {
  // Quem passou pelo fluxo curto (anúncio do dinheiro) já escreveu o nome na
  // tela de merecimento — digitá-lo de novo no celular seria cobrar duas
  // vezes o mesmo dado no caminho do dinheiro.
  const [fullName, setFullName] = useState(() => lerCadastroRapido()?.nome ?? '');
  // E-mail e WhatsApp também vêm do pedido de oração, quando existirem — a
  // pessoa já digitou os dois uma vez nesta visita.
  const [email, setEmail] = useState(() => lerCadastroRapido()?.email ?? '');
  const [phone, setPhone] = useState(() => {
    const salvo = lerCadastroRapido()?.telefone ?? '';
    return salvo ? maskPhone(salvo) : '';
  });
  const [cpf, setCpf] = useState('');

  const [selectedBumps, setSelectedBumps] = useState<string[]>(['salmos_150']);

  /**
   * O acréscimo voluntário escolhido, ou null.
   *
   * Começa VAZIO de propósito: os order bumps acima vêm pré-marcados porque são
   * produtos com entrega, e a pessoa pode desmarcar; já uma contribuição extra
   * pré-marcada seria dinheiro somado à conta sem ela ter pedido — que é o tipo
   * de surpresa que vira estorno, e com razão.
   */
  const [contribuicaoExtra, setContribuicaoExtra] = useState<string | null>(null);

  /*
   * PIX é o padrão, e continua sendo o caminho recomendado na tela: é o único
   * que libera o acesso na hora, e este funil vive de decisão tomada agora.
   */
  const [metodo, setMetodo] = useState<MetodoPagamento>('pix');

  /**
   * O boleto só aparece se o servidor disser que existe emissão configurada.
   *
   * Enquanto a resposta não chega, a opção fica escondida — e não visível-e-
   * desabilitada. Um botão que aparece e depois some é ruim; um botão que
   * aparece, a pessoa escolhe e leva erro é pior.
   */
  const [boletoDisponivel, setBoletoDisponivel] = useState(false);

  /**
   * O boleto abre uma CONVERSA em vez de emitir um documento.
   *
   * É o estado enquanto não existe provedor de emissão (17/08/2026): a opção
   * continua na tela, porque quem não quer PIX precisa de um caminho, mas o que
   * ela faz é chamar o dono no WhatsApp — que combina o pagamento à mão, como já
   * faz com quem some no meio do checkout. Sem número configurado no servidor,
   * nada disso aparece.
   */
  const [boletoPeloWhatsapp, setBoletoPeloWhatsapp] = useState(false);
  const [whatsappDoSuporte, setWhatsappDoSuporte] = useState('');
  /** A conversa já montada, guardada para o caso de o navegador ter bloqueado a aba. */
  const [linkDaConversa, setLinkDaConversa] = useState('');

  const [step, setStep] = useState<CheckoutStep>('form');
  const [mainOrder, setMainOrder] = useState<Order | null>(null);
  const [addonOrder, setAddonOrder] = useState<Order | null>(null);
  const [access, setAccess] = useState<AccessBundle | null>(null);

  const [isProcessing, setIsProcessing] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isRestoring, setIsRestoring] = useState(() => readStoredOrder() !== null);

  /**
   * Esta pessoa VOLTOU para um pedido que já existia, em vez de acabar de criá-lo.
   *
   * É a única diferença que separa "gerei o PIX agora" de "abandonei e voltei",
   * e é ela que decide se a mensagem de recuperação aparece. Sem essa distinção,
   * quem apertou o botão de comprar há três segundos leria "percebemos que você
   * não concluiu" — o que soa como sistema que não está acompanhando.
   */
  const [retomouPedido, setRetomouPedido] = useState(false);

  const mainStatus = useOrderStatus(mainOrder, step === 'pix' || step === 'boleto');
  const addonStatus = useOrderStatus(addonOrder, step === 'upsell_pix' || step === 'downsell_pix');

  const totalValue =
    basePrice +
    selectedBumps.reduce((sum, id) => sum + (ORDER_BUMPS.find((b) => b.id === id)?.price ?? 0), 0) +
    (CONTRIBUICOES.find((c) => c.id === contribuicaoExtra)?.valor ?? 0);

  /** Há uma segunda forma de pagar para oferecer — emissão de boleto ou conversa. */
  const temEscolhaDePagamento = boletoDisponivel || boletoPeloWhatsapp;
  /** Este pedido vai virar conversa em vez de cobrança. */
  const vaiPeloWhatsapp = metodo === 'boleto' && boletoPeloWhatsapp;

  const scrollToCheckout = useCallback(() => {
    document.getElementById('offer-details-section')?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  /**
   * Assim que o PIX existe, a tela vai até ele.
   *
   * Sem isto, quem apertava "QUERO MINHA ORAÇÃO" continuava olhando para o
   * formulário: o QR Code e o botão de copiar nasciam abaixo da dobra, e a
   * pessoa precisava adivinhar que devia rolar. Este público compra pelo
   * celular, onde o formulário sozinho já ocupa mais de uma tela — o resultado
   * era ficar parado esperando algo acontecer depois de ter pagado a atenção
   * toda para apertar o botão.
   *
   * O atraso curto existe porque o painel ainda está sendo montado quando o
   * passo muda; rolar antes disso mira uma âncora que não existe. E quem pediu
   * menos animação no sistema recebe o salto direto, sem deslize.
   */
  const rolarAte = useCallback((id: string) => {
    const semAnimacao = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    document.getElementById(id)?.scrollIntoView({
      behavior: semAnimacao ? 'auto' : 'smooth',
      block: 'start',
    });
  }, []);

  const rolarAtePagamento = useCallback(
    () => rolarAte(step === 'boleto' ? ID_DA_AREA_DO_BOLETO : ID_DA_AREA_DE_PAGAMENTO),
    [rolarAte, step],
  );

  useEffect(() => {
    if (step !== 'pix' && step !== 'boleto' && step !== 'upsell_pix' && step !== 'downsell_pix') return;

    /*
     * Dois destinos, conforme como a pessoa chegou aqui.
     *
     * Quem acabou de gerar o PIX vai direto ao QR Code — é o que ela pediu ao
     * apertar o botão. Quem VOLTOU vai para a mensagem de recuperação, que fica
     * logo acima: essa pessoa reabriu a página no topo da VSL e teria de rolar
     * o vídeo, a oferta e o formulário inteiros para reencontrar o próprio
     * pagamento. Levá-la ao QR também não serve — ela pularia a única mensagem
     * escrita para recebê-la de volta. Da mensagem ao QR é um toque.
     */
    const areaDoPagamento = step === 'boleto' ? ID_DA_AREA_DO_BOLETO : ID_DA_AREA_DE_PAGAMENTO;
    const destino = retomouPedido ? ID_DO_CONVITE_DE_RETOMADA : areaDoPagamento;

    /*
     * Três tentativas, e não uma.
     *
     * Acima do checkout está a VSL, e o player só reserva a altura dele quando
     * carrega. Rolando uma vez só, a página acertava o alvo e em seguida o
     * vídeo aparecia, empurrava tudo para baixo e o destino terminava a meia
     * tela de distância — perto o bastante para o teste antigo não notar e
     * longe o bastante para a pessoa não ver a mensagem.
     *
     * O laço para assim que o alvo está no lugar, então no caso comum a segunda
     * e a terceira passadas nem acontecem. E ele não insiste depois de 1,2 s:
     * a partir daí a rolagem provavelmente é da pessoa, e disputar o controle
     * da tela com quem está lendo é pior do que errar o enquadramento.
     */
    const conferir = () => {
      const alvo = document.getElementById(destino);
      if (!alvo) return;
      const topo = alvo.getBoundingClientRect().top;
      if (topo >= -4 && topo <= 96) return;
      rolarAte(destino);
    };

    const relogios = [150, 600, 1200].map((atraso) => window.setTimeout(conferir, atraso));

    /*
     * E MAIS UMA PASSADA QUANDO AS FONTES CHEGAM.
     *
     * As fontes do site passaram a ser baixadas sem bloquear a primeira pintura
     * (ver o <head> em index.html) — o que faz a página aparecer muito antes num
     * 4G, e é o certo. O preço é que o texto reflui quando elas chegam: tudo
     * cresce alguns pixels de uma vez, e o alvo desce junto.
     *
     * Sem esta passada, a rolagem acertava e o conteúdo escapava logo depois:
     * medido em 17/08/2026, a área de pagamento terminava a 1101px da tela em
     * vez dos 80px de sempre. `document.fonts.ready` avisa exatamente quando o
     * reflow terminou, então esta é a única correção que não é chute de tempo.
     *
     * `cancelado` evita rolar a tela de alguém que já saiu deste passo — as
     * fontes podem chegar depois de a pessoa ter navegado.
     */
    let cancelado = false;
    const fontes = (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts;
    if (fontes?.ready) {
      void fontes.ready.then(() => {
        if (!cancelado) conferir();
      });
    }

    return () => {
      cancelado = true;
      relogios.forEach((relogio) => window.clearTimeout(relogio));
    };
  }, [step, retomouPedido, rolarAte]);

  /**
   * Volta da tela do PIX para o formulário.
   *
   * O pedido anterior NÃO é cancelado, e isso é deliberado: o código já pode
   * ter sido copiado e estar aberto no app do banco. Cancelar aqui faria o
   * pagamento de quem já tinha decidido pagar cair no vazio — o pior desfecho
   * possível nesta tela.
   *
   * Não há risco de cobrar duas vezes no caso comum: se a pessoa voltar e
   * confirmar o mesmo pedido, o servidor devolve a MESMA cobrança (a janela de
   * reaproveitamento em server/orders.ts). Só nasce um PIX novo quando ela de
   * fato muda o que está levando — e aí o valor é outro mesmo.
   *
   * Nome e e-mail voltam preenchidos a partir do pedido, para quem recarregou a
   * página não ter de digitar tudo de novo. O CPF não volta: o servidor só
   * devolve ele mascarado, e é assim que tem de ser.
   */
  const editarPedido = useCallback(() => {
    const pedido = mainStatus.order ?? mainOrder;
    if (pedido) {
      setFullName((atual) => atual || pedido.customer.name);
      setEmail((atual) => atual || pedido.customer.email);
    }
    writeStoredOrder(null);
    setMainOrder(null);
    // O pedido retomado deixou de existir: o PIX que vier depois é novo, e
    // "percebemos que você não concluiu" não vale para quem acabou de recomeçar.
    setRetomouPedido(false);
    /*
     * Volta para o PIX ao reabrir o formulário.
     *
     * Na tela do boleto esta é a porta rotulada "quero mudar meu pedido ou
     * pagar com PIX" — deixar o boleto marcado ali entregaria o contrário do
     * que o botão promete. E quem só queria corrigir um dado reescolhe o boleto
     * com um toque, que é o custo menor dos dois.
     */
    setMetodo('pix');
    setStep('form');
    scrollToCheckout();
  }, [mainStatus.order, mainOrder, scrollToCheckout]);

  /*
   * Quais formas de pagamento existem hoje. Falhando, fica só o PIX: o funil
   * inteiro funcionava assim até 17/08/2026, então o pior caso desta chamada é
   * o comportamento antigo — e nunca um checkout sem forma de pagar.
   */
  useEffect(() => {
    let ativo = true;
    api
      .opcoesDePagamento()
      .then((opcoes) => {
        if (!ativo) return;
        setBoletoDisponivel(opcoes.boleto.disponivel);
        setBoletoPeloWhatsapp(opcoes.boleto.peloWhatsapp);
        setWhatsappDoSuporte(opcoes.whatsapp);
      })
      .catch(() => {
        if (!ativo) return;
        setBoletoDisponivel(false);
        setBoletoPeloWhatsapp(false);
      });
    return () => {
      ativo = false;
    };
  }, []);

  // Retoma o pedido de quem voltou do app do banco (ou recarregou a página).
  useEffect(() => {
    const stored = readStoredOrder();
    if (!stored) return;

    let active = true;
    api
      .getOrder(stored.id)
      .then((order) => {
        if (!active) return;
        if (order.status === 'completed') {
          setMainOrder(order);
          setStep(stored.finished ? 'completed' : 'upsell');
          return;
        }
        if (order.status === 'pending') {
          setMainOrder(order);
          setRetomouPedido(true);
          // Volta para o painel do método que ela escolheu: quem emitiu boleto e
          // reabriu a página precisa reencontrar a linha digitável, não um QR.
          setMetodo(order.metodo);
          setStep(order.metodo === 'boleto' ? 'boleto' : 'pix');
          return;
        }
        // Expirado, cancelado ou estornado: o cliente recomeça do formulário.
        writeStoredOrder(null);
      })
      .catch(() => {
        // Pedido inexistente no servidor: descartamos a referência local.
        writeStoredOrder(null);
      })
      .finally(() => {
        if (active) setIsRestoring(false);
      });

    return () => {
      active = false;
    };
  }, []);

  // O avanço para o upsell só acontece quando o servidor confirma o pagamento.
  const mainPaid = mainStatus.order?.status === 'completed';
  useEffect(() => {
    if ((step !== 'pix' && step !== 'boleto') || !mainPaid) return;
    setMainOrder(mainStatus.order);
    setStep('upsell');
    scrollToCheckout();
    onPaymentSuccess?.();
  }, [step, mainPaid, mainStatus.order, scrollToCheckout, onPaymentSuccess]);

  const addonPaid = addonStatus.order?.status === 'completed';
  useEffect(() => {
    if ((step !== 'upsell_pix' && step !== 'downsell_pix') || !addonPaid) return;
    if (mainOrder) writeStoredOrder({ id: mainOrder.id, finished: true });
    setStep('completed');
  }, [step, addonPaid, mainOrder]);

  // Depois de tudo concluído, buscamos o que foi efetivamente liberado.
  const mainOrderId = mainOrder?.id;
  useEffect(() => {
    if (step !== 'completed' || !mainOrderId) return;
    let active = true;
    api
      .getAccess(mainOrderId)
      .then((bundle) => {
        if (active) setAccess(bundle);
      })
      .catch(() => {
        if (active) setAccess(null);
      });
    return () => {
      active = false;
    };
  }, [step, mainOrderId]);

  const toggleBump = (bumpId: string) => {
    setSelectedBumps((current) => (current.includes(bumpId) ? current.filter((id) => id !== bumpId) : [...current, bumpId]));
  };

  const handleSubmitPayment = async (event: React.FormEvent) => {
    event.preventDefault();

    /*
     * Fecha o teclado do celular ANTES de qualquer coisa.
     *
     * Tocar no botão de comprar não tira o foco do campo (no iOS o teclado
     * fica aberto), e é com o teclado aberto que a rolagem automática até o
     * PIX rodava: metade da tela ocupada, o navegador reajustando o layout
     * enquanto o teclado recolhe, e o enquadramento final caía onde desse.
     * Com o foco solto aqui, o teclado já recolheu por completo durante a
     * chamada que gera a cobrança (~1 s), e a rolagem mede a tela inteira.
     */
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();

    setFormError(null);

    if (!fullName.trim() || !email.trim()) {
      setFormError('Preencha seu nome e e-mail para receber o acesso à Oração Sagrada.');
      return;
    }
    /*
     * O e-mail é o ÚNICO canal de entrega — telefone é opcional. Deixar passar
     * um endereço quebrado é vender sem ter como entregar: aconteceu duas
     * vezes em dois dias (`gmail.comn1`, `gmail.com989888` — o dedo escorrega
     * depois do domínio, no celular), e as duas compradoras ficaram
     * inalcançáveis. A sugestão entra na própria mensagem quando dá para
     * adivinhar a intenção.
     */
    if (!emailPlausivel(email)) {
      const sugestao = sugestaoDeEmail(email);
      setFormError(
        sugestao
          ? `Confira o e-mail: parece ter sobrado algo depois do fim. Você quis dizer ${sugestao}? É nele que chega a sua Oração.`
          : 'Confira o e-mail digitado — parece incompleto ou com caracteres a mais. É nele que chega a sua Oração.',
      );
      return;
    }
    /*
     * O CPF é exigido nos DOIS caminhos, e no do boleto ele é ainda mais
     * necessário: quem vai emitir o documento à mão precisa do CPF do pagador,
     * porque boleto sem CPF não existe. Mandar a pessoa para o WhatsApp sem esse
     * dado só adia a pergunta — e cada ida e volta ali perde gente.
     */
    if (!isValidCPF(cpf)) {
      setFormError(
        metodo === 'boleto'
          ? 'Informe um CPF válido. Ele é obrigatório para emitir o boleto no seu nome.'
          : 'Informe um CPF válido. Ele é exigido pelo banco e só esse CPF poderá pagar o PIX.',
      );
      return;
    }

    const contato = { nome: fullName.trim(), email: email.trim(), telefone: onlyDigits(phone) };

    /*
     * O caminho da conversa: nenhuma cobrança é criada.
     *
     * A janela abre AQUI, ainda dentro do clique, e antes de qualquer espera —
     * navegador só permite abrir aba nova durante o gesto do usuário, e abrir
     * depois de um `await` cai no bloqueador de pop-up. Se mesmo assim for
     * bloqueada, a tela seguinte traz o botão para abrir à mão.
     */
    if (vaiPeloWhatsapp) {
      /*
       * A mensagem carrega os DADOS DO PAGADOR, e não só o pedido.
       *
       * Do outro lado tem uma pessoa que vai emitir o boleto à mão, no painel do
       * banco: ela precisa de nome completo, CPF, e-mail e valor. Sem isso, a
       * conversa começa com quatro perguntas — e cada pergunta é uma chance de a
       * pessoa não responder e a venda morrer ali. Assim, quem atende só
       * confirma e emite.
       *
       * O CPF vai formatado porque é assim que ele é digitado no sistema do
       * banco, e conferir 11 dígitos corridos numa tela de celular é onde nasce
       * o erro de digitação que emite boleto no nome errado.
       */
      const itens = ['Oração Sagrada do Arcanjo Miguel', ...selectedBumps.map((id) => ORDER_BUMPS.find((b) => b.id === id)?.title ?? id)];
      const extra = CONTRIBUICOES.find((c) => c.id === contribuicaoExtra);
      /*
       * "CONTRIBUIR", e nunca "pagar" — a mesma regra que vale no resto do
       * funil e nas mensagens do painel (ver server/routes/admin.ts). Quem entra
       * aqui não está comprando um arquivo, está retribuindo; falar em pagamento
       * transforma um gesto de fé em conta a vencer, e conta atrasada dá
       * vergonha — a pessoa não responde, some.
       */
      const texto =
        'Olá! Quero contribuir pelo boleto.\n\n' +
        'Meus dados para gerar o boleto:\n' +
        `Nome: ${fullName.trim()}\n` +
        `CPF: ${maskCPF(cpf)}\n` +
        `E-mail: ${email.trim()}\n` +
        (phone.trim() ? `WhatsApp: ${maskPhone(phone)}\n` : '') +
        '\n' +
        `Pedido: ${itens.join(' + ')}\n` +
        (extra ? `Contribuição a mais: ${formatBRL(extra.valor)}\n` : '') +
        `Minha contribuição: ${formatBRL(totalValue)}`;
      const conversa = `https://wa.me/${whatsappDoSuporte}?text=${encodeURIComponent(texto)}`;
      window.open(conversa, '_blank', 'noopener');

      /*
       * O Lead sai igual ao do caminho do PIX: é o único momento em que temos
       * e-mail e telefone de alguém que ainda não comprou, e é o que faz esta
       * pessoa aparecer no painel do dono em vez de virar uma conversa sem dono.
       */
      rastrear('Lead', { step: 13, contato, contentIds: ['main', ...selectedBumps] });

      /*
       * O PEDIDO DE BOLETO FICA REGISTRADO, mesmo que a conversa nunca aconteça.
       *
       * Daqui a pessoa sai do site para o WhatsApp, e o WhatsApp abre com o
       * texto pronto mas NÃO envia sozinho: se ela não tocar em enviar do outro
       * lado, some sem deixar rastro nenhum — e o dono nunca fica sabendo que
       * houve alguém ali querendo pagar de outro jeito.
       *
       * Este evento é a única prova de que o pedido existiu. É ele que põe essa
       * pessoa no painel, com nome, contato e valor, para ser chamada de volta.
       */
      rastrear('PedidoDeBoleto', {
        step: 13,
        contato,
        contentIds: ['main', ...selectedBumps, ...(contribuicaoExtra ? [contribuicaoExtra] : [])],
      });

      /*
       * E o pedido vira uma LINHA na aba Boletos, com o que falta ao evento
       * acima: CPF e valor.
       *
       * O evento serve à contagem; esta chamada serve ao trabalho. Quem vai
       * emitir o boleto à mão precisa do CPF do pagador e do valor exato, e
       * precisa poder marcar depois se foi gerado e se compensou — inclusive
       * quando a conversa nunca chegou, que é o caso em que o painel é a única
       * coisa que sobra.
       *
       * Solta de propósito, e sem `await`: a tela seguinte não pode esperar
       * pelo servidor, e uma falha aqui não pode tirar da pessoa a conversa que
       * já está aberta na outra aba.
       */
      void api
        .pedirBoleto({
          customer: { name: contato.nome, email: contato.email, phone: contato.telefone, document: onlyDigits(cpf) },
          bumps: selectedBumps,
          contribuicao: contribuicaoExtra,
          attrib: getAttribution(),
          session_id: getSessionId(),
        })
        .catch(() => {
          /* O evento acima já registrou a passagem; aqui não há o que dizer ao cliente. */
        });

      setLinkDaConversa(conversa);
      setStep('whatsapp');
      return;
    }

    setIsProcessing(true);

    /*
     * AQUI o Pixel do Meta passava a saber QUEM era a pessoa (e-mail, telefone,
     * nome e CPF, hasheados) para casar com a API de Conversões. Removido em
     * 21/08/2026 junto com o resto do rastreamento de terceiros.
     *
     * O contato continua indo para o NOSSO servidor no evento abaixo — é o que
     * faz esta pessoa aparecer no painel do dono mesmo sem comprar.
     */
    /*
     * O Lead sai ANTES da chamada que gera a cobrança, e de propósito.
     *
     * É o único momento em que temos e-mail e telefone de alguém que ainda
     * pode não comprar — e são esses dois campos que dão ao Meta a chance de
     * reconhecer a pessoa. Se o gateway recusar o CPF logo abaixo, o evento já
     * saiu, que é o certo: a pessoa deixou os dados de verdade.
     */
    rastrear('Lead', { step: 13, contato, contentIds: ['main', ...selectedBumps] });

    try {
      const order = await api.createOrder({
        offer: 'main',
        bumps: selectedBumps,
        metodo,
        contribuicao: contribuicaoExtra,
        customer: {
          name: fullName.trim(),
          email: email.trim(),
          phone: onlyDigits(phone),
          document: onlyDigits(cpf),
        },
        // O carimbo do anúncio viaja com o pedido: daqui em diante a venda
        // sabe de onde veio, mesmo que o PIX só caia horas depois.
        attrib: getAttribution(),
        session_id: getSessionId(),
      });
      /*
       * NADA DE SEGURAR O FLUXO AQUI.
       *
       * Houve uma espera curta neste ponto, para a barra de carregamento ser
       * lida em vez de piscar quando o gateway responde rápido. Ela custou caro:
       * com o `await` no meio, o checkout voltava sozinho para a tela inicial
       * depois de a cobrança já ter sido criada — a pessoa pagava do lado do
       * servidor e do lado dela a tela dizia que nada tinha acontecido.
       * Reproduzido em 17/08/2026 na bateria de navegação e confirmado tirando
       * só estas linhas.
       *
       * A barra não precisa disso: ela reflete o tempo REAL da chamada. Em
       * produção o gateway leva de 1 a 3 segundos e ela aparece inteira; no modo
       * mock ela passa rápido, e passar rápido é a verdade daquele ambiente.
       */

      /*
       * A BARRA SAI DA TELA ANTES DE O PASSO MUDAR — a ordem aqui não é gosto.
       *
       * Enquanto ela está montada o formulário é mais alto; ao trocar de passo,
       * o formulário inteiro sai e a página muda de tamanho duas vezes seguidas.
       * A rolagem automática até o PIX começa no meio dessa dança, mira uma
       * posição que deixa de existir e para a mil pixels do alvo. Medido em
       * 17/08/2026: com a barra saindo junto, a área de pagamento ficava a
       * 1084px da tela; tirando-a primeiro, volta aos 80px de sempre.
       */
      setIsProcessing(false);

      setMainOrder(order);
      writeStoredOrder({ id: order.id });
      setRetomouPedido(false);
      // O passo segue o método que o SERVIDOR devolveu, não o que a tela pediu:
      // é ele que decide, e discordar aqui mostraria o painel errado.
      setStep(order.metodo === 'boleto' ? 'boleto' : 'pix');

      // Pagamento na tela: o cliente chegou ao ponto de pagar. Com o pedido já
      // criado, o evento carrega os IDs reais do que ele escolheu.
      rastrear('AddPaymentInfo', {
        step: 13,
        contato,
        orderId: order.id,
        contentIds: order.items.map((item) => item.id),
      });
    } catch (error) {
      setFormError(
        error instanceof ApiError
          ? error.message
          : metodo === 'boleto'
            ? 'Não foi possível emitir o boleto. Tente novamente ou pague com PIX.'
            : 'Não foi possível gerar a chave PIX. Tente novamente.',
      );
    } finally {
      setIsProcessing(false);
    }
  };

  const createAddonOrder = async (offer: Exclude<OfferId, 'main'>, nextStep: CheckoutStep) => {
    if (!mainOrder) return;
    setActionError(null);
    setIsProcessing(true);
    try {
      const order = await api.createOrder({ offer, parentOrderId: mainOrder.id });
      setAddonOrder(order);
      setStep(nextStep);
    } catch (error) {
      setActionError(error instanceof ApiError ? error.message : 'Não foi possível gerar a chave PIX desta oferta.');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleRejectUpsell = () => {
    setActionError(null);
    setStep('downsell');
    scrollToCheckout();
  };

  /*
   * Fim do fluxo. Leva para /obg, que é um endereço de verdade — o funil é uma
   * página só e nunca troca de URL, então sem essa ida o Google Ads não teria
   * o que contar como conversão de compra.
   *
   * A saída acontece aqui, e não assim que o PIX principal é confirmado, para
   * não passar por cima do upsell e do downsell: sair antes deles apagaria
   * essa receita. Quem pagou tem motivo forte para chegar até aqui, porque é
   * onde estão os acessos — e a própria /obg os mostra de novo, para ninguém
   * ficar sem o que comprou ao trocar de página.
   */
  const handleFinishAll = () => {
    if (mainOrder) writeStoredOrder({ id: mainOrder.id, finished: true });
    setStep('completed');
    window.location.assign('/obg');
  };

  return (
    <div className="w-full bg-superficie border border-borda rounded-2xl p-4 sm:p-6 shadow-md space-y-6 text-left">
      <div className="border-b border-borda pb-4 space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <span className="text-xs font-sans uppercase tracking-widest text-ouro font-bold block">
              Você chegou até aqui por uma razão. 🙏
            </span>
            <h2 className="font-sans font-bold text-xl text-texto leading-snug">
              Não deixe essa decisão que pode mudar sua vida pela metade.
            </h2>
          </div>
          <div className="w-10 h-10 rounded-full bg-sutil border border-borda flex items-center justify-center text-ouro flex-shrink-0">
            <ShieldCheck className="w-5 h-5" />
          </div>
        </div>

        {/* As instruções valem só enquanto há formulário para preencher: repeti-las
            na tela do PIX ou do upsell mandaria o cliente conferir dados que já
            não estão à vista. */}
        {step === 'form' && !isRestoring && (
          <div className="space-y-1.5 text-sm text-suave leading-relaxed">
            <p className="text-texto font-semibold">
              Esse é o momento de confirmar sua devoção ao Arcanjo Miguel.
            </p>
            <p>
              {temEscolhaDePagamento
                ? 'Confira seus dados, escolha como pagar e confirme sua contribuição.'
                : 'Confira seus dados, confirme sua contribuição e finalize pelo PIX.'}
            </p>
            <p>Após a confirmação do pagamento, seu acesso será liberado.</p>
          </div>
        )}
      </div>

      {/* Retomando um pedido anterior: evita mostrar o formulário a quem já pagou */}
      {isRestoring && (
        <div className="py-10 text-center space-y-2">
          <div className="w-8 h-8 mx-auto rounded-full border-2 border-borda border-t-ouro animate-spin" />
          <p className="text-xs text-suave">Recuperando seu pedido...</p>
        </div>
      )}

      {/*
        A mensagem de recuperação, para quem voltou a um pedido em aberto.

        Fica ACIMA do painel de pagamento porque é o primeiro contexto de que
        essa pessoa precisa: ela reencontra um QR Code que já tinha visto e
        merece uma linha explicando por que ele continua ali. Some assim que o
        pagamento é confirmado, junto com o painel inteiro.
      */}
      {(step === 'pix' || step === 'boleto') && retomouPedido && mainStatus.order && (
        <ConviteDeRetomada
          valorFormatado={mainStatus.order.amountFormatted}
          onContinuar={rolarAtePagamento}
        />
      )}

      {/* STEP 1: PIX DO PEDIDO PRINCIPAL */}
      {step === 'pix' && mainStatus.order && (
        <PixPanel
          order={mainStatus.order}
          title="Falta só um passo: conclua o PIX"
          description="Sua Oração Sagrada já está reservada em seu nome. Assim que o banco confirmar, o acesso é liberado automaticamente nesta tela."
          isChecking={mainStatus.isChecking}
          error={mainStatus.error}
          onCheckNow={() => void mainStatus.checkNow()}
          onEditarPedido={editarPedido}
        />
      )}

      {/* STEP 1-B: BOLETO DO PEDIDO PRINCIPAL */}
      {step === 'boleto' && mainStatus.order && (
        <BoletoPanel
          order={mainStatus.order}
          title="Seu boleto foi emitido"
          description="Sua Oração Sagrada está reservada em seu nome. Ela é liberada assim que o banco confirmar o pagamento."
          isChecking={mainStatus.isChecking}
          error={mainStatus.error}
          onCheckNow={() => void mainStatus.checkNow()}
          onEditarPedido={editarPedido}
        />
      )}

      {/*
        STEP 1-C: A CONVERSA, para quem escolheu pagar de outra forma.

        Não é uma tela de espera nem de erro: é o fim do caminho no site. A
        pessoa foi para o WhatsApp e o pagamento se combina lá. O que esta tela
        precisa fazer é (1) garantir que ela CHEGOU na conversa — o pop-up é
        bloqueado com frequência, e sem o botão de reabrir ela ficaria sem nada
        depois de ter decidido pagar — e (2) deixar a porta do PIX aberta, porque
        parte de quem clica aqui muda de ideia quando vê que o PIX é imediato.
      */}
      {step === 'whatsapp' && (
        <m.div initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} className="text-center py-6 space-y-5">
          <div className="w-16 h-16 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center mx-auto border border-emerald-200">
            <MessageCircle className="w-8 h-8" />
          </div>

          <div className="space-y-2">
            <h3 className="font-sans font-bold text-xl text-texto">Seus dados foram enviados</h3>
            <p className="text-sm text-suave leading-relaxed">
              Abrimos o WhatsApp com os seus dados prontos. <strong className="text-texto">Toque em enviar</strong> na
              conversa que abriu — a nossa equipe emite o seu boleto e devolve ali mesmo, em poucos minutos.
            </p>
            <p className="text-[13px] text-suave">
              Valor da sua contribuição: <strong className="text-texto">{formatBRL(totalValue)}</strong>
            </p>
          </div>

          {/*
            A porta de entrada manual: se a aba não abriu, é por aqui.

            Ela não é acessório. O pop-up é bloqueado com frequência no navegador
            embutido do Instagram e do Facebook — que é por onde este público
            chega —, e sem este botão a pessoa preencheria tudo e ficaria olhando
            para uma tela que diz que enviou algo que não foi.
          */}
          <a
            href={linkDaConversa}
            target="_blank"
            rel="noreferrer"
            className="w-full min-h-[56px] py-3.5 px-4 bg-[#278647] text-white rounded-xl font-sans font-bold text-sm sm:text-base flex items-center justify-center gap-2 hover:bg-[#1F6F3A] transition-colors"
          >
            <MessageCircle className="w-5 h-5" />
            <span>Não abriu? Toque aqui para enviar seus dados</span>
          </a>

          <div className="bg-sutil border border-borda rounded-xl p-3.5 space-y-2.5">
            <p className="text-[13px] text-suave leading-snug">
              O boleto leva alguns minutos para chegar, e depois de pago o banco ainda demora até 3 dias úteis para
              confirmar. Prefere receber a sua Oração agora? O PIX libera na hora.
            </p>
            <button
              onClick={() => {
                setMetodo('pix');
                setStep('form');
                scrollToCheckout();
              }}
              className="w-full min-h-[44px] py-2.5 px-4 bg-superficie border border-borda text-texto rounded-xl font-sans font-semibold text-xs hover:border-ouro transition-colors cursor-pointer"
            >
              Quero pagar com PIX agora
            </button>
          </div>
        </m.div>
      )}

      {/* STEP 2: OFERTA DE UPSELL */}
      {step === 'upsell' && (
        <m.div initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} className="space-y-5 text-left">
          <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 text-center text-xs text-emerald-800 font-semibold flex items-center justify-center gap-1.5">
            <CheckCircle2 className="w-4 h-4" />
            Contribuição confirmada! Sua Oração Sagrada já está liberada.
          </div>

          <div className="bg-amber-50 border border-amber-300 rounded-xl p-3.5 text-center space-y-1">
            <span className="text-[12px] font-black uppercase tracking-widest text-ouro bg-superficie px-2 py-0.5 rounded-full border border-amber-200">
              🙏 ESPERE — SUA DEVOÇÃO PODE IR MAIS LONGE
            </span>
            <h3 className="font-sans font-bold text-lg text-texto">{UPSELL_DATA.headline}</h3>
            <p className="text-xs text-suave">{UPSELL_DATA.subheadline}</p>
          </div>

          <div className="bg-sutil border-2 border-ouro rounded-2xl p-4 sm:p-5 space-y-4 relative overflow-hidden">
            <div className="flex items-start gap-3 border-b border-borda pb-3">
              <div className="w-12 h-12 rounded-xl bg-texto text-ouro flex items-center justify-center text-2xl flex-shrink-0 shadow-xs">
                📱
              </div>
              <div className="space-y-0.5">
                <span className="text-[12px] font-bold bg-ouro text-sobre-ouro px-2 py-0.5 rounded-full uppercase tracking-wider inline-block">
                  O QUE VOCÊ VAI RECEBER
                </span>
                <h4 className="font-sans font-bold text-base text-texto leading-snug">
                  Aplicativo Espiritual com Rotina Diária & Tutorial em Vídeo
                </h4>
              </div>
            </div>

            <div className="space-y-3">
              {UPSELL_DATA.features.map((feature, idx) => (
                <div key={idx} className="flex items-start gap-2.5">
                  <div className="w-5 h-5 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center flex-shrink-0 mt-0.5 border border-emerald-200">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                  </div>
                  <div className="space-y-0.5">
                    <p className="font-sans font-bold text-xs sm:text-sm text-texto">{feature.title}</p>
                    <p className="text-xs text-suave leading-relaxed">{feature.description}</p>
                  </div>
                </div>
              ))}
            </div>

            <div className="p-3 bg-superficie rounded-xl border border-borda text-xs text-suave flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-ouro flex-shrink-0" />
              <span>
                <strong>Fique em paz:</strong> {UPSELL_DATA.reassuranceNote}
              </span>
            </div>

            <div className="bg-superficie p-3.5 rounded-xl border border-borda flex items-center justify-between">
              <div>
                <span className="text-[13px] text-suave line-through block">De {UPSELL_DATA.originalPrice} por apenas:</span>
                <span className="font-sans font-extrabold text-2xl text-texto">{UPSELL_DATA.offerPrice}</span>
              </div>
              {/* O número acompanha a âncora e o preço logo ao lado (297 → 47).
                  Estava fixo em 80% e ficou errado quando o upsell caiu para
                  R$ 47,00 — selo de desconto que não bate com a conta é o tipo
                  de detalhe que o cliente confere justamente na hora de pagar. */}
              <span className="text-xs font-bold text-emerald-700 bg-emerald-50 px-2.5 py-1 rounded-full border border-emerald-200">
                84% DE DESCONTO
              </span>
            </div>

            {actionError && (
              <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 flex items-center gap-1.5">
                <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
                {actionError}
              </p>
            )}

            <Button
              onClick={() => void createAddonOrder('upsell', 'upsell_pix')}
              variant="comprar"
              fullWidth
              isLoading={isProcessing}
              icon={<Sparkles className="w-4 h-4 ml-1" />}
            >
              SIM! ADICIONAR O APLICATIVO POR APENAS {UPSELL_DATA.offerPrice}
            </Button>

            <button
              onClick={handleRejectUpsell}
              className="w-full text-center text-xs text-suave hover:text-texto underline font-medium py-1 transition-colors cursor-pointer"
            >
              Não, obrigado. Sigo apenas com a minha Oração Sagrada.
            </button>
          </div>
        </m.div>
      )}

      {/* STEP 3: PIX DO UPSELL */}
      {step === 'upsell_pix' && addonStatus.order && (
        <>
          <PixPanel
            order={addonStatus.order}
            title="Conclua o PIX do Aplicativo Espiritual"
            description="Esta é uma segunda contribuição, separada da Oração principal que você já garantiu."
            isChecking={addonStatus.isChecking}
            error={addonStatus.error}
            onCheckNow={() => void addonStatus.checkNow()}
          />
          <button
            onClick={handleFinishAll}
            className="w-full min-h-[44px] text-center text-xs text-suave hover:text-texto underline font-medium py-1 transition-colors cursor-pointer"
          >
            Prefiro seguir agora para a minha Oração Sagrada
          </button>
        </>
      )}

      {/* STEP 3.5: DOWNSELL */}
      {step === 'downsell' && (
        <m.div initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} className="space-y-5 text-left">
          <div className="bg-creme border border-ouro rounded-xl p-3.5 text-center space-y-1">
            <span className="text-[12px] font-black uppercase tracking-widest text-ouro bg-superficie px-2 py-0.5 rounded-full border border-amber-200">
              {DOWNSELL_DATA.badgeTitle}
            </span>
            <h3 className="font-sans font-bold text-lg text-texto">{DOWNSELL_DATA.headline}</h3>
            <p className="text-xs text-suave">{DOWNSELL_DATA.subheadline}</p>
          </div>

          <div className="bg-sutil border-2 border-ouro rounded-2xl p-4 sm:p-5 space-y-4 relative overflow-hidden">
            <div className="flex items-start gap-3 border-b border-borda pb-3">
              <div className="w-12 h-12 rounded-xl bg-texto text-ouro flex items-center justify-center text-2xl flex-shrink-0 shadow-xs">
                🙏
              </div>
              <div className="space-y-0.5">
                <span className="text-[12px] font-bold bg-ouro text-sobre-ouro px-2 py-0.5 rounded-full uppercase tracking-wider inline-block">
                  ÚLTIMA CHANCE NESTA PÁGINA
                </span>
                <h4 className="font-sans font-bold text-base text-texto leading-snug">{DOWNSELL_DATA.productTitle}</h4>
              </div>
            </div>

            <div className="space-y-3">
              {DOWNSELL_DATA.features.map((feature, idx) => (
                <div key={idx} className="flex items-start gap-2.5">
                  <div className="w-5 h-5 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center flex-shrink-0 mt-0.5 border border-emerald-200">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                  </div>
                  <div className="space-y-0.5">
                    <p className="font-sans font-bold text-xs sm:text-sm text-texto">{feature.title}</p>
                    <p className="text-xs text-suave leading-relaxed">{feature.description}</p>
                  </div>
                </div>
              ))}
            </div>

            <div className="p-3 bg-superficie rounded-xl border border-borda text-xs text-suave flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-ouro flex-shrink-0" />
              <span>
                <strong>Importante:</strong> {DOWNSELL_DATA.reassuranceNote}
              </span>
            </div>

            <div className="bg-superficie p-3.5 rounded-xl border border-borda flex items-center justify-between">
              <div>
                <span className="text-[13px] text-suave line-through block">De {DOWNSELL_DATA.originalPrice} por apenas:</span>
                <span className="font-sans font-extrabold text-2xl text-texto">{DOWNSELL_DATA.offerPrice}</span>
              </div>
              <span className="text-xs font-bold text-emerald-700 bg-emerald-50 px-2.5 py-1 rounded-full border border-emerald-200">
                {DOWNSELL_DATA.discountLabel}
              </span>
            </div>

            {actionError && (
              <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 flex items-center gap-1.5">
                <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
                {actionError}
              </p>
            )}

            <Button
              onClick={() => void createAddonOrder('downsell', 'downsell_pix')}
              variant="comprar"
              fullWidth
              isLoading={isProcessing}
              icon={<Sparkles className="w-4 h-4 ml-1" />}
            >
              {DOWNSELL_DATA.ctaText}
            </Button>

            <button
              onClick={handleFinishAll}
              className="w-full text-center text-xs text-suave hover:text-texto underline font-medium py-1 transition-colors cursor-pointer"
            >
              {DOWNSELL_DATA.rejectText}
            </button>
          </div>
        </m.div>
      )}

      {/* STEP 3.6: PIX DO DOWNSELL */}
      {step === 'downsell_pix' && addonStatus.order && (
        <>
          <PixPanel
            order={addonStatus.order}
            title="Conclua o PIX da Versão Essencial"
            description="Esta é uma segunda contribuição, separada da Oração principal que você já garantiu."
            isChecking={addonStatus.isChecking}
            error={addonStatus.error}
            onCheckNow={() => void addonStatus.checkNow()}
          />
          <button
            onClick={handleFinishAll}
            className="w-full min-h-[44px] text-center text-xs text-suave hover:text-texto underline font-medium py-1 transition-colors cursor-pointer"
          >
            Prefiro seguir agora para a minha Oração Sagrada
          </button>
        </>
      )}

      {/* STEP 4: CONCLUÍDO */}
      {step === 'completed' && (
        <m.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="text-center py-6 space-y-4">
          <div className="w-16 h-16 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center mx-auto border border-emerald-200">
            <Check className="w-8 h-8 stroke-[3]" />
          </div>
          <div className="space-y-1">
            <h3 className="font-sans font-bold text-2xl text-texto">Pagamento confirmado! 🙏</h3>
            <p className="text-sm text-suave">
              Sua devoção foi registrada e seu acesso está liberado abaixo. Guarde esta página — você pode voltar a
              ela por este mesmo navegador a qualquer momento.
            </p>
            {mainOrder && (
              <p className="text-[13px] text-suave pt-1">
                Pedido <strong className="text-texto font-mono">{mainOrder.id.slice(0, 8).toUpperCase()}</strong>
                {' • '}
                {mainOrder.customer.email}
              </p>
            )}
          </div>

          {access?.contents.length ? (
            <div className="space-y-2.5 text-left">
              {access.contents.map((content) => (
                <div key={content.itemId} className="bg-emerald-50 border border-emerald-200 rounded-xl p-3.5 space-y-1.5">
                  <p className="font-bold text-sm text-emerald-900 flex items-center gap-1.5">
                    <Sparkles className="w-4 h-4 text-emerald-600 flex-shrink-0" />
                    {content.title}
                  </p>
                  <p className="text-xs text-emerald-800">{content.description}</p>
                  {content.url ? (
                    <a
                      href={content.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 text-xs font-bold text-emerald-900 underline hover:text-emerald-700"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      Acessar agora
                    </a>
                  ) : (
                    // Sem DELIVERY_URL_<ITEM> configurada no servidor não há link a mostrar.
                    <p className="text-[13px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5">
                      Link de acesso ainda não configurado. Anote o número do pedido acima e acione o suporte.
                    </p>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-suave bg-sutil border border-borda rounded-xl p-3">
              Estamos preparando os seus acessos. Se nada aparecer, recarregue esta página — fique tranquilo, seu
              pagamento já está registrado.
            </p>
          )}
        </m.div>
      )}

      {/* STEP 0: FORMULÁRIO */}
      {step === 'form' && !isRestoring && (
        <form onSubmit={handleSubmitPayment} className="space-y-5">
          <div className="space-y-3">
            <label className="text-xs font-sans font-bold text-texto uppercase tracking-wider block">
              1. Em nome de quem será esta oração
            </label>
            <div className="space-y-2.5">
              <input
                type="text"
                placeholder="Seu nome completo"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className={CLASSE_CAMPO}
                required
              />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <input
                  type="email"
                  placeholder="Seu melhor e-mail (onde chega o acesso)"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={CLASSE_CAMPO}
                  required
                />
                <input
                  type="tel"
                  placeholder="WhatsApp com DDD (11 91234-5678)"
                  value={phone}
                  onChange={(e) => setPhone(maskPhone(e.target.value))}
                  inputMode="numeric"
                  className={CLASSE_CAMPO}
                />
              </div>
              {/* Sem cobrança para nascer, o CPF não serve para nada — e cobrá-lo
                  de quem só quer perguntar como pagar de outro jeito é atrito no
                  pior lugar. Ver a validação em handleSubmitPayment. */}
              <input
                type="text"
                placeholder={vaiPeloWhatsapp ? 'CPF de quem vai no boleto (000.000.000-00)' : 'CPF de quem vai pagar (000.000.000-00)'}
                value={cpf}
                onChange={(e) => setCpf(maskCPF(e.target.value))}
                inputMode="numeric"
                autoComplete="off"
                className={CLASSE_CAMPO}
                required
              />
            </div>
          </div>

          <div className="space-y-3 pt-2 border-t border-borda">
            <div className="flex items-center justify-between">
              <label className="text-xs font-sans font-bold text-texto uppercase tracking-wider flex items-center gap-1.5">
                <Sparkles className="w-4 h-4 text-ouro" />
                2. Fortaleça ainda mais a sua proteção
              </label>
              <span className="text-[12px] font-bold bg-ouro/10 text-ouro px-2 py-0.5 rounded-full uppercase">
                Só nesta página
              </span>
            </div>

            <div className="space-y-2.5">
              {ORDER_BUMPS.map((bump) => {
                const isChecked = selectedBumps.includes(bump.id);
                return (
                  <div
                    key={bump.id}
                    onClick={() => toggleBump(bump.id)}
                    className={`relative p-3.5 sm:p-4 rounded-xl border-2 transition-all cursor-pointer select-none flex items-start gap-3 ${
                      isChecked ? 'bg-sutil border-ouro shadow-xs' : 'bg-superficie border-borda hover:border-ouro/60'
                    }`}
                  >
                    <div className="mt-0.5 flex-shrink-0">
                      <div
                        className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-colors ${
                          isChecked ? 'bg-ouro border-ouro text-sobre-ouro' : 'border-borda bg-superficie'
                        }`}
                      >
                        {isChecked && <Check className="w-3.5 h-3.5 stroke-[3]" />}
                      </div>
                    </div>

                    <div className="flex-1 space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-sans font-semibold text-xs sm:text-sm text-texto flex items-center gap-1">
                          <span>{bump.icon}</span>
                          <span>{bump.title}</span>
                        </span>
                        <span className="font-sans font-bold text-xs sm:text-sm text-ouro whitespace-nowrap">
                          +{bump.priceFormatted}
                        </span>
                      </div>
                      <p className="text-[13px] text-suave leading-snug">{bump.subtitle}</p>
                    </div>

                    <span className="absolute -top-2.5 right-3 bg-acao text-sobre-acao text-[11px] font-bold px-2 py-0.5 rounded-full tracking-wider uppercase shadow-xs">
                      {bump.tag}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/*
            O acréscimo voluntário.

            Pedido por um comprador em 17/08/2026, que quis dar mais do que o
            valor do pedido. Três coisas o mantêm honesto, e nenhuma é decoração:

            - NASCE DESMARCADO. Nada é somado sem a pessoa tocar. Um acréscimo
              pré-selecionado é dinheiro cobrado sem pedido, e volta como
              estorno — junto com a confiança.
            - O TOQUE DESFAZ. Tocar de novo no mesmo valor tira. Quem se
              arrepende não precisa recarregar a página nem procurar como voltar.
            - O TOTAL LOGO ABAIXO MUDA À VISTA, e o resumo mostra a linha
              separada. A pessoa vê o que está fazendo enquanto faz.

            A promessa é de reciprocidade — o que ela recebe de volta é
            intercessão e cuidado, não uma quantia. Prometer retorno em dinheiro
            proporcional ao valor pago é o que transforma doação em contestação de
            pagamento, e é uma linha que este texto não atravessa.
          */}
          <div className="space-y-3 pt-2 border-t border-borda">
            <div className="flex items-center justify-between">
              <label className="text-xs font-sans font-bold text-texto uppercase tracking-wider flex items-center gap-1.5">
                <Heart className="w-4 h-4 text-ouro" />
                3. Quer semear um pouco mais?
              </label>
              <span className="text-[12px] font-bold text-suave uppercase">Opcional</span>
            </div>

            <p className="text-[13px] text-suave leading-snug">
              Quem estende a mão com o coração aberto recebe de volta pela intercessão de Miguel. Se sentir no
              coração, some um valor à sua contribuição — sua Oração é a mesma, e a sua semente vai junto na
              consagração.
            </p>

            <div className="grid grid-cols-3 gap-2.5">
              {CONTRIBUICOES.map((opcao) => {
                const escolhida = contribuicaoExtra === opcao.id;
                return (
                  <button
                    key={opcao.id}
                    type="button"
                    aria-pressed={escolhida}
                    onClick={() => setContribuicaoExtra(escolhida ? null : opcao.id)}
                    className={`min-h-[52px] rounded-xl border-2 font-sans font-bold text-sm transition-all cursor-pointer ${
                      escolhida
                        ? 'bg-ouro border-ouro text-sobre-ouro shadow-xs'
                        : 'bg-superficie border-borda text-texto hover:border-ouro/60'
                    }`}
                  >
                    {opcao.rotulo}
                  </button>
                );
              })}
            </div>

            {contribuicaoExtra && (
              <p className="text-[13px] text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 flex items-center gap-1.5">
                <Check className="w-4 h-4 flex-shrink-0" />
                <span>
                  Que Deus te retribua. Toque de novo no valor para tirar, se preferir.
                </span>
              </p>
            )}
          </div>

          <div className="space-y-3 pt-2 border-t border-borda">
            <label className="text-xs font-sans font-bold text-texto uppercase tracking-wider block">
              4. Confirme sua contribuição
            </label>

            {/*
              Sem boleto configurado, a tela continua exatamente como era: um
              cartão só, informando o meio de pagamento. Não é escolha, é
              informação — e transformar isso num seletor de uma opção só faria
              o cliente procurar a segunda.
            */}
            {!temEscolhaDePagamento ? (
              <div className="p-3.5 bg-sutil border border-ouro rounded-xl flex items-center gap-3">
                {/* O verde fixo #278647 em vez de emerald-600: este é um dos dois
                    lugares com texto branco sobre verde, e o #278647 é o tom já
                    medido em 4.5:1 contra o branco. Deixá-lo literal mantém o
                    contraste igual nos dois temas. */}
                <div className="w-10 h-10 rounded-lg bg-[#278647] text-white flex items-center justify-center flex-shrink-0">
                  <QrCode className="w-6 h-6" />
                </div>
                <div>
                  <p className="font-sans font-bold text-xs sm:text-sm text-texto flex items-center gap-1.5">
                    <span>PIX — o caminho mais rápido</span>
                    <span className="text-[12px] bg-emerald-100 text-emerald-800 font-extrabold px-2 py-0.5 rounded-full">
                      LIBERAÇÃO IMEDIATA
                    </span>
                  </p>
                  <p className="text-[13px] text-suave mt-0.5">
                    Pague pelo app do seu banco, em segundos. Seu acesso é liberado assim que o banco confirmar — sem
                    espera, sem burocracia.
                  </p>
                </div>
              </div>
            ) : (
              /*
                A escolha entre os dois.

                O PIX vem primeiro e continua sendo o único com a tarja verde:
                ele é o caminho que libera na hora, e num funil de decisão
                tomada agora essa diferença é a própria oferta. O boleto aparece
                com o prazo escrito no rótulo — quem escolher precisa saber, na
                hora de escolher, que vai esperar.

                `role="radiogroup"` porque é o que isto é, e não um par de
                botões: leitor de tela anuncia "1 de 2 selecionado", e a seta do
                teclado troca a opção.
              */
              <div className="space-y-2.5" role="radiogroup" aria-label="Forma de pagamento">
                {[
                  {
                    id: 'pix' as MetodoPagamento,
                    icone: <QrCode className="w-6 h-6" />,
                    corDoIcone: 'bg-[#278647] text-white',
                    titulo: 'PIX — o caminho mais rápido',
                    tarja: 'LIBERAÇÃO IMEDIATA',
                    texto:
                      'Pague pelo app do seu banco, em segundos. Seu acesso é liberado assim que o banco confirmar — sem espera, sem burocracia.',
                  },
                  /*
                   * A MESMA OPÇÃO, DOIS DESTINOS.
                   *
                   * Com provedor de emissão, ela emite o boleto na hora. Sem
                   * provedor — o estado de 17/08/2026 —, ela abre uma conversa no
                   * WhatsApp e o dono combina a forma de pagar à mão. O rótulo
                   * muda junto, porque prometer "boleto" e entregar uma conversa
                   * seria enganar no passo do dinheiro.
                   */
                  boletoPeloWhatsapp
                    ? {
                      id: 'boleto' as MetodoPagamento,
                      icone: <Barcode className="w-6 h-6" />,
                      corDoIcone: 'bg-texto text-superficie',
                      titulo: 'Boleto bancário',
                      tarja: 'ENVIAMOS PELO WHATSAPP',
                      texto:
                        'Preencha os seus dados e toque em gerar boleto. Nossa equipe emite o boleto no seu nome e envia para você pelo WhatsApp, em poucos minutos.',
                    }
                    : {
                      id: 'boleto' as MetodoPagamento,
                      icone: <Barcode className="w-6 h-6" />,
                      corDoIcone: 'bg-texto text-superficie',
                      titulo: 'Boleto bancário',
                      tarja: 'ATÉ 3 DIAS ÚTEIS',
                      texto:
                        'Pague pelo app do banco, no caixa ou na lotérica. Sua Oração é liberada depois que o banco confirmar o pagamento — não é na hora.',
                    },
                ].map((opcao) => {
                  const escolhida = metodo === opcao.id;
                  return (
                    <div
                      key={opcao.id}
                      onClick={() => setMetodo(opcao.id)}
                      onKeyDown={(evento) => {
                        if (evento.key === ' ' || evento.key === 'Enter') {
                          evento.preventDefault();
                          setMetodo(opcao.id);
                        }
                      }}
                      role="radio"
                      aria-checked={escolhida}
                      tabIndex={escolhida ? 0 : -1}
                      className={`p-3.5 rounded-xl border-2 transition-all cursor-pointer select-none flex items-start gap-3 ${
                        escolhida ? 'bg-sutil border-ouro shadow-xs' : 'bg-superficie border-borda hover:border-ouro/60'
                      }`}
                    >
                      {/* Círculo, e não quadrado: os order bumps acima usam
                          caixa de marcar, e aqui só uma das duas vale. A forma
                          diferente é o que diz isso sem texto. */}
                      <div className="mt-0.5 flex-shrink-0">
                        <div
                          className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${
                            escolhida ? 'border-ouro' : 'border-borda'
                          }`}
                        >
                          {escolhida && <div className="w-2.5 h-2.5 rounded-full bg-ouro" />}
                        </div>
                      </div>

                      <div className={`w-10 h-10 rounded-lg ${opcao.corDoIcone} flex items-center justify-center flex-shrink-0`}>
                        {opcao.icone}
                      </div>

                      <div className="flex-1 space-y-0.5">
                        <p className="font-sans font-bold text-xs sm:text-sm text-texto flex flex-wrap items-center gap-1.5">
                          <span>{opcao.titulo}</span>
                          <span
                            className={`text-[12px] font-extrabold px-2 py-0.5 rounded-full ${
                              opcao.id === 'pix' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-900'
                            }`}
                          >
                            {opcao.tarja}
                          </span>
                        </p>
                        <p className="text-[13px] text-suave leading-snug">{opcao.texto}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="bg-sutil p-4 rounded-xl border border-borda space-y-2">
            <div className="flex items-center justify-between text-xs text-suave">
              <span>Oração Sagrada do Arcanjo Miguel</span>
              <span>{formatBRL(basePrice)}</span>
            </div>

            {selectedBumps.map((bumpId) => {
              const bump = ORDER_BUMPS.find((b) => b.id === bumpId);
              if (!bump) return null;
              return (
                <div key={bumpId} className="flex items-center justify-between text-xs text-suave">
                  <span>+ {bump.title}</span>
                  <span>{bump.priceFormatted}</span>
                </div>
              );
            })}

            {/* A linha do acréscimo aparece separada, com o nome do que é: no
                extrato e na conferência, "contribuição de gratidão" precisa ser
                reconhecível como escolha dela, e não como taxa que apareceu. */}
            {contribuicaoExtra && (
              <div className="flex items-center justify-between text-xs text-ouro font-semibold">
                <span>+ Contribuição de gratidão</span>
                <span>{formatBRL(CONTRIBUICOES.find((c) => c.id === contribuicaoExtra)?.valor ?? 0)}</span>
              </div>
            )}

            <div className="border-t border-borda pt-2 flex items-center justify-between font-sans font-bold text-base text-texto">
              <span>Sua contribuição:</span>
              <span className="text-xl text-ouro">{formatBRL(totalValue)}</span>
            </div>
          </div>

          {formError && (
            <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 flex items-center gap-1.5">
              <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
              {formError}
            </p>
          )}

          {/*
            A barra da espera, entre o botão e o PIX.

            Fica ACIMA do botão, e não abaixo: no celular o botão costuma ser a
            última coisa visível antes da dobra, e uma barra embaixo dele
            nasceria fora da tela — informação que existe e ninguém vê. Acima,
            ela empurra o botão para baixo e ocupa exatamente o lugar para onde a
            pessoa está olhando depois de tocar.
          */}
          <BarraDoCheckout ativo={isProcessing} />

          {/* O rótulo diz o que vai acontecer ao tocar: quem escolheu boleto
              recebe um boleto, e prometer PIX aqui seria o começo de uma
              surpresa na tela seguinte. */}
          <Button type="submit" variant="comprar" fullWidth isLoading={isProcessing} icon={<ArrowRight className="w-5 h-5 ml-1" />}>
            {vaiPeloWhatsapp
              ? `GERAR BOLETO DE ${formatBRL(totalValue)}`
              : metodo === 'boleto'
                ? `QUERO MINHA ORAÇÃO — BOLETO DE ${formatBRL(totalValue)}`
                : `QUERO MINHA ORAÇÃO — PIX DE ${formatBRL(totalValue)}`}
          </Button>

          <div className="text-center space-y-1.5 pt-1">
            <p className="text-[13px] text-suave flex items-center justify-center gap-1.5">
              <Lock className="w-3.5 h-3.5 text-emerald-600 inline" />
              <span>Ambiente criptografado • 30 dias de garantia • Seus dados protegidos</span>
            </p>
          </div>
        </form>
      )}
    </div>
  );
};
