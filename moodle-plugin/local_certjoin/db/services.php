<?php
defined('MOODLE_INTERNAL') || die();

$functions = [
    'local_certjoin_get_certificate_issues' => [
        'classname'     => 'local_certjoin_external',
        'methodname'    => 'get_certificate_issues',
        'classpath'     => 'local/certjoin/externallib.php',
        'description'   => 'Devuelve los certificados (customcert) emitidos en los cursos indicados.',
        'type'          => 'read',
        'capabilities'  => 'local/certjoin:viewcertificates',
        'ajax'          => false,
    ],
    'local_certjoin_get_enrolment_dates' => [
        'classname'     => 'local_certjoin_external',
        'methodname'    => 'get_enrolment_dates',
        'classpath'     => 'local/certjoin/externallib.php',
        'description'   => 'Devuelve la fecha de matriculacion de cada usuario indicado en un curso.',
        'type'          => 'read',
        'capabilities'  => 'local/certjoin:viewcertificates',
        'ajax'          => false,
    ],
];

// Este bloque crea un servicio externo NUEVO con esta sola funcion, por si es
// mas rapido habilitarlo asi que editar el servicio que ya usa CertJoin.
// Si prefieren agregar la funcion al servicio existente (recomendado, para no
// generar un token nuevo), pueden ignorar este bloque y hacerlo desde:
//   Administracion del sitio > Servidor > Servicios web > Servicios externos
//   > (el servicio de CertJoin) > Funciones > Agregar funciones
//   > local_certjoin_get_certificate_issues
$services = [
    'CertJoin - certificados' => [
        'functions'       => ['local_certjoin_get_certificate_issues', 'local_certjoin_get_enrolment_dates'],
        'restrictedusers' => 0,
        'enabled'         => 1,
    ],
];
