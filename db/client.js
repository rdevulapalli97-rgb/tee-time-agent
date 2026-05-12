/**
 * db/client.js — Supabase database client
 *
 * Wraps @supabase/supabase-js with typed helpers for every table.
 * All functions return { data, error } — never throw.
 *
 * Setup:
 *   Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in your .env
 *   (Use the SERVICE ROLE key, not the anon key — this runs server-side only)
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// ─── Client ──────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: { persistSession: false },
    db:   { schema: 'public' }
  }
);

// ─── USERS ───────────────────────────────────────────────────

async function getAllActiveUsers() {
  return supabase
    .from('users')
    .select('*')
    .eq('active', true)
    .order('created_at', { ascending: true });
}

async function getUserById(userId) {
  return supabase
    .from('users')
    .select('*')
    .eq('id', userId)
    .single();
}

async function getUserByEmail(email) {
  return supabase
    .from('users')
    .select('*')
    .eq('email', email)
    .single();
}

async function createUser({ email, name, phone, plan = 'starter' }) {
  return supabase
    .from('users')
    .insert({ email, name, phone, plan })
    .select()
    .single();
}

async function updateUser(userId, updates) {
  return supabase
    .from('users')
    .update(updates)
    .eq('id', userId)
    .select()
    .single();
}

async function deactivateUser(userId) {
  return updateUser(userId, { active: false });
}

// ─── CREDENTIALS ─────────────────────────────────────────────

async function getCredentials(userId, portal = 'invited_clubs') {
  return supabase
    .from('credentials')
    .select('*')
    .eq('user_id', userId)
    .eq('portal', portal)
    .single();
}

async function upsertCredentials({ userId, portal = 'invited_clubs', username_enc, password_enc, iv, auth_tag }) {
  return supabase
    .from('credentials')
    .upsert({
      user_id: userId,
      portal,
      username_enc,
      password_enc,
      iv,
      auth_tag
    }, { onConflict: 'user_id,portal' })
    .select()
    .single();
}

// ─── USER CONFIGS ─────────────────────────────────────────────

async function getUserConfig(userId) {
  return supabase
    .from('user_configs')
    .select('*')
    .eq('user_id', userId)
    .single();
}

async function upsertUserConfig(userId, config) {
  return supabase
    .from('user_configs')
    .upsert({ user_id: userId, ...config }, { onConflict: 'user_id' })
    .select()
    .single();
}

// ─── PLAYERS ──────────────────────────────────────────────────

async function getPlayers(userId) {
  return supabase
    .from('players')
    .select('*')
    .eq('user_id', userId)
    .order('slot_index', { ascending: true });
}

async function upsertPlayer({ userId, slotIndex, firstName, lastName, phone, role = 'guest' }) {
  return supabase
    .from('players')
    .upsert({
      user_id:    userId,
      slot_index: slotIndex,
      role,
      first_name: firstName,
      last_name:  lastName,
      phone
    }, { onConflict: 'user_id,slot_index' })
    .select()
    .single();
}

// ─── BOOKINGS ─────────────────────────────────────────────────

async function recordBooking({
  userId, clubName, bookingDate, teeTime, teeTimeHour,
  numPlayers, bookingType = 'home_club', inPreferredWindow = true,
  confirmationRef, rawResponse
}) {
  return supabase
    .from('bookings')
    .insert({
      user_id:             userId,
      club_name:           clubName,
      booking_date:        bookingDate,
      tee_time:            teeTime,
      tee_time_hour:       teeTimeHour,
      num_players:         numPlayers,
      booking_type:        bookingType,
      in_preferred_window: inPreferredWindow,
      confirmation_ref:    confirmationRef,
      raw_response:        rawResponse
    })
    .select()
    .single();
}

async function getRecentBookings(userId, limit = 10) {
  return supabase
    .from('bookings')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
}

// ─── BOOKING ATTEMPTS ─────────────────────────────────────────

async function recordAttempt({
  userId, runType = 'availability_check', success,
  bookingId = null, clubsChecked = 0, slotsFound = 0,
  errorMessage = null, durationMs = null
}) {
  return supabase
    .from('booking_attempts')
    .insert({
      user_id:       userId,
      run_type:      runType,
      success,
      booking_id:    bookingId,
      clubs_checked: clubsChecked,
      slots_found:   slotsFound,
      error_message: errorMessage,
      duration_ms:   durationMs
    })
    .select()
    .single();
}

async function getRecentAttempts(userId, limit = 20) {
  return supabase
    .from('booking_attempts')
    .select('*')
    .eq('user_id', userId)
    .order('attempted_at', { ascending: false })
    .limit(limit);
}

// ─── AVAILABILITY SNAPSHOTS ───────────────────────────────────

async function saveSnapshot({ userId, clubName, snapshotDate, dayOfWeek, slots }) {
  const inWindowSlots = slots.filter(s => s.inPreferredWindow && s.slotsAvailable > 0).length;
  return supabase
    .from('availability_snapshots')
    .insert({
      user_id:          userId,
      club_name:        clubName,
      snapshot_date:    snapshotDate,
      day_of_week:      dayOfWeek,
      slots:            slots,
      total_slots:      slots.filter(s => s.slotsAvailable > 0).length,
      in_window_slots:  inWindowSlots
    })
    .select()
    .single();
}

// ─── ADMIN VIEWS ──────────────────────────────────────────────

async function getUserSummary() {
  return supabase.from('user_summary').select('*');
}

// ─── EXPORTS ──────────────────────────────────────────────────

module.exports = {
  supabase,
  // Users
  getAllActiveUsers, getUserById, getUserByEmail, createUser, updateUser, deactivateUser,
  // Credentials
  getCredentials, upsertCredentials,
  // Configs
  getUserConfig, upsertUserConfig,
  // Players
  getPlayers, upsertPlayer,
  // Bookings
  recordBooking, getRecentBookings,
  // Attempts
  recordAttempt, getRecentAttempts,
  // Snapshots
  saveSnapshot,
  // Admin
  getUserSummary,
};
