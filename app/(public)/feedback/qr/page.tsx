import QRCodeImport from "qrcode";
import { Logo } from "@/components/ui/Logo";

// `qrcode` ships sem types — TS infere assinatura errada. Cast explícito.
interface QRCodeApi {
  toString(
    text: string,
    options?: {
      type?: "svg" | "utf8" | "terminal";
      margin?: number;
      errorCorrectionLevel?: "L" | "M" | "Q" | "H";
      color?: { dark?: string; light?: string };
      width?: number;
    }
  ): Promise<string>;
}
const QRCode = QRCodeImport as unknown as QRCodeApi;

// Página pra projetar / mostrar na TV ao final da imersão.
// QR aponta pra /feedback. Server component — gera SVG no build/render.

const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ?? "https://fort-inside.vercel.app";
const FEEDBACK_URL = `${APP_URL}/feedback`;

export const metadata = {
  title: "Avalie a imersão · Fort Inside",
  description: "QR Code para enviar feedback da imersão Fort Inside",
};

export default async function FeedbackQRPage() {
  // SVG cru — escala 100%, sem perda. Cores do brandbook (charcoal sobre sand).
  const svg = await QRCode.toString(FEEDBACK_URL, {
    type: "svg",
    margin: 1,
    errorCorrectionLevel: "M",
    color: {
      dark: "#232323",
      light: "#FFFFFF00",
    },
  });

  return (
    <main className="min-h-screen bg-background flex flex-col items-center justify-center px-6 py-12">
      <div className="max-w-xl w-full flex flex-col items-center text-center space-y-10">
        <Logo size="lg" className="opacity-90" />

        <div className="space-y-3">
          <p className="text-xs uppercase tracking-[0.3em] text-muted-foreground font-display">
            Imersão Fort Inside
          </p>
          <h1 className="font-display text-5xl md:text-6xl text-foreground font-bold tracking-tight leading-[1.05]">
            Avalie a imersão
          </h1>
          <p className="text-muted-foreground font-body text-base md:text-lg leading-relaxed max-w-md mx-auto">
            Aponte a câmera do celular para o código abaixo.
          </p>
        </div>

        <div
          className="bg-white rounded-2xl p-6 md:p-8 shadow-sm border border-border w-full max-w-sm aspect-square flex items-center justify-center"
          aria-label="QR Code para /feedback"
          // SVG inline — escala automática
          dangerouslySetInnerHTML={{ __html: svg }}
        />

        <div className="space-y-1.5">
          <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground font-display">
            ou abra direto
          </p>
          <p className="font-body text-foreground text-sm md:text-base break-all">
            {FEEDBACK_URL.replace(/^https?:\/\//, "")}
          </p>
        </div>
      </div>
    </main>
  );
}
