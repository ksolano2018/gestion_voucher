# local_certjoin — Web Service de certificados para CertJoin

Plugin mínimo, de solo lectura, que agrega **dos funciones de Web Service** a
Moodle: `local_certjoin_get_certificate_issues` y
`local_certjoin_get_enrolment_dates`. No modifica nada, no escribe en la base
de datos, y no expone nombre ni correo de los alumnos: solo el `userid`
(CertJoin ya resuelve nombre/correo con una función que su token ya tiene
autorizada, `core_user_get_users_by_field`).

## Qué hace

### `local_certjoin_get_certificate_issues`
Devuelve los certificados (plugin `customcert`) emitidos en los cursos que se
le indiquen.

**Entrada:**
```json
{ "courseids": [19, 20, 28, 104] }
```

**Salida**, una fila por certificado emitido:
```json
[
  {
    "courseid": 104,
    "customcertid": 7,
    "customcertname": "Ethical Hacking Certified Associate",
    "userid": 11,
    "code": "7cDy5nAdJ2",
    "timecreated": 1759708800
  }
]
```

Si un alumno no tiene certificado en ese curso, simplemente no aparece una fila
para él — no hace falta un campo "sí/no".

### `local_certjoin_get_enrolment_dates`
Devuelve la fecha de matriculación (la más antigua, si el alumno quedó
inscrito por más de un método en el mismo curso) de cada usuario indicado, en
un curso dado.

**Entrada:**
```json
{ "courseid": 104, "userids": [11, 12, 15] }
```

**Salida:**
```json
[
  { "userid": 11, "timecreated": 1757462400 },
  { "userid": 12, "timecreated": 1757548800 }
]
```

Si un usuario indicado no está matriculado en ese curso, simplemente no
aparece una fila para él.

## Instalación (primera vez)

1. Copiar esta carpeta completa a `<raiz_de_moodle>/local/certjoin` (el nombre
   de la carpeta debe quedar `certjoin`, no `local_certjoin`).
2. Entrar como administrador a **Administración del sitio** → Moodle detecta
   el plugin nuevo y pide confirmar la instalación.
3. Dar de alta las funciones en el Web Service que ya usa CertJoin
   (recomendado, para no generar un token nuevo):
   - **Administración del sitio → Servidor → Servicios web → Servicios externos**
   - Abrir el servicio que usa CertJoin (el mismo del token que ya nos
     compartieron).
   - En **Funciones**, agregar `local_certjoin_get_certificate_issues` y
     `local_certjoin_get_enrolment_dates`.
   - *(Probado en un ensayo local: si la instalación es nueva, Moodle agrega
     las funciones solo al crear el servicio — este paso es, igual, un buen
     chequeo para confirmar que quedaron.)*
4. Confirmar que el rol del usuario de Web Services (el que genera el token)
   tenga el permiso nuevo **"Ver certificados emitidos"**
   (`local/certjoin:viewcertificates`). Si ese usuario tiene el rol
   **Manager**, ya lo tiene por defecto.
5. No hace falta generar un token nuevo: el mismo que ya usa CertJoin funciona
   en cuanto las funciones queden agregadas a su servicio.

## Actualización (ya está instalado y solo cambió el código)

1. Reemplazar `<raiz_de_moodle>/local/certjoin` por el contenido de este
   paquete (o subir el `.zip` desde **Plugins → Instalar plugins**, Moodle
   detecta que ya existe y ofrece actualizarlo).
2. Entrar como administrador a **Administración del sitio** → Moodle corre el
   script de actualización (`$plugin->version` subió, por eso detecta el
   cambio).
3. Si se agregó una función nueva (como `local_certjoin_get_enrolment_dates`
   en esta versión), Moodle normalmente la agrega solo al servicio existente
   al correr la actualización (confirmado en un ensayo local). Igual conviene
   verificarlo: **Administración del sitio → Servidor → Servicios web →
   Servicios externos** → abrir el servicio de CertJoin → **Funciones** →
   confirmar que `local_certjoin_get_enrolment_dates` esté en la lista. Si no
   aparece, agregarla ahí manualmente (paso 3 de instalación arriba).

## Cómo probarlo

Con el mismo token y el mismo dominio que ya usa CertJoin:

```bash
curl -s -X POST "https://campus.certjoin.com/webservice/rest/server.php" \
  --data-urlencode "wstoken=EL_TOKEN_DE_CERTJOIN" \
  --data-urlencode "wsfunction=local_certjoin_get_certificate_issues" \
  --data-urlencode "moodlewsrestformat=json" \
  --data-urlencode "courseids[0]=104"
```

Si todo quedó bien, responde con un arreglo JSON (puede venir vacío `[]` si
ese curso no tiene certificados emitidos). Si responde
`"errorcode":"accessexception"`, falta agregar la función al servicio o el
permiso al rol (pasos 3 y 4).

## Desinstalación

Si en algún momento quieren quitarlo: **Administración del sitio → Plugins →
Administrar plugins**, buscar "CertJoin - integración de certificados" y
desinstalar. No deja tablas propias en la base de datos (no usa `install.xml`),
así que la desinstalación es limpia.
