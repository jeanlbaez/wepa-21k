/* Wepa 21K — configuración de Supabase.
 *
 * Proyecto: jeanlbaez's Project · us-east-1 (North Virginia)
 *
 * Los dos valores de abajo son públicos a propósito: están pensados para
 * viajar en el navegador de cada quien. La seguridad la dan las policies de
 * RLS que están en supabase/schema.sql, no el secreto de la llave.
 *
 * Nunca pongas aquí la "service_role" key: esa se salta el RLS entero.
 *
 * Nota: esta es una llave legacy (JWT). Supabase las retira a principios de
 * 2027, así que en algún momento habrá que migrar a una publishable key
 * (sb_publishable_...). Hasta entonces funciona igual.
 */
window.WEPA_CONFIG = {
  SUPABASE_URL: 'https://tvwwlpiwiciovkpoimrs.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR2d3dscGl3aWNpb3ZrcG9pbXJzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQxMDU0NTEsImV4cCI6MjEwOTY4MTQ1MX0.FgK8H-dyISgtPsClrxTgEOBjzVuXk-hxJxAL1La9OAU',
  BUCKET: 'photos'
};
