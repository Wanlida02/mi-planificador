# Mi Planificador

Calendario semanal interactivo para planificar tareas encima de:

- **Programación anual de trabajo** (`Programación Anual 2026.xlsx`): los días con tus iniciales (**FS**) bloquean
  - viaje de varios días (celda combinada o mismo destino en días seguidos) → **07:00–17:00** cada día
  - jornada de un día → **07:00–15:00**
  - los festivos de la hoja aparecen arriba, como eventos de todo el día
  - las celdas **tachadas** (relleno con rayas diagonales o trama) se consideran **canceladas** y se ignoran
  - recordatorio para actualizarla cada semana y lectura automática del archivo local en el ordenador
- **Avisos de solapes**: si un día de trabajo coincide con una cita (médico, pilates…), con una tarea programada o con otro trabajo, aparece el botón ⚠︎ arriba, el bloque se marca en rojo y llega una notificación (cuando la app se abre o se actualiza)
- **Calendarios de iCloud**: “Familia” (Luna) en **rosa pastel** y “Calendar” (personal) en lila.
- **Tus tareas**: **azul** si están pendientes y **verde** si están hechas. Se pueden arrastrar (entre días o dentro del mismo día), alargar o acortar tirando del borde inferior y editar con doble clic (en el móvil, doble toque).
- **Pestaña Pendientes**: tablero por prioridad (Alta / Media / Baja / Sin clasificar). Arrastra las tarjetas para clasificarlas y pulsa **Programar** (o **⚡ Próximo hueco libre**) para llevarlas al calendario.
- **Google Tasks**: se traen solas al sincronizar (las que tienen fecha aparecen ese día; Google no comparte la hora). También puedes importarlas a mano con prioridad. Al marcarlas como hechas aquí, también se completan en Google.
- **Sincronización** entre iPhone y ordenador mediante un archivo oculto en tu Google Drive (carpeta *appData*, que no ves en Drive).

No hay servidor ni base de datos: todo vive en tu navegador y en tu Google Drive. El repositorio no contiene datos personales.

---

## Configuración (una sola vez)

### 1. Abrir la app
`https://wanlida02.github.io/mi-planificador/`

En el iPhone: Safari → Compartir → **Añadir a pantalla de inicio**, para usarla como una app.

### 2. Cargar la programación anual
⚙︎ Ajustes → **Programación anual** → elige `Programación Anual 2026.xlsx` desde iCloud Drive.
**Mantenerla al día** (el original está en el Teams del trabajo):
- **Manual (iPhone u ordenador)**: descarga el Excel de Teams y cárgalo. Si pasan más de 7 días (configurable) sin actualizarla, aparece arriba el botón **📄 Actualizar programación**: un toque y eliges el archivo.
- **Automática en el ordenador (Edge/Chrome)**: en Teams, en la carpeta del canal, pulsa **Sincronizar** (o *Agregar acceso directo a Mis archivos*) para que OneDrive mantenga una copia local. En ⚙︎ Ajustes → **📌 Elegir y recordar archivo del ordenador** elige esa copia. La app la relee cada vez que se abre y, si cambió, actualiza la programación (y se sincroniza al iPhone mediante Google). Si el navegador pide permiso de nuevo, sale el botón **📄 Releer programación**.
- *Alternativa*: enlace de iCloud Drive (en Ajustes, apartado plegado), con el Worker del paso 3.

Cuando llegue la de 2027, cárgala igual: se sustituyen los años que traiga el archivo y se conservan los demás.
Si el Excel cambia, vuelve a cargarlo.

### 3. Calendarios de iCloud (Familia y Calendar)
1. iPhone → app Calendario → **Calendarios** → (i) junto a **Familia** → activa **Calendario público** → **Compartir enlace…** → Copiar.
2. Repite con **Calendar**.
3. En ⚙︎ Ajustes → *Calendarios de iCloud* → **+ Añadir calendario**. Pega cada enlace y elige la categoría: *Luna/Familia* o *Personal*.

> Por seguridad, el navegador no deja que una web lea directamente los calendarios de iCloud (CORS).
> Hace falta un pequeño **proxy** gratuito en Cloudflare, que solo acepta direcciones de iCloud (sirve también para descargar el Excel a diario):
>
> 1. Crea una cuenta gratuita en <https://dash.cloudflare.com> → **Workers & Pages** → **Create** → **Create Worker**.
> 2. Ponle un nombre (p. ej. `ics-proxy`) → **Deploy** → **Edit code**. Pega el contenido de [`worker/ics-proxy.js`](worker/ics-proxy.js) → **Deploy**.
> 3. Copia la URL (`https://ics-proxy.<tu-cuenta>.workers.dev`) en ⚙︎ Ajustes → *Proxy para iCloud*.
>
> Los enlaces públicos de iCloud son difíciles de adivinar, pero cualquiera que tenga uno puede ver ese calendario. No los compartas.

### 3b. Mover eventos de iCloud desde la app (opcional)
Los enlaces públicos solo permiten **ver**. Para **mover** eventos, el worker se conecta a tu iCloud (CalDAV):

