<?php
// Plugin local_certjoin: expone, por Web Services, los certificados (customcert)
// emitidos en los cursos indicados. Solo lectura, sin datos personales mas alla
// del userid (nombre/correo ya se resuelven con core_user_get_users_by_field,
// que el token de CertJoin ya usa).
defined('MOODLE_INTERNAL') || die();

$plugin->component = 'local_certjoin';
$plugin->version   = 2026110400;
$plugin->requires  = 2020110900; // Moodle 3.10 o superior.
$plugin->maturity  = MATURITY_STABLE;
$plugin->release   = '1.0';
