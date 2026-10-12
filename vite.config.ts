import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

/**
 * Na Vercel, /admin, /leads e /obg viram os .html correspondentes por rewrite
 * (vercel.json). O servidor de desenvolvimento não lê esse arquivo, então este
 * plugin reproduz o mesmo caminho: sem ele, a URL do painel seria diferente em
 * desenvolvimento e em produção.
 *
 * A /obg entrou aqui junto: ela é o endereço de conversão do Google Ads, e um
 * endereço que só existe em produção é um endereço que ninguém testa antes de
 * anunciar.
 */
function urlsLimpasDoPainel() {
  const paginas: Record<string, string> = {
    '/admin': '/admin.html',
    '/leads': '/leads.html',
    '/obg': '/obg.html',
  };
  return {
    name: 'urls-limpas-do-painel',
    configureServer(servidor: { middlewares: { use: (fn: (req: any, _res: any, next: () => void) => void) => void } }) {
      servidor.middlewares.use((req, _res, next) => {
        const caminho = (req.url ?? '').split('?')[0];
        const destino = paginas[caminho.replace(/\/$/, '')];
        if (destino) req.url = destino;
        next();
      });
    },
  };
}

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), urlsLimpasDoPainel()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify - file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
      // Em desenvolvimento o frontend e o backend rodam em portas diferentes;
      // o proxy mantem as chamadas na mesma origem e evita CORS.
      proxy: {
        '/api': {
          target: `http://localhost:${process.env.PORT ?? 3333}`,
          changeOrigin: true,
        },
      },
    },
  };
});
