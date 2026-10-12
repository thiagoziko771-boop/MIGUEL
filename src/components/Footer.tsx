import React from 'react';

interface FooterProps {
  /**
   * `escuro` acompanha o hero (tela 0), que é de sangria total e fundo preto.
   * Um rodapé claro logo abaixo da arte cortaria a tela em duas e entregaria a
   * borda do container justo onde o design quer profundidade.
   */
  tema?: 'claro' | 'escuro';
}

export const Footer: React.FC<FooterProps> = ({ tema = 'claro' }) => {
  if (tema === 'escuro') {
    return (
      <footer className="relative z-20 w-full mt-auto py-8 px-6 bg-[#0e0e0e] border-t border-[#4d4635]/20 text-center">
        <p className="font-work font-semibold text-sm text-[#d0c5af] tracking-[0.03em]">
          © 2026 Rezas Sagradas | Todos os direitos reservados
        </p>
      </footer>
    );
  }

  return (
    // Sem cor de fundo: herda a do <body>, e no tema escuro deixa o céu passar.
    <footer className="w-full mt-auto py-6 px-4 border-t border-borda text-center">
      <div className="max-w-md mx-auto space-y-3">
        {/* Mandatory Copy string */}
        <p className="text-xs text-suave font-sans tracking-wide">
          © 2026 Rezas Sagradas | Todos os direitos reservados
        </p>
      </div>
    </footer>
  );
};
