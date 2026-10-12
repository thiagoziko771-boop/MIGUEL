import { QuizQuestion, TestimonialVideo } from '../types';

export const HERO_DATA = {
  /*
   * EXPERIMENTO LOCAL (14/08/2026, ainda não publicado): a capa perdia 3 de
   * cada 4 cliques pagos (26% clique→quiz contra 53% do tráfego geral), e a
   * hipótese principal é quebra de promessa: todos os anúncios ativos dizem
   * "OUÇA a mensagem/o recado de Miguel", e a capa respondia "Descubra".
   *
   * A versão nova fecha o laço do anúncio (a mensagem JÁ ESTÁ PRONTA, o botão
   * é OUVIR) e diz o custo antes do clique (9 perguntas, 2 minutos) — o que
   * quem tem medo de cadastro precisa ler para entrar. A citação bíblica
   * saiu do caminho do botão: ver HeroScreen.tsx.
   *
   * A versão anterior, publicada até aqui:
   *   headerTitle: "Essa é a resposta que você pediu em oração."
   *   subtitle:    "Descubra qual mensagem o Arcanjo Miguel tem para sua vida hoje."
   *   ctaText:     "Descobrir agora"
   */
  // Caixa alta e baixa, não versal: o hero agora usa Libre Caslon a 48px, e
  // caixa alta nesse tamanho estoura para cinco linhas em tela de 360px.
  headerTitle: "Sua mensagem do Arcanjo Miguel está pronta.",
  // Sem contar perguntas (pedido do dono, 14/08): anunciar "9 perguntas"
  // vende trabalho; o comando direto com o tempo vende alívio.
  subtitle: "Toque no botão e responda com fé. Leva menos de 2 minutos.",
  ctaText: "Ouvir a minha mensagem",
  quote: "Peçam, e será dado; busquem, e encontrarão.",
  citation: "Lucas 11:9",
  imageUrl: "/images/arcanjo-hero.webp", // Arcanjo Miguel com escudo e espada
  customAngelImage: "https://images.unsplash.com/photo-1519817650390-64a93db51149?auto=format&fit=crop&q=80&w=1000"
};

/**
 * Uma capa para cada anúncio (pedido do dono, 14/08/2026).
 *
 * O clique num anúncio é uma promessa; a capa é o cumprimento. Título e botão
 * de cada variante ESPELHAM a arte do anúncio correspondente — quem toca em
 * "OUÇA A MENSAGEM DE MIGUEL" precisa reencontrar essas mesmas palavras aqui,
 * ou a página parece outra loja. Era o vazamento nº 1 do tráfego pago: 26% de
 * clique→quiz contra 53% do tráfego geral.
 *
 * Quem escolhe a variante é `capaAtiva()` (src/lib/capa.ts), lendo o
 * `utm_content` que o carimbo dos anúncios já carrega — nenhum anúncio foi
 * tocado para isso. A citação bíblica muda junto: cada dor tem o seu salmo.
 */
/*
 * 'pedido'        = capa -> tela do pedido -> "enviado" -> quiz -> análise -> VSL
 * 'pedido-direto' = a TELA DO PEDIDO É A PRIMEIRA (anjo atrás) -> análise -> VSL
 *                   (sem capa separada, sem transição, sem quiz — pedido do dono
 *                   em 15/08/2026 para os criativos novos)
 */
export type CapaVariante = 'padrao' | 'dinheiro' | 'madrugada' | 'inveja' | 'pedido' | 'pedido-direto';

export interface TextosDaCapa {
  headerTitle: string;
  subtitle: string;
  ctaText: string;
  quote: string;
  citation: string;
}

