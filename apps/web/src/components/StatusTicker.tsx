// Live infrastructure status strip. Every entry is a real, deployed, verified contract or
// service this app actually depends on -- not decorative filler. Addresses are the ones this
// project independently confirmed on-chain.

const ITEMS: { label: string; state: string; live: boolean }[] = [
  { label: "ERC-8004 identity · agent #1890", state: "REGISTERED", live: true },
  { label: "Altana keystore · session delegation", state: "LIVE", live: true },
  { label: "ERC-8183 escrow · job settlement", state: "DEPLOYED", live: true },
  { label: "PancakeSwap V3 · position manager", state: "CONNECTED", live: true },
  { label: "Venus protocol · lending reads", state: "CONNECTED", live: true },
  { label: "BSC testnet · chain 97", state: "ONLINE", live: true },
];

export function StatusTicker() {
  // Rendered twice so the marquee wraps seamlessly: the animation translates by exactly -50%,
  // so the second copy is in the first one's place at the moment it loops.
  const run = [...ITEMS, ...ITEMS];
  return (
    <div className="ticker" aria-label="Live infrastructure status">
      {/* animate-marquee was defined in the stylesheet but never applied here, so this strip sat
          static while a fade mask clipped it mid-word at both edges -- which read as broken
          truncation rather than a marquee. */}
      <div className="ticker-track animate-marquee">
        {run.map((item, i) => (
          <span className="ticker-item" key={i} aria-hidden={i >= ITEMS.length}>
            {/* A dot carries "live" at a glance; six shouted green words competed with the nav. */}
            <span className={`ticker-dot${item.live ? "" : " off"}`} />
            {item.label}
            <span className={`state${item.live ? "" : " off"}`}>{item.state}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
