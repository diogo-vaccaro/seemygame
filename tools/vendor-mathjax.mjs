import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = path.join(root, 'js/vendor/mathjax');
const mathjax = path.join(root, 'node_modules/mathjax');
const font = path.join(root, 'node_modules/@mathjax/mathjax-newcm-font');
fs.mkdirSync(target, { recursive: true });
for (const file of ['startup.js', 'core.js', 'LICENSE']) fs.copyFileSync(path.join(mathjax, file), path.join(target, file));
for (const file of ['input/tex-base.js', 'input/tex/extensions/ams.js', 'input/tex/extensions/newcommand.js', 'output/svg.js']) {
  fs.mkdirSync(path.dirname(path.join(target, file)), { recursive: true });
  fs.copyFileSync(path.join(mathjax, file), path.join(target, file));
}
fs.mkdirSync(path.join(target, 'font'), { recursive: true });
// The font npm package declares Apache-2.0 but omits the license file.
fs.copyFileSync(path.join(mathjax, 'LICENSE'), path.join(target, 'font/LICENSE'));
fs.copyFileSync(path.join(font, 'svg.js'), path.join(target, 'font/svg.js'));
fs.cpSync(path.join(font, 'svg'), path.join(target, 'font/svg'), { recursive: true });
fs.writeFileSync(path.join(target, 'VERSION.json'), JSON.stringify({
  mathjax: JSON.parse(fs.readFileSync(path.join(mathjax, 'package.json'))).version,
  font: JSON.parse(fs.readFileSync(path.join(font, 'package.json'))).version
}, null, 2) + '\n');
console.log('Local MathJax SVG bundle and dynamic glyph data prepared.');

