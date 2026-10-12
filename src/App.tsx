import React, { useState, useEffect, useRef, lazy, Suspense } from 'react';
/*
 * A BIBLIOTECA DE ANIMAÇÃO ENTRA NA VERSÃO ENXUTA.
 *
 * `motion.div` traz o motor inteiro para dentro do primeiro download — inclusive
 * arrasto, animação de layout e detecção de rolagem, que este funil não usa. O
 * `m` é o mesmo componente sem essa bagagem, e o `LazyMotion` carrega só o
 * conjunto `domAnimation`: opacidade, transformação, `whileHover`, `whileTap` e
 * `variants`, que é exatamente o que existe aqui — conferido arquivo por arquivo
 * antes da troca (as quatro ocorrências de "layout" no código eram comentários,
 * não a propriedade de animação).
 *
 * Nenhuma animação muda. O que muda é o peso: ~25 kB comprimidos a menos na
 * entrada, num público que chega por 4G.
 */
import { AnimatePresence, LazyMotion, domAnimation } from 'motion/react';
import * as m from 'motion/react-m';
import { ChevronLeft, RotateCcw } from 'lucide-react';
import { QuizOption } from './types';
import {
  QUIZ_QUESTIONS,
  AUDIO_INTERMISSION_DATA,
  TESTIMONIALS_DATA
} from './data/funnelData';
import { Header } from './components/Header';
import { Footer } from './components/Footer';
import { Button } from './components/Button';
import { OptionCard } from './components/OptionCard';

/*
 * As telas que vêm DEPOIS do hero, cada uma no seu pedaço.
 *
 * O mesmo raciocínio da tela da oferta, logo abaixo: o celular que acabou de
 * chegar pelo anúncio precisa ver a primeira tela, e só ela. O tocador de vídeo,
 * o de áudio, a análise e os formulários de outros fluxos entravam todos no
 * primeiro download — para telas que aparecem minutos depois, ou que aquela
 * pessoa talvez nunca veja.
 *
 * Todos são pré-carregados em segundo plano assim que a pessoa sai do hero, e o
 * `Suspense` que envolve as telas cobre o intervalo. Aparência inalterada.
 */
const CadastroRapido = lazy(() => import('./components/CadastroRapido').then((m) => ({ default: m.CadastroRapido })));
const PedidoDeOracao = lazy(() => import('./components/PedidoDeOracao').then((m) => ({ default: m.PedidoDeOracao })));
const TransicaoBencaos = lazy(() => import('./components/TransicaoBencaos').then((m) => ({ default: m.TransicaoBencaos })));
const AudioPlayer = lazy(() => import('./components/AudioPlayer').then((m) => ({ default: m.AudioPlayer })));
const VideoPlayer = lazy(() => import('./components/VideoPlayer').then((m) => ({ default: m.VideoPlayer })));
import { HeroScreen } from './components/HeroScreen';
import { LoadingScreen } from './components/LoadingScreen';

/*
 * A TELA DA OFERTA CHEGA DEPOIS — e o celular não baixa ela na entrada.
 *
 * Ela é a parte mais pesada do site: puxa o checkout inteiro, os painéis de PIX
 * e de boleto, a prova social e o desenhador de QR Code. Nada disso aparece
 * antes da nona pergunta, mas tudo isso vinha no primeiro carregamento — de
 * graça para quem abandona no meio do quiz, e caro para quem chega pelo anúncio
 * num 4G ruim, porque é tela branca com o clique já pago.
 *
 * O `lazy` sozinho traria um problema novo: a pessoa terminaria o quiz e ficaria
 * esperando o download começar ali, no pior momento. Por isso o pedaço é
 * PRÉ-CARREGADO em segundo plano assim que a primeira tela aparece (ver o efeito
 * `useEffect` de pré-carga, abaixo). Quando ela chega na oferta, já está pronto.
 *
 * Nada muda na aparência: é o mesmo componente, no mesmo lugar, com a mesma
 * animação de entrada.
 */
