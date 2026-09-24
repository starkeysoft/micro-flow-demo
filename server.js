import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { bundleMicroFlow } from './lib/bundle-micro-flow.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pages_dir = path.join(__dirname, 'pages');
const PORT = 8081;

const app = express();

// micro-flow, bundled for the browser once at startup. Pages load it through
// the import map in their <head> as `import { ... } from 'micro-flow'`.
const micro_flow_bundle = await bundleMicroFlow();
app.get('/vendor/micro-flow.js', (req, res) => {
  res.type('text/javascript').send(micro_flow_bundle);
});

// Every pages/<name>.html is served at /<name>, and index.html at /.
for (const file of fs.readdirSync(pages_dir).filter((f) => f.endsWith('.html'))) {
  const name = path.basename(file, '.html');
  const route = name === 'index' ? '/' : `/${name}`;
  app.get(route, (req, res) => res.sendFile(path.join(pages_dir, file)));
}

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Demos running → http://localhost:${PORT}`);
});
