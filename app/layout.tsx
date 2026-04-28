import type { Metadata } from "next";
import { Manrope, Mulish, Roboto } from "next/font/google";
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

const roboto = Roboto({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-system",
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "Fort Inside — Yuri Fortes",
  description: "Mapa da Sua Próxima Construção",
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
