import Image from "next/image";
import { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { CINEMATIC_BLUR_DATA_URL } from "@/lib/cinematic-map";

// Cinematic hero — full-bleed image background + dark overlay + Manrope
// typography on top. When `imageSrc` is omitted the hero falls back to the
// Sand brandbook treatment (used by PrognosticView for reading screens).

interface Props {
  imageSrc?: string;
  imageAlt?: string;
  eyebrow?: string;
  title: string;
  subtitle?: string;
  children?: ReactNode;
  className?: string;
  /** "default" full hero | "compact" smaller for split layouts (quiz) */
  variant?: "default" | "compact";
}

export function CinematicHero({
  imageSrc,
  imageAlt = "",
  eyebrow,
  title,
  subtitle,
  children,
  className,
  variant = "default",
}: Props) {
  // Sand fallback when no image — used by reading screens (prognostic).
  if (!imageSrc) {
    return (
      <section
        className={cn(
          "bg-secondary px-6",
          variant === "default" ? "py-24 md:py-32" : "py-16 md:py-20",
          className
        )}
      >
        <div className="max-w-3xl mx-auto text-center space-y-6">
          {eyebrow && (
            <p className="text-xs uppercase tracking-[0.3em] text-muted-foreground font-display">
              {eyebrow}
            </p>
          )}
          <h1
            className={cn(
              "font-display text-foreground font-bold tracking-tight leading-[1.05]",
              variant === "default" ? "text-6xl md:text-8xl" : "text-5xl md:text-7xl"
            )}
          >
            {title}
          </h1>
          {subtitle && (
            <p className="text-base md:text-lg text-muted-foreground font-body">
              {subtitle}
            </p>
          )}
          {children}
        </div>
      </section>
    );
  }

  // Cinematic image variant — full bleed, dark overlay, white type.
  return (
    <section
      className={cn(
        "relative w-full overflow-hidden",
        variant === "default"
          ? "h-[70vh] min-h-[500px]"
          : "h-[42vh] min-h-[320px]",
        className
      )}
    >
      <Image
        src={imageSrc}
        alt={imageAlt}
        fill
        priority
        sizes="100vw"
        placeholder="blur"
        blurDataURL={CINEMATIC_BLUR_DATA_URL}
        className="object-cover"
      />
      <div className="absolute inset-0 bg-black/55" aria-hidden />
      <div className="relative z-10 h-full flex flex-col items-center justify-center px-6">
        <div className="max-w-3xl mx-auto text-center space-y-6">
          {eyebrow && (
            <p className="text-xs uppercase tracking-[0.3em] text-white/85 font-display">
              {eyebrow}
            </p>
          )}
          <h1
            className={cn(
              "font-display text-white font-bold tracking-tight leading-[1.05]",
              variant === "default"
                ? "text-6xl md:text-8xl"
                : "text-5xl md:text-7xl"
            )}
          >
            {title}
          </h1>
          {subtitle && (
            <p className="text-base md:text-lg text-white/85 font-body">
              {subtitle}
            </p>
          )}
          {children}
        </div>
      </div>
    </section>
  );
}
