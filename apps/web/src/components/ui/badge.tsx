import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium tracking-wide uppercase",
  {
    variants: {
      variant: {
        neutral: "border-white/10 bg-white/[0.05] text-muted-foreground",
        live: "border-success/35 bg-success/10 text-success",
        warn: "border-warning/35 bg-warning/10 text-warning",
        danger: "border-danger/35 bg-danger/10 text-danger",
        accent: "border-accent/40 bg-accent/10 text-accent",
      },
    },
    defaultVariants: { variant: "neutral" },
  },
);

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

/** A small pulsing status dot, for anything genuinely live. */
export function Dot({ className }: { className?: string }) {
  return (
    <span className={cn("relative flex size-1.5", className)}>
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-60" />
      <span className="relative inline-flex size-1.5 rounded-full bg-current" />
    </span>
  );
}