const OfferScreen = lazy(() =>
  import('./components/OfferScreen').then((modulo) => ({ default: modulo.OfferScreen })),
);
import { capaAtiva } from './lib/capa';
import { gravarCadastroRapido, lerCadastroRapido } from './lib/cadastroRapido';
import { rastrear } from './lib/rastreio';
import { temPedidoGuardado } from './lib/pedidoGuardado';
import { carregarWistia } from './lib/wistia';

export default function App() {
  // Funnel Flow Index:
  // 0: Hero welcome screen
  // 1-6: Quiz Questions q1 to q6
  // 7: Audio Intermission screen
  // 8-10: Quiz Questions q7 to q9
  // 11: Testimonials screen
  // 12: Loading / Calculation screen
  // 13: Final VSL Offer screen
  /**
   * ?tela=<n> abre o funil direto naquela etapa, para conferir uma tela sem
   * responder o quiz inteiro antes. 13 é a oferta. Só vale para quem digita a
   * URL: quem chega pelo anúncio começa do zero, como sempre.
   */
  const [funnelStepIndex, setFunnelStepIndex] = useState<number>(() => {
    // Mesmo cuidado do ?cta: get() devolve null e Number(null) e 0. Aqui o
    // resultado por acaso coincide com o padrao, mas depender de coincidencia
    // e como o ?cta quebrou o funil inteiro.
    const bruto = new URLSearchParams(window.location.search).get('tela');
    const pedida = bruto === null || bruto.trim() === '' ? Number.NaN : Number(bruto);
    if (Number.isInteger(pedida) && pedida >= 0 && pedida <= 13) return pedida;

    /*
     * Quem tem pedido em aberto volta para o pagamento, nao para a primeira
     * pergunta.
     *
     * O PIX tira a pessoa do site: ela copia o codigo, abre o app do banco e
     * volta -- e no celular a aba costuma ser descartada nesse meio-tempo. O
     * passo do funil nao e persistido, entao ate aqui essa volta caia no hero,
     * e concluir o pagamento exigia responder as nove perguntas de novo. Nao e
     * exagero dizer que ninguem fazia isso: e o abandono acontecendo DEPOIS de
     * a pessoa ja ter decidido comprar e digitado o CPF.
     *
     * So vale para quem tem pedido guardado. Quem chega pelo anuncio nunca tem,
     * e comeca do zero como sempre. O ?tela= continua vencendo, porque e a
     * ferramenta de conferir tela.
     */
    if (temPedidoGuardado()) return 13;
    /*
     * Fluxo direto (`/pedido`): quem já entregou o pedido neste navegador e
     * recarregou não volta ao formulário — vai à análise e daí à VSL. Sem
     * isto o refresh mostraria o hero padrão, que este fluxo nem tem.
     */
    if (capaAtiva() === 'pedido-direto' && lerCadastroRapido()?.pedidoEnviado === true) return 12;
    return 0;
  });
  const [selectedAnswers, setSelectedAnswers] = useState<Record<string, QuizOption>>({});

  /*
   * FLUXO CURTO (experimento de 14/08/2026, só para a capa "dinheiro").
   *
   * Quem chega pelo anúncio do dinheiro não responde o quiz: capa -> nome e
   * data de nascimento -> análise de merecimento -> oferta. A aposta do dono é
   * que, para essa dor, a verificação personalizada ("Maria, você foi
   * escolhida") vale mais que as nove perguntas. As outras capas seguem no
   * quiz completo — este interruptor não toca nelas.
   *
   * `mostrandoCadastro` vive FORA do índice de telas: o cadastro ocupa o
   * lugar do hero (índice 0), então todo o resto — tema escuro, rastreio,
   * rodapé — continua valendo sem ganhar um número novo de tela.
   */
  const [fluxoCurto] = useState(() => capaAtiva() === 'dinheiro');
  const [mostrandoCadastro, setMostrandoCadastro] = useState(false);

  /*
   * FLUXO DO PEDIDO (experimento local de 15/08/2026, ideia do dono): capa
   * "peça e será dado" -> tela onde a pessoa ESCREVE ou GRAVA o pedido e
   * deixa nome, e-mail e WhatsApp -> quiz completo. Diferente do fluxo curto,
   * aqui o quiz continua; o que muda é que o contato e o pedido nascem antes
   * dele. Só para a capa "pedido"; nada mais é tocado.
   */
  const [fluxoDoPedido] = useState(() => capaAtiva() === 'pedido');
  /*
   * FLUXO DIRETO (`/pedido` ou `?capa=pedido-direto`, 15/08/2026): a tela do
   * pedido É a primeira tela, com o Arcanjo atrás; entregou o pedido -> análise
   * -> VSL. Sem capa, sem transição, sem quiz. É a variação mais curta para os
   * criativos novos; nenhuma campanha antiga aponta para cá.
   */
  const [fluxoDireto] = useState(() => capaAtiva() === 'pedido-direto');
  // No fluxo direto a tela do pedido abre já na primeira pintura — a menos que
  // a pessoa já tenha pedido neste navegador (refresh): aí não há o que pedir.
  const [mostrandoPedido, setMostrandoPedido] = useState(
    () => capaAtiva() === 'pedido-direto' && lerCadastroRapido()?.pedidoEnviado !== true,
  );
  /*
   * A tela "seu pedido foi enviado" entre o pedido e o quiz. E o nome fica
   * em estado para ela usar sem reler o armazenamento a cada render.
   */
  const [mostrandoTransicao, setMostrandoTransicao] = useState(false);
  const [nomeDoPedido, setNomeDoPedido] = useState(() => lerCadastroRapido()?.nome ?? '');

  /*
   * Quem já entregou o pedido neste navegador e recarregou a página não pede
   * de novo (viraria lead duplicado no banco e pediria à pessoa que reescreva
   * o que já escreveu). Cai direto na transição, de onde segue ao quiz.
   */
  const [jaPediu] = useState(() => lerCadastroRapido()?.pedidoEnviado === true);

  const concluirPedidoDeOracao = (dados: { nome: string; email: string; telefone: string; pedido: string; temAudio: boolean }) => {
    gravarCadastroRapido({
      nome: dados.nome,
      nascimento: '',
      email: dados.email,
      telefone: dados.telefone,
      pedido: dados.pedido,
      pedidoEnviado: true,
    });
    setNomeDoPedido(dados.nome);
    /*
     * O contato vira Lead agora — é o momento em que passamos a ter e-mail e
     * telefone de alguém que ainda pode não comprar, e é isso que o Meta e a
     * recuperação precisam. O pedido escrito vai como "resposta" da sessão,
     * na mesma tabela das respostas do quiz: é dali que sai o remarketing.
     */
    rastrear('Lead', { step: 1, contato: { nome: dados.nome, email: dados.email, telefone: dados.telefone } });
    /*
     * O contato vai DENTRO da resposta, como JSON, e não só no `contato` do
     * evento: a rota /track repassa `contato` ao Meta e não grava no banco
     * (por desenho — é rota pública). A tabela do funil só guarda
     * pergunta+resposta, e é dela que o painel lê. Empacotar aqui evita
     * mexer no esquema da tabela e na rota pública por causa de uma tela em
     * teste. O painel (rota /admin/pedidos-de-oracao) desempacota.
     */
    rastrear('EtapaDoFunil', {
      step: 1,
      contato: { nome: dados.nome, email: dados.email, telefone: dados.telefone },
      resposta: {
        pergunta: 'Pedido de oração',
        escolha: JSON.stringify({
          nome: dados.nome.slice(0, 60),
          email: dados.email.slice(0, 60),
          tel: dados.telefone.slice(0, 15),
          pedido: (dados.pedido || (dados.temAudio ? '[áudio gravado]' : '')).slice(0, 400),
        }).slice(0, 600),
      },
    });
    setMostrandoPedido(false);
    if (fluxoDireto) {
      // Direto para a análise ("Analisando o Merecimento de Maria...") e daí
      // para a VSL — o quiz não existe neste fluxo.
      setFunnelStepIndex(12);
      return;
    }
    setMostrandoTransicao(true);
    // A tela de transição deixa rastro próprio: sem isto o painel não
    // saberia quantos viram "seu pedido foi enviado" e não seguiram.
    rastrear('EtapaDoFunil', { step: 1, resposta: { pergunta: 'Tela', escolha: 'transicao_bencaos' } });
  };

  const seguirDaTransicaoParaOQuiz = () => {
    setMostrandoTransicao(false);
    setFunnelStepIndex(1);
  };

  const concluirCadastroRapido = (nome: string, nascimento: string) => {
    gravarCadastroRapido({ nome, nascimento });
    /*
     * O rastro da tela: sem isto, o painel veria as sessões do fluxo curto
     * pularem do hero direto para a análise, e "quantos preencheram o nome"
     * não teria resposta. Vai como etapa 1 — no fluxo curto ela é a única
     * tela entre a capa e a análise, o equivalente funcional da pergunta 1.
     */
    rastrear('EtapaDoFunil', { step: 1, contato: { nome } });
    setMostrandoCadastro(false);
    setFunnelStepIndex(12);
  };

  /*
   * O navegador não decide mais onde a página abre.
   *
   * Por padrão ele guarda a posição da rolagem e a restaura no recarregamento —
   * comportamento certo num site de páginas, e errado aqui: o funil é uma URL
   * só, e a etapa em que a pessoa estava não é a mesma coisa que a altura em
   * que ela tinha parado. Quem voltava do app do banco reabria a página no meio
   * do checkout, abaixo da mensagem escrita justamente para recebê-la.
   *
   * Precisa rodar antes da primeira pintura, daí o `useState` em vez de um
   * `useEffect`: o efeito só correria depois de o navegador já ter rolado.
   */
  useState(() => {
    if (typeof window !== 'undefined' && 'scrollRestoration' in window.history) {
      window.history.scrollRestoration = 'manual';
    }
  });

  // Auto scroll to top on step change
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [funnelStepIndex]);

  /*
   * Os players de vídeo começam a baixar quando a pessoa sai do hero.
   *
   * Antes vinham em quatro tags no <head>, todas na tela 0 — e o primeiro
   * vídeo só aparece na tela 11. Quem desistia no quiz pagava 60 kB e quatro
   * conexões de terceiro por vídeo nenhum, no celular, na rede da operadora.
   *
   * Aqui há folga de sobra: da primeira pergunta até o primeiro vídeo são seis
   * telas e 52 s de áudio. E quem abre direto na oferta (?tela=13) já entra com
   * o índice acima de zero, então pede na mesma hora.
   */
  useEffect(() => {
    if (funnelStepIndex > 0) carregarWistia();
  }, [funnelStepIndex]);

  /*
   * A tela da oferta é baixada em segundo plano, pela mesma lógica do Wistia
   * acima: quem saiu do hero vai chegar lá, e daqui até lá há seis telas e 52 s
   * de áudio — tempo de sobra até numa rede ruim.
   *
   * `requestIdleCallback` para o download não disputar com o que está na tela
   * agora: ele espera o navegador ficar ocioso. Onde ele não existe (Safari mais
   * antigo, comum neste público), um `setTimeout` curto faz o mesmo papel.
   *
   * Falhar aqui não quebra nada: se a pré-carga não acontecer, o `lazy` baixa
   * na hora de mostrar, que é o comportamento normal dele.
   */
  useEffect(() => {
    if (funnelStepIndex === 0) return;
    const puxar = () => {
      void import('./components/OfferScreen');
      void import('./components/AudioPlayer');
      void import('./components/VideoPlayer');
      void import('./components/TransicaoBencaos');
      void import('./components/PedidoDeOracao');
      void import('./components/CadastroRapido');
    };
    const ocioso = (window as unknown as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
    if (ocioso) {
      ocioso(puxar);
      return;
    }
    const relogio = window.setTimeout(puxar, 1200);
    return () => window.clearTimeout(relogio);
  }, [funnelStepIndex]);

  /*
   * Marcos do funil enviados ao Meta e ao nosso painel.
   *
   * Só as três etapas que dizem alguma coisa: chegou, terminou o quiz, viu a
   * oferta. Mandar uma por pergunta encheria a tabela sem responder nada que
   * "quantos chegaram na VSL" já não responda.
   *
   * O conjunto de já enviados existe porque o botão "Voltar" faz a pessoa
   * passar de novo pela mesma etapa — e uma visita não pode virar duas no
   * relatório. Ele também dá conta do StrictMode, que roda todo efeito duas
   * vezes em desenvolvimento.
   */
  const marcosEnviados = useRef<Set<number>>(new Set());
  useEffect(() => {
    if (marcosEnviados.current.has(funnelStepIndex)) return;
    marcosEnviados.current.add(funnelStepIndex);

    if (funnelStepIndex === 0) {
      rastrear('PageView', { step: 0 });
    } else if (funnelStepIndex === 12) {
      rastrear('CompleteRegistration', { step: 12 });
    } else if (funnelStepIndex === 13) {
      rastrear('ViewContent', { step: 13, contentIds: ['main'] });
    } else {
      /*
       * As telas do meio — perguntas, áudio e depoimentos — passaram a deixar
       * rastro, e é o que permite a aba Funil dizer em QUAL pergunta as pessoas
       * desistem.
       *
       * Isto contraria a escolha anterior deste arquivo, que mandava três
       * marcos e mais nada com a justificativa de que uma etapa por pergunta
       * "encheria a tabela sem responder nada". A justificativa valia enquanto
       * a única pergunta era "quantos chegaram na VSL". Ela deixou de valer no
       * instante em que o dono quis saber onde o dinheiro do anúncio evapora:
       * entre entrar e terminar o quiz existem onze telas, e sem evento nenhum
       * elas são um buraco só. Não dá para consertar a tela que espanta a
       * pessoa sem antes saber qual é.
       *
       * O custo é conhecido e limitado: são eventos `EtapaDoFunil`, que ficam
       * no nosso banco e NÃO vão ao Meta (ver SO_NOSSOS em src/lib/rastreio.ts),
       * sem valor em dinheiro e sem dado de contato. Uma visita que percorre o
       * funil inteiro passa de 6 para 17 requisições curtas; uma que desiste na
       * segunda pergunta gera três.
       *
       * O `Set` acima garante uma por etapa por sessão: o botão "Voltar" faz a
       * pessoa repassar pelas mesmas telas, e cada passagem repetida contaria
       * como gente nova parando ali.
       */
      rastrear('EtapaDoFunil', { step: funnelStepIndex });
    }
  }, [funnelStepIndex]);

  // Helper calculation for progress bar percentage
  const getProgressPercent = (): number => {
    if (funnelStepIndex === 0) return 0; // Hero
    if (funnelStepIndex >= 1 && funnelStepIndex <= 6) {
      // Questions 1 to 6
      return Math.round((funnelStepIndex / 12) * 100);
    }
    if (funnelStepIndex === 7) return 78; // Audio intermission
    if (funnelStepIndex >= 8 && funnelStepIndex <= 10) {
      // Questions 7 to 9
      return Math.round((funnelStepIndex / 12) * 100);
    }
    if (funnelStepIndex === 11) return 98; // Testimonials
    return 100; // Loading & Offer
  };

  // Helper to handle quiz option selection
  const handleSelectOption = (questionId: string, option: QuizOption) => {
    setSelectedAnswers((prev) => ({ ...prev, [questionId]: option }));

    /*
     * A passagem pela etapa vai para o servidor no instante em que ela acontece.
     *
     * Guardar só no fim do quiz não resolveria: quem desiste na pergunta 3 é
     * exatamente quem interessa medir, e essa pessoa nunca chega ao fim.
     *
     * SÓ A ETAPA, nunca o texto.
     *
     * Até 21/08/2026 este evento levava o texto literal da pergunta e da opção
     * escolhida. Eram respostas sobre medo, dinheiro, inveja e fé, gravadas ao
     * lado de nome, e-mail, telefone e IP — um dossiê pessoal dentro da tabela
     * de analytics, para responder uma pergunta ("onde as pessoas desistem")
     * que o número da etapa responde sozinho.
     *
     * `step` continua indo, e é ele que o painel usa para montar o caminho de
     * quem abandonou. O que se perde é o recorte por OPÇÃO escolhida; o que se
     * ganha é não guardar a intimidade de quem só respondeu um quiz.
     */
    rastrear('EtapaDoFunil', {
      step: funnelStepIndex,
    });

    // Smooth transition to next step after brief tactile feedback
    setTimeout(() => {
      setFunnelStepIndex((prev) => prev + 1);
    }, 280);
  };

  // Handle Back Navigation
  const handleGoBack = () => {
    if (funnelStepIndex > 0) {
      setFunnelStepIndex((prev) => prev - 1);
    }
  };

  // Reset Funnel
  const handleReset = () => {
    setSelectedAnswers({});
    setFunnelStepIndex(0);
  };

  /*
   * As duas telas do tema "Sacred Shield": o hero e o processamento antes da
   * VSL. As duas são de sangria total e fundo preto, então saem do container de
   * max-w-md e trocam o fundo da página inteira — inclusive o da barra do
   * navegador em celular, que herda a cor do <html>.
   */
  // A tela do pedido de oração NÃO é de sangria: é um cartão como o do
  // checkout, na paleta do tema — por isso sai da regra do hero mesmo estando
  // no índice 0.
  // No fluxo direto a tela do pedido tem o anjo atrás e É escura, como o hero.
  const telaEscura = (funnelStepIndex === 0 && (!mostrandoPedido || fluxoDireto)) || funnelStepIndex === 12;

  /*
   * A tela 12 é a única que não rola: ela cabe inteira na janela e some sozinha
   * em ~5 s. `min-h-screen` usa 100vh, que no Chrome do Android ignora a barra
   * de endereço e sobra alguns pixels — o bastante para a página ganhar uma
   * rolagem de 60px que não leva a lugar nenhum e faz a análise tremer no dedo.
   * Aqui a altura é svh, a que desconta a barra.
   */
  const telaSemRolagem = funnelStepIndex === 12;

  /*
   * Fora das telas 0 e 12 o container não tem cor de fundo própria: quem pinta
   * é o <body> (src/index.css). No tema escuro é ele que carrega o céu, e um
   * fundo opaco aqui taparia a nebulosa inteira.
   */
  return (
    <LazyMotion features={domAnimation}>
    <div
      className={`relative flex flex-col font-sans selection:bg-ouro/20 overflow-x-hidden ${
        telaSemRolagem ? 'h-[100svh] overflow-y-hidden' : 'min-h-screen'
      } ${telaEscura ? 'bg-[#131313] text-[#e5e2e1]' : 'text-texto'}`}
    >
      {/* Design System Header with progress bar */}
      <Header
        progressPercent={getProgressPercent()}
        showProgress={funnelStepIndex > 0 && funnelStepIndex < 12}
      />

      {/* Main Container */}
      <main
        className={
          telaEscura
            ? 'flex-1 flex flex-col'
            : 'flex-1 flex flex-col justify-center items-center py-6 px-4'
        }
      >
        <div className={telaEscura ? 'w-full flex-1 flex flex-col' : 'w-full max-w-md sm:max-w-lg mx-auto'}>
          {/*
            Voltar e Reiniciar do quiz. Os dois têm 44px de altura mínima e
            recuo lateral: o texto segue discreto, mas a área que responde ao
            toque para de ser um alvo de 16px, onde o dedo erra mais do que
            acerta. O -mx compensa o recuo para o alinhamento não mudar.
          */}
          {funnelStepIndex > 0 && funnelStepIndex < 12 && (
            <div className="mb-4 flex items-center justify-between -mx-2">
              <button
                onClick={handleGoBack}
                className="inline-flex items-center gap-1 px-2 min-h-[44px] text-xs font-semibold text-suave hover:text-texto transition-colors cursor-pointer"
              >
                <ChevronLeft className="w-4 h-4" />
                <span>Voltar</span>
              </button>

              <button
                onClick={handleReset}
                className="inline-flex items-center gap-1 px-2 min-h-[44px] text-[13px] font-medium text-suave/80 hover:text-texto transition-colors cursor-pointer"
                title="Reiniciar funil"
              >
                <RotateCcw className="w-3 h-3" />
                <span>Reiniciar</span>
              </button>
            </div>
          )}

          {/*
            O `Suspense` cobre TODAS as telas de uma vez, e o vazio como espera é
            deliberado: cada pedaço já foi baixado em segundo plano antes de a
            pessoa chegar nele, então este estado quase nunca acontece. Quando
            acontece — conexão que caiu no meio —, um piscar de vazio informa
            menos errado que um "carregando" que aparece e some, que faz a pessoa
            achar que travou e tocar de novo.
          */}
          <Suspense fallback={null}>
          <AnimatePresence mode="wait">
            {/* SCREEN 0: HERO WELCOME SCREEN */}
            {funnelStepIndex === 0 && !mostrandoCadastro && !mostrandoPedido && !mostrandoTransicao && (
              <m.div
                key="hero"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12 }}
                transition={{ duration: 0.4 }}
                className="flex-1 flex flex-col"
              >
                <HeroScreen
                  onStart={() => {
                    if (fluxoCurto) setMostrandoCadastro(true);
                    // Já pediu neste navegador: pula o formulário, vai à transição.
                    else if (fluxoDoPedido && jaPediu) setMostrandoTransicao(true);
                    else if (fluxoDoPedido) setMostrandoPedido(true);
                    else setFunnelStepIndex(1);
                  }}
                />
              </m.div>
            )}

            {/* FLUXO DO PEDIDO: "SEU PEDIDO FOI ENVIADO" — a transição para o quiz */}
            {funnelStepIndex === 0 && mostrandoTransicao && (
              <m.div
                key="transicao_bencaos"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12 }}
                transition={{ duration: 0.4 }}
                className="flex-1 flex flex-col"
              >
                <TransicaoBencaos nome={nomeDoPedido} onContinuar={seguirDaTransicaoParaOQuiz} />
              </m.div>
            )}

            {/* FLUXO DO PEDIDO: NOME + E-MAIL + WHATSAPP + O PEDIDO, ANTES DO QUIZ */}
            {funnelStepIndex === 0 && mostrandoPedido && (
              <m.div
                key="pedido_de_oracao"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12 }}
                transition={{ duration: 0.4 }}
                className="flex-1 flex flex-col"
              >
                <PedidoDeOracao onConcluir={concluirPedidoDeOracao} comAnjoAtras={fluxoDireto} />
              </m.div>
            )}

            {/* FLUXO CURTO: NOME + NASCIMENTO NO LUGAR DO QUIZ */}
            {funnelStepIndex === 0 && mostrandoCadastro && (
              <m.div
                key="cadastro_rapido"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12 }}
                transition={{ duration: 0.4 }}
                className="flex-1 flex flex-col"
              >
                <CadastroRapido onConcluir={concluirCadastroRapido} />
              </m.div>
            )}

            {/* SCREEN 1 - 6: QUIZ QUESTIONS PART 1 */}
            {funnelStepIndex >= 1 && funnelStepIndex <= 6 && (
              <m.div
                key={`quiz_step_${funnelStepIndex}`}
                initial={{ opacity: 0, x: 16 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -16 }}
                transition={{ duration: 0.25 }}
                className="space-y-6"
              >
                {/* Question Header */}
                <div className="space-y-2 text-left">
                  <h2 className="font-sans font-semibold text-xl sm:text-2xl text-texto leading-snug">
                    {QUIZ_QUESTIONS[funnelStepIndex - 1].question}
                  </h2>
                </div>

                {/* Options List */}
                <div className="space-y-3">
                  {QUIZ_QUESTIONS[funnelStepIndex - 1].options.map((option) => (
                    <OptionCard
                      key={option.id}
                      option={option}
                      isSelected={selectedAnswers[QUIZ_QUESTIONS[funnelStepIndex - 1].id]?.id === option.id}
                      onSelect={(opt) => handleSelectOption(QUIZ_QUESTIONS[funnelStepIndex - 1].id, opt)}
                      hasImageThumbnail={QUIZ_QUESTIONS[funnelStepIndex - 1].hasImageThumbnails}
                    />
                  ))}
                </div>
              </m.div>
            )}

            {/* SCREEN 7: AUDIO INTERMISSION */}
            {funnelStepIndex === 7 && (
              <m.div
                key="audio_intermission"
                initial={{ opacity: 0, scale: 0.97 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.97 }}
                transition={{ duration: 0.3 }}
                className="space-y-6 text-left"
              >
                {/* Headline Copy */}
                <div className="space-y-3">
                  <h2 className="font-sans font-semibold text-xl sm:text-2xl text-texto leading-snug whitespace-pre-line">
                    {AUDIO_INTERMISSION_DATA.headlineText}
                  </h2>
                </div>

                {/* Custom Audio Player Component */}
                <AudioPlayer onEnded={() => {}} />

                {/* Continue CTA Button */}
                <Button 
                  onClick={() => setFunnelStepIndex(8)}
                  variant="primary"
                  fullWidth
                >
                  {AUDIO_INTERMISSION_DATA.ctaText}
                </Button>
              </m.div>
            )}

            {/* SCREEN 8 - 10: QUIZ QUESTIONS PART 2 */}
            {funnelStepIndex >= 8 && funnelStepIndex <= 10 && (
              <m.div
                key={`quiz_step_${funnelStepIndex}`}
                initial={{ opacity: 0, x: 16 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -16 }}
                transition={{ duration: 0.25 }}
                className="space-y-6"
              >
                {/* Question Header */}
                <div className="space-y-2 text-left">
                  <h2 className="font-sans font-semibold text-xl sm:text-2xl text-texto leading-snug">
                    {QUIZ_QUESTIONS[funnelStepIndex - 2].question}
                  </h2>
                </div>

                {/* Options List */}
                <div className="space-y-3">
                  {QUIZ_QUESTIONS[funnelStepIndex - 2].options.map((option) => (
                    <OptionCard
                      key={option.id}
                      option={option}
                      isSelected={selectedAnswers[QUIZ_QUESTIONS[funnelStepIndex - 2].id]?.id === option.id}
                      onSelect={(opt) => handleSelectOption(QUIZ_QUESTIONS[funnelStepIndex - 2].id, opt)}
                    />
                  ))}
                </div>
              </m.div>
            )}

            {/* SCREEN 11: TESTIMONIALS / SOCIAL PROOF */}
            {funnelStepIndex === 11 && (
              <m.div
                key="testimonials"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12 }}
                transition={{ duration: 0.3 }}
                className="space-y-6 text-left"
              >
                {/* Headline Copy with Highlighted text */}
                <div className="space-y-2">
                  <h2 className="font-sans font-semibold text-lg sm:text-xl text-texto leading-snug">
                    Muitas pessoas também duvidaram no começo. Até fazerem a oração e perceberem que{" "}
                    <span className="text-destaque font-bold underline decoration-destaque/30">
                      {TESTIMONIALS_DATA.highlightText}
                    </span>{" "}
                    e começaram a relatar isso:
                  </h2>
                </div>

                {/* Video Testimonials Grid */}
                <div className="grid grid-cols-2 gap-3.5">
                  {TESTIMONIALS_DATA.videos.slice(0, 2).map((video) => (
                    <VideoPlayer key={video.id} testimonial={video} />
                  ))}
                </div>

                {/* CTA Button */}
                <Button 
                  onClick={() => setFunnelStepIndex(12)}
                  variant="primary"
                  fullWidth
                >
                  {TESTIMONIALS_DATA.ctaText}
                </Button>
              </m.div>
            )}

            {/* SCREEN 12: LOADING / CALCULATION */}
            {funnelStepIndex === 12 && (
              <m.div
                key="loading"
                initial={{ opacity: 0, scale: 0.97 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.97 }}
                transition={{ duration: 0.25 }}
              >
                <LoadingScreen onComplete={() => setFunnelStepIndex(13)} />
              </m.div>
            )}

            {/* SCREEN 13: FINAL VSL / OFFER SCREEN */}
            {funnelStepIndex === 13 && (
              <m.div
                key="offer"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4 }}
              >
                <OfferScreen />
              </m.div>
            )}
          </AnimatePresence>
          </Suspense>
        </div>
      </main>

      {/*
        A tela 12 é a única sem rodapé. Ela ocupa a altura toda com a análise
        acontecendo e some sozinha em ~5 s — uma faixa de copyright ali só
        empurraria o astrolábio para fora do enquadramento no celular.
      */}
      {funnelStepIndex !== 12 && <Footer tema={telaEscura ? 'escuro' : 'claro'} />}
    </div>
    </LazyMotion>
  );
}
