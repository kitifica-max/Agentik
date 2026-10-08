import { cpSync, mkdirSync } from 'node:fs';

// Renderer es JS plano (sin bundler). Copia HTML, CSS, JS y el avatar a dist.
mkdirSync('dist/renderer/assets', { recursive: true });
mkdirSync('dist/main', { recursive: true });
cpSync('src/renderer', 'dist/renderer', { recursive: true });
cpSync('assets/Agetik.svg', 'dist/renderer/assets/Agetik.svg');
cpSync('config.json', 'dist/main/config.json');