export const HERO_VARIANTES: Record<CapaVariante, TextosDaCapa> = {
  padrao: {
    headerTitle: HERO_DATA.headerTitle,
    subtitle: HERO_DATA.subtitle,
    ctaText: HERO_DATA.ctaText,
    quote: HERO_DATA.quote,
    citation: HERO_DATA.citation,
  },
  // Anúncio: "O DINHEIRO ENTRA… E SOME?" / botão "OUÇA A MENSAGEM DE MIGUEL"
  // Copy ditada pelo dono (14/08): chamado de destino ("você não chegou aqui
  // por acaso") + promessa de abundância e prosperidade — não diagnóstico.
  // O título fica só com o chamado porque a 48px ele já ocupa duas linhas;
  // a promessa inteira mora no subtítulo, que é a linha grande e clara.
  dinheiro: {
    headerTitle: "Você não chegou aqui por acaso.",
    subtitle: "Miguel vai trazer abundância financeira e prosperidade para a sua vida. Toque e ouça a mensagem dele — leva 2 minutos.",
    ctaText: "Ouvir a mensagem de Miguel",
    quote: "Peçam, e será dado; busquem, e encontrarão.",
    citation: "Lucas 11:9",
  },
  // Anúncio: "VOCÊ ACORDA DE MADRUGADA SEM MOTIVO?" / botão "OUÇA O RECADO DELE AGORA"
  madrugada: {
    headerTitle: "Existe um motivo para você acordar de madrugada.",
    subtitle: "O recado de Miguel para você já está pronto. Toque e ouça com fé — leva 2 minutos.",
    ctaText: "Ouvir o recado agora",
    quote: "Não dormitará aquele que te guarda.",
    citation: "Salmo 121:3",
  },
  // EXPERIMENTO LOCAL 15/08/2026 (ideia do dono): reciprocidade explícita —
  // "peça e será dado". Depois da capa vem a tela do PEDIDO (nome, e-mail,
  // WhatsApp e o pedido escrito ou gravado), e só então o quiz.
  pedido: {
    headerTitle: "O que você tanto pede em oração, Miguel vai te dar agora.",
    subtitle: "Faça o seu pedido a ele e responda com fé. Leva menos de 2 minutos.",
    ctaText: "Fazer o meu pedido a Miguel",
    quote: "Peça, e lhe será dado.",
    citation: "Lucas 11:9",
  },
  // 'pedido-direto' não tem capa: os textos abaixo só existem para o tipo
  // fechar; a primeira tela é a do pedido (PedidoDeOracao com fundo do anjo).
  'pedido-direto': {
    headerTitle: "O que você tanto pede em oração, Miguel vai te dar agora.",
    subtitle: "Faça o seu pedido a ele. Leva menos de 2 minutos.",
    ctaText: "Fazer o meu pedido a Miguel",
    quote: "Peça, e lhe será dado.",
    citation: "Lucas 11:9",
  },
  // Anúncio: "SENTE QUE ALGO SEGURA A SUA VIDA?" / botão "RECEBA A ORAÇÃO DE PROTEÇÃO"
  inveja: {
    headerTitle: "A oração que corta o que segura a sua vida está pronta.",
    subtitle: "Toque no botão e responda com fé. Leva menos de 2 minutos.",
    ctaText: "Receber a oração de proteção",
    quote: "Nenhum mal te sucederá.",
    citation: "Salmo 91:10",
  },
};

