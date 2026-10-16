/**
 * The temple of policy: a hexastyle façade drawn as architectural line art. The hero uses it
 * as a low-contrast backdrop (darker orange on orange); the inscription on the architrave is
 * the version of the rules in force.
 */
type Props = { className?: string; stroke?: string; fill?: string; columns?: number; inscription?: string; strokeWidth?: number };

export function Temple({ className, stroke = "var(--signal-deep)", fill = "transparent", columns = 6, inscription = "LEX · POLICY · V2026.1", strokeWidth = 2.2 }: Props) {
  const left = 150;
  const right = 850;
  const spacing = (right - left) / (columns - 1);
  const xs = Array.from({ length: columns }, (_, i) => left + i * spacing);
  const triglyphs = Array.from({ length: 13 }, (_, i) => 104 + i * 66);
  return (
    <svg viewBox="0 0 1000 600" className={className} aria-hidden="true" fill="none" stroke={stroke} strokeWidth={strokeWidth} strokeLinejoin="round">
      {/* pediment */}
      <path d="M70 128 L500 30 L930 128 Z" fill={fill} />
      <path d="M118 120 L500 46 L882 120 Z" />
      <circle cx={500} cy={92} r={18} />
      <text x={500} y={99} textAnchor="middle" fontSize={20} fontWeight={800} fill={stroke} stroke="none" style={{ fontVariationSettings: '"wdth" 125' }}>
        §
      </text>
      <path d="M430 100 C 450 92, 466 90, 478 92 M570 100 C 550 92, 534 90, 522 92" />
      {/* cornice + frieze + architrave */}
      <rect x={70} y={128} width={860} height={14} fill={fill} />
      <rect x={90} y={142} width={820} height={40} fill={fill} />
      {triglyphs.map((x) => (
        <g key={x}>
          <path d={`M${x} 146 V178 M${x + 8} 146 V178 M${x + 16} 146 V178`} />
        </g>
      ))}
      <rect x={90} y={182} width={820} height={44} fill={fill} />
      <text x={500} y={212} textAnchor="middle" fontSize={20} fontWeight={800} letterSpacing={9} fill={stroke} stroke="none" style={{ fontVariationSettings: '"wdth" 125' }}>
        {inscription}
      </text>
      {/* columns */}
      {xs.map((x) => (
        <g key={x}>
          <rect x={x - 42} y={226} width={84} height={10} fill={fill} />
          <path d={`M${x - 36} 236 C ${x - 30} 250, ${x + 30} 250, ${x + 36} 236`} fill={fill} />
          <path d={`M${x - 25} 250 L${x - 29} 484 L${x + 29} 484 L${x + 25} 250 Z`} fill={fill} />
          <path d={`M${x - 13} 254 L${x - 15} 482 M${x} 254 V482 M${x + 13} 254 L${x + 15} 482`} strokeWidth={strokeWidth * 0.6} />
          <rect x={x - 38} y={484} width={76} height={12} rx={3} fill={fill} />
        </g>
      ))}
      {/* stylobate */}
      <rect x={96} y={496} width={808} height={22} fill={fill} />
      <rect x={66} y={518} width={868} height={22} fill={fill} />
      <rect x={36} y={540} width={928} height={22} fill={fill} />
    </svg>
  );
}
