'use strict';

/**
 * Wraps Moodle Web Services REST API calls.
 * All public functions return a result object; they NEVER throw.
 *
 * Required env vars:
 *   MOODLE_URL       e.g. https://moodle.example.com
 *   MOODLE_TOKEN     Web Services token (generated in Moodle admin)
 *   MOODLE_MOCK      'true' to skip real calls (local dev)
 *   MOODLE_ROLE_ID   Moodle role ID for enrollment (default: 5 = student)
 */

const https = require('https');
const http  = require('http');
const { URL, URLSearchParams } = require('url');
const crypto = require('crypto');

const MOODLE_URL     = (process.env.MOODLE_URL || '').replace(/\/$/, '');
const MOODLE_TOKEN   = process.env.MOODLE_TOKEN  || '';
const MOODLE_MOCK    = process.env.MOODLE_MOCK   === 'true';
const MOODLE_ROLE_ID = parseInt(process.env.MOODLE_ROLE_ID || '5', 10);

// ─── Internal HTTP helper ────────────────────────────────────────────────────

function moodleRequest(wsfunction, params) {
  return new Promise((resolve, reject) => {
    if (!MOODLE_URL) {
      return reject(new Error('MOODLE_URL no configurado'));
    }

    const base = new URL('/webservice/rest/server.php', MOODLE_URL);
    const body = new URLSearchParams({
      wstoken:            MOODLE_TOKEN,
      moodlewsrestformat: 'json',
      wsfunction,
      ...params
    }).toString();

    const isHttps = base.protocol === 'https:';
    const options = {
      hostname: base.hostname,
      port:     base.port || (isHttps ? 443 : 80),
      path:     base.pathname,
      method:   'POST',
      headers: {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const transport = isHttps ? https : http;
    const req = transport.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Moodle HTTP ${res.statusCode}: ${raw.slice(0, 200)}`));
        }
        try {
          const parsed = JSON.parse(raw);
          if (parsed && parsed.exception) {
            return reject(new Error(`[${parsed.errorcode}] ${parsed.message}`));
          }
          resolve(parsed);
        } catch {
          reject(new Error(`Moodle respuesta no-JSON: ${raw.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('Moodle request timeout (10s)')));
    req.write(body);
    req.end();
  });
}

// ─── Mock responses ──────────────────────────────────────────────────────────

let _mockIdCounter = 5000;

function mockEnrollStudent(email, moodleCourseId) {
  const id = ++_mockIdCounter;
  console.log(`[MOODLE MOCK] enrollStudent email=${email} courseId=${moodleCourseId} → userId=${id}`);
  return { mocked: true, moodleUserId: id };
}

function mockGetCourseCompletionStatus(moodleUserId, moodleCourseId) {
  // Course IDs 800-899 simulan cursos completados automáticamente
  const autoComplete = moodleCourseId >= 800 && moodleCourseId <= 899;
  console.log(`[MOODLE MOCK] getCourseCompletionStatus userId=${moodleUserId} courseId=${moodleCourseId} → completed=${autoComplete}`);
  return {
    completed:     autoComplete,
    timecompleted: autoComplete ? Math.floor(Date.now() / 1000) : 0,
    statustext:    autoComplete ? 'Complete' : 'In progress'
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Find Moodle user by email.
 * Returns { moodleUserId } or { moodleUserId: null } if not found, or { error }.
 */
async function findUserByEmail(email) {
  try {
    const users = await moodleRequest('core_user_get_users_by_field', {
      field:       'email',
      'values[0]': email
    });
    if (!Array.isArray(users) || users.length === 0) {
      return { moodleUserId: null };
    }
    return { moodleUserId: users[0].id };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Create a Moodle user. Username is derived from email.
 * Returns { moodleUserId } or { error }.
 */
async function createUser(email, firstName, lastName) {
  const username = email
    .toLowerCase()
    .replace('@', '.')
    .replace(/[^a-z0-9._-]/g, '_');

  const password = generateMoodlePassword();
  try {
    const result = await moodleRequest('core_user_create_users', {
      'users[0][username]':  username,
      'users[0][email]':     email,
      'users[0][firstname]': firstName || email.split('@')[0],
      'users[0][lastname]':  lastName  || 'Student',
      'users[0][password]':  password,
      'users[0][auth]':      'manual'
    });
    if (!Array.isArray(result) || result.length === 0) {
      return { error: 'Moodle createUser retornó resultado vacío' };
    }
    return { moodleUserId: result[0].id, moodleUsername: username, moodleTempPassword: password };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Force a user to change their password on next login.
 * Non-fatal: logs but does not block enrollment on failure.
 */
async function forcePasswordChange(moodleUserId) {
  try {
    await moodleRequest('core_user_update_users', {
      'users[0][id]':                  moodleUserId,
      'users[0][forcepasswordchange]': '1'
    });
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Enroll a Moodle user in a course.
 * Returns { ok: true } or { error }.
 */
async function enrollUserInCourse(moodleUserId, moodleCourseId) {
  try {
    await moodleRequest('enrol_manual_enrol_users', {
      'enrolments[0][roleid]':   MOODLE_ROLE_ID,
      'enrolments[0][userid]':   moodleUserId,
      'enrolments[0][courseid]': moodleCourseId
    });
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * High-level: find-or-create user then enroll in course.
 *
 * Returns one of:
 *   { enrolled: true, moodleUserId }          — éxito real
 *   { mocked: true, moodleUserId }             — modo mock
 *   { skipped: true, reason }                  — sin moodle_course_id
 *   { error, moodleUserId? }                   — fallo parcial o total
 */
async function enrollStudent({ email, firstName, lastName, moodleCourseId }) {
  if (!moodleCourseId) {
    return { skipped: true, reason: 'no_moodle_course_id' };
  }

  if (MOODLE_MOCK) {
    return mockEnrollStudent(email, moodleCourseId);
  }

  // Step 1: find existing user
  const findResult = await findUserByEmail(email);
  if (findResult.error) {
    return { error: `find_user: ${findResult.error}` };
  }

  let moodleUserId = findResult.moodleUserId;

  // Step 2: create if not found
  let moodleUsername = null;
  let moodleTempPassword = null;
  if (!moodleUserId) {
    const createResult = await createUser(email, firstName, lastName);
    if (createResult.error) {
      return { error: `create_user: ${createResult.error}` };
    }
    moodleUserId = createResult.moodleUserId;
    moodleUsername = createResult.moodleUsername;
    moodleTempPassword = createResult.moodleTempPassword;

    // Force password change on first login (non-fatal if unsupported)
    const fpcResult = await forcePasswordChange(moodleUserId);
    if (fpcResult.error) {
      console.warn(`[MOODLE] forcePasswordChange failed (non-fatal): ${fpcResult.error}`);
    }
  }

  // Step 3: enroll
  const enrollResult = await enrollUserInCourse(moodleUserId, moodleCourseId);
  if (enrollResult.error) {
    return { error: `enroll: ${enrollResult.error}`, moodleUserId };
  }

  return { enrolled: true, moodleUserId, moodleUsername, moodleTempPassword };
}

/**
 * Check if a Moodle user has completed a course.
 *
 * Uses Moodle WS: core_completion_get_course_completion_status
 *   { completionstatus: { id, statustext, timecompleted, ... } }
 *
 * Returns one of:
 *   { completed: true,  timecompleted, statustext }  — completado
 *   { completed: false, timecompleted: 0 }            — en progreso
 *   { error }                                          — fallo de llamada
 */
async function getCourseCompletionStatus(moodleUserId, moodleCourseId) {
  if (!moodleUserId || !moodleCourseId) {
    return { error: 'moodleUserId y moodleCourseId son requeridos' };
  }

  if (MOODLE_MOCK) {
    return mockGetCourseCompletionStatus(moodleUserId, moodleCourseId);
  }

  try {
    const result = await moodleRequest('core_completion_get_course_completion_status', {
      courseid: moodleCourseId,
      userid:   moodleUserId
    });
    const cs = result && result.completionstatus;
    if (!cs) return { completed: false, timecompleted: 0, statustext: '' };
    const completed = Boolean(cs.timecompleted && cs.timecompleted > 0);
    return {
      completed,
      timecompleted: cs.timecompleted || 0,
      statustext:    cs.statustext    || ''
    };
  } catch (err) {
    return { error: err.message };
  }
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function generateMoodlePassword() {
  const base = crypto.randomBytes(12).toString('base64').replace(/[+/=]/g, 'X');
  return `M!${base}1a`;
}

/**
 * Fetch all courses from Moodle.
 * Returns { courses: [{ id, shortname, fullname, summary, visible }] } or { error }.
 * Uses Moodle WS: core_course_get_courses (empty options = all courses, skips site course id=1)
 */
async function getCourses() {
  if (MOODLE_MOCK) {
    return {
      courses: [
        { id: 2, shortname: 'JAVA-01', fullname: 'Certificación Java Developer', summary: 'Curso de Java', visible: 1 },
        { id: 3, shortname: 'AWS-01',  fullname: 'Certificación AWS Solutions Architect', summary: '', visible: 1 },
        { id: 4, shortname: 'PMP-01',  fullname: 'Certificación PMP Project Management', summary: '', visible: 1 }
      ]
    };
  }

  try {
    const result = await moodleRequest('core_course_get_courses', {});
    if (!Array.isArray(result)) return { error: 'Respuesta inesperada de Moodle' };
    // Filter out the site course (id=1)
    const courses = result
      .filter(c => c.id !== 1)
      .map(c => ({
        id:        c.id,
        shortname: c.shortname,
        fullname:  c.fullname,
        summary:   c.summary ? c.summary.replace(/<[^>]*>/g, '').trim() : '',
        visible:   c.visible
      }));
    return { courses };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Test Moodle connection using core_webservice_get_site_info.
 * Returns { ok: true, sitename, username } or { error }.
 */
async function testConnection() {
  if (MOODLE_MOCK) {
    return { ok: true, sitename: 'Moodle Mock', username: 'mock_user' };
  }
  try {
    const info = await moodleRequest('core_webservice_get_site_info', {});
    return { ok: true, sitename: info.sitename, username: info.username };
  } catch (err) {
    return { error: err.message };
  }
}

function isMockMode() {
  return MOODLE_MOCK;
}

module.exports = {
  enrollStudent,
  findUserByEmail,
  createUser,
  enrollUserInCourse,
  getCourseCompletionStatus,
  getCourses,
  testConnection,
  isMockMode
};