export const QUIZ_QUESTIONS: QuizQuestion[] = [
  {
    id: "q1",
    stepNumber: 1,
    progressPercent: 11,
    question: "Se você pudesse pedir uma intervenção urgente do Arcanjo Miguel hoje, para qual área seria?",
    hasImageThumbnails: true,
    options: [
      {
        id: "q1_op1",
        text: "Proteção para minha família",
        imageUrl: "/images/quiz-protecao.webp"
      },
      {
        id: "q1_op2",
        text: "Desbloqueio financeiro",
        imageUrl: "/images/quiz-financeiro.webp"
      },
      {
        id: "q1_op3",
        text: "Chuva de bênçãos",
        imageUrl: "/images/quiz-bencaos.webp"
      },
      {
        id: "q1_op4",
        text: "Quebra do mal e das tentações",
        imageUrl: "https://images.unsplash.com/photo-1518057111178-44a106bad636?auto=format&fit=crop&q=80&w=300"
      }
    ]
  },
  {
    id: "q2",
    stepNumber: 2,
    progressPercent: 22,
    question: "Como está sua relação com o dinheiro hoje?",
    options: [
      {
        id: "q2_op1",
        text: "O dinheiro entra e sai mas nunca sobra nada..",
        icon: "💸"
      },
      {
        id: "q2_op2",
        text: "Estou afogado em dívidas..",
        icon: "😰"
      },
      {
        id: "q2_op3",
        text: "Tenho apenas o básico.. mas sinto que mereço e posso muito mais.",
        icon: "😳"
      },
      {
        id: "q2_op4",
        text: "Estou no fundo do poço.. desempregado e sem perspectiva alguma.",
        icon: "😭"
      }
    ]
  },
  {
    id: "q3",
    stepNumber: 3,
    progressPercent: 33,
    question: "Você sente que, por mais que se esforce as coisas não melhoram?",
    options: [
      {
        id: "q3_op1",
        text: "Faço tudo que está ao meu alcance mas as coisas parecem que nunca dão certo pra mim..",
        icon: "🤯"
      },
      {
        id: "q3_op2",
        text: "Muitas vezes sim..",
        icon: "😓"
      },
      {
        id: "q3_op3",
        text: "As coisas estão melhorando.. mas sinto que preciso de uma ajuda superior..",
        icon: "😳"
      },
      {
        id: "q3_op4",
        text: "Agora sei que estou no caminho certo e que tudo vai prosperar..",
        icon: "😌"
      }
    ]
  },
  {
    id: "q4",
    stepNumber: 4,
    progressPercent: 44,
    question: "Você teme pela segurança de alguém que você ama?",
    options: [
      {
        id: "q4_op1",
        text: "Meus filhos",
        icon: "👨‍👩‍👧‍👦"
      },
      {
        id: "q4_op2",
        text: "Meu cônjuge, parceiro(a)",
        icon: "👫"
      },
      {
        id: "q4_op3",
        text: "Meus pais.. familiares..",
        icon: "👨‍👩‍👦"
      },
      {
        id: "q4_op4",
        text: "Muitas pessoas próximas dependem de mim..",
        icon: "😔"
      }
    ]
  },
  {
    id: "q5",
    stepNumber: 5,
    progressPercent: 55,
    question: "Você acredita que existem pessoas que te invejam ou te desejam mal?",
    options: [
      {
        id: "q5_op1",
        text: "Sim.. e sei exatamente quem são",
        icon: "🚪"
      },
      {
        id: "q5_op2",
        text: "Eu sinto que sim.. e isso atrapalha minha vida. Mas não sei quem são",
        icon: "❌"
      },
      {
        id: "q5_op3",
        text: "Deus tem me falado para me afastar de certas pessoas..",
        icon: "🙏"
      },
      {
        id: "q5_op4",
        text: "Não posso afirmar..",
        icon: "😑"
      }
    ]
  },
  {
    id: "q6",
    stepNumber: 6,
    progressPercent: 66,
    question: "Nos últimos dias ou semanas, você teve algum desses sinais?",
    options: [
      {
        id: "q6_op1",
        text: "Sonhos estranhos e muito vívidos..",
        icon: "💤"
      },
      {
        id: "q6_op2",
        text: "Acordar de madrugada sem motivo e não conseguir voltar a dormir..",
        icon: "😰"
      },
      {
        id: "q6_op3",
        text: "Sensação de algo está tentando te avisar..",
        icon: "💭"
      },
      {
        id: "q6_op4",
        text: "Coincidências e sincronicidades",
        icon: "🌀"
      }
    ]
  },
  {
    id: "q7",
    stepNumber: 7,
    progressPercent: 88,
    question: "Você está disposto(a) a seguir as orientações sagradas para receber suas bênçãos?",
    options: [
      {
        id: "q7_op1",
        text: "Com toda certeza sim.. farei tudo que for preciso!!!",
        icon: "🤗"
      },
      {
        id: "q7_op2",
        text: "Sim.. estou pronto para mudar de vida!!!!",
        icon: "🥰"
      },
      {
        id: "q7_op3",
        text: "Esperei muito por esse momento..",
        icon: "😊"
      },
      {
        id: "q7_op4",
        text: "Sim.. não aguento mais sofrer",
        icon: "😔"
      }
    ]
  },
  {
    id: "q8",
    stepNumber: 8,
    progressPercent: 94,
    question: "Se você receber a Oração do Arcanjo Miguel, você se compromete a fazê-la com fé?",
    options: [
      {
        id: "q8_op1",
        text: "Sim.. prometo fazer diariamente",
        icon: "🙏"
      },
      {
        id: "q8_op2",
        text: "Estou aprendendo a criar intimidade com o Senhor, mas farei o que for necessário",
        icon: "🚪"
      },
      {
        id: "q8_op3",
        text: "Não sei se tenho tempo..",
        icon: "😟"
      }
    ]
  },
  {
    id: "q9",
    stepNumber: 9,
    progressPercent: 97,
    question: "Você está pronto(a) para receber suas bênçãos AGORA?",
    options: [
      {
        id: "q9_op1",
        text: "Sim..",
        icon: "😃"
      },
      {
        id: "q9_op2",
        text: "Com certeza..",
        icon: "🤩"
      }
    ]
  }
];

