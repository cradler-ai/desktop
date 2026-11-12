// A small POSIX-ish tokenizer. Good enough for install commands copied from READMEs;
// it never executes anything.

const OPERATORS = new Set(['&&', '||', ';', '|']);

export function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inTok = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) { quote = null; continue; }
      if (c === '\\' && quote === '"' && i + 1 < line.length && '"\\$`'.includes(line[i + 1])) {
        cur += line[++i];
        continue;
      }
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; inTok = true; continue; }
    if (c === '\\' && i + 1 < line.length) { cur += line[++i]; inTok = true; continue; }
    if (/\s/.test(c)) {
      if (inTok) { out.push(cur); cur = ''; inTok = false; }
      continue;
    }
    if (c === '#' && !inTok) break; // comment
    const two = line.slice(i, i + 2);
    if (two === '&&' || two === '||' || c === ';' || c === '|') {
      if (inTok) { out.push(cur); cur = ''; inTok = false; }
      out.push(two === '&&' || two === '||' ? two : c);
      if (two === '&&' || two === '||') i++;
      continue;
    }
    cur += c;
    inTok = true;
  }
  if (inTok) out.push(cur);
  return out;
}

/** Splits pasted text into separate commands (by line and by && ; |). */
export function splitCommands(text: string): string[][] {
  // line continuations: backslash (sh), backtick (PowerShell), caret (cmd)
  const joined = text.replace(/[\\`^][ \t]*\r?\n/g, ' ');
  const out: string[][] = [];
  for (let line of joined.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    line = line.replace(/^(\$|%|>|PS[^>]*>|❯|➜)\s+/, '');
    let cur: string[] = [];
    for (const t of tokenize(line)) {
      if (OPERATORS.has(t)) {
        if (cur.length) out.push(cur);
        cur = [];
      } else cur.push(t);
    }
    if (cur.length) out.push(cur);
  }
  return out;
}
