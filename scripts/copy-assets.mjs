import { cpSync, mkdirSync } from 'node:fs';

// Renderer es JS plano (sin bundler). Copia HTML, CSS, JS y el avatar a dist.
mkdirSync('dist/renderer/assets', { recursive: true });
mkdirSync('dist/main', { recursive: true });
cpSync('src/renderer', 'dist/renderer', { recursive: true });
cpSync('assets/Agentik-head.svg', 'dist/renderer/assets/Agentik-head.svg');
cpSync('assets/Agentik-torso.svg', 'dist/renderer/assets/Agentik-torso.svg');
cpSync('config.json', 'dist/main/config.json');
