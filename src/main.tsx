import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import {capturarAtribuicao} from './lib/attribution';

/*
 * A captura da origem, antes do render.
 *
 * Precisa acontecer na primeira carga porque é a única em que a URL ainda tem
 * os parâmetros do anúncio: quem recarrega volta para a tela 1 e chega aqui com
 * a URL já limpa.
 *
 * AQUI SUBIAM O PIXEL DO META E O DO TIKTOK, removidos em 21/08/2026. O funil
 * deixou de mandar evento para plataforma de anúncio; a mensuração passou a ser
 * inteiramente própria, pelo `POST /api/track` e pela tabela `conversoes`. A
 * captura de origem continua idêntica — inclusive `fbclid` e `ttclid`, que
 * seguem sendo guardados para análise nossa.
 */
capturarAtribuicao();

/*
 * O funil é escuro por padrão desde 10/08/2026 — a paleta "Sacred Shield", a
 * mesma das telas de abertura e de processamento. Quem liga isso é o
 * data-tema="escuro" que já vem no index.html, para valer antes da primeira
 * pintura.
 *
 * ?tema=claro devolve a versão clara anterior. Ela existe por um motivo
 * prático: se o escuro converter pior, dá para comparar as duas na mesma
 * máquina, no mesmo minuto, sem publicar nada. A paleta clara inteira continua
 * viva em src/index.css.
 */
if (new URLSearchParams(window.location.search).get('tema') === 'claro') {
  delete document.documentElement.dataset.tema;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
