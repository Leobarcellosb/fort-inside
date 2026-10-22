import type { Metadata } from "next";
import { Manrope, Mulish, Poppins, Roboto } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";
import { cn } from "@/lib/utils";

// Yuri Fortes brandbook fonts — Manrope (display) + Mulish (body) via Google Fonts.
// Sohne Breit + Avenir Next official files come later; class names stay stable.
const manrope = Manrope({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-display",
  weight: ["200", "300", "400", "500", "600", "700", "800"],
});

const mulish = Mulish({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-body",
  weight: ["300", "400", "500", "600", "700", "800"],
});

// MARCO ZERO: Avenir Next com Poppins atrás.
//
// Avenir Next é fonte de sistema da Apple: existe no iPhone e no Mac, NÃO existe
// no Android nem no Windows, e é licenciada -- não dá para servir como webfont.
// Metade de uma sala de 50 jovens está em Android, então deixá-la sozinha na
// pilha significaria metade das pessoas caindo num fallback qualquer do sistema.
//
// Poppins é a de baixo porque é a que o próprio material do Marco Zero usa, e é
// geométrica como a Avenir Next -- quem tem iPhone vê a fonte da marca, quem não
// tem vê a fonte do site do evento. Nenhum dos dois vê uma fonte estranha.
const poppins = Poppins({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-marco-zero",
  weight: ["300", "400", "500", "600", "700"],
});

const roboto = Roboto({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-system",
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  // O nome que o participante ve na aba e na previa do WhatsApp. "Fort Inside"
  // era o produto antigo (pedido do dono: o que circula e "Marco Zero").
  title: "Marco Zero · Geração Preparada",
  description: "Movimento Geração Preparada",
  icons: { icon: "/icon.png" },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="pt-BR"
      className={cn(
        "h-full",
        manrope.variable,
        mulish.variable,
        poppins.variable,
        roboto.variable,
        "font-body"
      )}
    >
      <body className="min-h-full flex flex-col bg-background text-foreground">
        {children}
        <Toaster richColors position="top-center" />
      </body>
    </html>
  );
}
