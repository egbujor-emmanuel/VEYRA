/**
 * The VEYRA mark.
 *
 * It replaces a plain blue rounded square containing the letter "v", which read as a placeholder
 * because that is what it was. A marketplace people are asked to hand custody decisions to cannot
 * look like it was assembled from a default.
 *
 * The mark is a V built from two strokes that converge on a single point, with a node sitting at
 * the vertex: many candidate strategies evaluated down to one selected decision, which is exactly
 * what the arena does. It is drawn rather than lettered, so it works at 20px in a nav bar and at
 * favicon size without turning to mush.
 */
export function Logo({ size = 28, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="veyra-mark" x1="4" y1="2" x2="28" y2="30" gradientUnits="userSpaceOnUse">
          <stop stopColor="oklch(0.86 0.15 92)" />
          <stop offset="1" stopColor="oklch(0.72 0.155 74)" />
        </linearGradient>
      </defs>

      {/* Rounded field, low-contrast so the strokes carry the identity rather than a coloured tile. */}
      <rect x="0.75" y="0.75" width="30.5" height="30.5" rx="9" fill="oklch(0.18 0.012 80)" />
      <rect
        x="0.75"
        y="0.75"
        width="30.5"
        height="30.5"
        rx="9"
        stroke="oklch(1 0 0 / 0.12)"
        strokeWidth="1.5"
      />

      {/* The two converging strokes. */}
      <path
        d="M9 9.5 L16 21 L23 9.5"
        stroke="url(#veyra-mark)"
        strokeWidth="2.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* The selected outcome, at the point everything converges on. */}
      <circle cx="16" cy="23.6" r="2.15" fill="oklch(0.84 0.155 88)" />
    </svg>
  );
}
