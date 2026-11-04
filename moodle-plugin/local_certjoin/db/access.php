<?php
// Capability propia, de solo lectura, a nivel de sistema. No reutiliza un
// permiso amplio como moodle/site:config: el rol de Web Services de CertJoin
// solo necesita este permiso para usar la funcion nueva.
defined('MOODLE_INTERNAL') || die();

$capabilities = [
    'local/certjoin:viewcertificates' => [
        'captype'      => 'read',
        'contextlevel' => CONTEXT_SYSTEM,
        'archetypes'   => [
            'manager' => CAP_ALLOW,
        ],
    ],
];
