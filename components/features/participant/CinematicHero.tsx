import { ReactNode } from "react";
import { cn } from "@/lib/utils";

// Yuri Fortes brandbook hero — Sand background + Manrope giant typography.
// Replaces the old image-based cinematic hero. No photos.

interface Props {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  children?: ReactNode;
  className?: string;
  /** "default" full-page hero | "compact" smaller for split layouts (quiz) */
  variant?: "default" | "compact";
}

export function CinematicHero({
  eyebrow,
  title,
  subtitle,
  children,
  className,
  variant = "default",
}: Props) {
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
