# Agetik

Agente personal de escritorio para macOS. Un personaje flotante observa tu trabajo, recuerda lo que le pides y puede modificar archivos cuando lo autorizas.

Estado: **Fase 4 (en revisión)**. Herramientas de archivo con diff preview, aprobación, backups y audit log.

## Instalación

```bash
npm install
npm run dev        # desarrollo
npm test           # pruebas
npm run build      # genera .dmg en release/
```

Requisitos: macOS 13+, Node 22+.

## Configuración de la API key

Crea `.env` en la raíz (ya está en `.gitignore`):

```
ANTHROPIC_API_KEY=tu_clave
```

Modelo: Claude Haiku 5.5. La clave nunca se escribe en logs ni en la base de datos.

## Chat

Haz clic en el personaje para abrir la burbuja. Escribe un mensaje y Agetik responde usando Claude Haiku con contexto de tu actividad reciente (apps, archivos modificados) y recuerdos aprobados.

Si le pides que recuerde algo, propone un recuerdo. Solo se guarda si lo apruebas. Datos sensibles (contraseñas, bancarios, salud, API keys) nunca se proponen como recuerdo.

## Memoria

La pestaña **Memoria** en la burbuja muestra todos los recuerdos: propuestos, aprobados y rechazados. Puedes aprobar, rechazar o eliminar desde ahí. Un recuerdo eliminado desaparece sin dejar copias.

## Sugerencias proactivas

Agetik observa patrones de actividad y sugiere ayuda cuando detecta algo relevante. El personaje cambia a estado `con-sugerencia` (sonrisa + rebote + insignia `!`).

**Niveles** (`suggestion_level` en `config.json`):

| Nivel | Comportamiento | Cooldown |
|-------|----------------|----------|
| `silencio` | Sin sugerencias | — |
| `discreto` | Solo foco prolongado y cambio rápido de apps | 15 min |
| `activo` | Todas las reglas: foco, cambio rápido, ediciones repetidas, inactividad | 5 min |

**Reglas locales** (sin llamada a la API):
- **Foco prolongado**: >30 min en la misma app → sugiere descanso.
- **Cambio rápido**: >5 apps en 5 min → sugiere concentrarse.
- **Ediciones repetidas** (solo activo): mismo archivo cambiado 3+ veces → sugiere revisar.
- **Inactividad** (solo activo): sin actividad 10-30 min tras periodo activo → ofrece resumen.

Al aceptar una sugerencia, se abre como chat con la IA. Al descartar, se suprime esa regla temporalmente.

## Herramientas de archivo

Agetik puede proponer ediciones a archivos dentro de las carpetas autorizadas. Toda escritura requiere aprobación explícita.

**Flujo**:
1. El AI propone una edición (via chat) → aparece en pestaña **Archivos** con diff preview.
2. Revisas el diff (líneas verdes = añadidas, rojas = eliminadas).
3. **Aprobar**: crea backup del original en `~/Library/Application Support/Agetik/backups/`, luego escribe.
4. **Rechazar**: no se toca el archivo.

**Restricciones de seguridad**:
- Solo archivos dentro de `allowed_folders` (config.json).
- Nunca toca: `.env`, claves SSH, `.pem`, credenciales, archivos ocultos de configuración.
- Nunca borra archivos.
- Cada acción se registra en el audit log (tabla `audit_log` en la DB).

## Permisos de macOS

- **Accesibilidad**: necesario para leer el título de la ventana activa. Sin él, Agetik solo ve el nombre de la app. Ajustes del Sistema → Privacidad y seguridad → Accesibilidad → activa Agetik.
- **Automatización (System Events)**: macOS puede pedirlo al primer uso.
- **Grabación de pantalla**: solo para capturas bajo petición (Fase 2).
- **Acceso a carpetas**: Agetik solo vigila las carpetas que tú agregues desde la app.

La app detecta permisos faltantes y lo indica en la burbuja.

## Activar el observador

1. Haz clic en el personaje para abrir la burbuja.
2. Pulsa **Activar observador**. Hasta entonces no se registra nada.
3. Pausa en cualquier momento con el botón **Pausar** o con **Cmd+Shift+P**. La pausa es inmediata.

Mientras el observador esté activo, el personaje muestra un punto rojo pulsante.

## Animaciones del personaje

El avatar (`assets/Agetik.svg`) se anima según lo que hace. Los ojos, cejas y boca se dibujan encima del SVG, que no se modifica.

| Estado | Emoción | Expresión | Movimiento |
|---|---|---|---|
| reposo | calma | ojos normales, boca neutra | respira lento, parpadea |
| observando | atento, curioso | ojos normales | se balancea, mira de lado a lado, punto rojo |
| pensando | concentrado | ojos arriba, una ceja alzada, boca ondulada | cabeza ladeada, insignia `…` |
| con-sugerencia | contento, útil | ojos felices, sonrisa | rebote suave, insignia `!` |
| esperando-aprobacion | pide atención | ojos abiertos, cejas arriba, boca en "o" | se mueve en vaivén, insignia `?` |
| pausado | apagado, descansando | ojos cerrados, boca plana | opaco, hundido, insignia `zz` |

Respeta "reducir movimiento" de macOS.

## Privacidad

**Qué se registra**
- App en primer plano y título de la ventana activa.
- Duración de uso por app.
- Cambios de archivos dentro de las carpetas autorizadas (nombre y ruta, no contenido).

**Qué no se registra nunca**
- Pulsaciones de teclado.
- Contenido de la pantalla. Las capturas son solo bajo petición (Fase 2) y no se guardan en disco.
- Contenido de archivos, fuera o dentro de las carpetas autorizadas.
- Apps y títulos excluidos. Se descartan antes de tocar la base de datos.
- Archivos sensibles: `.env`, claves SSH, `.pem`, credenciales y archivos ocultos.

**Filtros por defecto** (en `config.json` y en código, por seguridad)
- Apps: Bitwarden, 1Password, Keychain Access, Wallet.
- Títulos que contengan: banco, bancaria, contraseña, password, login, bitwarden, 1password, keychain, salud, médico, wallet.

**Dónde se guarda**
- Base de datos SQLite local: `~/Library/Application Support/Agetik/agetik.db`.
- Nada sale del equipo, salvo las llamadas al modelo en fases 2+, que envían solo resúmenes compactos.

**Cuánto dura**
- Eventos de actividad: 24 horas por defecto (`retention_hours` en `config.json`). Una tarea horaria borra lo vencido.

**Cómo borrarlo**
- Desactiva el observador: deja de registrar de inmediato.
- Borra el archivo `~/Library/Application Support/Agetik/agetik.db` para eliminar todo el historial.
- Los recuerdos se borran desde el panel de memoria, sin copias ni resúmenes derivados.

## Estructura

```
src/
  main/        observador, ventanas, IPC, configuración
  observer/    ventana activa, filtros, retención, archivos
  memory/      memoria de hechos (Fase 2)
  suggestions/ motor de sugerencias (Fase 3)
  files/       herramientas de archivos (Fase 4)
  ai/          cliente de Anthropic (Fase 2)
  db/          SQLite
  renderer/    personaje, burbuja, estilos (JS plano)
  preload/     puente IPC con allowlist
  shared/      tipos y canales IPC
tests/         pruebas
assets/        avatar
```