export const AUDIO_INTERMISSION_DATA = {
  headlineText: "Nada disso é coincidência..\nDeus tem preparado algo grandioso para transformar a sua vida.\nE mandou Miguel para te instruir..",
  speakerName: "Irmã Maria",
  audioTitle: "Mensagem do Arcanjo Miguel para seu momento de vida",
  /*
   * Duração real do arquivo em public/mensagem-arcanjo-miguel.mp3. Fica aqui só
   * como registro: quem mostra o tempo na tela é o próprio elemento <audio>, que
   * lê do arquivo. Antes dizia "1:00" enquanto a gravação tem 52 s.
   */
  duration: "0:52",
  ctaText: "Continuar",
  avatarUrl: "https://images.unsplash.com/photo-1544005313-94ddf0286df2?auto=format&fit=crop&q=80&w=200"
};

export const TESTIMONIALS_DATA = {
  headlineText: "Muitas pessoas também duvidaram no começo. Até fazerem a oração e perceberem que não era uma oração comum e começaram a relatar isso:",
  highlightText: "não era uma oração comum",
  ctaText: "Continuar",
  videos: [
    {
      id: "test_1",
      author: "Maria Helena, 28 anos",
      title: "Cura e Paz na Família",
      duration: "0:27",
      thumbnailUrl: "https://images.unsplash.com/photo-1544005313-94ddf0286df2?auto=format&fit=crop&q=80&w=500",
      avatarUrl: "https://images.unsplash.com/photo-1544005313-94ddf0286df2?auto=format&fit=crop&q=80&w=150",
      quote: "Depois da 3ª oração, meu filho voltou pra casa e as brigas cessaram. Foi um milagre do Arcanjo!",
      wistiaMediaId: "sc2zwew6dx"
    },
    {
      id: "test_2",
      author: "Dona Neide, 64 anos",
      title: "Desbloqueio Financeiro",
      duration: "0:52",
      thumbnailUrl: "https://images.unsplash.com/photo-1508214751196-bcfd4ca60f91?auto=format&fit=crop&q=80&w=500",
      avatarUrl: "https://images.unsplash.com/photo-1508214751196-bcfd4ca60f91?auto=format&fit=crop&q=80&w=150",
      quote: "Consegui quitar a dívida da minha casa que parecia impossível em menos de 15 dias de devoção.",
      wistiaMediaId: "31rfb4n9yd"
    },
    {
      id: "test_3",
      author: "Antônio Carlos, 61 anos",
      title: "Proteção Espiritual Absoluta",
      duration: "0:41",
      thumbnailUrl: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&q=80&w=500",
      avatarUrl: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&q=80&w=150",
      quote: "Sentia um peso no peito todas as noites. Hoje durmo na paz do Senhor e sinto o manto de Miguel me cobrindo."
    }
  ] as TestimonialVideo[]
};

/*
 * A tela de processamento foi redesenhada em 10/08/2026 e passou a mostrar
 * quatro verificações curtas, escritas dentro do próprio componente
 * (VERIFICACOES, em src/components/LoadingScreen.tsx). Saíram daqui:
 *
 *   imageUrl      apontava para /images/arcanjo-loading.webp, que a tela não
 *                 usa mais — o lugar dela é do astrolábio desenhado em CSS.
 *                 O arquivo continua em public/, sem ninguém pedindo.
 *   loadingSteps  as cinco frases longas que rodavam uma a uma.
 *
 * Ficaram só os dois campos que a tela realmente lê. Manter os outros aqui
 * seria pior que apagá-los: quem quisesse mudar o texto da tela editaria
 * `loadingSteps`, publicaria, e nada mudaria.
 */
export const LOADING_DATA = {
  title: "Analisando seu Merecimento...",
  subtitle: "Sua oração está sendo preparada e consagrada para sua vida.",
};

