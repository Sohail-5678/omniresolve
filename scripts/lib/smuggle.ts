/** Converts {{TAG:hidden text}} markers in red-team data into invisible Unicode Tag characters. */
export function smuggle(text: string): string {
  return text.replace(/\{\{TAG:([\s\S]*?)\}\}/g, (_m, hidden: string) =>
    [...hidden].map((ch) => {
      const cp = ch.charCodeAt(0);
      return cp >= 0x20 && cp < 0x7f ? String.fromCodePoint(0xe0000 + cp) : "";
    }).join(""),
  );
}
