import { Hero } from "@/components/landing/Hero";
import { Pillars } from "@/components/landing/Pillars";
import { Cases, Pivot, Receipts, SiteFooter } from "@/components/landing/Sections";
import { loadResults } from "@/lib/results";

export default function Home() {
  const results = loadResults();
  return (
    <main className="pb-4">
      <Hero />
      <Pillars />
      <Cases />
      <Pivot />
      <Receipts results={results} />
      <SiteFooter />
    </main>
  );
}