export const OFFER_DATA = {
  /*
   * Segundos de tela aberta antes de o botão de compra aparecer. Zero deixa
   * sempre visível.
   *
   * 242 s = 4 min 2 s, o ponto do vídeo em que a oferta e o preço são ditos.
   *
   * O número vem da VSL 97ib3ki0q3 ("VSL 47", 382 s), que por sua vez herdou da
   * hof9trznru ("VECEDORA") em 09/08/2026 — as duas tinham a mesma duração e o
   * dono confirmou que o preço era falado no mesmo ponto. Antes eram 226 s.
   *
   * CONFIRMADO PELO DONO em 13/08/2026, para a VSL atual (a78m863q0a, "VLS
   * CERTA ESCALA"): é aos 4 min 2 s que o vídeo faz a chamada para a ação e diz
   * o preço de R$ 47. O botão nasce no mesmo instante em que a pessoa termina
   * de ouvir quanto custa — que é exatamente o que este número existe para
   * garantir.
   *
   * Ficou aqui a nota de que o valor era "herdado sem medição nova", e ela
   * envelheceu mal: virou motivo para desconfiar de um número certo. Quem
   * auditar o funil daqui a três meses precisa ler que ESTE PONTO ESTÁ
   * CASADO COM O VÍDEO, e que a conta a refazer é outra — quanta gente
   * continua assistindo até lá.
   *
   * ESTE NÚMERO ACOMPANHA O VÍDEO, não a preferência de quem mexe. Encurtar por
   * achar a espera longa faz o botão aparecer antes de o preço ser dito: quem
   * clica nessa janela chega ao checkout sem saber quanto custa, e desiste lá.
   * Se a edição do vídeo mudar, meça de novo onde o preço é falado e ajuste.
   *
   * Vale testar variações quando houver tráfego para comparar: segurar mais
   * costuma reduzir quem chega no checkout e aumentar a proporção dos que
   * compram; soltar antes faz o contrário.
   */
  segundosAteOCta: 242,
  badgeTitle: "Parabéns!",
  badgeSubtitle: "Entre milhares... você foi um dos selecionados.",
  headline: "A oração secreta do Arcanjo Miguel foi liberada para você.",
  subheadline: "Para destravar bênçãos financeiras e curas inexplicáveis em apenas 24 horas.",
  videoCaption: "SUA ORAÇÃO PERSONALIZADA",
  ctaText: "Garantir Minha Oração Sagrada Agora",
  secondaryCtaText: "Acessar Oração do Arcanjo Miguel",
  originalPrice: "R$ 197,00",
  offerPrice: "R$ 47,00",
  guaranteeText: "Garantia incondicional de 30 dias com devolução integral sem perguntas",
  securityNotes: "Acesso Imediato • Pagamento 100% Seguro • Ambiente Criptografado",
  writtenTestimonials: [
    {
      name: "Teresinha de Jesus",
      city: "Belo Horizonte - MG",
      avatarUrl: "https://images.unsplash.com/photo-1567532939604-b6b5b0db2604?auto=format&fit=crop&q=80&w=200",
      text: "Fiz a oração hoje de manhã e às 15h recebi a notícia de que minha aposentadoria foi liberada sem nenhum atraso. Louvado seja Deus e o Arcanjo Miguel!",
      time: "Há 12 minutos",
      stars: 5
    },
    {
      name: "Geraldo Magela",
      city: "São Paulo - SP",
      avatarUrl: "https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?auto=format&fit=crop&q=80&w=200",
      text: "Minha família estava desmoronando por causa de inveja. Quando comecei essa oração sagrada, a paz voltou pro meu lar imediatamente.",
      time: "Há 28 minutos",
      stars: 5
    },
    {
      name: "Maria das Graças",
      city: "Fortaleza - CE",
      avatarUrl: "https://images.unsplash.com/photo-1544005313-94ddf0286df2?auto=format&fit=crop&q=80&w=200",
      text: "Chorei de emoção ao escutar a voz e as palavras dessa oração. Senti um calor no peito e uma paz que há anos eu não sentia.",
      time: "Há 45 minutos",
      stars: 5
    },
    {
      name: "Francisca Oliveira",
      city: "Salvador - BA",
      avatarUrl: "https://images.unsplash.com/photo-1508214751196-bcfd4ca60f91?auto=format&fit=crop&q=80&w=200",
      text: "Eu estava desesperada com problemas de saúde na família. Depois de 3 dias rezando a oração sagrada, os exames voltaram normais!",
      time: "Há 1 hora",
      stars: 5
    }
  ]
};

