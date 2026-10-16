import Link from "next/link";
import { ArrowRight, ArrowUpRight, Zap } from "lucide-react";
import { Owl } from "@/components/art/Owl";
import { Temple } from "@/components/art/Temple";
import { CropMarks, LogoMark, SpeechBubble } from "@/components/art/marks";

export const GITHUB_URL = "https://github.com/Sohail-5678/omniresolve";

export function Hero() {
  return (
    <section className="px-3 pt-3 sm:px-4 sm:pt-4">
      <Link
        href="/console?scenario=s3-temporal-trap"
        className="group mx-auto flex min-h-10 items-center justify-center gap-2 rounded-full bg-signal-soft px-4 py-2 text-center text-[0.78rem] font-semibold text-ink shadow-[inset_0_0_0_1px_rgba(28,26,23,0.12)] transition-colors duration-200 hover:bg-[#f5b088]"
      >
        <span className="mono hidden rounded bg-ink px-1.5 py-0.5 text-[0.6rem] text-signal-soft sm:inline">§1.4 v2026.1</span>
        <span className="underline decoration-ink/40 underline-offset-4 group-hover:decoration-ink">The 90-day return window ended. Watch the agent refuse to cite it</span>
        <ArrowRight className="size-3.5 shrink-0 transition-transform duration-200 group-hover:translate-x-0.5" aria-hidden />
      </Link>

      <div className="poster poster-grain relative mt-2 overflow-hidden lg:min-h-[max(720px,calc(100dvh-72px))]">
        <CropMarks inset={20} />
        <Temple className="absolute bottom-[-2px] left-1/2 z-0 w-[min(1240px,118%)] -translate-x-1/2 opacity-70 max-lg:bottom-auto max-lg:top-[26%] max-sm:w-[200%]" />

        <header className="relative z-20 grid grid-cols-[1fr_auto_1fr] items-center px-6 pt-6 sm:px-12 sm:pt-9">
          <Link href="/" className="flex w-fit items-center gap-2" aria-label="OmniResolve home">
            <LogoMark className="size-8" />
            <span className="display text-[0.8rem] tracking-[0.02em] sm:hidden">OmniResolve</span>
          </Link>
          <span className="display hidden text-[1.05rem] tracking-[0.02em] sm:inline">OmniResolve</span>
          <nav className="flex items-center justify-end gap-5 text-[0.7rem] font-semibold uppercase tracking-[0.08em] wide">
            <a href="#pillars" className="hidden hover:underline xl:inline">How it works</a>
            <a href="#receipts" className="hidden hover:underline xl:inline">Evals</a>
            <a href={GITHUB_URL} className="hidden items-center gap-1 hover:underline lg:inline-flex" target="_blank" rel="noreferrer">
              GitHub <ArrowUpRight className="size-3" aria-hidden />
            </a>
            <Link href="/console" className="btn btn-ink !rounded-[10px] !px-3 !py-2 !text-[0.66rem] uppercase tracking-[0.08em]">
              Console
            </Link>
          </nav>
        </header>

        <div className="relative z-10 flex flex-col items-center px-5 pt-[clamp(2rem,6vh,4.5rem)] text-center">
          <p className="eyebrow mb-5 text-ink/80">A support agent that takes real actions — safely</p>
          <h1 className="display text-[clamp(3.1rem,min(9.8vw,15.5vh),10.2rem)] text-ink">
            Agents
            <br />
            with
            <br />
            receipts
          </h1>
          <div className="pill-toggle mt-[clamp(1.5rem,4vh,2.5rem)]" role="group" aria-label="Get started">
            <Link href="/console?scenario=s1-damaged-double-charge" data-active="true">
              Watch a case
            </Link>
            <Link href="/console?scenario=free-play">Write a complaint</Link>
          </div>
        </div>

        {/* Bottom band: copy on the left, the Gatekeeper peeking up from the frame on the right. */}
        <div className="relative z-10 px-6 pb-6 pt-10 sm:px-12 lg:absolute lg:bottom-0 lg:left-0 lg:max-w-[30rem] lg:pb-9 lg:pt-0">
          <p className="text-[1.02rem] leading-[1.55] text-ink">
            It refunds, replaces and ships — and it can&apos;t be talked into it. <strong className="font-bold">The LLM proposes. Code decides.</strong> A supervisor signs off on anything big, and a saga makes every change stick or unwind cleanly.
          </p>
          <p className="mt-4 flex items-center gap-2 text-[0.78rem] font-semibold text-ink/85">
            <Zap className="size-3.5 shrink-0 fill-ink" aria-hidden />
            Demo mode replays real recorded model runs — no API key needed.
          </p>
        </div>

        <div className="relative z-10 mx-auto w-[min(300px,72vw)] max-lg:mt-14 lg:absolute lg:bottom-0 lg:right-[5%] lg:mx-0 lg:w-[clamp(230px,min(24vw,40vh),330px)]">
          <SpeechBubble className="absolute bottom-[74%] right-[80%] z-20 w-max max-lg:bottom-[86%] max-lg:right-[58%]" tail="right">
            <span className="block text-[1.02rem] font-bold leading-tight wide">
              no token,
              <br />
              no refund.
            </span>
          </SpeechBubble>
          <div className="relative overflow-hidden lg:h-[clamp(196px,min(21vw,35vh),292px)]">
            <Owl className="relative z-10 block w-full drop-shadow-[0_18px_22px_rgba(138,52,18,0.35)]" animateShades />
          </div>
        </div>
      </div>
    </section>
  );
}
