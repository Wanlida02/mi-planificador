# Mi Planificador

Calendario semanal interactivo para planificar tareas encima de:

- **Programación anual de trabajo** (`Programación Anual 2026.xlsx`): los días con tus iniciales (**FS**) bloquean
  - viaje de varios días (celda combinada o mismo destino en días seguidos) → **07:00–17:00** cada día
  - jornada de un día → **07:00–15:00**
  - los festivos de la hoja aparecen arriba, como eventos de todo el día
- **Calendarios de iCloud**: “Familia” (Luna) en **rosa pastel** y “Calendar” (personal) en lila.
- **Tus tareas**: **azul** si están pendientes y **verde** si están hechas. Se pueden arrastrar (entre días o dentro del mismo día), alargar o acortar tirando del borde inferior y editar con doble clic (en el móvil, doble toque).
- **Pestaña Pendientes**: tablero por prioridad (Alta / Media / Baja / Sin clasificar). Arrastra las tarjetas para clasificarlas y pulsa **Programar** (o **⚡ Próximo hueco libre**) para llevarlas al calendario.
- **Google Tasks**: importa las tareas que quieras. Al marcarlas como hechas aquí, también se completan en Google.
- **Sincronización** entre iPhone y ordenador mediante un archivo oculto en tu Google Drive (carpeta *appData*, que no ves en Drive).

No hay servidor ni base de datos: todo vive en tu navegador y en tu Google Drive. El repositorio no contiene datos personales.

---

## Configuración (una sola vez)

### 1. Abrir la app
`https://wanlida02.github.io/mi-planificador/`

En el iPhone: Safari → Compartir → **Añadir a pantalla de inicio**, para usarla como una app.

### 2. Cargar la programación anual
⚙︎ Ajustes → **Programación anual** → elige `Programación Anual 2026.xlsx` desde iCloud Drive.
Cuando llegue la de 2027, cárgala igual: se sustituyen los años que traiga el archivo y se conservan los demás.
Si el Excel cambia, vuelve a cargarlo.

### 3. Calendarios de iCloud (Familia y Calendar)
1. iPhone → app Calendario → **Calendarios** → (i) junto a **Familia** → activa **Calendario público** → **Compartir enlace…** → Copiar.
2. Repite con **Calendar**.
3. En ⚙︎ Ajustes → *Calendarios de iCloud* → **+ Añadir calendario**. Pega cada enlace y elige la categoría: *Luna/Familia* o *Personal*.

> Por seguridad, el navegador no deja que una web lea directamente los calendarios de iCloud (CORS).
> Hace falta un pequeño **proxy** gratuito en Cloudflare, que solo acepta direcciones de `icloud.com`:
>
> 1. Crea una cuenta gratuita en <https://dash.cloudflare.com> → **Workers & Pages** → **Create** → **Create Worker**.
> 2. Ponle un nombre (p. ej. `ics-proxy`) → **Deploy** → **Edit code**. Pega el contenido de [`worker/ics-proxy.js`](worker/ics-proxy.js) → **Deploy**.
> 3. Copia la URL (`https://ics-proxy.<tu-cuenta>.workers.dev`) en ⚙︎ Ajustes → *Proxy para iCloud*.
>
> Los enlaces públicos de iCloud son difíciles de adivinar, pero cualquiera que tenga uno puede ver ese calendario. No los compartas.

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
| Mover tarea | Arrastrar | Mantener pulsado y arrastrar |
| Cambiar duración | Arrastra el borde inferior | Arrastra el borde inferior |
| Editar (título, día, hora, duración…) | Doble clic | Doble toque |
| Marcar como hecha | Casilla de la tarea | Casilla de la tarea |
| Programar desde Pendientes | Arrastrar desde el panel lateral, botón *Programar* o ⚡ | Botón *Programar* o ⚡ |
| Navegar | ← → para cambiar de semana, `T` para hoy, `N` para nueva tarea | ‹ › |

En el ordenador ves la semana completa; en el móvil, 3 días.

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
