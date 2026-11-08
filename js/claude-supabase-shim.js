/* ============================================================================
 * Wepa 21K — adaptador Supabase para el runtime de Claude
 * ============================================================================
 *
 * La app se escribió para correr dentro de un Artifact de Claude, donde existe
 * `window.claude.use('db' | 'assets' | 'user' | 'downloads')`.
 *
 * En GitHub Pages ese objeto no existe, así que el tablero compartido y el
 * álbum de fotos quedan muertos. Este archivo reimplementa exactamente esa
 * misma superficie de API sobre Supabase, así la app (index.html) no se toca.
 *
 * Si la app corre dentro de Claude, este archivo NO hace nada: detecta que
 * `window.claude` ya existe y se retira.
 *
 * Superficie que la app usa (y que este shim implementa):
 *
 *   db.collection(name).onSnapshot(cb, err)
 *   db.collection(name).doc()            -> { id, set(), delete() }
 *   db.doc('coleccion/id').onSnapshot(cb, err)
 *   db.doc('coleccion/id').set(data)
 *   db.doc('coleccion/id').delete()
 *   assets.upload(blob, { type }) -> { id }
 *   assets.delete(id)
 *   user.id() / user.isOwner() / user.can('data.write') / user.canEdit()
 *   downloads.save({ filename, data })
 *
 * Códigos de error que la app ya sabe manejar y que aquí se respetan:
 *   unavailable · resource_exhausted · store_unavailable · not_granted
 *
 * ----------------------------------------------------------------------------
 * DOS DETALLES QUE IMPORTAN (y que costaron un bug cada uno):
 *
 * 1. Los ids de foto NO pueden llevar extensión.
 *    index.html los valida con  /^[A-Za-z0-9_-]{6,80}$/  (línea 868).
 *    Un id como "abc123.jpg" pasa el upload pero falla esa validación, así
 *    que la foto se sube al bucket y nunca se engancha al corredor: se
 *    pierde en silencio. Por eso newAssetId() no pone extensión y el tipo
 *    de contenido viaja en los metadatos del objeto.
 *
 * 2. No se usa signInAnonymously().
 *    En un proyecto nuevo de Supabase el login anónimo viene DESACTIVADO,
 *    así que pedirlo rompería todo de entrada. No hace falta: las policies
 *    de supabase/schema.sql le dan permiso al rol `anon`, que es el que
 *    corresponde a la anon key sola, sin sesión.
 *    La identidad por persona la resuelve la propia app: si user.id() no
 *    devuelve nada, index.html genera y guarda un id en localStorage
 *    (clave 'wepa21k.anon'), que es justo lo que queremos aquí.
 * ========================================================================= */
