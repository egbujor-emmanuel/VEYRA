import type { ReactNode } from "react";

/**
 * One header treatment for every non-marketplace page.
 *
 * Dashboard, Arena, Executions and How-it-works each opened with a bare h1 and a paragraph, styled
 * slightly differently on each, so moving between them felt like moving between three sites. This
 * gives them a shared shape: an eyebrow, the display heading, a lead paragraph at a readable
 * measure, and a hairline that carries the page's accent.
 *
 * `accent` exists so a page can be recognised by colour before it is read -- the same idea as the
 * category hues on the marketplace cards. It defaults to BNB gold, and is passed a category colour
 * on the pages that belong to one.
 */
export function PageHeader({
  eyebrow,
  title,
  lead,
  accent = "var(--color-accent)",
  children,
}: {
  eyebrow?: string;
  title: string;
  lead?: ReactNode;
  accent?: string;
  children?: ReactNode;
}) {
  return (
    <header className="page-header" style={{ "--page-accent": accent } as React.CSSProperties}>
      {eyebrow && <span className="page-header__eyebrow">{eyebrow}</span>}
      <h1 className="text-display text-[clamp(2rem,4.5vw,3rem)] leading-[1.06] text-foreground">{title}</h1>
      {lead && <p className="page-header__lead">{lead}</p>}
      {children}
      <span className="page-header__rule" aria-hidden="true" />
    </header>
  );
}
