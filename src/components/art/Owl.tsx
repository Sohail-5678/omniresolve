/**
 * "The Gatekeeper": Athena's owl as a judge — laurel wreath, black robe and jabot, wings
 * folded, pixel sunglasses. Drawn as flat poster art so it sits on signal orange.
 * The shades drop in once on first paint (respecting reduced motion).
 */
type Props = { className?: string; animateShades?: boolean; title?: string };

const LEAF = "M0 0 C 5 -7, 17 -8, 26 0 C 17 8, 5 7, 0 0 Z";

function laurel(side: "left" | "right") {
  const leaves = [];
  const cx = 160;
  const cy = 140;
  const r = 110;
  // Two branches climb from the temples toward the crown; leaves point along the direction of travel.
  for (let i = 0; i < 8; i++) {
    const t = i / 7;
    const deg = side === "left" ? 176 - t * 74 : 4 + t * 74;
    const rad = (deg * Math.PI) / 180;
    const x = cx + r * Math.cos(rad);
    const y = cy - r * Math.sin(rad);
    const travel = side === "left" ? 90 - deg : -deg - 90;
    const outer = i % 2 === 0;
    const tilt = (outer ? -1 : 1) * (side === "left" ? 24 : -24);
    leaves.push(
      <path
        key={`${side}-${i}`}
        d={LEAF}
        transform={`translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${(travel + tilt).toFixed(1)}) scale(${outer ? 1 : 0.84})`}
        fill={outer ? "var(--gold)" : "#b98a1f"}
        stroke="var(--ink)"
        strokeWidth={1.6}
        strokeLinejoin="round"
      />,
    );
  }
  return leaves;
}

export function Owl({ className, animateShades = false, title = "The Gatekeeper, an owl in a judge's robe wearing pixel sunglasses" }: Props) {
  const p = 8;
  const ox = 86;
  const oy = 128;
  const px = (x: number, y: number, w = 1, h = 1, fill = "var(--ink)") => (
    <rect key={`${x}-${y}-${fill}`} x={ox + x * p} y={oy + y * p} width={w * p} height={h * p} fill={fill} />
  );
  return (
    <svg viewBox="0 0 320 400" className={className} role="img" aria-label={title}>
      <title>{title}</title>
      {/* ear tufts */}
      <path d="M98 94 L70 20 L138 70 Z" fill="var(--paper)" stroke="var(--ink)" strokeWidth={4} strokeLinejoin="round" />
      <path d="M222 94 L250 20 L182 70 Z" fill="var(--paper)" stroke="var(--ink)" strokeWidth={4} strokeLinejoin="round" />
      {/* robe */}
      <path d="M58 230 C 70 196, 250 196, 262 230 L 292 392 C 228 402, 92 402, 28 392 Z" fill="var(--ink)" />
      <path d="M96 300 C 100 340, 98 370, 92 396 M224 300 C 220 340, 222 370, 228 396" stroke="var(--ink-soft)" strokeWidth={3} fill="none" strokeLinecap="round" />
      {/* jabot */}
      <path d="M138 222 L160 270 L182 222 C 168 230, 152 230, 138 222 Z" fill="var(--paper)" stroke="var(--ink)" strokeWidth={3} strokeLinejoin="round" />
      <path d="M150 236 L160 262 L170 236" stroke="var(--paper-3)" strokeWidth={2} fill="none" />
      {/* head */}
      <ellipse cx={160} cy={142} rx={108} ry={92} fill="var(--paper)" stroke="var(--ink)" strokeWidth={4} />
      <path d="M128 70 q8 6 16 0 M152 64 q8 6 16 0 M176 70 q8 6 16 0" stroke="var(--ink-soft)" strokeWidth={2.4} fill="none" strokeLinecap="round" />
      {/* facial disc */}
      <ellipse cx={122} cy={148} rx={48} ry={44} fill="#fffaf2" stroke="var(--ink)" strokeWidth={3} />
      <ellipse cx={198} cy={148} rx={48} ry={44} fill="#fffaf2" stroke="var(--ink)" strokeWidth={3} />
      {/* beak */}
      <path d="M160 170 L174 188 L160 210 L146 188 Z" fill="var(--signal)" stroke="var(--ink)" strokeWidth={3} strokeLinejoin="round" />
      {/* laurel wreath */}
      <g>{laurel("left")}{laurel("right")}</g>
      {/* wings, crossed like folded arms */}
      <path d="M262 252 C 230 262, 150 302, 108 318 C 96 323, 98 340, 112 340 C 160 338, 232 316, 262 296 C 280 284, 280 258, 262 252 Z" fill="var(--paper)" stroke="var(--ink)" strokeWidth={4} strokeLinejoin="round" />
      <path d="M244 278 C 210 292, 170 306, 132 318" stroke="var(--ink-soft)" strokeWidth={2} fill="none" strokeLinecap="round" />
      <path d="M58 252 C 90 262, 170 302, 212 318 C 224 323, 222 340, 208 340 C 160 338, 88 316, 58 296 C 40 284, 40 258, 58 252 Z" fill="var(--paper)" stroke="var(--ink)" strokeWidth={4} strokeLinejoin="round" />
      <path d="M76 278 C 110 292, 150 306, 188 318" stroke="var(--ink-soft)" strokeWidth={2} fill="none" strokeLinecap="round" />
      <path d="M196 340 q6 -10 12 0 q6 -10 12 0" stroke="var(--ink)" strokeWidth={2.4} fill="none" strokeLinecap="round" />
      {/* talons */}
      <path d="M124 392 l-9 7 M130 392 l0 8 M136 392 l9 7 M184 392 l-9 7 M190 392 l0 8 M196 392 l9 7" stroke="var(--signal-ink)" strokeWidth={4} strokeLinecap="round" />
      {/* pixel shades */}
      <g className={animateShades ? "shades-drop" : undefined}>
        {px(0, 0, 19, 1)}
        {px(1, 1, 7, 1)}
        {px(2, 2, 5, 1)}
        {px(11, 1, 7, 1)}
        {px(12, 2, 5, 1)}
        {px(2, 1, 1, 1, "var(--paper)")}
        {px(3, 2, 1, 1, "var(--paper)")}
        {px(12, 1, 1, 1, "var(--paper)")}
        {px(13, 2, 1, 1, "var(--paper)")}
      </g>
    </svg>
  );
}
