# Report definitions

All report numbers come from recorded handoff events (with count corrections applied and undone steps excluded),
in the organization time zone, for the chosen date range (both days inclusive).

- **Orders created / completed / cancelled** — by the date each happened.
- **Bags collected** — sum of counts at "collected from client".
- **Bags washed** — sum of counts at "washing completed".
- **Bags delivered** — sum of counts at "delivered to recipient".
  These three are separate totals and are never interchanged.
- **Outstanding orders** — created before the end of the range and not completed or cancelled now.
- **Overdue orders (now)** — open orders with a stage past its scheduled time plus the grace period (Settings).
- **Average turnaround** — hours from collection to delivery, for deliveries inside the range.
- **Volunteer workload** — washes completed and bags washed in the range; open washing assignments now.
- **Driver workload** — pickups, drop-offs, return collections and deliveries each driver recorded in the range.
- **Exceptions** — reported in the range, plus any still open.
- **Recurring performance** — occurrences dated in the range and what happened to them.

CSV exports contain exactly what is on screen for the same filters, and are only available to administrators and
dispatchers (the database refuses report queries from other roles).
