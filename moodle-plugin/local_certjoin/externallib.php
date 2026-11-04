<?php
// Funcion de Web Service de solo lectura: dado un listado de ids de curso,
// devuelve los certificados (plugin mod_customcert) emitidos en ellos.
//
// No expone nombre, correo ni ningun otro dato del usuario: solo su userid.
// CertJoin ya resuelve nombre/correo con core_user_get_users_by_field, que su
// token de Web Services ya tiene autorizado.
defined('MOODLE_INTERNAL') || die();

require_once($CFG->libdir . '/externallib.php');

class local_certjoin_external extends external_api {

    public static function get_certificate_issues_parameters() {
        return new external_function_parameters([
            'courseids' => new external_multiple_structure(
                new external_value(PARAM_INT, 'Id de curso de Moodle'),
                'Lista de ids de curso a consultar',
                VALUE_DEFAULT,
                []
            ),
        ]);
    }

    public static function get_certificate_issues($courseids) {
        global $DB;

        $params = self::validate_parameters(self::get_certificate_issues_parameters(), [
            'courseids' => $courseids,
        ]);
        $courseids = $params['courseids'];

        // Permiso de solo lectura, a nivel de sistema (ver db/access.php).
        $context = context_system::instance();
        self::validate_context($context);
        require_capability('local/certjoin:viewcertificates', $context);

        if (empty($courseids)) {
            return [];
        }

        // Si el plugin mod_customcert no esta instalado, no hay nada que devolver
        // (evita un error de SQL en vez de fallar silenciosamente con una lista vacia).
        if (!$DB->get_manager()->table_exists('customcert')) {
            return [];
        }

        list($insql, $inparams) = $DB->get_in_or_equal($courseids, SQL_PARAMS_NAMED, 'cid');

        $sql = "SELECT ci.id,
                       cc.course      AS courseid,
                       cc.id          AS customcertid,
                       cc.name        AS customcertname,
                       ci.userid      AS userid,
                       ci.code        AS code,
                       ci.timecreated AS timecreated
                  FROM {customcert_issues} ci
                  JOIN {customcert} cc ON cc.id = ci.customcertid
                 WHERE cc.course $insql
              ORDER BY cc.course, ci.timecreated";

        $records = $DB->get_records_sql($sql, $inparams);

        $result = [];
        foreach ($records as $r) {
            $result[] = [
                'courseid'       => (int) $r->courseid,
                'customcertid'   => (int) $r->customcertid,
                'customcertname' => (string) $r->customcertname,
                'userid'         => (int) $r->userid,
                'code'           => (string) $r->code,
                'timecreated'    => (int) $r->timecreated,
            ];
        }

        return $result;
    }

    public static function get_certificate_issues_returns() {
        return new external_multiple_structure(
            new external_single_structure([
                'courseid'       => new external_value(PARAM_INT, 'Id de curso de Moodle'),
                'customcertid'   => new external_value(PARAM_INT, 'Id del certificado (instancia de customcert)'),
                'customcertname' => new external_value(PARAM_TEXT, 'Nombre del certificado'),
                'userid'         => new external_value(PARAM_INT, 'Id del usuario que obtuvo el certificado'),
                'code'           => new external_value(PARAM_RAW, 'Codigo de verificacion del certificado'),
                'timecreated'    => new external_value(PARAM_INT, 'Fecha de emision (unix timestamp)'),
            ])
        );
    }

    public static function get_enrolment_dates_parameters() {
        return new external_function_parameters([
            'courseid' => new external_value(PARAM_INT, 'Id de curso de Moodle'),
            'userids'  => new external_multiple_structure(
                new external_value(PARAM_INT, 'Id de usuario'),
                'Ids de usuario a consultar (miembros del grupo del partner en ese curso)',
                VALUE_DEFAULT,
                []
            ),
        ]);
    }

    // Fecha de matriculacion (la mas antigua, si el usuario quedo inscrito por mas de
    // un metodo de inscripcion en el mismo curso) de cada usuario indicado en el curso.
    public static function get_enrolment_dates($courseid, $userids) {
        global $DB;

        $params = self::validate_parameters(self::get_enrolment_dates_parameters(), [
            'courseid' => $courseid,
            'userids'  => $userids,
        ]);
        $courseid = $params['courseid'];
        $userids  = $params['userids'];

        $context = context_system::instance();
        self::validate_context($context);
        require_capability('local/certjoin:viewcertificates', $context);

        if (empty($userids)) {
            return [];
        }

        list($insql, $inparams) = $DB->get_in_or_equal($userids, SQL_PARAMS_NAMED, 'uid');
        $sqlparams = array_merge($inparams, ['courseid' => $courseid]);

        $sql = "SELECT ue.userid, MIN(ue.timecreated) AS timecreated
                  FROM {user_enrolments} ue
                  JOIN {enrol} e ON e.id = ue.enrolid
                 WHERE e.courseid = :courseid
                   AND ue.userid $insql
              GROUP BY ue.userid";

        $records = $DB->get_records_sql($sql, $sqlparams);

        $result = [];
        foreach ($records as $r) {
            $result[] = [
                'userid'      => (int) $r->userid,
                'timecreated' => (int) $r->timecreated,
            ];
        }

        return $result;
    }

    public static function get_enrolment_dates_returns() {
        return new external_multiple_structure(
            new external_single_structure([
                'userid'      => new external_value(PARAM_INT, 'Id de usuario'),
                'timecreated' => new external_value(PARAM_INT, 'Fecha de matriculacion (unix timestamp), la mas antigua si hay mas de una inscripcion'),
            ])
        );
    }
}
