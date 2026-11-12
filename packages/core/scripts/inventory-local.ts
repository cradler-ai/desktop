// Dev tool: print what loadInventory finds on this machine (names only, secrets masked).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadInventory, displayRaw, scopeText, precheck } from '../src/index';

const home = os.homedir();
const inv = await loadInventory({
  home,
  readTexts: (ps) => Promise.all(ps.map((p) => fs.readFile(p, 'utf8').catch(() => null))),
  listDir: async (p) => {
    const entries = await fs.readdir(p, { withFileTypes: true }).catch(() => []);
    return Promise.all(
      entries.map(async (e) => {
        const full = path.join(p, e.name);
        const st = await fs.stat(full).catch(() => null);
        return { name: e.name, isDir: !!st?.isDirectory(), isSymlink: e.isSymbolicLink(), target: e.isSymbolicLink() ? await fs.realpath(full).catch(() => null) : null };
      }),
    );
  },
});
console.log('config files:');
for (const f of inv.configFiles) console.log(`  ${f.client.padEnd(15)} ${f.exists ? (f.error ?? 'ok') : '(none)'}  servers=${f.servers}  ${f.path.replace(home, '~')}`);
console.log(`\nservers: ${inv.servers.length} in ${inv.serverGroups.length} groups`);
for (const g of inv.serverGroups) {
  const where = g.items.map((i) => [i.client, scopeText(i)].filter(Boolean).join(' ') + (i.disabled ? '(停用)' : '')).join(', ');
  const pre = g.items.map((i) => precheck(i)?.title).filter(Boolean);
  console.log(`  ${g.name.padEnd(18)} ${g.kind.padEnd(10)} ${g.consistent ? '' : '[不一致] '}${where}${pre.length ? '  预检:' + [...new Set(pre)].join('/') : ''}`);
  console.log(`      ${displayRaw(g.items[0].raw).slice(0, 110)}`);
}
console.log(`\nskills: ${inv.skills.length} in ${inv.skillGroups.length} groups`);
for (const g of inv.skillGroups.filter((g) => g.items.length > 1)) console.log(`  ${g.name.padEnd(26)} ${g.items.map((i) => i.location + (i.isSymlink ? '→link' : '')).join(', ')}${g.differs ? '  [内容不一样]' : ''}`);
const byLoc: Record<string, number> = {};
for (const s of inv.skills) byLoc[s.location] = (byLoc[s.location] ?? 0) + 1;
console.log('  by location:', byLoc);
console.log(`\nplugins: ${inv.plugins.length}`);
for (const p of inv.plugins) console.log(`  ${p.id.padEnd(40)} ${p.enabled ? '启用' : '停用'}  v${p.version}  skills=${p.counts.skills} cmds=${p.counts.commands} agents=${p.counts.agents} mcp=${p.counts.mcp} hooks=${p.counts.hooks}`);
