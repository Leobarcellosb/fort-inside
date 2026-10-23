import Image from "next/image";
import { cn } from "@/lib/utils";
import { MARCA } from "@/lib/marca";

type Size = "sm" | "md" | "lg" | "xl";

interface Props {
  size?: Size;
  className?: string;
  alt?: string;
}

const SIZES: Record<Size, number> = {
  sm: 24,
  md: 40,
  lg: 64,
  xl: 120,
};

export function Logo({ size = "md", className, alt = MARCA }: Props) {
  const dimension = SIZES[size];
  return (
    <Image
      src="/logo-yuri.png"
      alt={alt}
      width={dimension}
      height={dimension}
      className={cn("object-contain", className)}
      priority
    />
  );
}
