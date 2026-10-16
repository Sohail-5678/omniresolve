/** Poster furniture: crop marks, the logo mark, and the comic speech bubble. */
import type { ReactNode } from "react";
import { cn } from "@/lib/client/cn";

/** Registration-style L marks set just inside each corner, as on a printer's proof. */
export function CropMarks({ className, color = "var(--ink)", inset = 22, size = 16 }: { className?: string; color?: string; inset?: number; size?: number }) {
  const corner = (pos: "tl" | "tr" | "bl" | "br") => {
    const style: React.CSSProperties = { position: "absolute", width: size, height: size, pointerEvents: "none" };
    if (pos[0] === "t") style.top = inset;
    else style.bottom = inset;
    if (pos[1] === "l") style.left = inset;
    else style.right = inset;
    const h = pos[1] === "l" ? `M0 ${pos[0] === "t" ? 0 : size} H${size * 0.7}` : `M${size} ${pos[0] === "t" ? 0 : size} H${size * 0.3}`;
    const v = pos[1] === "l" ? `M${pos[1] === "l" ? 0 : size} ${pos[0] === "t" ? size * 0.35 : size * 0.65} V${pos[0] === "t" ? size : 0}` : `M${size} ${pos[0] === "t" ? size * 0.35 : size * 0.65} V${pos[0] === "t" ? size : 0}`;
    return (
      <svg key={pos} viewBox={`0 0 ${size} ${size}`} style={style} aria-hidden="true">
        <path d={`${h} ${v}`} stroke={color} strokeWidth={1.6} fill="none" />
      </svg>
    );
  };
  return <div className={cn("pointer-events-none absolute inset-0", className)}>{(["tl", "tr", "bl", "br"] as const).map(corner)}</div>;
}

export function LogoMark({ className, color = "var(--ink)" }: { className?: string; color?: string }) {
  return (
    <svg viewBox="0 0 40 40" className={className} aria-hidden="true">
      <path d="M6 13 L3 3 L13 9 Z M34 13 L37 3 L27 9 Z" fill={color} />
      <circle cx={13.5} cy={20} r={8} fill="none" stroke={color} strokeWidth={2.6} />
      <circle cx={26.5} cy={20} r={8} fill="none" stroke={color} strokeWidth={2.6} />
      <rect x={4} y={16} width={32} height={4} fill={color} />
      <rect x={7} y={20} width={11} height={4} fill={color} />
      <rect x={22} y={20} width={11} height={4} fill={color} />
      <path d="M20 26 L23.5 30.5 L20 35 L16.5 30.5 Z" fill={color} />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return <span className={cn("display text-[0.95rem] tracking-[0.01em]", className)}>OmniResolve</span>;
}

/** Comic speech bubble with an offset ink shadow; the tail points down-left by default. */
export function SpeechBubble({ children, className, tail = "left" }: { children: ReactNode; className?: string; tail?: "left" | "right" }) {
  return (
    <div className={cn("relative inline-block", className)}>
      <div className="relative z-10 rounded-[22px] border-[3px] border-ink bg-white px-5 py-3 text-ink shadow-[5px_6px_0_var(--ink)]">{children}</div>
      <svg viewBox="0 0 40 34" className={cn("absolute z-20 h-[34px] w-[40px]", tail === "left" ? "-bottom-[27px] left-8" : "-bottom-[27px] right-8 -scale-x-100")} aria-hidden="true">
        <path d="M2 0 L10 32 L30 0" fill="white" stroke="var(--ink)" strokeWidth={3} strokeLinejoin="round" />
        <path d="M3 -3 H29" stroke="white" strokeWidth={6} />
      </svg>
    </div>
  );
}
