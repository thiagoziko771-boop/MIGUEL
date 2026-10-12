import { CATALOG } from './catalog.js';
import { logger } from './logger.js';
import { repositorioDoPainel, type TipoEntrega } from './painel/repositorio.js';

export interface DeliverableContent {
  itemId: string;
  title: string;
  description: string;
  url: string | null;
  tipo: TipoEntrega;
}

/**
 * O que cada produto entrega depois do pagamento confirmado.
 *
 * A fonte da verdade é a tabela de entregas, editável pelo painel: trocar um
 * link não pode exigir deploy, porque o produto muda mais rápido que o código.
 * As variáveis DELIVERY_URL_* continuam valendo como valor inicial, para nada
 * quebrar em quem ainda não abriu o painel.
 */
const DESCRIPTIONS: Record<string, string> = {
  main: 'Áudio completo da Oração Sagrada do Arcanjo Miguel, preparada a partir das suas respostas.',
  salmos_150: 'Livro digital com os 150 Salmos de proteção e libertação, em PDF.',
  vela_7dias: 'Confirmação da consagração do seu nome na Vela Sagrada de 7 dias.',
  upsell: 'Acesso ao Aplicativo Espiritual completo + vídeo tutorial de instalação.',
  downsell: 'Acesso à Versão Essencial do Aplicativo Espiritual.',
};

export async function getDeliverables(itemIds: string[]): Promise<DeliverableContent[]> {
  /*
   * Contribuição voluntária não entrega nada — é acréscimo à mesma Oração.
   * Deixá-la passar daqui a transformaria num "produto pago sem link de
   * entrega" no aviso do log e num cartão vermelho no painel, pedindo ao dono
   * uma providência que não existe.
   */
  const unicos = [...new Set(itemIds)].filter((itemId) => CATALOG[itemId] && CATALOG[itemId].kind !== 'contribuicao');
  if (unicos.length === 0) return [];

  let entregas;
  try {
    entregas = await repositorioDoPainel().listarEntregas();
  } catch (erro) {
    // A entrega não pode depender do painel estar de pé: caindo aqui, o cliente
    // ainda recebe o que estiver nas variáveis de ambiente.
    logger.error('Falha ao ler os links de entrega; usando as variáveis de ambiente', {
      erro: (erro as Error).message,
    });
    entregas = null;
  }

  return unicos
    .map((itemId) => {
      const item = CATALOG[itemId];
      const configurado = entregas?.find((entrega) => entrega.itemId === itemId);

      // Item desativado no painel simplesmente não aparece para o cliente.
      if (configurado && !configurado.ativo) return null;

      const url = configurado?.url || (process.env[`DELIVERY_URL_${itemId.toUpperCase()}`] ?? '').trim();
      const tipo = configurado?.tipo ?? 'arquivo';

      // Serviço não tem link para entregar: a confirmação é a entrega.
      if (!url && tipo !== 'servico') {
        logger.warn('Produto pago sem link de entrega configurado', { itemId });
      }

      return {
        itemId,
        title: configurado?.nome || item.title,
        description: DESCRIPTIONS[itemId] ?? item.title,
        url: url || null,
        tipo,
      } satisfies DeliverableContent;
    })
    .filter((conteudo): conteudo is DeliverableContent => conteudo !== null);
}
