// Gera um preview.html auto-contido (demo, sem Firebase) para partilhar como Artifact.
// Uso: node build_preview.mjs [saida.html]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] || join(root, 'preview.html');

const html = readFileSync(join(root, 'index.html'), 'utf8');
const css = readFileSync(join(root, 'app.css'), 'utf8');
const logo = readFileSync(join(root, 'assets/icon.png'));
const dataUri = `data:image/png;base64,${logo.toString('base64')}`;

const stripModules = (src) => src
  .replace(/^import .*?;\s*$/gm, '')   // imports locais (o import() dinâmico do gstatic fica, mas nunca corre sem config)
  .replace(/^export /gm, '');

// O preview NUNCA leva a config real — modo demo local, senão o artifact
// público escrevia dados fictícios na base de dados do restaurante.
const js = ['const firebaseConfig = null;', ...['store.js', 'app.js']
  .map((f) => stripModules(readFileSync(join(root, f), 'utf8')))]
  .join('\n;\n');

let body = html.match(/<body>([\s\S]*)<\/body>/)[1]
  .replace(/<script type="module" src="app\.js"><\/script>/, '')
  .replaceAll('assets/icon.png', dataUri);

writeFileSync(out, `<title>O Cruzeiro · Mesas</title>
<style>
${css}</style>
${body}
<script type="module">
window.__PREVIEW__ = true;
document.documentElement.dataset.unlocked = '1'; // a demo nunca pede código
${js}
</script>
`);
console.log('preview →', out);