export const DOWNSELL_DATA = {
  badgeTitle: "🙏 ESPERE! UMA ÚLTIMA BÊNÇÃO PARA VOCÊ",
  headline: "Que tal levar apenas o essencial por um valor simbólico?",
  subheadline: "Entendemos o seu momento. Por isso, liberamos a Versão Essencial do Aplicativo Espiritual com um desconto final — só nesta tela.",
  productTitle: "Aplicativo Espiritual — Versão Essencial",
  /*
   * A âncora é o preço real do upsell, que é exatamente o que a pessoa acabou
   * de recusar na tela anterior — e não um número solto. Se o upsell mudar de
   * preço em server/catalog.ts, esta âncora e o selo abaixo têm de mudar junto,
   * senão a tela passa a prometer um desconto que não existe.
   *
   * Hoje: 47,00 → 19,00 = 59,6% de desconto (o upsell caiu para R$ 47,00 em
   * 17/08/2026, e esta âncora caiu junto).
   */
  originalPrice: "R$ 47,00",
  // O gateway recusa cobrança abaixo de R$ 10,00; este valor está acima disso.
  offerPrice: "R$ 19,00",
  discountLabel: "59% DE DESCONTO EXTRA",
  ctaText: "SIM! QUERO A VERSÃO ESSENCIAL POR APENAS R$ 19,00",
  rejectText: "Não, obrigado. Quero finalizar apenas com a Oração principal.",
  reassuranceNote: "Este é o menor valor que conseguimos liberar. Essa oferta não aparecerá novamente.",
  features: [
    {
      title: "Rotina Diária de Oração no Celular",
      description: "A Oração do Arcanjo Miguel e sua rotina sagrada de proteção sempre à mão, todos os dias."
    },
    {
      title: "Lembretes de Devoção",
      description: "Notificações diárias para você nunca esquecer seu momento com Deus."
    },
    {
      title: "Mesma Garantia de 30 Dias",
      description: "Sinta a transformação ou receba 100% do seu dinheiro de volta, sem burocracia."
    }
  ]
};

export const UPSELL_DATA = {
  badgeTitle: "📱 OFERTA ESPECIAL DE UPSELL",
  headline: "Aplicativo Espiritual com Rotina Diária & Tutorial em Vídeo",
  subheadline: "Acesse o Aplicativo Espiritual com sua Rotina Sagrada Diária + Vídeo Tutorial Passo a Passo de Instalação.",
  /*
   * A âncora precisa ficar ACIMA do preço, sempre. Quando o upsell subiu para
   * R$ 97,00 ela ainda era R$ 97,00 — a tela teria mostrado "de R$ 97,00 por
   * R$ 97,00", anunciando um desconto de zero por cento com cara de oferta.
   * Hoje: 297,00 → 47,00 = 84,2% de desconto. O preço caiu de R$ 97 para R$ 47
   * em 17/08/2026 — ver o porquê em server/catalog.ts, no item `upsell`.
   */
  originalPrice: "R$ 297,00",
  offerPrice: "R$ 47,00",
  reassuranceNote: "Fique 100% tranquilo: O vídeo tutorial de instalação é entregue logo após a confirmação. É muito simples de instalar e acessar!",
  features: [
    {
      title: "Aplicativo Espiritual Completo",
      description: "Sua rotina diária de orações sagradas, áudios de bênçãos e oração do Arcanjo Miguel na palma da sua mão."
    },
    {
      title: "Vídeo Tutorial Passo a Passo de Instalação",
      description: "Não se preocupe com tecnologia! Você receberá um vídeo curto e direto ensinando exatamente como instalar e usar o app no seu celular."
    },
    {
      title: "Rotina Diária de Oração & Proteção",
      description: "Guia diário para momentos de afligimento, abertura de caminhos financeiros e paz na família."
    },
    {
      title: "Garantia Total de 30 Dias",
      description: "Sinta a transformação no seu lar ou receba 100% do seu dinheiro de volta sem burocracia."
    }
  ]
};
