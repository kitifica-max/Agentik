/**
 * AgentikOnboarding — contenido y lógica de la guía de inicio (sin DOM: se puede probar en Node).
 * bubble.js la dibuja. La lista de "primeros pasos" se marca sola según lo que ya hayas configurado.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AgentikOnboarding = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STEPS = [
    {
      id: 'hola',
      title: 'Hola, soy Agentik',
      body: [
        'Soy un personaje que vive en tu pantalla. Haz clic en mí para abrir o cerrar este chat, y arrástrame para moverme.',
        'Puedo organizar tus archivos, ejecutar tareas en tu Mac, recordar lo que me pidas y avisarte cuando termine algo.',
        'Tú mandas: no observo nada hasta que tú lo actives, y lo que aprenda de ti solo se guarda si lo apruebas.',
      ],
    },
    { id: 'pasos', title: 'Primeros pasos', checklist: true, body: ['Se marcan solos según lo que ya tengas listo.'] },
    { id: 'pedir', title: 'Qué puedes pedirme', examples: true, body: ['Escríbelo como se lo dirías a una persona. Toca un ejemplo para probarlo:'] },
    {
      id: 'control',
      title: 'Tú tienes el control',
      body: [
        'Detener: mientras trabajo aparece el botón Detener (o pulsa Esc).',
        'Puedo ejecutar comandos y mover archivos. Antes de sobrescribir un archivo guardo una copia, pero mover o borrar no se deshace solo: revisa lo que me pides.',
        'Borrar historial: botón en el chat y en Ajustes. Los recuerdos nuevos los apruebas tú, en la pestaña Memoria.',
        'Atajos: ⌘⇧P pausa el observador · Ctrl+Opción+A abre o cierra el chat · Ctrl+Opción+R resumen · Ctrl+Opción+N chat nuevo.',
        'En Ajustes eliges avatar (niño o niña), avisos y sonido. Vuelve a esta guía cuando quieras con el botón ? de arriba.',
      ],
    },
  ];

  // Los cinco primeros son comandos que corren en tu Mac (sin modelo, sin tokens); el primero va al modelo.
  const EXAMPLES = [
    { text: 'Organiza mi carpeta de Descargas por tipo y fecha', note: 'tarea con el modelo' },
    { text: 'resumen', note: 'qué avancé hoy · sin tokens' },
    { text: 'retoma', note: 'dónde me quedé · sin tokens' },
    { text: 'espacio', note: 'revisa y libera disco · sin tokens' },
    { text: 'aprende', note: 'te propone recuerdos de tus proyectos · sin tokens' },
    { text: 'gasto', note: 'cuánto llevas gastado · sin tokens' },
  ];

  /** state: { hasModel, folders, observing, chatted } → lista de pasos con hecho / no hecho. */
  function checklist(s) {
    return [
      { id: 'modelo', done: !!s.hasModel, title: 'Elige un modelo', hint: 'Pega tu API key o agrega uno local de Ollama.', go: 'models', goLabel: 'Ir a Modelo' },
      { id: 'carpetas', done: (s.folders || 0) > 0, title: 'Autoriza una carpeta', hint: 'Una concreta: Descargas, Documentos o un proyecto. Nunca el disco entero.', go: 'files', goLabel: 'Ir a Archivos' },
      { id: 'observador', done: !!s.observing, title: 'Activa el observador (opcional)', hint: 'Solo anota qué app y ventana tienes al frente; nada de teclas ni pantalla. El detalle se borra a las 24 h.', go: 'observer', goLabel: 'Activar' },
      { id: 'mensaje', done: !!s.chatted, title: 'Escribe tu primer mensaje', hint: 'Prueba con «Organiza mi carpeta de Descargas».', go: 'chat', goLabel: 'Ir al chat' },
    ];
  }

  function progress(items) {
    const done = items.filter((i) => i.done).length;
    return { done, total: items.length, text: `${done} de ${items.length} listos` };
  }

  return { STEPS, EXAMPLES, checklist, progress };
});
