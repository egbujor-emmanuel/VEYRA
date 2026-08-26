// Ports renderArenaPage.ts's badge() function to React. One canonical place this renders
// anywhere in the app -- every OBSERVED/DERIVED/SUPPLIED/SIMULATED tag uses this component.
export type Provenance = "OBSERVED" | "DERIVED" | "SUPPLIED" | "SIMULATED";

export function ProvenanceBadge({ tier }: { tier: Provenance }) {
  return <span className={`tag tag-${tier.toLowerCase()}`}>{tier}</span>;
}
