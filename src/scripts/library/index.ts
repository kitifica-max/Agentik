import type { ScriptDef } from '../types.js';
import { TODOS } from './todos.js';
import { IMAGENES } from './imagenes.js';
import { DEV } from './dev.js';
import { OFICINA } from './oficina.js';
import { CONTENIDO } from './contenido.js';

export const LIBRARY: ScriptDef[] = [...TODOS, ...IMAGENES, ...DEV, ...OFICINA, ...CONTENIDO];
