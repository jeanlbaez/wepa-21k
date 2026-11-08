# Wepa 21K

App del grupo para el **medio maratón LOLA Challenge** — San Juan, domingo 8 de
noviembre de 2026, salida 4:00 a.m. desde el Balneario El Escambrón.

Una sola página, sin build, sin dependencias que compilar. Funciona en el
teléfono y se puede guardar en la pantalla de inicio.

## Qué trae

**Guía de carrera** (funciona siempre, incluso sin internet después de la
primera carga):

- Cuenta regresiva a la salida y horario de la madrugada
- Los 9 oasis en orden, con baños marcados, y un check para ir tachándolos
- Cómo llegar: Tren Urbano, guaguas, y qué entrada te toca según tu wave
- Tips para un 21K de madrugada con calor y humedad
- Qué llevar y qué pasa después de la meta

**Tablero del grupo** (necesita conexión y configuración, ver abajo):

- Corredores con BIB, wave, pronóstico y tiempo oficial
- Tabla de posiciones, podio y medallas (PR, debut, split negativo, sub-X…)
- El **Oráculo**: quién le atinó más a su propio pronóstico
- **¡Wepa!** — reacciones para echarle porras a cada quien
- Álbum de fotos del grupo y generador de tarjeta de finisher

## Importante: de dónde salen los datos del tablero

Esta app se escribió originalmente como **Artifact de Claude**. Allí el tablero
compartido y las fotos usan el runtime de Claude:

```js
window.claude.use('db')        // base de datos compartida, en tiempo real
window.claude.use('assets')    // fotos, servidas en /_blob/<id>
window.claude.use('user')      // identidad y permisos
window.claude.use('downloads') // guardar archivos
```

**En GitHub Pages ese objeto no existe.** Sin nada más, la app detecta que no
hay base de datos y degrada sola: la guía de carrera sigue perfecta, pero el
tablero muestra *«Sin acceso a los datos del grupo»* y las fotos no cargan.

Para que subir y guardar funcione en Pages, este repo incluye un adaptador:

| archivo | qué hace |
|---|---|
| `js/claude-supabase-shim.js` | Reimplementa la misma API (`db`, `assets`, `user`, `downloads`) sobre Supabase. Si la app corre dentro de Claude, se retira y no toca nada. |
| `js/config.js` | Los dos valores públicos de tu proyecto de Supabase. |
| `supabase/schema.sql` | Tablas, realtime, bucket de fotos y RLS. Se corre una vez. |

`index.html` quedó casi intacto: solo se le añadieron tres `<script>` y se hizo
pluggable la línea de `blobUrl`. Sigue funcionando igual dentro de Claude.

## Configurar Supabase (una vez, ~10 minutos)

1. Crea una cuenta gratis en [supabase.com](https://supabase.com) y un proyecto
   nuevo. No pide tarjeta.
2. **SQL Editor → New query**, pega todo `supabase/schema.sql` y dale **Run**.
   Si alguna línea de `alter publication` se queja de que la tabla ya estaba
   añadida, ignóralo y sigue.
3. **Project Settings → API**, copia:
   - *Project URL*
   - *anon public* key
4. Pégalos en `js/config.js` y haz commit.

Los dos valores son públicos y se pueden publicar sin problema — la seguridad
la da el RLS, no el secreto de la llave. **Nunca** pongas ahí la
`service_role` key.

### Modelo de seguridad

Tal como está el `schema.sql`, **cualquiera con el enlace puede escribir y
borrar**. Para un grupo de corredores está bien. Si el enlace se vuelve
público de verdad, al final de `schema.sql` hay un bloque comentado para
cerrar la escritura con una clave de grupo.

## Correrlo local

No hace falta build. Cualquier servidor estático:

```bash
python3 -m http.server 8080
```

Y abre `http://localhost:8080`.

## Estado

**La guía de carrera** — probada en pantalla de teléfono, sin errores de JS.
Cuenta regresiva, horario, oasis, waves y checklist funcionando.

**El adaptador de Supabase** — probado hasta donde se puede sin un proyecto
real. Con una config falsa:

- el shim se instala y la app lo acepta como backend
  (`user.can('data.write')` → el tablero se vuelve escribible)
- se abren los 3 canales de realtime y las 3 llamadas REST esperadas
- no hay excepciones de JS ni promesas rechazadas sin manejar
- cuando la red falla, la app cae en su estado de «sin conexión» sin romperse

Lo que **falta probar** y hay que hacer antes de confiarle nada importante:
una pasada de punta a punta contra un proyecto de verdad — añadir un corredor,
darle un ¡Wepa! y subir una foto **desde dos teléfonos distintos**, para ver
que el realtime llega a los dos lados y que la foto se engancha al corredor.

Ese último punto es el que más importa: el bug de los ids con extensión ya
hizo exactamente eso una vez (foto subida, foto perdida, cero error visible).

## Créditos

Datos de ruta, horario y oasis tomados de la guía oficial del corredor del
[LOLA Challenge](https://www.lolachallenge.com). El esquema de la ruta es
simplificado y no está a escala; la organización puede cambiarla el día del
evento.
