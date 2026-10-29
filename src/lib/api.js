// Data access. All authorization happens in the database (RLS + checked functions);
// the UI only hides what a role cannot use.
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from '../config.js';
import { friendlyError } from './format.js';

export const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

export class AppError extends Error {
  constructor(raw) { super(friendlyError(raw)); this.raw = raw; }
}

export async function rpc(name, args = {}) {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw new AppError(error);
  return data;
}

// Run a query builder and unwrap; throws AppError on failure.
export async function run(builder) {
  const { data, error, count } = await builder;
  if (error) throw new AppError(error);
  return count !== undefined && count !== null ? { data, count } : data;
}

export const state = {
  session: null,
  ctx: null,         // { user_id, email, full_name, roles[], person_id, settings }
  people: null,      // staff-only cache: [{ ...person, roles: ['driver','washer'] }]
  categories: null,
};

export const roles = {
  has: (r) => !!state.ctx && state.ctx.roles.includes(r),
  get admin() { return roles.has('admin'); },
  get staff() { return roles.has('admin') || roles.has('dispatcher'); },
  get field() { return roles.has('driver') || roles.has('volunteer'); },
  get kiosk() { return roles.has('kiosk'); },
  // A tablet login that can do nothing but the walk-up screen.
  get kioskOnly() { return roles.kiosk && !roles.staff && !roles.field; },
};

export function tz() { return state.ctx?.settings?.time_zone || 'America/New_York'; }
export function settings() { return state.ctx?.settings || {}; }

export async function loadContext() {
  state.ctx = await rpc('my_context');
  return state.ctx;
}

export async function loadPeople(force = false) {
  if (state.people && !force) return state.people;
  const [people, pr] = await Promise.all([
    run(sb.from('people').select('*').order('full_name')),
    run(sb.from('person_roles').select('person_id, role, active')),
  ]);
  const byId = new Map(people.map((p) => [p.id, { ...p, roles: [] }]));
  for (const r of pr) if (r.active && byId.has(r.person_id)) byId.get(r.person_id).roles.push(r.role);
  state.people = Array.from(byId.values());
  return state.people;
}

export function personName(id) {
  if (!id) return '';
  const p = state.people?.find((x) => x.id === id);
  return p ? p.full_name : '';
}

export function peopleWithRole(role, { includeInactive = false } = {}) {
  return (state.people || []).filter((p) => p.roles.includes(role) && (includeInactive || p.active));
}

export async function loadCategories(force = false) {
  if (state.categories && !force) return state.categories;
  state.categories = await run(sb.from('client_categories').select('*').order('sort_order'));
  return state.categories;
}

export function categoryLabel(id) {
  return state.categories?.find((c) => c.id === id)?.label || id || '';
}

export function invalidate() { state.people = null; state.categories = null; }
