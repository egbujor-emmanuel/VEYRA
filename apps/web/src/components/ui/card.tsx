import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The glassy panel. Border contrast is deliberately low -- the card should read as a pane of
 * tinted glass over the gradient ground, not as a boxed-in container with a drawn outline.
 */
export const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "glass rounded-[14px] border border-white/[0.08] shadow-[0_1px_0_oklch(1_0_0/0.06)_inset,0_20px_50px_-24px_oklch(0_0_0/0.8)]",
        className,
      )}
      {...props}
    />
  ),
);
Card.displayName = "Card";

export const CardHeader = ({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("px-6 pt-6 pb-4", className)} {...p} />
);
export const CardTitle = ({ className, ...p }: React.HTMLAttributes<HTMLHeadingElement>) => (
  <h3 className={cn("text-display text-lg text-foreground", className)} {...p} />
);
export const CardDescription = ({ className, ...p }: React.HTMLAttributes<HTMLParagraphElement>) => (
  <p className={cn("mt-1.5 text-sm leading-relaxed text-muted-foreground", className)} {...p} />
);
export const CardContent = ({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("px-6 pb-6", className)} {...p} />
);
export const CardFooter = ({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex items-center gap-3 border-t border-white/[0.06] px-6 py-4", className)} {...p} />
);