1. **Contraseña específica de app**: <https://account.apple.com> → *Inicio de sesión y seguridad* → **Contraseñas específicas de app** → «+» → nombre `Planificador` → copia la contraseña (`xxxx-xxxx-xxxx-xxxx`). No es la contraseña de tu Apple ID y puedes revocarla cuando quieras.
2. **Código privado**: en la app, ⚙︎ → *Mover eventos de iCloud* → **🎲 Generar código** (se copia solo).
3. **Secretos del worker**: Cloudflare → *Workers & Pages* → `ics-proxy` → **Settings** → **Variables and Secrets** → **+ Add** (tipo **Secret**) tres veces:
   - `ICLOUD_USER` = el email de tu Apple ID
   - `ICLOUD_APP_PASSWORD` = la contraseña del paso 1
   - `PLANNER_TOKEN` = el código del paso 2
   → **Deploy**.
4. Vuelve a pegar el código de [`worker/ics-proxy.js`](worker/ics-proxy.js) en el worker (**Edit code** → **Deploy**), porque esta versión es nueva.
5. En la app: ⚙︎ → **🔌 Probar conexión** → debe listar tus calendarios. **Guardar**.

A partir de ahí, los eventos de iCloud se mueven igual que las tareas: arrastrándolos, con **⇄ Mover** en su detalle o con los botones día antes/después y ±15 min/±1 h. En los eventos que se repiten solo se mueve ese día. El cambio se guarda en tu iCloud. El enlace público tarda unos minutos en reflejarlo; mientras tanto la app lo muestra ya movido, con borde punteado.

### 4. Google (Tasks + sincronización)
Necesitas un *Client ID* de OAuth propio (gratuito):

1. <https://console.cloud.google.com> → crea un proyecto (p. ej. “Planificador”).
2. **APIs y servicios → Biblioteca**: habilita **Google Tasks API** y **Google Drive API**.
3. **Pantalla de consentimiento de OAuth** (Google Auth Platform): tipo **Externo**; en **Público** añade tu Gmail como *usuario de prueba*.
4. **Credenciales → Crear credenciales → ID de cliente de OAuth** → tipo **Aplicación web**.
   - *Orígenes de JavaScript autorizados*: `https://wanlida02.github.io`
5. Copia el *Client ID* (`….apps.googleusercontent.com`) en ⚙︎ Ajustes → *Google* → **Conectar con Google**.

Haz lo mismo en cada dispositivo (pegar el Client ID y conectar). A partir de ahí, el botón **Google** de arriba sincroniza. El punto de color indica el estado: verde = sincronizado, naranja = cambios pendientes de subir. La sesión de Google dura 1 hora; al volver a la app, pulsa el botón para reconectar.

---

## Uso rápido

| Acción | Ordenador | iPhone |
|---|---|---|
| Crear tarea en un hueco | Arrastra en un hueco vacío o haz doble clic | Doble toque en el hueco |
| Agenda de hoy y mañana | Pestaña **Hoy** | Pestaña **Hoy** |
| Bloquear agenda (p. ej. llevar a Luna al cole) | **＋ Nuevo** → «🔒 Bloqueo de agenda» | Igual |
| Cambiar de semana | ‹ › o ← → | ‹ › o deslizar a izquierda/derecha |
| Ver detalle (evento o tarea) | Clic | Un toque |
| Mover tarea | Arrastrar, o detalle → **⇄ Mover** y clic en el hueco | Mantener pulsado y arrastrar, o detalle → **⇄ Mover** y tocar el hueco |
| Ajustes rápidos | Detalle: día antes/después, ±15 min, más corta/larga, próximo hueco | Igual |
| Cambiar duración | Arrastra el borde inferior | Arrastra el borde inferior |
| Editar (título, día, hora, duración…) | Doble clic | Doble toque |
| Marcar como hecha | Casilla de la tarea | Casilla de la tarea |
| Programar desde Pendientes | Arrastrar desde el panel lateral, botón *Programar* o ⚡ | Botón *Programar* o ⚡ |
| Navegar | ← → para cambiar de semana, `T` para hoy, `N` para nueva tarea | ‹ › |
| Cambiar de vista | Día / 3 días / Semana (o clic en un día) | Igual (toque en un día) |
| Zoom de horas | Botones − / + | Pellizcar con dos dedos o − / + |
| Tareas sin programar | Panel lateral «Por programar» | Bandeja de abajo; botón + para crear |

La vista y el zoom elegidos se recuerdan en cada dispositivo.

## Desarrollo
Es una web estática sin compilación (HTML + JS en módulos). Para probarla en local:

```bash
python3 -m http.server 8000
```

- `js/programacion.js` – lector del Excel (bloques mensuales, celdas combinadas, iniciales)
- `js/ics.js` / `js/feeds.js` – calendarios iCloud (.ics, eventos que se repiten, excepciones)
- `js/google.js` – Google Identity, Drive appData y Google Tasks
- `js/store.js` – estado, guardado local y fusión con Drive (gana el último cambio de cada tarea)
- `js/main.js` – interfaz: semana, arrastrar y redimensionar, pendientes y ajustes
