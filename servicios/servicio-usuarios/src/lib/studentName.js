'use strict';
// Separa nombres y apellidos del estudiante para Moodle (que los usa en el certificado).
// Con campos explícitos se usan tal cual; con un solo texto:
//   2 palabras → 1+1, 3 → 1+2 ("Juan Pérez Gómez"), 4 o más → 2+resto ("Juan Carlos Pérez Gómez").
// Devuelve null si no hay apellido (informe QA 4.3: antes quedaba apellido "Student").
function splitStudentName(fullName, first, last) {
  const clean = (v) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');
  const f = clean(first), l = clean(last);
  if (f && l) return { firstName: f, lastName: l };
  const parts = clean(fullName).split(' ').filter(Boolean);
  if (parts.length < 2) return null;
  const nFirst = parts.length >= 4 ? 2 : 1;
  return { firstName: parts.slice(0, nFirst).join(' '), lastName: parts.slice(nFirst).join(' ') };
}

// Para reintentos de activaciones antiguas (que pudieron guardarse con una sola palabra):
// nunca falla; conserva el comportamiento anterior como último recurso.
function splitStudentNameLenient(fullName, email) {
  const r = splitStudentName(fullName);
  if (r) return r;
  const one = (typeof fullName === 'string' && fullName.trim()) || String(email || '').split('@')[0];
  return { firstName: one, lastName: 'Student' };
}

module.exports = { splitStudentName, splitStudentNameLenient };
