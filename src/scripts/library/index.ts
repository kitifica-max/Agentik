import type { ScriptDef } from '../types.js';
import { TODOS } from './todos.js';
import { IMAGENES } from './imagenes.js';
import { DEV } from './dev.js';

export const LIBRARY: ScriptDef[] = [...TODOS, ...IMAGENES, ...DEV];
