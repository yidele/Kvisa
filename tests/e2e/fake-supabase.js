// Test double for supabase-js used by the browser smoke tests (no network).
// Every query resolves with fixture rows; writes are recorded in window.__writes.
(function () {
  const role = localStorage.getItem('fakeRole') || 'admin';
  const now = Date.now();
  const iso = (h) => new Date(now + h * 3600e3).toISOString();
  const P = (id, name, roles, extra = {}) => ({ id, person_no: Number(id.slice(-2), 16), full_name: name, phone: '718-555-01' + id.slice(-2), email: null,
    address: id.slice(-1) + ' Test St', address_note: null, availability: 'Evenings', preferred_days: [0, 4], max_bags_per_day: 10,
    unavailable_from: null, unavailable_until: null, notes: null, active: true, _roles: roles, ...extra });
  const people = [
    P('00000000-0000-0000-0000-0000000000a1', 'Avi Driver', ['driver']),
    P('00000000-0000-0000-0000-0000000000b2', 'Bracha Washer', ['washer']),
    P('00000000-0000-0000-0000-0000000000c3', 'Chaim Both', ['driver', 'washer']),
  ];
  const settings = {
    id: 1, org_name: 'Kvisa Test Org', org_phone: null, org_email: null, org_address: null, time_zone: 'America/New_York',
    planning_window_days: 28, default_pickup_time: '10:00:00', default_wash_days: 2, default_return_days: 3,
    min_minutes_between_tasks: 30, flag_collection_vs_expected: true, require_discrepancy_resolution: true,
    overdue_grace_minutes: 60, upcoming_notice_hours: 12,
    notify_kinds: ['assigned', 'reassigned', 'schedule_changed', 'upcoming', 'overdue', 'washing_completed', 'return_ready', 'delivered', 'exception'],
    cancellation_reasons: ['Client cancelled', 'Other'], correction_reasons: ['Entered by mistake', 'Other'],
    status_labels: {}, task_type_labels: {},
    wa_enabled: true, wa_group_id: '120363000000000001@g.us', wa_group_name: 'Kvisa Drivers', sms_enabled: false,
    phone_country_code: '1', msg_send_address: true, msg_post_intro: 'Jobs available — reply privately with the number you can take:',
  };
  const O = '11111111-1111-1111-1111-111111111111';
  const C = '22222222-2222-2222-2222-222222222222';
  const T = (type, seq, status, assignee, h, extra = {}) => ({ id: '33333333-3333-3333-3333-33333333333' + seq, order_id: O, task_type: type, seq, status,
    assignee_id: assignee, scheduled_at: iso(h), original_scheduled_at: iso(h), started_at: null, completed_at: status === 'completed' ? iso(h) : null,
    from_address: '1 Pickup Rd', to_address: '2 Wash Ave', expected_bags: 4, actual_bags: status === 'completed' ? 4 : null, instructions: 'Ring twice', notes: null, ...extra });
  const tasks = [
    T('pickup', 1, 'completed', people[0].id, -5),
    T('dropoff', 2, 'completed', people[0].id, -4),
    T('washing', 3, 'in_progress', people[1].id, 1),
    T('return_collection', 4, 'pending', null, 26),
    T('delivery', 5, 'pending', people[2].id, 27),
  ];
  const client = { id: C, client_no: 1, name: 'Cohen Family', category_id: 'meshilach', primary_contact: 'Rivka', phone: '718-555-0100', email: null,
    pickup_address: '1 Pickup Rd', default_return_recipient: null, default_return_phone: null, default_return_address: null,
    access_instructions: 'Ring twice', preferred_days: [0], active: true, created_at: iso(-100), updated_at: iso(-1) };
  const order = { id: O, order_no: 1001, client_id: C, category_id: 'meshilach', status: 'awaiting_washing', pickup_contact: 'Rivka', pickup_phone: '718-555-0100',
    pickup_address: '1 Pickup Rd', return_recipient: 'Grandma Cohen', return_phone: null, return_address: '9 Other St', delivery_instructions: 'Ring twice',
    expected_bags: 4, bag_notes: 'Blue bags', expected_return_date: new Date(now + 86400e3 * 3).toISOString().slice(0, 10), notes: null,
    recurring_schedule_id: null, occurrence_date: null, detached_from_series: false, cancel_reason: null, cancelled_at: null, completed_at: null,
    created_at: iso(-30), updated_at: iso(-1), clients: { name: 'Cohen Family', client_no: 1, phone: '718-555-0100', category_id: 'meshilach' } };
  const overview = { id: O, order_no: 1001, client_id: C, client_name: 'Cohen Family', client_no: 1, category_id: 'meshilach', category_label: 'Meshilach',
    status: 'awaiting_washing', expected_bags: 4, expected_return_date: order.expected_return_date, pickup_address: '1 Pickup Rd', return_address: '9 Other St',
    return_recipient: 'Grandma Cohen', recurring_schedule_id: null, occurrence_date: null, cancel_reason: null, created_at: iso(-30), updated_at: iso(-1),
    completed_at: null, current_bags: 3, pickup_at: iso(-5), pickup_driver_id: people[0].id, pickup_driver_name: 'Avi Driver', washer_id: people[1].id,
    washer_name: 'Bracha Washer', delivery_driver_id: people[2].id, delivery_driver_name: 'Chaim Both', next_task_id: tasks[2].id, next_task_type: 'washing',
    next_task_at: iso(1), next_assignee_id: people[1].id, next_assignee_name: 'Bracha Washer', current_location: 'At washer Bracha Washer',
    open_exceptions: 1, is_overdue: false, has_unassigned: true };
  const events = [
    { id: 'e1', order_id: O, task_id: tasks[0].id, event_type: 'collected_from_client', expected_bags: 4, actual_bags: 4, from_person_id: null, to_person_id: people[0].id, from_party: 'Rivka', to_party: null, location: '1 Pickup Rd', occurred_at: iso(-5), recorded_at: iso(-5), corrects_event_id: null, notes: null, effective_bags: 4 },
    { id: 'e2', order_id: O, task_id: tasks[1].id, event_type: 'delivered_to_washer', expected_bags: 4, actual_bags: 3, from_person_id: people[0].id, to_person_id: people[1].id, from_party: null, to_party: null, location: '2 Wash Ave', occurred_at: iso(-4), recorded_at: iso(-4), corrects_event_id: null, notes: 'One bag missing <script>alert(1)</script>', effective_bags: 3 },
  ];
  const cal = tasks.map((t) => ({ task_id: t.id, order_id: O, order_no: 1001, task_type: t.task_type, seq: t.seq, task_status: t.status, order_status: 'awaiting_washing',
    scheduled_at: t.scheduled_at, original_scheduled_at: t.scheduled_at, completed_at: t.completed_at, assignee_id: t.assignee_id,
    assignee_name: (people.find((p) => p.id === t.assignee_id) || {}).full_name || null, from_address: t.from_address, to_address: t.to_address,
    expected_bags: 4, actual_bags: t.actual_bags, client_id: C, client_name: 'Cohen Family', category_id: 'meshilach', recurring_schedule_id: null }));
  const fixtures = {
    organization_settings: [settings],
    client_categories: [{ id: 'meshilach', label: 'Meshilach', sort_order: 1, active: true }, { id: 'family', label: 'Family', sort_order: 2, active: true }, { id: 'other', label: 'Other', sort_order: 3, active: true }],
    people: people.map(({ _roles, ...p }) => p),
    person_roles: people.flatMap((p) => p._roles.map((r) => ({ person_id: p.id, role: r, active: true }))),
    clients: [client], client_internal_notes: [{ client_id: C, notes: 'Internal only' }], client_addresses: [],
    recurring_schedules: [{ id: 'rs1', client_id: C, weekdays: [0, 3], pickup_time: '09:00:00', start_date: '2026-10-01', end_date: null, expected_bags: 2, status: 'active' }],
    orders: [order], order_overview: [overview], order_tasks: tasks, handoff_events: events, handoff_effective: events,
    order_exceptions: [{ id: 'x1', order_id: O, task_id: tasks[1].id, kind: 'bag_discrepancy', description: 'Drop-off: expected 4 bag(s), recorded 3.', expected_bags: 4, actual_bags: 3, status: 'open', reported_at: iso(-4), resolution: null, resolved_at: null }],
    task_assignments: tasks.filter((t) => t.assignee_id).map((t, i) => ({ id: 'a' + i, task_id: t.id, person_id: t.assignee_id, assigned_at: iso(-30), ended_at: null, reason: null, order_tasks: { order_id: O, task_type: t.task_type } })),
    audit_logs: [{ id: 1, at: iso(-4), actor_id: 'u1', actor_email: 'admin@test', action: 'handoff.delivered_to_washer', entity: 'handoff_events', entity_id: 'e2', order_id: O, client_id: C, old_value: null, new_value: { event_type: 'delivered_to_washer', actual_bags: 3, expected_bags: 4 }, reason: null },
      { id: 2, at: iso(-3), actor_id: 'u1', actor_email: 'admin@test', action: 'task.reassigned', entity: 'order_tasks', entity_id: tasks[4].id, order_id: O, client_id: C, old_value: { assignee_id: people[0].id }, new_value: { assignee_id: people[2].id }, reason: 'Avi away' }],
    notifications: [{ id: 'n1', user_id: 'u1', kind: 'exception', title: 'Bag count mismatch — order K-1001', body: 'Drop-off: expected 4, recorded 3', order_id: O, task_id: null, created_at: iso(-4), read_at: null }],
    profiles: [{ id: 'u1', email: 'admin@test', full_name: 'Admin User', person_id: null, active: true }],
    user_roles: [{ user_id: 'u1', role: 'admin', active: true }],
    invites: [], task_calendar: cal,
    task_dispatch: tasks.filter((t) => t.task_type !== 'washing').map((t) => ({ task_id: t.id, order_id: O, task_type: t.task_type, seq: t.seq,
      task_status: t.status, assignee_id: t.assignee_id,
      offer_id: t.task_type === 'return_collection' ? 'off1' : null, offer_status: t.task_type === 'return_collection' ? 'declined' : null,
      offered_at: iso(-1), expires_at: null, accepted_at: null, accepted_person_id: null, offered_count: 2, declined_count: 2,
      dispatch_status: t.status === 'completed' ? 'completed' : t.task_type === 'return_collection' ? 'declined' : t.assignee_id ? 'assigned' : 'not_dispatched',
      blocked_reason: t.task_type === 'delivery' ? 'Washing is not completed yet' : null })),
    task_offers: [{ id: 'off1', order_id: O, task_id: tasks[3].id, status: 'declined', created_at: iso(-1), accepted_at: null, close_reason: 'Every driver declined' }],
    job_posts: [{ id: 'jp1', post_no: 1, intro: null, channels: ['whatsapp'], created_at: iso(-2),
      body: 'Jobs available — reply privately with the number you can take:\n\n1. Return collection — Maple Avenue → Other St — 4 bags\n\nReply privately with the job number (e.g. 2). Reply DONE when you finish.' }],
    job_post_items: [{ post_id: 'jp1', item_no: 1, offer_id: 'off1', task_id: tasks[3].id, order_id: O, covered_person_id: people[0].id, covered_at: iso(-1.5),
      task_offers: { status: 'accepted', expires_at: null }, order_tasks: { task_type: 'return_collection' }, orders: { order_no: 1001 } }],
    message_outbox: [
      { id: 'mo1', channel: 'whatsapp', to_kind: 'group', to_address: '120363000000000001@g.us', person_id: null, body: 'Jobs available <b>x</b>\n1. Return collection', mentions: [], purpose: 'post', status: 'sent', attempts: 1, error: null, created_at: iso(-2) },
      { id: 'mo2', channel: 'whatsapp', to_kind: 'group', to_address: '120363000000000001@g.us', person_id: people[0].id, body: '1 covered @17185550101', mentions: ['17185550101'], purpose: 'covered', status: 'failed', attempts: 3, error: 'HTTP 401: bad token', created_at: iso(-1.5) },
    ],
    message_inbox: [
      { id: 'mi1', channel: 'whatsapp', provider_message_id: 'w1', from_address: '17185550101', person_id: people[0].id, body: '1', outcome: 'take', detail: 'Job 1 is yours: Return collection (K-1001)\nBags: 4', received_at: iso(-1.5) },
      { id: 'mi2', channel: 'sms', provider_message_id: 's1', from_address: '19995550000', person_id: null, body: 'who is this? <script>alert(2)</script>', outcome: 'unknown_sender', detail: null, received_at: iso(-1) },
    ],
    offer_recipients: [{ offer_id: 'off1', order_id: O, person_id: people[0].id, response: 'declined' }, { offer_id: 'off1', order_id: O, person_id: people[2].id, response: 'declined' }],
  };
  const ctx = { user_id: 'u1', email: 'admin@test', full_name: role === 'admin' ? 'Admin User' : 'Avi Driver', active: true,
    person_id: role === 'admin' ? null : people[0].id, roles: role === 'admin' ? ['admin'] : ['driver'], settings };
  const rpcs = {
    my_context: ctx, generate_recurring_orders: 0, refresh_due_notifications: 0, assignment_conflicts: [{ kind: 'overlap', message: 'Also has Pickup for K-1002 at 10:15 AM.' }],
    dashboard_summary: { date: '2026-10-13', pickups_scheduled: 3, pickups_completed: 1, awaiting_washing: 2, washing_in_progress: 1, bags_ready_for_return: 6,
      orders_ready_for_return: 2, returns_scheduled: 1, overdue: 1, open_discrepancies: 1, washers_active: 2, washers_assigned: 1, driver_tasks_outstanding: 4, unassigned_tasks: 2 },
    report_summary: { from: '2026-10-01', to: '2026-10-13', time_zone: 'America/New_York', totals: { orders_created: 5, orders_completed: 2, orders_cancelled: 1, bags_collected: 12,
      bags_washed: 9, bags_delivered: 8, outstanding_orders: 3, overdue_orders_now: 1, avg_turnaround_hours: 50.5 },
      by_category: [{ category: 'Meshilach', orders_created: 3, orders_completed: 1, bags_collected: 8, bags_washed: 6, bags_delivered: 5 }],
      washers: [{ name: 'Bracha Washer', washes_completed: 2, bags_washed: 9, assigned_open: 1 }],
      drivers: [{ name: 'Avi Driver', pickups: 3, dropoffs: 3, return_collections: 1, deliveries: 1, bags_handled: 12 }],
      exceptions: [{ order_no: 1001, kind: 'bag_discrepancy', status: 'open', description: 'x', expected: 4, actual: 3, reported_at: iso(-4), resolution: null }],
      recurring: [{ client: 'Cohen Family', status: 'active', occurrences: 4, completed: 2, cancelled_or_skipped: 1, open: 1 }] },
    my_tasks: [{ task_id: tasks[3].id, order_id: O, order_no: 1001, task_type: 'return_collection', task_status: 'pending', order_status: 'ready_for_return',
      scheduled_at: iso(2), started_at: null, completed_at: null, from_address: '2 Wash Ave', to_address: '9 Other St', expected_bags: 3, actual_bags: null,
      contact_name: 'Bracha Washer', contact_phone: '718-555-0102', other_party_name: 'Grandma Cohen', other_party_phone: null, client_label: 'Cohen (K-1001)',
      instructions: null, bag_notes: 'Blue bags', washing_received: false, can_act: true, open_problems: 0 }],
    record_handoff: { event_id: 'e9', exception_id: null, order_status: 'out_for_delivery' },
    my_offers: role === 'admin' ? [] : [{ offer_id: 'off2', order_no: 1002, task_type: 'pickup', from_street: 'Main Street', to_street: 'Maple Avenue',
      expected_bags: 4, scheduled_at: iso(3), note: 'Two heavy bags', expires_at: iso(2), created_at: iso(-0.1) }],
    dispatch_preview: { from_street: 'Maple Avenue', to_street: 'Other St', blocked: null, assignee_id: null },
    dispatch_task: 'off3', respond_offer: { accepted: true, task_id: 'x' }, cancel_offer: null,
    job_post_preview: { body: 'Jobs available — reply privately with the number you can take:\n\n1. Return collection — Maple Avenue → Other St — 3 bags\n\nReply privately with the job number (e.g. 2). Reply DONE when you finish.', items: [] },
    post_jobs: { post_id: 'jp2', post_no: 2, jobs: 1, first_no: 1, last_no: 1, whatsapp: true, sms: 0, body: 'x' },
    outbox_retry: null, outbox_cancel: null,
  };
  window.__writes = [];
  function builder(table) {
    const state = { table, single: false, maybe: false, head: false, count: false, write: null };
    const target = {};
    const handler = {
      get(_, prop) {
        if (prop === 'then') {
          return (resolve, reject) => {
            if (table === '__fail') return resolve({ data: null, error: { message: 'boom' } });
            let rows = fixtures[table] ? JSON.parse(JSON.stringify(fixtures[table])) : [];
            if (state.write) { window.__writes.push({ table, ...state.write }); rows = state.write.values ? [Object.assign({ id: 'new-id', client_no: 99 }, state.write.values)] : rows; }
            if (state.single || state.maybe) return Promise.resolve({ data: rows[0] || null, error: null }).then(resolve, reject);
            return Promise.resolve({ data: state.head ? null : rows, error: null, count: state.count ? rows.length : null }).then(resolve, reject);
          };
        }
        return (...args) => {
          if (prop === 'single') state.single = true;
          if (prop === 'maybeSingle') state.maybe = true;
          if (prop === 'select' && args[1] && args[1].head) state.head = true;
          if (prop === 'select' && args[1] && args[1].count) state.count = true;
          if (['insert', 'update', 'upsert', 'delete'].includes(prop)) state.write = { op: prop, values: args[0] };
          return proxy;
        };
      },
    };
    const proxy = new Proxy(target, handler);
    return proxy;
  }
  const session = { user: { id: 'u1', email: 'admin@test' }, access_token: 'x' };
  window.supabase = {
    createClient() {
      return {
        from: (t) => builder(t),
        rpc: (name, args) => { window.__writes.push({ rpc: name, args }); return Promise.resolve({ data: rpcs[name] ?? null, error: null }); },
        functions: {
          invoke: (name, { body } = {}) => {
            window.__writes.push({ fn: name, body });
            const out = { send: { sent: 1, failed: 0 }, status: { whatsapp: true, sms: false, webhook: true },
              groups: { groups: [{ id: '120363000000000001@g.us', name: 'Kvisa Drivers' }, { id: '120363000000000002@g.us', name: 'Family' }] } };
            return Promise.resolve({ data: out[body?.action] ?? null, error: null });
          },
        },
        auth: {
          getSession: () => Promise.resolve({ data: { session } }),
          onAuthStateChange: (cb) => { setTimeout(() => cb(localStorage.getItem('fakeLoggedOut') ? 'INITIAL_SESSION' : 'INITIAL_SESSION', localStorage.getItem('fakeLoggedOut') ? null : session), 0); return { data: { subscription: { unsubscribe() {} } } }; },
          signOut: () => Promise.resolve({ error: null }),
          signInWithPassword: () => Promise.resolve({ error: { message: 'Invalid login credentials' } }),
          signUp: () => Promise.resolve({ data: {}, error: { message: 'Database error saving new user' } }),
          resetPasswordForEmail: () => Promise.resolve({ error: null }),
          updateUser: () => Promise.resolve({ error: null }),
        },
      };
    },
  };
})();
