import Image from "next/image";
import { CINEMATIC_BLUR_DATA_URL } from "@/lib/cinematic-map";
import { cn } from "@/lib/utils";

type Overlay = "light" | "medium" | "heavy";
type Height = "full" | "split";

interface CinematicHeroProps {
  image: string;
  alt: string;
  children?: React.ReactNode;
  overlay?: Overlay;
  priority?: boolean;
  height?: Height;
  /** Extra classes for the outer container */
  className?: string;
  /** Extra classes for the foreground content wrapper */
  contentClassName?: string;
}

const OVERLAY_CLASSES: Record<Overlay, string> = {
  light: "bg-gradient-to-t from-black/70 via-black/30 to-transparent",
  medium: "bg-gradient-to-t from-black/90 via-black/50 to-black/20",
  heavy: "bg-gradient-to-t from-black/95 via-black/70 to-black/40",
};

export function CinematicHero({
  image,
  alt,
  children,
  overlay = "medium",
  priority = true,
  height = "full",
  className,
  contentClassName,
}: CinematicHeroProps) {
  const isSplit = height === "split";

  return (
    <section
      className={cn(
        "relative w-full overflow-hidden",
        isSplit ? "h-[40vh] min-h-[280px]" : "min-h-screen",
        className
      )}
      aria-label={alt}
    >
      {/* Image layer — fills the section. Fade-in via `animate-hero-fade`. */}
      <div className="absolute inset-0 motion-safe:animate-hero-fade">
        <Image
          src={image}
          alt={alt}
          fill
          priority={priority}
          sizes="100vw"
          placeholder="blur"
          blurDataURL={CINEMATIC_BLUR_DATA_URL}
          className="object-cover"
        />
      </div>

      {/* Dark gradient overlay for text legibility */}
      <div
        aria-hidden
        className={cn("absolute inset-0 pointer-events-none", OVERLAY_CLASSES[overlay])}
      />

      {/* Foreground content */}
      <div
        className={cn(
          "relative z-10 flex flex-col h-full",
          isSplit
            ? "justify-end px-6 pb-6 pt-10 min-h-[280px]"
            : "justify-end min-h-screen px-6 pb-12 pt-20",
          contentClassName
        )}
      >
        {children}
      </div>
    </section>
  );
}
