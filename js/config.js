/* Wepa 21K — configuración de Supabase.
 *
 * Pega aquí los dos valores de tu proyecto de Supabase:
 *   Supabase → Project Settings → API
 *
 * Los dos son públicos y se pueden publicar en GitHub sin problema.
 * La anon key NO es un secreto: la seguridad la da el RLS (ver supabase/schema.sql).
 * Nunca pegues aquí la "service_role" key.
 */
window.WEPA_CONFIG = {
  SUPABASE_URL: '',      // ej: 'https://abcdefghijklm.supabase.co'
  SUPABASE_ANON_KEY: '', // ej: 'eyJhbGciOi...'
  BUCKET: 'photos'
};
