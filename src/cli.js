// node src/cli.js [--only name]... [--force] [--list-new DAYS]
import { parseArgs } from 'node:util';
import * as D from './db.js';
import { run } from './sync.js';

const { values } = parseArgs({ options: { only: { type: 'string', multiple: true }, force: { type: 'boolean' }, 'list-new': { type: 'string' } } });
if (values['list-new'] !== undefined) {
  const cut = Date.now() / 1000 - Number(values['list-new']) * 86400;
  for (const r of D.all('SELECT name,revision,first_seen FROM bundles WHERE first_seen>=? ORDER BY first_seen DESC', cut))
    console.log(r.name, r.revision, new Date(r.first_seen * 1000).toISOString().slice(0, 16).replace('T', ' '));
} else {
  const st = await run({ only: values.only ? new Set(values.only) : null, force: !!values.force });
  console.log(JSON.stringify(st, null, 1));
  process.exit(st.last_error && !st.downloaded && st.failed ? 1 : 0);
}
