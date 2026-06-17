'use strict';
// Jobs en segundo plano (setInterval) de sincronización con Moodle.
// Se arrancan SOLO desde app.js cuando RUN_SCHEDULERS está activo, para que al
// escalar a varias instancias no se dupliquen (una sola instancia los corre).
//   - Completaciones: cada 6 h (primera corrida 5 min tras el arranque).
//   - Cursos: cada MOODLE_SYNC_INTERVAL_MINUTES (primera 30 s tras el arranque),
//     solo si Moodle NO está en modo mock.
// Comportamiento idéntico al que vivía inline en app.js.
const moodleService = require('../integrations/moodle');
const { syncMoodleCompletions, syncMoodleCourses } = require('../modules/moodle/service');

const COMPLETION_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 h

function startCompletionSync() {
  // Primera ejecución 5 min después del arranque (espera a que todo esté listo)
  setTimeout(async () => {
    try {
      console.log('⏱ [MOODLE] Inicio sincronización automática de completaciones...');
      const r = await syncMoodleCompletions();
      console.log(`✓ [MOODLE] Sync completaciones: checked=${r.checked} completed=${r.completed} errors=${r.errors}`);
    } catch (e) {
      console.error('❌ [MOODLE] Error en sync automático de completaciones:', e.message);
    }

    // Luego cada 6 horas
    setInterval(async () => {
      try {
        console.log('⏱ [MOODLE] Sincronizando completaciones...');
        const r = await syncMoodleCompletions();
        console.log(`✓ [MOODLE] Sync completaciones: checked=${r.checked} completed=${r.completed} errors=${r.errors}`);
      } catch (e) {
        console.error('❌ [MOODLE] Error en sync automático de completaciones:', e.message);
      }
    }, COMPLETION_SYNC_INTERVAL_MS);
  }, 5 * 60 * 1000);
}

function startCourseSync() {
  const MOODLE_SYNC_MINUTES = Math.max(5, parseInt(process.env.MOODLE_SYNC_INTERVAL_MINUTES || '60', 10));

  if (moodleService.isMockMode()) {
    console.log('ℹ️ Moodle auto-sync de cursos desactivado (MOODLE_MOCK=true)');
    return;
  }

  // Primera sincronización al arrancar (30 seg de delay para que la BD esté lista)
  setTimeout(async () => {
    console.log('🎓 [MOODLE] Sincronización inicial de certificaciones...');
    const r = await syncMoodleCourses();
    if (r.ok) {
      console.log(`🎓 [MOODLE] Sync inicial: +${r.created.length} nuevas, ~${r.updated.length} actualizadas, -${r.deactivated.length} desactivadas`);
    } else {
      console.warn(`⚠️ [MOODLE] Sync inicial falló: ${r.error}`);
    }
  }, 30_000);

  // Sincronización periódica
  setInterval(async () => {
    console.log(`🎓 [MOODLE] Auto-sync periódico (cada ${MOODLE_SYNC_MINUTES} min)...`);
    const r = await syncMoodleCourses();
    if (r.ok) {
      if (r.created.length || r.updated.length || r.deactivated.length) {
        console.log(`🎓 [MOODLE] Auto-sync: +${r.created.length} nuevas, ~${r.updated.length} actualizadas, -${r.deactivated.length} desactivadas`);
      }
    } else {
      console.warn(`⚠️ [MOODLE] Auto-sync falló: ${r.error}`);
    }
  }, MOODLE_SYNC_MINUTES * 60 * 1000);

  console.log(`✓ Moodle auto-sync activo: cada ${MOODLE_SYNC_MINUTES} min`);
}

// Arranca todos los jobs en background. Idempotente respecto al proceso:
// llamarlo una vez por instancia que deba correr los schedulers.
function startSchedulers() {
  startCompletionSync();
  startCourseSync();
}

module.exports = { startSchedulers };