(function () {
  'use strict';

  if (window.claude) return; // corriendo dentro de Claude: no tocar nada.

  var CFG = window.WEPA_CONFIG || {};
  var URL_ = (CFG.SUPABASE_URL || '').replace(/\/+$/, '');
  var KEY = CFG.SUPABASE_ANON_KEY || '';
  var BUCKET = CFG.BUCKET || 'photos';

  // Colecciones -> tablas. Cada tabla: id text PK, data jsonb.
  var TABLES = { runners: 'runners', reactions: 'reactions', meta: 'meta' };

  function err(code, msg) {
    var e = new Error(msg || code);
    e.code = code;
    return e;
  }

  if (!URL_ || !KEY) {
    // Sin configurar: la app ya degrada sola (muestra la guía, sin tablero).
    console.warn('[wepa] Falta configurar js/config.js — el tablero compartido queda desactivado.');
    return;
  }
  if (!window.supabase || !window.supabase.createClient) {
    console.warn('[wepa] No cargó supabase-js — el tablero compartido queda desactivado.');
    return;
  }

  var sb = window.supabase.createClient(URL_, KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  /* ---- ids ---------------------------------------------------------------
   * Doc ids: libres. Asset ids: SIN extensión (ver nota 1 arriba).          */
  function rand(n) {
    var s = '';
    var abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
    for (var i = 0; i < n; i++) s += abc[Math.floor(Math.random() * abc.length)];
    return s;
  }
  function newId() {
    return 'd' + Date.now().toString(36) + rand(6);
  }
  function newAssetId() {
    // debe cumplir /^[A-Za-z0-9_-]{6,80}$/
    return 'p' + Date.now().toString(36) + rand(10);
  }

  /* ---- writes en vuelo (para snap.metadata.hasPendingWrites) ------------- */
  var pending = 0;
  var listeners = [];

  function bump(d) {
    pending = Math.max(0, pending + d);
    listeners.forEach(function (l) { l.fire(); });
  }

  function mapErr(e) {
    var m = (e && e.message) || '';
    if (/rate|too many/i.test(m)) return err('resource_exhausted', m);
    if (/row-level security|permission|denied|not authoriz/i.test(m)) return err('not_granted', m);
    return err('unavailable', m || 'network');
  }

  /* ---- db ---------------------------------------------------------------- */
  function collRef(name) {
    var table = TABLES[name];
    if (!table) throw err('unavailable', 'colección desconocida: ' + name);

    return {
      // Carga inicial + realtime. Ante cualquier cambio se recarga la
      // colección completa: son pocos documentos, y así no hay que
      // reconciliar inserts/updates/deletes a mano.
      onSnapshot: function (cb, onErr) {
        var dead = false;
        var served = false;
        var cache = [];

        function fire() {
          if (dead) return;
          cb({
            docs: cache.map(function (row) {
              return {
                id: row.id,
                exists: true,
                data: function () { return row.data || {}; }
              };
            }),
            metadata: { fromCache: !served, hasPendingWrites: pending > 0 }
          });
        }

        var lis = { fire: fire };
        listeners.push(lis);

        function load() {
          return sb.from(table).select('id,data').then(function (r) {
            if (dead) return;
            if (r.error) { if (onErr) onErr(mapErr(r.error)); return; }
            cache = r.data || [];
            served = true;
            fire();
          }, function (e) { if (onErr) onErr(mapErr(e)); });
        }

        load();

        var ch = sb
          .channel('wepa-' + table + '-' + rand(8))
          .on('postgres_changes', { event: '*', schema: 'public', table: table }, load)
          .subscribe();

        return function unsubscribe() {
          dead = true;
          listeners = listeners.filter(function (x) { return x !== lis; });
          try { sb.removeChannel(ch); } catch (e) {}
        };
      },

      // .doc() sin argumento = id nuevo (como Firestore)
      doc: function (id) {
        return docRef(name, id || newId());
      }
    };
  }

  function docRef(coll, id) {
    var table = TABLES[coll];
    if (!table) throw err('unavailable', 'colección desconocida: ' + coll);

    return {
      id: id,

      set: function (data) {
        bump(1);
        return sb
          .from(table)
          .upsert({ id: id, data: data }, { onConflict: 'id' })
          .then(function (r) {
            bump(-1);
            if (r.error) throw mapErr(r.error);
            return true;
          }, function (e) {
            bump(-1);
            throw mapErr(e);
          });
      },

      delete: function () {
        bump(1);
        return sb
          .from(table)
          .delete()
          .eq('id', id)
          .then(function (r) {
            bump(-1);
            if (r.error) throw mapErr(r.error);
            return true;
          }, function (e) {
            bump(-1);
            throw mapErr(e);
          });
      },

      onSnapshot: function (cb, onErr) {
        var dead = false;

        function load() {
          return sb.from(table).select('id,data').eq('id', id).maybeSingle().then(function (r) {
            if (dead) return;
            if (r.error) { if (onErr) onErr(mapErr(r.error)); return; }
            cb({
              exists: !!r.data,
              data: function () { return (r.data && r.data.data) || {}; }
            });
          }, function (e) { if (onErr) onErr(mapErr(e)); });
        }

        load();

        var ch = sb
          .channel('wepa-doc-' + table + '-' + id + '-' + rand(8))
          .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: table, filter: 'id=eq.' + id },
            load
          )
          .subscribe();

        return function unsubscribe() {
          dead = true;
          try { sb.removeChannel(ch); } catch (e) {}
        };
      }
    };
  }

  var db = {
    collection: collRef,
    doc: function (path) {
      var parts = String(path).split('/');
      if (parts.length !== 2) throw err('unavailable', 'ruta inválida: ' + path);
      return docRef(parts[0], parts[1]);
    }
  };

  /* ---- assets (fotos) ---------------------------------------------------- */
  var assets = {
    upload: function (blob, opts) {
      var type = (opts && opts.type) || blob.type || 'image/jpeg';
      var id = newAssetId(); // sin extensión: ver nota 1 arriba
      return sb.storage
        .from(BUCKET)
        .upload(id, blob, { contentType: type, upsert: false, cacheControl: '31536000' })
        .then(function (r) {
          if (r.error) {
            var m = r.error.message || '';
            if (/not found|bucket/i.test(m)) throw err('store_unavailable', m);
            throw mapErr(r.error);
          }
          return { id: id };
        }, function (e) {
          throw err('store_unavailable', (e && e.message) || 'upload');
        });
    },

    delete: function (id) {
      return sb.storage.from(BUCKET).remove([id]).then(function (r) {
        if (r.error) throw mapErr(r.error);
        return true;
      });
    }
  };

  // La app pide las fotos como '/_blob/<id>'. Aquí van al bucket público.
  window.WEPA_BLOB_URL = function (id) {
    return URL_ + '/storage/v1/object/public/' + BUCKET + '/' + encodeURIComponent(id);
  };

  /* ---- user --------------------------------------------------------------
   * id() devuelve null a propósito: así index.html usa su propio id de
   * localStorage, que es estable por teléfono. Ver nota 2 arriba.           */
  var user = {
    id: function () { return Promise.resolve(null); },
    isOwner: function () { return Promise.resolve(false); },
    can: function (what) { return Promise.resolve(what === 'data.write' ? true : null); },
    canEdit: function () { return Promise.resolve(true); }
  };

  /* ---- downloads --------------------------------------------------------- */
  var downloads = {
    save: function (o) {
      try {
        var a = document.createElement('a');
        var u = URL.createObjectURL(o.data);
        a.href = u;
        a.download = o.filename || 'wepa21k';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(u); }, 10000);
        return Promise.resolve({ status: 'saved' });
      } catch (e) {
        return Promise.reject(err('declined', String(e)));
      }
    }
  };

  /* ---- instalar ---------------------------------------------------------- */
  var API = { db: db, assets: assets, user: user, downloads: downloads };
  window.claude = {
    use: function (name) { return API[name] || null; }
  };
})();
