/** A line of code (comments removed) with its 1-based line number in the original source. */
export interface CodeLine {
  line: number;
  text: string;
}

/**
 * The lines of a source file that hold code: blank lines and comment-only lines are dropped.
 * A line with code and a trailing comment is kept whole. Handles `//` lines and block comments.
 */
export function codeLines(source: string): CodeLine[] {
  const kept: CodeLine[] = [];
  let inBlock = false;
  source.split(/\r?\n/).forEach((raw, index) => {
    let text = raw.trim();
    if (inBlock) {
      const end = text.indexOf("*/");
      if (end === -1) return;
      text = text.slice(end + 2).trim();
      inBlock = false;
    }
    while (text.startsWith("/*")) {
      const end = text.indexOf("*/", 2);
      if (end === -1) {
        inBlock = true;
        text = "";
      } else {
        text = text.slice(end + 2).trim();
      }
    }
    if (text !== "" && !text.startsWith("//")) kept.push({ line: index + 1, text });
  });
  return kept;
}

/** Lines of code the way H1 defines it. */
export function countCodeLines(source: string): number {
  return codeLines(source).length;
}
