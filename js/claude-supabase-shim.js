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
 *   unavailable · resource_exhausted · store_unavailable · declined
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
    auth: { persistSession: true, autoRefreshToken: true }
  });

  /* ---- identidad anónima -------------------------------------------------
   * El runtime de Claude da una identidad por cuenta. Aquí usamos una sesión
   * anónima de Supabase, que es estable por dispositivo/navegador.           */
  var signedIn = null;
  function ensureAuth() {
    if (signedIn) return signedIn;
    signedIn = sb.auth.getSession().then(function (r) {
      if (r && r.data && r.data.session) return r.data.session.user.id;
      return sb.auth.signInAnonymously().then(function (r2) {
        if (r2.error) throw err('unavailable', r2.error.message);
        return r2.data.user.id;
      });
    });
    return signedIn;
  }

  /* ---- writes en vuelo (para snap.metadata.hasPendingWrites) ------------- */
  var pending = 0;
  var listeners = []; // { table, fire }

  function bump(d) {
    pending = Math.max(0, pending + d);
    listeners.forEach(function (l) { l.fire(false); });
  }

  function mapErr(e) {
    var m = (e && e.message) || '';
    if (/rate|too many/i.test(m)) return err('resource_exhausted', m);
    if (/row-level security|permission|denied/i.test(m)) return err('not_granted', m);
    return err('unavailable', m || 'network');
  }

  /* ---- db ---------------------------------------------------------------- */
  function collRef(name) {
    var table = TABLES[name];
    if (!table) throw err('unavailable', 'colección desconocida: ' + name);

    return {
      // onSnapshot: carga inicial + realtime. Ante cualquier cambio se
      // recarga la colección completa (son pocos docs: es simple y correcto).
      onSnapshot: function (cb, onErr) {
        var dead = false;
        var served = false;

        function fire(fromServer) {
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

        var cache = [];
        var lis = { table: table, fire: fire };
        listeners.push(lis);

        function load() {
          return sb.from(table).select('id,data').then(function (r) {
            if (dead) return;
            if (r.error) { if (onErr) onErr(mapErr(r.error)); return; }
            cache = r.data || [];
            served = true;
            fire(true);
          });
        }

        ensureAuth().then(load).catch(function (e) { if (onErr) onErr(e); });

        var ch = sb
          .channel('wepa-' + table + '-' + Math.random().toString(36).slice(2))
          .on('postgres_changes', { event: '*', schema: 'public', table: table }, load)
          .subscribe();

        return function unsubscribe() {
          dead = true;
          listeners = listeners.filter(function (x) { return x !== lis; });
          try { sb.removeChannel(ch); } catch (e) {}
        };
      },

      // .doc() sin argumento = nuevo id (como Firestore)
      doc: function (id) {
        return docRef(name, id || newId());
      }
    };
  }

  function newId() {
    return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function docRef(coll, id) {
    var table = TABLES[coll];
    if (!table) throw err('unavailable', 'colección desconocida: ' + coll);

    return {
      id: id,

      set: function (data) {
        bump(1);
        return ensureAuth()
          .then(function () {
            return sb.from(table).upsert({ id: id, data: data }, { onConflict: 'id' });
          })
          .then(function (r) { if (r.error) throw mapErr(r.error); return true; })
          .finally(function () { bump(-1); });
      },

      delete: function () {
        bump(1);
        return ensureAuth()
          .then(function () { return sb.from(table).delete().eq('id', id); })
          .then(function (r) { if (r.error) throw mapErr(r.error); return true; })
          .finally(function () { bump(-1); });
      },

      onSnapshot: function (cb, onErr) {
        var dead = false;

        function emit(row) {
          if (dead) return;
          cb({
            exists: !!row,
            data: function () { return (row && row.data) || {}; }
          });
        }

        function load() {
          return sb.from(table).select('id,data').eq('id', id).maybeSingle().then(function (r) {
            if (dead) return;
            if (r.error) { if (onErr) onErr(mapErr(r.error)); return; }
            emit(r.data);
          });
        }

        ensureAuth().then(load).catch(function (e) { if (onErr) onErr(e); });

        var ch = sb
          .channel('wepa-doc-' + table + '-' + id + '-' + Math.random().toString(36).slice(2))
          .on('postgres_changes', { event: '*', schema: 'public', table: table, filter: 'id=eq.' + id }, load)
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
      var ext = /png/.test(type) ? 'png' : /webp/.test(type) ? 'webp' : 'jpg';
      var id = newId() + '.' + ext;
      return ensureAuth()
        .then(function () {
          return sb.storage.from(BUCKET).upload(id, blob, { contentType: type, upsert: false });
        })
        .then(function (r) {
          if (r.error) {
            var m = r.error.message || '';
            if (/not found|bucket/i.test(m)) throw err('store_unavailable', m);
            throw mapErr(r.error);
          }
          return { id: id };
        });
    },

    delete: function (id) {
      return ensureAuth()
        .then(function () { return sb.storage.from(BUCKET).remove([id]); })
        .then(function (r) { if (r.error) throw mapErr(r.error); return true; });
    }
  };

  // La app pide las fotos como '/_blob/<id>'. Aquí las mandamos al bucket.
  window.WEPA_BLOB_URL = function (id) {
    return URL_ + '/storage/v1/object/public/' + BUCKET + '/' + encodeURIComponent(id);
  };

  /* ---- user -------------------------------------------------------------- */
  var user = {
    id: function () { return ensureAuth(); },
    // En Pages no hay dueño/invitados: cualquiera con el enlace puede escribir.
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
    use: function (name) {
      return API[name] || null;
    }
  };
})();
